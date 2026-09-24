import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { segmentBatches, validateSegmentReview, reviewSegmented } from '../src/core/webtoon-segments.js';
import { runLegacyWebtoonTool as runWebtoonTool } from './fixtures/legacy-webtoon.js';
import { WebtoonStore } from '../src/store/webtoon-store.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';
import { answers, webtoonStore, workId, provider, plan, pixel } from './fixtures/webtoon.js';

const review = d => ({ subjectHash: d.subjectHash, inspectedImages: true, evidence: 'Synthetic review fixture, not actual visual QA', findings: [],
  observations: d.shots?.map(s => ({ shotId: s.id, verdict: 'clear', evidence: 'Fixture action reason' })),
  transitions: d.transitions?.map(t => ({ ...t, verdict: 'clear', evidence: 'Fixture state connection' })) });

test('bounded semantic batches retain scene boundaries and adjacent context', () => {
  const p = { sequences: [{ id: 'a', shots: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}` })) }, { id: 'b', shots: [{ id: 'b0' }] }] };
  const b = segmentBatches(p);
  assert.deepEqual(b.map(b => b.shots.length), [6, 2, 1]);
  assert.deepEqual(b[1].context.map(s => s.id), ['a5', 'a6', 'a7', 'b0']);
  assert.ok(b[1].transitions.some(t => t.from === 'a7' && t.to === 'b0'));
});

test('lettering presentation preserves actual local context, images and source in segment reviews', async () => {
  const shots = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, sourceIds: [`u${i}`] }));
  const lettering = { dialogue: 'round', thought: 'plain', caption: 'plain', sfx: 'contextual' };
  const w = { decisions: {}, contract: { digest: 'contract' }, source: { hash: 'source', chapters: [], units: shots.map(s => ({ id: s.sourceIds[0] })) },
    plan: { presentation: { lettering }, sequences: [{ id: 'a', shots: shots.slice(0, 6) }, { id: 'b', shots: shots.slice(6) }] },
    images: Object.fromEntries(shots.map(s => [s.id, { reviewPath: `${s.id}.png`, hash: s.id }])),
    render: { shotIds: shots.map(s => s.id), files: {}, artComplete: true } };
  const packets = [];
  const result = await reviewSegmented(w, 'render', 'subject', async (_, __, packet) => { packets.push(packet); return review(packet); });
  assert.equal(result.failed, false);
  const second = packets.find(p => p.batchId === 'b-0');
  assert.deepEqual(second.context.map(s => s.id), shots.slice(5).map(s => s.id));
  assert.deepEqual(second.images.map(s => s.path), shots.slice(5).map(s => `${s.id}.png`));
  assert.deepEqual(second.source.units.map(s => s.id), shots.slice(5).map(s => s.sourceIds[0]));
  assert.deepEqual(second.transitions[0], { from: 's5', to: 's6' });
  assert.deepEqual(second.shots[0].letteringStyle, lettering);
  assert.equal(shots[6].letteringStyle, undefined);
});

test('coverage IDs alone, missing edge, stale evidence and unseen visuals do not pass', () => {
  const packet = { subjectHash: 'hash', visual: true, shots: [{ id: 'a' }], transitions: [{ from: 'a', to: 'b' }] };
  const valid = review(packet);
  assert.equal(validateSegmentReview(valid, packet), true);
  for (const bad of [{ ...valid, observations: [] }, { ...valid, transitions: [] }, { ...valid, subjectHash: 'old' },
    { ...valid, inspectedImages: false }, { ...valid, observations: [{ shotId: 'a', verdict: 'clear', evidence: '' }] }]) assert.equal(validateSegmentReview(bad, packet), false);
});

function segmentedProvider({ omitTextPolicy = false } = {}) {
  let full;
  return provider({ response: (r, d) => {
    if (r.step === 'webtoon-plan-outline') {
      full = plan(d.source);
      const { textPolicyVersion, ...header } = full;
      return { ...(omitTextPolicy ? header : full), sequences: full.sequences[0].shots.map((s, i) => ({ id: `seq${i}`, purpose: 'fixture scene',
        sourceIds: s.sourceIds, entryState: 'before', exitState: 'after' })) };
    }
    if (r.step === 'webtoon-plan-part') {
      const s = full.sequences[0].shots.find(s => s.sourceIds.some(id => d.sequence.sourceIds.includes(id)));
      return { sequenceId: d.sequence.id, shots: [{ ...s, id: `${d.sequence.id}-shot` }] };
    }
    if (r.step.endsWith('-review')) return d.batchId || d.episodeMap ? review(d) : undefined;
  } });
}

test('real workflow splits drafting and reviews while preserving existing approval and rendering tools', async () => {
  const store = await webtoonStore(), p = segmentedProvider();
  const call = (name, args = {}) => runWebtoonTool({ store, toolName: `lore_webtoon_${name}`, args: { workId, ...args }, providers: p });
  const approve = r => call('decide', { workflowId: r.workflowId, approvalId: r.approvalId, action: 'approve' });
  const before = await readFile(store.chapterPath(1));
  let r = await call('plan', { segmented: true, imageModel: 'gpt-image-2', responses: answers });
  r = await approve(r);
  assert.equal(r.approval.kind, 'plan'); assert.equal(r.quality.status, 'completed');
  assert.equal(p.requests.filter(r => r.step === 'webtoon-plan-outline').length, 1);
  const parts = p.requests.filter(r => r.step === 'webtoon-plan-part').map(r => JSON.parse(r.messages.at(-1).content));
  assert.equal(parts.length, 2); assert.equal(parts[0].source.units.length, 1); assert.equal(parts[1].previous.length, 1);
  assert.deepEqual(parts[0].common, parts[1].common);
  assert.equal(p.requests.filter(r => r.step === 'webtoon-plan-review').length, 3);
  await approve(r); r = await call('render');
  const path = join(store.rootDir, 'pixel.png'); await writeFile(path, pixel);
  r = await call('render', { references: r.jobs.map(j => ({ referenceId: j.referenceId, inputHash: j.inputHash, path })) });
  await approve(r); r = await call('render');
  r = await call('render', { assets: r.jobs.map(j => ({ shotId: j.shotId, inputHash: j.inputHash, path })) });
  assert.equal(r.approval.kind, 'look'); assert.equal(r.lettering.technicalStatus, 'passed');
  const visual = p.requests.filter(r => r.step === 'webtoon-render-review').map(r => JSON.parse(r.messages.at(-1).content)).filter(d => d.batchId);
  assert.equal(visual.length, 2);
  assert.ok(visual.every(d => d.images.every(i => i.path && i.hash)));
  assert.ok(visual.every(d => !d.contract && !d.artifacts));
  assert.deepEqual(await readFile(store.chapterPath(1)), before);
  assert.equal((await new WebtoonStore(store).load()).segmentDraft.outline.sequences.length, 2);
});

test('segmented plan keeps the workflow text policy when the outline omits it', async () => {
  const store = await webtoonStore(), p = segmentedProvider({ omitTextPolicy: true });
  const call = (name, args = {}) => runWebtoonTool({ store, toolName: `lore_webtoon_${name}`, args: { workId, ...args }, providers: p });
  let r = await call('plan', { segmented: true, imageModel: 'gpt-image-2', responses: answers });
  r = await call('decide', { workflowId: r.workflowId, approvalId: r.approvalId, action: 'approve' });
  assert.equal(r.approval.kind, 'plan');
  const saved = await new WebtoonStore(store).load();
  assert.equal(saved.plan.textPolicyVersion, saved.textPolicyVersion);
  const part = JSON.parse(p.requests.find(r => r.step === 'webtoon-plan-part').messages.at(-1).content);
  assert.equal(part.maxShotsThisPart, Math.min(6, part.remainingShots - 1));
  assert.ok(part.layout.height && part.layout.gapAfter);
});

test('actual host relay persists part progress across request IDs and rejects stale runs', async () => {
  const store = await webtoonStore(), fixture = segmentedProvider();
  const call = (tool, args, providers, run = null) => runWebtoonTool({ store, toolName: `lore_webtoon_${tool}`, args: { workId, ...args }, providers, run });
  let r = await call('plan', { segmented: true, imageModel: 'gpt-image-2', responses: answers }, fixture);
  r = await call('decide', { workflowId: r.workflowId, approvalId: r.approvalId, action: 'approve' }, createHostRelay());
  const seen = [], runs = [];
  for (let i = 0; r.status === 'needs_model' && i < 15; i++) {
    const q = r.requests[0], run = await loadRun(store.rootDir, r.runId); runs.push(run); seen.push(q.step);
    const answer = await fixture.complete({ step: q.step, messages: [{ role: 'system', content: q.system }, { role: 'user', content: q.user }] });
    r = await call('plan', run.args, createHostRelay({ [q.id]: answer.text }), run);
  }
  assert.equal(r.approval.kind, 'plan');
  assert.deepEqual(seen, ['webtoon-editorial', 'webtoon-plan-outline', 'webtoon-plan-part', 'webtoon-plan-part', 'webtoon-plan-review', 'webtoon-plan-review', 'webtoon-plan-review']);
  await assert.rejects(call('plan', runs[0].args, createHostRelay(), runs[0]), /STALE_WEBTOON_RUN/);
  await assert.rejects(call('plan', { workflowId: r.workflowId, segmented: false }, fixture), /SEGMENTED_POLICY_REQUIRES_NEW_WORKFLOW/);
});

test('review resumes after a pending chunk, caches unchanged chunks, and cannot launder a failed chunk', async () => {
  const shots = ['a', 'b', 'c'].map(id => ({ id, sourceIds: [id], knowledgeBefore: [], knowledgeAfter: [] }));
  const w = { decisions: {}, contract: { digest: 'contract' }, source: { hash: 'source', units: [], chapters: [] },
    plan: { sequences: shots.map(s => ({ id: s.id, purpose: s.id, shots: [s] })) } };
  const calls = []; let pending = true;
  const call = async (_, __, d) => { calls.push(d.batchId ?? 'whole');
    if (d.batchId === 'b-0' && pending) return { pending: true, result: { status: 'needs_model' } };
    return review(d); };
  assert.equal((await reviewSegmented(w, 'plan', 'plan', call)).pending, true);
  pending = false; const done = await reviewSegmented(w, 'plan', 'plan', call);
  assert.equal(done.failed, false); assert.equal(calls.filter(x => x === 'a-0').length, 1);
  calls.length = 0; shots[0].action = 'changed';
  await reviewSegmented(w, 'plan', 'new-plan', call);
  assert.deepEqual(calls, ['a-0', 'b-0', 'whole']);
  w.segmentReviews = {};
  const failed = await reviewSegmented(w, 'plan', 'plan', async (_, __, d) => d.batchId === 'b-0' ? { ...review(d), observations: [] } : review(d));
  assert.equal(failed.failed, true);
});
