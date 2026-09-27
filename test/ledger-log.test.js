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
  const built = JSON.parse(await readFile(join(store.rootDir, '.vibelore', 'ledger', 'built.json'), 'utf8'));
  assert.deepEqual({ ...built, digest: typeof built.digest }, { throughChapter: 2, chapters: 2, eventCount: 4, digest: 'string' });
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

// ── replay = the live ledger (final fix wave: I1, I2, DEV1, DEV3, DEV8) ──
import { reduceStoryState } from '../engine/src/continuity/story-state.js';
import { ledgerEntitySnapshots } from '../engine/src/continuity/ledger.js';
import { ledgerBaseState, replayLedgerState, updateLedgerLog } from '../src/tools/ledger-log.js';
import { loadLedgerConfig, saveWriterSupportPolicy } from '../src/core/review-policy.js';

/** What lore_commit does for the ledger: build on the base state, reduce, save the state and the derived snapshots, then the log. */
async function commitLike(store, delta) {
  const chapter = delta.chapterNumber;
  const config = await loadLedgerConfig(store, workId);
  const prev = await ledgerBaseState({ store, workId, chapter: chapter - 1 });
  const next = reduceStoryState(prev, delta, { config });
  await store.saveArtifact({ workId, chapterNumber: chapter, prose: 'x', delta });
  await store.saveStoryState(next);
  await store.saveEntitySnapshots(workId, ledgerEntitySnapshots(next.ledger));
  return { next, log: await updateLedgerLog({ store, workId, chapter, prevState: prev, delta, config }) };
}

const seedSword = [{ entityId: 'sword', kind: '물건', canonicalName: '검', aliases: [], status: 'active', attrs: {} }];

test('replay seeds from the entities as they were before chapter 1, not the derived snapshot', async () => {
  const store = await newStore();
  await store.saveEntitySnapshots(workId, seedSword);
  await store.saveLedgerSeed(workId, { entities: seedSword });
  await commitLike(store, { ...base(1), ledgerOps: [{ op: 'event', id: 'sword', event: 'changed', set: { holder: 'c1' }, note: '쥠' }] });
  await commitLike(store, { ...base(2), ledgerOps: [{ op: 'event', id: 'sword', event: 'status', status: 'destroyed', note: '부러짐' }] });
  const { events } = await rebuildLedgerLog({ store, workId });
  assert.deepEqual(events.map((e) => [e.chapter, e.id, e.event]), [[1, 'sword', 'changed'], [2, 'sword', 'status']]);
  const replay = await replayLedgerState({ store, workId });
  assert.deepEqual(replay.violations, []);
});

test('a work without a seed file keeps the first seed it finds, reset to its starting status', async () => {
  const store = await newStore();
  await store.saveEntitySnapshots(workId, [{ ...seedSword[0], status: 'destroyed', registeredAtChapter: 0, updatedAtChapter: 1 }, { entityId: 'o5', kind: '물건', canonicalName: '방패', aliases: [], status: 'active', attrs: {}, registeredAtChapter: 1 }]);
  await store.saveArtifact({ workId, chapterNumber: 1, prose: '가', delta: { ...base(1), ledgerOps: [{ op: 'event', id: 'sword', event: 'status', status: 'destroyed', note: '부러짐' }] } });
  const replay = await replayLedgerState({ store, workId });
  assert.deepEqual(replay.state.ledger.records.map((r) => [r.id, r.status]), [['sword', 'destroyed']]);
  assert.deepEqual(replay.violations, []);
  assert.deepEqual((await store.loadLedgerSeed(workId)).entities.map((e) => [e.entityId, e.status]), [['sword', 'active']]);
  await store.saveEntitySnapshots(workId, []);
  assert.deepEqual((await replayLedgerState({ store, workId })).state.ledger.records.map((r) => r.id), ['sword'], 'the stored seed wins');
});

test('a later custom item and a feature turned off do not rewrite the history of earlier chapters', async () => {
  const store = await newStore();
  await commitLike(store, { ...base(1), ledgerOps: [{ op: 'register', feature: 'objects', label: '물건', name: '금화 잔액', fields: { amount: '10' } }, { op: 'plant', text: '손목' }] });
  await commitLike(store, { ...base(2), ledgerOps: [{ op: 'event', id: 'o1', event: 'changed', set: { amount: '8' } }] });
  await saveWriterSupportPolicy(store, workId, { customTracking: [{ name: '금화 잔액', feature: 'objects', pinned: true }], tracking: { hooks: false } });
  const { events } = await rebuildLedgerLog({ store, workId, config: await loadLedgerConfig(store, workId) });
  assert.deepEqual(events.map((e) => [e.chapter, e.id, e.event]), [[1, 'o1', 'registered'], [1, 'h1', 'planted'], [2, 'o1', 'changed']]);
  assert.equal(ledgerHistory(events, 'o1').length, 2);
});

test('the live ledger equals the replay after seeds, destroy and restore, a merge, a switch and a custom item', async () => {
  const store = await newStore();
  await store.saveEntitySnapshots(workId, seedSword);
  await store.saveLedgerSeed(workId, { entities: seedSword });
  await commitLike(store, { ...base(1), ledgerOps: [
    { op: 'event', id: 'sword', event: 'status', status: 'destroyed', note: '부러짐' },
    { op: 'register', feature: 'objects', label: '물건', name: '은 반지', fields: { holder: 'c1' } },
    { op: 'register', feature: 'objects', label: '물건', name: '은반지', fields: { holder: 'c1' } },
    { op: 'plant', text: '누가 검을 부러뜨렸나' }] });
  await commitLike(store, { ...base(2), ledgerOps: [{ op: 'event', id: 'sword', event: 'restored', note: '대장장이가 벼림' }, { op: 'event', id: 'o2', event: 'changed', set: { holder: 'c2' } }] });
  await saveWriterSupportPolicy(store, workId, { mergeRecords: [{ from: 'o2', into: 'o1' }], tracking: { hooks: false }, customTracking: [{ name: '은 반지', feature: 'objects', rules: [{ type: 'frozenAfter', status: 'lost' }] }] });
  await commitLike(store, { ...base(3), ledgerOps: [{ op: 'event', id: 'o2', event: 'changed', set: { holder: 'c3' } }, { op: 'event', id: 'u1', event: 'status', status: 'lost' }] });
  const live = await store.loadStoryState(workId, 3);
  const replay = await replayLedgerState({ store, workId, config: await loadLedgerConfig(store, workId) });
  assert.deepEqual(replay.state.ledger, live.ledger);
  assert.deepEqual(replay.state.hooks, live.hooks);
  assert.deepEqual(live.ledger.records.map((r) => [r.id, r.status, r.fields.holder ?? null]), [['sword', 'active', null], ['o1', 'lost', 'c3']]);
  const events = await store.loadLedgerEvents(workId);
  for (const item of [...live.ledger.records, ...live.hooks]) assert.ok(ledgerHistory(events, item.id).length > 0, item.id);
  assert.deepEqual(events, (await rebuildLedgerLog({ store, workId, config: await loadLedgerConfig(store, workId) })).events);
});

test('the log is ok only when it exists, has as many lines as it was built with and matches the deltas and config', async () => {
  const store = await newStore();
  await twoChapters(store);
  await rebuildLedgerLog({ store, workId });
  assert.equal((await ledgerLogStatus({ store, workId })).ok, true);
  const path = join(store.rootDir, '.vibelore', 'ledger', 'events.jsonl');
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.split('\n').slice(1).join('\n'));
  assert.equal((await ledgerLogStatus({ store, workId })).ok, false, 'a line lost');
  const { rm } = await import('node:fs/promises');
  await rm(path);
  assert.equal((await ledgerLogStatus({ store, workId })).ok, false, 'the file lost');
  await rebuildLedgerLog({ store, workId });
  await store.saveArtifact({ workId, chapterNumber: 2, prose: '나', delta: { ...base(2), ledgerOps: [] } });
  assert.equal((await ledgerLogStatus({ store, workId })).ok, false, 'a chapter recommitted');
  await rebuildLedgerLog({ store, workId });
  await saveWriterSupportPolicy(store, workId, { tracking: { hooks: false } });
  assert.equal((await ledgerLogStatus({ store, workId })).ok, false, 'the config changed');
});

test('a commit appends its chapter to a current log and rebuilds a stale one', async () => {
  const store = await newStore();
  assert.equal((await commitLike(store, { ...base(1), ledgerOps: [{ op: 'plant', text: '손목' }] })).log.mode, 'rebuild');
  assert.equal((await commitLike(store, { ...base(2), ledgerOps: [{ op: 'hook', id: 'h1', event: 'advanced' }] })).log.mode, 'append');
  await saveWriterSupportPolicy(store, workId, { mergeRecords: [{ from: 'o9', into: 'o1' }] });
  assert.equal((await commitLike(store, { ...base(3), ledgerOps: [{ op: 'hook', id: 'h1', event: 'mentioned' }] })).log.mode, 'rebuild');
  const appended = await store.loadLedgerEvents(workId);
  assert.deepEqual(appended, (await rebuildLedgerLog({ store, workId, config: await loadLedgerConfig(store, workId) })).events);
  assert.equal((await ledgerLogStatus({ store, workId })).ok, true);
});
