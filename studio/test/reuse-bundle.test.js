import test from 'node:test';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJSON } from '../src/engine/contracts.js';
import { originKey, validateOriginRef, sealBundle, validateBundle, readBundleDirectory, writeBundleDirectory } from '../src/reuse/bundle.js';
import { bundleFixture, ref, pngBytes, pngSha256 } from './helpers/bundles.js';

const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const unseal = bundle => { const value = structuredClone(bundle); delete value.manifestSha256; return value; };
const code = expected => error => error.code === expected;
const invalid = fn => assert.throws(fn, code('INVALID_INPUT'));
const limit = fn => assert.throws(fn, code('BUNDLE_LIMIT_EXCEEDED'));
async function temp(t) { const path = await mkdtemp(join(await realpath(tmpdir()), 'studio-bundle-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

// Dropping any OriginRef component would incorrectly merge distinct semantic records.
test('semantic identity preserves exact owner, subject, project, kind and native revision independently of bytes', () => {
  const first = bundleFixture();
  const secondRef = ref({ ownerId: 'another-owner', recordId: 'villain', revision: 'rev/opaque:2' });
  const second = bundleFixture({ roots: [secondRef], records: [{ ...unseal(first.bundle).records[0], ref: secondRef, metadata: { identityId: 'villain' } }] });
  assert.deepEqual(first.bytes, second.bytes);
  for (const overrides of [{ ownerId: 'b' }, { projectId: 'b' }, { recordKind: 'b' }, { recordId: 'b' }, { revision: 'b' }]) assert.notEqual(originKey(ref()), originKey(ref(overrides)));
  assert.notEqual(originKey(first.bundle.roots[0]), originKey(second.bundle.roots[0]));
  const native = ref({ revision: 'sha256:old/native@1' });
  assert.deepEqual(validateOriginRef(native), native);
  assert.notEqual(originKey(ref({ projectId: 'a:b', recordId: 'c' })), originKey(ref({ projectId: 'a', recordId: 'b:c' })));
});

test('sealing hashes each portable record and the manifest while validation returns a defensive clone', () => {
  const { bundle, bytes } = bundleFixture();
  const record = { ...bundle.records[0] }; delete record.recordSha256;
  assert.equal(bundle.records[0].recordSha256, hash(record));
  assert.equal(bundle.manifestSha256, hash(unseal(bundle)));
  const copy = validateBundle(bundle, bytes);
  copy.records[0].metadata.title = 'changed';
  assert.equal(bundle.records[0].metadata.title, 'Portrait');
});

test('directory roundtrip preserves exact PNG bytes and writes only fixed hash paths', async t => {
  const base = await temp(t); const directory = join(base, 'bundle'); const fixture = bundleFixture();
  fixture.bundle = sealBundle({ ...unseal(fixture.bundle), records: [{ ...fixture.bundle.records[0], metadata: { prompt: 'fetch https://invalid.test or execute /bin/sh is literal text', text: '../../not-a-path', sha256: '../never-read', script: { scenes: ['screenplay'] }, commandId: 'observed-command', executionRefs: [], literalInputRefs: [], evidenceUrl: 'https://example.test/citation' } }] });
  await writeBundleDirectory(directory, fixture);
  const actual = await readBundleDirectory(directory);
  assert.deepEqual(actual, fixture);
  assert.deepEqual(await readFile(join(directory, 'files', pngSha256)), Buffer.from(pngBytes));
  assert.deepEqual((await readdir(directory)).sort(), ['files', 'manifest.json']);
  await assert.rejects(writeBundleDirectory(directory, fixture));
  assert.deepEqual(await readBundleDirectory(directory), fixture);
});

test('byte, record and manifest tampering fail hashes rather than being silently resealed', () => {
  const { bundle, bytes } = bundleFixture();
  assert.throws(() => validateBundle(bundle, { ...bytes, [pngSha256]: [0, ...pngBytes.slice(1)] }), code('BUNDLE_HASH_MISMATCH'));
  const changedRecord = structuredClone(bundle); changedRecord.records[0].metadata.title = 'forged';
  assert.throws(() => validateBundle(changedRecord), code('BUNDLE_HASH_MISMATCH'));
  const changedManifest = structuredClone(bundle); changedManifest.disclosure.includedScope = 'forged';
  assert.throws(() => validateBundle(changedManifest), code('BUNDLE_HASH_MISMATCH'));
});

test('runtime records, roots and required descriptors must exist; historical references may be absent', () => {
  const base = unseal(bundleFixture().bundle); const absent = ref({ recordId: 'missing' });
  for (const value of [ { ...base, roots: [absent] }, { ...base, links: [{ from: ref(), to: absent, relation: 'derived-from', requirement: 'runtime' }] }, { ...base, files: [] } ]) assert.throws(() => sealBundle(value), code('BUNDLE_INCOMPLETE'));
  const historical = sealBundle({ ...base, records: [{ ...base.records[0], evidenceRefs: [absent] }], links: [{ from: ref(), to: absent, relation: 'derived-from', requirement: 'historical-reference' }] });
  assert.equal(validateBundle(historical).links[0].to.recordId, 'missing');
  assert.throws(() => validateBundle(historical, {}), code('BUNDLE_INCOMPLETE'));
});

test('directory missing or truncated files are incomplete; modified full length files fail hash', async t => {
  const directory = join(await temp(t), 'bundle'); const fixture = bundleFixture();
  await writeBundleDirectory(directory, fixture);
  const file = join(directory, 'files', pngSha256);
  await rm(file);
  await assert.rejects(readBundleDirectory(directory), code('BUNDLE_INCOMPLETE'));
  await writeFile(file, Buffer.from([1]));
  await assert.rejects(readBundleDirectory(directory), code('BUNDLE_INCOMPLETE'));
  await writeFile(file, Buffer.alloc(pngBytes.length));
  await assert.rejects(readBundleDirectory(directory), code('BUNDLE_HASH_MISMATCH'));
});

test('unsupported schema and non-exact latest revisions fail explicitly', () => {
  assert.throws(() => sealBundle({ ...unseal(bundleFixture().bundle), schemaVersion: 2 }), code('BUNDLE_SCHEMA_UNSUPPORTED'));
  for (const value of ['latest', '', null, 1]) invalid(() => validateOriginRef(ref({ revision: value })));
  invalid(() => validateOriginRef({ ...ref(), locator: '/private/source' }));
});

test('portable structures reject unknown schema keys and recursive path or executable instructions', () => {
  const base = unseal(bundleFixture().bundle);
  for (const value of [{ ...base, locator: '/tmp' }, { ...base, files: [{ ...base.files[0], path: '../outside' }] }, { ...base, records: [{ ...base.records[0], script: 'run' }] }]) invalid(() => sealBundle(value));
  for (const key of ['path', 'filePath', 'rootDir', 'sourcePath', 'worldRoot', 'directory', 'absolutePath', 'locator', 'executableInstruction', 'fetchInstruction']) invalid(() => sealBundle({ ...base, records: [{ ...base.records[0], metadata: { nested: { [key]: '/tmp/escape' } } }] }));
});

test('hostile prototypes, accessors, sparse arrays and non-JSON values never run', () => {
  let reads = 0;
  const getter = { ...ref() }; Object.defineProperty(getter, 'revision', { enumerable: true, get() { reads++; return 'safe'; } });
  invalid(() => validateOriginRef(getter)); assert.equal(reads, 0);
  invalid(() => validateOriginRef(Object.assign(Object.create({}), ref())));
  const base = unseal(bundleFixture().bundle);
  for (const metadata of [JSON.parse('{"__proto__":{}}'), { value: undefined }, { value: () => {} }, { value: Infinity }, { value: new Date() }, { value: Array(1) }]) invalid(() => sealBundle({ ...base, records: [{ ...base.records[0], metadata }] }));
  const bytes = {}; Object.defineProperty(bytes, pngSha256, { enumerable: true, get() { reads++; return pngBytes; } });
  invalid(() => validateBundle(bundleFixture().bundle, bytes)); assert.equal(reads, 0);
});

test('duplicate semantic refs, roots, file hashes and required hashes cannot disguise conflicts', () => {
  const base = unseal(bundleFixture().bundle);
  for (const value of [{ ...base, records: [...base.records, base.records[0]] }, { ...base, roots: [ref(), ref()] }, { ...base, files: [...base.files, base.files[0]] }, { ...base, records: [{ ...base.records[0], requiredFileSha256s: [pngSha256, pngSha256] }] }]) invalid(() => sealBundle(value));
});

test('byte maps must contain dense integer byte arrays under declared hashes only', () => {
  const { bundle } = bundleFixture();
  for (const bytes of [{ [pngSha256]: [256] }, { [pngSha256]: [-1] }, { [pngSha256]: [1.5] }, { [pngSha256]: Array(1) }, { '../escape': [1] }, { [pngSha256]: Buffer.from(pngBytes) }]) invalid(() => validateBundle(bundle, bytes));
});

test('all JSON nesting accepts depth 32 and rejects depth 33 explicitly', () => {
  const base = unseal(bundleFixture().bundle);
  const nested = count => { let value = 'leaf'; while (count--) value = { child: value }; return value; };
  // root -> records array -> record -> metadata = four object/array levels.
  sealBundle({ ...base, records: [{ ...base.records[0], metadata: nested(29) }] });
  limit(() => sealBundle({ ...base, records: [{ ...base.records[0], metadata: nested(30) }] }));
});

test('manifest bytes accept exactly 512 KiB and reject one byte more', () => {
  const base = unseal(bundleFixture().bundle); base.records[0].metadata = { text: '' };
  const empty = sealBundle(base);
  const padding = 512 * 1024 - Buffer.byteLength(canonicalJSON(empty));
  base.records[0].metadata.text = 'a'.repeat(padding);
  const exact = sealBundle(base); assert.equal(Buffer.byteLength(canonicalJSON(exact)), 512 * 1024);
  base.records[0].metadata.text += 'a'; limit(() => sealBundle(base));
});

test('record count accepts 256 and rejects 257', () => {
  const base = unseal(bundleFixture().bundle);
  base.records = Array.from({ length: 256 }, (_, i) => ({ ...base.records[0], ref: ref({ recordId: `record-${i}` }) })); base.roots = [base.records[0].ref];
  assert.equal(sealBundle(base).records.length, 256);
  base.records.push({ ...base.records[0], ref: ref({ recordId: 'extra' }) }); limit(() => sealBundle(base));
});

test('link count accepts 1024 and rejects 1025', () => {
  const base = unseal(bundleFixture().bundle);
  base.links = Array.from({ length: 1024 }, (_, i) => ({ from: ref(), relation: 'derived-from', to: ref({ recordId: `history-${i}` }), requirement: 'historical-reference' }));
  assert.equal(sealBundle(base).links.length, 1024);
  base.links.push({ from: ref(), relation: 'derived-from', to: ref({ recordId: 'extra' }), requirement: 'historical-reference' }); limit(() => sealBundle(base));
});

test('per-file limit accepts 20 MiB and rejects one byte more', () => {
  const base = unseal(bundleFixture().bundle); base.files[0].byteLength = 20 * 1024 * 1024;
  sealBundle(base); base.files[0].byteLength++; limit(() => sealBundle(base));
});

test('unique file total accepts 24 MiB across shared record uses and rejects one byte more', () => {
  const base = unseal(bundleFixture().bundle); base.files[0].byteLength = 20 * 1024 * 1024;
  base.files.push({ ...base.files[0], sha256: 'a'.repeat(64), byteLength: 4 * 1024 * 1024 });
  base.records.push({ ...base.records[0], ref: ref({ recordId: 'shared' }) });
  sealBundle(base); base.files[1].byteLength++; limit(() => sealBundle(base));
});

test('oversized manifest reads and actual files are bounded before accepting content', async t => {
  const directory = join(await temp(t), 'bundle'); const fixture = bundleFixture(); await writeBundleDirectory(directory, fixture);
  await writeFile(join(directory, 'manifest.json'), ' '.repeat(512 * 1024 + 1));
  await assert.rejects(readBundleDirectory(directory), code('BUNDLE_LIMIT_EXCEEDED'));
  await writeFile(join(directory, 'manifest.json'), canonicalJSON(fixture.bundle));
  await writeFile(join(directory, 'files', pngSha256), Buffer.alloc(20 * 1024 * 1024 + 1));
  await assert.rejects(readBundleDirectory(directory), code('BUNDLE_LIMIT_EXCEEDED'));
});

test('symlink directory ancestors and manifest, files directory or byte leaves are refused', async t => {
  const base = await temp(t); const fixture = bundleFixture(); const directory = join(base, 'real'); await writeBundleDirectory(directory, fixture);
  const alias = join(base, 'alias'); await symlink(directory, alias);
  await assert.rejects(readBundleDirectory(alias), code('INVALID_INPUT'));
  await assert.rejects(writeBundleDirectory(join(alias, 'new'), fixture), code('INVALID_INPUT'));
  for (const relative of ['manifest.json', 'files', `files/${pngSha256}`]) {
    const target = join(directory, relative); const saved = join(base, `saved-${relative.replaceAll('/', '-')}`);
    const bytes = relative === 'files' ? null : await readFile(target);
    if (bytes) await writeFile(saved, bytes); else { await mkdir(saved); await writeFile(join(saved, pngSha256), Buffer.from(pngBytes)); }
    await rm(target, { recursive: true }); await symlink(saved, target);
    await assert.rejects(readBundleDirectory(directory), code('INVALID_INPUT'));
    await rm(target); if (bytes) await writeFile(target, bytes); else { await mkdir(target); await writeFile(join(target, pngSha256), Buffer.from(pngBytes)); }
  }
});

test('invalid write input leaves no partial directory', async t => {
  const base = await temp(t); const fixture = bundleFixture(); fixture.bytes = {};
  await assert.rejects(writeBundleDirectory(join(base, 'new'), fixture), code('BUNDLE_INCOMPLETE'));
  assert.deepEqual(await readdir(base), []);
});

test('directory writes snapshot verified bytes before their first async filesystem operation', async t => {
  const directory = join(await temp(t), 'bundle');
  const fixture = bundleFixture(); const expected = structuredClone(fixture);
  const writing = writeBundleDirectory(directory, fixture);
  fixture.bytes[pngSha256][0] = 0;
  fixture.bytes[pngSha256] = [1];
  await writing;
  assert.deepEqual(await readBundleDirectory(directory), expected);
});

test('proxy traps cannot execute while inspecting portable records or bytes', () => {
  let traps = 0;
  const proxied = value => new Proxy(value, { ownKeys() { traps++; throw new Error('executed proxy'); } });
  invalid(() => validateOriginRef(proxied(ref())));
  invalid(() => sealBundle({ ...unseal(bundleFixture().bundle), records: [{ ...bundleFixture().bundle.records[0], metadata: proxied({ text: 'safe' }) }] }));
  invalid(() => validateBundle(bundleFixture().bundle, proxied({ [pngSha256]: pngBytes })));
  invalid(() => validateBundle(bundleFixture().bundle, { [pngSha256]: proxied(pngBytes) }));
  assert.equal(traps, 0);
});

test('writes explicitly reject an existing symlink destination and preserve its target', async t => {
  const base = await temp(t); const directory = join(base, 'real'); const alias = join(base, 'alias');
  const fixture = bundleFixture(); await writeBundleDirectory(directory, fixture); await symlink(directory, alias);
  await assert.rejects(writeBundleDirectory(alias, fixture), code('INVALID_INPUT'));
  assert.deepEqual(await readBundleDirectory(directory), fixture);
});

test('shared PNG fixture is decodable with exact RGBA pixels for consuming import tests', async () => {
  assert.deepEqual([...await sharp(Buffer.from(pngBytes)).ensureAlpha().raw().toBuffer()], [40, 60, 80, 255]);
});
