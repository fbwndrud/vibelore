import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureArcSummaries, renderLongMemory } from '../src/tools/arc-summary.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';
import { promptKit } from '../src/prompts/index.js';
import { buildLanguageContract } from '../engine/src/core/language-policy.js';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';

const kit = promptKit({ contract: buildLanguageContract({ language: 'ko' }) });
const episode = (chapter, index) => ({ chapter, index, title: `${chapter}화`, beat: `BEAT_${chapter}`, status: 'completed' });

function memoryStore() {
  const arcs = new Map();
  const summaries = new Map();
  const arcSummaries = new Map();
  return {
    arcs, summaries, arcSummaries,
    async loadArcArchive(_w, n) { return arcs.get(n) ?? null; },
    async loadChapterSummary(_w, n) { return summaries.has(n) ? { chapterNumber: n, summary: summaries.get(n) } : null; },
    async loadArcSummary(_w, n) { return arcSummaries.get(n) ?? null; },
    async saveArcSummary(_w, record) { arcSummaries.set(record.arcNumber, record); },
  };
}

test('a completed arc is summarized once, from its chapter summaries and the story so far', async () => {
  const store = memoryStore();
  store.arcs.set(1, { arcNumber: 1, title: '첫 아크', promise: 'ARC1_PROMISE', status: 'completed', episodes: [episode(1, 1), episode(2, 2)] });
  store.arcs.set(2, { arcNumber: 2, title: '둘째 아크', promise: 'ARC2_PROMISE', status: 'completed', episodes: [episode(3, 1)] });
  store.summaries.set(1, 'CH1_SUMMARY'); store.summaries.set(2, 'CH2_SUMMARY'); store.summaries.set(3, 'CH3_SUMMARY');
  store.arcSummaries.set(1, { arcNumber: 1, summary: 'ARC1_SUMMARY', storySoFar: 'SAGA_AFTER_1' });
  const requests = [];
  const providers = { pending: [], async complete(req) { requests.push(req); return { text: JSON.stringify({ arcSummary: 'ARC2_SUMMARY', storySoFar: 'SAGA_AFTER_2' }) }; } };
  await ensureArcSummaries({ store, workId: 'w', arcPlan: { arcNumber: 3, status: 'active', episodes: [] }, providers, kit });
  assert.equal(requests.length, 1);
  const user = requests[0].messages.find((m) => m.role === 'user').content;
  assert.match(user, /SAGA_AFTER_1/);
  assert.match(user, /ARC2_PROMISE/);
  assert.match(user, /3화[^\n]*CH3_SUMMARY/);
  assert.doesNotMatch(user, /CH1_SUMMARY/, 'earlier arcs arrive through the story so far');
  assert.equal(store.arcSummaries.get(2).storySoFar, 'SAGA_AFTER_2');
  await ensureArcSummaries({ store, workId: 'w', arcPlan: { arcNumber: 3, status: 'active', episodes: [] }, providers, kit });
  assert.equal(requests.length, 1, 'not asked again');
});

test('the long memory stays bounded however many arcs there are', async () => {
  const sizes = [];
  for (const arcs of [10, 100]) {
    const store = memoryStore();
    for (let n = 1; n <= arcs; n += 1) store.arcs.set(n, { arcNumber: n, status: 'completed', episodes: [] });
    for (let n = 1; n <= arcs; n += 1) store.arcSummaries.set(n, { arcNumber: n, title: `아크${n}`, summary: `아크 ${String(n).padStart(3, '0')} 요약 `.repeat(40), storySoFar: `지금까지 ${String(n).padStart(3, '0')} `.repeat(150) });
    const current = { arcNumber: arcs + 1, title: '현재', promise: 'NOW', status: 'active', episodes: [{ ...episode(1, 1) }, { chapter: 8, index: 2, title: '8화', beat: 'NEXT', status: 'planned' }] };
    const text = await renderLongMemory({ store, workId: 'w', arcPlan: current, chapter: 8, kit });
    assert.match(text, new RegExp(`지금까지 ${String(arcs).padStart(3, '0')} `));
    assert.match(text, new RegExp(`아크 ${String(arcs).padStart(3, '0')} 요약`));
    assert.doesNotMatch(text, new RegExp(`아크 ${String(arcs - 2).padStart(3, '0')} 요약`), 'only the last two arc summaries');
    assert.match(text, /BEAT_1/, 'the current arc so far');
    assert.doesNotMatch(text, /NEXT/, 'not beats still ahead');
    sizes.push(text.length);
  }
  assert.ok(sizes[1] <= sizes[0] * 1.05, sizes.join(' → '));
});

test('lore_write summarizes a finished arc before planning and hands the story so far to the plan', async () => {
  const store = await qualityStore();
  const active = await store.loadArcPlan(workId);
  await store.saveArcPlan(workId, { ...active, arcNumber: 1, status: 'completed', episodes: active.episodes.map((e) => ({ ...e, status: 'completed' })) });
  await store.saveArcPlan(workId, { ...active, arcNumber: 2, status: 'active' });
  const steps = [];
  const requests = [];
  await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: { async complete(req) {
    steps.push(req.step); requests.push(req);
    const contract = contractResponse(req); if (contract) return contract;
    if (req.step === 'arc-summary') return { text: JSON.stringify({ arcSummary: 'FIRST_ARC_DONE', storySoFar: 'STORY_SO_FAR_TOKEN' }) };
    return { text: outputs[req.step] ?? '{}' };
  } } });
  assert.ok(steps.includes('arc-summary'), steps.join(','));
  const draft = requests.find((req) => req.step === 'draft');
  assert.match(draft.messages.map((m) => m.content).join('\n'), /STORY_SO_FAR_TOKEN/);
});

test('review fixes: only completed arcs are summarized, a gap stops the chain, blank answers are not stored', async () => {
  const store = memoryStore();
  store.arcs.set(1, { arcNumber: 1, title: 'A', promise: 'P1', status: 'completed', episodes: [episode(1, 1)] });
  store.arcs.set(2, { arcNumber: 2, title: 'REJECTED', promise: 'P2', status: 'rejected', episodes: [] });
  store.arcs.set(3, { arcNumber: 3, title: 'C', promise: 'P3', status: 'completed', episodes: [episode(2, 1)] });
  const asked = [];
  let answer = { arcSummary: '   ', storySoFar: ' ' };
  const providers = { pending: [], async complete(req) { asked.push(req.messages[1].content); return { text: JSON.stringify(answer) }; } };
  const blank = await ensureArcSummaries({ store, workId: 'w', arcPlan: { arcNumber: 4, status: 'active', episodes: [] }, providers, kit });
  assert.equal(store.arcSummaries.size, 0, 'blank answer not stored');
  assert.equal(blank.failed, 1);
  answer = { arcSummary: 'S1', storySoFar: 'SO1' };
  await ensureArcSummaries({ store, workId: 'w', arcPlan: { arcNumber: 4, status: 'active', episodes: [] }, providers, kit });
  assert.ok(!asked.some((text) => /REJECTED/.test(text)), 'a rejected arc is not summarized');
  assert.ok(store.arcSummaries.has(3));

  const gap = memoryStore();
  gap.arcs.set(2, { arcNumber: 2, title: 'B', promise: 'P', status: 'completed', episodes: [episode(1, 1)] });
  const result = await ensureArcSummaries({ store: gap, workId: 'w', arcPlan: { arcNumber: 3, status: 'active', episodes: [] }, providers, kit });
  assert.equal(result.missing, 1);
  assert.equal(gap.arcSummaries.size, 0, 'no summary built on a missing earlier arc');
});

test('review fixes: the current arc so far uses stored chapter summaries, not plan beats', async () => {
  const store = memoryStore();
  store.summaries.set(1, 'ACTUAL_CH1');
  const text = await renderLongMemory({ store, workId: 'w', arcPlan: { arcNumber: 1, title: 'T', status: 'active', episodes: [episode(1, 1), { chapter: 8, index: 2, beat: 'B2', status: 'planned' }] }, chapter: 8, kit });
  assert.match(text, /ACTUAL_CH1/);
  assert.doesNotMatch(text, /BEAT_1/);
});

test('an unusable arc summary answer does not stop the chapter; the result says so', async () => {
  const store = await qualityStore();
  const active = await store.loadArcPlan(workId);
  await store.saveArcPlan(workId, { ...active, arcNumber: 1, status: 'completed', episodes: active.episodes.map((e) => ({ ...e, status: 'completed' })) });
  await store.saveArcPlan(workId, { ...active, arcNumber: 2, status: 'active' });
  const result = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: { async complete(req) {
    const contract = contractResponse(req); if (contract) return contract;
    if (req.step === 'arc-summary') return { text: '{"arcSummary":"","storySoFar":""}' };
    return { text: outputs[req.step] ?? '{}' };
  } } });
  assert.equal(result.status, 'awaiting_approval', JSON.stringify(result).slice(0, 300));
  assert.equal(result.quality.longMemory.failed, 1);
});
