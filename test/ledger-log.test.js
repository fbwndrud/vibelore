import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { rebuildLedgerLog, ledgerHistory, ledgerLogStatus } from '../src/tools/ledger-log.js';

const workId = 'ledger-work';
const newStore = async () => new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-ledger-')));
const base = (chapterNumber) => ({ chapterNumber, appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], mutableChanges: [] });

async function twoChapters(store) {
  await store.saveArtifact({ workId, chapterNumber: 1, prose: '가', delta: { ...base(1),
    hookChanges: [{ id: 'wrist', text: '손목', phase: 'planted' }], trackedEntityOps: [{ kind: 'Artifact', data: { name: '서명 쪽지', holder: 'c1' } }] } });
  await store.saveArtifact({ workId, chapterNumber: 2, prose: '나', delta: { ...base(2),
    ledgerOps: [{ op: 'event', id: 'o1', event: 'changed', set: { holder: 'c2' }, note: '넘김' }, { op: 'hook', id: 'wrist', event: 'advanced' }] } });
}

test('rebuilds the event log from committed chapter deltas, legacy and new', async () => {
  const store = await newStore();
  await twoChapters(store);
  const { events } = await rebuildLedgerLog({ store, workId });
  assert.deepEqual(events.map((e) => [e.chapter, e.target, e.id, e.event]), [
    [1, 'hook', 'wrist', 'planted'], [1, 'record', 'o1', 'registered'],
    [2, 'record', 'o1', 'changed'], [2, 'hook', 'wrist', 'advanced'],
  ]);
  assert.deepEqual(await store.loadLedgerEvents(workId), events);
  assert.deepEqual(ledgerHistory(events, 'o1').map((e) => e.event), ['registered', 'changed']);
});

test('rebuilding twice writes the same bytes, one compact JSON line per event', async () => {
  const store = await newStore();
  await twoChapters(store);
  const path = join(store.rootDir, '.vibelore', 'ledger', 'events.jsonl');
  await rebuildLedgerLog({ store, workId });
  const first = await readFile(path, 'utf8');
  await rebuildLedgerLog({ store, workId });
  assert.equal(await readFile(path, 'utf8'), first);
  assert.ok(first.endsWith('\n'));
  assert.equal(first.trim().split('\n').length, 4);
});

test('entity snapshots from before the first chapter seed the replay', async () => {
  const store = await newStore();
  await store.saveEntitySnapshots(workId, [{ entityId: 'seed-1', kind: '물건', canonicalName: '은 열쇠', aliases: [], status: 'active', attrs: {} }]);
  await store.saveArtifact({ workId, chapterNumber: 1, prose: '가', delta: { ...base(1), ledgerOps: [{ op: 'event', id: 'seed-1', event: 'changed', set: { holder: 'c1' } }] } });
  const { events } = await rebuildLedgerLog({ store, workId });
  assert.deepEqual(events.map((e) => [e.id, e.event]), [['seed-1', 'changed']]);
});

test('an empty work has an empty log file and a log ahead of the chapters is not ok', async () => {
  const store = await newStore();
  assert.deepEqual(await store.loadLedgerEvents(workId), []);
  assert.deepEqual(await ledgerLogStatus({ store, workId }), { ok: true, lastChapter: null, committed: null });
  await twoChapters(store);
  await rebuildLedgerLog({ store, workId });
  assert.deepEqual(await ledgerLogStatus({ store, workId }), { ok: true, lastChapter: 2, committed: 2 });
  await store.saveLedgerEvents(workId, [...await store.loadLedgerEvents(workId), { chapter: 3, target: 'hook', id: 'wrist', event: 'paid' }]);
  assert.equal((await ledgerLogStatus({ store, workId })).ok, false);
});

test('lore_sync rebuilds a missing or stale log', async () => {
  const { runSyncStatus } = await import('../src/tools/sync.js');
  const store = await newStore();
  await twoChapters(store);
  await runSyncStatus({ store, workId });
  assert.equal((await store.loadLedgerEvents(workId)).length, 4);
  await store.saveLedgerEvents(workId, [{ chapter: 9, target: 'hook', id: 'x', event: 'planted' }]);
  await runSyncStatus({ store, workId });
  assert.deepEqual((await ledgerLogStatus({ store, workId })).lastChapter, 2);
});
