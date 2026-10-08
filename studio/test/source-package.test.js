import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exportVibeloreSource } from '../src/source/vibelore-connector.js';
import { makeSourcePackage } from '../src/source/source-package.js';
import { withStudio } from './helpers/project.js';
import { webtoonStore, workId } from '../../test/fixtures/webtoon.js';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function inventory(root, prefix = '') {
  const result = {};
  for (const e of await readdir(join(root, prefix), { withFileTypes: true })) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(result, await inventory(root, p));
    else result[p] = hash(await readFile(join(root, p)));
  }
  return result;
}
it('captures actual novel UTF-8 bytes and readable hashes without writing source or exporting paths', async (t) => {
  const store = await webtoonStore();
  const raw = await readFile(store.chapterPath(1));
  const before = await inventory(store.rootDir);
  const exported = await exportVibeloreSource({
    store,
    workId,
    request: { kind: 'novel-chapters', chapters: [1] },
  });
  assert.deepEqual(await inventory(store.rootDir), before);
  const pkg = exported.package;
  assert.equal(pkg.schemaVersion, 1);
  assert.equal(pkg.preservationStatus.actualSourceBytes, 'complete');
  assert.equal(pkg.preservationStatus.legacySnapshotComplete, false);
  assert.equal(pkg.textUnits[0].text, '윤이 닫힌 문 앞에 멈췄다.');
  const chapter = pkg.blobManifest.find((b) => b.kind === 'chapter');
  assert.equal(chapter.blobId, hash(raw));
  assert.deepEqual(Buffer.from(exported.blobs.find((b) => b.blobId === chapter.blobId).bytes), raw);
  assert.equal(chapter.readableHash, hash(raw.toString('utf8')));
  assert.ok(!JSON.stringify(pkg).includes(store.rootDir));
  assert.ok(!Object.keys(pkg.blobManifest[0]).includes('path'));
  const { command, service } = await withStudio(t);
  await command('source.import', exported, { aggregate: { kind: 'sourcePackage', id: pkg.id } });
  assert.deepEqual(Buffer.from(await service.readBlob('p1', chapter.blobId)), raw);
  assert.equal((await service.snapshot('p1')).sourcePackages[0].id, pkg.id);
  await assert.rejects(
    command('source.import', exported, { aggregate: { kind: 'sourcePackage', id: pkg.id } }),
    { code: 'SOURCE_IMMUTABLE' }
  );
});
it('fails capture on a source race after exact bytes are copied', async () => {
  const store = await webtoonStore();
  const read = store.loadStoryProfile.bind(store);
  let calls = 0;
  store.loadStoryProfile = async (...args) => {
    if (++calls === 2) await writeFile(store.chapterPath(1), 'changed');
    return read(...args);
  };
  await assert.rejects(
    exportVibeloreSource({ store, workId, request: { kind: 'novel-chapters', chapters: [1] } }),
    { code: 'SOURCE_CAPTURE_CHANGED' }
  );
});
it('validates bytes through the public command and rejects path-bearing DTOs', async (t) => {
  const { command } = await withStudio(t);
  const source = makeSourcePackage({
    sourceKind: 'studio-script',
    sourceRevision: 'v1',
    textUnits: [],
    sceneScopes: [],
    sourceIdentityMap: [],
    revealPolicy: { unknown: ['secret'] },
    blobManifest: [],
    preservationStatus: { actualSourceBytes: 'complete' },
  });
  await assert.rejects(
    command(
      'source.import',
      { package: { ...source, path: '/private/source' }, blobs: [] },
      { aggregate: { kind: 'sourcePackage', id: source.id } }
    ),
    { code: 'INVALID_INPUT' }
  );
  const bytes = Buffer.from('hello');
  const pkg = makeSourcePackage({
    ...source,
    id: 'with-bytes',
    blobManifest: [{ blobId: hash(bytes), byteLength: 5, kind: 'text', id: 'text1' }],
  });
  await assert.rejects(
    command(
      'source.import',
      { package: pkg, blobs: [{ blobId: hash(bytes), bytes: [0] }] },
      { aggregate: { kind: 'sourcePackage', id: pkg.id } }
    ),
    { code: 'SOURCE_BLOB_MISMATCH' }
  );
});
it('keeps the original envelope replay digest and drains asynchronous preparation before close', async (t) => {
  const { service } = await withStudio(t);
  const bytes = Buffer.from('persist');
  const pkg = makeSourcePackage({
    sourceKind: 'studio-script',
    sourceRevision: 'v1',
    textUnits: [],
    sceneScopes: [],
    sourceIdentityMap: [],
    revealPolicy: {},
    blobManifest: [{ blobId: hash(bytes), byteLength: bytes.length, kind: 'text', id: 't' }],
    preservationStatus: { actualSourceBytes: 'complete' },
  });
  const envelope = {
    projectId: 'p1',
    commandId: 'import',
    aggregate: { kind: 'sourcePackage', id: pkg.id },
    expectedRevision: 0,
    type: 'source.import',
    payload: { package: pkg, blobs: [{ blobId: hash(bytes), bytes: [...bytes] }] },
  };
  const result = await service.command(envelope);
  assert.equal((await service.command(envelope)).replayed, true);
  const pkg2 = makeSourcePackage({ ...pkg, id: 'second-package', sourceRevision: 'v2' });
  const pending = service.command({
    ...envelope,
    commandId: 'import2',
    aggregate: { kind: 'sourcePackage', id: pkg2.id },
    payload: { package: pkg2, blobs: [{ blobId: hash(bytes), bytes: [...bytes] }] },
  });
  const close = service.close();
  await pending;
  await close;
  assert.equal(result.aggregateRevision, 1);
});
it('exports sealed scene scopes without leaking future/author documents after the original world disappears', async (t) => {
  const { sharedSaga, SAGA_PROJECTIONS } = await import('../../test/fixtures/shared-lore.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { MarkdownStateStore } = await import('../../src/store/markdown-store.js');
  const { inspectSceneScript, applySceneScript } = await import('../../src/core/scene-script.js');
  const w = await sharedSaga(),
    root = await mkdtemp(join(tmpdir(), 'studio-script-'));
  t.after(() =>
    Promise.all([rm(root, { recursive: true, force: true }), rm(w.root, { recursive: true, force: true })])
  );
  const store = new MarkdownStateStore(root),
    scriptWork = 'script-test';
  const script = {
    schemaVersion: 1,
    workId: scriptWork,
    scriptId: 'tower.part:1',
    title: '탑',
    language: 'ko',
    universeId: 'u1',
    loreRevisionId: w.head,
    registryRevisionId: w.registry.revisionId,
    continuityId: 'main',
    assetCatalogRevisionId: null,
    expressionProfileId: null,
    cast: [
      {
        localCharacterId: 'hero.part:1',
        entityId: 'character-a',
        projections: SAGA_PROJECTIONS,
        assetIds: [],
      },
    ],
    scenes: [
      {
        id: 's1.part:1',
        frame: 'present',
        scope: { continuityId: 'main', timelineId: 't1', pointId: 'adulthood' },
        entityIds: ['character-a'],
        requirements: [
          { entityId: 'character-a', fieldId: 'name', required: true },
          { entityId: 'character-a', fieldId: 'field-life-status', required: false },
        ],
        text: '윤재가 탑을 오른다.',
      },
    ],
  };
  const renamed = await w.world.propose({
    expectedHead: w.head,
    registryRevisionId: w.registry.revisionId,
    content: {
      ...w.content,
      states: w.content.states.map((state) =>
        state.id === 'state-adult' ? { ...state, id: 'state-adult.part:1' } : state
      ),
    },
    reason: 'external state ID fixture',
  });
  const adopted = await w.world.decide({
    expectedHead: w.head,
    proposalId: renamed.proposalId,
    action: 'approve',
  });
  script.loreRevisionId = adopted.head;
  const preview = await inspectSceneScript({ store, workId: scriptWork, worldRoot: w.root, script });
  await applySceneScript({ store, workId: scriptWork, proposalId: preview.proposalId, expectedHead: null });
  const before = await inventory(root);
  await rm(w.root, { recursive: true, force: true });
  const exported = await exportVibeloreSource({
    store,
    workId: scriptWork,
    request: { kind: 'scene-script', scriptId: 'tower.part:1' },
  });
  assert.deepEqual(await inventory(root), before);
  const allText =
    JSON.stringify(exported.package) +
    exported.blobs.map((b) => Buffer.from(b.bytes).toString('utf8')).join('');
  assert.match(allText, /ADULT_ONLY/);
  assert.doesNotMatch(allText, /FUTURE_SECRET_TOKEN|TS_ONLY|CHILD_ONLY/);
  const scope = exported.package.sceneScopes[0];
  assert.match(scope.id, /^[A-Za-z0-9_-]{1,120}$/);
  assert.equal(scope.sourceSceneId, 's1.part:1');
  assert.match(scope.stateIds['character-a'][0], /^[A-Za-z0-9_-]{1,120}$/);
  assert.equal(exported.package.states.sourceStateMap[0].sourceStateId, 'state-adult.part:1');
  assert.match(exported.package.sourceIdentityMap[0].id, /^[A-Za-z0-9_-]{1,120}$/);
  assert.equal(exported.package.sourceIdentityMap[0].sourceCharacterId, 'hero.part:1');
  assert.equal(exported.package.textUnits[0].sourceUnitId, 's1.part:1-p-1');
  assert.equal(scope.results.find((r) => r.fieldId === 'field-life-status').status, 'unknown');
  assert.ok(!allText.includes(root));
  assert.ok(!allText.includes(w.root));
  const { command } = await withStudio(t);
  await command('source.import', exported, { aggregate: { kind: 'sourcePackage', id: exported.package.id } });
  const sourceIdentity = exported.package.sourceIdentityMap[0];
  await command(
    'cast.put',
    {
      id: 'source-role',
      name: 'Source role',
      characterId: sourceIdentity.id,
      identity: {
        id: sourceIdentity.id,
        origin: { kind: 'source', packageId: exported.package.id, canonId: sourceIdentity.canonId },
      },
      language: 'ko',
    },
    { aggregate: { kind: 'cast', id: 'source-role' } }
  );
  await command(
    'casting.set',
    {
      id: 'source-casting',
      roleId: 'source-role',
      scope: 'project',
      state: scope.stateIds['character-a'][0],
      voice: 'source-voice',
    },
    { aggregate: { kind: 'casting', id: 'source-casting' } }
  );
  await command(
    'story.save',
    { id: 'main', title: 'Adaptation', text: 'Script', states: [], revealPolicy: {} },
    { aggregate: { kind: 'story', id: 'main' } }
  );
});
it('rechecks CAS after asynchronous preparation without holding a transaction', async (t) => {
  const { service } = await withStudio(t);
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  service.registerCommand('prepared.save', {
    target: () => ({ kind: 'prepared', id: 'one' }),
    async prepare() {
      started();
      await ready;
    },
    apply: ({ envelope }) => envelope.payload,
  });
  service.registerCommand('immediate.save', {
    target: () => ({ kind: 'prepared', id: 'one' }),
    apply: ({ envelope }) => envelope.payload,
  });
  const envelope = {
    projectId: 'p1',
    aggregate: { kind: 'prepared', id: 'one' },
    expectedRevision: 0,
    payload: { value: 'late' },
  };
  const pending = service.command({ ...envelope, commandId: 'prepared', type: 'prepared.save' });
  await began;
  await service.command({
    ...envelope,
    commandId: 'immediate',
    type: 'immediate.save',
    payload: { value: 'winner' },
  });
  release();
  await assert.rejects(pending, { code: 'REVISION_CONFLICT' });
  assert.equal(
    (await service.snapshot('p1')).aggregates.find((a) => a.kind === 'prepared').value.value,
    'winner'
  );
});
it('distinguishes actual byte checksum from readable UTF-8 checksum', async () => {
  const store = await webtoonStore();
  const path = store.chapterPath(1);
  const original = await readFile(path);
  const bytes = Buffer.concat([
    Buffer.from(original.toString('utf8').replaceAll('\n', '\r\n')),
    Buffer.from([255]),
  ]);
  await writeFile(path, bytes);
  const exported = await exportVibeloreSource({
    store,
    workId,
    request: { kind: 'novel-chapters', chapters: [1] },
  });
  const chapter = exported.package.blobManifest.find((b) => b.kind === 'chapter');
  assert.equal(chapter.blobId, hash(bytes));
  assert.equal(chapter.readableHash, hash(bytes.toString('utf8')));
  assert.notEqual(chapter.blobId, chapter.readableHash);
  assert.deepEqual(Buffer.from(exported.blobs.find((b) => b.blobId === chapter.blobId).bytes), bytes);
});
it('reads source changes inside the same transaction as the project snapshot', async (t) => {
  const { service } = await withStudio(t),
    all = service.store.all.bind(service.store);
  let inTransaction = null;
  service.store.all = (sql, ...args) => {
    if (sql.includes('FROM source_changes')) {
      inTransaction = service.store.db.isTransaction;
    }
    return all(sql, ...args);
  };
  await service.snapshot('p1');
  assert.equal(inTransaction, true);
});
it('passes prepared descriptors into the transaction while keeping the hashed envelope immutable', async (t) => {
  const { service } = await withStudio(t);
  service.registerCommand('prepare.descriptor', {
    target: () => ({ kind: 'prepared', id: 'descriptor' }),
    async prepare({ envelope }) {
      assert.throws(() => {
        envelope.payload.value = 'changed';
      }, TypeError);
      return { stored: 'bytes-prepared' };
    },
    apply: ({ envelope, prepared }) => ({ value: envelope.payload.value, stored: prepared.stored }),
  });
  const result = await service.command({
    projectId: 'p1',
    commandId: 'descriptor',
    aggregate: { kind: 'prepared', id: 'descriptor' },
    expectedRevision: 0,
    type: 'prepare.descriptor',
    payload: { value: 'original' },
  });
  assert.deepEqual(result.value, { value: 'original', stored: 'bytes-prepared' });
});
