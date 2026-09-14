import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runInit } from '../src/tools/init.js';
import { runCommit } from '../src/tools/commit.js';
import { retrieveMemory } from '../src/tools/memory-index.js';
import { buildContext } from '../src/tools/context.js';
import { chooseBestRevision, makeRevisionCandidate } from '../src/tools/revision-selection.js';
import { listSnapshots, rollbackToSnapshot } from '../src/tools/snapshots.js';
import { createHostRelay } from '../src/provider/host-relay.js';

const emptyDelta = (chapterNumber) => ({ chapterNumber, appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], hookChanges: [], mutableChanges: [], trackedEntityOps: [] });

async function storeWithWork() {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-resilience-')));
  await runInit({ store, workId: 'memory-work', genre: 'other', povMode: '3인칭제한', targetChapters: 20, worldFacts: ['해원은 강등권 프로 축구팀이다.'] });
  return store;
}

describe('resilience modules', () => {
  it('rebuilds searchable memory from canonical summaries and records context selection trace', async () => {
    const store = await storeWithWork();
    await store.saveChapterSummary({ workId: 'memory-work', chapterNumber: 1, summary: '윤태호는 왼발목 통증을 숨기고 훈련을 계속했다.' });
    const memory = await retrieveMemory({ store, workId: 'memory-work', query: '윤태호 왼발목 통증', currentChapter: 10 });
    assert.equal(memory.selected[0].scope, 'summary');
    const built = await buildContext({ store, workId: 'memory-work', chapter: 10 });
    const trace = await store.loadContextTrace('memory-work', 10);
    assert.equal(trace.chapter, 10);
    assert.equal(trace.contextChars, built.context.length);
    assert.ok(Array.isArray(trace.retrieval.candidates));
  });

  it('prefers a clean earlier revision over a higher-scoring candidate with a new hard violation', () => {
    const base = { castManifestRaw: '{}', check: { counts: { hard: 0 }, prosody: { score: 80 } }, coherence: { score: 80 }, editorial: { score: 80 }, readerHook: { score: 80 }, lengthFailed: false, mustRevise: true, experienceFailed: false };
    const clean = makeRevisionCandidate({ ...base, attempt: 1, prose: '안전한 원고' });
    const broken = makeRevisionCandidate({ ...base, attempt: 2, prose: '점수만 높은 원고', check: { counts: { hard: 1 }, prosody: { score: 99 } }, coherence: { score: 99 }, editorial: { score: 99 }, readerHook: { score: 99 } });
    assert.equal(chooseBestRevision([clean, broken]).attempt, 1);
  });

  it('snapshots every commit and rolls back later chapters into a recoverable archive', async () => {
    const store = await storeWithWork();
    const providers = createHostRelay({});
    await runCommit({ store, workId: 'memory-work', chapter: 1, prose: '첫 장면이 끝났다.', summary: '첫 장면.', delta: emptyDelta(1), providers });
    await runCommit({ store, workId: 'memory-work', chapter: 2, prose: '두 번째 장면이 끝났다.', summary: '두 번째 장면.', delta: emptyDelta(2), providers });
    assert.deepEqual(await listSnapshots({ store }), [1, 2]);
    const result = await rollbackToSnapshot({ store, workId: 'memory-work', chapter: 1 });
    assert.equal(result.recoverable, true);
    assert.deepEqual(await store.listChapters(), [1]);
  });
});
