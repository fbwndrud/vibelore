import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { localRelease, validatePack } from '../scripts/local-release.js';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const files = [
  'package.json', 'engine/package.json', '.codex-plugin/plugin.json', '.mcp.json',
  'src/server.js', 'LICENSE', 'NOTICE', 'SECURITY.md', 'docs/release-review.json',
  'skills/story-discovery-interview/SKILL.md', 'skills/webtoon-discovery-interview/SKILL.md',
  'docs/reference/WEBTOON_WORKFLOW.md', 'docs/reference/STORY_PREPARATION_WORKFLOW.md',
  'docs/reference/WORLD_BUILDING_WORKFLOW.md', 'src/assets/fonts/OFL.txt',
  'src/assets/fonts/GowunDodum-Regular.ttf',
].map(path => ({ path }));
const bytes = Buffer.from('synthetic packed bytes');
const manifest = () => [{ name: pkg.name, version: pkg.version, filename: 'release.tgz',
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, files }];

function runner({ fail, dirty = false, drift = false, tamper = false, invalidPack = false } = {}) {
  const calls = [];
  let heads = 0;
  const runCommand = (command, args) => {
    calls.push(args);
    if (args.includes(fail)) throw new Error('Synthetic check failure');
    if (args[0] === 'status') return dirty ? ' M src/server.js\n' : '';
    if (args[0] === 'rev-parse') return drift && heads++ ? 'changed' : 'verified';
    if (args.includes('pack')) {
      const directory = args[args.indexOf('--pack-destination') + 1];
      writeFileSync(join(directory, 'release.tgz'), tamper ? 'changed' : bytes);
      const data = manifest();
      if (invalidPack) data[0].files = [...files, { path: 'output/private.md' }];
      return JSON.stringify(data);
    }
    return '';
  };
  return { runCommand, calls };
}

// Direct node --test also works; the fake runner never executes this path.
process.env.npm_execpath ??= 'synthetic-npm-cli';
const execute = options => localRelease({ nodeVersion: '24.0.0', ...options });
const published = calls => calls.some(args => args.includes('publish'));

test('a failed test or approval check prevents packing and publishing', () => {
  for (const fail of ['test:all', 'check:release', 'diff']) {
    const fake = runner({ fail });
    assert.throws(() => execute({ publish: true, ...fake }), /Synthetic check failure/);
    assert.equal(fake.calls.some(args => args.includes('pack')), false);
    assert.equal(published(fake.calls), false);
  }
});

test('dirty checkout, commit drift, invalid contents and tampered tarballs cannot publish', () => {
  for (const options of [{ dirty: true }, { drift: true }, { invalidPack: true }, { tamper: true }]) {
    const fake = runner(options);
    assert.throws(() => execute({ publish: true, ...fake }));
    assert.equal(published(fake.calls), false);
  }
});

test('dry run verifies a real artifact but never invokes npm publish', () => {
  const fake = runner();
  const receipt = execute({ publish: true, dryRun: true, ...fake });
  assert.equal(receipt.published, false);
  assert.equal(receipt.commit, 'verified');
  assert.equal(published(fake.calls), false);
  assert.deepEqual(readFileSync(receipt.tarball), bytes);
});

test('publication uses the verified tarball after every gate succeeds', () => {
  const fake = runner();
  const receipt = execute({ publish: true, ...fake });
  assert.equal(receipt.published, true);
  const args = fake.calls.at(-1);
  assert.deepEqual(args.slice(1), ['publish', receipt.tarball, '--tag', 'latest', '--access', 'public', '--registry=https://registry.npmjs.org']);
});

test('package guard rejects missing resources, stale versions, unsafe paths and private files', () => {
  const mutations = [
    data => { data[0].files = files.filter(file => !file.path.endsWith('/OFL.txt')); },
    data => { data[0].version = '0.0.0'; },
    data => { data[0].filename = '../outside.tgz'; },
    ...['src/.env', 'src/token.key', 'docs/showcase/private.md', 'output/private.md', '../outside', 'unexpected.md']
      .map(path => data => { data[0].files = [...files, { path }]; }),
  ];
  for (const mutate of mutations) {
    const data = manifest();
    mutate(data);
    assert.throws(() => validatePack(data, pkg));
  }
});

test('package guard denies the local Studio runtime even if the allowlist widens', () => {
  const widened = { ...pkg, files: [...pkg.files, 'studio/'] };
  for (const path of ['studio/package.json', 'studio/src/engine/index.js']) {
    const data = manifest();
    data[0].files = [...files, { path }];
    assert.throws(() => validatePack(data, widened), /Private or development artifact packed/);
  }
});

test('unsupported Node.js versions stop before running any release commands', () => {
  const fake = runner();
  assert.throws(() => localRelease({ nodeVersion: '23.11.0', ...fake }), /supported Node.js/);
  assert.equal(fake.calls.length, 0);
});
