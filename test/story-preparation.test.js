import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { resolveDiscoveryPreference } from '../src/core/discovery-preference.js';
import { reviewPlanningStage, STAGE_REVIEW_FOCUS } from '../src/core/planning-stage-review.js';
import { projectApprovalValue } from '../src/core/approval-language-gate.js';
import { promptKit } from '../src/prompts/index.js';
import { runStoryProfile, runStoryProfileDecide } from '../src/tools/story-profile.js';
import { runEpisodePlan } from '../src/tools/episode-plan.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';
import { runStorySpine } from '../src/tools/story-spine.js';
import { runArcPlan } from '../src/tools/arc.js';
import { runRelayedTool } from '../src/relay-runner.js';
import { createPreflightRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';
import { qualityStore, workId } from './fixtures/quality-workflow.js';
import { approvalResponse } from './fixtures/approval-response.js';

async function newStore(t) {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'preparation-')));
  t.after(() => rm(store.rootDir, { recursive: true, force: true })); return store;
}
const profileProvider = obj => ({ pending: [], async complete(req) { return approvalResponse(req) ?? { text: JSON.stringify(obj) }; } });
const preference = { depth: 'deep', focus: ['인물과 관계'], authority: 'user', userAnswer: '인물은 자세히, 세계는 쓰면서 알아가요.' };
const review = (stage, findings = []) => ({ checks: STAGE_REVIEW_FOCUS[stage].map(focus => ({ focus, result: 'met', evidence: '인물의 선택이 이번 사건을 바꾼다.' })), findings });
const repair = { id: 'promise', evidence: '원래 목표가 없어졌다.', reason: '확정한 목표와 다르다.', action: 'repair', contractEvidence: '문을 열고 함께 논다.', revision: '원래 목표를 이번 선택과 결과로 되살린다.' };

test('one initial collaboration-depth question precedes world, character and readability questions', async t => {
  const store = await newStore(t);
  const out = await runStoryProfile({ store, workId: 'book', brief: '항구 가족 이야기', providers: profileProvider({
    discovery: { depth: 'deep', userAnswer: 'a fabricated preference' },
    designReview: { openQuestions: [{ id: 'family', question: '인물 관계는?' }, { id: 'worldbuilding-scope', question: '세계 크기는?' }] },
  }) });
  assert.equal(out.needsDiscovery, true);
  assert.deepEqual(out.profile.designReview.openQuestions.map(q => q.id), ['discovery-depth']);
  assert.deepEqual(out.profile.designReview.askedQuestionIds, ['discovery-depth']);
  await assert.rejects(runStoryProfileDecide({ store, workId: 'book', action: 'approve' }), /DISCOVERY_PREFERENCE_REQUIRED/);
});

test('free answers control all preparation areas independently of world extent and reading difficulty', async t => {
  const store = await newStore(t);
  const out = await runStoryProfile({ store, workId: 'book', brief: preference.userAnswer,
    providers: profileProvider({ discovery: { depth: preference.depth, focus: preference.focus, userAnswer: preference.userAnswer } }) });
  assert.deepEqual(out.profile.discovery, preference);
  assert.equal(out.profile.worldbuilding.scope, 'starter');
  assert.equal(out.profile.readabilityContract.confirmedByUser, false);
  assert.ok(!out.profile.designReview.openQuestions.some(q => q.id === 'discovery-depth'));
  const quick = await runStoryProfile({ store: await newStore(t), workId: 'large', brief: '질문은 최소로, 여러 작품에 쓸 세계는 크게.',
    discovery: { depth: 'quick', userAnswer: '질문은 최소로' }, worldbuilding: { scope: 'universe', userAnswer: '여러 작품에 쓸 세계는 크게.' },
    providers: profileProvider({ designReview: { openQuestions: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, question: `중요한 선택 ${i}` })) } }) });
  assert.equal(quick.profile.worldbuilding.scope, 'universe');
  assert.equal(quick.profile.discovery.depth, 'quick');
  assert.equal(quick.profile.designReview.openQuestions.length, 3);
  assert.ok(quick.profile.designReview.openQuestions.some(q => q.id === 'reading-experience-contract'));
  assert.deepEqual(quick.profile.designReview.askedQuestionIds, quick.profile.designReview.openQuestions.map(q => q.id));
});

test('latest depth and focus changes persist, without old quotations silently restoring them', () => {
  const latest = resolveDiscoveryPreference({ existing: preference, requested: { depth: 'quick', focus: [], userAnswer: '이제 그만 묻고 시작해요.' },
    source: `${preference.userAnswer}\n이제 그만 묻고 시작해요.`, changeSource: '이제 그만 묻고 시작해요.', mode: 'review' });
  assert.equal(latest.depth, 'quick');
  assert.deepEqual(resolveDiscoveryPreference({ existing: latest, proposed: preference, source: preference.userAnswer, changeSource: '장면부터 써요.', mode: 'review' }), latest);
  assert.throws(() => resolveDiscoveryPreference({ existing: latest, requested: preference, source: preference.userAnswer, changeSource: '장면부터 써요.', mode: 'review' }), { code: 'INVALID_DISCOVERY_PREFERENCE' });
  assert.equal(resolveDiscoveryPreference({ source: '알아서 해줘', mode: 'auto' }).authority, 'delegated');
  assert.deepEqual(resolveDiscoveryPreference({ existing: preference, source: '알아서 이어서 해줘', mode: 'auto' }), preference);
});

test('changing only preparation preferences keeps approved fiction active and never regenerates it', async t => {
  const store = await newStore(t);
  await runStoryProfile({ store, workId: 'book', brief: '가족 이야기. 인물은 자세히, 세계는 쓰면서 알아가요.',
    discovery: { depth: preference.depth, focus: preference.focus, userAnswer: preference.userAnswer }, providers: profileProvider({ genreLabel: '가족 이야기' }) });
  await runStoryProfileDecide({ store, workId: 'book', action: 'approve' });
  const before = await store.loadStoryProfile('book'), requests = [];
  const out = await runStoryProfile({ store, workId: 'book', action: 'preferences', feedback: '이제 그만 묻고 시작해요.',
    discovery: { depth: 'quick', userAnswer: '이제 그만 묻고 시작해요.' },
    providers: { pending: [], async complete(req) { requests.push(req); const reply = approvalResponse(req); assert.ok(reply, 'only existing fiction language validation is allowed'); return reply; } } });
  assert.equal(out.preferenceUpdated, true); assert.equal(out.profile.status, 'active');
  assert.equal(out.profile.discovery.depth, 'quick');
  const fictional = ({ discovery, revision, updatedAt, ...rest }) => rest;
  assert.deepEqual(fictional(out.profile), fictional(before));
  assert.ok(!requests.some(r => r.step === 'story-profile'));
});

test('preference-only changes preserve every legacy story field without filling new defaults', async t => {
  const store = await newStore(t);
  const old = { workId: 'book', status: 'active', revision: 2, genreLabel: '오래된 가족 이야기',
    format: { chapterChars: 2400 }, customNotes: { original: '그대로 둔다' } };
  await store.saveStoryProfile('book', old);
  const out = await runStoryProfile({ store, workId: 'book', action: 'preferences', feedback: preference.userAnswer,
    discovery: { depth: preference.depth, focus: preference.focus, userAnswer: preference.userAnswer },
    providers: { complete() { throw Error('legacy metadata change needs no generated fiction'); } } });
  const { discovery, revision, updatedAt, ...fiction } = out.profile;
  const { revision: priorRevision, ...priorFiction } = old;
  assert.deepEqual(fiction, priorFiction); assert.equal(revision, priorRevision + 1);
});

test('discovery provenance and review records stay hash-bound across languages', () => {
  const projected = projectApprovalValue({ discovery: preference, stageReview: { findings: ['English reviewer notes'] } }, [], { promptFamily: 'multilingual' });
  assert.deepEqual(projected.discovery.focus, { id: preference.focus });
  assert.match(projected.stageReview.id, /^[0-9a-f]{64}$/);
  assert.notDeepEqual(projected, projectApprovalValue({ discovery: { ...preference, depth: 'quick' }, stageReview: { findings: ['English reviewer notes'] } }, [], { promptFamily: 'multilingual' }));
});

for (const stage of ['story', 'arc', 'episode']) test(`${stage}: review → grounded revision → review the replacement, keeping opportunities advisory`, async () => {
  const requests = [], candidate = { title: '원래 제목', goal: '잊은 목표' };
  const providers = { pending: [], async complete(req) {
    requests.push(req); const input = JSON.parse(req.messages[1].content);
    if (req.step.endsWith('-revision')) return { text: JSON.stringify({ ...input.candidate, goal: '문을 열고 함께 논다.' }) };
    return { text: JSON.stringify(review(stage, input.candidate.goal === candidate.goal ? [repair] : [
      { id: 'enrich', action: 'advisory', evidence: '좋은 대화가 있다.', reason: '관계를 더 살릴 수도 있다.' },
    ])) };
  } };
  const out = await reviewPlanningStage({ stage, profile: { revision: 2, discovery: preference }, candidate,
    context: { promise: repair.contractEvidence }, providers, kit: promptKit({ language: 'ko' }), rebuild: value => value });
  assert.equal(out.ok, true); assert.equal(out.candidate.goal, repair.contractEvidence);
  assert.deepEqual(requests.map(r => r.step), [`${stage}-plan-review`, `${stage}-plan-revision`, `${stage}-plan-review`]);
  assert.equal(out.stageReview.attempts.length, 2);
  assert.notEqual(out.stageReview.attempts[0].candidateHash, out.stageReview.attempts[1].candidateHash);
  assert.equal(out.stageReview.attempts[1].findings[0].action, 'advisory');
  assert.equal(out.stageReview.independence, 'not-established');
});

test('unfixed required findings stop after the bounded retry; invented requirement quotes are refused', async () => {
  const calls = [];
  const args = { stage: 'story', profile: { discovery: preference }, candidate: { goal: '다른 목표' }, context: { promise: repair.contractEvidence },
    kit: promptKit({ language: 'ko' }), rebuild: value => value };
  const out = await reviewPlanningStage({ ...args, providers: { pending: [], async complete(req) {
    calls.push(req.step); return { text: JSON.stringify(req.step.endsWith('-revision') ? args.candidate : review('story', [repair])) };
  } } });
  assert.equal(out.code, 'PLANNING_REVISION_REQUIRED'); assert.equal(calls.length, 3);
  await assert.rejects(reviewPlanningStage({ ...args, providers: { async complete() {
    return { text: JSON.stringify(review('story', [{ ...repair, contractEvidence: '사용자가 말하지 않은 요구' }])) };
  } } }), { code: 'INVALID_PLANNING_REVIEW' });
});

test('upstream changes and missing research stop lower-stage rewriting; legacy paths remain unchanged', async () => {
  for (const action of ['upstream', 'research']) {
    let calls = 0;
    const out = await reviewPlanningStage({ stage: 'arc', profile: { discovery: preference }, candidate: { title: '보존' }, context: { fact: '상위 근거가 필요하다.' },
      providers: { async complete(req) { calls++; return { text: JSON.stringify(req.step.endsWith('escalation-review')
        ? { findings: [{ id: action, action, reason: '하위에서 해결할 수 없다.', contractEvidence: '상위 근거가 필요하다.', candidateEvidence: '보존' }] }
        : review('arc', [{ id: action, action, evidence: '상위 근거가 필요하다.', reason: '하위에서 해결할 수 없다.' }])) }; } },
      kit: promptKit({ language: 'ko' }), rebuild() { throw Error('must not revise'); } });
    assert.equal(out.code, 'PLANNING_UPSTREAM_REQUIRED'); assert.equal(calls, 2);
  }
  const candidate = { title: 'old' };
  assert.deepEqual(await reviewPlanningStage({ profile: {}, candidate }), { ok: true, candidate });
});

test('episode review blocks integrated drafting and preserves the previously accepted plan', async t => {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  const profile = await store.loadStoryProfile(workId);
  await store.saveStoryProfile(workId, { ...profile, discovery: preference });
  const original = await store.loadEpisodePlan(workId, 1);
  const plan = { ...original, status: 'pending', title: '실제 후보' };
  await store.saveEpisodePlan(workId, plan);
  const requests = [];
  const out = await runWriteWorkflow({ store, workId, providers: { pending: [], async complete(req) {
    requests.push(req);
    if (req.step === 'episode-plan') return { text: JSON.stringify(plan) };
    if (req.step === 'episode-plan-review') return { text: JSON.stringify(review('episode', [{ id: 'history', action: 'research', evidence: '입장 규칙 근거가 없다.', reason: '규칙을 확인해야 한다.' }])) };
    if (req.step === 'episode-plan-escalation-review') return { text: JSON.stringify({ findings: [{ id: 'history', action: 'research', reason: '요청된 입장 규칙을 확인해야 한다.',
      contractEvidence: '놀이를 실제로 즐기는 약속', candidateEvidence: plan.premise }] }) };
    throw Error(`unexpected ${req.step}`);
  } } });
  assert.equal(out.status, 'needs_revision'); assert.equal(out.code, 'PLANNING_UPSTREAM_REQUIRED');
  assert.deepEqual(await store.loadEpisodePlan(workId, 1), plan);
  assert.ok(!requests.some(r => r.step === 'draft'));
  const input = JSON.parse(requests.find(r => r.step === 'episode-plan-review').messages[1].content);
  assert.equal(input.context.profile.discovery.depth, 'deep');
  assert.equal(input.context.arcBeat.chapter, 1);
});

test('accepted episode plan records the actual reviewed candidate and keeps a good plan unchanged', async t => {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  const profile = await store.loadStoryProfile(workId); await store.saveStoryProfile(workId, { ...profile, discovery: preference });
  const raw = { ...await store.loadEpisodePlan(workId, 1), title: '문을 열기' };
  const requests = [];
  const out = await runEpisodePlan({ store, workId, chapter: 1, mode: 'review', providers: { pending: [], async complete(req) {
    requests.push(req); return approvalResponse(req) ?? { text: JSON.stringify(req.step === 'episode-plan' ? raw : review('episode')) };
  } } });
  assert.equal(out.needsApproval, true); assert.equal(out.plan.stageReview.verdict, 'reviewed');
  assert.equal(out.plan.title, raw.title); assert.equal(out.plan.stageReview.attempts.length, 1);
  assert.ok(!requests.some(r => r.step.endsWith('-revision')));
  assert.deepEqual((await store.loadEpisodePlan(workId, 1)).stageReview, out.plan.stageReview);
});

test('story and arc tools review actual normalized plans before accepting them', async t => {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  const profile = await store.loadStoryProfile(workId); await store.saveStoryProfile(workId, { ...profile, discovery: preference });
  const spine = { dramaticQuestion: '함께 놀 수 있는가?', protagonistWant: '함께 논다', protagonistNeed: '협력', falseBelief: '혼자면 충분',
    incitingDisruption: '문이 잠김', initialStrategy: '혼자 민다', causalChain: ['문을 민다', '안 열린다', '도움을 묻는다', '함께 연다', '함께 논다'],
    midpointReframe: '도움이 필요하다', finalChoice: '도움을 청한다', endingChange: '협력', endingCost: '시간',
    characterForces: [{ characterId: 'hero', want: '입장', actionThatChangesPlot: '문을 민다' }, { characterId: 'gate', want: '규칙 보존', actionThatChangesPlot: '문을 잠근다' }] };
  const arc = { title: '문 안', promise: '같이 논다', episodes: [1, 2, 3].map(i => ({ title: `놀이 ${i}`, beat: `다른 사건 ${i}`, pressure: `장애 ${i}`, turn: `선택 ${i}`, carry: `다음 결과 ${i}` })) };
  for (const [stage, run, args, output, generation, qualityStep, dimensions] of [
    ['story', runStorySpine, {}, spine, 'story-spine', 'story-spine-quality', ['causalNecessity', 'protagonistError', 'expectationReframe', 'characterAgency', 'finalChoiceCost', 'endingTransformation']],
    ['arc', runArcPlan, { episodes: 3, replaceActive: true }, arc, 'arc-plan', 'arc-quality', ['premisePressure', 'causalEscalation', 'expectationRenewal', 'characterAgency', 'oppositionAdaptation', 'payoffSurprise', 'serialMomentum']],
  ]) {
    const requests = [];
    const out = await run({ store, workId, ...args, mode: 'review', providers: { pending: [], async complete(req) {
      requests.push(req);
      return approvalResponse(req) ?? { text: JSON.stringify(req.step === generation ? output : req.step === qualityStep
        ? { dimensions: Object.fromEntries(dimensions.map(d => [d, 80])), findings: [] } : review(stage)) };
    } } });
    const candidate = out.spine ?? out.plan;
    assert.equal(out.needsApproval, true); assert.equal(candidate.stageReview.stage, stage);
    const input = JSON.parse(requests.find(r => r.step === `${stage}-plan-review`).messages[1].content);
    assert.equal(input.context.profile.discovery.depth, 'deep');
    assert.equal(input.candidate[stage === 'story' ? 'dramaticQuestion' : 'promise'], output[stage === 'story' ? 'dramaticQuestion' : 'promise']);
    if (stage === 'story') await store.saveStorySpine(workId, { ...candidate, status: 'active' });
  }
});

for (const needsRepair of [false, true]) test(`relayed episode creation${needsRepair ? ', revision and re-review' : ''} completes without timestamps invalidating answers`, async t => {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  const profile = await store.loadStoryProfile(workId); await store.saveStoryProfile(workId, { ...profile, discovery: preference });
  const raw = { ...await store.loadEpisodePlan(workId, 1), title: '문을 열기' };
  const args = { workId, chapter: 1, mode: 'review' }, observed = [];
  let result = null;
  for (let round = 0; round < 8; round++) {
    const run = result?.runId ? await loadRun(store.rootDir, result.runId) : null;
    const answers = { ...(run?.answers ?? {}) };
    for (const request of result?.requests ?? []) {
      observed.push(request.step);
      if (request.step === 'episode-plan') answers[request.id] = JSON.stringify(raw);
      else if (request.step === 'episode-plan-review') {
        const input = JSON.parse(request.user);
        answers[request.id] = JSON.stringify(review('episode', needsRepair && !input.candidate.premise.startsWith('수정됨')
          ? [{ ...repair, contractEvidence: '문을 연다' }] : []));
      } else if (request.step === 'episode-plan-revision') {
        const input = JSON.parse(request.user);
        answers[request.id] = JSON.stringify({ ...input.candidate, premise: '수정됨: 배운 지도로 문을 연다.' });
      }
      else if (request.step === 'approval-language-contract') {
        const input = JSON.parse(request.user);
        answers[request.id] = JSON.stringify({ language: input.language, artifactHash: input.artifactHash, verdict: 'pass', evidence: [], allowedExceptions: [] });
      }
      else throw Error(`unexpected ${request.step}`);
    }
    result = await runRelayedTool({ store, toolName: 'lore_episode_plan', args, run, answers,
      executeTool: (store, _name, args, providers) => runEpisodePlan({ store, ...args, providers }),
      providerForTool: (_name, accumulated) => createPreflightRelay(accumulated) });
    if (result.plan) break;
  }
  assert.ok(result.plan, JSON.stringify(result));
  assert.deepEqual(observed, needsRepair ? ['episode-plan', 'episode-plan-review', 'episode-plan-revision', 'episode-plan-review', 'approval-language-contract']
    : ['episode-plan', 'episode-plan-review', 'approval-language-contract']);
  assert.equal(result.plan.stageReview.verdict, 'reviewed');
});
