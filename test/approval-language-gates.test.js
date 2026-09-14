import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { buildLanguageContract } from '../engine/src/core/language-policy.js';
import { gateApprovalActivation, projectApprovalValue } from '../src/core/approval-language-gate.js';
import { runInit } from '../src/tools/init.js';
import { runStoryProfile, runStoryProfileDecide, runStoryProfileStatus } from '../src/tools/story-profile.js';
import { ensureStoryIdentity, ensurePilotContract } from '../src/tools/story-experience.js';

export const profileResponse = { genreLabel: 'Harbor drama', engineGenre: 'other', format: { pov: '3인칭제한', serialization: 'Serial' }, narrativeContract: { depthMode: 'commercial-dramatic' }, promptGuidance: {}, designReview: { settledDecisions: [], openQuestions: [] } };
export const newStore = async () => new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'approval-gate-')));
export function approvalProvider({ language = 'en', outputs = {}, answer = null } = {}) {
  const requests = [];
  return { requests, pending: [], async complete(request) {
    requests.push(request);
    if (request.step !== 'approval-language-contract') return { text: JSON.stringify(outputs[request.step] ?? profileResponse) };
    const input = JSON.parse(request.messages[1].content);
    return { text: answer ? answer(input) : JSON.stringify({ language, artifactHash: input.artifactHash, verdict: 'pass', evidence: [], allowedExceptions: [] }) };
  } };
}
const identity = { readerPromise: 'A harbor opens', protagonistAppeal: 'A practical keeper', emotionalDefect: 'Distrust', competenceSignature: ['Mending lamps'], comedyEngines: ['Misread orders'], solutionPatternsToRotate: ['Cooperation'] };
const resolution = language => ({ implicitLegacy: false, contract: buildLanguageContract({ language }) });

for (const language of ['ko', 'en', 'ja', 'ar']) test(`new ${language} init requires proof before either creation write`, async () => {
  const store = await newStore();
  const noProvider = await runInit({ store, workId: 'book', genre: 'other', language, worldFacts: ['A fact'] });
  assert.equal(noProvider.created, false);
  assert.equal(await store.loadAcceptedCreation('book'), null);
  assert.equal(await store.loadFoundation('book'), null);
  const ok = await runInit({ store, workId: 'book', genre: 'other', language, worldFacts: ['A fact'], providers: approvalProvider({ language }) });
  assert.equal(ok.adopted, false);
  assert.equal((await store.loadFoundation('book')).language, language);
  assert.ok(await store.loadAcceptedCreation('book'));
  const adopted = await runInit({ store, workId: 'book', language, providers: { complete() { throw Error('reading must not audit'); } } });
  assert.equal(adopted.adopted, true);
});

test('wrong language cannot activate profile or be approved later', async () => {
  const store = await newStore();
  const providers = approvalProvider({ language: 'ko' });
  const out = await runStoryProfile({ store, workId: 'book', language: 'en', brief: '한국어 사용자 브리프', mode: 'auto', providers });
  assert.equal(out.status, 'clean_fail');
  assert.equal(await store.loadStoryProfile('book'), null);
  assert.equal(providers.requests.filter(r => r.step === 'approval-language-contract').length, 3);
  await assert.rejects(runStoryProfileDecide({ store, workId: 'book', action: 'approve', providers }));
});

test('review profile consumes exact proof through approve with no new calls', async () => {
  const store = await newStore(); const providers = approvalProvider();
  const out = await runStoryProfile({ store, workId: 'book', language: 'en', brief: '사용자 입력은 보존한다', providers });
  assert.equal(out.profile.status, 'pending');
  const count = providers.requests.length;
  const approved = await runStoryProfileDecide({ store, workId: 'book', action: 'approve', providers });
  assert.equal(approved.approved, true);
  assert.equal(providers.requests.length, count);
  assert.equal(approved.profile.sourceBrief, '사용자 입력은 보존한다');
  assert.equal(approved.profile.format.pov, '3인칭제한');
  assert.equal((await runStoryProfileStatus({ store, workId: 'book' })).profile.status, 'active');
});

test('title/example/revision tamper blocks consume and cannot revive by reverting', async () => {
  const store = await newStore(); const providers = approvalProvider();
  const value = { ...identity, revision: 1, createdAt: 'first', status: 'pending' };
  const args = { store, workId: 'book', kind: 'story', stateKey: 'story-identity', value, resolution: resolution('en'), providers };
  assert.equal((await gateApprovalActivation(args)).ok, true);
  assert.equal((await gateApprovalActivation({ ...args, consumeOnly: true, value: { ...value, status: 'active', createdAt: 'later' } })).ok, true);
  assert.equal((await gateApprovalActivation({ ...args, consumeOnly: true, value: { ...value, readerPromise: 'Changed' } })).ok, false);
  assert.equal((await gateApprovalActivation({ ...args, consumeOnly: true })).code, 'STALE_VALIDATION_RECEIPT');
});

test('unknown generated leaf stays incomplete even when model echoes pass', async () => {
  const store = await newStore(); const providers = approvalProvider();
  const out = await gateApprovalActivation({ store, workId: 'book', kind: 'story', stateKey: 'story-identity', value: { ...identity, futureUnknownNarrative: 'An unclassified sentence' }, resolution: resolution('en'), providers });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'INCOMPLETE_LANGUAGE_EVIDENCE');
});

test('required identity and pilot omissions never become English fallback canon', async () => {
  const store = await newStore();
  await runInit({ store, workId: 'book', language: 'ja', genre: 'other', providers: approvalProvider({ language: 'ja' }) });
  const foundation = await store.loadFoundation('book');
  const providers = approvalProvider({ language: 'ja', outputs: { 'story-identity': {}, 'pilot-contract': {} } });
  await assert.rejects(ensureStoryIdentity({ store, workId: 'book', foundation, providers }), { code: 'APPROVAL_SCHEMA_INVALID' });
  await assert.rejects(ensurePilotContract({ store, workId: 'book', foundation, identity, providers }), { code: 'APPROVAL_SCHEMA_INVALID' });
  assert.equal(await store.loadStoryIdentity('book'), null);
  assert.equal(await store.loadPilotContract('book'), null);
});

test('nested human rationale is checked while actual source evidence remains exempt', () => {
  const projected = projectApprovalValue({ rationale: 'Generated reasoning', sourceBrief: '한국어 브리프', userAnswerEvidence: { axis: { quote: '한국어 답변' } }, format: { pov: '3인칭제한' } });
  assert.deepEqual(projected.rationale, { description: 'Generated reasoning' });
  assert.equal(projected.sourceBrief, '한국어 브리프');
  assert.equal(typeof projected.userAnswerEvidence, 'string');
  assert.equal(projected.format.pov, '3인칭제한');
});

test('reused cast and beat keys distinguish generated instructions from machine references', () => {
  const projected = projectApprovalValue({ cast: ['c1'], promptGuidance: { cast: ['Give every character a conflicting goal.'] },
    episodes: [{ beat: 'The keeper pays the debt.' }], characterArcs: [{ beats: [{ beat: 'wound' }] }] });
  assert.deepEqual(projected.cast, { id: ['c1'] });
  assert.deepEqual(projected.promptGuidance.cast, ['Give every character a conflicting goal.']);
  assert.equal(projected.episodes[0].beat, 'The keeper pays the debt.');
  assert.deepEqual(projected.characterArcs[0].beats[0].beat, { id: 'wound' });
});

test('generated prose cannot hide inside an engine configuration slot', async () => {
  const store = await newStore(); const providers = approvalProvider();
  const out = await gateApprovalActivation({ store, workId: 'book', kind: 'foundation',
    value: { genre: 'other', characters: [], worldFacts: [], genreProfile: { description: 'Unvalidated generated prose' } },
    resolution: resolution('en'), providers });
  assert.equal(out.code, 'APPROVAL_SCHEMA_INVALID');
  assert.equal(providers.requests.length, 0);
});

test('a canonical source edit during a model round trip invalidates the approval', async () => {
  const store = await newStore();
  const providers = approvalProvider();
  const complete = providers.complete.bind(providers);
  providers.complete = async request => {
    const answer = await complete(request);
    await store.saveStoryProfile('book', { language: 'en', status: 'active', revision: 9 });
    return answer;
  };
  const result = await gateApprovalActivation({ store, workId: 'book', kind: 'story', stateKey: 'story-identity',
    value: identity, resolution: resolution('en'), providers });
  assert.equal(result.code, 'STALE_VALIDATION_RECEIPT');
  assert.equal(result.validation.attempt, 0);
});

test('seeded entity open attrs preserve exact keys and audit every nested string value', async () => {
  const store = await newStore();
  const value = { worldFacts: [], characters: [], seededEntities: [{ kind: 'location', canonicalName: '港', aliases: [], attrs: { climate: '温暖な海洋性気候', owner: '港の協同組合', nested: { status: '霧の中で閉鎖されている' }, tier: 2 } }] };
  const providers = approvalProvider({ language: 'ja' });
  const args = { store, workId: 'book', kind: 'foundation', value, resolution: resolution('ja'), providers };
  assert.equal((await gateApprovalActivation(args)).ok, true);
  const projected = JSON.parse(providers.requests[0].messages[1].content).artifact.value.seededEntities[0].attrs.entries;
  assert.deepEqual(projected[0], { id: 'climate', value: { description: '温暖な海洋性気候' } });
  assert.deepEqual(projected[2].value.entries[0], { id: 'status', value: { description: '霧の中で閉鎖されている' } });
  const wrongStore = await newStore();
  const wrong = structuredClone(value);
  wrong.seededEntities[0].attrs.owner = 'The harbor cooperative';
  const failed = await gateApprovalActivation({ ...args, store: wrongStore, value: wrong, providers: approvalProvider({ language: 'ja', answer: input => JSON.stringify({ language: 'ja', artifactHash: input.artifactHash, verdict: 'fail', evidence: [{ fieldPath: 'value.seededEntities[0].attrs.entries[1].value.description', quote: 'The harbor cooperative', reason: 'English description rather than Japanese' }], allowedExceptions: [] }) }) });
  assert.equal(failed.ok, false);
  assert.equal(failed.validation.attempt, 3);
  assert.notDeepEqual(projectApprovalValue({ seededEntities: [{ attrs: { nested: {} } }] }), projectApprovalValue({ seededEntities: [{ attrs: { nested: [] } }] }));
  const changed = structuredClone(value);
  changed.seededEntities[0].attrs.owner = '別の組合';
  assert.equal((await gateApprovalActivation({ ...args, value: changed, consumeOnly: true })).code, 'STALE_VALIDATION_RECEIPT');
});

// 2026-09-14 실제 ko/es 표본: 검토자 pass 가 cast-design 생성 필드의 미분류로 거부됐다.
test('foundation approval classifies every cast-design generated field', async () => {
  const store = await newStore(); const providers = approvalProvider();
  const value = {
    title: 'The Harbor That Opened', language: 'en',
    worldFacts: [{ id: 'wf1', statement: 'The harbor closed after the storm.' }],
    characters: [{
      id: 'c1', canonicalName: 'Mara Vale', contradiction: 'She wants help but calls it surrender.',
      speechProfile: { defaultRegister: 'clipped', relationVariants: [{ targetId: 'c2', adjustment: 'Shorter sentences around him.', sample: 'Fine. Your way.' }] },
      dramaticModel: { valueOrder: ['safety'], genreDetails: { 'opening permit': 'She alone signs the reopening notice.', 'inspection zones': 4 }, dimensionBaselines: { delegation_trust: -2 } },
      mutable: { status: 'alive', knownFacts: ['The timber cannot cover the landing.'] },
      relationships: [{ to: 'c2', kind: 'reluctant partner', state: 'trust under construction' }],
    }],
  };
  const out = await gateApprovalActivation({ store, workId: 'book', kind: 'foundation', value, resolution: resolution('en'), providers });
  assert.equal(out.ok, true, JSON.stringify(out.validation?.failureDetails ?? out.code));
  assert.equal(providers.requests.filter(r => r.step === 'approval-language-contract').length, 1);
});

// 2026-09-14 실제 아랍어 표본: `format.pov` 를 지목한 fail 이 machine 면제로 거부되어 소진됐다.
test('a fail that cites the free-text profile pov is a real language failure, not incomplete evidence', async () => {
  const store = await newStore();
  const providers = approvalProvider({ language: 'ar', answer: input => JSON.stringify({ language: 'ar', artifactHash: input.artifactHash, verdict: 'fail',
    evidence: [{ fieldPath: 'value.format.pov', quote: '3인칭제한', reason: 'Not Arabic' }], allowedExceptions: [] }) });
  const out = await runStoryProfile({ store, workId: 'book', language: 'ar', brief: 'A harbor story', mode: 'auto', providers });
  assert.equal(out.status, 'clean_fail');
  assert.notEqual(out.validation?.failureCode, 'INCOMPLETE_LANGUAGE_EVIDENCE');
  assert.notEqual(out.validation?.failureDetails?.reason, 'machine_field');
  assert.equal(await store.loadStoryProfile('book'), null);
});

// 2026-09-14 spine 표본: 심사 findings 의 message 가 미분류 생성 필드로 승인을 막았다.
test('a quality review record is bound in the hash but not language-reviewed', async () => {
  const store = await newStore(); const providers = approvalProvider();
  const spine = { dramaticQuestion: 'Can she share the harbor?', protagonistWant: 'Reopen alone', protagonistNeed: 'Trust', falseBelief: 'Help is surrender', incitingDisruption: 'Timber shortfall', initialStrategy: 'Do it all', midpointReframe: 'The buoy loss was hers', finalChoice: 'Delegate or recheck', endingChange: 'She delegates', endingCost: 'A flaw remains',
    quality: { score: 82, dimensions: { causalNecessity: 80 }, weakDimensions: [], verdict: 'passed', findings: [{ code: 'PASSIVE_CAST', message: '비평 코멘트는 작품 언어가 아니어도 된다.' }] } };
  const out = await gateApprovalActivation({ store, workId: 'book', kind: 'story', stateKey: 'spine', value: spine, resolution: resolution('en'), providers });
  assert.equal(out.ok, true, JSON.stringify(out.validation?.failureDetails ?? out.code));
  const projected = projectApprovalValue(spine);
  assert.deepEqual(Object.keys(projected.quality), ['id']);
  // The reviewer sees only a digest: no critic code or comment text can be cited as a language failure.
  assert.match(projected.quality.id, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(projected).includes('PASSIVE_CAST'), false);
  assert.notEqual(projectApprovalValue({ ...spine, quality: { ...spine.quality, score: 70 } }).quality.id, projected.quality.id);
  // 같은 이름이라도 심사 기록 모양이 아니면 그대로 생성 필드로 검토된다.
  assert.equal(projectApprovalValue({ quality: 'a sentence' }).quality, 'a sentence');
});
