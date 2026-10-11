import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { reviewPlanningStage, STAGE_REVIEW_FOCUS, planningAuthority } from '../src/core/planning-stage-review.js';
import { validateGeneratedFoundation } from '../src/core/foundation-language-repair.js';
import { captureWorkingTreeFingerprint, detectWorkingTreeDrift } from '../src/core/working-tree-sync.js';
import { runStoryProfile } from '../src/tools/story-profile.js';
import { buildLanguageContract } from '../engine/src/core/language-policy.js';
import { promptKit } from '../src/prompts/index.js';
import { approvalResponse } from './fixtures/approval-response.js';
import { sharedSaga } from './fixtures/shared-lore.js';
import { runRelayedTool } from '../src/relay-runner.js';
import { createPreflightRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';

const workId = 'recovery';
const profile = { discovery: { depth: 'deep', authority: 'user' } };
const review = (stage, findings) => ({ checks: STAGE_REVIEW_FOCUS[stage].map(focus => ({ focus, result: 'met', evidence: '실제 후보를 대조했다.' })), findings });
const kit = promptKit({ language: 'ko' });
async function storeFor(t) {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'world-recovery-')));
  t.after(() => rm(store.rootDir, { recursive: true, force: true })); return store;
}

test('generated micro-rules cannot block, but the author can explicitly request the same rule', async () => {
  const rule = '한 장면에 개념을 하나만 넣는다.';
  assert.equal(JSON.stringify(planningAuthority({ profile: { promptGuidance: { draft: [rule] }, sourceBrief: '쉽게 읽고 싶다.' } })).includes(rule), false);
  const requests = [];
  const out = await reviewPlanningStage({ stage: 'story', profile, candidate: { title: '수확' },
    context: { profile: { promptGuidance: { draft: [rule] }, sourceBrief: '쉽게 읽고 싶다.' } }, kit, rebuild: x => x,
    providers: { async complete(req) {
      requests.push(req.step);
      return { text: JSON.stringify(review('story', req.step.endsWith('response-repair')
        ? [{ id: 'style', action: 'advisory', evidence: '두 생물이 나온다.', reason: '읽기 제안이다.' }]
        : [{ id: 'style', action: 'repair', evidence: '두 생물이 나온다.', reason: '개념 수', contractEvidence: rule, revision: '하나를 뺀다.' }])) };
    } } });
  assert.equal(out.ok, true); assert.equal(out.stageReview.attempts[0].findings[0].action, 'advisory');
  assert.deepEqual(requests, ['story-plan-review', 'story-plan-review-response-repair']);
  assert.equal(out.stageReview.attempts[0].responseRepairs.length, 1);
  assert.ok(JSON.stringify(planningAuthority({ direction: rule })).includes(rule));
});

test('stitched source quotations are re-requested once, never silently accepted', async () => {
  const finding = { id: 'blood', action: 'repair', evidence: '마법이 없다고 썼다.', reason: '확정 사실 충돌', revision: '원래 사실을 보존한다.' };
  let revision = false; const calls = [];
  const out = await reviewPlanningStage({ stage: 'story', profile, candidate: { title: '원본' }, context: { fact: '거신의 피에는 마법이 있다.', other: '제국은 그 공급에 의존한다.' }, kit, rebuild: x => x,
    providers: { async complete(req) {
      calls.push(req.step);
      if (req.step === 'story-plan-revision') { revision = true; return { text: '{"title":"수정"}' }; }
      return { text: JSON.stringify(review('story', revision ? [] : [{ ...finding, contractEvidence: req.step.endsWith('response-repair')
        ? '거신의 피에는 마법이 있다.' : '거신의 피에는 마법이 있다. / 제국은 그 공급에 의존한다.' }])) };
    } } });
  assert.equal(out.ok, true); assert.equal(out.candidate.title, '수정');
  assert.deepEqual(calls, ['story-plan-review', 'story-plan-review-response-repair', 'story-plan-revision', 'story-plan-review']);
});

for (const actualConflict of [false, true]) test(`escalation audit distinguishes temporal ambiguity from actual knowledge conflict (${actualConflict})`, async () => {
  const candidate = { ending: actualConflict ? '로가는 실제로 열한 자루를 실었다.' : '2화 고백, 3화 동행 제안.' };
  const context = { fact: actualConflict ? '로가는 실제로 열두 자루를 실었다.' : '로가는 고백한 뒤 동행을 제안한다.' };
  const steps = [];
  const out = await reviewPlanningStage({ stage: 'arc', profile, candidate, context, kit, rebuild() { throw Error('do not rewrite'); },
    providers: { async complete(req) {
      steps.push(req.step);
      if (req.step === 'arc-plan-escalation-review') return { text: JSON.stringify({ findings: [{ id: 'timing', action: actualConflict ? 'upstream' : 'advisory',
        reason: actualConflict ? '실수량이 모순된다.' : '뒤는 같은 회차를 강제하지 않는다.', contractEvidence: context.fact, candidateEvidence: candidate.ending }] }) };
      return { text: JSON.stringify(review('arc', [{ id: 'timing', action: 'upstream', evidence: candidate.ending, reason: '상위 변경 요청' }])) };
    } } });
  assert.deepEqual(steps, ['arc-plan-review', 'arc-plan-escalation-review']);
  assert.equal(out.ok, !actualConflict);
  if (actualConflict) assert.equal(out.code, 'PLANNING_UPSTREAM_REQUIRED');
  else assert.equal(out.stageReview.attempts[0].findings[0].originalAction, 'upstream');
});

test('system plan saves update only their document; hand edits and source HEAD remain protected', async t => {
  const store = await storeFor(t);
  await store.saveFoundation({ workId, genre: 'other', worldFacts: [{ id: 'w1', statement: '두 개의 달' }], characters: [] });
  await captureWorkingTreeFingerprint({ store, sourceHead: 'pinned-head' });
  await store.saveStorySpine(workId, { status: 'pending', dramaticQuestion: '수확은 어디에?' });
  await store.saveWriterSkill(workId, { status: 'active', aestheticThesis: '행동을 본다.' });
  assert.equal((await detectWorkingTreeDrift({ store, sourceHead: 'pinned-head' })).status, 'clean');
  await writeFile(store.settingPath, (await readFile(store.settingPath, 'utf8')).replace('두 개의 달', '세 개의 달'));
  await store.saveStorySpine(workId, { status: 'active', dramaticQuestion: '수확은 어디에?' });
  assert.deepEqual((await detectWorkingTreeDrift({ store, sourceHead: 'pinned-head' })).changed, ['world/setting.md']);
  const previous = await store.loadStorySpine(workId);
  await writeFile(store.storySpinePath, '작가가 새로 작성한 계획');
  await assert.rejects(store.saveStorySpine(workId, { dramaticQuestion: '덮어쓸 내용' }), { code: 'WORKING_TREE_DRIFT' });
  assert.equal(await readFile(store.storySpinePath, 'utf8'), '작가가 새로 작성한 계획');
  assert.deepEqual(await store.loadStorySpine(workId), previous);
});

test('initial character knowledge is readable, editable and preserved in legacy documents', async t => {
  const store = await storeFor(t);
  await store.saveFoundation({ workId, genre: 'other', worldFacts: [], characters: [{ id: 'carrier', canonicalName: '로가', intrinsic: {}, mutable: { knownFacts: ['열두 자루를 실었다.'], status: 'alive' } }] });
  const path = store.characterPath('carrier'); const original = await readFile(path, 'utf8');
  assert.match(original, /## 인물 시작 상태/);
  await writeFile(path, original.replace('열두 자루를 실었다.', '열한 자루를 실었다.'));
  assert.deepEqual((await store.loadFoundation(workId)).characters[0].mutable.knownFacts, ['열한 자루를 실었다.']);
  await writeFile(path, original.replace(/## 인물 시작 상태[\s\S]*$/, ''));
  assert.deepEqual((await store.loadFoundation(workId)).characters[0].mutable.knownFacts, ['열두 자루를 실었다.']);
});

test('interview receives the pinned selected world, preserves it in next rounds, and excludes author-only sources', async t => {
  const world = await sharedSaga(); t.after(() => rm(world.root, { recursive: true, force: true }));
  const store = await storeFor(t); const requests = [];
  const source = { worldRoot: world.root, universeId: 'u1', loreRevisionId: world.head, documentIds: ['world-doc'] };
  const providers = { async complete(req) { requests.push(req); return approvalResponse(req) ?? { text: '{"genreLabel":"농업 수사"}' }; } };
  const first = await runStoryProfile({ store, workId, brief: '알아서 준비', worldbuildingSource: source, providers });
  await runStoryProfile({ store, workId, brief: '다음 답변', providers });
  assert.equal(first.profile.worldbuilding.source.loreRevisionId, world.head);
  for (const req of requests.filter(r => r.step === 'story-profile')) {
    assert.match(req.messages[1].content, /두 개의 달/); assert.doesNotMatch(req.messages[1].content, /FUTURE_SECRET_TOKEN/);
  }
  const count = requests.length;
  await assert.rejects(runStoryProfile({ store, workId, brief: '수사', worldbuildingSource: { ...source, documentIds: ['secret-doc'] }, providers }), { code: 'INVALID_WORLDBUILDING_SOURCE' });
  assert.equal(requests.length, count);
});

test('foundation repair changes only cited prose, audits meaning, then checks a new artifact', async t => {
  const store = await storeFor(t); const requests = [];
  const value = { worldFacts: [], characters: [], seededEntities: [{ entityId: 'cat', canonicalName: '드로카 고양이', attrs: { species: 'drokha-cat' } }] };
  const providers = { async complete(req) {
    requests.push(req); const input = JSON.parse(req.messages[1].content);
    if (req.step === 'foundation-language-repair') return { text: JSON.stringify({ patches: input.fields.map(f => ({ ...f, after: '드로카 고양이' })) }) };
    if (req.step === 'foundation-language-repair-review') return { text: JSON.stringify({ meaningPreserved: true, evidence: input.patches.map(p => ({ ...p, reason: '같은 생물을 한국어로 표기했다.' })) }) };
    const bad = JSON.stringify(input.artifact).includes('drokha-cat');
    return { text: JSON.stringify({ languageCompliance: { language: 'ko', artifactHash: input.artifactHash, verdict: bad ? 'fail' : 'pass', evidence: bad ? [{ fieldPath: 'value.seededEntities[0].attrs.entries[0].value.description', quote: 'drokha-cat', reason: '영어 종 설명이다.' }] : [], allowedExceptions: [] } }) };
  } };
  const out = await validateGeneratedFoundation({ store, workId, kind: 'foundation', value, providers, resolution: { language: 'ko', implicitLegacy: false, contract: buildLanguageContract({ language: 'ko' }) } });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.value.seededEntities[0].attrs.species, '드로카 고양이');
  assert.equal(out.value.seededEntities[0].entityId, 'cat'); assert.equal(value.seededEntities[0].attrs.species, 'drokha-cat');
  assert.deepEqual(requests.map(r => r.step), ['approval-language-contract', 'foundation-language-repair', 'foundation-language-repair-review', 'approval-language-contract']);
  const checks = requests.filter(r => r.step === 'approval-language-contract').map(r => JSON.parse(r.messages[1].content).artifactHash);
  assert.notEqual(checks[0], checks[1]);
});

const repairValue = () => ({ worldFacts: [], characters: [], seededEntities: [{ entityId: 'cat', canonicalName: '드로카 고양이', attrs: { species: 'drokha-cat' } }] });
const repairResolution = () => ({ language: 'ko', implicitLegacy: false, contract: buildLanguageContract({ language: 'ko' }) });
function repairAnswer(step, input) {
  if (step === 'foundation-language-repair') return { patches: input.fields.map(f => ({ ...f, after: '드로카 고양이' })) };
  if (step === 'foundation-language-repair-review') return { meaningPreserved: true, evidence: input.patches.map(p => ({ ...p, reason: '같은 생물을 번역했다.' })) };
  const bad = JSON.stringify(input.artifact).includes('drokha-cat');
  return { language: 'ko', artifactHash: input.artifactHash, verdict: bad ? 'fail' : 'pass', evidence: bad ? [{ fieldPath: 'value.seededEntities[0].attrs.entries[0].value.description', quote: 'drokha-cat', reason: '영어 종 설명이다.' }] : [], allowedExceptions: [] };
}

for (const failure of ['unauthorized_patch', 'meaning_change', 'second_language_failure']) test(`foundation recovery stops on ${failure} without modifying the original`, async t => {
  const store = await storeFor(t); const value = repairValue(); const steps = [];
  const providers = { async complete(req) {
    steps.push(req.step); const input = JSON.parse(req.messages[1].content);
    let answer = repairAnswer(req.step, input);
    if (failure === 'unauthorized_patch' && req.step === 'foundation-language-repair') answer = { patches: [{ path: 'seededEntities.0.entityId', before: 'cat', after: 'new-cat' }] };
    if (failure === 'meaning_change' && req.step === 'foundation-language-repair-review') answer = { meaningPreserved: false, evidence: [] };
    if (failure === 'second_language_failure' && req.step === 'approval-language-contract' && !JSON.stringify(input.artifact).includes('drokha-cat'))
      answer = { ...answer, verdict: 'fail', evidence: [{ fieldPath: 'value.seededEntities[0].attrs.entries[0].value.description', quote: '드로카 고양이', reason: '의미 비교와 별개의 검증 실패 fixture' }] };
    return { text: JSON.stringify(answer) };
  } };
  const out = await validateGeneratedFoundation({ store, workId, kind: 'foundation', value, resolution: repairResolution(), providers });
  assert.equal(out.ok, false); assert.equal(out.status, 'clean_fail');
  assert.equal(out.code, failure === 'second_language_failure' ? 'OUTPUT_LANGUAGE_MISMATCH' : 'APPROVAL_REPAIR_INVALID');
  assert.equal(value.seededEntities[0].entityId, 'cat'); assert.equal(value.seededEntities[0].attrs.species, 'drokha-cat');
  assert.equal(steps.filter(s => s === 'foundation-language-repair').length, 1);
  assert.equal(steps.length, failure === 'unauthorized_patch' ? 2 : failure === 'meaning_change' ? 3 : 4);
});

test('foundation repair converges across actual relay resumes and retains both original failure and new proof', async t => {
  const store = await storeFor(t); const value = repairValue(); const steps = []; let parked = null;
  const executeTool = (store, _name, _args, providers) => validateGeneratedFoundation({ store, workId, kind: 'foundation', value, resolution: repairResolution(), providers });
  for (let pass = 0; pass <= 4; pass++) {
    const run = parked?.runId ? await loadRun(store.rootDir, parked.runId) : null;
    const answers = { ...(run?.answers ?? {}) };
    for (const request of parked?.requests ?? []) answers[request.id] = JSON.stringify(repairAnswer(request.step, JSON.parse(request.user)));
    const args = run?.args ?? { workId };
    parked = await runRelayedTool({ store, toolName: 'lore_create', args, run, answers, executeTool,
      providerForTool: (_name, accumulated) => createPreflightRelay(accumulated) });
    if (pass < 4) {
      assert.equal(parked.status, 'needs_model', JSON.stringify(parked)); assert.equal(parked.requests.length, 1);
      steps.push(parked.requests[0].step);
    }
  }
  assert.equal(parked.ok, true, JSON.stringify(parked));
  assert.equal(parked.value.seededEntities[0].attrs.species, '드로카 고양이');
  assert.deepEqual(steps, ['approval-language-contract', 'foundation-language-repair', 'foundation-language-repair-review', 'approval-language-contract']);
  const original = await store.loadApprovalValidation(workId, 'foundation');
  const corrected = await store.loadApprovalValidation(workId, 'foundation-repaired');
  assert.equal(original.status, 'clean_fail'); assert.equal(original.attempt, 1); assert.equal(corrected.status, 'passed');
  assert.notEqual(original.artifactHash, corrected.artifactHash); assert.ok(corrected.repair);
});

test('a quote cannot bridge two unrelated authoritative fields, even with a newline', async () => {
  const steps = [];
  await assert.rejects(reviewPlanningStage({ stage: 'story', profile, candidate: { title: '수확' },
    context: { fact: '마법이 있다.', other: '제국이 있다.' }, kit, rebuild: x => x,
    providers: { async complete(req) { steps.push(req.step); return { text: JSON.stringify(review('story', [{ id: 'joined', action: 'repair', evidence: '단서', reason: '합친 인용', contractEvidence: '마법이 있다.\n제국이 있다.', revision: '수정' }])) }; } } }),
  { code: 'INVALID_PLANNING_REVIEW' });
  assert.deepEqual(steps, ['story-plan-review', 'story-plan-review-response-repair']);
});
