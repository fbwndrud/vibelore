import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const requiredFiles = [
  'package.json', 'engine/package.json', '.codex-plugin/plugin.json', '.mcp.json',
  'src/server.js', 'LICENSE', 'NOTICE', 'SECURITY.md', 'docs/release-review.json',
  'skills/story-discovery-interview/SKILL.md', 'skills/webtoon-discovery-interview/SKILL.md',
  'docs/reference/WEBTOON_WORKFLOW.md', 'docs/reference/STORY_PREPARATION_WORKFLOW.md',
  'docs/reference/WORLD_BUILDING_WORKFLOW.md', 'src/assets/fonts/OFL.txt',
  'src/assets/fonts/GowunDodum-Regular.ttf',
];

export function validatePack(manifest, pkg) {
  assert.equal(manifest.length, 1, 'Expected exactly one packed package.');
  const pack = manifest[0];
  assert.equal(pack.name, pkg.name, 'Packed package name mismatch.');
  assert.equal(pack.version, pkg.version, 'Packed version mismatch.');
  assert.equal(basename(pack.filename), pack.filename, 'Invalid tarball filename.');
  assert.match(pack.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, 'Missing package integrity.');
  const paths = new Set(pack.files.map(file => file.path));
  for (const path of requiredFiles) assert.ok(paths.has(path), `Package missing ${path}`);
  for (const path of paths) {
    assert.ok(!/(^|\/)\.\.(\/|$)|^\/|\\/.test(path), `Invalid package path: ${path}`);
    assert.ok(!/(^|\/)(?:\.env(?:\..*)?|manifest-private\.json)$|^(?:output|test|scripts|studio|docs\/(?:showcase|research|superpowers|plans)|\.vibelore)\/|\.(?:pem|key|p12|pfx|log)$/.test(path), `Private or development artifact packed: ${path}`);
    assert.ok(path === 'package.json' || pkg.files.some(entry => entry.endsWith('/') ? path.startsWith(entry) : path === entry), `Outside package allowlist: ${path}`);
  }
  return pack;
}

function run(command, args, capture = false) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
}

export function localRelease({ publish = false, dryRun = false, runCommand = run, nodeVersion = process.versions.node } = {}) {
  const [major, minor] = nodeVersion.split('.').map(Number);
  assert.ok((major === 22 && minor >= 13) || major === 24 || major === 26, 'Use supported Node.js 22.13+, 24.x or 26.x for release checks.');
  assert.ok(process.env.npm_execpath, 'Run via npm run check:publish or npm run release:npm.');
  const npm = (...args) => runCommand(process.execPath, [process.env.npm_execpath, ...args], args.includes('--json'));
  const cleanCommit = () => {
    assert.equal(runCommand('git', ['status', '--porcelain', '--untracked-files=all'], true).trim(), '', 'Commit all changes before publishing.');
    return runCommand('git', ['rev-parse', 'HEAD'], true).trim();
  };
  const commit = publish ? cleanCommit() : null;
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  if (publish) assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'Only stable versions may use the latest release command.');
  npm('run', 'test:all');
  npm('run', 'check:release');
  runCommand('git', ['diff', '--check']);
  const directory = mkdtempSync(join(tmpdir(), 'vibelore-release-'));
  const pack = validatePack(JSON.parse(npm('pack', '--json', '--pack-destination', directory)), pkg);
  const tarball = join(directory, pack.filename);
  const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
  assert.equal(integrity, pack.integrity, 'Tarball differs from the verified package.');
  if (publish) {
    assert.equal(cleanCommit(), commit, 'The release commit changed during verification.');
    if (!dryRun) npm('publish', tarball, '--tag', 'latest', '--access', 'public', '--registry=https://registry.npmjs.org');
  }
  const receipt = { version: pkg.version, commit, tarball, integrity, published: publish && !dryRun };
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  assert.ok(args.every(arg => ['--publish', '--dry-run'].includes(arg)), 'Only --publish and --dry-run are supported.');
  assert.ok(!args.includes('--dry-run') || args.includes('--publish'), 'Use npm run release:npm -- --dry-run.');
  localRelease({ publish: args.includes('--publish'), dryRun: args.includes('--dry-run') });
}
