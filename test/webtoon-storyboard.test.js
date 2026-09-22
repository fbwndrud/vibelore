import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runWebtoonTool } from '../src/tools/webtoon.js';
import { digest } from '../src/core/webtoon-contract.js';
import { validateContinuity, continuityInput, continuityDescendants, reconfigureContinuity, roughBinding, storyboardSubject, roughReviewContext, roughReviewed } from '../src/core/webtoon-continuity.js';
import { roughReviewJobs } from '../src/core/webtoon-storyboard.js';
import { WebtoonStore } from '../src/store/webtoon-store.js';
import { answers, webtoonStore, workId, provider, pixel } from './fixtures/webtoon.js';

const production = () => ({ version: 2,
  scenes: [{ id: 'door-scene', environmentId: 'door', layout: '인물 왼쪽, 문 오른쪽', cameraAxis: '문 앞 남쪽' }],
  shots: ['shot1', 'shot2'].map((shotId, i) => ({ shotId, sceneId: 'door-scene', transition: i ? 'cut' : 'reset',
    ...(i ? { previousShotId: 'shot1' } : {}), blocking: '문 앞 왼쪽', camera: i ? '입 근접' : '전신',
    before: '문 닫힘', after: '문 닫힘', change: '말을 건다', decisiveMoment: '입을 열 때' })) });

async function setup(mode = 'review', presentation = {}) {
  const store = await webtoonStore(), providers = provider();
  const call = (tool, args = {}) => runWebtoonTool({ store, toolName: `lore_webtoon_${tool}`, args: { workId, ...args }, providers });
  const approve = r => call('decide', { workflowId: r.workflowId, approvalId: r.approvalId, action: 'approve' });
  let r = await call('plan', { responses: { ...answers, ...presentation }, imageModel: 'gpt-image-2', mode });
  if (mode === 'review') { r = await approve(r); r = await approve(r); }
  const workflowId = r.workflowId, path = join(store.rootDir, 'fixture.png'); await writeFile(path, pixel);
  r = await call('render', { workflowId });
  r = await call('render', { workflowId, references: r.jobs.map(j => ({ referenceId: j.referenceId, inputHash: j.inputHash, path })) });
  if (mode === 'review') await approve(r);
  return { store, call, approve, workflowId, path };
}

async function roughGate(ctx, p = production()) {
  const { call, workflowId, path } = ctx;
  let r = await call('render', { workflowId, continuityPlan: p, feedback: '러프 승인 후 병렬 작화' });
  assert.equal(r.status, 'needs_continuity_roughs');
  assert.ok(r.jobs[0].prompt.includes('silhouettes'));
  r = await call('render', { workflowId, continuityRoughs: r.jobs.map(j => ({ sceneId: j.sceneId, inputHash: j.inputHash, path })) });
  const rough = r.continuity.roughs[0];
  r = await call('render', { workflowId, continuityReviews: [{ kind: 'rough', id: rough.sceneId, hash: rough.hash,
    contextHash: r.roughReviewJobs[0].contextHash,
    inspectedImages: true, passed: true, evidence: 'Synthetic fixture, not visual QA',
    observations: p.shots.map(s => ({ shotId: s.shotId, verdict: 'clear', evidence: 'Fixture silhouette' })),
    transitions: [{ from: 'shot1', to: 'shot2', verdict: 'clear', evidence: 'Fixture causal connection' }] }] });
  assert.equal(r.approval.kind, 'storyboard');
  return r;
}

test('new workflows cannot omit or downgrade the storyboard plan', async () => {
  const ctx = await setup('auto');
  const result = await ctx.call('render', { workflowId: ctx.workflowId });
  assert.equal(result.status, 'needs_continuity_plan');
  assert.deepEqual(result.jobs, []);
  await assert.rejects(ctx.call('render', { workflowId: ctx.workflowId,
    continuityPlan: { ...production(), version: 1 }, feedback: 'downgrade' }), /STORYBOARD_V2_REQUIRED/);
  await assert.rejects(ctx.call('render', { workflowId: ctx.workflowId,
    assets: [{ shotId: 'shot1', path: ctx.path, inputHash: 'fake' }] }), /STORYBOARD_PLAN_REQUIRED/);
});

test('storyboard user gate precedes ready cut jobs even in auto mode; approved rough is a real attachment', async () => {
  const ctx = await setup('auto');
  const gate = await roughGate(ctx);
  assert.equal(gate.status, 'awaiting_approval');
  assert.ok(gate.artifacts['storyboard.html']);
  await assert.rejects(ctx.call('render', { workflowId: ctx.workflowId }), /PLAN_APPROVAL_REQUIRED/);
  await ctx.approve(gate);
  const ready = await ctx.call('render', { workflowId: ctx.workflowId });
  assert.deepEqual(ready.jobs.map(j => j.shotId), ['shot1', 'shot2']);
  for (const job of ready.jobs) {
    const rough = job.referenceImages.find(r => r.role === 'storyboard');
    assert.ok(rough); assert.deepEqual(await readFile(rough.path), pixel);
    assert.equal(rough.shotId, job.shotId);
  }
});

test('continue still waits for the previous finished image while cut uses approved storyboard', async () => {
  const ctx = await setup(), p = production(); p.shots[1].transition = 'continue';
  await ctx.approve(await roughGate(ctx, p));
  const ready = await ctx.call('render', { workflowId: ctx.workflowId });
  assert.deepEqual(ready.jobs.map(j => j.shotId), ['shot1']);
  assert.deepEqual(ready.blockedJobs[0].blockedBy, ['shot:shot1']);
});

const shotReview = id => ({ kind: 'shot', id, hash: digest(pixel), inspectedImages: true, passed: true,
  evidence: 'Synthetic test, not visual inspection', composition: { verdict: 'clear', evidence: 'Synthetic composition' } });

test('new mandatory workflow completes with selected lettering, rough and transition approvals and unchanged prose', async () => {
  const ctx = await setup('review', { W15: 'minimal' });
  const before = await readFile(ctx.store.chapterPath(1));
  const repo = new WebtoonStore(ctx.store);
  assert.equal((await repo.load(ctx.workflowId)).storyboardPolicyVersion, 2);
  await ctx.approve(await roughGate(ctx));
  let r = await ctx.call('render', { workflowId: ctx.workflowId });
  r = await ctx.call('render', { workflowId: ctx.workflowId,
    assets: r.jobs.map(j => ({ shotId: j.shotId, inputHash: j.inputHash, path: ctx.path })),
    continuityReviews: ['shot1', 'shot2'].map(shotReview) });
  const pair = r.continuity.transitions[0];
  r = await ctx.call('render', { workflowId: ctx.workflowId, continuityReviews: [{ kind: 'transition', id: pair.id,
    hash: pair.hash, inspectedImages: true, passed: true, evidence: 'Synthetic pair evidence' }] });
  assert.equal(r.approval.kind, 'look');
  const saved = await repo.load(ctx.workflowId);
  assert.equal(saved.plan.presentation.lettering.thought, 'plain');
  assert.equal(saved.lettering.shot2.candidates[0].items[0].appearance.box, 'round');
  await ctx.approve(r);
  r = await ctx.call('render', { workflowId: ctx.workflowId, quality: 'final' });
  r = await ctx.approve(r);
  assert.equal(r.status, 'completed');
  assert.deepEqual(await readFile(ctx.store.chapterPath(1)), before);
});

test('parallel cuts accept out-of-order completion without stale jobs; actual pair review is mandatory', async () => {
  const ctx = await setup(); await ctx.approve(await roughGate(ctx));
  const { call, workflowId, path } = ctx;
  const ready = await call('render', { workflowId, detail: 'summary' });
  assert.equal(ready.continuity.storyboardApproved, true);
  assert.ok(ready.artifacts['storyboard.html']);
  const [first, second] = ready.jobs;
  let r = await call('render', { workflowId, assets: [{ shotId: second.shotId, inputHash: second.inputHash, path }], continuityReviews: [shotReview(second.shotId)] });
  assert.equal(r.jobs[0].inputHash, first.inputHash);
  const missingComposition = shotReview(first.shotId); delete missingComposition.composition;
  await assert.rejects(call('render', { workflowId, assets: [{ shotId: first.shotId, inputHash: first.inputHash, path }], continuityReviews: [missingComposition] }), /COMPOSITION_REVIEW_REQUIRED/);
  r = await call('render', { workflowId, assets: [{ shotId: first.shotId, inputHash: first.inputHash, path }], continuityReviews: [shotReview(first.shotId)] });
  assert.equal(r.status, 'needs_continuity_review'); assert.equal(r.approval, null);
  await assert.rejects(call('render', { workflowId, revisionTarget: { kind: 'lettering', shotIds: ['shot2'] }, feedback: '글자만 수정' }), /STORYBOARD_ART_REVIEW_REQUIRED/);
  const pair = r.continuity.transitions[0]; assert.equal(pair.ready, true); assert.equal(pair.images.length, 2);
  const review = { kind: 'transition', id: pair.id, hash: pair.hash, inspectedImages: true, passed: true, evidence: 'Synthetic pair evidence only' };
  await assert.rejects(call('render', { workflowId, continuityReviews: [{ ...review, hash: 'outdated' }] }), /STALE_CONTINUITY_REVIEW/);
  r = await call('render', { workflowId, continuityReviews: [{ ...review, passed: false }] });
  assert.equal(r.status, 'needs_continuity_review');
  r = await call('render', { workflowId, continuityReviews: [review] });
  assert.equal(r.approval.kind, 'look');
  await call('decide', { workflowId, approvalId: r.approvalId, action: 'request_revision', feedback: '첫 컷만 수정' });
  r = await call('render', { workflowId, regenerateShotIds: ['shot1'], feedback: '첫 컷 실루엣 수정' });
  assert.deepEqual(r.jobs.map(j => j.shotId), ['shot1']);
  assert.equal(r.continuity.shots[1].imageHash, digest(pixel));
  assert.equal(r.continuity.transitions[0].passed, false);
});

test('rough bytes cannot change after review or after user approval', async () => {
  for (const approved of [false, true]) {
    const ctx = await setup(); const gate = await roughGate(ctx);
    if (approved) await ctx.approve(gate);
    await writeFile(gate.continuity.roughs[0].path, Buffer.concat([pixel, Buffer.from('changed')]));
    await assert.rejects(approved ? ctx.call('render', { workflowId: ctx.workflowId }) : ctx.approve(gate), /STORYBOARD_BYTES_CHANGED/);
  }
});

test('storyboard revision preserves old file, carries feedback, requires fresh rough review and approval', async () => {
  const ctx = await setup(); const gate = await roughGate(ctx);
  let r = await ctx.call('decide', { workflowId: ctx.workflowId, approvalId: gate.approvalId, action: 'request_revision',
    revisionTarget: { kind: 'storyboard', sceneIds: ['door-scene'] }, feedback: '접점과 이동 방향이 읽히게' });
  assert.equal(r.status, 'needs_continuity_roughs');
  assert.equal(r.jobs[0].feedback, '접점과 이동 방향이 읽히게');
  assert.deepEqual(await readFile(gate.continuity.roughs[0].path), pixel);
  await assert.rejects(ctx.approve(gate), /STALE_WEBTOON_APPROVAL/);
  r = await ctx.call('render', { workflowId: ctx.workflowId, continuityRoughs: [{ sceneId: r.jobs[0].sceneId, inputHash: r.jobs[0].inputHash, path: ctx.path }] });
  const rough = r.continuity.roughs[0];
  await assert.rejects(ctx.call('render', { workflowId: ctx.workflowId, assets: [{ shotId: 'shot1', inputHash: 'old', path: ctx.path }] }), /STORYBOARD_APPROVAL_REQUIRED/);
  const review = { kind: 'rough', id: rough.sceneId, hash: rough.hash, contextHash: r.roughReviewJobs[0].contextHash, inspectedImages: true, passed: true, evidence: 'Fixture' };
  await assert.rejects(ctx.call('render', { workflowId: ctx.workflowId, continuityReviews: [review] }), /ROUGH_EVIDENCE_REQUIRED/);
  const p = production();
  review.observations = p.shots.map(s => ({ shotId: s.shotId, verdict: 'clear', evidence: 'Fixture' }));
  review.transitions = [{ from: 'shot1', to: 'shot2', verdict: 'unclear', evidence: 'No readable contact' }];
  await assert.rejects(ctx.call('render', { workflowId: ctx.workflowId, continuityReviews: [review] }), /ROUGH_EVIDENCE_REQUIRED/);
  review.passed = false;
  r = await ctx.call('render', { workflowId: ctx.workflowId, continuityReviews: [review] });
  assert.equal(r.status, 'needs_continuity_review');
  assert.equal(r.roughReviewJobs[0].images.length, 1);
});

function syntheticWorkflow(p = production()) {
  const w = { source: { hash: 'source' }, contract: { digest: 'contract' }, references: {}, images: {},
    plan: { sequences: [{ shots: p.shots.map(s => ({ id: s.shotId, environmentId: 'door', texts: [] })) }] },
    continuity: { plan: p, roughs: {}, roughReviews: {}, shotReviews: {}, transitionReviews: {} } };
  for (const scene of p.scenes) {
    w.continuity.roughs[scene.id] = { image: { hash: scene.id }, path: `/${scene.id}.png`, inputHash: roughBinding(w, scene.id) };
    w.continuity.roughReviews[scene.id] = { hash: scene.id, inspectedImages: true, passed: true, evidence: 'Synthetic fixture' };
  }
  for (const scene of p.scenes) w.continuity.roughReviews[scene.id].contextHash = roughReviewContext(w, scene.id);
  w.continuity.approval = { hash: digest(storyboardSubject(w)) };
  return w;
}

test('v2 requires complete ordered adjacent coverage and deliberate resets', () => {
  const w = syntheticWorkflow(); validateContinuity(w.plan, w.continuity.plan);
  const p = production(); p.shots.pop();
  assert.throws(() => validateContinuity(w.plan, p), /FULL_COVERAGE/);
  p.shots = production().shots.reverse();
  assert.throws(() => validateContinuity(w.plan, p), /READING_ORDER/);
  p.shots = production().shots; p.shots[1].transition = 'reset'; delete p.shots[1].previousShotId;
  assert.throws(() => validateContinuity(w.plan, p), /RESET_REASON/);
  p.shots[1].resetReason = '다음날 문 앞으로 돌아옴'; validateContinuity(w.plan, p);
});

test('action readiness expands from 1 to 3 jobs without changing sequential continue dependencies', () => {
  const p = production(); p.shots.push({ ...p.shots[1], shotId: 'shot3', previousShotId: 'shot2' });
  const w = syntheticWorkflow(p);
  assert.equal(p.shots.filter(s => !continuityInput(w, s.shotId).blocked.length).length, 3);
  assert.deepEqual(continuityDescendants(w, ['shot1']), ['shot1']);
  p.version = 1;
  w.continuity.roughs['door-scene'].inputHash = roughBinding(w, 'door-scene');
  assert.equal(p.shots.filter(s => !continuityInput(w, s.shotId).blocked.length).length, 1);
  assert.deepEqual(continuityDescendants(w, ['shot1']), ['shot1', 'shot2', 'shot3']);
});

test('explicit anchor still blocks a cut, and unchanged rough chunks are preserved across reblocking', () => {
  const p = production(); p.shots[1].anchorShotId = 'shot1';
  let w = syntheticWorkflow(p);
  assert.deepEqual(continuityInput(w, 'shot2').blocked, ['shot:shot1']);
  const separated = production(); separated.scenes.push({ ...separated.scenes[0], id: 'later' });
  separated.shots[1] = { ...separated.shots[1], sceneId: 'later', transition: 'reset', resetReason: '다음날' }; delete separated.shots[1].previousShotId;
  w = syntheticWorkflow(separated);
  const changed = structuredClone(separated); changed.shots[0].camera = 'wide';
  const next = reconfigureContinuity(w, changed);
  assert.deepEqual(next.affected, ['shot1']); assert.ok(next.next.roughs.later);
  assert.equal(next.next.approval, undefined);
});

test('rough review includes boundary neighbor bytes and becomes stale when they change', () => {
  const p = production(); p.scenes.push({ ...p.scenes[0], id: 'next-chunk' }); p.shots[1].sceneId = 'next-chunk';
  const w = syntheticWorkflow(p);
  assert.equal(roughReviewed(w, 'next-chunk'), true);
  w.continuity.roughs['door-scene'].image.hash = 'new-rough';
  assert.equal(roughReviewed(w, 'next-chunk'), false);
  const job = roughReviewJobs(w).find(j => j.sceneId === 'next-chunk');
  assert.equal(job.images.length, 2);
  assert.notEqual(job.contextHash, w.continuity.roughReviews['next-chunk'].contextHash);
  delete w.continuity.roughs['next-chunk'];
  const pending = roughReviewJobs(w);
  assert.deepEqual(pending.map(j => j.sceneId), ['door-scene']);
});
