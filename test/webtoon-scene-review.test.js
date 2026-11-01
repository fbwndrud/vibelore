import test from 'node:test';
import assert from 'node:assert/strict';
import { runConfigureStatus } from '../src/tools/configure.js';
import { runWebtoonSceneTool } from '../src/tools/webtoon-scene.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';
import { digest } from '../src/core/webtoon-contract.js';
import { sceneImageBinding, validateSceneImageReview } from '../src/core/webtoon-scene.js';
import { sceneSetup, scenePlan, scenePreflight } from './fixtures/webtoon-scene.js';
import { qualityStore, workId as qualityWorkId } from './fixtures/quality-workflow.js';
import { workId } from './fixtures/webtoon.js';
import { readFile } from 'node:fs/promises';

const terra = { provider: 'host', modelId: 'gpt-6.1-terra', reasoningEffort: 'medium' };
const checkNames = ['reflectionGeometry', 'propStructure', 'handsAndContact', 'withinSceneContinuity', 'layoutAndTiming'];
const checks = () => Object.fromEntries(checkNames.map(key => [key, {
  status: 'not_applicable', panels: [], evidence: 'Synthetic fixture; no required visual relationship is evaluated.',
}]));
const planner = { async complete(req) {
  const d = JSON.parse(req.messages.at(-1).content);
  return { text: JSON.stringify(req.step === 'webtoon-scene-plan' ? scenePlan(d.source) : scenePreflight(d)) };
} };
const assetFor = (args, job) => ({ path: args.references[0].path, inputHash: job.inputHash,
  provenance: { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: 'selected-api' } });

test('configure persists a webtoon-only reviewer, preserves omission, and clears explicit null', async () => {
  const store = await qualityStore();
  const workId = qualityWorkId;
  assert.deepEqual((await runConfigureStatus({ store, workId, webtoonReviewModel: terra })).webtoonReviewModel, terra);
  assert.deepEqual((await runConfigureStatus({ store, workId })).webtoonReviewModel, terra);
  assert.equal((await runConfigureStatus({ store, workId, webtoonReviewModel: null })).webtoonReviewModel, null);
  await assert.rejects(runConfigureStatus({ store, workId, webtoonReviewModel: { reasoningEffort: 'medium' } }), /INVALID_WEBTOON_REVIEW_MODEL/);
  await assert.rejects(runConfigureStatus({ store, workId, webtoonReviewModel: 'bad model id' }), /INVALID_WEBTOON_REVIEW_MODEL/);
});

test('only image review routes to the configured reviewer and exposes reference roles and visual checks', async () => {
  const { store, args } = await sceneSetup();
  await store.saveReviewPolicy(workId, { webtoonReviewModel: terra });
  let first;
  const p = { async complete(req) { first ??= req; return planner.complete(req); } };
  const drawn = await runWebtoonSceneTool({ store, args, providers: p });
  assert.equal(first.model.modelId, 'host-agent');
  const review = await runWebtoonSceneTool({ store, args: { workId, asset: assetFor(args, drawn.jobs[0]) }, providers: createHostRelay() });
  const q = review.requests[0], d = JSON.parse(q.user);
  assert.deepEqual(q.model, { provider: 'host', modelId: terra.modelId });
  assert.equal(q.reasoningEffort, 'medium');
  assert.equal(d.reviewVersion, 2);
  assert.deepEqual(Object.keys(d.schema.visualChecks), checkNames);
  assert.ok(d.referenceImages.some(ref => ref.id === 'ref' && q.images[ref.imageIndex - 1]));
  assert.match(q.system, /reflection/i);
  assert.match(q.system, /uncertain/);
});

test('explicit re-review preserves image, revision and redraw budget while replacing only the pending review', async () => {
  const { store, repo, args } = await sceneSetup();
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: planner });
  const pending = await runWebtoonSceneTool({ store, args: { workId, asset: assetFor(args, drawn.jobs[0]) }, providers: createHostRelay() });
  const before = await repo.load();
  await store.saveReviewPolicy(workId, { webtoonReviewModel: terra });
  const unchanged = await runWebtoonSceneTool({ store, args: { workId }, providers: createHostRelay() });
  assert.equal(unchanged.runId, pending.runId);
  const reviewed = await runWebtoonSceneTool({ store, args: { workId, action: 'review', feedback: 'Inspect the reflection and open case with Terra.' }, providers: createHostRelay() });
  assert.equal(reviewed.status, 'needs_model');
  assert.notEqual(reviewed.runId, pending.runId);
  assert.notEqual(reviewed.requests[0].id, pending.requests[0].id);
  assert.equal(await loadRun(store.rootDir, pending.runId), null);
  assert.deepEqual(reviewed.image, pending.image);
  const history = (await repo.load()).reviewHistory;
  const archived = JSON.parse(await readFile(history.at(-1).path, 'utf8'));
  assert.equal(archived.pending.runId, pending.runId);
  assert.equal(archived.pending.requestId, pending.requests[0].id);
  assert.equal(typeof archived.pending.startedAt, 'string');
  assert.equal(reviewed.revision, before.revision);
  assert.deepEqual(reviewed.autoRevision, before.autoRevision);
  assert.equal(reviewed.jobs, undefined);
  assert.equal(reviewed.requests[0].model.modelId, terra.modelId);
  assert.match(JSON.parse(reviewed.requests[0].user).feedback, /reflection/);
});

async function syntheticReview() {
  const { store, repo, args } = await sceneSetup();
  await runWebtoonSceneTool({ store, args, providers: planner });
  const w = await repo.load();
  w.sceneImage = { hash: 'synthetic-image' }; w.imageReviewVersion = 2;
  const review = { subjectHash: digest({ binding: sceneImageBinding(w), imageHash: w.sceneImage.hash }),
    inspectedImages: true, observedPanelCount: 6, coveredBeatIds: w.scenePlan.beats.map(b => b.id),
    textObservations: w.scenePlan.texts.map(t => ({ id: t.id, observedText: t.text, readable: true, speakerCorrect: true, evidence: 'Synthetic text fixture.' })),
    spatialCoherence: true, readingOrder: true, evidence: 'Synthetic review, not an actual image inspection.', findings: [], visualChecks: checks() };
  return { w, review };
}

test('failed and uncertain visual checks block completion despite aggregate pass claims', async () => {
  const { w, review } = await syntheticReview();
  assert.equal(validateSceneImageReview(review, w), true);
  for (const status of ['failed', 'uncertain']) {
    review.visualChecks.reflectionGeometry = { status, panels: [1], evidence: 'Panel1 does not establish matching reflected hands.' };
    assert.equal(validateSceneImageReview(review, w), false);
  }
});

test('new review contract rejects missing checks, empty evidence and invalid panel references', async () => {
  const { w, review } = await syntheticReview();
  for (const mutate of [r => delete r.visualChecks.propStructure,
    r => { r.visualChecks.propStructure.evidence = ''; },
    r => { r.visualChecks.propStructure = { status: 'passed', panels: [7], evidence: 'Outside the actual six panels.' }; }]) {
    const invalid = structuredClone(review); mutate(invalid);
    assert.throws(() => validateSceneImageReview(invalid, w), /INCOMPLETE_SCENE_VISUAL_REVIEW/);
  }
  delete w.imageReviewVersion; delete review.visualChecks;
  assert.equal(validateSceneImageReview(review, w), true, 'legacy pending reviews keep their original contract');
});

function reviewAnswer(q) {
  const d = JSON.parse(q.user);
  return { ...d.schema, visualChecks: checks(), inspectedImages: true, observedPanelCount: d.requestedPanelCount,
    spatialCoherence: true, readingOrder: true, evidence: 'Synthetic protocol receipt.', findings: [],
    textObservations: d.plan.texts.map(t => ({ id: t.id, observedText: t.text, readable: true, speakerCorrect: true, evidence: 'Synthetic text.' })) };
}

test('re-review archives a completed receipt and cannot spend an existing automatic redraw allowance', async () => {
  const { store, repo, args } = await sceneSetup();
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 2 }, providers: planner });
  let pending = await runWebtoonSceneTool({ store, args: { workId, asset: assetFor(args, drawn.jobs[0]) }, providers: createHostRelay() });
  let q = pending.requests[0], run = await loadRun(store.rootDir, pending.runId);
  const done = await runWebtoonSceneTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(reviewAnswer(q)) }) });
  assert.equal(done.status, 'completed');
  const oldReview = structuredClone(done.visualReview);
  pending = await runWebtoonSceneTool({ store, args: { workId, action: 'review' }, providers: createHostRelay() });
  const state = await repo.load();
  assert.equal(state.visualReview, null);
  assert.equal(state.reviewHistory.length, 1);
  const archived = JSON.parse(await readFile(state.reviewHistory[0].path, 'utf8'));
  assert.deepEqual(archived.visualReview, oldReview);
  assert.equal(archived.productionRecord.reviewHash, digest(oldReview));
  q = pending.requests[0]; run = await loadRun(store.rootDir, pending.runId);
  const failed = reviewAnswer(q);
  failed.visualChecks.propStructure = { status: 'uncertain', panels: [1], evidence: 'Required support cannot be identified.' };
  const result = await runWebtoonSceneTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(failed) }) });
  assert.equal(result.status, 'scene_needs_revision');
  assert.equal(result.jobs, undefined);
  assert.equal(result.revision, done.revision);
  assert.deepEqual(result.autoRevision, { used: 0, limit: 2 });
});
