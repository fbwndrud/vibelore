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

// -- family-gated budget estimate -------------------------------------------
// ko (and no family) keeps the exact 52e5aee flat code-point / 2 estimate so
// the same memories are selected; multilingual uses script-aware tokenUnits().
const mixedKo = (n, seed) => {
  const u = `- (${seed}) 등대지기는 수리공이 도착하기 전에 널빤지를 세었다. "status": "active", "tags": ["harbor", "council"], see docs/notes.md. `;
  return u.repeat(Math.ceil(n / u.length)).slice(0, n);
};
const latin = (n, seed) => {
  const u = `(${seed}) The keeper counts planks before the repairman arrives; harbor council "status": "active". `;
  return u.repeat(Math.ceil(n / u.length)).slice(0, n);
};
const legacyTokens = (value) => Math.max(1, Math.ceil([...String(value ?? '')].length / 2));
const memoryInput = (text, extra = {}) => ({
  budget: { maxTokens: 3000, reservedTokens: 500 }, query: 'harbor council 등대지기',
  mandatory: [{ id: 'm', text: text(900, 99) }],
  candidates: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, text: text(700, i), priority: i })),
  ...extra,
});

for (const promptFamily of [undefined, 'ko']) {
  test(`ko memory selection is identical to 52e5aee (promptFamily=${String(promptFamily)})`, async () => {
    const { tokenUnits } = await import('../src/core/token-units.js');
    const result = compileMemory(context, memoryInput(mixedKo, promptFamily === undefined ? {} : { promptFamily }));
    assert.equal(result.ok, true);
    // golden values recorded at 52e5aee
    assert.deepEqual(result.value.lineage.selectedIds, ['c9', 'c8', 'c7', 'c6', 'c5']);
    assert.deepEqual(result.value.usage, { maxTokens: 3000, reservedTokens: 500, mandatoryTokens: 450, discretionaryTokens: 1750, remainingTokens: 300 });
    assert.equal(result.value.usage.mandatoryTokens, legacyTokens(mixedKo(900, 99)));
    assert.ok(tokenUnits(mixedKo(900, 99)) < legacyTokens(mixedKo(900, 99)), 'fixture must be mixed enough for tokenUnits() to diverge');
  });
}

test('an en work selects more optional memory under the same budget', () => {
  const old = compileMemory(context, memoryInput(latin));
  const now = compileMemory(context, memoryInput(latin, { promptFamily: 'multilingual' }));
  assert.equal(old.value.discretionary.length, 5);
  assert.equal(now.value.discretionary.length, 10);
  assert.ok(now.value.usage.mandatoryTokens < old.value.usage.mandatoryTokens);
});

test('an unknown prompt family is rejected, not silently treated as ko', () => {
  assert.throws(() => compileMemory(context, memoryInput(latin, { promptFamily: 'en' })));
});
