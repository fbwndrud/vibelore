import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sealBundle } from '../src/reuse/bundle.js';
import { pngBytes, pngSha256 } from './helpers/bundles.js';
let openLibrary;
try { ({ openLibrary } = await import('../src/library/index.js')); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const code = expected => error => error.code === expected;
const ref = (ownerId, overrides = {}) => ({ ownerId, projectId: 'project', recordKind: 'candidate', recordId: 'same', revision: 'native:1', ...overrides });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const entry = (ownerId, overrides = {}) => ({ ref: ref(ownerId), title: 'Same portrait', mediaKind: 'image', roles: ['identity-reference'], subjects: [{ ownerId, projectId: 'project', identityId: 'hero', stateRefs: [] }], expressionRefs: [], availability: 'observed-available', capabilities: ['discover', 'preserve', 'inspect'], ...overrides });
function source() { return { fingerprint: 'physical:1', token: 'token:1', failure: null, capture: null, exports: null, calls: 0, entries: null, verify: true }; }
function adapters(sources) {
  return { fake: ({ locator, ownerId, allowedProjects }) => {
    const state = sources[locator];
    if (!state) throw new Error(`private locator ${locator}`);
    return {
      async identify() { if (state.failure) throw state.failure; return state.fingerprint; },
      async verifyRefs(refs) { return state.verify && refs.every(value => value.ownerId === ownerId && allowedProjects.includes(value.projectId)); },
      async capture(request) {
        state.calls++; assert.equal(request.ownerId, ownerId); assert.deepEqual(request.allowedProjects, allowedProjects);
        if (state.failure) throw state.failure;
        if (state.capture) return state.capture(request);
        return { token: state.token, entries: state.entries ?? [entry(ownerId)], links: [{ from: ref(ownerId), relation: 'derived-from', to: ref(ownerId, { recordId: 'parent' }), requirement: 'historical-reference' }], uses: [{ ref: ref(ownerId), usedIn: ref(ownerId, { recordKind: 'edition', recordId: 'edition' }) }], cases: [{ id: 'case', ownerId, projectId: 'project', question: 'Which portrait?', contextRefs: [ref(ownerId)], literalInputRefs: [], trials: [], observations: [], unknowns: ['unobserved quality'] }] };
      },
      async exportExact({ roots, disclosure }) {
        if (state.exports) return state.exports({ roots, disclosure });
        return { bundle: sealBundle({ schemaVersion: 1, roots, records: roots.map(value => ({ ref: value, metadata: { title: 'Same portrait' }, requiredFileSha256s: [pngSha256], sourcePins: {}, evidenceRefs: [] })), files: [{ sha256: pngSha256, byteLength: pngBytes.length, mime: 'image/png', role: 'selected-content' }], links: [], disclosure, capturedAt: '2026-10-21T00:00:00.000Z' }), bytes: { [pngSha256]: [...pngBytes] } };
      }
    };
  } };
}
async function setup(t, sources = { '/private/owner-a': source(), '/private/owner-b': source() }) {
  assert.equal(typeof openLibrary, 'function', 'openLibrary must implement explicit federated metadata owners');
  const directory = await mkdtemp(join(tmpdir(), 'studio-library-'));
  const handles = []; const factories = adapters(sources);
  async function open() { const library = await openLibrary({ directory, adapters: factories }); handles.push(library); return library; }
  t.after(async () => { for (const library of handles) await library.close(); await rm(directory, { recursive: true, force: true }); });
  const library = await open(); let serial = 0;
  const command = async (type, payload, extra = {}) => library.command({ commandId: `command-${++serial}`, expectedRegistryRevision: (await library.query({ type: 'find' })).registryRevision, type, payload, ...extra });
  const register = async (locator = '/private/owner-a') => command('owner.register', { adapterKind: 'fake', locator, allowedProjects: ['project'] });
  return { library, sources, directory, command, register, open };
}

test('owner identity and exact filters do not merge shared names or bytes; graph and cases stay owner-scoped', async t => {
  const { library, register, command } = await setup(t); const a = await register(); const b = await register('/private/owner-b');
  assert.notEqual(a.ownerId, b.ownerId); assert.match(a.ownerId, /^[0-9a-f-]{36}$/);
  await command('owner.refresh', { ownerId: a.ownerId }); await command('owner.refresh', { ownerId: b.ownerId });
  assert.equal((await library.query({ type: 'find' })).entries.length, 2);
  const result = await library.query({ type: 'find', text: 'PORTRAIT', mediaKind: 'image', ownerId: a.ownerId, projectId: 'project', role: 'identity-reference', subject: { ownerId: a.ownerId, projectId: 'project', identityId: 'hero' }, limit: 1 });
  assert.deepEqual(result.entries.map(value => value.ref), [ref(a.ownerId)]);
  assert.equal((await library.query({ type: 'find', mediaKind: 'audio' })).entries.length, 0);
  assert.equal((await library.query({ type: 'inspect', ref: ref(a.ownerId) })).status, 'observed-available');
  assert.equal((await library.query({ type: 'lineage', ref: ref(a.ownerId) })).links[0].to.recordId, 'parent');
  assert.equal((await library.query({ type: 'uses', ref: ref(b.ownerId) })).uses[0].usedIn.ownerId, b.ownerId);
  assert.deepEqual((await library.query({ type: 'cases', ownerId: a.ownerId, projectId: 'project' })).cases.map(value => value.ownerId), [a.ownerId]);
});

test('durable SQLite registry reopens, rebuilds removed projection only from explicit refresh and issues a UUID for a copy', async t => {
  const { library, register, command, directory, open, sources } = await setup(t); const a = await register(); await command('owner.refresh', { ownerId: a.ownerId });
  await library.close();
  const registry = new DatabaseSync(join(directory, 'library-registry.sqlite'), { readOnly: true });
  assert.equal(registry.prepare('PRAGMA user_version').get().user_version, 1); registry.close();
  await rm(join(directory, 'library-projection.sqlite'), { force: true });
  const reopened = await open(); const before = sources['/private/owner-a'].calls;
  const view = await reopened.query({ type: 'find' }); assert.equal(view.owners[0].ownerId, a.ownerId); assert.deepEqual(view.entries, []); assert.equal(sources['/private/owner-a'].calls, before);
  assert.equal((await reopened.query({ type: 'inspect', ref: ref(a.ownerId) })).status, 'unverified');
  await reopened.command({ commandId: 'rebuild', expectedRegistryRevision: view.registryRevision, type: 'owner.refresh', payload: { ownerId: a.ownerId } });
  assert.equal((await reopened.query({ type: 'find' })).entries.length, 1);
  const copied = await reopened.command({ commandId: 'copy', expectedRegistryRevision: view.registryRevision, type: 'owner.register', payload: { adapterKind: 'fake', locator: '/private/owner-b', allowedProjects: ['project'] } });
  assert.notEqual(copied.ownerId, a.ownerId);
});

test('offline retains observation time, does not erase another owner, and differs from confirmed exact missing', async t => {
  const { library, register, command, sources } = await setup(t); const a = await register(); const b = await register('/private/owner-b');
  await command('owner.refresh', { ownerId: a.ownerId }); await command('owner.refresh', { ownerId: b.ownerId });
  const old = (await library.query({ type: 'inspect', ref: ref(a.ownerId) })).entry.observed;
  sources['/private/owner-a'].failure = new Error('offline at /private/owner-a');
  const failed = await command('owner.refresh', { ownerId: a.ownerId }); assert.equal(failed.status, 'offline');
  const offline = await library.query({ type: 'inspect', ref: ref(a.ownerId) }); assert.equal(offline.status, 'offline'); assert.deepEqual(offline.entry.observed, old);
  assert.equal((await library.query({ type: 'inspect', ref: ref(b.ownerId) })).status, 'observed-available');
  sources['/private/owner-a'].failure = null; sources['/private/owner-a'].entries = [];
  await command('owner.refresh', { ownerId: a.ownerId });
  assert.equal((await library.query({ type: 'inspect', ref: ref(a.ownerId) })).status, 'missing');
  assert.equal((await library.query({ type: 'inspect', ref: ref(a.ownerId, { revision: 'unknown' }) })).status, 'missing');
});

test('refresh completion order cannot overwrite the newest request, even across two open facades', async t => {
  const { library, register, command, sources, open } = await setup(t); const a = await register(); const started = deferred(); const release = deferred();
  sources['/private/owner-a'].capture = async () => { started.resolve(); await release.promise; return { token: 'zzz-old', entries: [entry(a.ownerId, { title: 'Old' })], links: [], uses: [], cases: [] }; };
  const old = command('owner.refresh', { ownerId: a.ownerId }); await started.promise;
  const second = await open(); sources['/private/owner-a'].capture = async () => ({ token: 'aaa-new', entries: [entry(a.ownerId, { title: 'New' })], links: [], uses: [], cases: [] });
  await second.command({ commandId: 'new-refresh', expectedRegistryRevision: a.registryRevision, type: 'owner.refresh', payload: { ownerId: a.ownerId } }); release.resolve();
  assert.equal((await old).status, 'discarded'); assert.equal((await library.query({ type: 'find' })).entries[0].title, 'New');
});

for (const mutation of ['owner.unregister', 'owner.rebind']) test(`late refresh cannot revive data after ${mutation}`, async t => {
  const { library, register, command, sources } = await setup(t); const a = await register(); const started = deferred(); const release = deferred();
  sources['/private/owner-a'].capture = async () => { started.resolve(); await release.promise; return { token: 'old', entries: [entry(a.ownerId)], links: [], uses: [], cases: [] }; };
  const refresh = command('owner.refresh', { ownerId: a.ownerId }); await started.promise;
  await command(mutation, mutation === 'owner.unregister' ? { ownerId: a.ownerId } : { ownerId: a.ownerId, locator: '/private/owner-b', confirmRefs: [ref(a.ownerId)] });
  release.resolve(); assert.equal((await refresh).status, 'discarded'); assert.deepEqual((await library.query({ type: 'find' })).entries, []);
});

test('commands replay exactly after reopen and reject payload conflicts and stale registry CAS', async t => {
  const { library, open } = await setup(t); const envelope = { commandId: 'stable', expectedRegistryRevision: 0, type: 'owner.register', payload: { adapterKind: 'fake', locator: '/private/owner-a', allowedProjects: ['project'] } };
  const receipt = await library.command(envelope); assert.deepEqual(await library.command(envelope), receipt);
  await library.close(); const reopened = await open(); assert.deepEqual(await reopened.command(envelope), receipt);
  await assert.rejects(reopened.command({ ...envelope, payload: { ...envelope.payload, locator: '/private/owner-b' } }), code('COMMAND_CONFLICT'));
  await assert.rejects(reopened.command({ ...envelope, commandId: 'stale' }), code('REVISION_CONFLICT'));
});

test('private locators and adapter errors never escape DTOs or export errors; export validates exact roots, scope and bytes', async t => {
  const { library, register, command, sources } = await setup(t); const a = await register(); await command('owner.refresh', { ownerId: a.ownerId });
  const exported = await library.exportExact({ ownerId: a.ownerId, roots: [ref(a.ownerId)], disclosure: { includedScope: 'Selected', omittedEvidence: [] } });
  assert.deepEqual(exported.bytes[pngSha256], pngBytes);
  const serialized = JSON.stringify([a, await library.query({ type: 'find' }), exported]); assert.equal(serialized.includes('/private/'), false); assert.equal(serialized.includes('physical:'), false);
  await assert.rejects(library.exportExact({ ownerId: a.ownerId, roots: [ref(a.ownerId, { projectId: 'secret' })], disclosure: {} }), code('PROJECT_NOT_ALLOWED'));
  await assert.rejects(library.exportExact({ ownerId: a.ownerId, roots: [ref('another-owner')], disclosure: {} }), code('OWNER_SCOPE_MISMATCH'));
  sources['/private/owner-a'].exports = async () => { throw new Error('secret /private/owner-a'); };
  await assert.rejects(library.exportExact({ ownerId: a.ownerId, roots: [ref(a.ownerId)], disclosure: {} }), error => error.code === 'OWNER_OFFLINE' && !JSON.stringify(error).includes('/private/'));
  sources['/private/owner-a'].exports = async ({ roots, disclosure }) => ({ bundle: sealBundle({ schemaVersion: 1, roots, records: roots.map(value => ({ ref: value, metadata: {}, requiredFileSha256s: [pngSha256], sourcePins: {}, evidenceRefs: [] })), files: [{ sha256: pngSha256, byteLength: pngBytes.length, mime: 'image/png', role: 'selected-content' }], links: [], disclosure, capturedAt: 'now' }), bytes: { [pngSha256]: pngBytes.map(() => 0) } });
  await assert.rejects(library.exportExact({ ownerId: a.ownerId, roots: [ref(a.ownerId)], disclosure: { includedScope: 'Selected', omittedEvidence: [] } }), code('BUNDLE_HASH_MISMATCH'));
});

test('same-path replacement is blocked before capture/export; explicit rebind needs verified exact refs', async t => {
  const { library, register, command, sources } = await setup(t); const a = await register(); await command('owner.refresh', { ownerId: a.ownerId });
  const observed = (await library.query({ type: 'find' })).entries[0].observed;
  sources['/private/owner-a'].fingerprint = 'physical:replacement';
  const result = await command('owner.refresh', { ownerId: a.ownerId }); assert.equal(result.error.code, 'OWNER_REPLACED');
  const view = await library.query({ type: 'inspect', ref: ref(a.ownerId) }); assert.equal(view.entry.availability, 'unverified'); assert.deepEqual(view.entry.observed, observed);
  await assert.rejects(library.exportExact({ ownerId: a.ownerId, roots: [ref(a.ownerId)], disclosure: {} }), code('OWNER_REPLACED'));
  await assert.rejects(command('owner.rebind', { ownerId: a.ownerId, locator: '/private/owner-b', confirmRefs: [] }), code('INVALID_INPUT'));
  sources['/private/owner-b'].verify = false;
  await assert.rejects(command('owner.rebind', { ownerId: a.ownerId, locator: '/private/owner-b', confirmRefs: [ref(a.ownerId)] }), code('OWNER_REBIND_UNCONFIRMED'));
  sources['/private/owner-b'].verify = true;
  const rebound = await command('owner.rebind', { ownerId: a.ownerId, locator: '/private/owner-b', confirmRefs: [ref(a.ownerId)] }); assert.equal(rebound.ownerId, a.ownerId);
  await command('owner.refresh', { ownerId: a.ownerId }); assert.equal((await library.query({ type: 'find' })).entries[0].observed.registrationGeneration, 2);
});

test('replacement while capturing or exporting cannot publish observations or bytes', async t => {
  const { library, register, command, sources } = await setup(t); const a = await register(); const state = sources['/private/owner-a'];
  state.capture = async () => { state.fingerprint = 'replaced-during-capture'; return { token: 'new', entries: [entry(a.ownerId)], links: [], uses: [], cases: [] }; };
  assert.equal((await command('owner.refresh', { ownerId: a.ownerId })).error.code, 'OWNER_REPLACED'); assert.deepEqual((await library.query({ type: 'find' })).entries, []);
  await command('owner.rebind', { ownerId: a.ownerId, locator: '/private/owner-a', confirmRefs: [ref(a.ownerId)] });
  state.exports = async () => { state.fingerprint = 'replaced-during-export'; return {}; };
  await assert.rejects(library.exportExact({ ownerId: a.ownerId, roots: [ref(a.ownerId)], disclosure: {} }), code('OWNER_REPLACED'));
});

test('export in flight is discarded after unregister and close drains admitted work', async t => {
  const { library, register, command, sources } = await setup(t); const a = await register(); const started = deferred(); const release = deferred();
  sources['/private/owner-a'].exports = async () => { started.resolve(); await release.promise; return {}; };
  const exporting = library.exportExact({ ownerId: a.ownerId, roots: [ref(a.ownerId)], disclosure: {} }); await started.promise;
  await command('owner.unregister', { ownerId: a.ownerId }); let closed = false; const closing = library.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); release.resolve(); await assert.rejects(exporting, code('OWNER_CHANGED')); await closing;
  await assert.rejects(library.query({ type: 'find' }), code('LIBRARY_CLOSED'));
});

test('out-of-scope or private adapter projections are rejected without replacing good metadata', async t => {
  const { library, register, command, sources } = await setup(t); const a = await register(); await command('owner.refresh', { ownerId: a.ownerId });
  for (const bad of [entry(a.ownerId, { ref: ref(a.ownerId, { projectId: 'secret' }) }), { ...entry(a.ownerId), locator: '/private/owner-a' }]) {
    sources['/private/owner-a'].capture = async () => ({ token: 'bad', entries: [bad], links: [], uses: [], cases: [] });
    assert.equal((await command('owner.refresh', { ownerId: a.ownerId })).status, 'offline');
    assert.equal((await library.query({ type: 'find' })).entries[0].title, 'Same portrait');
  }
});

test('destination owner exposes cross-owner input uses and lineage without registering the source', async t => {
  const { library, register, command, sources } = await setup(t); const b = await register('/private/owner-b');
  const external = ref('external-source', { projectId: 'external-project', recordId: 'input' });
  const consumed = ref(b.ownerId, { recordKind: 'edition', recordId: 'output' });
  const receiptRef = ref(b.ownerId, { recordKind: 'importReceipt', recordId: 'receipt' });
  sources['/private/owner-b'].capture = async () => ({ token: 'consumer', entries: [entry(b.ownerId)], links: [{ from: external, relation: 'used-in', to: consumed, requirement: 'historical-reference' }], uses: [{ ref: external, usedIn: consumed, receiptRef, role: 'identity-reference' }], cases: [] });
  const refreshed = await command('owner.refresh', { ownerId: b.ownerId }); assert.equal(refreshed.status, 'observed-available');
  const uses = await library.query({ type: 'uses', ref: external }); assert.equal(uses.uses.length, 1); assert.deepEqual(uses.uses[0].receiptRef, receiptRef); assert.deepEqual(uses.owners.map(value => value.ownerId), [b.ownerId]);
  const lineage = await library.query({ type: 'lineage', ref: external }); assert.deepEqual(lineage.links.map(value => value.to), [consumed]);
  sources['/private/owner-b'].capture = async () => ({ token: 'unanchored', entries: [], links: [], uses: [{ ref: external, usedIn: ref('unregistered-other-owner') }], cases: [] });
  assert.equal((await command('owner.refresh', { ownerId: b.ownerId })).status, 'offline');
  assert.equal((await library.query({ type: 'uses', ref: external })).uses.length, 1);
});

test('concurrent replay uses one durable receipt, conflicts while pending, and preserves refresh CAS', async t => {
  const { library, register, command, sources, open } = await setup(t); const a = await register(); const second = await open(); const started = deferred(); const release = deferred();
  sources['/private/owner-a'].capture = async () => { started.resolve(); await release.promise; return { token: 'same', entries: [entry(a.ownerId)], links: [], uses: [], cases: [] }; };
  const envelope = { commandId: 'concurrent', expectedRegistryRevision: a.registryRevision, type: 'owner.refresh', payload: { ownerId: a.ownerId } };
  const first = library.command(envelope); await started.promise; const replay = second.command(envelope);
  await assert.rejects(second.command({ ...envelope, payload: { ownerId: 'different' } }), code('COMMAND_CONFLICT'));
  release.resolve(); assert.deepEqual(await first, await replay);
  await command('owner.register', { adapterKind: 'fake', locator: '/private/owner-b', allowedProjects: ['project'] });
  await assert.rejects(library.command({ ...envelope, commandId: 'stale-refresh' }), code('REVISION_CONFLICT'));
});

test('export cannot substitute another root or leak a locator through literal metadata', async t => {
  const { library, register, sources } = await setup(t); const a = await register();
  for (const change of ['root', 'private']) {
    sources['/private/owner-a'].exports = async ({ roots, disclosure }) => {
      const actual = change === 'root' ? [ref(a.ownerId, { revision: 'native:2' })] : roots;
      return { bundle: sealBundle({ schemaVersion: 1, roots: actual, records: actual.map(value => ({ ref: value, metadata: { title: change === 'private' ? 'secret /private/owner-a' : 'other' }, requiredFileSha256s: [], sourcePins: {}, evidenceRefs: [] })), files: [], links: [], disclosure, capturedAt: 'now' }), bytes: {} };
    };
    await assert.rejects(library.exportExact({ ownerId: a.ownerId, roots: [ref(a.ownerId)], disclosure: { includedScope: 'Selected', omittedEvidence: [] } }), code(change === 'root' ? 'BUNDLE_INCOMPLETE' : 'INVALID_INPUT'));
  }
});

test('late export failure does not override a newer successful refresh observation', async t => {
  const { library, register, command, sources } = await setup(t); const a = await register(); const started = deferred(); const release = deferred();
  sources['/private/owner-a'].exports = async () => { started.resolve(); await release.promise; throw new Error('old failed call /private/owner-a'); };
  const exporting = library.exportExact({ ownerId: a.ownerId, roots: [ref(a.ownerId)], disclosure: {} }); await started.promise;
  await command('owner.refresh', { ownerId: a.ownerId }); release.resolve(); await assert.rejects(exporting, code('OWNER_OFFLINE'));
  assert.equal((await library.query({ type: 'inspect', ref: ref(a.ownerId) })).status, 'observed-available');
});

test('unavailable registration and unsupported source schemas fail safely without creating or erasing owners', async t => {
  const { library, register, command, sources } = await setup(t);
  sources['/private/owner-a'].failure = new Error('offline /private/owner-a');
  await assert.rejects(register(), code('OWNER_OFFLINE')); assert.deepEqual((await library.query({ type: 'find' })).owners, []);
  sources['/private/owner-a'].failure = null; const a = await register(); await command('owner.refresh', { ownerId: a.ownerId });
  sources['/private/owner-a'].failure = Object.assign(new Error('schema path /private/owner-a'), { code: 'SOURCE_SCHEMA_UNSUPPORTED' });
  const refreshed = await command('owner.refresh', { ownerId: a.ownerId }); assert.equal(refreshed.error.code, 'SOURCE_SCHEMA_UNSUPPORTED');
  assert.equal(JSON.stringify(refreshed).includes('/private/'), false); assert.equal((await library.query({ type: 'find' })).entries.length, 1);
});

test('cases preserve declared observation category and exact local record without inventing an assessment', async t => {
  const { library, register, command, sources } = await setup(t); const a = await register();
  const item = { id: 'declared-case', ownerId: a.ownerId, projectId: 'project', question: 'One observed adoption', ref: ref(a.ownerId, { recordKind: 'productionCase', recordId: 'case' }), classification: 'accepted-example', contextRefs: [], literalInputRefs: [], trials: [], observations: [], unknowns: ['not compared'] };
  sources['/private/owner-a'].capture = async () => ({ token: 'case', entries: [], links: [], uses: [], cases: [item] });
  assert.equal((await command('owner.refresh', { ownerId: a.ownerId })).status, 'observed-available');
  assert.deepEqual((await library.query({ type: 'cases' })).cases, [item]);
  for (const bad of [{ ...item, classification: 'winner' }, { ...item, ref: ref('external-owner') }]) {
    sources['/private/owner-a'].capture = async () => ({ token: 'bad', entries: [], links: [], uses: [], cases: [bad] });
    assert.equal((await command('owner.refresh', { ownerId: a.ownerId })).status, 'offline');
    assert.deepEqual((await library.query({ type: 'cases' })).cases, [item]);
  }
});

test('facade snapshots caller requests before asynchronous admission', async t => {
  const { library, sources } = await setup(t); sources['/private/owner-b'].failure = new Error('wrong selected owner');
  const envelope = { commandId: 'snapshot-register', expectedRegistryRevision: 0, type: 'owner.register', payload: { adapterKind: 'fake', locator: '/private/owner-a', allowedProjects: ['project'] } };
  const registering = library.command(envelope); envelope.payload.locator = '/private/owner-b';
  const registered = await registering;
  const request = { ownerId: registered.ownerId, roots: [ref(registered.ownerId)], disclosure: { includedScope: 'Selected', omittedEvidence: [] } };
  const exporting = library.exportExact(request); request.roots[0].projectId = 'secret';
  assert.equal((await exporting).bundle.roots[0].projectId, 'project');
  const filter = { type: 'find' }; const finding = library.query(filter); filter.type = 'invalid';
  assert.equal((await finding).owners[0].ownerId, registered.ownerId);
});

test('entry preserves explicitly declared external identity subjects without merging owners or registering sources', async t => {
  const { library, register, command, sources } = await setup(t); const a = await register();
  const subject = { ownerId: 'original-owner', projectId: 'original-project', identityId: 'hero', continuityId: 'original-continuity', stateRefs: [ref('original-owner', { projectId: 'original-project', recordKind: 'appearanceState' })] };
  sources['/private/owner-a'].entries = [entry(a.ownerId, { subjects: [subject] })];
  assert.equal((await command('owner.refresh', { ownerId: a.ownerId })).status, 'observed-available');
  const found = await library.query({ type: 'find', subject: { ownerId: 'original-owner', projectId: 'original-project', identityId: 'hero' } });
  assert.deepEqual(found.entries[0].subjects, [subject]); assert.deepEqual(found.owners.map(value => value.ownerId), [a.ownerId]);
  assert.equal(sources['/private/owner-b'].calls, 0);
});

test('explicit rebind expands allowed project scope while preserving owner UUID and fencing old captures', async t => {
  const { library, register, command, sources } = await setup(t); const a = await register();
  const secondRef = ref(a.ownerId, { projectId: 'second-project' });
  sources['/private/owner-b'].entries = [entry(a.ownerId, { ref: secondRef, subjects: [] })];
  await assert.rejects(command('owner.rebind', { ownerId: a.ownerId, locator: '/private/owner-b', allowedProjects: [], confirmRefs: [secondRef] }), code('INVALID_INPUT'));
  const rebound = await command('owner.rebind', { ownerId: a.ownerId, locator: '/private/owner-b', allowedProjects: ['project', 'second-project'], confirmRefs: [secondRef] });
  assert.equal(rebound.ownerId, a.ownerId); assert.equal(rebound.generation, 2);
  assert.equal((await command('owner.refresh', { ownerId: a.ownerId })).status, 'observed-available');
  const found = await library.query({ type: 'find', projectId: 'second-project' }); assert.deepEqual(found.entries.map(value => value.ref), [secondRef]);
  assert.deepEqual(found.owners[0].allowedProjects, ['project', 'second-project']);
  const exported = await library.exportExact({ ownerId: a.ownerId, roots: [secondRef], disclosure: { includedScope: 'Selected', omittedEvidence: [] } }); assert.equal(exported.bundle.roots[0].projectId, 'second-project');
  await assert.rejects(command('owner.rebind', { ownerId: a.ownerId, locator: '/private/owner-b', allowedProjects: ['project'], confirmRefs: [secondRef] }), code('INVALID_INPUT'));
});

test('scope shrink hides old local anchors, retains private history and keeps another consumer external provenance', async t => {
  const { library, register, command, sources, directory } = await setup(t); const a = await register(); const b = await register('/private/owner-b');
  const removed = ref(a.ownerId, { projectId: 'second-project' }); const kept = ref(a.ownerId);
  await command('owner.rebind', { ownerId: a.ownerId, locator: '/private/owner-a', allowedProjects: ['project', 'second-project'], confirmRefs: [kept] });
  const caseItem = { id: 'historic', ownerId: a.ownerId, projectId: 'second-project', question: 'Earlier observation', contextRefs: [], literalInputRefs: [], trials: [], observations: [], unknowns: [] };
  sources['/private/owner-a'].capture = async () => ({ token: 'two-projects', entries: [entry(a.ownerId), entry(a.ownerId, { ref: removed, subjects: [] })], links: [{ from: removed, relation: 'derived-from', to: kept, requirement: 'historical-reference' }], uses: [{ ref: kept, usedIn: removed }], cases: [caseItem] });
  sources['/private/owner-b'].capture = async () => ({ token: 'consumer', entries: [], links: [], uses: [{ ref: removed, usedIn: ref(b.ownerId) }], cases: [] });
  await command('owner.refresh', { ownerId: a.ownerId }); await command('owner.refresh', { ownerId: b.ownerId });
  const old = (await library.query({ type: 'inspect', ref: removed })).entry.observed;
  await command('owner.rebind', { ownerId: a.ownerId, locator: '/private/owner-a', allowedProjects: ['project'], confirmRefs: [kept] });
  const excluded = await library.query({ type: 'inspect', ref: removed }); assert.equal(excluded.status, 'unverified'); assert.equal(excluded.entry, null);
  assert.deepEqual((await library.query({ type: 'find', ownerId: a.ownerId })).entries.map(value => value.ref), [kept]);
  assert.deepEqual((await library.query({ type: 'cases', ownerId: a.ownerId })).cases, []);
  assert.deepEqual((await library.query({ type: 'lineage', ref: removed })).links, []);
  assert.deepEqual((await library.query({ type: 'uses', ref: kept })).uses, []);
  assert.deepEqual((await library.query({ type: 'uses', ref: removed })).uses.map(value => value.usedIn.ownerId), [b.ownerId]);
  await assert.rejects(library.exportExact({ ownerId: a.ownerId, roots: [removed], disclosure: {} }), code('PROJECT_NOT_ALLOWED'));
  sources['/private/owner-a'].capture = async () => ({ token: 'one-project', entries: [entry(a.ownerId)], links: [], uses: [], cases: [] });
  await command('owner.refresh', { ownerId: a.ownerId });
  const projection = new DatabaseSync(join(directory, 'library-projection.sqlite'), { readOnly: true });
  const stored = JSON.parse(projection.prepare('SELECT value_json FROM snapshots WHERE owner_id=?').get(a.ownerId).value_json); projection.close();
  assert.deepEqual(stored.entries.find(value => value.ref.projectId === 'second-project').observed, old); assert.equal(stored.entries.find(value => value.ref.projectId === 'second-project').availability, 'observed-available'); assert.equal(stored.cases[0].id, 'historic'); assert.equal(stored.links.length, 1); assert.equal(stored.uses.length, 1);
  await command('owner.rebind', { ownerId: a.ownerId, locator: '/private/owner-a', allowedProjects: ['project', 'second-project'], confirmRefs: [kept] });
  const restored = await library.query({ type: 'inspect', ref: removed }); assert.equal(restored.status, 'unverified'); assert.deepEqual(restored.entry.observed, old);
});

test('projection rejects embedded relative, nested connection and fingerprint secrets in every portable string', async t => {
  const state = source(); state.fingerprint = 'physical-secret-123';
  const { library, command } = await setup(t, { '[object Object]': state });
  const locator = { directory: 'private-source.sqlite', connection: { endpoint: 'socket:private-connection', fragments: ['nested-store.sqlite', ''] } };
  const registered = await command('owner.register', { adapterKind: 'fake', locator, allowedProjects: ['project'] });
  await command('owner.refresh', { ownerId: registered.ownerId });
  const observed = (await library.query({ type: 'inspect', ref: ref(registered.ownerId) })).entry.observed;
  for (const secret of ['private-source.sqlite', 'socket:private-connection', 'nested-store.sqlite', 'physical-secret-123']) {
    for (const placement of ['value', 'key']) {
      const exposed = `prefix ${secret} suffix`;
      state.capture = async () => ({ token: 'safe-observation-token', entries: [entry(registered.ownerId, { title: placement === 'value' ? exposed : 'Safe title' })], links: [], uses: [], cases: placement === 'key' ? [{ id: 'case', ownerId: registered.ownerId, projectId: 'project', question: 'Literal data', contextRefs: [], literalInputRefs: [], trials: [], observations: [{ [exposed]: 'literal observation' }], unknowns: [] }] : [] });
      const refreshed = await command('owner.refresh', { ownerId: registered.ownerId });
      assert.equal(refreshed.status, 'offline', `${placement} containing private binding must be rejected`);
      const view = await library.query({ type: 'find' }); assert.equal(JSON.stringify([refreshed, view]).includes(secret), false); assert.deepEqual(view.entries[0].observed, observed);
    }
  }
});

test('export rejects embedded relative, nested connection and fingerprint secrets in metadata values and keys', async t => {
  const state = source(); state.fingerprint = 'physical-secret-123';
  const { library, command } = await setup(t, { '[object Object]': state });
  const locator = { directory: 'private-source.sqlite', connection: { endpoint: 'socket:private-connection', fragments: ['nested-store.sqlite', ''] } };
  const registered = await command('owner.register', { adapterKind: 'fake', locator, allowedProjects: ['project'] });
  for (const secret of ['private-source.sqlite', 'socket:private-connection', 'nested-store.sqlite', 'physical-secret-123']) {
    for (const placement of ['value', 'key']) {
      const exposed = `prefix ${secret} suffix`;
      state.exports = async ({ roots, disclosure }) => ({ bundle: sealBundle({ schemaVersion: 1, roots, records: roots.map(value => ({ ref: value, metadata: placement === 'value' ? { title: exposed } : { [exposed]: 'literal data' }, requiredFileSha256s: [], sourcePins: {}, evidenceRefs: [] })), files: [], links: [], disclosure, capturedAt: 'now' }), bytes: {} });
      await assert.rejects(library.exportExact({ ownerId: registered.ownerId, roots: [ref(registered.ownerId)], disclosure: { includedScope: 'Selected', omittedEvidence: [] } }), error => error.code === 'INVALID_INPUT' && !JSON.stringify(error).includes(secret));
    }
  }
});

test('old generation snapshot cannot confirm unknown records missing after expanded-scope rebind', async t => {
  const { library, register, command, sources, open } = await setup(t); const a = await register();
  await command('owner.refresh', { ownerId: a.ownerId });
  const observed = (await library.query({ type: 'inspect', ref: ref(a.ownerId) })).entry.observed;
  await command('owner.rebind', { ownerId: a.ownerId, locator: '/private/owner-a', allowedProjects: ['project', 'new-project'], confirmRefs: [ref(a.ownerId)] });
  const unknownRefs = [ref(a.ownerId, { recordId: 'not-observed' }), ref(a.ownerId, { projectId: 'new-project', recordId: 'not-observed' })];
  for (const unknown of unknownRefs) {
    const view = await library.query({ type: 'inspect', ref: unknown }); assert.equal(view.status, 'unverified'); assert.equal(view.entry, null); assert.deepEqual(view.owners[0].observed, observed); assert.equal(view.owners[0].generation, 2);
  }
  const retained = await library.query({ type: 'inspect', ref: ref(a.ownerId) }); assert.equal(retained.status, 'unverified'); assert.deepEqual(retained.entry.observed, observed);
  const reopened = await open();
  for (const unknown of unknownRefs) assert.equal((await reopened.query({ type: 'inspect', ref: unknown })).status, 'unverified');
  sources['/private/owner-a'].entries = [];
  await command('owner.refresh', { ownerId: a.ownerId });
  for (const unknown of unknownRefs) {
    const view = await reopened.query({ type: 'inspect', ref: unknown }); assert.equal(view.status, 'missing'); assert.equal(view.owners[0].observed.registrationGeneration, 2);
  }
});
