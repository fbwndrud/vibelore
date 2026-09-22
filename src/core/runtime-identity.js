import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = new URL('../../', import.meta.url);
let identity;

async function sourceFiles(directory) {
  const entries = await readdir(new URL(directory, root), { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? sourceFiles(`${directory}${entry.name}/`)
    : entry.isFile() ? [`${directory}${entry.name}`] : []));
  return files.flat();
}

/** Identity of the installed source on first use in this server process. */
export function getRuntimeIdentity() {
  identity ??= (async () => {
    const paths = ['package.json', ...(await sourceFiles('src/')), ...(await sourceFiles('engine/src/'))].sort();
    const digest = createHash('sha256');
    for (const path of paths) digest.update(path).update('\0').update(await readFile(new URL(path, root))).update('\0');
    let gitCommit = null;
    try {
      const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(root), timeout: 2000 });
      if (/^[a-f0-9]{40,64}$/.test(stdout.trim())) gitCommit = stdout.trim();
    } catch { /* Installed packages need not include git metadata. */ }
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    return { packageVersion: pkg.version, gitCommit, sourceTreeHash: `sha256:${digest.digest('hex')}`, scope: 'package.json+src+engine/src', capturedAt: new Date().toISOString() };
  })();
  return identity;
}
