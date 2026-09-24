import { gateApprovalActivation } from '../core/approval-language-gate.js';
import { ENGINE_GENRES } from '../../engine/src/continuity/genre-profile.js';
import { PROMPT_FAMILY_KO } from '../../engine/src/core/language-policy.js';

import { MCP_CONTRACT_VERSION, runtimeVersion } from '../core/runtime-version.js';
import {
  STORY_PROFILE_SCHEMA_VERSION, profileLanguageChange, readProfileLength,
  resolveProposedLength, resolveWorkLanguage,
} from '../core/work-language.js';
import { asKit, promptKit } from '../prompts/index.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const READABILITY_QUESTION_ID = 'reading-experience-contract';
const READABILITY_AXES = Object.freeze(['surfaceEase', 'conceptPacing', 'inferenceLoad', 'complexityRamp']);
const READABILITY_DEFAULTS = Object.freeze({
  surfaceEase: 'easy',
  conceptPacing: 'slow',
  inferenceLoad: 'explicit',
  complexityRamp: 'onboarding-first',
});
const ENGINE_SET = new Set(ENGINE_GENRES);
const list = (value, max = 12) => Array.isArray(value)
  ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, max)
  : [];

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

function guidance(value) {
  const obj = value && typeof value === 'object' ? value : {};
  return {
    worldbuild: list(obj.worldbuild, 10), cast: list(obj.cast, 10), arc: list(obj.arc, 10),
    draft: list(obj.draft, 12), avoid: list(obj.avoid, 12),
  };
}

function designQuestion(value, index, kit) {
  const obj = value && typeof value === 'object' ? value : {};
  const question = String(obj.question ?? '').trim().slice(0, 600);
  if (!question) return null;
  return {
    id: String(obj.id ?? `profile_question_${index + 1}`).trim().slice(0, 80),
    title: String(obj.title ?? kit.phrases.profile.designQuestionTitle(index + 1)).trim().slice(0, 120),
    question,
    recommendation: String(obj.recommendation ?? '').trim().slice(0, 600),
  };
}

function designReview(value, previous, kit) {
  const obj = value && typeof value === 'object' ? value : {};
  const prior = previous && typeof previous === 'object' ? previous : {};
  const settledDecisions = [...new Set([
    ...list(prior.settledDecisions, 40),
    ...list(obj.settledDecisions, 40),
  ])].slice(0, 40);
  const openQuestions = (Array.isArray(obj.openQuestions) ? obj.openQuestions : [])
    .map((item, index) => designQuestion(item, index, kit))
    .filter(Boolean)
    .slice(0, 5);
  const askedQuestionIds = [...new Set([
    ...list(prior.askedQuestionIds, 40),
    ...(Array.isArray(prior.openQuestions) ? prior.openQuestions : []).map((item) => String(item?.id ?? '').trim()).filter(Boolean),
    ...openQuestions.map((item) => item.id),
  ])].slice(0, 40);
  return {
    settledDecisions,
    askedQuestionIds,
    openQuestions,
  };
}

const DIALOGUE_BREAK_MODES = ['strict', 'relaxed', 'natural'];

/**
 * 대사 문단 정책. 명시된 `strict|relaxed|natural` 은 언어·연재 형태와 무관하게 항상
 * 그대로 존중한다. 승인된 포맷 선택을 웹소설 연재라는 이유로 strict 로 되돌리지
 * 않는다(기획: "모든 언어에 한국어식 대사 단독 문단을 강제하지 않는다. 승인된 작품
 * 포맷을 따른다"). 명시가 없을 때만 계열 기본값을 쓴다: ko 는 기존대로 strict,
 * 비ko 신규 작품은 그 언어의 일반적인 대사+발화자 서술인 natural 이다.
 */
function resolveDialogueBreakMode(format, promptFamily) {
  const explicit = DIALOGUE_BREAK_MODES.includes(format?.dialogueBreakMode) ? format.dialogueBreakMode : null;
  if (explicit) return explicit;
  return promptFamily === PROMPT_FAMILY_KO ? 'strict' : 'natural';
}

function narrativeContract(value, kit) {
  const obj = value && typeof value === 'object' ? value : {};
  const mode = ['light-webnovel', 'commercial-dramatic', 'deep-world-driven'].includes(obj.depthMode)
    ? obj.depthMode
    : 'commercial-dramatic';
  return {
    depthMode: mode,
    readerPromise: String(obj.readerPromise ?? '').trim().slice(0, 300),
    openingPressure: String(obj.openingPressure ?? '').trim().slice(0, 300),
    viewpointReason: String(obj.viewpointReason ?? '').trim().slice(0, 300),
    expositionPolicy: String(obj.expositionPolicy ?? '').trim().slice(0, 300),
    readerLegibility: String(obj.readerLegibility
      ?? kit.phrases.profile.defaultReaderLegibility).trim().slice(0, 300),
    registerPolicy: String(obj.registerPolicy
      ?? kit.phrases.profile.defaultRegisterPolicy).trim().slice(0, 300),
  };
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function normalizeReadabilityContract(value) {
  const obj = value && typeof value === 'object' ? value : {};
  const evidence = normalizeReadabilityEvidence(obj.userAnswerEvidence);
  return {
    schemaVersion: 1,
    surfaceEase: oneOf(obj.surfaceEase, ['easy', 'standard', 'dense'], READABILITY_DEFAULTS.surfaceEase),
    conceptPacing: oneOf(obj.conceptPacing, ['slow', 'standard', 'fast'], READABILITY_DEFAULTS.conceptPacing),
    inferenceLoad: oneOf(obj.inferenceLoad, ['explicit', 'balanced', 'subtext-heavy'], READABILITY_DEFAULTS.inferenceLoad),
    complexityRamp: oneOf(obj.complexityRamp, ['onboarding-first', 'steady', 'dense-start'], READABILITY_DEFAULTS.complexityRamp),
    confirmedByUser: obj.confirmedByUser === true,
    ...(evidence ? { userAnswerEvidence: evidence } : {}),
  };
}

function normalizeReadabilityEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = READABILITY_AXES.flatMap((axis) => {
    const raw = value[axis];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const quote = String(raw.quote ?? '').trim().slice(0, 300);
    if (!quote) return [];
    return [[axis, {
      quote,
      selected: String(raw.selected ?? '').trim().slice(0, 40),
      questionId: String(raw.questionId ?? '').trim().slice(0, 80),
    }]];
  });
  return entries.length ? Object.fromEntries(entries) : null;
}

export function normalizeStoryProfile(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const kit = promptKit({ profile });
  return {
    ...profile,
    narrativeContract: narrativeContract(profile.narrativeContract, kit),
    readabilityContract: normalizeReadabilityContract(profile.readabilityContract),
  };
}

/**
 * 읽기 난도 질문도 다른 열린 질문처럼 모델이 작품 언어로 쓴다. 모델이 같은 id 로 제목·질문·
 * 추천을 모두 쓴 경우 그 질문을 그대로 쓰고, 빠뜨린 경우에만 호스트의 정적 ko/en 질문을
 * 넣는다(정적 문구는 작품 언어 산출물이 아니므로 승인 언어 검토에서 digest 로만 묶인다,
 * 2026-09-24 ar/zh-Hant/th 표본). 질문이 필요 없으면 남은 같은 id 질문을 뺀다.
 */
function ensureReadabilityQuestion(review, readability, mode, kit, rawReview) {
  const withoutRequired = review.openQuestions.filter((item) => item.id !== READABILITY_QUESTION_ID);
  if (mode !== 'review' || readability.confirmedByUser) {
    return withoutRequired.length === review.openQuestions.length ? review : { ...review, openQuestions: withoutRequired };
  }
  const raw = (Array.isArray(rawReview?.openQuestions) ? rawReview.openQuestions : [])
    .find((item) => String(item?.id ?? '').trim() === READABILITY_QUESTION_ID);
  const generated = ['title', 'question', 'recommendation'].every((key) => typeof raw?.[key] === 'string' && raw[key].trim())
    ? review.openQuestions.find((item) => item.id === READABILITY_QUESTION_ID)
    : null;
  const question = generated ?? {
      id: READABILITY_QUESTION_ID,
      title: kit.phrases.profile.readabilityQuestionTitle,
      question: kit.phrases.profile.readabilityQuestion,
      recommendation: kit.phrases.profile.readabilityRecommendation,
    };
  const openQuestions = [...withoutRequired.slice(0, 4), question];
  return {
    ...review,
    askedQuestionIds: [...new Set([...(review.askedQuestionIds ?? []), READABILITY_QUESTION_ID])].slice(0, 40),
    openQuestions,
  };
}

/**
 * 한국어 표현 패턴. 한국어 답변은 이 경로로 계속 인식하되, **이 패턴에 맞지 않는다는
 * 이유만으로 다른 언어의 명시적 답변을 미응답으로 되돌리지 않는다**(아래 근거 경로).
 */
const READABILITY_KO_SIGNALS = [
  /표면\s*(?:가독성|난도)|문장\s*(?:난도|난이도)|쉽게\s*읽|읽(?:기|기는).{0,8}쉽/i,
  /개념.{0,12}(?:속도|천천|빠르|보통)|새\s*개념/i,
  /추론\s*(?:부담|량)|표면\s*뜻|서브텍스트/i,
  /(?:초반|첫\s*(?:아크|장|화)|복잡(?:도|성)).{0,20}(?:복잡|적응|쉽|완만|상승)|onboarding-first|dense-start/i,
];

const normalizeQuote = (value) => String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

const MIN_QUOTE_WORDS = 2;
const MIN_QUOTE_LENGTH = 6;

/**
 * 인용이 "실제 답변"이라고 볼 만한 최소 분량인가. 언어 사전이나 allowlist 를 쓰지
 * 않고 `Intl.Segmenter` 의 단어 단위만 센다(분할기가 없으면 길이로 물러난다).
 * `pi` 같은 임의 조각이 네 축의 근거로 재사용되는 것을 막는 목적이다.
 */
function quoteIsSubstantive(quote, language) {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    return [...quote].length >= MIN_QUOTE_LENGTH;
  }
  try {
    const segmenter = new Intl.Segmenter(language ?? undefined, { granularity: 'word' });
    let words = 0;
    for (const segment of segmenter.segment(quote)) if (segment.isWordLike) words += 1;
    return words >= MIN_QUOTE_WORDS;
  }
  catch {
    return [...quote].length >= MIN_QUOTE_LENGTH;
  }
}

/**
 * 사용자가 읽기 난도 질문에 실제로 답했는가.
 *
 * 두 경로만 인정한다.
 *   1. 한국어 표현 패턴이 네 축 모두에 맞는 경우(기존 한국어 동작 보존).
 *   2. 모델이 네 축마다 **사용자 입력에 실제로 있는 답변 구절**을 인용하고, 그 축에서
 *      고른 값과 답한 질문을 함께 밝힌 경우.
 *
 * 두 번째 경로의 검증은 전부 사용자 원문 대조다. 모델의 `confirmedByUser` 는 승인
 * 근거가 아니다. 임의의 짧은 조각, 네 축에 재사용한 같은 구절, 고른 값과 어긋나는
 * 근거, 답한 질문이 다른 근거는 받지 않는다. 언어별 allowlist 나 새 한국어 정규식을
 * 쓰지 않으므로 어떤 언어의 명시적 답변도 같은 규칙으로 통과한다.
 *
 * @returns {{ confirmed: boolean, method: string|null, evidence: object|null,
 *             rejection: string|null }}
 */
export function recognizeReadabilityAnswer(userSource, proposedEvidence, { language = null, selected = null, questionId = READABILITY_QUESTION_ID } = {}) {
  const source = String(userSource ?? '');
  const evidence = normalizeReadabilityEvidence(proposedEvidence);
  let rejection = null;
  if (evidence) {
    const haystack = normalizeQuote(source);
    const seen = new Set();
    rejection = READABILITY_AXES.map((axis) => {
      const entry = evidence[axis];
      if (!entry) return `${axis}:missing`;
      const quote = normalizeQuote(entry.quote);
      if (!quote || !haystack.includes(quote)) return `${axis}:not_in_user_input`;
      if (!quoteIsSubstantive(entry.quote, language)) return `${axis}:quote_too_thin`;
      if (seen.has(quote)) return `${axis}:quote_reused`;
      seen.add(quote);
      if (entry.questionId !== questionId) return `${axis}:question_mismatch`;
      if (selected && entry.selected !== selected[axis]) return `${axis}:selected_value_mismatch`;
      return null;
    }).find(Boolean) ?? null;
    if (!rejection) return { confirmed: true, method: 'user-answer-quote', evidence, rejection: null };
  }
  if (READABILITY_KO_SIGNALS.every((pattern) => pattern.test(source))) {
    return { confirmed: true, method: 'ko-answer-pattern', evidence, rejection: null };
  }
  return { confirmed: false, method: null, evidence, rejection: rejection ?? 'no_user_answer' };
}

function povDesign(value, fallbackPov) {
  const obj = value && typeof value === 'object' ? value : {};
  return {
    mode: String(obj.mode ?? fallbackPov ?? '3인칭제한').slice(0, 100),
    openingViewpoint: String(obj.openingViewpoint ?? '').trim().slice(0, 100),
    narrativeDistance: String(obj.narrativeDistance ?? '').trim().slice(0, 200),
    readerKnowledgePolicy: String(obj.readerKnowledgePolicy ?? '').trim().slice(0, 300),
    switchPolicy: String(obj.switchPolicy ?? '').trim().slice(0, 300),
  };
}

function voiceExample(value) {
  const obj = value && typeof value === 'object' ? value : {};
  return {
    situation: String(obj.situation ?? '').trim().slice(0, 160),
    example: String(obj.example ?? '').trim().slice(0, 500),
    craftReason: String(obj.craftReason ?? '').trim().slice(0, 300),
  };
}

function voiceContract(value) {
  const obj = value && typeof value === 'object' ? value : {};
  return {
    genreVoiceRecipe: {
      narration: String(obj.genreVoiceRecipe?.narration ?? '').trim().slice(0, 400),
      dialogue: String(obj.genreVoiceRecipe?.dialogue ?? '').trim().slice(0, 400),
      exposition: String(obj.genreVoiceRecipe?.exposition ?? '').trim().slice(0, 400),
      rhythm: String(obj.genreVoiceRecipe?.rhythm ?? '').trim().slice(0, 300),
    },
    narrationExamples: (Array.isArray(obj.narrationExamples) ? obj.narrationExamples : []).map(voiceExample).filter((item) => item.example).slice(0, 4),
    dialogueExamples: (Array.isArray(obj.dialogueExamples) ? obj.dialogueExamples : []).map(voiceExample).filter((item) => item.example).slice(0, 4),
    emotionalRendering: String(obj.emotionalRendering ?? '').trim().slice(0, 400),
  };
}

export async function runStoryProfile({ store, workId, brief, mode = 'review', feedback = '', language = null, length = null, providers, retryValidation = false }) {
  const foundation = await store.loadFoundation(workId);
  const stored = normalizeStoryProfile(await store.loadStoryProfile(workId));
  // foundation 이전의 명시적 언어 변경은 새 revision 이다. 이전 언어의 예시·승인·
  // 대기 질문을 계승하지 않는다. foundation 이 이미 있으면 아래 resolveWorkLanguage
  // 가 WORK_LANGUAGE_IMMUTABLE 로 거부한다.
  const languageChange = foundation ? { changed: false } : profileLanguageChange({ profile: stored, requested: language });
  const existing = languageChange.changed ? null : stored;
  const workLanguage = await resolveWorkLanguage({
    store, workId, requested: language, length, foundation, profile: existing,
  });
  const kit = promptKit({ contract: workLanguage.contract });
  const source = String(brief || foundation?.brief || '').trim();
  if (!source) throw new Error('작품의 장르·톤·이야기 방향을 설명하는 brief가 필요합니다.');
  const response = await providers.complete({
    model: MODEL, jsonMode: true, step: 'story-profile',
    messages: kit.messages('story-profile', {
      source,
      genre: foundation?.genre ?? kit.phrases.common.newWork,
      existingJson: existing ? JSON.stringify(existing) : kit.phrases.common.noneParen,
      feedback: feedback || kit.phrases.common.noneParen,
      engineGenres: ENGINE_GENRES.join(', '),
    }),
  });
  if ((providers.pending?.length ?? 0) > 0) return { preview: true };
  const obj = parse(response.text);
  if (!obj || typeof obj !== 'object') throw new Error('story-profile JSON을 해석할 수 없습니다.');
  const proposedEngine = String(obj.engineGenre ?? 'other');
  // v3 은 `format.length` 만 저장한다. 모델 schema/정규화/fallback 어디에서도
  // chapterChars 를 다시 만들어 넣지 않는다.
  const resolvedLength = resolveProposedLength({
    language: workLanguage.language,
    requestedLength: length,
    proposedFormat: obj.format,
  });
  // 읽기 난도 승인은 사용자의 실제 답변에서만 나온다. 모델이 confirmedByUser 를
  // true 로 답해도 사용자 원문 근거가 없으면 승인으로 세지 않는다. 근거는 모델이
  // 고른 축 값과도 맞아야 한다.
  const proposedReadability = normalizeReadabilityContract(obj.readabilityContract);
  const readabilityAnswer = recognizeReadabilityAnswer(
    `${source}\n${feedback}`,
    obj.readabilityContract?.userAnswerEvidence,
    {
      language: workLanguage.language,
      selected: Object.fromEntries(READABILITY_AXES.map((axis) => [axis, proposedReadability[axis]])),
    },
  );
  const profile = {
    workId, profileSchemaVersion: STORY_PROFILE_SCHEMA_VERSION, contractVersion: MCP_CONTRACT_VERSION,
    language: workLanguage.language,
    genreLabel: String(obj.genreLabel ?? source).slice(0, 200),
    engineGenre: ENGINE_SET.has(proposedEngine) ? proposedEngine : 'other',
    subgenres: list(obj.subgenres), tones: list(obj.tones), storyEngines: list(obj.storyEngines), themes: list(obj.themes),
    format: {
      pov: String(obj.format?.pov ?? foundation?.povMode ?? '3인칭제한').slice(0, 100),
      length: { unit: resolvedLength.unit, target: resolvedLength.target },
      serialization: String(obj.format?.serialization ?? kit.phrases.profile.defaultSerialization).slice(0, 200),
      dialogueBreakMode: resolveDialogueBreakMode(obj.format, workLanguage.promptFamily),
    },
    narrativeContract: narrativeContract(obj.narrativeContract, kit),
    readabilityContract: normalizeReadabilityContract({
      ...obj.readabilityContract,
      confirmedByUser: mode === 'review'
        && obj.readabilityContract?.confirmedByUser === true
        && readabilityAnswer.confirmed,
      userAnswerEvidence: readabilityAnswer.confirmed ? readabilityAnswer.evidence : null,
    }),
    povDesign: povDesign(obj.povDesign, obj.format?.pov ?? foundation?.povMode),
    voiceContract: voiceContract(obj.voiceContract),
    tracking: { engineBacked: list(obj.tracking?.engineBacked), semantic: list(obj.tracking?.semantic) },
    promptGuidance: guidance(obj.promptGuidance),
    designReview: null,
    sourceBrief: source,
    status: mode === 'auto' ? 'active' : 'pending',
    createdAt: new Date().toISOString(),
    // revision 은 계속 증가한다. 언어를 바꾼 revision 은 새 번호를 받되 이전 언어의
    // 예시·승인·대기 질문은 계승하지 않는다.
    revision: Number(stored?.revision ?? 0) + 1,
    ...(languageChange.changed
      ? { languageChangedFrom: languageChange.from, supersedesRevision: stored?.revision ?? null }
      : {}),
  };
  profile.designReview = ensureReadabilityQuestion(
    designReview(obj.designReview, existing?.designReview, kit),
    profile.readabilityContract,
    mode,
    kit,
    obj.designReview,
  );
  const approvalResolution = await resolveWorkLanguage({ store, workId, foundation, profile, requested: profile.language, length: profile.format.length });
  const approval = await gateApprovalActivation({ store, workId, kind: 'profile', value: profile, providers, resolution: approvalResolution, retryValidation });
  if (!approval.ok) return { ...approval, candidate: profile };
  await store.saveStoryProfile(workId, profile);
  return {
    profile,
    language: profile.language,
    length: profile.format.length,
    ...(profile.readabilityContract.confirmedByUser
      ? { readabilityAnswer: { method: readabilityAnswer.method, evidence: readabilityAnswer.evidence ?? null } }
      : {}),
    ...(languageChange.changed
      ? {
        languageChanged: { from: languageChange.from, to: languageChange.to },
        languageChangeNote: '작품 언어를 바꾼 새 프로필 revision입니다. 이전 언어의 예시·승인·대기 질문은 계승하지 않았습니다.',
      }
      : {}),
    ...(profile.status === 'pending'
      ? { needsApproval: true, instruction: profile.designReview.openQuestions.length
        ? 'StoryProfile과 작품 발견 인터뷰의 열린 질문을 사용자에게 보여주세요. 답변은 lore_profile의 feedback으로 넘겨 다음 review 라운드를 이어가며, 사용자가 현재 결정을 의도적으로 승인하면 바로 승인할 수도 있습니다.'
        : '사용자에게 장르·톤·이야기 동력·작법 지침을 보여주고 승인 여부를 물으세요.' }
      : { needsApproval: false }),
  };
}

export async function runStoryProfileDecide({ store, workId, action, providers, retryValidation = false }) {
  const profile = normalizeStoryProfile(await store.loadStoryProfile(workId));
  if (!profile) throw new Error('검토할 StoryProfile이 없습니다.');
  if (action === 'approve') {
    const kit = promptKit({ profile });
    const readability = { ...profile.readabilityContract, confirmedByUser: true };
    const settled = kit.phrases.profile.readabilitySettled(readability);
    const active = {
      ...profile,
      readabilityContract: readability,
      designReview: {
        ...profile.designReview,
        settledDecisions: [...new Set([...(profile.designReview?.settledDecisions ?? []), settled])].slice(0, 40),
        openQuestions: (profile.designReview?.openQuestions ?? []).filter((item) => item.id !== READABILITY_QUESTION_ID),
      },
      status: 'active', approvedAt: new Date().toISOString(),
    };
    // New contracts preserve already checked generated decisions/questions. User
    // confirmation is approval metadata, not newly generated translated prose.
    if (Object.hasOwn(profile, 'language')) active.designReview = profile.designReview;
    const approval = await gateApprovalActivation({ store, workId, kind: 'profile', value: active, providers, consumeOnly: true, retryValidation });
    if (!approval.ok) return { ...approval, approved: false };
    await store.saveStoryProfile(workId, active);
    return { approved: true, profile: active };
  }
  if (action === 'reject') {
    const rejected = { ...profile, status: 'rejected', rejectedAt: new Date().toISOString() };
    await store.saveStoryProfile(workId, rejected);
    return { approved: false, profile: rejected, instruction: '피드백과 함께 lore_profile을 다시 호출하세요.' };
  }
  throw new Error('action은 approve 또는 reject여야 합니다.');
}

export async function runStoryProfileStatus({ store, workId }) {
  const profile = normalizeStoryProfile(await store.loadStoryProfile(workId));
  if (!profile) return { profiled: false, runtime: runtimeVersion() };
  // 조회는 저장된 문서를 바꾸지 않는다. 구형 프로필의 chapterChars 는 읽기
  // 경계에서만 legacyCodeUnits 로 해석해 보여 준다.
  const workLanguage = await resolveWorkLanguage({ store, workId, profile });
  return {
    profiled: true,
    profile,
    language: workLanguage.language,
    implicitLanguage: workLanguage.implicitLegacy,
    length: { unit: workLanguage.length.unit, target: workLanguage.length.target, source: workLanguage.length.source },
    runtime: runtimeVersion(),
  };
}

/**
 * 프로필에 **실제로 저장된** 분량만 읽는다. 저장된 값이 없으면 줄 자체를 만들지
 * 않는다. 렌더링 단계에서 `chapterChars: 3000` 같은 기본값을 주입하지 않는다.
 */
function approvedLength(profile) {
  if (profile?.format?.length == null && profile?.format?.chapterChars == null) return null;
  const resolved = readProfileLength(profile, { language: profile.language ?? null });
  return { unit: resolved.unit, target: resolved.target };
}

export function renderStoryProfile(profile, kitSource) {
  profile = normalizeStoryProfile(profile);
  if (!profile || profile.status !== 'active') return '';
  const kit = asKit(kitSource ?? { profile });
  const t = kit.phrases.profile;
  const none = kit.phrases.common.none;
  const undecided = kit.phrases.common.undecided;
  const length = approvedLength(profile);
  const p = profile.promptGuidance;
  return [
    t.heading(profile.genreLabel),
    t.engineGenre(profile.engineGenre), t.subgenres(profile.subgenres.join(', ') || none),
    t.tones(profile.tones.join(', ') || none), t.storyEngines(profile.storyEngines.join(', ') || none),
    t.themes(profile.themes.join(', ') || none), t.semanticTracking(profile.tracking.semantic.join(', ') || none),
    profile.narrativeContract ? t.readingContract(profile.narrativeContract.depthMode, profile.narrativeContract.readerPromise || undecided) : '',
    profile.narrativeContract?.readerLegibility ? t.readerLegibility(profile.narrativeContract.readerLegibility) : '',
    profile.narrativeContract?.registerPolicy ? t.registerPolicy(profile.narrativeContract.registerPolicy) : '',
    t.readability(profile.readabilityContract),
    length ? t.length(length.unit, length.target) : '',
    // The switch rule is the part the writer breaks (2026-09-15 zh-Hant sample:
    // both viewpoints' interiority in one chapter under "alternate between
    // chapters"); the reviewer already judges POV against it.
    profile.povDesign ? t.povDesign(profile.povDesign.mode, profile.povDesign.openingViewpoint || undecided, profile.povDesign.switchPolicy || '') : '',
    renderVoiceContract(profile.voiceContract, kit),
    t.draftRules, ...p.draft.map((item) => `  - ${item}`), t.avoidRules, ...p.avoid.map((item) => `  - ${item}`),
  ].filter(Boolean).join('\n');
}

function renderVoiceContract(contract, kitSource) {
  if (!contract) return '';
  const kit = asKit(kitSource);
  const t = kit.phrases.profile;
  const recipe = contract.genreVoiceRecipe ?? {};
  const lines = [
    recipe.narration ? t.voiceNarration(recipe.narration) : '',
    recipe.dialogue ? t.voiceDialogue(recipe.dialogue) : '',
    recipe.exposition ? t.voiceExposition(recipe.exposition) : '',
    recipe.rhythm ? t.voiceRhythm(recipe.rhythm) : '',
    ...(contract.narrationExamples ?? []).map((item) => t.narrationExample(item.situation || t.exampleSituation, item.example, item.craftReason)),
    ...(contract.dialogueExamples ?? []).map((item) => t.dialogueExample(item.situation || t.exampleSituation, item.example, item.craftReason)),
    contract.emotionalRendering ? t.emotionalRendering(contract.emotionalRendering) : '',
  ].filter(Boolean);
  return lines.length ? [t.voiceHeading, ...lines].join('\n') : '';
}

export function compileBriefWithProfile(brief, profile, stage, kitSource) {
  profile = normalizeStoryProfile(profile);
  if (!profile || profile.status !== 'active') return brief;
  const kit = asKit(kitSource ?? { profile });
  const t = kit.phrases.profile;
  const stages = Array.isArray(stage) ? stage : [stage];
  const rules = stages.flatMap((name) => profile.promptGuidance?.[name] ?? []);
  const contract = profile.narrativeContract
    ? [t.briefReadingContract(profile.narrativeContract.depthMode), t.briefOpeningPressure(profile.narrativeContract.openingPressure), t.briefExpositionPolicy(profile.narrativeContract.expositionPolicy), t.briefReaderLegibility(profile.narrativeContract.readerLegibility), t.briefRegisterPolicy(profile.narrativeContract.registerPolicy)].filter(Boolean)
    : [];
  const readability = profile.readabilityContract
    ? [t.briefSurfaceEase(profile.readabilityContract.surfaceEase), t.briefConceptPacing(profile.readabilityContract.conceptPacing), t.briefInferenceLoad(profile.readabilityContract.inferenceLoad), t.briefComplexityRamp(profile.readabilityContract.complexityRamp)]
    : [];
  const pov = profile.povDesign
    ? [t.briefPovDesign(profile.povDesign.mode), t.briefViewpointReason(profile.povDesign.viewpointReason || profile.narrativeContract?.viewpointReason || '')].filter(Boolean)
    : [];
  const length = approvedLength(profile);
  const voice = renderVoiceContract(profile.voiceContract, kit);
  return [brief, '', t.briefHeading(profile.genreLabel), t.briefSubgenres(profile.subgenres.join(', ')), t.briefTones(profile.tones.join(', ')), t.briefStoryEngines(profile.storyEngines.join(', ')), ...contract, ...readability, ...pov, length ? t.briefLength(length.unit, length.target) : '', voice, ...rules.map((r) => `- ${r}`), ...profile.promptGuidance.avoid.map((r) => `- ${t.forbidden(r)}`)].filter(Boolean).join('\n');
}

/** Put durable genre/tone rules on the engine's system-prompt override seam. */
export function profileToPromptOverride(profile, instruction = '', kitSource) {
  if (!profile || profile.status !== 'active') return instruction ? { freeNotes: String(instruction).slice(0, 1000) } : undefined;
  const kit = asKit(kitSource ?? { profile });
  const draft = profile.promptGuidance?.draft ?? [];
  const avoid = profile.promptGuidance?.avoid ?? [];
  const voice = profile.voiceContract ? renderVoiceContract(profile.voiceContract, kit) : '';
  return {
    genrePolicy: [profile.genreLabel, ...(profile.subgenres ?? []), ...(profile.storyEngines ?? [])].filter(Boolean).join(' · ').slice(0, 500),
    toneGuideline: [...(profile.tones ?? []), ...draft].filter(Boolean).join(' / ').slice(0, 500),
    freeNotes: [voice, ...avoid.map((item) => kit.phrases.profile.forbidden(item)), instruction].filter(Boolean).join('\n').slice(0, 1400),
  };
}

export { renderVoiceContract };
