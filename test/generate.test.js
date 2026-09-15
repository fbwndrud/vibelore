import { legacyWorkFixture } from './fixtures/legacy-work.js';
import { contractResponse } from './fixtures/contract-response.js';
import { planningResponse } from './fixtures/planning-response.js';
import { approvalResponse, approvalFixtureProvider } from './fixtures/approval-response.js';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { createPreflightRelay } from '../src/provider/host-relay.js';
import { createLocalOpenAIProvider } from '../src/provider/local-openai.js';
import { runCreate, runDraftTool, runReviseTool, runRewriteTool, runNextArc, runRefold } from '../src/tools/generate.js';
import { runCommit, runStatus } from '../src/tools/commit.js';
import { runEraResearchTool } from '../src/tools/era-research.js';
import { runArcPlan, runArcDecide } from '../src/tools/arc.js';
import { runArcQuality } from '../src/tools/arc-quality.js';
import { runStoryProfile, runStoryProfileDecide } from '../src/tools/story-profile.js';
import { buildContext } from '../src/tools/context.js';
import { episodePlanningContractViolations, runEpisodePlan, runEpisodeDecide } from '../src/tools/episode-plan.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { repairMissingInfluenceObservation, runWriteWorkflow, runWorkflowDecide, runWorkflowHistory, proseHash } from '../src/tools/workflow.js';
import { patternViolations } from '../src/tools/story-experience.js';
import { compileAuthorCraftPacket, compileWriterPacket, createDifferenceContract, writerSkillViolations } from '../src/tools/writer-skill.js';
import { createPublicationUnit } from '../src/core/publication-unit.js';
import { saveExperienceLedgerForHead } from '../src/core/experience-ledger.js';
import { REVIEW_RESPONSES } from './fixtures/review-responses.js';
import { SYNTHETIC_LONG_PROSE } from './fixtures/synthetic-prose.js';

const WORLD = JSON.stringify({ premise: '탑이 세금을 걷는다.', worldFacts: [{ id: 'wf1', statement: '탑의 시스템은 모든 보상에 세금을 매긴다.' }] });
const CAST = JSON.stringify({ characters: [{
  id: 'hero', canonicalName: '윤재', aliases: ['체납자'], contradiction: '살려고 강해질수록 생존세 때문에 죽음에 가까워진다.', description: '빈정대지 않고 모든 부조리를 진지하게 받아들인다.', registeredAtChapter: 1,
  intrinsic: { gender: 'male', ageBand: '20대초반', birthOrder: '외동', role: '주인공', coreAppearance: ['검은 머리'], visualHints: { hair: '검은 단발', eyes: '갈색', build: '마른 체격', attire: '낡은 작업복', distinguishing: ['번호표'], vibe: '지친' } },
  speechProfile: {
    defaultRegister: '낮은 존댓말',
    sentenceShape: '짧게 끊고 숫자를 먼저 말한다',
    logicHabit: '감정보다 납부 비용과 규칙 문구를 먼저 확인한다',
    emotionalLeak: '불안할수록 문장 끝을 계산으로 닫는다',
    samples: { everyday: '먼저 총액부터 보죠.', underPressure: '숨 쉬는 데도 이자가 붙습니까?', lying: '부족하지 않습니다. 아직 계산 중입니다.', intimate: '이번 건 제 몫으로 남겨 둬요.' },
  },
  dramaticModel: { valueOrder: ['생존', '동료', '자존심'], behaviorTraits: [
    { trigger: '세금이 부과될 때', actionBias: '규칙의 빈틈을 찾는다', benefit: '즉시 비용을 줄인다', cost: '다음 과세 조건을 만든다' },
    { trigger: '동료가 손해 볼 때', actionBias: '자기 몫으로 떠안는다', benefit: '동료를 지킨다', cost: '자신의 체납액이 늘어난다' },
  ], perception: { seesFirst: ['규칙 문구'], missesFirst: ['동료의 자존심'] }, defense: { public: '숫자로 말한다', underPressure: '혼자 책임진다' }, repair: { firstMove: '선택권을 돌려준다', cannotDo: '도움을 먼저 청한다' }, privateDelights: ['영수증 정리'], unproductiveWant: '세금 없는 식사를 한다', dimensionBaselines: { rule_control: 3, team_trust: 1 }, genreDetails: { class: '체납자' } },
  mutable: { status: 'alive', knownFacts: [] }, relationships: [],
}] });
const ENTITIES = JSON.stringify({ entities: [{ kind: 'skill', canonicalName: '체납자 감별', aliases: [], attrs: { tier: 1 } }] });
const CAST_MANIFEST = { cast: [{ characterId: 'hero', addressTermsUsed: [] }] };
const revisionPatch = ({ replacements = [], insertions = [] } = {}) => JSON.stringify({ replacements, insertions, castManifest: CAST_MANIFEST });

function provider(outputs) {
  return { register() {}, has() { return true; }, get pending() { return []; }, async complete(req) {
    const proof = contractResponse(req) ?? approvalResponse(req);
    if (proof) return proof;
    if (req.step === 'arc-quality' && outputs[req.step] === undefined) return { text: JSON.stringify({ score: 90, dimensions: { premisePressure: 90, causalEscalation: 90, expectationRenewal: 90, characterCollision: 90, oppositionAdaptation: 90, payoffSurprise: 90, serialMomentum: 90 }, verdict: 'pass', findings: [] }) };
    return outputs[req.step] !== undefined ? { text: outputs[req.step] } : planningResponse(req) ?? { text: REVIEW_RESPONSES[req.step] ?? '{}' };
  } };
}

async function createdStore({ legacy = false } = {}) {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-generate-')));
  if (legacy) await legacyWorkFixture({ store, workId: 'tax-tower', genre: 'litrpg', title: '세금탑', brief: '탑이 보상보다 많은 세금을 걷는다.', worldFacts: JSON.parse(WORLD).worldFacts.map(f => f.statement), characters: JSON.parse(CAST).characters });
  else await runCreate({ store, workId: 'tax-tower', title: '세금탑', brief: '탑이 보상보다 많은 세금을 걷는다.', genre: 'litrpg', providers: provider({ worldbuild: WORLD, 'cast-design': CAST, 'entity-seed': ENTITIES }) });
  await store.saveStorySpine('tax-tower', { status: 'active', causalChain: ['고지서를 받는다', '빈틈을 쓴다', '징수관이 적응한다', '동료가 다른 선택을 한다', '윤재가 통제를 포기한다'] });
  await store.saveWriterSkill('tax-tower', { status: 'active', aestheticThesis: '규칙의 비용을 사람의 선택으로 드러낸다.', coreAttention: ['작은 어긋남을 본다', '비용을 먼저 본다'], sceneTransformations: ['설명을 행동으로 바꾼다', '성공을 새 비용으로 바꾼다', '성격을 선택 순서로 보인다'], withholdingInstinct: ['결론을 늦춘다'], payoffInstinct: ['앞 사물을 재사용한다'], antiFixation: ['같은 해결 순서를 반복하지 않는다', '모든 대사를 영리하게 만들지 않는다'], discoverySpaces: ['정확한 행동은 장면에서 발견한다'], authorCraft: { judgments: ['효율이 침해하는 사람을 본다','말보다 포기하지 못한 행동을 믿는다','정답 뒤의 불일치를 본다'], omissions: ['결론은 행동 뒤에 둔다'], dialogueConduct: ['답변 대신 관계를 바꾼다'], selfBetrayal: ['빈틈 찾기가 예상되면 빈틈의 피해를 보인다'] }, storyDramaturgy: { conflictSources: ['규칙의 정상 적용','동료의 독립 거래'], escalationLaws: ['성공할수록 담보가 는다'], protagonistError: '문구를 알면 사람도 움직일 거라 믿는다', oppositionAdaptation: ['적용 순서를 바꾼다'] } });
  await store.saveArcPlan('tax-tower', activePlan());
  await store.saveEpisodePlan('tax-tower', activeEpisodePlan());
  return store;
}

describe('Phase 2 generation pipeline', () => {
  it('compiles a rotating Writer Packet without leaking future arc answers', () => {
    const skill = { status: 'active', aestheticThesis: '비용을 선택으로 보인다.', coreAttention: ['이상 징후', '침묵의 비용', '손의 순서'], sceneTransformations: ['설명을 실패로', '성공을 비용으로', '성격을 선택으로'], antiFixation: ['같은 오프닝 금지', '완결 대사 금지'], discoverySpaces: ['누가 규칙을 깨는지는 자유'], authorCraft: { judgments: ['효율의 피해자','말과 행동의 차이','정답의 잔여'], omissions: ['독자가 안 사실은 생략'], dialogueConduct: ['답하지 않는 대사'], selfBetrayal: ['전문성이 정답이면 부작용을 드러낸다'] }, storyDramaturgy: { conflictSources: ['정상 절차의 피해','동료의 독립 거래'], escalationLaws: ['성공이 감시를 부른다'], protagonistError: '분석하면 설득할 수 있다고 믿는다', oppositionAdaptation: ['분석법을 역이용한다'] } };
    assert.deepEqual(writerSkillViolations(skill), []);
    const packet = compileWriterPacket({ skill, chapter: 2, episodePlan: { premise: '현재 사건', readerExpectation: { likelyOutcome: '문이 열린다' }, scenePressure: { incompatibleGoods: ['증거', '사람'] }, payoff: { promisePaid: '한 명을 구한다' }, costCreatedByResolution: { immediate: '증거를 잃는다' } } });
    assert.match(packet, /문이 열린다|증거 vs 사람|한 명을 구한다|증거를 잃는다/);
    assert.doesNotMatch(packet, /미래 아크|최종 결말/);
    const craft = compileAuthorCraftPacket({ skill, chapter: 2, episodePlan: { premise: '현재 사건', readerExpectation: { likelyOutcome: '문이 열린다' }, scenePressure: { incompatibleGoods: ['증거', '사람'] }, payoff: { promisePaid: '한 명을 구한다' }, costCreatedByResolution: { immediate: '증거를 잃는다' } } });
    assert.match(craft, /Author Craft Packet/);
    assert.doesNotMatch(craft, /문이 열린다|증거 vs 사람|한 명을 구한다|증거를 잃는다/);
    assert.doesNotMatch(craft, /주인공이 놓쳐야|전환의 소유자|자기 장기 배반/);
    const contract = createDifferenceContract({ skill, chapter: 3, episodePlan: { premise: '현재 사건' }, recentPatterns: [
      { solutionPattern: '계약 문구 재해석', protagonistMethod: '규칙 빈틈', supportingAgency: { ally: '증거를 숨김' } },
      { solutionPattern: '책임 분산', protagonistMethod: '권한 재배치', supportingAgency: { rival: '거래를 거부함' } },
    ] });
    assert.match(contract.forbiddenRepeat, /계약 문구 재해석.*책임 분산/);
    assert.match(contract.agencyOwnerConstraint, /rival 이외/);
    assert.equal(contract.methodToAvoid, '권한 재배치');
  });

  it('does not trust a high reported arc score when one dramatic axis is weak', async () => {
    const quality = await runArcQuality({
      foundation: { title: '세금탑', genre: 'litrpg', worldFacts: [], characters: [] },
      plan: { title: '선택의 세금', episodes: [] },
      providers: provider({ 'arc-quality': JSON.stringify({
        score: 96,
        dimensions: { premisePressure: 92, causalEscalation: 91, expectationRenewal: 88, characterCollision: 35, oppositionAdaptation: 90, payoffSurprise: 87, serialMomentum: 93 },
        verdict: 'pass', findings: [],
      }) }),
    });
    assert.equal(quality.reportedScore, 96);
    assert.equal(quality.verdict, 'failed');
    assert.deepEqual(quality.weakDimensions, ['characterAgency']);
  });

  it('flags only established three-chapter experience patterns', () => {
    const entries = [1, 2].map((chapter) => ({ chapter, solutionPattern: '규칙 빈틈', comedyMechanism: '관료주의', protagonistMethod: '문구 해석', mistakeAndCorrection: '', supportingAgency: {} }));
    const violations = patternViolations(entries, { chapter: 3, solutionPattern: '규칙 빈틈', comedyMechanism: '관료주의', protagonistMethod: '문구 해석', mistakeAndCorrection: '', supportingAgency: {} });
    assert.ok(violations.some((v) => v.code === 'PATTERN_REPETITION'));
    assert.ok(violations.some((v) => v.code === 'PERFECT_JUDGMENT_STREAK'));
    assert.deepEqual(patternViolations([], { chapter: 1, solutionPattern: '', comedyMechanism: '', protagonistMethod: '', mistakeAndCorrection: '', supportingAgency: {} }), []);
  });

  it('flags semantic repetition even when surface methods use different wording', () => {
    const entries = [
      { chapter: 1, solutionPattern: '규칙을 찢는다', moralChoice: '사람vs성과', evidenceFamily: '문서', endingImage: '검은증거', mistakeAndCorrection: '오판을 수정한다' },
      { chapter: 2, solutionPattern: '점수를 포기한다', moralChoice: '사람vs성과', evidenceFamily: '문서', endingImage: '검은증거', mistakeAndCorrection: '반론을 수용한다' },
    ];
    const violations = patternViolations(entries, {
      chapter: 3, solutionPattern: '규정을 어긴다', moralChoice: '사람vs성과', evidenceFamily: '문서', endingImage: '검은증거', mistakeAndCorrection: '계산을 고친다',
    });
    assert.deepEqual(violations.map((item) => item.code).sort(), [
      'ENDING_IMAGE_REPETITION', 'EVIDENCE_FAMILY_REPETITION', 'MORAL_CHOICE_REPETITION',
    ]);
  });

  it('persists the commercial reader contract and renders it through the existing arc seam', async () => {
    const store = await createdStore();
    await store.saveArcPlan('tax-tower', { ...activePlan(), status: 'pending' });
    const arcJson = JSON.stringify({
      title: '선택의 세금', promise: '윤재의 해법이 통하지만 동료가 비용을 낸다.', type: 'small',
      commercialPromise: { fantasy: '규칙을 역산하는 쾌감', humanComplication: '동료가 생존 때문에 다른 선택을 한다', repeatableProof: '앞서 읽은 문구가 뒤에서 함정으로 재등장한다' },
      readerContract: { openingQuestion: '누구의 해석이 맞는가?', expectedPath: '윤재의 계산이 맞는다', promisedPayoffBy: 3, minimumPayoff: '계산의 실제 결과를 본다' },
      characterPressureMatrix: [{ characterId: 'hero', visibleWant: '납부', privateNeed: '자유', protectedSecret: '부족액', lineTheyWillNotCross: '동료 담보', pressureThatMayBreakIt: '마감' }],
      misconceptionStack: [{ id: 'safe-rule', readerBelief: '규칙은 일관적이다', characterBelief: '문구가 전부다', hiddenCausality: '징수관이 적용 순서를 바꾼다', evidenceToPlant: ['시간 도장이 다르다'], revealPolicy: '두 번째 적용에서 의미를 바꾼다' }],
      escalatingCosts: ['성공할수록 담보가 커진다'], oppositionAgency: { actor: '징수관', independentGoal: '체납 자산 확보', knowledge: '윤재의 해석법', adaptationTrigger: '같은 빈틈을 두 번 사용' },
      openOutcomeSpace: { mustResolve: ['첫 납부'], mayResolve: ['누가 담보를 내는가'], mustRemainCostly: ['자유'] },
      episodes: Array.from({ length: 3 }, (_, i) => ({ title: `${i + 1}화`, beat: [`규칙을 발견한다`, `동료가 계산을 거부한다`, `징수관이 빈틈을 역이용한다`][i], readerExpectation: [`계산이 맞는다`, `동료가 따른다`, `담보를 피한다`][i], payoff: [`첫 빈틈이 통한다`, `동료의 대안이 사람을 살린다`, `증거로 첫 담보를 막는다`][i], costCreatedByResolution: [`담보 후보가 된다`, `동료의 신뢰를 잃는다`, `징수관이 적용 순서를 바꾼다`][i], exitValue: [`동료가 거래를 제안한다`, `징수관이 먼저 움직인다`, `새 규칙 아래 선택해야 한다`][i] })),
    });
    const planned = await runArcPlan({ store, workId: 'tax-tower', mode: 'auto', episodes: 3, providers: provider({ 'arc-plan': arcJson }) });
    assert.ok(planned.plan, JSON.stringify(planned.validation));
    assert.equal(planned.plan.readerContract.openingQuestion, '누구의 해석이 맞는가?');
    assert.equal(planned.plan.oppositionAgency.actor, '징수관');
    assert.equal(planned.plan.episodes[0].costCreatedByResolution, '담보 후보가 된다');
    assert.deepEqual(planned.plan.episodes.map((episode) => episode.readerLoad.phase), ['onboarding', 'onboarding', 'expansion']);
  });

  it('carries the previous final arc review into the next arc as advisory evidence', async () => {
    const store = await createdStore();
    const previous = { ...activePlan(), status: 'completed' };
    await store.saveArcPlan('tax-tower', previous);
    store.loadCharacterDynamics = async () => ({
      characterStates: {
        hero: {
          nextChoiceBias: '동료에게 선택권을 돌려준다',
          influences: [{
            eventId: 'hero-choice-3', anchor: 'p9:l2', storyTime: 3,
            interpretation: '혼자 계산한 결과가 동료를 담보로 만들었다',
          }],
        },
      },
      agendas: { hero: { goal: '동료의 담보를 되찾는다', nextAction: '거래 조건을 공개한다' } },
      relationshipStates: {},
    });
    await store.saveArcReview('tax-tower', {
      workId: 'tax-tower', arcNumber: 1, chapter: 3, checkpoint: 'final',
      dimensions: { patternVariety: 42, commercialMomentum: 55 },
      findings: [{ dimension: 'patternVariety', code: 'PATTERN_FAMILY_REPETITION', message: 'ARC_REVIEW_CARRY_TOKEN' }],
      characterOutcomes: [{
        characterId: 'hero', status: 'complicated',
        evidence: '3화에서 거래 조건을 공개했지만 동료의 담보는 남았다.',
        remainingPressure: '타인의 선택권과 자기 책임을 함께 지킬 수 있는가',
      }],
    });
    const arcJson = JSON.stringify({
      title: '다음 세금', promise: '윤재가 새 거래권을 얻는다.', type: 'small',
      commercialPromise: { fantasy: '규칙 역산', humanComplication: '동료의 독립 거래', repeatableProof: '다른 장소에서 비용이 증명된다' },
      readerContract: { openingQuestion: '누가 비용을 내나?', expectedPath: '윤재가 낸다', promisedPayoffBy: 3, minimumPayoff: '새 선택권을 얻는다' },
      characterPressureMatrix: [{ characterId: 'hero', visibleWant: '납부', privateNeed: '도움', protectedSecret: '부족액', lineTheyWillNotCross: '동료 담보', pressureThatMayBreakIt: '마감' }],
      misconceptionStack: [], escalatingCosts: ['감시가 늘어난다'],
      oppositionAgency: { actor: '징수관', independentGoal: '징수', knowledge: '빈틈', adaptationTrigger: '윤재의 성공' },
      openOutcomeSpace: { mustResolve: ['첫 거래'], mayResolve: ['승패'], mustRemainCostly: ['체납'] },
      characterArcs: [{
        characterId: 'hero', promise: '책임을 독점하지 않고 선택권을 나눈다.',
        beats: [{ episodeIndex: 2, beat: 'wound', note: '거래 조건을 먼저 공개하고 동료의 결정을 기다린다.' }],
      }],
      episodes: Array.from({ length: 3 }, (_, index) => ({
        title: `${index + 1}화`, beat: `새 사건 ${index + 1}`, pressure: `새 압력 ${index + 1}`,
        readerExpectation: ['협상 성공', '동료 합류', '징수관 반격'][index],
        payoff: ['납부 유예', '공동 장부 열람', '담보 선택권'][index],
        turn: ['징수관이 조건을 바꾼다', '동료가 독립 거래한다', '윤재가 빈틈을 공개한다'][index],
        costCreatedByResolution: ['감시 명단 등록', '동료와 수익 분배', '다음 층 의무 진입'][index],
        carry: ['새 세율표', '독립 거래 증서', '다음 층 소환장'][index],
        exitValue: ['징수 순서의 변경', '동료의 비밀 담보', '다음 층의 예외 조항'][index],
      })),
    });
    let arcRequest;
    const p = provider({ 'arc-plan': arcJson });
    const complete = p.complete.bind(p);
    p.complete = async (request) => {
      if (request.step === 'arc-plan') arcRequest = request;
      return complete(request);
    };
    const result = await runArcPlan({ store, workId: 'tax-tower', mode: 'auto', episodes: 3, providers: p });
    assert.ok(result.plan, JSON.stringify(result.validation));
    const prompt = arcRequest.messages.map((message) => message.content).join('\n');
    assert.match(prompt, /ARC_REVIEW_CARRY_TOKEN/);
    assert.match(prompt, /hero-choice-3/);
    assert.match(prompt, /타인의 선택권과 자기 책임을 함께 지킬 수 있는가/);
    assert.match(prompt, /강제 규칙이 아님/);
    assert.match(prompt, /표면 해법이나 특정 문구를 복제하지 않는다/);
    assert.equal(result.plan.characterArcs[0].inheritedState.status, 'complicated');
    assert.equal(result.plan.characterArcs[0].sourceEvidence[0].eventId, 'hero-choice-3');
  });

  it('rejects a field-complete but dramatically repetitive commercial arc', async () => {
    const store = await createdStore();
    const episodes = Array.from({ length: 3 }, (_, index) => ({
      title: `${index + 1}화`, beat: '윤재가 고지서를 읽는다', pressure: '마감이 온다',
      readerExpectation: '빈틈을 찾는다', payoff: '문구의 빈틈을 찾는다', turn: '빈틈을 쓴다',
      costCreatedByResolution: '다음 고지서가 온다', carry: '다음 고지서를 읽는다', exitValue: '다음 고지서가 온다',
    }));
    const bland = JSON.stringify({
      title: '고지서 세 장', promise: '윤재가 고지서를 처리한다.', type: 'small',
      commercialPromise: { fantasy: '문구의 빈틈', humanComplication: '동료가 걱정한다', repeatableProof: '매번 문구를 읽는다' },
      readerContract: { openingQuestion: '고지서를 처리할까?', expectedPath: '빈틈을 찾는다', promisedPayoffBy: 3, minimumPayoff: '고지서를 처리한다' },
      characterPressureMatrix: [{ characterId: 'hero', visibleWant: '처리', privateNeed: '처리', protectedSecret: '고지서', lineTheyWillNotCross: '실패', pressureThatMayBreakIt: '마감' }],
      misconceptionStack: [], escalatingCosts: ['고지서가 더 온다'],
      oppositionAgency: { actor: '징수관', independentGoal: '고지서를 보낸다', knowledge: '윤재가 읽는다', adaptationTrigger: '윤재가 읽는다' },
      openOutcomeSpace: { mustResolve: ['고지서'], mayResolve: ['고지서'], mustRemainCostly: ['고지서'] }, episodes,
    });
    await assert.rejects(
      () => runArcPlan({ store, workId: 'tax-tower', mode: 'auto', episodes: 3, providers: provider({ 'arc-plan': bland }) }),
      /아크 품질 검증 실패/,
    );
  });

  it('pre-flights world, cast, and entity prompts in one pass without writing probe output', async () => {
    const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-preflight-')));
    const relay = createPreflightRelay({});
    const result = await runCreate({ store, workId: 'tax-tower', title: '세금탑', brief: '세금을 걷는 탑', genre: 'litrpg', providers: relay });
    assert.equal(result.preview, true);
    assert.deepEqual(relay.pending.map((r) => r.step), ['worldbuild', 'cast-design', 'entity-seed']);
    assert.equal(await store.loadFoundation('tax-tower'), null);
  });

  it('creates canonical world, contradictory cast, and seeded entities', async () => {
    const store = await createdStore();
    const foundation = await store.loadFoundation('tax-tower');
    assert.equal(foundation.worldFacts.length, 1);
    assert.match(foundation.characters[0].contradiction, /강해질수록/);
    assert.deepEqual(foundation.characters[0].dramaticModel.valueOrder, ['생존', '동료', '자존심']);
    assert.equal(foundation.characters[0].speechProfile.samples.everyday, '먼저 총액부터 보죠.');
    assert.equal(foundation.narrativeSalienceProfile.dimensions.length, 2);
    const { context } = await buildContext({ store, workId: 'tax-tower', chapter: 1 });
    assert.match(context, /가치 우선순위: 생존 > 동료 > 자존심/);
    assert.match(context, /행동 편향:/);
    assert.match(context, /말투 예시:/);
    assert.equal((await store.loadEntitySnapshots('tax-tower'))[0].canonicalName, '체납자 감별');
  });

  it('refuses to publish a newly generated cast with a thin dramatic model', async () => {
    const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-thin-cast-')));
    const thin = JSON.stringify({ characters: [{
      id: 'flat', canonicalName: '평면', contradiction: '원하지만 두렵다',
      intrinsic: { gender: 'unknown', species: 'human', form: 'humanoid', role: '주인공' },
      dramaticModel: { valueOrder: ['생존'] },
    }] });
    await assert.rejects(
      () => runCreate({ store, workId: 'thin-cast', title: '얇은 인물', brief: '검사', genre: 'litrpg', providers: provider({ worldbuild: WORLD, 'cast-design': thin }) }),
      /CHARACTER_DESIGN_INVALID.*DRAMATIC_VALUE_ORDER_THIN/,
    );
    assert.equal(await store.loadFoundation('thin-cast'), null);
  });

  // 2026-09-14 실제 표본: 조연 한 명의 behaviorTraits 1개가 전체 생성을 즉시 끝냈다.
  it('repairs a thin cast once through a second cast-design request before refusing', async () => {
    const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-repaired-cast-')));
    const thin = JSON.stringify({ characters: [{
      id: 'flat', canonicalName: '평면', contradiction: '원하지만 두렵다',
      intrinsic: { gender: 'unknown', species: 'human', form: 'humanoid', role: '주인공' },
      dramaticModel: { valueOrder: ['생존'] },
    }] });
    const base = provider({ worldbuild: WORLD, 'entity-seed': ENTITIES });
    const castQueue = [thin, CAST]; const castRequests = [];
    const providers = { register() {}, has() { return true; }, get pending() { return []; }, async complete(req) {
      if (req.step !== 'cast-design') return base.complete(req);
      castRequests.push(req);
      return { text: castQueue.shift() };
    } };
    const out = await runCreate({ store, workId: 'repaired-cast', title: '고친 인물', brief: '검사', genre: 'litrpg', providers });
    assert.equal(out.created, true);
    assert.equal(castRequests.length, 2);
    const repair = castRequests[1].messages.find((m) => m.role === 'user').content;
    assert.match(repair, /이전 응답 수정 요청:/);
    assert.match(repair, /- flat: .*DRAMATIC_VALUE_ORDER_THIN/);
    assert.equal((await store.loadFoundation('repaired-cast')).characters[0].canonicalName, '윤재');
  });

  it('drafts, revises, rewrites, and proposes the next arc through the same provider seam', async () => {
    const store = await createdStore({ legacy: true });
    const prose = '윤재는 탑 앞에 섰다.\n\n⟦vle:cast-manifest {"cast":[{"characterId":"hero","addressTermsUsed":[]}]}⟧';
    const draft = await runDraftTool({ store, workId: 'tax-tower', chapter: 1, providers: provider({ draft: prose }) });
    assert.match(draft.prose, /cast-manifest/);
    const revised = await runReviseTool({
      store, workId: 'tax-tower', chapter: 1, prose: draft.prose,
      violations: [{ severity: 'hard', code: 'X', message: '고쳐라' }],
      providers: provider({ revise: revisionPatch({ replacements: [{ paragraph: 1, text: '윤재는 탑 앞에 무릎을 꿇었다.' }] }) }),
    });
    assert.match(revised.prose, /무릎을 꿇었다/);
    await runCommit({ store, workId: 'tax-tower', chapter: 1, prose: '윤재는 탑 앞에 섰다.', summary: '윤재가 탑 앞에 섰다.', providers: createHostRelay({}), delta: emptyDelta(1) });
    assert.equal((await store.loadArcPlan('tax-tower')).episodes[0].status, 'completed');
    const rewritten = await runRewriteTool({ store, workId: 'tax-tower', chapter: 1, intent: '더 절박하게', providers: provider({ rewrite: prose }) });
    assert.match(rewritten.prose, /윤재는 탑 앞/);
    const arc = await runNextArc({ store, workId: 'tax-tower', providers: provider({ 'next-arc-proposal': JSON.stringify({ title: '압류 아크', promise: '윤재는 자신의 이름을 되찾는다.', type: 'small', estimatedEpisodes: 6, scopedEntities: [], carryOverCharacters: ['hero'], newCharacterSeeds: [], transitionHook: '압류관이 온다.' }) }) });
    assert.equal(arc.proposal.title, '압류 아크');
  });

  it('keeps supplemental direction in the user plan channel and records compiled draft hashes', async () => {
    const store = await createdStore();
    let draftRequest;
    const p = { register() {}, has() { return true; }, get pending() { return []; }, async complete(req) {
      const proof = contractResponse(req) ?? approvalResponse(req);
      if (proof) return proof;
      if (req.step === 'chapter-plan') return { text: REVIEW_RESPONSES[req.step] ?? '{}' };
      if (req.step === 'draft') {
        draftRequest = req;
        return { text: '윤재가 문 앞에 섰다.\n\n⟦vle:cast-manifest {"cast":[{"characterId":"hero","addressTermsUsed":[]}]}⟧' };
      }
      return planningResponse(req) ?? { text: REVIEW_RESPONSES[req.step] ?? '{}' };
    } };
    const result = await runDraftTool({
      store, workId: 'tax-tower', chapter: 1, plan: 'SUPPLEMENTAL_DIRECTION_SENTINEL', providers: p,
    });
    assert.ok(draftRequest);
    assert.doesNotMatch(draftRequest.messages[0].content, /SUPPLEMENTAL_DIRECTION_SENTINEL/);
    assert.match(draftRequest.messages.slice(1).map((message) => message.content).join('\n'), /추가 지시: SUPPLEMENTAL_DIRECTION_SENTINEL/);
    assert.match(draftRequest.messages.slice(1).map((message) => message.content).join('\n'), /VOICE_TARGET_TOKEN/);
    assert.match(result.contextAudit.draftInputTrace.outputs.planHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(result.contextAudit.draftInputTrace.outputs.slidingWindowHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(result.contextAudit.draftInputTrace.identity.invocation, 'direct');
  });

  it('rejects a draft result when its pinned plan source changes during generation', async () => {
    const store = await createdStore();
    const p = { register() {}, has() { return true; }, get pending() { return []; }, async complete(req) {
      const proof = contractResponse(req) ?? approvalResponse(req);
      if (proof) return proof;
      if (req.step === 'chapter-plan') return { text: REVIEW_RESPONSES[req.step] ?? '{}' };
      if (req.step === 'draft') {
        await store.saveWriterSkill('tax-tower', { ...(await store.loadWriterSkill('tax-tower')), aestheticThesis: '생성 도중 바뀐 기술' });
        return { text: '윤재가 문 앞에 섰다.\n\n⟦vle:cast-manifest {"cast":[{"characterId":"hero","addressTermsUsed":[]}]}⟧' };
      }
      return planningResponse(req) ?? { text: REVIEW_RESPONSES[req.step] ?? '{}' };
    } };
    await assert.rejects(
      () => runDraftTool({ store, workId: 'tax-tower', chapter: 1, providers: p }),
      /STALE_DRAFT_IDENTITY: planSource/,
    );
  });

  it('uses the same current experience view for every draft identity check', async () => {
    const store = await createdStore();
    await store.savePatternLedger('tax-tower', [{ chapter: 1, solutionPattern: '구형 패턴' }]);
    await store.saveExperienceLedger('tax-tower', {
      schemaVersion: 2,
      sourceHead: 'sha256:stale-before-episode-plan-publication',
      entries: [{ chapter: 1, solutionPattern: '현재 원장에서는 제외할 패턴' }],
    });
    const prose = '윤재가 문 앞에 섰다.\n\n⟦vle:cast-manifest {"cast":[{"characterId":"hero","addressTermsUsed":[]}]}⟧';
    const draft = await runDraftTool({
      store,
      workId: 'tax-tower',
      chapter: 1,
      providers: provider({ 'chapter-plan': '{}', draft: prose }),
    });
    assert.match(draft.prose, /윤재가 문 앞에 섰다/);
  });

  it('repairs a malformed influence observation without rewriting checked prose', async () => {
    const foundation = { characters: [{ id: 'hero', canonicalName: '윤재', aliases: [] }] };
    const repaired = await repairMissingInfluenceObservation({
      foundation, prose: '윤재는 동료 대신 벌금을 떠안았다.', chapter: 2,
      episodePlan: { characterArcBeats: [{ characterId: 'hero', beat: 'attempt', note: '비용을 떠안는다' }] },
      delta: { influenceEvents: [], noInfluenceReason: '' },
      providers: provider({
        'influence-observation-repair': '{"hard":[],"soft":[]}',
        'influence-observation-repair-retry': JSON.stringify({ influenceEvents: [{ characterId: '윤재', anchor: '동료 대신 벌금을 떠안았다', interpretation: '책임을 혼자 진다', dimensionChanges: { team_trust: 1 }, nextChoiceBias: '다음에도 먼저 책임지려 한다', behavioralProof: null, relationshipClaims: [] }], noInfluenceReason: '' }),
      }),
    });
    assert.equal(repaired.influenceEvents[0].characterId, 'hero');
    assert.equal(repaired.influenceEvents[0].dimensionChanges.team_trust, 1);
  });

  it('refolds later state and entity lifecycle from stored deltas', async () => {
    const store = await createdStore({ legacy: true });
    const first = emptyDelta(1);
    first.entityOps = [{ op: 'register', entityId: 'taxman', kind: 'organization', name: '징수국' }];
    await runCommit({ store, workId: 'tax-tower', chapter: 1, prose: '징수국이 왔다.', summary: '징수국이 왔다.', providers: createHostRelay({}), delta: first });
    const second = emptyDelta(2);
    second.hookChanges = [{ id: 'bill', text: '청구서의 출처가 불명이다.', plantedAtChapter: 2, phase: 'planted' }];
    await runCommit({ store, workId: 'tax-tower', chapter: 2, prose: '청구서가 왔다.', summary: '청구서가 왔다.', providers: createHostRelay({}), delta: second });
    const arcPlan = await store.loadArcPlan('tax-tower');
    await store.saveArcPlan('tax-tower', {
      ...arcPlan,
      status: 'completed',
      completedAt: new Date().toISOString(),
      episodes: arcPlan.episodes.map((episode) => ({ ...episode, status: 'completed' })),
    });
    const result = await runRefold({ store, workId: 'tax-tower', fromChapter: 1 });
    assert.equal(result.rebuilt, 2);
    assert.equal((await store.loadStoryState('tax-tower', 2)).hooks[0].id, 'bill');
    assert.ok((await store.loadEntitySnapshots('tax-tower')).some((e) => e.entityId === 'taxman'));
    assert.equal((await runStatus({ store, workId: 'tax-tower' })).arc.status, 'completed');
  });

  it('supports an OpenAI-compatible local model endpoint', async () => {
    let request;
    const local = createLocalOpenAIProvider({ baseUrl: 'http://127.0.0.1:11434/v1/', model: 'local-model', fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return { ok: true, async json() { return { choices: [{ message: { content: '로컬 응답' } }] }; } };
    } });
    const result = await local.complete({ jsonMode: true, messages: [{ role: 'user', content: '안녕' }] });
    assert.equal(result.text, '로컬 응답');
    assert.equal(request.url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(request.body.model, 'local-model');
  });

  it('uses the host model relay for sourced era-fidelity checks', async () => {
    const store = await createdStore();
    const result = await runEraResearchTool({
      store, workId: 'tax-tower', chapter: 1, era: '조선 후기 한양',
      claims: ['상인이 플라스틱 우산을 썼다.'], providers: provider({
        'era-research': JSON.stringify({ verdict: 'contradicts', explanation: '플라스틱 우산은 조선 후기에 존재하지 않았다.', sources: ['https://example.org/museum'] }),
      }),
    });
    assert.equal(result.checked, 1);
    assert.equal(result.violations[0].code, 'ERA_FIDELITY_CONFLICT');
    assert.match(result.violations[0].message, /example\.org/);
  });

  it('holds a review-mode arc until approval and advances its episode on commit', async () => {
    const store = await createdStore();
    // Remove the helper plan logically by replacing it with a generated pending plan.
    const arcJson = JSON.stringify({ title: '납부 기한', promise: '윤재가 첫 세금을 납부하는 대신 자유를 저당 잡힌다.', type: 'small', episodes: [
      { title: '고지서', goal: '세금 규칙을 체험한다.', conflict: '납부액 부족', growth: '감별 스킬 단서', cost: '채무 증가', hook: '징수관 등장' },
      { title: '압류', goal: '징수관과 충돌한다.', conflict: '장비 압류', growth: '감별 스킬 획득', cost: '동료 장비 상실', hook: '더 깊은 층 명령' },
      { title: '납부', goal: '아크 약속을 정산한다.', conflict: '마석 부족', growth: '레벨 상승', cost: '의무 심도 상승', hook: '다음 원정' },
    ] });
    const planned = await runArcPlan({ store, workId: 'tax-tower', mode: 'review', episodes: 3, providers: provider({ 'arc-plan': arcJson }) });
    assert.equal(planned.needsApproval, true);
    assert.equal((await store.loadArcPlan('tax-tower')).status, 'pending');
    await runArcDecide({ store, workId: 'tax-tower', action: 'approve' });
    assert.equal((await store.loadArcPlan('tax-tower')).status, 'active');
  });

  it('keeps sparse character arc beats without inventing intermediate progress', async () => {
    const store = await createdStore();
    const arcJson = JSON.stringify({
      title: '건너뛴 감정선', promise: '윤재가 도움을 받아들인다.', type: 'small',
      characterArcs: [{
        characterId: 'hero', promise: '고립에서 동료 선택으로 간다.',
        beats: [
          { episodeIndex: 1, beat: 'wound', note: '상처' },
          { episodeIndex: 2, beat: 'wound', note: '상처를 부정한다.' },
          { episodeIndex: 4, beat: 'attempt', note: '처음으로 도움을 시험한다.' },
          { episodeIndex: 5, beat: 'attempt', note: '실패 뒤에도 시도를 거두지 않는다.' },
        ],
      }],
      episodes: Array.from({ length: 5 }, (_, index) => ({ title: `${index + 1}화`, beat: `사건 ${index + 1}` })),
    });

    const planned = await runArcPlan({ store, workId: 'tax-tower', mode: 'auto', episodes: 5, providers: provider({ 'arc-plan': arcJson }) });
    assert.ok(planned.plan, JSON.stringify(planned.validation));
    assert.deepEqual(planned.plan.characterArcs[0].beats.map(({ episodeIndex, beat }) => ({ episodeIndex, beat })), [
      { episodeIndex: 1, beat: 'wound' },
      { episodeIndex: 2, beat: 'wound' },
      { episodeIndex: 4, beat: 'attempt' },
      { episodeIndex: 5, beat: 'attempt' },
    ]);
  });

  it('keeps targeted relationship findings outside the arc average and verdict', async () => {
    const dimensions = { premisePressure: 90, causalEscalation: 90, expectationRenewal: 90, characterAgency: 90, oppositionAdaptation: 90, payoffSurprise: 90, serialMomentum: 90 };
    const quality = await runArcQuality({
      foundation: { title: '세금탑', genre: 'litrpg', worldFacts: [], characters: [] },
      plan: { title: '관계 변화', episodes: [] },
      providers: provider({ 'arc-quality': JSON.stringify({
        score: 90, dimensions, verdict: 'pass', findings: [],
        targetedReview: { applicable: true, findings: [{
          code: 'UNSUPPORTED_RELATIONSHIP_SHIFT', message: '적대가 협력으로 너무 빨리 바뀐다.',
          evidence: '2화의 공격 뒤 3화에서 책임 추궁 없이 협력한다.', confidence: 0.94,
        }] },
      }) }),
    });
    assert.equal(quality.score, 90);
    assert.equal(quality.verdict, 'passed');
    assert.equal(quality.targetedReview.findings[0].code, 'UNSUPPORTED_RELATIONSHIP_SHIFT');
  });

  it('compiles an unknown composite genre once and reuses it across creation and context', async () => {
    const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-profile-')));
    const profileJson = JSON.stringify({
      genreLabel: '우주 오페라 정치 성장극', engineGenre: 'sci-fi', subgenres: ['space-opera', 'political-drama'],
      tones: ['장중함', '냉소'], storyEngines: ['권력 상승', '세력 경쟁'], themes: ['충성', '제국주의'],
      format: { pov: '3인칭제한', chapterChars: 3200, serialization: '웹소설 연재', dialogueBreakMode: 'relaxed' },
      narrativeContract: {
        depthMode: 'deep-world-driven',
        readerPromise: '제국의 제도가 인물의 충성을 갉아먹는 긴장',
        openingPressure: '배급과 의전 규칙이 서기관의 생존권을 결정한다',
        viewpointReason: '몰락한 서기관만 제국 장부의 폭력을 실감한다',
        expositionPolicy: '정치 구조는 회의 설명이 아니라 결재 실패와 배급 삭감으로 드러낸다',
      },
      povDesign: {
        mode: '3인칭제한',
        openingViewpoint: '몰락한 서기관',
        narrativeDistance: '인물의 관찰과 오해에 붙는다',
        readerKnowledgePolicy: '독자는 서기관이 본 문서 이상을 알지 못한다',
        switchPolicy: '아크 단위로만 전환한다',
      },
      tracking: { engineBacked: ['Character', 'AddressMap'], semantic: ['FactionState', 'Technology'] },
      promptGuidance: { worldbuild: ['기술의 한계와 정치적 소유자를 함께 정한다.'], cast: ['모든 핵심 인물에게 상충하는 정치적 이해관계를 준다.'], arc: ['아크마다 세력 균형을 관찰 가능하게 바꾼다.'], draft: ['정치 정보는 협상과 행동으로 드러낸다.'], avoid: ['설명만으로 끝나는 회의 장면'] },
      designReview: {
        settledDecisions: ['정치 성장극'],
        openQuestions: [{ id: 'first-payoff', title: '첫 보상', question: '첫 정치적 승리는 무엇인가?', recommendation: '배급권 확보' }],
      },
    });
    let profileRequest;
    const firstProvider = provider({ 'story-profile': profileJson });
    const firstComplete = firstProvider.complete.bind(firstProvider);
    firstProvider.complete = async (request) => { if (request.step === 'story-profile') profileRequest = request; return firstComplete(request); };
    const proposed = await runStoryProfile({ store, workId: 'space-court', brief: '우주 오페라 정치 성장극', mode: 'review', providers: firstProvider });
    assert.equal(proposed.needsApproval, true);
    // 명시된 relaxed 는 ko 웹소설 연재에서도 그대로 유지된다. 승인된 포맷 선택을
    // serialization 문자열 때문에 strict 로 되돌리지 않는다(다국어 기획의 "승인된
    // 작품 포맷을 따른다"). ko 기본값은 명시가 없을 때만 strict 다.
    assert.equal(proposed.profile.format.dialogueBreakMode, 'relaxed');
    assert.deepEqual(proposed.profile.designReview.openQuestions.map((item) => item.id), ['first-payoff', 'reading-experience-contract']);
    assert.deepEqual(proposed.profile.readabilityContract, {
      schemaVersion: 1, surfaceEase: 'easy', conceptPacing: 'slow', inferenceLoad: 'explicit', complexityRamp: 'onboarding-first', confirmedByUser: false,
    });
    assert.match(proposed.instruction, /feedback/);
    const revisedJson = JSON.stringify({
      ...JSON.parse(profileJson),
      readabilityContract: { surfaceEase: 'easy', conceptPacing: 'slow', inferenceLoad: 'explicit', complexityRamp: 'onboarding-first', confirmedByUser: true },
      designReview: { settledDecisions: ['첫 보상은 배급권 확보'], openQuestions: [] },
    });
    const revisedProvider = provider({ 'story-profile': revisedJson });
    const revisedComplete = revisedProvider.complete.bind(revisedProvider);
    revisedProvider.complete = async (request) => { if (request.step === 'story-profile') profileRequest = request; return revisedComplete(request); };
    const revised = await runStoryProfile({ store, workId: 'space-court', brief: '우주 오페라 정치 성장극', mode: 'review', feedback: '첫 승리는 배급권 확보. 읽기는 쉽게, 새 개념은 천천히, 표면 뜻은 명확하게, 초반 적응 뒤 복잡하게.', providers: revisedProvider });
    assert.deepEqual(revised.profile.designReview.openQuestions, []);
    assert.deepEqual(revised.profile.designReview.settledDecisions, ['정치 성장극', '첫 보상은 배급권 확보']);
    assert.deepEqual(revised.profile.designReview.askedQuestionIds, ['first-payoff', 'reading-experience-contract']);
    assert.equal(revised.profile.revision, 2);
    assert.match(profileRequest.messages[1].content, /first-payoff/);
    assert.match(profileRequest.messages[1].content, /첫 승리는 배급권 확보/);
    await runStoryProfileDecide({ store, workId: 'space-court', action: 'approve' });
    await runCreate({ store, workId: 'space-court', title: '별의 의회', brief: '몰락한 서기관이 제국 의회에 들어간다.', providers: provider({ worldbuild: WORLD, 'cast-design': CAST }) });
    const foundation = await store.loadFoundation('space-court');
    assert.equal(foundation.genre, 'sci-fi');
    const profile = await store.loadStoryProfile('space-court');
    assert.equal(profile.narrativeContract.depthMode, 'deep-world-driven');
    assert.equal(profile.povDesign.openingViewpoint, '몰락한 서기관');
    const { context, meta } = await buildContext({ store, workId: 'space-court', chapter: 1 });
    assert.match(context, /우주 오페라 정치 성장극/);
    assert.match(context, /deep-world-driven/);
    assert.match(context, /몰락한 서기관/);
    assert.match(context, /정치 정보는 협상과 행동/);
    assert.equal(meta.storyProfileStatus, 'active');
  });

  it('does not repeat the readability interview when all four choices are explicit in the brief', async () => {
    const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-profile-readable-')));
    const profileJson = JSON.stringify({
      genreLabel: '쉬운 상업 판타지', engineGenre: 'litrpg', subgenres: ['게임빙의'],
      tones: ['통쾌함'], storyEngines: ['정복'], themes: ['책임'],
      format: { pov: '1인칭', chapterChars: 5000, serialization: '웹소설 연재' },
      narrativeContract: { depthMode: 'commercial-dramatic' },
      readabilityContract: {
        surfaceEase: 'easy', conceptPacing: 'slow', inferenceLoad: 'explicit',
        complexityRamp: 'onboarding-first', confirmedByUser: true,
      },
      promptGuidance: {}, designReview: { settledDecisions: [], openQuestions: [] },
    });
    const brief = '표면 가독성은 쉬움, 새 개념은 느리게 도입하고 추론 부담은 낮춘다. 복잡성은 첫 아크 동안 완만히 상승한다.';

    const proposed = await runStoryProfile({
      store, workId: 'readable-start', brief, mode: 'review',
      providers: provider({ 'story-profile': profileJson }),
    });

    assert.equal(proposed.profile.readabilityContract.confirmedByUser, true);
    assert.deepEqual(proposed.profile.designReview.openQuestions, []);
  });

  it('keeps character agendas optional but validates a collision when one is requested', () => {
    assert.deepEqual(episodePlanningContractViolations({ cast: ['hero', 'ally'] }, ['hero', 'ally']), []);
    const collisionWithoutAgendas = {
      characterCollisions: [{ agendaIds: ['hero', 'ally'], scarceConstraint: '한 자리' }],
    };
    assert.match(episodePlanningContractViolations(collisionWithoutAgendas, ['hero', 'ally']).join(' '), /characterAgenda/);
    const independent = {
      characterAgendas: [
        { characterId: 'hero', goal: '보상을 선점한다', nextAction: '숨은 방을 연다', redLine: '소유권을 넘긴다' },
        { characterId: 'ally', goal: '자기 몫을 받는다', nextAction: '출구를 지킨다', redLine: '무상으로 싸운다' },
      ],
      characterCollisions: [{ agendaIds: ['hero', 'ally'], scarceConstraint: '하나뿐인 보상 소유권' }],
    };
    assert.deepEqual(episodePlanningContractViolations(independent, ['hero', 'ally']), []);
  });

  it('rejects every unregistered character reference before compiling an EpisodePlan', () => {
    const plan = {
      cast: ['hero', 'seo_ina'], povCharacter: 'hero',
      scenes: [{ characters: ['hero', 'seo_ina'] }],
      characterAgendas: [
        { characterId: 'hero', goal: '계약한다', nextAction: '서명한다', redLine: '집을 잃는다' },
        { characterId: 'ally', goal: '수수료를 받는다', nextAction: '조건을 건다', redLine: '무료로 돕는다' },
      ],
      characterCollisions: [{ agendaIds: ['hero', 'ally'], scarceConstraint: '보증금 하나' }],
      episodeVoiceTargets: [{ characterId: 'seo_ina', sampleLine: '계약부터 보죠.' }],
    };
    const violations = episodePlanningContractViolations(plan, ['hero', 'ally']);
    assert.match(violations.join(' '), /등록되지 않은 characterId.*seo_ina/);
  });

  it('expands an immutable arc beat into a reviewable detailed EpisodePlan', async () => {
    const store = await createdStore();
    const response = JSON.stringify({
      title: '고지서가 걷는다', premise: '윤재가 움직이는 고지서를 붙잡아 첫 세금 규칙을 알아낸다.', povCharacter: 'hero',
      cast: ['hero'], locations: ['탑 입구'], openingState: '윤재는 세금 규칙을 모른다.', closingState: '윤재는 납부 기한과 부족액을 안다.',
      scenes: [
        { location: '탑 입구', characters: ['hero'], objective: '고지서 확인', obstacle: '고지서가 도망감', turn: '체납자를 추적함', outcome: '붙잡음' },
        { location: '징수 창구', characters: ['hero'], objective: '규칙 확인', obstacle: '설명 수수료', turn: '감별 단서 발견', outcome: '채무 증가' },
      ], reveals: ['납부 기한'], withheld: ['시스템 제작자'], powerChanges: ['감별 스킬 조건 1/3'], artifacts: ['고지서 획득'],
      absurdity: '도망가는 고지서를 잡지 못하면 미수령 가산세가 붙는다.', hooksTouched: ['첫 세금'], carryForward: ['채무 10'],
      foregroundCharacters: ['hero'],
      readerLoad: { phase: 'focus', newConcepts: ['가산세', '설명 수수료', '역도장'], complexityReason: '규칙을 비교해야 한다.' },
      readerExpectation: { likelyOutcome: '윤재가 고지서를 붙잡는다', evidenceOnPage: ['고지서의 속도가 느려진다'], confidenceTarget: 'medium' },
      scenePressure: { choiceOwner: 'hero', incompatibleGoods: ['기한 준수', '채무 회피'], withheldByOther: '징수관이 수수료를 숨긴다', decisionDeadline: '창구 폐쇄 전' },
      payoff: { promisePaid: '고지서 규칙 하나를 역이용한다', proofOnPage: '도장을 거꾸로 찍어 멈춘다', notJustReported: true },
      turn: { brokenBelief: '붙잡으면 무료다', causedByChoice: '윤재가 설명을 요구한다', priorClueReinterpreted: '도장의 작은 글씨' },
      costCreatedByResolution: { immediate: '설명 수수료', deferred: '채무 증가', beneficiary: '윤재', payer: '윤재' },
      exitValue: { closedQuestion: '고지서를 잡는가', nextQuestion: '수수료를 누가 설계했는가', hookType: 'reinterpretation', specificFutureValue: '도장 문구의 다른 적용을 본다' },
    });
    const unit = createPublicationUnit({ rootDir: store.rootDir });
    const token = await unit.issueFencingToken();
    const [foundation, storyProfile, storySpine, writerSkill, arcPlan] = await Promise.all([
      store.loadFoundation('tax-tower'), store.loadStoryProfile('tax-tower'),
      store.loadStorySpine('tax-tower'), store.loadWriterSkill('tax-tower'),
      store.loadArcPlan('tax-tower'),
    ]);
    const published = await unit.publish({
      context: { snapshotId: 'genesis', expectedHead: null, storyTimeScope: { worldline: 'main', through: 0 }, publicationOrder: 1, transactionTime: new Date().toISOString(), policyRevision: 'test', semanticGeneration: 'test', fencingToken: token.value.fencingToken },
      candidate: { tree: { workId: 'tax-tower', foundation, plans: { storyProfile, storySpine, writerSkill, arcPlan } }, projections: {}, impactClosure: [] },
    });
    await saveExperienceLedgerForHead({
      store, workId: 'tax-tower', sourceHead: published.value.head,
      entries: [{ chapter: 1, sceneMode: '협상' }], criticVersion: 'test-critic',
    });
    const planned = await runEpisodePlan({ store, workId: 'tax-tower', chapter: 1, mode: 'review', providers: provider({ 'episode-plan': response }) });
    assert.equal(planned.needsApproval, true);
    assert.equal(planned.plan.arcBeat.goal, activePlan().episodes[0].goal);
    assert.equal(planned.plan.scenes.length, 2);
    assert.equal(planned.plan.exitValue.hookType, 'reinterpretation');
    assert.equal(planned.plan.readerLoad.phase, 'onboarding');
    assert.deepEqual(planned.plan.readerLoad.newConcepts, ['가산세']);
    await runEpisodeDecide({ store, workId: 'tax-tower', chapter: 1, action: 'approve' });
    const current = await unit.readPublished();
    const ledger = await store.loadExperienceLedger('tax-tower');
    assert.equal(ledger.sourceHead, current.value.head);
    assert.deepEqual(ledger.entries.map((entry) => entry.chapter), [1]);
    const { context } = await buildContext({ store, workId: 'tax-tower', chapter: 1 });
    assert.match(context, /움직이는 고지서/);
  });

  it('runs a receipt-guarded guided chapter workflow and leaves an auditable history', async () => {
    const store = await createdStore();
    await store.saveStoryProfile('tax-tower', {
      workId: 'tax-tower', status: 'active', genreLabel: '관료제 블랙코미디 성장물', engineGenre: 'litrpg',
      subgenres: ['dungeon'], tones: ['건조한 블랙코미디'], storyEngines: ['성장', '생존'], themes: [],
      format: { pov: '3인칭제한', chapterChars: 3300, serialization: '웹소설', dialogueBreakMode: 'relaxed' }, tracking: { engineBacked: [], semantic: [] },
      promptGuidance: { worldbuild: [], cast: [], arc: [], draft: ['인물의 절박함을 행동으로 쓴다.'], avoid: ['농담을 설명하지 않는다.'] },
    });
    const body = SYNTHETIC_LONG_PROSE;
    const raw = `${body}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"hero","addressTermsUsed":[]}]}⟧`;
    const base = provider({
      draft: raw, revise: revisionPatch(),
      'story-profile-check': '{"findings":[]}',
      'coherence-judge': '{"score":88,"reason":"계획대로 자연스럽게 이어진다."}',
      'chapter-summary': '{"summary":"윤재가 탑에 들어갔다.","plotBeat":"opening","sceneTags":["진입"],"povCharacter":"hero"}',
    });
    const reviseRequests = [];
    const p = { ...base, get pending() { return []; }, async complete(req) { if (req.step === 'revise') reviseRequests.push(req); return base.complete(req); } };
    const ready = await runWriteWorkflow({ store, workId: 'tax-tower', autonomy: 'guided', providers: p });
    assert.equal(ready.status, 'awaiting_approval');
    const receipt = await store.loadCheckReceipt('tax-tower', (await store.loadWorkflow('tax-tower')).checkId);
    assert.equal(receipt.proseHash, proseHash(ready.prose));
    await assert.rejects(() => runCommit({
      store, workId: 'tax-tower', chapter: 1, prose: `${ready.prose}\n변조`, summary: '변조', providers: p,
    }), { code: 'MISSING_VALIDATION_RECEIPT' });
    const revisionRequested = await runWorkflowDecide({
      store, workId: 'tax-tower', approvalId: ready.approvalId, action: 'request_revision',
      feedback: '마지막 선택의 대가를 더 선명하게 보여줘.', providers: p,
    });
    assert.equal(revisionRequested.workflowId, ready.workflowId);
    const revisedReady = await runWriteWorkflow({ store, workId: 'tax-tower', autonomy: 'guided', providers: p });
    assert.equal(revisedReady.status, 'awaiting_approval');
    assert.equal(revisedReady.workflowId, ready.workflowId);
    // 2026-09-15 en 표본: 사용자 수정 요청이 초안의 cast-manifest 없이 revise 를 불러 모델이 임의 형태를 만들었다.
    assert.equal(reviseRequests.length, 1);
    assert.match(reviseRequests[0].messages.map((m) => m.content).join('\n'), /\{"cast":\[\{"characterId":"hero","addressTermsUsed":\[\]\}\]\}/);
    const committed = await runWorkflowDecide({ store, workId: 'tax-tower', approvalId: revisedReady.approvalId, action: 'approve', providers: p });
    assert.equal(committed.status, 'completed');
    assert.equal((await store.loadArtifact('tax-tower', 1)).prose, body);
    assert.ok((await runWorkflowHistory({ store, workId: 'tax-tower' })).events.some((e) => e.event === 'chapter_committed'));
  });

  it('lore_write supplies scene continuity but hides future arc answers and engine plans from drafting', async () => {
    const store = await createdStore({ legacy: true });
    await store.saveStoryProfile('tax-tower', {
      workId: 'tax-tower', status: 'active', genreLabel: '관료제 성장물', engineGenre: 'litrpg',
      subgenres: [], tones: [], storyEngines: ['성장'], themes: [],
      format: { pov: '3인칭제한', chapterChars: 1600, serialization: '웹소설', dialogueBreakMode: 'relaxed' },
      tracking: { engineBacked: [], semantic: [] },
      promptGuidance: { worldbuild: [], cast: [], arc: [], draft: [], avoid: [] },
    });
    const arc = activePlan();
    arc.episodes[2] = { ...arc.episodes[2], goal: 'FUTURE_ARC_BEAT_TOKEN을 회수한다.' };
    await store.saveArcPlan('tax-tower', arc);
    await runCommit({
      store, workId: 'tax-tower', chapter: 1,
      prose: '윤재는 첫 고지서를 접었다.\n\nPREVIOUS_SCENE_TAIL_TOKEN을 쥔 채 문 앞에서 멈췄다.',
      summary: '윤재가 첫 고지서를 받고 문 앞에 멈췄다.', providers: createHostRelay({}), delta: emptyDelta(1),
    });
    const ep2 = { ...activeEpisodePlan(), chapter: 2, arcEpisodeIndex: 2, title: '두 번째 고지' };
    await store.saveEpisodePlan('tax-tower', ep2);

    const requests = [];
    const p = { register() {}, has() { return true; }, get pending() { return []; }, async complete(req) {
      const proof = contractResponse(req) ?? approvalResponse(req);
      if (proof) return proof;
      requests.push(req);
      if (req.step === 'chapter-plan') return { text: JSON.stringify({ plan: 'ENGINE_CHAPTER_PLAN_TOKEN을 따라 문을 연다.', scene: { settings: [], characters: ['hero'], items: [], antagonists: [], additionalRefs: [] }, tension: { stake: '퇴로' } }) };
      if (req.step === 'draft') {
        const fragmented = Array.from({ length: 20 }, (_, index) => `윤재는 ${index + 1}번째 문을 확인했다.`).join('\n\n');
        return { text: `${fragmented}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"hero","addressTermsUsed":[]}]}⟧` };
      }
      if (req.step === 'coherence-judge') return { text: '{"score":90,"reason":"연결됨"}' };
      if (req.step === 'chapter-summary') return { text: '{"summary":"윤재가 문을 열었다.","plotBeat":"rising","sceneTags":[],"povCharacter":"hero"}' };
      if (req.step === 'story-profile-check') return { text: '{"findings":[]}' };
      return planningResponse(req) ?? { text: REVIEW_RESPONSES[req.step] ?? '{}' };
    } };
    await runWriteWorkflow({ store, workId: 'tax-tower', autonomy: 'guided', providers: p });
    const chapterPlan = requests.find((req) => req.step === 'chapter-plan');
    const draft = requests.find((req) => req.step === 'draft');
    assert.equal(chapterPlan, undefined, 'engine chapter-plan 답변은 초고 프롬프트에 쓰이지 않으므로 요청하지 않는다');
    const prompt = draft.messages.map((m) => m.content).join('\n');
    assert.match(prompt, /PREVIOUS_SCENE_TAIL_TOKEN/);
    assert.doesNotMatch(prompt, /FUTURE_ARC_BEAT_TOKEN/);
    assert.doesNotMatch(prompt, /ENGINE_CHAPTER_PLAN_TOKEN/);
    assert.match(prompt, /Author Craft Packet/);
    assert.match(prompt, /Reader Contract/);
    assert.match(prompt, /Episode Core/);
    assert.match(prompt, /Writer Freedom/);
    assert.match(prompt, /확인 → 세금 → 고지/);
    assert.doesNotMatch(prompt, /## 인과 진행/);
    assert.doesNotMatch(prompt, /"scenePressure"|createdAt|"revision"/);
    const workflow = await store.loadWorkflow('tax-tower');
    assert.match(workflow.contextAudit.episodeObligationHash, /^sha256:[0-9a-f]{64}$/);
    assert.ok(workflow.contextAudit.episodePacketTokens > 0);
    assert.ok(workflow.contextAudit.episodePacketTrace.includedFields.includes('payoff.promisePaid'));
    assert.ok(workflow.contextAudit.episodePacketTrace.derivedFields.some((item) => item.field === 'payoff.promisePaid'));
    assert.ok(workflow.contextAudit.episodePacketTrace.omittedFields.includes('createdAt'));
  });

  it('preflight starts with StoryIdentity and does not leak placeholders into later stages', async () => {
    const store = await createdStore();
    await store.saveStoryProfile('tax-tower', {
      workId: 'tax-tower', status: 'active', genreLabel: '성장물', engineGenre: 'litrpg',
      subgenres: [], tones: [], storyEngines: ['성장'], themes: [],
      format: { pov: '3인칭제한', chapterChars: 3000, serialization: '웹소설', dialogueBreakMode: 'relaxed' },
      tracking: { engineBacked: [], semantic: [] },
      promptGuidance: { worldbuild: [], cast: [], arc: [], draft: [], avoid: [] },
    });
    const relay = createPreflightRelay({});
    const result = await runWriteWorkflow({ store, workId: 'tax-tower', autonomy: 'auto', providers: relay });
    assert.equal(result.preview, true);
    assert.equal(result.operation, 'story_identity');
    assert.deepEqual(relay.pending.map((request) => request.step), ['story-identity']);
  });

  it('lore_write carries the planned character beat into prose context and persists its cursor', async () => {
    const store = await createdStore();
    await store.saveStoryProfile('tax-tower', {
      workId: 'tax-tower', status: 'active', genreLabel: '성장물', engineGenre: 'litrpg',
      subgenres: [], tones: [], storyEngines: ['성장'], themes: [],
      format: { pov: '3인칭제한', chapterChars: 3300, serialization: '웹소설', dialogueBreakMode: 'relaxed' }, tracking: { engineBacked: [], semantic: [] },
      promptGuidance: { worldbuild: [], cast: [], arc: [], draft: [], avoid: [] },
    });
    const arc = activePlan();
    arc.characterArcs = [{
      characterId: 'hero', promise: '누명 때문에 타인을 믿지 못하는 윤재가 도움을 받아들이게 된다.',
      beats: [{ episodeIndex: 1, beat: 'wound', note: '동료의 선의를 세금 함정으로 오해한다.' }],
    }];
    await store.saveArcPlan('tax-tower', arc);
    // Force lore_write to generate the per-chapter plan so the arc beat must cross that seam.
    await store.saveEpisodePlan('tax-tower', { ...(await store.loadEpisodePlan('tax-tower', 1)), status: 'rejected' });
    const requests = [];
    const episode = {
      title: '첫 상처', premise: '윤재가 동료의 도움을 의심한다.', povCharacter: 'hero', cast: ['hero'], locations: ['탑 입구'],
      openingState: '윤재가 혼자 버틴다.', closingState: '도움을 거절해 위험이 커진다.', tension: { stake: '동료의 신뢰' },
      scenes: [{ location: '탑 입구', characters: ['hero'], situation: '동료가 손을 내민다.', choice: '거절한다.', change: '혼자 남는다.' }, { location: '문 앞', characters: ['hero'], situation: '문이 닫힌다.', choice: '혼자 민다.', change: '부상한다.' }],
      reveals: [], withheld: [], powerChanges: [], artifacts: [], absurdity: '', hooksTouched: [], carryForward: ['불신'],
    };
    const longBody = SYNTHETIC_LONG_PROSE;
    const p = { register() {}, has() { return true; }, get pending() { return []; }, async complete(req) {
      const proof = contractResponse(req) ?? approvalResponse(req);
      if (proof) return proof;
      requests.push(req);
      if (req.step === 'episode-plan') return { text: JSON.stringify(episode) };
      if (req.step === 'chapter-plan') return { text: '{"plan":"상처를 장면으로 보인다.","scene":{"settings":[],"characters":["hero"],"items":[],"antagonists":[],"additionalRefs":[]},"tension":{}}' };
      if (req.step === 'draft') return { text: `${longBody}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"hero","addressTermsUsed":[]}]}⟧` };
      if (req.step === 'revise') return { text: revisionPatch() };
      if (req.step === 'coherence-judge') return { text: '{"score":90,"reason":"연결됨"}' };
      if (req.step === 'chapter-summary') return { text: '{"summary":"윤재가 도움을 거절하고 혼자 문을 밀다 다쳤다.","plotBeat":"opening","sceneTags":[],"povCharacter":"hero"}' };
      if (req.step === 'story-profile-check') return { text: '{"findings":[]}' };
      return planningResponse(req) ?? { text: REVIEW_RESPONSES[req.step] ?? '{}' };
    } };
    const result = await runWriteWorkflow({ store, workId: 'tax-tower', autonomy: 'auto', providers: p });
    assert.equal(result.status, 'completed', JSON.stringify({ degraded: result.degraded, failedReviews: result.quality?.review?.records?.filter(r => r.status === 'failed').map(r => ({ step: r.step, failure: r.failure })) }));
    const draftPrompt = requests.find((req) => req.step === 'draft').messages.map((m) => m.content).join('\n');
    assert.match(draftPrompt, /wound/);
    assert.match(draftPrompt, /동료의 선의를 세금 함정으로 오해/);
    const state = await store.loadStoryState('tax-tower', 1);
    assert.equal(state.arcCursor.hero.beat, 'wound');
  });

  it('lore_write can iterate an unfinished episode without consuming the next arc beat', async () => {
    const store = await createdStore();
    await store.saveStoryProfile('tax-tower', {
      workId: 'tax-tower', status: 'active', genreLabel: '성장물', engineGenre: 'litrpg', subgenres: [], tones: [], storyEngines: ['성장'], themes: [],
      format: { pov: '3인칭제한', chapterChars: 3300, serialization: '웹소설', dialogueBreakMode: 'relaxed' }, tracking: { engineBacked: [], semantic: [] },
      promptGuidance: { worldbuild: [], cast: [], arc: [], draft: [], avoid: [] },
    });
    const body = SYNTHETIC_LONG_PROSE;
    const requests = [];
    const p = { register() {}, has() { return true; }, get pending() { return []; }, async complete(req) {
      const proof = contractResponse(req) ?? approvalResponse(req);
      if (proof) return proof;
      requests.push(req);
      if (req.step === 'chapter-plan') return { text: '{"plan":"첫 고지의 위기를 전개한다.","scene":{"settings":[],"characters":["hero"],"items":[],"antagonists":[],"additionalRefs":[]},"tension":{}}' };
      if (req.step === 'draft') return { text: `${body}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"hero","addressTermsUsed":[]}]}⟧` };
      if (req.step === 'revise') return { text: revisionPatch() };
      if (req.step === 'coherence-judge') return { text: '{"score":90,"reason":"연결됨"}' };
      if (req.step === 'narrative-boundary') return { text: '{"decision":"iterate_episode","reason":"현재 위기의 선택과 결과가 아직 장면으로 끝나지 않았다.","continuation":{"title":"첫 고지 (계속)","beat":"윤재가 미완의 위기를 끝까지 통과한다.","pressure":"퇴로가 닫힌다.","turn":"혼자 해결할 수 없음을 인정한다.","carry":"다음 아크 비트로 넘어갈 상태가 된다."}}' };
      if (req.step === 'chapter-summary') return { text: '{"summary":"윤재의 첫 위기가 아직 끝나지 않았다.","plotBeat":"rising","sceneTags":[],"povCharacter":"hero"}' };
      if (req.step === 'story-profile-check') return { text: '{"findings":[]}' };
      return planningResponse(req) ?? { text: REVIEW_RESPONSES[req.step] ?? '{}' };
    } };
    const result = await runWriteWorkflow({ store, workId: 'tax-tower', autonomy: 'auto', providers: p });
    assert.equal(result.status, 'completed', JSON.stringify({ degraded: result.degraded, failedReviews: result.quality?.review?.records?.filter(r => r.status === 'failed').map(r => ({ step: r.step, failure: r.failure })) }));
    assert.ok(requests.some((req) => req.step === 'narrative-boundary'));
    const arc = await store.loadArcPlan('tax-tower');
    assert.equal(arc.status, 'active');
    assert.equal(arc.estimatedEpisodes, 4);
    assert.equal(arc.episodes[1].chapter, 2);
    assert.equal(arc.episodes[1].iteration, 2);
    assert.match(arc.episodes[1].beat, /미완의 위기/);
    assert.equal(arc.episodes[2].chapter, 3, '원래 두 번째 비트는 뒤로 밀려야 한다');
  });

  it('lore_write revises a short draft until it satisfies the configured chapter length', async () => {
    const store = await createdStore();
    await store.saveStoryProfile('tax-tower', {
      workId: 'tax-tower', status: 'active', genreLabel: '성장물', engineGenre: 'litrpg', subgenres: [], tones: [], storyEngines: ['성장'], themes: [],
      format: { pov: '3인칭제한', chapterChars: 1000, serialization: '웹소설', dialogueBreakMode: 'relaxed' }, tracking: { engineBacked: [], semantic: [] },
      promptGuidance: { worldbuild: [], cast: [], arc: [], draft: [], avoid: [] },
    });
    const fixture = SYNTHETIC_LONG_PROSE;
    const revisedBody = fixture.slice(0, 1050);
    const requests = [];
    const p = { register() {}, has() { return true; }, get pending() { return []; }, async complete(req) {
      const proof = contractResponse(req) ?? approvalResponse(req);
      if (proof) return proof;
      requests.push(req);
      if (req.step === 'chapter-plan') return { text: '{"plan":"전진한다.","scene":{"settings":[],"characters":["hero"],"items":[],"antagonists":[],"additionalRefs":[]},"tension":{}}' };
      if (req.step === 'draft') return { text: '윤재는 문을 열었다.\n\n⟦vle:cast-manifest {"cast":[{"characterId":"hero","addressTermsUsed":[]}]}⟧' };
      if (req.step === 'revise') return { text: revisionPatch({ insertions: [{ afterParagraph: 1, text: revisedBody }] }) };
      if (req.step === 'coherence-judge') return { text: '{"score":90,"reason":"연결됨"}' };
      if (req.step === 'editorial-quality') return { text: JSON.stringify({
        score: 88,
        dimensions: { sceneContinuity: 90, characterVoice: 85, setupPayoff: 85, sceneDepth: 88, proseIdentity: 82, consequenceResidue: 82 },
        findings: [{ dimension: 'consequenceResidue', code: 'CLEAN_CONFLICT_RESET', message: '충돌의 후속이 사라졌다.', evidence: '직전 공격 뒤 곧바로 농담한다.', confidence: 0.91 }],
      }) };
      if (req.step === 'narrative-boundary') return { text: '{"decision":"advance_episode","reason":"현재 비트가 끝났다."}' };
      if (req.step === 'chapter-summary') return { text: '{"summary":"윤재가 전진했다.","plotBeat":"opening","sceneTags":[],"povCharacter":"hero"}' };
      if (req.step === 'story-profile-check') return { text: '{"findings":[]}' };
      return planningResponse(req) ?? { text: REVIEW_RESPONSES[req.step] ?? '{}' };
    } };
    const result = await runWriteWorkflow({ store, workId: 'tax-tower', autonomy: 'guided', providers: p });
    assert.equal(result.status, 'awaiting_approval');
    assert.ok(requests.some((req) => req.step === 'revise'), '짧은 초고는 수정 단계를 반드시 거쳐야 한다');
    assert.ok(result.quality.advisories.some((item) => item.code === 'CLEAN_CONFLICT_RESET'));
    const revisePrompt = requests.find((req) => req.step === 'revise').messages.map((message) => message.content).join('\n');
    assert.doesNotMatch(revisePrompt, /충돌의 후속이 사라졌다/, '독립 advisory는 다른 수정 사유가 있어도 자동 수정 지시로 전달하지 않는다');
    assert.doesNotMatch(revisePrompt, /WEBNOVEL_FRAGMENTED_RHYTHM/, '문체 취향 advisory는 확정 위반 수정에 함께 전달하지 않는다');
    assert.match(revisePrompt, /수정 한도/);
    assert.match(revisePrompt, /QUALITY_GATE_LENGTH/);
    assert.match(revisePrompt, /기존 문단을 유지하고 insertion/);
    assert.match(revisePrompt, /현재 cast-manifest[\s\S]*\{"cast"/);
    assert.doesNotMatch(revisePrompt, /⟦\/vle:cast-manifest⟧/);
    assert.equal(requests.find((req) => req.step === 'revise').jsonMode, true);
    assert.ok(requests.some((req) => req.step === 'editorial-quality'));
    assert.ok(result.prose.length >= 850 && result.prose.length <= 1150);
    assert.equal(result.quality.editorial, 88);
    const candidates = await store.loadRevisionCandidates('tax-tower', result.workflowId);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[1].gatePassed, true);
  });

  it('lore_write does not revise solely because a draft exceeds the configured chapter length', async () => {
    const store = await createdStore();
    await store.saveStoryProfile('tax-tower', {
      workId: 'tax-tower', status: 'active', genreLabel: '성장물', engineGenre: 'litrpg', subgenres: [], tones: [], storyEngines: ['성장'], themes: [],
      format: { pov: '3인칭제한', chapterChars: 1000, serialization: '웹소설', dialogueBreakMode: 'relaxed' }, tracking: { engineBacked: [], semantic: [] },
      promptGuidance: { worldbuild: [], cast: [], arc: [], draft: [], avoid: [] },
    });
    const fixture = SYNTHETIC_LONG_PROSE;
    const longBody = fixture.slice(0, 1600);
    const requests = [];
    const p = { register() {}, has() { return true; }, get pending() { return []; }, async complete(req) {
      const proof = contractResponse(req) ?? approvalResponse(req);
      if (proof) return proof;
      requests.push(req);
      if (req.step === 'chapter-plan') return { text: '{"plan":"전진한다.","scene":{"settings":[],"characters":["hero"],"items":[],"antagonists":[],"additionalRefs":[]},"tension":{}}' };
      if (req.step === 'draft') return { text: `${longBody}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"hero","addressTermsUsed":[]}]}⟧` };
      if (req.step === 'coherence-judge') return { text: '{"score":90,"reason":"연결됨"}' };
      if (req.step === 'editorial-quality') return { text: '{"score":88,"dimensions":{"sceneContinuity":90,"characterVoice":85,"setupPayoff":85,"sceneDepth":88,"proseIdentity":82},"findings":[]}' };
      if (req.step === 'narrative-boundary') return { text: '{"decision":"advance_episode","reason":"현재 비트가 끝났다."}' };
      if (req.step === 'chapter-summary') return { text: '{"summary":"윤재가 전진했다.","plotBeat":"opening","sceneTags":[],"povCharacter":"hero"}' };
      if (req.step === 'story-profile-check') return { text: '{"findings":[]}' };
      return planningResponse(req) ?? { text: REVIEW_RESPONSES[req.step] ?? '{}' };
    } };
    const result = await runWriteWorkflow({ store, workId: 'tax-tower', autonomy: 'guided', providers: p });
    assert.equal(result.status, 'awaiting_approval');
    assert.equal(requests.some((req) => req.step === 'revise'), false, '상한 초과만으로는 수정 단계를 거치지 않는다');
    assert.ok(result.prose.length > 1150);
    const candidates = await store.loadRevisionCandidates('tax-tower', result.workflowId);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].gatePassed, true);
  });

  it('replays a five-chapter arc with scene carryover, character beats, length, and final closure', async () => {
    const store = await createdStore();
    await store.saveStoryProfile('tax-tower', {
      workId: 'tax-tower', status: 'active', genreLabel: '성장물', engineGenre: 'litrpg', subgenres: [], tones: [], storyEngines: ['성장'], themes: [],
      format: { pov: '3인칭제한', chapterChars: 1000, serialization: '웹소설', dialogueBreakMode: 'relaxed' }, tracking: { engineBacked: [], semantic: [] },
      promptGuidance: { worldbuild: [], cast: [], arc: [], draft: [], avoid: [] },
    });
    const beatNames = ['wound', 'attempt', 'collapse', 'companion', 'self-choice'];
    const arc = {
      ...activePlan(), estimatedEpisodes: 5,
      episodes: Array.from({ length: 5 }, (_, i) => ({
        index: i + 1, chapter: i + 1, title: `${i + 1}화`, beat: `ARC_BEAT_${i + 1}`,
        pressure: `압력 ${i + 1}`, turn: `전환 ${i + 1}`, carry: `전달 ${i + 1}`,
        goal: `ARC_BEAT_${i + 1}`, conflict: `압력 ${i + 1}`, growth: '', cost: '', hook: `전달 ${i + 1}`, status: 'pending',
      })),
      characterArcs: [{ characterId: 'hero', promise: '윤재가 고립에서 벗어나 동료를 선택한다.', beats: beatNames.map((beat, i) => ({ episodeIndex: i + 1, beat, note: `CHARACTER_BEAT_${i + 1}` })) }],
    };
    await store.saveArcPlan('tax-tower', arc);
    for (let chapter = 1; chapter <= 5; chapter += 1) {
      await store.saveEpisodePlan('tax-tower', {
        ...activeEpisodePlan(), chapter, arcEpisodeIndex: chapter, title: `${chapter}화 계획`,
        characterArcBeats: [{ characterId: 'hero', promise: arc.characterArcs[0].promise, beat: beatNames[chapter - 1], note: `CHARACTER_BEAT_${chapter}` }],
      });
    }
    const fixture = SYNTHETIC_LONG_PROSE;
    const base = fixture.slice(0, 1000);
    for (let chapter = 1; chapter <= 5; chapter += 1) {
      const requests = [];
      const p = { register() {}, has() { return true; }, get pending() { return []; }, async complete(req) {
      const proof = contractResponse(req) ?? approvalResponse(req);
      if (proof) return proof;
        requests.push(req);
        if (req.step === 'story-identity') return { text: JSON.stringify({ readerPromise: 'IDENTITY_PROMISE_TOKEN', protagonistAppeal: '대가를 계산하지만 사람은 계산하지 못한다.', competenceSignature: ['불완전한 장부를 현장에서 검증한다.'], emotionalDefect: '호의를 부채로 오해한다.', comedyEngines: ['절박한 생존과 행정 절차의 충돌'], solutionPatternsToRotate: ['환경 이용', '협상', '손실 교환'] }) };
        if (req.step === 'pilot-contract') return { text: JSON.stringify({ beforeState: '평범한 체납자', firstFailure: 'PILOT_FAILURE_TOKEN', protagonistSpecificAction: '틀린 장부를 직접 시험한다.', irreversibleChoice: '동료의 채무를 인수한다.', competenceProof: '오차를 발견하고 수정한다.', humanHook: '타인을 믿을 수 있는가', seriesPromise: '계산과 신뢰의 충돌', closingQuestion: '빚진 사람을 구할 수 있는가' }) };
        if (req.step === 'chapter-plan') return { text: JSON.stringify({ plan: `ENGINE_PLAN_${chapter}`, scene: { settings: [], characters: ['hero'], items: [], antagonists: [], additionalRefs: [] }, tension: {} }) };
        if (req.step === 'draft') return { text: `${base}\nCHAPTER_${chapter}_TAIL_TOKEN\n\n⟦vle:cast-manifest {"cast":[{"characterId":"hero","addressTermsUsed":[]}]}⟧` };
        if (req.step === 'revise') return { text: revisionPatch() };
        if (req.step === 'coherence-judge') return { text: '{"score":90,"reason":"연결됨"}' };
        if (req.step === 'editorial-quality') return { text: '{"score":88,"dimensions":{"sceneContinuity":88,"characterVoice":88,"setupPayoff":88,"sceneDepth":88,"proseIdentity":88},"findings":[]}' };
        if (req.step === 'reader-hook') return { text: '{"score":90,"dimensions":{"protagonistAttachment":90,"competenceProof":90,"choiceAndCost":90,"supportingAgency":90,"nextChapterPull":90},"findings":[]}' };
        if (req.step === 'pattern-ledger') return { text: JSON.stringify({ solutionPattern: `해결-${chapter}`, comedyMechanism: `코미디-${chapter}`, protagonistMethod: `판단-${chapter}`, mistakeAndCorrection: `오차-${chapter}`, supportingAgency: { ally: `선택-${chapter}` } }) };
        if (req.step === 'narrative-boundary') return { text: JSON.stringify({ decision: chapter === 5 ? 'complete_arc' : 'advance_episode', reason: chapter === 5 ? '아크 약속이 정산됐다.' : '현재 비트가 끝났다.' }) };
        if (req.step === 'chapter-summary') return { text: JSON.stringify({ summary: `${chapter}화가 이어졌다.`, plotBeat: chapter === 5 ? 'climax' : 'rising', sceneTags: [], povCharacter: 'hero' }) };
        if (req.step === 'story-profile-check') return { text: '{"findings":[]}' };
        return planningResponse(req) ?? { text: REVIEW_RESPONSES[req.step] ?? '{}' };
      } };
      const result = await runWriteWorkflow({ store, workId: 'tax-tower', autonomy: 'auto', providers: p });
      assert.equal(result.status, 'completed', JSON.stringify({ degraded: result.degraded, failedReviews: result.quality?.review?.records?.filter(r => r.status === 'failed').map(r => ({ step: r.step, failure: r.failure })) }));
      assert.ok(result.quality.chars >= 850 && result.quality.chars <= 1150);
      const prompt = requests.find((req) => req.step === 'draft').messages.map((m) => m.content).join('\n');
      if (chapter < 5) assert.doesNotMatch(prompt, /ARC_BEAT_5/, '초고에는 미래 비트의 정답을 숨겨야 한다');
      else assert.match(prompt, /ARC_BEAT_5/, '현재 화 비트는 Writer Packet에 포함되어야 한다');
      assert.match(prompt, /IDENTITY_PROMISE_TOKEN/);
      if (chapter === 1) assert.doesNotMatch(prompt, /PILOT_FAILURE_TOKEN/);
      assert.match(prompt, new RegExp(`CHARACTER_BEAT_${chapter}`));
      if (chapter > 1) assert.match(prompt, new RegExp(`CHAPTER_${chapter - 1}_TAIL_TOKEN`));
    }
    const state = await store.loadStoryState('tax-tower', 5);
    assert.equal(state.arcCursor.hero.beat, 'self-choice');
    assert.equal((await store.loadArcPlan('tax-tower')).status, 'completed');
    assert.equal((await store.loadPatternLedger('tax-tower')).length, 5);
    assert.equal((await store.loadStoryIdentity('tax-tower')).readerPromise, 'IDENTITY_PROMISE_TOKEN');
    assert.equal((await store.loadPilotContract('tax-tower')).firstFailure, 'PILOT_FAILURE_TOKEN');
  });

});

function activePlan() {
  return {
    workId: 'tax-tower', arcNumber: 1, title: '첫 체납', promise: '윤재가 첫 원정을 마친다.', type: 'small',
    startChapter: 1, estimatedEpisodes: 3, status: 'active', createdAt: new Date(0).toISOString(),
    episodes: [1, 2, 3].map((index) => ({ index, chapter: index, title: `${index}화`, goal: '전진', conflict: '세금', growth: '감별', cost: '채무', hook: '다음 고지', status: 'pending' })),
  };
}

function activeEpisodePlan() {
  return {
    workId: 'tax-tower', chapter: 1, arcNumber: 1, arcEpisodeIndex: 1,
    arcBeat: { title: '1화', goal: '전진', conflict: '세금', growth: '감별', cost: '채무', hook: '다음 고지' },
    title: '첫 고지', premise: '윤재가 세금 규칙을 체험한다.', povCharacter: 'hero', cast: ['hero'], locations: ['탑 입구'],
    openingState: '규칙을 모른다.', closingState: '납부 기한을 안다.',
    scenes: [
      { order: 1, location: '탑 입구', characters: ['hero'], objective: '확인', obstacle: '세금', turn: '고지', outcome: '채무' },
      { order: 2, location: '창구', characters: ['hero'], objective: '납부', obstacle: '부족', turn: '감별', outcome: '조건 획득' },
    ], reveals: [], withheld: [], powerChanges: [], artifacts: [], absurdity: '설명에도 수수료가 붙는다.', hooksTouched: [], carryForward: [],
    episodeVoiceTargets: [{
      characterId: 'hero',
      sceneOrder: 1,
      speakingPressure: '징수관 앞에서 체납 사실을 숨겨야 한다',
      surfaceIntent: '규칙을 확인한다',
      hiddenIntent: '납부 불능을 들키지 않는다',
      sampleLine: 'VOICE_TARGET_TOKEN 총액부터 확인하겠습니다.',
      narrationFilter: '윤재는 사람 표정보다 고지서 숫자를 먼저 본다',
    }],
    status: 'active', revision: 1, createdAt: new Date(0).toISOString(),
  };
}

function emptyDelta(chapterNumber) {
  return { chapterNumber, appearedCharacterIds: [], mutableChanges: [], newAddressEntries: [], relationshipOps: [], hookChanges: [], trackedEntityOps: [], entityOps: [], lexiconAdditions: [] };
}


describe('approved multilingual profile length reaches foundation creation unchanged', () => {
  for (const [language, length, text] of [
    ['en', { unit: 'graphemes', target: 3000 }, 'A concrete choice carries a visible cost.'],
    ['ja', { unit: 'graphemes', target: 3000 }, '具体的な選択には目に見える代償がある。'],
    ['zh-Hant', { unit: 'graphemes', target: 3000 }, '具體的選擇帶來看得見的代價。'],
    ['en', { unit: 'words', target: 900 }, 'A concrete choice carries a visible cost.'],
  ]) it(`${language} ${length.unit} profile → create preserves the structured length unit`, async () => {
    const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'profile-create-length-')));
    const workId = 'structured-length';
    const localize = value => Array.isArray(value) ? value.map(localize)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key,item]) => [key, localize(item)]))
      : typeof value === 'string' && /[가-힣]/.test(value) ? text : value;
    const cast = localize(JSON.parse(CAST));
    const requests = [];
    const providers = { pending: [], async complete(request) {
      requests.push(request);
      const approval = approvalResponse(request); if (approval) return approval;
      const values = {
        'story-profile': { genreLabel: text, engineGenre: 'other', format: { pov: '3인칭제한' }, narrativeContract: { depthMode: 'commercial-dramatic' }, promptGuidance: {}, designReview: { settledDecisions: [text], openQuestions: [] } },
        worldbuild: { premise: text, worldFacts: [{ id: 'fact-1', statement: text }] },
        'cast-design': cast,
        'entity-seed': { entities: [] },
      };
      assert.ok(values[request.step], `unexpected request ${request.step}`);
      return { text: JSON.stringify(values[request.step]) };
    } };
    const profiled = await runStoryProfile({ store, workId, language, length, brief: text, mode: 'auto', providers });
    assert.equal(profiled.profile.status, 'active', JSON.stringify(profiled));
    assert.deepEqual(profiled.profile.format.length, length);
    const created = await runCreate({ store, workId, title: text, brief: text, providers });
    assert.equal(created.created, true, JSON.stringify(created));
    assert.deepEqual(created.length, length);
    const accepted = await store.loadAcceptedCreation(workId);
    assert.deepEqual(accepted.workContract.length, length);
    const foundation = await store.loadFoundation(workId);
    assert.equal(foundation.language, language);
    assert.deepEqual(foundation.workContract.length, length);
    const worldRequest = requests.find(request => request.step === 'worldbuild');
    assert.ok(worldRequest); assert.match(JSON.stringify(worldRequest), new RegExp(length.unit));
    assert.equal(requests.filter(request => request.step === 'approval-language-contract').length, 2);
  });
});
