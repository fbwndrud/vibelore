import { mkdir, open, readFile, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
/** Serializes complete MCP operations across server processes for one work. */
export async function withProjectLock(rootDir, operation, { waitMs = 5000 } = {}) {
  const base = join(rootDir, '.vibelore');
  await mkdir(base, { recursive: true });
  if ((await lstat(base)).isSymbolicLink()) throw new Error('UNSAFE_PROJECT: .vibelore cannot be a symbolic link');
  const path = join(base, 'project.lock');
  const owner = { pid: process.pid, id: randomUUID() };
  const deadline = Date.now() + waitMs;
  for (;;) {
    let handle;
    try { handle = await open(path, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
      if (previous && !alive(previous.pid)) {
        // Only one contender may reap a dead owner; otherwise a second reaper
        // could unlink the next owner's lock between its read and unlink.
        const reaperPath = `${path}.cleanup`;
        const reaper = await open(reaperPath, 'wx').catch((error) => {
          if (error.code === 'EEXIST') return null;
          throw error;
        });
        if (!reaper) {
          if (Date.now() >= deadline) throw new Error('PROJECT_BUSY: lock recovery is in progress');
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        try {
          const same = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
          if (same?.id === previous.id) await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        } finally { await reaper.close(); await unlink(reaperPath); }
      } else {
        if (Date.now() >= deadline) throw new Error('PROJECT_BUSY: another server is using this work');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      continue;
    }
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
    break;
  }
  try { return await operation(); }
  finally {
    const current = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
    if (current?.id === owner.id) await unlink(path);
  }
}
