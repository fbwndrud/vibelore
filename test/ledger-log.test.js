import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
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

test('status is ok only when the log was built through the last committed chapter', async () => {
  const store = await newStore();
  assert.deepEqual(await store.loadLedgerEvents(workId), []);
  assert.deepEqual(await ledgerLogStatus({ store, workId }), { ok: true, lastChapter: null, committed: null });
  await twoChapters(store);
  assert.equal((await ledgerLogStatus({ store, workId })).ok, false, 'never built');
  await rebuildLedgerLog({ store, workId });
  assert.deepEqual(JSON.parse(await readFile(join(store.rootDir, '.vibelore', 'ledger', 'built.json'), 'utf8')), { throughChapter: 2, chapters: 2 });
  assert.deepEqual(await ledgerLogStatus({ store, workId }), { ok: true, lastChapter: 2, committed: 2 });
  // A commit whose rebuild failed leaves the log behind the chapters.
  await store.saveArtifact({ workId, chapterNumber: 3, prose: '다', delta: { ...base(3), ledgerOps: [{ op: 'hook', id: 'wrist', event: 'paid' }] } });
  assert.equal((await ledgerLogStatus({ store, workId })).ok, false);
});

test('a malformed log line is skipped and makes the status not ok, without throwing', async () => {
  const store = await newStore();
  await twoChapters(store);
  await rebuildLedgerLog({ store, workId });
  const path = join(store.rootDir, '.vibelore', 'ledger', 'events.jsonl');
  await writeFile(path, `${await readFile(path, 'utf8')}{broken\n`);
  assert.equal((await store.loadLedgerEvents(workId)).length, 4);
  assert.equal((await store.loadLedgerLog(workId)).malformed, 1);
  assert.equal((await ledgerLogStatus({ store, workId })).ok, false);
});

test('lore_sync repairs a log that is behind, and only in paths that already write', async () => {
  const { runSyncStatus } = await import('../src/tools/sync.js');
  const store = await newStore();
  await twoChapters(store);
  await runSyncStatus({ store, workId, action: 'inspect' });
  assert.equal((await ledgerLogStatus({ store, workId })).ok, false, 'inspect is read-only');
  await runSyncStatus({ store, workId, action: 'validate' });
  assert.equal((await store.loadLedgerEvents(workId)).length, 4);
  assert.equal((await ledgerLogStatus({ store, workId })).ok, true);
});

test('repeated sync does not rewrite the log of a work whose chapters produced no events', async () => {
  const { runSyncStatus } = await import('../src/tools/sync.js');
  const store = await newStore();
  await store.saveArtifact({ workId, chapterNumber: 1, prose: '가', delta: base(1) });
  await runSyncStatus({ store, workId, action: 'validate' });
  const path = join(store.rootDir, '.vibelore', 'ledger', 'built.json');
  const before = (await stat(path)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await runSyncStatus({ store, workId, action: 'validate' });
  await runSyncStatus({ store, workId, action: 'validate' });
  assert.equal((await stat(path)).mtimeMs, before);
});
