import test from 'node:test';
import assert from 'node:assert/strict';
import { runConfigureStatus } from '../src/tools/configure.js';
import { runWebtoonSceneTool } from '../src/tools/webtoon-scene.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';
import { digest } from '../src/core/webtoon-contract.js';
import { sceneImageBinding, validateSceneImageReview } from '../src/core/webtoon-scene.js';
import { compositionCheckSchema, validateCompositionCheck, finalCompositionLabels, SCENE_IMAGE_REVIEW_PROMPT, COMPOSITION_CAST_SENTENCE } from '../src/core/webtoon-scene-review.js';
import { sceneSetup, scenePlan, scenePreflight, sceneCompositionCheck, sceneComposition } from './fixtures/webtoon-scene.js';
import { qualityStore, workId as qualityWorkId } from './fixtures/quality-workflow.js';
import { workId } from './fixtures/webtoon.js';
import { readFile } from 'node:fs/promises';
import { CompositionStore } from '../src/store/webtoon-composition-store.js';

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
    spatialCoherence: true, readingOrder: true, evidence: 'Synthetic review, not an actual image inspection.', findings: [], visualChecks: checks(),
    ...sceneCompositionCheck(compositionCheckSchema(w)) };
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
  return { ...d.schema, ...sceneCompositionCheck(d.schema.compositionCheck), visualChecks: checks(), inspectedImages: true, observedPanelCount: d.requestedPanelCount,
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

const SENTENCE = 'For compositionCheck, compare each panel to its planned composition label; report differs with the observed label only when visible evidence shows it, and unclear when it cannot be seen.';
const entry = (panel, result, observed = null) => ({ panel, result, observed, evidence: `Panel ${panel} was inspected.` });
const observedLabel = () => ({ shot: 'CU', angle: 'low', focal: 'face', background: 'bokeh', subjects: [], directed: false });

test('composition check schema has one entry per panel and offers observed only for a backfill', async () => {
  const { w } = await syntheticReview();
  const schema = compositionCheckSchema(w);
  assert.deepEqual(schema.map(e => e.panel), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(schema[0], { panel: 1, result: 'match|differs|unclear', observed: null, evidence: '' });
  w.compositionBackfill = true;
  assert.equal(compositionCheckSchema(w)[0].result, 'observed|unclear');
});

test('composition check must be complete: one entry per panel, observed only with differs or observed, evidence always', async () => {
  const { w } = await syntheticReview();
  const full = () => [1, 2, 3, 4, 5, 6].map(p => entry(p, 'match'));
  validateCompositionCheck(full(), w);
  const cases = {
    'a missing panel': c => c.slice(1), 'a duplicate panel': c => [...c.slice(0, 5), entry(1, 'match')], 'an extra panel': c => [...c, entry(7, 'match')],
    'not an array': () => undefined, 'differs without observed': c => { c[2] = entry(3, 'differs'); return c; },
    'match with observed': c => { c[2] = entry(3, 'match', observedLabel()); return c; },
    'unclear with observed': c => { c[2] = entry(3, 'unclear', observedLabel()); return c; },
    'an off-vocabulary observed label': c => { c[2] = entry(3, 'differs', { ...observedLabel(), shot: 'MACRO' }); return c; },
    'a result outside the options': c => { c[2] = entry(3, 'observed', observedLabel()); return c; },
    'empty evidence': c => { c[2] = { ...entry(3, 'match'), evidence: '  ' }; return c; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    assert.throws(() => validateCompositionCheck(mutate(full()), w), /INCOMPLETE_SCENE_COMPOSITION_REVIEW/, name);
  }
});

test('an observed label is checked against the same cast ids as the render brief', async () => {
  const { w } = await syntheticReview();
  w.source.cast = [{ localCharacterId: 'yun' }];
  const check = [1, 2, 3, 4, 5, 6].map(p => entry(p, 'match'));
  check[0] = entry(1, 'differs', { ...observedLabel(), subjects: [{ id: 'yun' }] });
  validateCompositionCheck(check, w);
  check[0] = entry(1, 'differs', { ...observedLabel(), subjects: [{ id: 'stranger' }] });
  assert.throws(() => validateCompositionCheck(check, w), /INCOMPLETE_SCENE_COMPOSITION_REVIEW/);
});

test('a backfill review offers observed or unclear and rejects the plan-relative results', async () => {
  const { w } = await syntheticReview();
  w.compositionBackfill = true;
  const check = [1, 2, 3, 4, 5, 6].map(p => entry(p, 'observed', observedLabel()));
  check[1] = entry(2, 'unclear');
  validateCompositionCheck(check, w);
  check[2] = entry(3, 'match');
  assert.throws(() => validateCompositionCheck(check, w), /INCOMPLETE_SCENE_COMPOSITION_REVIEW/);
  check[2] = entry(3, 'observed');
  assert.throws(() => validateCompositionCheck(check, w), /INCOMPLETE_SCENE_COMPOSITION_REVIEW/);
});

test('every panel differing does not change the review verdict', async () => {
  const { w, review } = await syntheticReview();
  assert.equal(validateSceneImageReview(review, w), true);
  review.compositionCheck = [1, 2, 3, 4, 5, 6].map(p => entry(p, 'differs', observedLabel()));
  assert.equal(validateSceneImageReview(review, w), true);
  review.visualChecks.propStructure = { status: 'failed', panels: [1], evidence: 'Support is missing.' };
  assert.equal(validateSceneImageReview(review, w), false);
  delete review.compositionCheck;
  assert.throws(() => validateSceneImageReview(review, w), /INCOMPLETE_SCENE_COMPOSITION_REVIEW/);
});

test('final labels follow the check: match keeps the plan, differs takes the observation, unclear keeps the plan flagged', async () => {
  const { w, review } = await syntheticReview();
  const planned = p => w.preflight.renderBrief.moments[p - 1].composition;
  const seen = observedLabel();
  w.visualReview = { ...review, passed: true, compositionCheck: [entry(1, 'match'), entry(2, 'differs', seen), entry(3, 'unclear'), entry(4, 'match'), entry(5, 'match'), entry(6, 'match')] };
  const labels = finalCompositionLabels(w);
  assert.equal(labels.length, 6);
  assert.deepEqual(labels[0], { panel: 1, label: planned(1), source: 'plan', confidence: 'clear' });
  assert.deepEqual(labels[1], { panel: 2, label: seen, source: 'review-corrected', confidence: 'clear' });
  assert.deepEqual(labels[2], { panel: 3, label: planned(3), source: 'plan', confidence: 'unclear' });
  w.compositionBackfill = true;
  w.visualReview.compositionCheck = [entry(1, 'observed', seen), entry(2, 'unclear'), ...[3, 4, 5, 6].map(p => entry(p, 'observed', seen))];
  const backfilled = finalCompositionLabels(w);
  assert.deepEqual(backfilled[0], { panel: 1, label: seen, source: 'observed-backfill', confidence: 'clear' });
  assert.deepEqual(backfilled[1], { panel: 2, label: null, source: 'observed-backfill', confidence: 'unclear' });
  w.visualReview = null;
  assert.deepEqual(finalCompositionLabels(w), []);
});

test('an auto workflow whose later revision resolves fewer panels needs exactly that many entries', async () => {
  const { store, args } = await sceneSetup();
  const counts = [7, 5], reviews = [];
  let stale = false;
  const p = { async complete(req) {
    const d = JSON.parse(req.messages.at(-1).content);
    if (req.step === 'webtoon-scene-plan') return { text: JSON.stringify(scenePlan(d.source, counts.shift())) };
    if (req.step === 'webtoon-scene-preflight') return { text: JSON.stringify(scenePreflight(d)) };
    reviews.push(d);
    const answer = reviewAnswer({ user: JSON.stringify(d) });
    if (reviews.length === 1) answer.observedPanelCount = 6;
    else if (stale) answer.compositionCheck = [1, 2, 3, 4, 5, 6, 7].map(n => entry(n, 'match'));
    return { text: JSON.stringify(answer) };
  } };
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, panelCount: 'auto' }, providers: p });
  assert.equal(drawn.panelCount, 7);
  // The first image shows the wrong panel count, so the workflow re-plans automatically at five panels.
  const replanned = await runWebtoonSceneTool({ store, args: { workId, asset: assetFor(args, drawn.jobs[0]) }, providers: p });
  assert.equal(replanned.status, 'needs_scene_image');
  assert.equal(replanned.panelCount, 5);
  assert.equal(reviews[0].schema.compositionCheck.length, 7);
  stale = true;
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId, asset: assetFor(args, replanned.jobs[0]) }, providers: p }), /INCOMPLETE_SCENE_COMPOSITION_REVIEW/);
  assert.equal(reviews[1].schema.compositionCheck.length, 5);
  stale = false;
  const done = await runWebtoonSceneTool({ store, args: { workId, action: 'retry' }, providers: p });
  assert.equal(done.status, 'completed');
  assert.equal(done.visualReview.compositionCheck.length, 5);
});

test('the review request carries the composition check and sentence only for composition workflows', async () => {
  const { store, args } = await sceneSetup();
  const drawn = await runWebtoonSceneTool({ store, args, providers: planner });
  const modern = await runWebtoonSceneTool({ store, args: { workId, asset: assetFor(args, drawn.jobs[0]) }, providers: createHostRelay() });
  const q = modern.requests[0];
  assert.equal(JSON.parse(q.user).schema.compositionCheck.length, 6);
  assert.ok(q.system.includes(SENTENCE));
  assert.equal(SCENE_IMAGE_REVIEW_PROMPT.includes('compositionCheck'), false, 'the base prompt bytes are unchanged');

  const old = await sceneSetup();
  const drawnOld = await runWebtoonSceneTool({ store: old.store, args: old.args, providers: planner });
  const w = await old.repo.load(); delete w.compositionVersion; await old.repo.save(w);
  const legacy = await runWebtoonSceneTool({ store: old.store, args: { workId, asset: assetFor(old.args, drawnOld.jobs[0]) }, providers: createHostRelay() });
  const lq = legacy.requests[0];
  assert.equal(JSON.parse(lq.user).schema.compositionCheck, undefined);
  assert.equal(lq.system.includes('compositionCheck'), false);
  // The novel foundation's characters stand in as the cast, so the cast sentence rides with the check sentence.
  assert.deepEqual(JSON.parse(q.user).cast, [{ id: 'hero', name: '윤' }]);
  assert.equal(q.system, lq.system.replace(SCENE_IMAGE_REVIEW_PROMPT, `${SCENE_IMAGE_REVIEW_PROMPT}\n${SENTENCE}\n${COMPOSITION_CAST_SENTENCE}`), 'only the check and cast sentences differ');
  assert.equal('cast' in JSON.parse(lq.user), false);
});

// A scene that finished before composition labels existed: no compositionVersion, no composition rows.
async function completedLegacyScene() {
  const { store, repo, args } = await sceneSetup();
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 2 }, providers: planner });
  const w = await repo.load(); delete w.compositionVersion; await repo.save(w);
  const pending = await runWebtoonSceneTool({ store, args: { workId, asset: assetFor(args, drawn.jobs[0]) }, providers: createHostRelay() });
  const q = pending.requests[0], run = await loadRun(store.rootDir, pending.runId);
  const done = await runWebtoonSceneTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(reviewAnswer(q)) }) });
  assert.equal(done.status, 'completed');
  return { store, repo, composition: new CompositionStore(repo) };
}
const allRows = async composition => (await Promise.all((await composition.listEpisodes()).map(({ episodeKey }) => composition.readShard(episodeKey)))).flat();
function backfillAnswer(q, { unclearPanel = 2, mutate } = {}) {
  const d = JSON.parse(q.user);
  const answer = reviewAnswer(q);
  answer.compositionCheck = d.schema.compositionCheck.map(e => e.panel === unclearPanel
    ? { panel: e.panel, result: 'unclear', observed: null, evidence: `Panel ${e.panel} is cropped.` }
    : { panel: e.panel, result: 'observed', observed: sceneComposition(), evidence: `Panel ${e.panel} was inspected.` });
  mutate?.(answer);
  return answer;
}
async function answerReview(store, pending, answer) {
  const run = await loadRun(store.rootDir, pending.runId);
  return runWebtoonSceneTool({ store, args: run.args, run, providers: createHostRelay({ [pending.requests[0].id]: JSON.stringify(answer(pending.requests[0])) }) });
}

test('a backfill re-review of a completed pre-change scene records observed-backfill rows and stays completed', async () => {
  const { store, repo, composition } = await completedLegacyScene();
  assert.deepEqual(await allRows(composition), [], 'a pre-change scene starts with no composition rows');
  const before = await repo.load();
  const pending = await runWebtoonSceneTool({ store, args: { workId, action: 'review', compositionBackfill: true }, providers: createHostRelay() });
  assert.equal(pending.status, 'needs_model');
  const request = JSON.parse(pending.requests[0].user);
  assert.deepEqual(request.schema.compositionCheck.map(e => e.result), Array(6).fill('observed|unclear'));
  assert.ok(pending.requests[0].system.includes(SENTENCE));
  const done = await answerReview(store, pending, q => backfillAnswer(q));
  assert.equal(done.status, 'completed');
  const state = await repo.load();
  assert.equal(state.stage, 'completed');
  assert.equal(state.compositionBackfill, true, 'the flag stays persisted for later label derivation');
  assert.equal(state.compositionVersion, undefined);
  assert.equal(state.reviewHistory.length, 1, 'the previous review is preserved');
  assert.equal(state.revision, before.revision);
  const panels = (await allRows(composition)).filter(r => r.type === 'panel');
  assert.equal(panels.length, 6);
  assert.ok(panels.every(r => r.source === 'observed-backfill' && r.status === 'adopted'));
  assert.equal(panels.filter(r => r.confidence === 'unclear').length, 1);
  assert.equal(panels.find(r => r.panel === 2).label, null);
  assert.deepEqual(panels.find(r => r.panel === 1).label, sceneComposition());
  assert.equal(done.compositionAdvisory, undefined, 'backfill adds no repetition advisory');
});

test('a backfill review that fails other checks still records adopted rows, keeps the scene completed and shows the findings', async () => {
  const { store, repo, composition } = await completedLegacyScene();
  const pending = await runWebtoonSceneTool({ store, args: { workId, action: 'review', compositionBackfill: true }, providers: createHostRelay() });
  const done = await answerReview(store, pending, q => backfillAnswer(q, { mutate: a => {
    a.visualChecks.propStructure = { status: 'failed', panels: [1], evidence: 'The support is missing.' };
    a.findings = [{ severity: 'blocking', category: 'prop', evidence: 'The support is missing.' }];
  } }));
  assert.equal(done.status, 'completed');
  assert.equal(done.jobs, undefined, 'no image is requested');
  assert.equal(done.visualReview.passed, false);
  assert.equal(done.visualReview.findings.length, 1);
  const state = await repo.load();
  assert.equal(state.stage, 'completed');
  assert.equal(state.visualReview.passed, false);
  assert.deepEqual(state.autoRevision, { used: 0, limit: 2 });
  const rows = await allRows(composition);
  assert.ok(rows.length === 7 && rows.every(r => r.status === 'adopted'), 'rows are adopted although the review failed');
});

test('backfill refuses a workflow that already records composition and a scene that is not completed', async () => {
  const modern = await sceneSetup();
  const drawn = await runWebtoonSceneTool({ store: modern.store, args: modern.args, providers: planner });
  const pending = await runWebtoonSceneTool({ store: modern.store, args: { workId, asset: assetFor(modern.args, drawn.jobs[0]) }, providers: createHostRelay() });
  const done = await answerReview(modern.store, pending, q => reviewAnswer(q));
  assert.equal(done.status, 'completed');
  await assert.rejects(runWebtoonSceneTool({ store: modern.store, args: { workId, action: 'review', compositionBackfill: true }, providers: createHostRelay() }), /SCENE_BACKFILL_NOT_NEEDED/);

  const legacy = await sceneSetup();
  const drawnLegacy = await runWebtoonSceneTool({ store: legacy.store, args: legacy.args, providers: planner });
  const w = await legacy.repo.load(); delete w.compositionVersion; await legacy.repo.save(w);
  const reviewing = await runWebtoonSceneTool({ store: legacy.store, args: { workId, asset: assetFor(legacy.args, drawnLegacy.jobs[0]) }, providers: createHostRelay() });
  assert.equal(reviewing.status, 'needs_model');
  await assert.rejects(runWebtoonSceneTool({ store: legacy.store, args: { workId, action: 'review', compositionBackfill: true }, providers: createHostRelay() }), /SCENE_BACKFILL_REQUIRES_COMPLETED/);
  assert.equal((await legacy.repo.load()).compositionBackfill, undefined, 'a refused backfill leaves no flag behind');
  await assert.rejects(runWebtoonSceneTool({ store: legacy.store, args: { workId, action: 'revise', feedback: 'x', compositionBackfill: true }, providers: createHostRelay() }), /SCENE_BACKFILL_REVIEW_ONLY/);
});

test('compositionBackfill is refused for every action but review, before anything runs', async () => {
  const { store, repo, args } = await sceneSetup();
  const refuses = extra => assert.rejects(runWebtoonSceneTool({ store, args: { workId, compositionBackfill: true, ...extra }, providers: createHostRelay() }), /SCENE_BACKFILL_REVIEW_ONLY/);
  await refuses({ ...args });
  assert.equal(await repo.load(), null, 'start created no workflow');
  await refuses({ action: 'start', workId, sourceChapters: [1] });
  await refuses({ action: 'composition_rebuild' });
  await refuses({ action: 'verify' });
  await refuses({ action: 'reject', feedback: 'stop' });
  assert.equal(await repo.load(), null);
});

test('a plain re-review of a pre-change scene keeps its bytes: no composition field, no rows', async () => {
  const { store, repo, composition } = await completedLegacyScene();
  const pending = await runWebtoonSceneTool({ store, args: { workId, action: 'review' }, providers: createHostRelay() });
  assert.equal(JSON.parse(pending.requests[0].user).schema.compositionCheck, undefined);
  assert.equal(pending.requests[0].system.includes('compositionCheck'), false);
  const done = await answerReview(store, pending, q => reviewAnswer(q));
  assert.equal(done.status, 'completed');
  assert.deepEqual(await allRows(composition), []);
  assert.equal((await repo.load()).compositionBackfill, undefined);
});
