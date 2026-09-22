import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSegmented } from '../src/core/webtoon-segments.js';
import { compactWebtoonState } from '../src/core/webtoon-efficiency.js';
import { runReviewBatch } from '../src/core/webtoon-review-batch.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { webtoonStore, workId, answers, provider, pixel } from './fixtures/webtoon.js';
import { WebtoonStore } from '../src/store/webtoon-store.js';
import { runLegacyWebtoonTool as runWebtoonTool } from './fixtures/legacy-webtoon.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const fixture = () => {
  const shots = ['a', 'b', 'c', 'd'].map(id => ({ id, sourceIds: [id], texts: [], knowledgeBefore: [], knowledgeAfter: [] }));
  return { efficiencyVersion: 1, decisions: {}, contract: { digest: 'contract' }, source: { hash: 'source', units: [], chapters: [] },
    images: {}, plan: { sequences: shots.map(s => ({ id: s.id, purpose: s.id, shots: [s] })) }, render: { shotIds: shots.map(s => s.id), files: {}, artComplete: true } };
};
const response = d => ({ subjectHash: d.subjectHash, inspectedImages: true, evidence: 'Fixture only', findings: [],
  observations: d.shots?.map(s => ({ shotId: s.id, verdict: 'clear', evidence: 'Fixture' })),
  transitions: d.transitions?.map(t => ({ ...t, verdict: 'clear', evidence: 'Fixture' })) });

test('global composite unavailability ends review fan-out without approving unseen work', async () => {
  const w = fixture(); let calls = 0;
  const r = await reviewSegmented(w, 'render', 'hash', async (_, __, d) => {
    calls++; return { ...response(d), inspectedImages: false, inspectionUnavailable: { scope: 'composite', reason: 'Host renderer denied' } };
  });
  assert.equal(calls, 1); assert.equal(r.failed, true); assert.equal(r.inspectedImages, false);
  assert.ok(r.findings.some(f => f.code === 'COMPOSITE_UNAVAILABLE'));
});

test('independent review packets batch at most three, keep context, and finish with separate whole-flow review', async () => {
  const w = fixture(), batches = [], singles = [];
  const call = async (_, __, d) => { singles.push(d.batchId ?? 'whole'); return response(d); };
  call.batch = async tasks => { batches.push(tasks); return tasks.map(t => response(t.data)); };
  const r = await reviewSegmented(w, 'plan', 'hash', call);
  assert.equal(r.failed, false); assert.deepEqual(batches.map(b => b.length), [3, 1]);
  assert.deepEqual(singles, ['whole']);
  assert.equal(batches[0][0].data.shots.length, 1);
  assert.equal(batches[0][0].data.context.length, 2);
  const again = await reviewSegmented(w, 'plan', 'hash', call);
  assert.equal(again.failed, false); assert.equal(batches.length, 2);
});

test('a failed batch slot is not laundered by a successful whole-flow review', async () => {
  const w = fixture();
  const call = async (_, __, data) => response(data);
  call.batch = async tasks => tasks.map((t, i) => ({ ...response(t.data), ...(i === 0 ? { failed: true } : {}) }));
  assert.equal((await reviewSegmented(w, 'plan', 'hash', call)).failed, true);
});

test('review provider execution has three independent in-flight requests, not a merged mega-prompt', async () => {
  const store = await webtoonStore(), repo = new WebtoonStore(store);
  const w = { ...fixture(), workflowId: 'wt-parallel-test', workId, revision: 1, events: [], failures: [], attempt: 0 };
  let active = 0, peak = 0; const waiting = [];
  const providers = { complete: async request => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => { waiting.push(resolve); if (waiting.length === 3) waiting.forEach(f => f()); });
    active--; return { text: JSON.stringify(response(JSON.parse(request.messages.at(-1).content))) };
  } };
  const tasks = ['a', 'b', 'c'].map(id => ({ step: 'webtoon-plan-review', system: 'Fixture', data: { subjectHash: id } }));
  const result = await runReviewBatch({ repo, workflow: w, providers, tasks, model: {}, event: () => {} });
  assert.equal(peak, 3); assert.deepEqual(result.map(r => r.subjectHash), ['a', 'b', 'c']);
});

test('summary retains actionable gates and failures without repeating the whole plan and reference library', () => {
  const full = { status: 'needs_images', workflowId: 'wt-test', approval: { id: 'wa-1' }, quality: { findings: [{ code: 'X' }] },
    plan: { large: 'x'.repeat(10000) }, inherited: { large: 'x'.repeat(10000) }, references: [{ id: 'r', large: 'x'.repeat(10000) }],
    artifacts: { 'episode.html': { path: '/preview' }, other: { path: '/other' } }, jobs: [{ shotId: 'a', inputHash: 'hash', prompt: 'do not trim' }] };
  const compact = compactWebtoonState(full);
  assert.equal(compact.plan, undefined); assert.equal(compact.inherited, undefined);
  assert.deepEqual(compact.jobs, full.jobs); assert.deepEqual(compact.approval, full.approval);
  assert.deepEqual(compact.quality, full.quality); assert.ok(compact.artifacts['episode.html']);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length / 10);
  assert.equal(full.plan.large.length, 10000);
});

test('review batch survives partial replies/restart without replaying completed slots or accepting stale bindings', async () => {
  const store = await webtoonStore(), repo = new WebtoonStore(store);
  let w = { ...fixture(), workflowId: 'wt-batch-test', workId, revision: 1, events: [], failures: [], attempt: 0 };
  const tasks = ['a', 'b', 'c'].map(id => ({ step: 'webtoon-plan-review', system: 'Fixture review', data: { batchId: id, subjectHash: id } }));
  const event = (w, name, detail) => w.events.push({ event: name, ...detail });
  const call = providers => runReviewBatch({ repo, workflow: w, providers, tasks, model: { provider: 'host', modelId: 'fixture' }, event });
  const first = await call(createHostRelay());
  assert.equal(first.result.requests.length, 3);
  const q = first.result.requests[0];
  const partial = await call(createHostRelay({ [q.id]: JSON.stringify(response(JSON.parse(q.user))) }));
  assert.equal(partial.result.runId, first.result.runId);
  assert.equal(partial.result.requests.length, 2); assert.equal(partial.result.scheduling.completed, 1);
  w = await repo.load(w.workflowId);
  assert.equal(w.events.length, 1);
  const values = Object.fromEntries(partial.result.requests.map(q => [q.id, JSON.stringify(response(JSON.parse(q.user)))]));
  const done = await call(createHostRelay(values));
  assert.equal(done.length, 3); assert.equal(w.events.length, 3); assert.equal(w.pending, null);
  assert.equal(new Set(w.events.map(e => e.requestId)).size, 3);
  await call(createHostRelay());
  tasks[0].data.subjectHash = 'changed';
  await assert.rejects(call(createHostRelay()), /STALE_WEBTOON_REVIEW_BATCH/);
});

test('preflight unavailability avoids model requests but keeps the failed look gate, even in auto mode', async () => {
  const store = await webtoonStore(), p = provider();
  const call = (tool, args = {}) => runWebtoonTool({ store, toolName: `lore_webtoon_${tool}`, args: { workId, ...args }, providers: p });
  const initial = await call('plan', { mode: 'auto', responses: answers, imageModel: 'gpt-image-2' });
  const refs = await call('render', { workflowId: initial.workflowId });
  const path = join(store.rootDir, 'pixel.png'); await writeFile(path, pixel);
  await call('render', { workflowId: initial.workflowId, references: refs.jobs.map(j => ({ referenceId: j.referenceId, inputHash: j.inputHash, path })) });
  const jobs = await call('render', { workflowId: initial.workflowId });
  const before = p.requests.length;
  const r = await call('render', { workflowId: initial.workflowId,
    reviewAccess: { available: false, reason: 'Synthetic global renderer restriction' },
    assets: jobs.jobs.map(j => ({ shotId: j.shotId, inputHash: j.inputHash, path })) });
  assert.equal(r.approval.kind, 'look'); assert.equal(r.quality.status, 'failed');
  assert.ok(r.quality.findings.some(f => f.code === 'COMPOSITE_UNAVAILABLE'));
  assert.ok(p.requests.slice(before).every(q => q.step !== 'webtoon-render-review'));
  assert.ok(p.requests.slice(before).some(q => q.step === 'webtoon-layout-analyze'));
});
