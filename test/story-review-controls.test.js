import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { runConfigureStatus } from '../src/tools/configure.js';
import { saveWriterSupportPolicy, loadArcReviewSchedule, loadPlanningReviews } from '../src/core/review-policy.js';
import { runStorySpine } from '../src/tools/story-spine.js';
import { runArcPlan } from '../src/tools/arc.js';
import { runEpisodePlan } from '../src/tools/episode-plan.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';
import { arcReviewCheckpoint, runArcReview, runStoredArcReview } from '../src/tools/arc-review.js';
import { STAGE_REVIEW_FOCUS } from '../src/core/planning-stage-review.js';
import { qualityStore, workId, outputs } from './fixtures/quality-workflow.js';
import { approvalResponse } from './fixtures/approval-response.js';
import { contractResponse } from './fixtures/contract-response.js';

async function fixture(t) {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true })); return store;
}
const discovery = { depth: 'deep', authority: 'user', userAnswer: '함께 자세히 준비해요.' };
const story = { dramaticQuestion: '함께 놀 수 있는가?', protagonistWant: '함께 논다', protagonistNeed: '협력', falseBelief: '혼자면 충분',
  incitingDisruption: '문이 잠김', initialStrategy: '혼자 민다', causalChain: ['문을 민다', '안 열린다', '도움을 묻는다', '함께 연다', '함께 논다'],
  midpointReframe: '도움이 필요하다', finalChoice: '도움을 청한다', endingChange: '협력', endingCost: '시간',
  characterForces: [{ characterId: 'hero', want: '입장', actionThatChangesPlot: '문을 민다' }, { characterId: 'gate', want: '규칙 보존', actionThatChangesPlot: '문을 잠근다' }] };
const arc = { title: '문 안', promise: '같이 논다', episodes: [1, 2, 3].map(i => ({ title: `놀이 ${i}`, beat: `다른 사건 ${i}`, pressure: `장애 ${i}`, turn: `선택 ${i}`, carry: `다음 결과 ${i}` })) };

test('review choices patch only supplied fields, survive other settings and reject invalid input without writes', async t => {
  const store = await fixture(t);
  await runConfigureStatus({ store, workId, planningReviews: { episode: false }, arcReview: { everyEpisodes: 0 }, tracking: { hooks: false } });
  await runConfigureStatus({ store, workId, planningReviews: { story: false }, arcReview: { atEnd: false }, disabledReviews: ['arc-review'] });
  const result = await runConfigureStatus({ store, workId });
  assert.deepEqual(result.reviewPolicy.planning, { story: false, arc: true, episode: false });
  assert.deepEqual(result.reviewPolicy.arcReview, { everyEpisodes: 0, atEnd: false });
  assert.equal(result.tracking.enabled.hooks, false);
  const before = await store.loadReviewPolicy(workId);
  assert.equal(result.reviewPolicy.revision, 2);
  assert.equal(before.reviewHistory.length, 2);
  assert.equal(before.reviewHistory[1].before.planningReviews.episode, false);
  assert.equal(before.reviewHistory[1].after.planningReviews.story, false);
  await runConfigureStatus({ store, workId, tracking: { hooks: false } });
  assert.equal((await store.loadReviewPolicy(workId)).reviewRevision, 2);
  const stable = await store.loadReviewPolicy(workId);
  for (const args of [{ planningReviews: { continuity: false } }, { planningReviews: { episode: 0 } },
    { arcReview: { everyEpisodes: -1 } }, { arcReview: { everyEpisodes: 2.5 } }, { arcReview: { atEnd: 1 } }]) {
    await assert.rejects(saveWriterSupportPolicy(store, workId, args), /INVALID_/);
    assert.deepEqual(await store.loadReviewPolicy(workId), stable);
  }
  const noPolicy = { loadReviewPolicy: async () => null };
  assert.deepEqual(await loadPlanningReviews(noPolicy, workId), { story: true, arc: true, episode: true });
  assert.deepEqual(await loadArcReviewSchedule(noPolicy, workId), { everyEpisodes: 5, atEnd: true });
});

for (const stage of ['story', 'arc', 'episode']) test(`${stage} disabled: actual tool omits both semantic and score reviews but retains approval checks`, async t => {
  const store = await fixture(t), requests = [];
  const profile = await store.loadStoryProfile(workId); await store.saveStoryProfile(workId, { ...profile, discovery });
  await runConfigureStatus({ store, workId, planningReviews: { [stage]: false } });
  const raw = stage === 'story' ? story : stage === 'arc' ? arc : { ...await store.loadEpisodePlan(workId, 1), title: '문을 열기' };
  const generator = stage === 'story' ? 'story-spine' : stage === 'arc' ? 'arc-plan' : 'episode-plan';
  const run = stage === 'story' ? runStorySpine : stage === 'arc' ? runArcPlan : runEpisodePlan;
  const result = await run({ store, workId, mode: 'review', chapter: 1, episodes: 3, replaceActive: true,
    providers: { pending: [], async complete(req) {
      requests.push(req); const reply = approvalResponse(req);
      if (reply) return reply;
      assert.equal(req.step, generator); return { text: JSON.stringify(raw) };
    } } });
  const plan = result.spine ?? result.plan;
  assert.equal(result.needsApproval, true, JSON.stringify(result));
  assert.equal(plan.stageReview.verdict, 'disabled_by_user');
  if (stage !== 'episode') assert.equal(plan.quality.verdict, 'disabled_by_user');
  assert.ok(!requests.some(req => req.step.endsWith('-review') || req.step.endsWith('-quality')));
});

test('disabling story review never bypasses deterministic plan structure checks', async t => {
  const store = await fixture(t);
  await runConfigureStatus({ store, workId, planningReviews: { story: false } });
  await assert.rejects(runStorySpine({ store, workId, providers: { async complete() { return { text: '{}' }; } } }), /구조 검증/);
});

test('explicit opt-in enables semantic review on legacy profiles without discovery metadata', async t => {
  const store = await fixture(t), requests = [];
  await runConfigureStatus({ store, workId, planningReviews: { episode: true } });
  const raw = { ...await store.loadEpisodePlan(workId, 1), title: '문을 열기' };
  const result = await runEpisodePlan({ store, workId, chapter: 1, mode: 'review', providers: { async complete(req) {
    requests.push(req);
    return approvalResponse(req) ?? { text: JSON.stringify(req.step === 'episode-plan' ? raw : {
      checks: STAGE_REVIEW_FOCUS.episode.map(focus => ({ focus, result: 'met', evidence: '문을 연다.' })), findings: [],
    }) };
  } } });
  assert.ok(result.plan, JSON.stringify(result));
  assert.equal(result.plan.stageReview.verdict, 'reviewed');
  const input = JSON.parse(requests.find(req => req.step === 'episode-plan-review').messages[1].content);
  assert.equal(input.context.storySpine.causalChain[0], '문을 연다');
  assert.match(requests.find(req => req.step === 'episode-plan').messages[1].content, /함께 논다/);
  assert.equal(input.preference, null);
});

test('arc cadence is read from saved policy, with independent intermediate and ending choices', async t => {
  const store = await fixture(t);
  const plan = { estimatedEpisodes: 6, episodes: [1, 2, 3, 4, 5, 6].map(i => ({ index: i, chapter: i })) };
  assert.equal(arcReviewCheckpoint(plan, 6, { everyEpisodes: 2, atEnd: false }), null);
  assert.equal(arcReviewCheckpoint(plan, 4, { everyEpisodes: 2, atEnd: false }), 'checkpoint');
  assert.equal(arcReviewCheckpoint(plan, 4, { everyEpisodes: 0, atEnd: true }), null);
  await runConfigureStatus({ store, workId, arcReview: { everyEpisodes: 0, atEnd: false } });
  assert.equal(await runArcReview({ store, workId, arcPlan: plan, chapter: 6, providers: { complete() { throw Error('not scheduled'); } } }), null);
});

test('disabled cumulative arc review is audited without blocking integrated auto publication', async t => {
  const store = await fixture(t), steps = [];
  await runConfigureStatus({ store, workId, disabledReviews: ['arc-review'] });
  const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: { async complete(req) {
    steps.push(req.step); return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' };
  } } });
  assert.equal(result.status, 'completed'); assert.ok(!steps.includes('arc-review'));
  const workflow = await store.loadWorkflow(workId);
  assert.ok(workflow.quality.review.records.some(record => record.step === 'arc-review' && record.status === 'disabled_by_user'));
});

test('manual arc review respects a disabled PatternLedger and automatic schedule does not block explicit review', async () => {
  let patternsWritten = false, reviewSaved;
  const store = {
    loadReviewPolicy: async () => ({ disabled: ['pattern-ledger', 'arc-review'], arcReview: { everyEpisodes: 0, atEnd: false } }),
    loadArcPlan: async () => ({ arcNumber: 1, estimatedEpisodes: 3, episodes: [1, 2, 3].map(i => ({ index: i, chapter: i })) }),
    listChapters: async () => [1, 2, 3], loadArtifact: async () => ({ prose: '실제 원고' }),
    loadRecentChapterSummaries: async () => [], loadPatternLedger: async () => [],
    savePatternLedger: async () => { patternsWritten = true; }, saveArcReview: async (_w, value) => { reviewSaved = value; },
  };
  const result = await runStoredArcReview({ store, workId, throughChapter: 3, providers: { async complete(req) {
    assert.equal(req.step, 'arc-review'); return { text: outputs['arc-review'] };
  } } });
  assert.equal(result.review.checkpoint, 'final'); assert.ok(reviewSaved);
  assert.deepEqual(result.patterns, []);
  // There must be no ledger rewrite when the user disabled its model review.
  assert.equal(patternsWritten, false);
});
