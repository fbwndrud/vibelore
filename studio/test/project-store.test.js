import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, rm, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { canonicalJSON } from '../src/engine/contracts.js';
import { createHash } from 'node:crypto';
import { openStudio } from '../src/engine/index.js';
import { withStudio } from './helpers/project.js';
const exec = promisify(execFile);
const production = id => ({ id, title: '본편', sourcePackageId: null });
const code = expected => error => error.code === expected;

it('reopens saved production in a separate process', async t => {
  const f = await withStudio(t);
  await f.command('production.create', production('main'));
  await f.service.close();
  const script = `import {openStudio} from ${JSON.stringify(new URL('../src/engine/index.js', import.meta.url).href)};
    const s=await openStudio({directory:process.argv[1]}); console.log(JSON.stringify(await s.snapshot('p1'))); await s.close();`;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script, f.directory]);
  const saved = JSON.parse(stdout);
  assert.equal(saved.productions[0].id, 'main');
  assert.equal(saved.project.language, 'ko');
  assert.equal(saved.eventCursor, 2);
});

it('replays identical commands with canonical key order after reopening', async t => {
  const f = await withStudio(t);
  const first = await f.command('production.create', production('main'), { commandId: 'same' });
  await f.service.close();
  const reopened = await openStudio({ directory: f.directory }); t.after(() => reopened.close());
  const replay = await reopened.command({ payload: { sourcePackageId: null, title: '본편', id: 'main' }, type: 'production.create',
    expectedRevision: 0, aggregate: { id: 'main', kind: 'production' }, commandId: 'same', projectId: 'p1' });
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.equal((await reopened.events('p1')).length, 2);
});

it('rejects a reused command ID with different payload without emitting an event', async t => {
  const f = await withStudio(t);
  await f.command('production.create', production('main'), { commandId: 'same' });
  await assert.rejects(f.command('production.create', { ...production('other'), title: 'Changed' }, { commandId: 'same' }), code('COMMAND_CONFLICT'));
  assert.equal((await f.service.snapshot('p1')).eventCursor, 2);
});

it('rejects stale aggregate revisions without changing persistent state', async t => {
  const f = await withStudio(t);
  await f.command('production.create', production('main'));
  await assert.rejects(f.command('production.create', production('main'), { expectedRevision: 0 }), code('REVISION_CONFLICT'));
  assert.equal((await f.service.snapshot('p1')).eventCursor, 2);
});

it('allows independent aggregate writes from two open connections', async t => {
  const f = await withStudio(t);
  const second = await openStudio({ directory: f.directory }); t.after(() => second.close());
  await f.command('production.create', production('main'));
  await second.command({ projectId: 'p1', commandId: 'second', type: 'production.create', payload: production('other'),
    aggregate: { kind: 'production', id: 'other' }, expectedRevision: 0 });
  const snapshot = await f.service.snapshot('p1');
  assert.deepEqual(snapshot.productions.map(p => p.id), ['main', 'other']);
  assert.equal(snapshot.aggregates.find(a => a.kind === 'project').revision, 1);
});

it('rejects aggregate targets unrelated to the command subject', async t => {
  const f = await withStudio(t);
  for (const aggregate of [{ kind: 'project', id: 'p1' }, { kind: 'production', id: 'other' }]) {
    await assert.rejects(f.command('production.create', production('main'), { aggregate, expectedRevision: 0 }), code('INVALID_AGGREGATE'));
  }
  assert.deepEqual((await f.service.snapshot('p1')).productions, []);
});

it('treats another project create as a conflict', async t => {
  const f = await withStudio(t);
  await assert.rejects(f.command('project.create', { title: 'Again', language: 'ko', budgetMicros: 0 }), code('PROJECT_EXISTS'));
  assert.equal((await f.service.snapshot('p1')).project.title, '작품');
});

it('uses bound values so quote-containing titles round trip', async t => {
  const f = await withStudio(t);
  const title = "O'Brien'); DROP TABLE projects; --";
  await f.command('production.create', { ...production('main'), title });
  assert.equal((await f.service.snapshot('p1')).productions[0].title, title);
});

it('rejects malformed IDs, non-JSON values, prototype keys and unresolved references', async t => {
  const f = await withStudio(t);
  const invalid = [production('../escape'), { ...production('main'), title: NaN }, { ...production('main'), title: Infinity },
    { ...production('main'), extra: undefined }, JSON.parse('{"id":"main","title":"x","sourcePackageId":null,"__proto__":{"x":1}}')];
  for (const payload of invalid) await assert.rejects(f.command('production.create', payload), code('INVALID_INPUT'));
  await assert.rejects(f.command('production.create', { ...production('main'), sourcePackageId: 'missing' }), code('INVALID_REFERENCE'));
  assert.equal((await f.service.snapshot('p1')).eventCursor, 1);
});

it('rolls back handler writes, command records and cursors when a handler fails', async t => {
  const f = await withStudio(t);
  f.service.registerCommand('test.fail', { target: () => ({ kind: 'project', id: 'p1' }), apply({ store }) {
    store.run('UPDATE projects SET title = ? WHERE id = ?', 'broken', 'p1');
    throw new Error('expected test failure');
  } });
  await assert.rejects(f.command('test.fail', {}), code('COMMAND_FAILED'));
  assert.equal((await f.service.snapshot('p1')).project.title, '작품');
  assert.equal((await f.service.snapshot('p1')).eventCursor, 1);
});

it('rejects async handlers and rolls back returned promises', async t => {
  const f = await withStudio(t);
  assert.throws(() => f.service.registerCommand('test.async', { target: () => ({ kind: 'project', id: 'p1' }), async apply() {} }), code('ASYNC_HANDLER'));
  f.service.registerCommand('test.promise', { target: () => ({ kind: 'project', id: 'p1' }), apply({ store }) {
    store.run('UPDATE projects SET title = ? WHERE id = ?', 'broken', 'p1'); return Promise.resolve({});
  } });
  await assert.rejects(f.command('test.promise', {}), code('ASYNC_HANDLER'));
  assert.equal((await f.service.snapshot('p1')).project.title, '작품');
});

it('serves ordered project-scoped events after a cursor', async t => {
  const f = await withStudio(t);
  await f.command('production.create', production('main'));
  assert.deepEqual((await f.service.events('p1', 1)).map(e => [e.cursor, e.type, e.aggregateRevision]), [[2, 'production.create', 1]]);
  await assert.rejects(f.service.events('missing'), code('PROJECT_NOT_FOUND'));
});

it('writes bytes immutably and reads them only for their registered project', async t => {
  const f = await withStudio(t);
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const blob = await f.service.blobs.put('p1', bytes);
  assert.equal(blob.blobId, '3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56');
  assert.deepEqual(await f.service.readBlob('p1', blob.blobId), bytes);
  assert.equal((await f.service.blobs.put('p1', bytes)).blobId, blob.blobId);
  await assert.rejects(f.service.blobs.put('p1', '/arbitrary/path'), code('INVALID_INPUT'));
  await assert.rejects(f.service.readBlob('missing', blob.blobId), code('PROJECT_NOT_FOUND'));
  assert.equal((await f.service.events('p1')).length, 1);
});

it('blocks reading corrupt blobs', async t => {
  const f = await withStudio(t);
  const { blobId } = await f.service.blobs.put('p1', new Uint8Array([1, 2, 3]));
  await writeFile(join(f.directory, 'blobs', 'p1', blobId), 'corrupt');
  await assert.rejects(f.service.readBlob('p1', blobId), code('BLOB_CORRUPT'));
});

it('does not register bytes after a disk write failure', async t => {
  const f = await withStudio(t);
  await writeFile(join(f.directory, 'blobs', 'p1'), 'not a directory');
  await assert.rejects(f.service.blobs.put('p1', new Uint8Array([1, 2, 3])));
  assert.equal(f.service.store.get('SELECT count(*) AS n FROM blobs').n, 0);
});

it('recovers durable orphan blobs on reopening and blocks missing registered bytes', async t => {
  const f = await withStudio(t);
  const { blobId: missing } = await f.service.blobs.put('p1', new Uint8Array([1]));
  await rm(join(f.directory, 'blobs', 'p1', missing));
  const bytes = new Uint8Array([4, 5, 6]); const orphan = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(f.directory, 'blobs', 'p1', orphan), bytes);
  await f.service.close();
  const reopened = await openStudio({ directory: f.directory }); t.after(() => reopened.close());
  assert.deepEqual(await reopened.readBlob('p1', orphan), bytes);
  await assert.rejects(reopened.readBlob('p1', missing), code('BLOB_MISSING'));
});

it('never registers corrupt orphan bytes during recovery', async t => {
  const f = await withStudio(t);
  await mkdir(join(f.directory, 'blobs', 'p1'));
  const fakeHash = 'a'.repeat(64);
  await writeFile(join(f.directory, 'blobs', 'p1', fakeHash), 'wrong hash');
  await f.service.close();
  const reopened = await openStudio({ directory: f.directory }); t.after(() => reopened.close());
  await assert.rejects(reopened.readBlob('p1', fakeHash), code('BLOB_NOT_FOUND'));
});

it('refuses all public operations after idempotent close', async t => {
  const f = await withStudio(t);
  await f.service.close(); await f.service.close();
  await assert.rejects(f.service.snapshot('p1'), code('STUDIO_CLOSED'));
  await assert.rejects(f.service.events('p1'), code('STUDIO_CLOSED'));
  await assert.rejects(f.service.readBlob('p1', 'a'.repeat(64)), code('STUDIO_CLOSED'));
  await assert.rejects(f.service.command({}), code('STUDIO_CLOSED'));
  await assert.rejects(f.service.blobs.put('p1', new Uint8Array([1])), code('STUDIO_CLOSED'));
  assert.throws(() => f.service.registerCommand('test.closed', {}), code('STUDIO_CLOSED'));
});


it('allows exactly one process to win a simultaneous CAS on the same aggregate', async t => {
  const f = await withStudio(t);
  const script = `import {openStudio} from ${JSON.stringify(new URL('../src/engine/index.js', import.meta.url).href)};
    const s=await openStudio({directory:process.argv[1]});
    try { const r=await s.command({projectId:'p1', commandId:process.argv[2], aggregate:{kind:'production',id:'main'},
      expectedRevision:0,type:'production.create',payload:{id:'main',title:'본편',sourcePackageId:null}});
      console.log(JSON.stringify({revision:r.aggregateRevision})); }
    catch(e) { console.log(JSON.stringify({code:e.code})); } finally {await s.close();}`;
  const results = await Promise.all(['a', 'b'].map(id => exec(process.execPath, ['--input-type=module', '-e', script, f.directory, id])));
  assert.deepEqual(results.map(r => JSON.parse(r.stdout)).sort((a, b) => (a.code ?? '').localeCompare(b.code ?? '')),
    [{ revision: 1 }, { code: 'REVISION_CONFLICT' }]);
  assert.equal((await f.service.snapshot('p1')).eventCursor, 2);
});

it('denies another existing project access to bytes registered only in the first project', async t => {
  const f = await withStudio(t);
  await f.service.command({ projectId: 'p2', commandId: 'create', aggregate: { kind: 'project', id: 'p2' }, expectedRevision: 0,
    type: 'project.create', payload: { title: '다른 작품', language: 'ko', budgetMicros: 0 } });
  const { blobId } = await f.service.blobs.put('p1', new Uint8Array([1, 2, 3]));
  await assert.rejects(f.service.readBlob('p2', blobId), code('BLOB_NOT_FOUND'));
  assert.deepEqual((await f.service.events('p2')).map(e => e.type), ['project.create']);
});

it('leaves no registry entry or temporary file when the OS denies a byte write', async t => {
  const f = await withStudio(t);
  const directory = join(f.directory, 'blobs', 'p1');
  await mkdir(directory); await chmod(directory, 0o500);
  try {
    await assert.rejects(f.service.blobs.put('p1', new Uint8Array([1, 2, 3])), error => error.code === 'BLOB_WRITE_FAILED' && error.details.reason === 'EACCES');
    assert.equal(f.service.store.get('SELECT count(*) AS n FROM blobs').n, 0);
  } finally { await chmod(directory, 0o700); }
  assert.deepEqual(await readdir(directory), []);
});

it('recovers bytes published before a failed registry transaction', async t => {
  const f = await withStudio(t);
  f.service.store.run("CREATE TRIGGER reject_blob BEFORE INSERT ON blobs BEGIN SELECT RAISE(ABORT, 'registration denied'); END");
  await assert.rejects(f.service.blobs.put('p1', new Uint8Array([1, 2, 3])), code('BLOB_WRITE_FAILED'));
  assert.equal(f.service.store.get('SELECT count(*) AS n FROM blobs').n, 0);
  f.service.store.run('DROP TRIGGER reject_blob'); await f.service.close();
  const reopened = await openStudio({ directory: f.directory }); t.after(() => reopened.close());
  assert.deepEqual(await reopened.readBlob('p1', '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'), new Uint8Array([1, 2, 3]));
});

it('refuses to overwrite an existing corrupt immutable blob during publication', async t => {
  const f = await withStudio(t);
  const bytes = new Uint8Array([1, 2, 3]);
  const { blobId } = await f.service.blobs.put('p1', bytes);
  await writeFile(join(f.directory, 'blobs', 'p1', blobId), 'corrupt');
  await assert.rejects(f.service.blobs.put('p1', bytes), code('BLOB_CORRUPT'));
  await assert.rejects(f.service.readBlob('p1', blobId), code('BLOB_CORRUPT'));
});

it('finishes accepted blob writes before closing the underlying database', async t => {
  const f = await withStudio(t);
  const write = f.service.blobs.put('p1', new Uint8Array([7, 8, 9]));
  const close = f.service.close();
  const { blobId } = await write; await close;
  const reopened = await openStudio({ directory: f.directory }); t.after(() => reopened.close());
  assert.deepEqual(await reopened.readBlob('p1', blobId), new Uint8Array([7, 8, 9]));
});


it('returns safe public errors without directory paths, SQL details or handler secrets', async t => {
  const f = await withStudio(t);
  await writeFile(join(f.directory, 'blobs', 'p1'), 'not a directory');
  await assert.rejects(f.service.blobs.put('p1', new Uint8Array([1])), error => {
    assert.equal(error.code, 'BLOB_WRITE_FAILED');
    assert.deepEqual(error.details, { reason: 'EEXIST' });
    assert.ok(!`${error.message}${JSON.stringify(error)}`.includes(f.directory));
    return true;
  });
  f.service.registerCommand('test.secret', { target: () => ({ kind: 'project', id: 'p1' }), apply() {
    throw new Error(`sensitive prompt bytes at ${f.directory}`);
  } });
  await assert.rejects(f.command('test.secret', {}), error => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.deepEqual(error.details, {});
    assert.ok(!`${error.message}${JSON.stringify(error)}`.includes('sensitive'));
    assert.ok(!`${error.message}${JSON.stringify(error)}`.includes(f.directory));
    return true;
  });
  f.service.store.run('DROP TABLE productions');
  await assert.rejects(f.service.snapshot('p1'), error => {
    assert.equal(error.code, 'STORAGE_FAILED');
    assert.ok(!error.message.includes('productions'));
    assert.deepEqual(error.details, {});
    return true;
  });
});

it('omits caller-supplied prompt and path fields from revision conflict details', async t => {
  const f = await withStudio(t);
  await f.command('production.create', production('main'));
  await assert.rejects(f.command('production.create', production('main'), {
    expectedRevision: 0, aggregate: { kind: 'production', id: 'main', prompt: 'sensitive prompt', path: f.directory },
  }), error => {
    assert.equal(error.code, 'REVISION_CONFLICT');
    assert.deepEqual(error.details.aggregate, { kind: 'production', id: 'main' });
    assert.ok(!JSON.stringify(error).includes(f.directory));
    assert.ok(!JSON.stringify(error).includes('sensitive prompt'));
    return true;
  });
});

it('reads the current revision for an overridden aggregate when using an extension handler', async t => {
  const f = await withStudio(t);
  await f.command('production.create', production('main'));
  f.service.registerCommand('production.rename', {
    target: ({ envelope }) => ({ kind: 'production', id: envelope.payload.id }),
    apply({ store, envelope, aggregate }) {
      store.run('UPDATE productions SET title = ? WHERE project_id = ? AND id = ?', envelope.payload.title, envelope.projectId, envelope.payload.id);
      return { ...aggregate.value, title: envelope.payload.title };
    },
  });
  const overrides = { aggregate: { kind: 'production', id: 'main' } };
  await f.command('production.rename', { id: 'main', title: '둘째 제목' }, overrides);
  const result = await f.command('production.rename', { id: 'main', title: '셋째 제목' }, overrides);
  assert.equal(result.aggregateRevision, 3);
  assert.equal((await f.service.snapshot('p1')).productions[0].title, '셋째 제목');
  assert.equal((await f.service.snapshot('p1')).aggregates.find(a => a.kind === 'project').revision, 1);
});


it('rejects non-enumerable unsafe, hidden and symbol JSON properties', () => {
  for (const key of ['__proto__', 'prototype', 'constructor', 'hidden', Symbol('hidden')]) {
    const input = { ok: 1 };
    Object.defineProperty(input, key, { value: 2 });
    assert.throws(() => canonicalJSON(input), code('INVALID_INPUT'));
  }
  const input = { ok: 1, [Symbol('enumerable')]: 2 };
  assert.throws(() => canonicalJSON(input), code('INVALID_INPUT'));
});

it('rejects array own getters before they can substitute serialized indices', () => {
  let getterCalls = 0;
  const input = [1];
  Object.defineProperty(input, 'map', { get() { getterCalls++; return () => [999]; } });
  assert.throws(() => canonicalJSON(input), code('INVALID_INPUT'));
  assert.equal(getterCalls, 0);
  const indexed = [1];
  Object.defineProperty(indexed, '0', { enumerable: true, get() { getterCalls++; return 999; } });
  assert.throws(() => canonicalJSON(indexed), code('INVALID_INPUT'));
  assert.equal(getterCalls, 0);
  assert.equal(canonicalJSON([1, { b: 2, a: 1 }]), '[1,{"a":1,"b":2}]');
});

function observeSync(t, callback) {
  const realOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await realOpen(...args);
    const realSync = handle.sync.bind(handle);
    handle.sync = async () => { await callback(String(args[0]), 'before'); await realSync(); await callback(String(args[0]), 'after'); };
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

it('syncs initial blob-root parent and the full publication directory chain before registration', async t => {
  const operations = [];
  observeSync(t, (path, phase) => { if (phase === 'after') operations.push({ type: 'sync', path }); });
  const f = await withStudio(t);
  assert.ok(operations.some(operation => operation.path === f.directory), 'initial blobs root entry requires storage parent sync');
  operations.length = 0;
  f.service.store.db.function('observe_blob_registration', () => { operations.push({ type: 'register' }); return 1; });
  f.service.store.run('CREATE TRIGGER observe_blob BEFORE INSERT ON blobs BEGIN SELECT observe_blob_registration(); END');
  await f.service.blobs.put('p1', new Uint8Array([1, 2, 3]));
  const registry = operations.findIndex(operation => operation.type === 'register');
  const file = operations.findIndex(operation => operation.path?.endsWith('.tmp'));
  const leaf = operations.findIndex(operation => operation.path === join(f.directory, 'blobs', 'p1'));
  const blobs = operations.findIndex(operation => operation.path === join(f.directory, 'blobs'));
  const storage = operations.findIndex(operation => operation.path === f.directory);
  assert.ok(file >= 0 && leaf > file && blobs > leaf && storage > blobs && registry > storage,
    'bytes and every parent directory entry must be synced before the registry transaction');
});

it('blocks registration when publication parent-directory sync fails', async t => {
  const f = await withStudio(t);
  observeSync(t, (path, phase) => {
    if (phase === 'before' && path === join(f.directory, 'blobs')) throw Object.assign(new Error('injected sync failure'), { code: 'EIO' });
  });
  await assert.rejects(f.service.blobs.put('p1', new Uint8Array([1, 2, 3])), error => error.code === 'BLOB_WRITE_FAILED' && error.details.reason === 'EIO');
  assert.equal(f.service.store.get('SELECT count(*) AS n FROM blobs').n, 0);
  t.mock.restoreAll(); syncBuiltinESMExports();
  const { blobId } = await f.service.blobs.put('p1', new Uint8Array([1, 2, 3]));
  assert.deepEqual(await f.service.readBlob('p1', blobId), new Uint8Array([1, 2, 3]));
});
