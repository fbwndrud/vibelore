import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { rebuildLedgerLog } from '../src/tools/ledger-log.js';
import { rebuildMemoryIndex, retrieveMemory } from '../src/tools/memory-index.js';
import { saveWriterSupportPolicy } from '../src/core/review-policy.js';
import { emptyStoryState, reduceStoryState } from '../engine/src/continuity/story-state.js';

const workId = 'memory-work';
const delta = (chapterNumber, ledgerOps) => ({ chapterNumber, appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], mutableChanges: [], ledgerOps });

async function workWithLedger() {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-memory-')));
  const chapter = delta(1, [
    { op: 'register', feature: 'objects', label: '문서', name: '서명 쪽지', aliases: ['쪽지'], fields: { holder: '민서' } },
    { op: 'event', id: 'o1', event: 'mentioned', note: '새벽 재서명' },
  ]);
  await store.saveArtifact({ workId, chapterNumber: 1, prose: '가', delta: chapter });
  await store.saveStoryState(reduceStoryState(emptyStoryState(workId), chapter));
  await rebuildLedgerLog({ store, workId });
  return store;
}

test('ledger records and event notes are searchable memory; entity snapshots are not read as their own scope', async () => {
  const store = await workWithLedger();
  const memory = await retrieveMemory({ store, workId, query: '재서명', currentChapter: 2 });
  const event = memory.selected.find((item) => item.scope === 'event');
  assert.equal(event?.ref, 'o1');
  assert.equal(event.chapter, 1);
  const record = (await retrieveMemory({ store, workId, query: '쪽지 민서', currentChapter: 2 })).selected.find((item) => item.scope === 'record');
  assert.equal(record?.ref, 'o1');
  assert.match(record.text, /서명 쪽지/);
  assert.match(record.text, /문서/);
});

test('an entity seeded before the first chapter is indexed as a record', async () => {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-memory-')));
  await store.saveEntitySnapshots(workId, [{ entityId: 'seed-1', kind: '물건', canonicalName: '은 열쇠', aliases: [], status: 'active', attrs: {}, registeredAtChapter: 0 }]);
  await rebuildMemoryIndex({ store, workId });
  const memory = await retrieveMemory({ store, workId, query: '은 열쇠', currentChapter: 1 });
  assert.deepEqual(memory.selected.map((item) => [item.scope, item.ref]), [['record', 'seed-1']]);
});

test('records and notes of a feature the author turned off are not indexed', async () => {
  const store = await workWithLedger();
  await saveWriterSupportPolicy(store, workId, { tracking: { objects: false } });
  const memory = await retrieveMemory({ store, workId, query: '재서명 쪽지', currentChapter: 2 });
  assert.deepEqual(memory.candidates.filter((item) => item.scope === 'record' || item.scope === 'event'), []);
});
