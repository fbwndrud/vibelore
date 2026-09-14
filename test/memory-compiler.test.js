import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMemory } from '../src/core/memory-compiler.js';

const context = {
  snapshotId: 'rev-7', expectedHead: 'rev-7', storyTimeScope: { worldline: 'main', through: 42 },
  publicationOrder: 42, transactionTime: '2026-08-26T00:00:00.000Z', policyRevision: 1,
  semanticGeneration: 3, fencingToken: 9,
};

test('mandatory recall is lossless and ranked memory records reproducible lineage', () => {
  const result = compileMemory(context, {
    scope: { chapter: 43, entityIds: ['mara'] }, budget: { maxTokens: 180, reservedTokens: 20 },
    mandatory: [
      { id: 'promise:key', kind: 'promise', text: '마라는 열쇠를 돌려주겠다고 맹세했다.', active: true },
      { id: 'knowledge:door', kind: 'knowledge', text: '마라만 비밀문 위치를 안다.', active: true },
    ],
    candidates: [
      { id: 's1', kind: 'summary', chapter: 2, text: '카렐이 열쇠를 훔치려 했다.' },
      { id: 's2', kind: 'summary', chapter: 8, text: '벤은 날씨 이야기를 했다.' },
    ],
    query: '마라 열쇠 비밀문', indexGeneration: 'idx-3', tokenizerRevision: 'ko-basic-1', rankerRevision: 'bm25-1',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.mandatory.map((x) => x.id), ['promise:key', 'knowledge:door']);
  assert.equal(result.value.discretionary[0].id, 's1');
  assert.equal(result.value.lineage.snapshotId, 'rev-7');
  assert.equal(result.value.lineage.indexGeneration, 'idx-3');
  assert.ok(result.value.lineage.boundaryWitness);
});

test('mandatory overflow fails closed instead of trimming canon', () => {
  const result = compileMemory(context, {
    scope: { chapter: 43 }, budget: { maxTokens: 8, reservedTokens: 4 },
    mandatory: [{ id: 'long', kind: 'promise', text: '절대로 잘리면 안 되는 매우 긴 정사 의무 문장이다.', active: true }],
    candidates: [], query: '', indexGeneration: 'idx-1', tokenizerRevision: 'ko-basic-1', rankerRevision: 'bm25-1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'context_overflow');
  assert.equal(result.error.recovery, 'split_scene_or_replan');
});

test('stale or incomplete execution context is rejected', () => {
  const result = compileMemory({ ...context, snapshotId: 'a', expectedHead: 'b' }, { budget: { maxTokens: 10 }, mandatory: [], candidates: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'stale_snapshot');
});
