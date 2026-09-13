import { approvalResponse, approvalFixtureProvider } from './fixtures/approval-response.js';
/**
 * 다국어 Phase 2A — 플러그인 프롬프트 계열과 언어 전달.
 *
 * 확인하는 것: 최종 provider 메시지 기준으로 ko 는 그대로, 비ko 는 영어 지시 +
 * 검증된 목표 언어 지시문이라는 것. 작품 데이터·기계 enum 은 번역하지 않는다는 것.
 * 그리고 읽기 난도 답변 인식, 대사 정책, 승인 분량 렌더링.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runInit } from '../src/tools/init.js';
import { runStoryProfile, renderStoryProfile, recognizeReadabilityAnswer } from '../src/tools/story-profile.js';
import { runArcPlan } from '../src/tools/arc.js';
import { runEpisodePlan } from '../src/tools/episode-plan.js';
import { runStorySpine } from '../src/tools/story-spine.js';
import { runWriterSkill } from '../src/tools/writer-skill.js';
import { runEditorialQuality } from '../src/tools/editorial-quality.js';
import { runCharacterFidelity } from '../src/tools/character-fidelity.js';
import { runNarrativeBoundary } from '../src/tools/narrative-boundary.js';
import { runReaderHook, runPatternAnalysis } from '../src/tools/story-experience.js';
import { runEraResearchTool } from '../src/tools/era-research.js';
import { buildContext } from '../src/tools/context.js';
import { compileWriterEpisodePacket } from '../src/core/writer-episode-packet.js';
import { compileDraftContract } from '../src/core/narrative-contract.js';
import { compileDraftInputs } from '../src/core/draft-input-compiler.js';
import { promptKit, PROMPT_STEPS } from '../src/prompts/index.js';
import * as ko from '../src/prompts/ko.js';
import * as multilingual from '../src/prompts/multilingual.js';

const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
/** 소스 코드가 비교하는 한국어 기계 값. 번역 대상이 아니므로 검사에서 제외한다. */
const MACHINE_ENUMS = ['3인칭제한', '1인칭', '전지적', '다중시점'];
const withoutMachineEnums = (text) => MACHINE_ENUMS.reduce((acc, value) => acc.split(value).join('<enum>'), String(text));

function assertNoKoreanInstructions(messages, label) {
  for (const message of messages) {
    const stripped = withoutMachineEnums(message.content);
    assert.equal(HANGUL.test(stripped), false,
      `${label}: 비ko 최종 메시지(${message.role})에 한국어 지시가 남아 있다 -> ${stripped.slice(0, 220)}`);
  }
}

/** 마지막 provider 요청을 그대로 붙잡는다. */
function capturingProvider(outputs = {}) {
  const requests = [];
  return {
    requests,
    register() {}, has() { return true; },
    get pending() { return []; },
    async complete(request) {
      requests.push(request);
      const approved = approvalResponse(request);
      if (approved) return approved;
      const fallback = request.step === 'arc-quality'
        ? JSON.stringify({ score: 90, verdict: 'pass', findings: [], dimensions: { premisePressure: 90, causalEscalation: 90, expectationRenewal: 90, characterAgency: 90, oppositionAdaptation: 90, payoffSurprise: 90, serialMomentum: 90 } })
        : '{}';
      return { text: outputs[request.step] ?? fallback };
    },
    last(step) {
      const found = [...requests].reverse().find((request) => request.step === step);
      assert.ok(found, `${step} 요청이 없다`);
      return found;
    },
  };
}

const PROFILE_RESPONSE = {
  genreLabel: 'quiet office drama',
  engineGenre: 'other',
  format: { pov: '3인칭제한', serialization: 'web serial' },
  narrativeContract: { depthMode: 'commercial-dramatic' },
  promptGuidance: {},
  designReview: { settledDecisions: [], openQuestions: [] },
};

async function newStore(tag) {
  return new MarkdownStateStore(await mkdtemp(join(tmpdir(), `vibelore-prompt-${tag}-`)));
}

/** 비ko 신작 하나를 실제 저장소에 만든다. 작품 데이터는 목표 언어로 둔다. */
async function jaStore() {
  const store = await newStore('ja');
  await runInit({ providers: approvalFixtureProvider(),
    store, workId: 'w', genre: 'other', language: 'ja', povMode: '3인칭제한',
    worldFacts: ['塔は税を集める。'],
  });
  const foundation = await store.loadFoundation('w');
  await store.saveFoundation({
    ...foundation,
    title: '灯台の帳簿',
    characters: [{
      id: 'hero', canonicalName: '灯里', aliases: [], registeredAtChapter: 1,
      contradiction: '生きるために強くなるほど死に近づく。',
      description: '静かな書記官。',
      intrinsic: { role: 'protagonist', coreAppearance: [] },
      dramaticModel: { valueOrder: ['生存'] },
      speechProfile: { defaultRegister: '丁寧語', samples: { everyday: '先に総額を見ましょう。' } },
      mutable: { status: 'alive', knownFacts: [] }, relationships: [],
    }],
  });
  await store.saveStoryProfile('w', {
    workId: 'w', status: 'active', revision: 1, language: 'ja',
    engineGenre: 'other', genreLabel: '静かな官僚劇', subgenres: [], tones: ['静謐'], storyEngines: ['生存'], themes: [],
    tracking: { semantic: [], engineBacked: [] },
    format: { pov: '3인칭제한', length: { unit: 'graphemes', target: 2400 }, serialization: 'web serial', dialogueBreakMode: 'natural' },
    narrativeContract: { depthMode: 'commercial-dramatic', readerPromise: '帳簿が人を変える約束' },
    readabilityContract: { schemaVersion: 1, surfaceEase: 'easy', conceptPacing: 'slow', inferenceLoad: 'explicit', complexityRamp: 'onboarding-first', confirmedByUser: true },
    voiceContract: { genreVoiceRecipe: { narration: '短く事実から書く。' }, narrationExamples: [{ situation: '帳簿', example: '数字が先に動いた。' }], dialogueExamples: [] },
    promptGuidance: { worldbuild: [], cast: [], arc: [], draft: ['数字を行動で見せる。'], avoid: ['説明だけの会議'] },
    povDesign: { mode: '3인칭제한', openingViewpoint: '灯里', viewpointReason: '帳簿を見るのは彼女だけ。' },
  });
  await store.saveStorySpine('w', { status: 'active', dramaticQuestion: '誰が帳簿を守るのか', causalChain: ['告知を受ける', '抜け道を使う', '徴収官が適応する'] });
  await store.saveWriterSkill('w', { status: 'active', revision: 1, antiFixation: ['同じ解決順を繰り返さない'], discoverySpaces: ['正確な台詞は場面で見つける'], authorCraft: { judgments: ['行動で費用を見せる'] }, storyDramaturgy: { conflictSources: ['規則の適用'], protagonistError: '文言が人を動かすと信じる' } });
  await store.saveStoryIdentity('w', { readerPromise: '帳簿', protagonistAppeal: '静かな書記官', emotionalDefect: '', competenceSignature: ['数字を読む'], comedyEngines: ['制度との衝突'], solutionPatternsToRotate: ['交渉'] });
  return store;
}

const JA_ARC = JSON.stringify({
  title: '最初の扉', promise: '灯里の計算が通るが同僚が代価を払う。', type: 'small',
  commercialPromise: { fantasy: '規則の逆算', humanComplication: '同僚が別の選択をする', repeatableProof: '前の文言が罠として戻る' },
  readerContract: { openingQuestion: '誰の解釈が正しいか', expectedPath: '灯里の計算が合う', promisedPayoffBy: 3, minimumPayoff: '計算の結果を見る' },
  escalatingCosts: ['成功するほど担保が増える'],
  oppositionAgency: { actor: '徴収官', independentGoal: '資産確保', knowledge: '灯里の解釈', adaptationTrigger: '同じ抜け道の再利用' },
  openOutcomeSpace: { mustResolve: ['最初の納付'], mayResolve: ['誰が担保を出すか'], mustRemainCostly: ['自由'] },
  episodes: [
    { title: '一話', beat: '規則を見つける', pressure: '締切', readerExpectation: '計算が合う', payoff: '抜け道が通る', turn: '文言を読み替える', costCreatedByResolution: '担保候補になる', carry: '同僚の視線', exitValue: '同僚が取引を持ちかける' },
    { title: '二話', beat: '同僚が計算を拒む', pressure: '信頼', readerExpectation: '同僚が従う', payoff: '別の道が人を救う', turn: '同僚が先に動く', costCreatedByResolution: '信頼を失う', carry: '割れた帳簿', exitValue: '徴収官が先に動く' },
    { title: '三話', beat: '徴収官が抜け道を逆用する', pressure: '担保', readerExpectation: '担保を避ける', payoff: '証拠で担保を止める', turn: '順序が変わる', costCreatedByResolution: '適用順が変わる', carry: '新しい規則', exitValue: '新しい規則の下で選ぶ' },
  ],
});

const JA_EPISODE = JSON.stringify({
  title: '一話', premise: '灯里が告知書を受け取る。', readerBridge: '締切までに払えないと机を失う。',
  povCharacter: 'hero', cast: ['hero'], foregroundCharacters: ['hero'], locations: ['記録室'],
  openingState: '机の前', closingState: '抜け道を見つける', immediateGoal: '納付を遅らせる', obstacle: '締切', choice: '文言を読み替える', outcome: '一日を得る',
  nextQuestion: '誰が担保になるのか',
  scenes: [
    { location: '記録室', characters: ['hero'], situation: '告知書が届く', choice: '文言を読み直す', change: '抜け道を見つける' },
    { location: '窓口', characters: ['hero'], situation: '窓口に並ぶ', choice: '別の条項を出す', change: '一日を得る' },
  ],
});

describe('프롬프트 계열 구조', () => {
  it('두 계열이 같은 단계와 같은 라벨 키를 갖는다', () => {
    assert.deepEqual(Object.keys(multilingual.steps).sort(), Object.keys(ko.steps).sort());
    assert.deepEqual([...PROMPT_STEPS].sort(), Object.keys(ko.steps).sort());
    const shape = (value) => {
      if (Array.isArray(value)) return 'array';
      if (typeof value === 'function') return 'function';
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]));
      }
      return typeof value;
    };
    assert.deepEqual(shape(multilingual.phrases), shape(ko.phrases));
  });

  it('ko 계열은 언어 지시문을 덧붙이지 않고 비ko 계열만 검증된 지시문을 붙인다', () => {
    const koKit = promptKit({ language: 'ko-KR' });
    assert.equal(koKit.family, 'ko');
    assert.deepEqual(koKit.directive, []);
    assert.equal(koKit.system('arc-plan'), ko.steps['arc-plan'].system);

    const jaKit = promptKit({ language: 'ja' });
    assert.equal(jaKit.family, 'multilingual');
    assert.ok(jaKit.system('arc-plan').startsWith(multilingual.steps['arc-plan'].system));
    assert.match(jaKit.system('arc-plan'), /Target work language \(BCP 47\): ja\./);
    assert.match(jaKit.system('arc-plan'), /Do not translate JSON keys, existing enum values, IDs, paths, or sentinel tags\./);
    // 승인되지 않은 분량 기본값은 프롬프트에 넣지 않는다.
    assert.doesNotMatch(jaKit.system('arc-plan'), /3000 graphemes/);
  });

  it('표본 목록 밖 언어도 새 프롬프트 팩 없이 공통 계열로 들어간다', () => {
    for (const language of ['th', 'fr', 'zh-Hant', 'ar']) {
      const kit = promptKit({ language });
      assert.equal(kit.family, 'multilingual', `${language} 가 공통 계열이 아니다`);
      assert.ok(kit.system('episode-plan').includes(`Target work language (BCP 47): ${language}`));
    }
    assert.match(promptKit({ language: 'zh-Hant' }).system('episode-plan'), /Use the Hant script consistently\./);
  });

  it('승인된 분량은 단위와 함께 지시문에 들어간다', () => {
    const kit = promptKit({ contract: { language: 'en', length: { unit: 'words', target: 900 }, allowedLanguageExceptions: [], provenance: { lengthSource: 'stored' } } });
    assert.match(kit.system('story-profile'), /Chapter length target: 900 words/);
  });
});

describe('최종 provider 메시지의 언어 계열', () => {
  it('ko 신규 프로필 요청은 기존 한국어 프롬프트 그대로다', async () => {
    const store = await newStore('ko');
    const providers = capturingProvider({ 'story-profile': JSON.stringify(PROFILE_RESPONSE) });
    await runStoryProfile({ store, workId: 'w', brief: '조용한 사무 드라마', mode: 'review', providers });
    const request = providers.last('story-profile');
    assert.equal(request.messages[0].content, ko.steps['story-profile'].system);
    assert.match(request.messages[1].content, /^작품 브리프: 조용한 사무 드라마$/m);
    assert.doesNotMatch(request.messages[0].content, /Target work language/);
  });

  for (const language of ['en', 'ja', 'th']) {
    it(`${language} 프로필 요청은 영어 지시 + 목표 언어 지시문이다`, async () => {
      const store = await newStore(language);
      const providers = capturingProvider({ 'story-profile': JSON.stringify(PROFILE_RESPONSE) });
      const result = await runStoryProfile({
        store, workId: 'w', brief: 'a quiet office drama', mode: 'review', language, providers,
      });
      assert.equal(result.profile.language, language);
      const request = providers.last('story-profile');
      assert.ok(request.messages[0].content.startsWith(multilingual.steps['story-profile'].system));
      assert.ok(request.messages[0].content.includes(`Target work language (BCP 47): ${language}`));
      assert.match(request.messages[1].content, /^Work brief: a quiet office drama$/m);
      assertNoKoreanInstructions(request.messages, `story-profile/${language}`);
    });
  }

  it('ja 아크·에피소드 계획의 최종 메시지에 한국어 집필 지시가 남지 않는다', async () => {
    const store = await jaStore();
    const providers = capturingProvider({ 'arc-plan': JA_ARC, 'episode-plan': JA_EPISODE });
    const planned = await runArcPlan({ store, workId: 'w', mode: 'auto', episodes: 3, direction: '帳簿の話', providers });
    assert.ok(planned.plan, JSON.stringify(planned.validation));
    assert.equal(planned.plan.episodes.length, 3);
    const arcRequest = providers.last('arc-plan');
    assert.ok(arcRequest.messages[0].content.startsWith(multilingual.steps['arc-plan'].system));
    assert.match(arcRequest.messages[0].content, /Target work language \(BCP 47\): ja\./);
    assert.match(arcRequest.messages[1].content, /^World facts:$/m);
    assert.match(arcRequest.messages[1].content, /## Approved StorySpine/);
    // 작품 데이터는 번역하지 않는다.
    assert.match(arcRequest.messages[1].content, /塔は税を集める。/);
    assertNoKoreanInstructions(arcRequest.messages, 'arc-plan/ja');
    // arc-quality 도 같은 계약을 이어받는다.
    assertNoKoreanInstructions(providers.last('arc-quality').messages, 'arc-quality/ja');

    const episode = await runEpisodePlan({ store, workId: 'w', chapter: 1, mode: 'review', providers });
    assert.ok(episode.plan, JSON.stringify(episode.validation));
    assert.equal(episode.plan.chapter, 1);
    const episodeRequest = providers.last('episode-plan');
    assert.ok(episodeRequest.messages[0].content.startsWith(multilingual.steps['episode-plan'].system));
    assert.match(episodeRequest.messages[1].content, /## Approved StoryProfile — 静かな官僚劇/);
    assert.match(episodeRequest.messages[1].content, /- Approved chapter length: 2400 graphemes/);
    assertNoKoreanInstructions(episodeRequest.messages, 'episode-plan/ja');
  });

  it('ja 작품 설계 단계(spine·writer)도 영어 템플릿을 쓴다', async () => {
    const store = await jaStore();
    const spineProviders = capturingProvider({
      'story-spine': JSON.stringify({
        dramaticQuestion: '誰が帳簿を守るのか', protagonistWant: '納付', protagonistNeed: '自由', falseBelief: '文言が全て',
        incitingDisruption: '告知書', initialStrategy: '抜け道', causalChain: ['告知', '抜け道', '適応', '離反', '放棄'],
        midpointReframe: '順序が変わる', finalChoice: '担保を選ぶ', endingChange: '帳簿を手放す', endingCost: '地位',
        characterForces: [{ characterId: 'hero', want: '自由', actionThatChangesPlot: '条項を出す' }, { characterId: 'hero', want: '生存', actionThatChangesPlot: '記録を隠す' }],
      }),
      'story-spine-quality': JSON.stringify({ dimensions: { causalNecessity: 90, protagonistError: 90, expectationReframe: 90, characterAgency: 90, finalChoiceCost: 90, endingTransformation: 90 }, findings: [] }),
    });
    const spineResult = await runStorySpine({ store, workId: 'w', mode: 'auto', providers: spineProviders });
    assert.equal(spineResult.spine?.status, 'active', JSON.stringify(spineResult.validation));
    assertNoKoreanInstructions(spineProviders.last('story-spine').messages, 'story-spine/ja');
    assertNoKoreanInstructions(spineProviders.last('story-spine-quality').messages, 'story-spine-quality/ja');

    const candidate = (id) => ({
      id, name: `作家${id}`, aestheticThesis: '費用を選択で見せる', coreAttention: ['ずれ', '費用'],
      sceneTransformations: ['説明を行動に', '成功を費用に', '性格を順序に'], antiFixation: ['同じ順序を避ける', '全ての台詞を賢くしない'],
      discoverySpaces: ['正確な行動は場面で'], authorCraft: { judgments: ['効率の被害', '行動を信じる', '正答の残り'], selfBetrayal: ['得意technique の副作用を見せる'] },
      storyDramaturgy: { conflictSources: ['規則', '同僚'], protagonistError: '文言が人を動かすと信じる' },
      audition: '灯里は帳簿を開いた。',
    });
    const writerProviders = capturingProvider({
      'writer-skill': JSON.stringify({ candidates: ['a', 'b', 'c'].map(candidate) }),
      'writer-skill-audition': JSON.stringify({ winnerId: 'a', scores: [] }),
    });
    const writerResult = await runWriterSkill({ store, workId: 'w', mode: 'auto', providers: writerProviders });
    assert.equal(writerResult.skill?.status, 'active', JSON.stringify(writerResult.validation));
    assertNoKoreanInstructions(writerProviders.last('writer-skill').messages, 'writer-skill/ja');
    assertNoKoreanInstructions(writerProviders.last('writer-skill-audition').messages, 'writer-skill-audition/ja');
  });

  it('critic 계열은 넘겨받은 작품 계약을 따르고, 없으면 기존 ko 동작을 유지한다', async () => {
    const kit = promptKit({ language: 'en' });
    const prose = 'She opened the ledger and the numbers moved first.';
    const context = 'Previous chapter: the notice arrived.';
    const foundation = { language: 'en', characters: [{ id: 'hero', canonicalName: 'Ann', intrinsic: { role: 'protagonist' } }] };

    const editorial = capturingProvider();
    await runEditorialQuality({ prose, context, providers: editorial, kit });
    assertNoKoreanInstructions(editorial.last('editorial-quality').messages, 'editorial-quality/en');

    const fidelity = capturingProvider();
    await runCharacterFidelity({ prose, chapter: 1, foundation, context, providers: fidelity });
    assertNoKoreanInstructions(fidelity.last('character-fidelity').messages, 'character-fidelity/en(foundation)');

    const hook = capturingProvider();
    await runReaderHook({ chapter: 1, prose, identity: { readerPromise: 'ledger', protagonistAppeal: 'clerk', emotionalDefect: '', competenceSignature: ['reads numbers'], comedyEngines: ['bureaucracy'], solutionPatternsToRotate: ['negotiation'] }, episodePlan: {}, providers: hook, kit });
    assertNoKoreanInstructions(hook.last('reader-hook').messages, 'reader-hook/en');

    const pattern = capturingProvider();
    await runPatternAnalysis({ chapter: 1, prose, providers: pattern, kit });
    assertNoKoreanInstructions(pattern.last('pattern-ledger').messages, 'pattern-ledger/en');

    const boundary = capturingProvider({ 'narrative-boundary': JSON.stringify({ decision: 'advance_episode', reason: 'the choice settled' }) });
    const arcPlan = { status: 'active', arcNumber: 1, title: 'First door', promise: 'a door opens', estimatedEpisodes: 2, episodes: [{ chapter: 1, index: 1, title: 'one', beat: 'opens' }, { chapter: 2, index: 2, title: 'two', beat: 'enters' }] };
    await runNarrativeBoundary({ arcPlan, episodePlan: null, chapter: 1, prose, providers: boundary, kit });
    assertNoKoreanInstructions(boundary.last('narrative-boundary').messages, 'narrative-boundary/en');

    // 계약을 넘기지 않으면 기존 ko 요청 그대로다(워크플로 결합은 다음 단계).
    const legacy = capturingProvider();
    await runEditorialQuality({ prose: '윤재가 문을 열었다.', context: '', providers: legacy });
    assert.equal(legacy.last('editorial-quality').messages[0].content, ko.steps['editorial-quality'].system);
  });

  it('ja 시대 고증 요청도 영어 지시와 목표 언어 설명을 쓴다', async () => {
    const store = await jaStore();
    const providers = capturingProvider({ 'era-research': JSON.stringify({ verdict: 'uncertain', explanation: '不明', sources: [] }) });
    await runEraResearchTool({ store, workId: 'w', chapter: 1, era: '明治', claims: ['帳簿は紙だった'], providers });
    const request = providers.last('era-research');
    assert.match(request.messages[0].content, /period-research assistant/);
    assert.match(request.messages[1].content, /^Era and region: 明治$/m);
    assertNoKoreanInstructions(request.messages, 'era-research/ja');
  });
});

describe('집필 컨텍스트와 작가 패킷', () => {
  it('ja 집필 컨텍스트는 영어 라벨과 일본어 작품 데이터를 함께 유지한다', async () => {
    const store = await jaStore();
    const providers = capturingProvider({ 'arc-plan': JA_ARC, 'episode-plan': JA_EPISODE });
    await runArcPlan({ store, workId: 'w', mode: 'auto', episodes: 3, providers });
    const { context } = await buildContext({ store, workId: 'w', chapter: 1 });
    assert.match(context, /^# Writing context for chapter 1 — w$/m);
    assert.match(context, /## World facts \(immutable/);
    assert.match(context, /塔は税を集める。/);
    assert.match(context, /灯里/);
    assert.match(context, /## Approved arc plan — Arc 1 "最初の扉"/);
    // 마지막 블록은 엔진의 sliding-window 렌더러다(2A 엔진 소유자 범위). 플러그인이
    // 만드는 모든 앞부분에는 한국어 지시가 남아 있지 않아야 한다.
    const [pluginSections] = context.split('(이전 화 요약 없음');
    assert.ok(pluginSections.length > 400);
    assert.equal(HANGUL.test(withoutMachineEnums(pluginSections)), false,
      `컨텍스트에 한국어 라벨이 남아 있다: ${withoutMachineEnums(pluginSections).slice(0, 200)}`);
  });

  it('Writer Episode Packet 과 DraftBrief 가 계열을 따른다', () => {
    const kit = promptKit({ language: 'ja' });
    const episodePlan = {
      status: 'active', chapter: 1, premise: '告知書が届く', readerBridge: '払えないと机を失う',
      cast: ['hero'], foregroundCharacters: ['hero'], povCharacter: 'hero',
      entryState: { activeQuestion: '誰が払うのか', protagonistImmediateWant: '納付を遅らせる', tickingLoss: '締切' },
      scenePressure: { choiceOwner: 'hero', incompatibleGoods: ['記録', '人'], decisionDeadline: '今日' },
      scenes: [
        { order: 1, situation: '告知書が届く', choice: '文言を読み直す', change: '抜け道を見つける' },
        { order: 2, situation: '窓口に並ぶ', choice: '別の条項を出す', change: '一日を得る' },
      ],
      payoff: { promisePaid: '一日を得る', proofOnPage: '窓口の判子' },
      costCreatedByResolution: { immediate: '担保候補になる' },
      exitValue: { closedQuestion: '今日の納付', nextQuestion: '誰が担保になるのか', specificFutureValue: '担保の指名' },
      reveals: [], withheld: ['不足額'], readerLoad: { phase: 'onboarding', newConcepts: ['徴収規則'] },
    };
    const packet = compileWriterEpisodePacket({ episodePlan, characterNames: { hero: '灯里' }, kit });
    assert.equal(packet.ok, true);
    assert.match(packet.value.writerText, /## Reader Contract/);
    assert.match(packet.value.writerText, /- Immediate goal: 灯里 — 納付を遅らせる/);
    assert.match(packet.value.writerText, /still withheld: 不足額/);
    assert.equal(HANGUL.test(packet.value.writerText), false);

    const contract = compileDraftContract({
      profile: { status: 'active', language: 'ja', tones: ['静謐'], format: { pov: '3인칭제한' }, storyEngines: ['生存'], promptGuidance: { draft: ['数字を行動で見せる。'] }, voiceContract: { genreVoiceRecipe: { narration: '短く書く' }, narrationExamples: [{ situation: '帳簿', example: '数字が先に動いた。' }] }, readabilityContract: {} },
      identity: { readerPromise: '帳簿', competenceSignature: ['数字を読む'] },
      writerSkill: { authorCraft: { judgments: ['行動で費用を見せる'] } },
      episodePlan, chapter: 1, kit,
    });
    assert.match(contract.writerText, /## Work contract/);
    assert.match(contract.writerText, /## Prose-style examples from this work/);
    assert.equal(HANGUL.test(withoutMachineEnums(contract.writerText)), false);

    const compiled = compileDraftInputs({
      identity: { workId: 'w', chapter: 1, invocation: 'direct' },
      episode: packet.value,
      authorCraft: { writerText: contract.writerText },
      continuity: { genreLine: kit.phrases.draftInput.genreLine('other', '3인칭제한'), recentSummaries: ['灯里が扉を開けた。'], castIds: ['hero'], locations: ['記録室'], previousSceneTail: '灯里は帳簿を閉じた。' },
      supplementalDirection: { source: 'direct-user', text: '静かに始める' },
      kit,
    });
    assert.equal(compiled.ok, true);
    assert.match(compiled.value.plan, /## DraftBrief/);
    assert.match(compiled.value.plan, /^Characters: hero$/m);
    assert.match(compiled.value.plan, /## Final scene of the previous chapter/);
    assert.match(compiled.value.slidingWindowRender, /^Recent events: 灯里が扉を開けた。$/m);
    assert.equal(HANGUL.test(withoutMachineEnums(compiled.value.plan)), false);
  });
});

describe('읽기 난도 답변 인식', () => {
  const AXES = ['surfaceEase', 'conceptPacing', 'inferenceLoad', 'complexityRamp'];
  const SELECTED = { surfaceEase: 'easy', conceptPacing: 'slow', inferenceLoad: 'explicit', complexityRamp: 'onboarding-first' };
  const evidenceFor = (quotes, selected = SELECTED) => Object.fromEntries(AXES.map((axis, index) => [axis, {
    quote: quotes[index], selected: selected[axis], questionId: 'reading-experience-contract',
  }]));

  it('실제 사용자 입력을 인용한 외국어 답변을 승인으로 인정한다', async () => {
    const store = await newStore('ja-readability');
    const feedback = '文章は読みやすく、新しい概念はゆっくり、表面の意味は明確に、序盤は慣れてから複雑にしてください。';
    const providers = capturingProvider({
      'story-profile': JSON.stringify({
        ...PROFILE_RESPONSE,
        readabilityContract: {
          surfaceEase: 'easy', conceptPacing: 'slow', inferenceLoad: 'explicit', complexityRamp: 'onboarding-first',
          confirmedByUser: true,
          userAnswerEvidence: evidenceFor(['文章は読みやすく', '新しい概念はゆっくり', '表面の意味は明確に', '序盤は慣れてから複雑に']),
        },
      }),
    });
    const result = await runStoryProfile({
      store, workId: 'w', brief: '静かな官僚劇', mode: 'review', language: 'ja', feedback, providers,
    });
    assert.equal(result.profile.readabilityContract.confirmedByUser, true);
    assert.equal(result.readabilityAnswer.method, 'user-answer-quote');
    assert.equal(result.profile.readabilityContract.userAnswerEvidence.conceptPacing.quote, '新しい概念はゆっくり');
    assert.equal(result.profile.readabilityContract.userAnswerEvidence.conceptPacing.selected, 'slow');
    // 같은 질문을 다시 묻지 않는다.
    assert.deepEqual(result.profile.designReview.openQuestions.map((item) => item.id), []);
  });

  it('사용자 입력에 없는 인용은 승인으로 세지 않고 질문을 유지한다', async () => {
    const store = await newStore('ja-invented');
    const providers = capturingProvider({
      'story-profile': JSON.stringify({
        ...PROFILE_RESPONSE,
        readabilityContract: {
          surfaceEase: 'dense', conceptPacing: 'fast', inferenceLoad: 'subtext-heavy', complexityRamp: 'dense-start',
          confirmedByUser: true,
          userAnswerEvidence: evidenceFor(['the user never said this', 'nor this', 'nor that', 'nor the last one']),
        },
      }),
    });
    const result = await runStoryProfile({
      store, workId: 'w', brief: '静かな官僚劇', mode: 'review', language: 'ja', feedback: '面白くしてください。', providers,
    });
    assert.equal(result.profile.readabilityContract.confirmedByUser, false);
    assert.equal(result.profile.readabilityContract.userAnswerEvidence, undefined);
    assert.ok(result.profile.designReview.openQuestions.some((item) => item.id === 'reading-experience-contract'));
    // 질문은 작품 언어 계열을 따른다.
    const question = result.profile.designReview.openQuestions.find((item) => item.id === 'reading-experience-contract');
    assert.equal(question.title, 'Reading difficulty');
  });

  it('사용자 입력에 있지만 주제와 무관한 조각을 재사용한 근거를 거부한다', async () => {
    const store = await newStore('en-fabricated');
    const brief = 'Write a pirate story with a stubborn quartermaster.';
    const providers = capturingProvider({
      'story-profile': JSON.stringify({
        ...PROFILE_RESPONSE,
        readabilityContract: {
          ...SELECTED, confirmedByUser: true,
          // 실제 brief 안에 있는 문자열이지만 읽기 난도 답변이 아니다.
          userAnswerEvidence: evidenceFor(['pirate story', 'pirate story', 'pirate story', 'pirate story']),
        },
      }),
    });
    const result = await runStoryProfile({ store, workId: 'w', brief, mode: 'review', language: 'en', providers });
    assert.equal(result.profile.readabilityContract.confirmedByUser, false);
    assert.ok(result.profile.designReview.openQuestions.some((item) => item.id === 'reading-experience-contract'));

    // 같은 조각을 네 축에 재사용하는 것과, 축별로 의미 없는 두 글자 조각을 쓰는 것
    // 모두 승인이 아니다.
    const reused = recognizeReadabilityAnswer(brief, evidenceFor(['pirate story', 'pirate story', 'pirate story', 'pirate story']), { language: 'en', selected: SELECTED });
    assert.equal(reused.confirmed, false);
    assert.equal(reused.rejection, 'conceptPacing:quote_reused');
    const thin = recognizeReadabilityAnswer(brief, evidenceFor(['pi', 'ra', 'te', 'st']), { language: 'en', selected: SELECTED });
    assert.equal(thin.confirmed, false);
    assert.equal(thin.rejection, 'surfaceEase:quote_too_thin');
  });

  it('고른 값이나 답한 질문이 어긋나면 승인이 아니다', () => {
    const source = 'Keep the sentences easy, introduce concepts slowly, spell out the surface meaning, and ramp complexity after the opening.';
    const quotes = ['Keep the sentences easy', 'introduce concepts slowly', 'spell out the surface meaning', 'ramp complexity after the opening'];
    assert.equal(recognizeReadabilityAnswer(source, evidenceFor(quotes), { language: 'en', selected: SELECTED }).confirmed, true);

    const wrongValue = recognizeReadabilityAnswer(source, evidenceFor(quotes, { ...SELECTED, conceptPacing: 'fast' }), { language: 'en', selected: SELECTED });
    assert.equal(wrongValue.confirmed, false);
    assert.equal(wrongValue.rejection, 'conceptPacing:selected_value_mismatch');

    const wrongQuestion = evidenceFor(quotes);
    wrongQuestion.inferenceLoad = { ...wrongQuestion.inferenceLoad, questionId: 'first-payoff' };
    const mismatched = recognizeReadabilityAnswer(source, wrongQuestion, { language: 'en', selected: SELECTED });
    assert.equal(mismatched.confirmed, false);
    assert.equal(mismatched.rejection, 'inferenceLoad:question_mismatch');
  });

  it('한국어 답변 패턴은 그대로 인정한다', () => {
    const answer = recognizeReadabilityAnswer('읽기는 쉽게, 새 개념은 천천히, 표면 뜻은 명확하게, 초반 적응 뒤 복잡하게.', null);
    assert.equal(answer.confirmed, true);
    assert.equal(answer.method, 'ko-answer-pattern');
    assert.equal(recognizeReadabilityAnswer('아무 말', null).confirmed, false);
  });

  it('주제와 무관한 조각과 축 이름만 물은 질문은 승인이 아니다', () => {
    const declined = 'Please do not choose readability preferences for me.';
    const declinedEvidence = evidenceFor(['do', 'do', 'do', 'do']);
    const declinedAnswer = recognizeReadabilityAnswer(declined, declinedEvidence, { language: 'en', selected: SELECTED });
    assert.equal(declinedAnswer.confirmed, false);

    const axisQuestion = 'What do surfaceEase, conceptPacing, inferenceLoad, and complexityRamp mean?';
    const questionOnly = recognizeReadabilityAnswer(axisQuestion, null);
    assert.equal(questionOnly.confirmed, false);
    assert.equal(questionOnly.method, null);
  });
});

describe('언어 신호 충돌', () => {
  const expectCode = (fn, code) => {
    const error = (() => { try { fn(); return null; } catch (err) { return err; } })();
    assert.ok(error, `${code} 를 기대했지만 성공했다`);
    assert.equal(error.code, code);
    return error;
  };

  it('계약과 명시 언어가 어긋나면 조용히 고르지 않는다', () => {
    expectCode(() => promptKit({ contract: { language: 'ja', length: { unit: 'graphemes', target: 3000 } }, language: 'en' }), 'WORK_LANGUAGE_IMMUTABLE');
    // 같은 언어면 통과하고, 지역 태그도 그대로 보존한다.
    const kit = promptKit({ foundation: { language: 'ko-KR' }, language: 'ko-KR' });
    assert.equal(kit.family, 'ko');
    assert.equal(kit.language, 'ko-KR');
  });

  it('언어 키 없는 구작에 비ko 를 명시해도 조용히 라우팅하지 않는다', () => {
    expectCode(() => promptKit({ foundation: { workId: 'w' }, language: 'ja' }), 'WORK_LANGUAGE_IMMUTABLE');
    assert.equal(promptKit({ foundation: { workId: 'w' } }).family, 'ko');
  });

  it('저장된 원천끼리 어긋나도 거부한다', () => {
    expectCode(() => promptKit({ foundation: { language: 'ja' }, profile: { language: 'en' } }), 'WORK_LANGUAGE_IMMUTABLE');
  });

  it('전달된 빈 값은 부재가 아니라 잘못된 입력이다', () => {
    expectCode(() => promptKit({ language: '' }), 'INVALID_LANGUAGE_TAG');
    expectCode(() => promptKit({ language: null }), 'INVALID_LANGUAGE_TAG');
    expectCode(() => promptKit({ foundation: { language: '' } }), 'INVALID_LANGUAGE_TAG');
    // 키 자체가 없으면 부재다.
    assert.equal(promptKit({}).family, 'ko');
    assert.equal(promptKit({ foundation: undefined, profile: undefined }).family, 'ko');
  });

  it('family 는 검증된 목표 언어를 덮거나 지시문을 없애지 못한다', () => {
    expectCode(() => promptKit({ family: 'ko', language: 'ja' }), 'LANGUAGE_SELECTION_REQUIRED');
    expectCode(() => promptKit({ family: 'multilingual' }), 'LANGUAGE_SELECTION_REQUIRED');
    expectCode(() => promptKit({ family: 'made-up', language: 'en' }), 'LANGUAGE_SELECTION_REQUIRED');
    const kit = promptKit({ family: 'multilingual', language: 'ja' });
    assert.match(kit.system('arc-plan'), /Target work language \(BCP 47\): ja\./);
  });
});

describe('대사 정책과 승인 분량', () => {
  const dialogueCase = async (tag, { language, dialogueBreakMode, serialization }) => {
    const store = await newStore(tag);
    const providers = capturingProvider({
      'story-profile': JSON.stringify({
        ...PROFILE_RESPONSE,
        format: { pov: '3인칭제한', serialization, ...(dialogueBreakMode ? { dialogueBreakMode } : {}) },
      }),
    });
    const result = await runStoryProfile({ store, workId: 'w', brief: 'brief', mode: 'auto', language, providers });
    return result.profile.format;
  };

  it('명시된 대사 정책은 ko 웹소설 연재에서도 유지된다', async () => {
    const format = await dialogueCase('ko-relaxed', { language: 'ko', dialogueBreakMode: 'relaxed', serialization: '웹소설 연재' });
    assert.equal(format.dialogueBreakMode, 'relaxed');
    const natural = await dialogueCase('ko-natural', { language: 'ko', dialogueBreakMode: 'natural', serialization: '웹소설 연재' });
    assert.equal(natural.dialogueBreakMode, 'natural');
  });

  it('명시가 없으면 ko 는 strict, 비ko 는 natural 이다', async () => {
    const koFormat = await dialogueCase('ko-default', { language: 'ko', serialization: '웹소설 연재' });
    assert.equal(koFormat.dialogueBreakMode, 'strict');
    const enFormat = await dialogueCase('en-default', { language: 'en', serialization: 'web serial' });
    assert.equal(enFormat.dialogueBreakMode, 'natural');
    const enStrict = await dialogueCase('en-strict', { language: 'en', dialogueBreakMode: 'strict', serialization: 'web serial' });
    assert.equal(enStrict.dialogueBreakMode, 'strict');
  });

  it('신규 비ko 기본 분량은 graphemes 3000 이고 ko 는 기존대로다', async () => {
    const store = await newStore('length-default');
    const providers = capturingProvider({ 'story-profile': JSON.stringify(PROFILE_RESPONSE) });
    const en = await runStoryProfile({ store, workId: 'w', brief: 'brief', mode: 'auto', language: 'en', providers });
    assert.deepEqual(en.profile.format.length, { unit: 'graphemes', target: 3000 });

    const koStore = await newStore('length-ko');
    const koResult = await runStoryProfile({ store: koStore, workId: 'w', brief: '브리프', mode: 'auto', providers: capturingProvider({ 'story-profile': JSON.stringify(PROFILE_RESPONSE) }) });
    assert.deepEqual(koResult.profile.format.length, { unit: 'legacyCodeUnits', target: 3000 });
  });

  it('렌더링은 저장된 분량만 단위와 함께 보여주고 기본값을 주입하지 않는다', () => {
    const base = {
      status: 'active', genreLabel: 'g', engineGenre: 'other', subgenres: [], tones: [], storyEngines: [], themes: [],
      tracking: { semantic: [], engineBacked: [] }, promptGuidance: { draft: [], avoid: [] },
      readabilityContract: { surfaceEase: 'easy', conceptPacing: 'slow', inferenceLoad: 'explicit', complexityRamp: 'onboarding-first' },
    };
    const stored = renderStoryProfile({ ...base, language: 'en', format: { length: { unit: 'words', target: 900 } } });
    assert.match(stored, /- Approved chapter length: 900 words/);

    const legacy = renderStoryProfile({ ...base, format: { chapterChars: 3300 } });
    assert.match(legacy, /- 승인된 회차 분량: 3300 legacyCodeUnits/);

    const none = renderStoryProfile({ ...base, format: { pov: '3인칭제한' } });
    assert.doesNotMatch(none, /회차 분량|chapter length/);
    assert.doesNotMatch(none, /3000/);
  });
});
