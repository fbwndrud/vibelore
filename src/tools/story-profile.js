import { ENGINE_GENRES } from '../../engine/src/continuity/genre-profile.js';
import { PROMPT_FAMILY_KO } from '../../engine/src/core/language-policy.js';

import { MCP_CONTRACT_VERSION, runtimeVersion } from '../core/runtime-version.js';
import {
  STORY_PROFILE_SCHEMA_VERSION, profileLanguageChange, readProfileLength,
  resolveProposedLength, resolveWorkLanguage,
} from '../core/work-language.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const READABILITY_QUESTION_ID = 'reading-experience-contract';
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

function designQuestion(value, index) {
  const obj = value && typeof value === 'object' ? value : {};
  const question = String(obj.question ?? '').trim().slice(0, 600);
  if (!question) return null;
  return {
    id: String(obj.id ?? `profile_question_${index + 1}`).trim().slice(0, 80),
    title: String(obj.title ?? `설계 질문 ${index + 1}`).trim().slice(0, 120),
    question,
    recommendation: String(obj.recommendation ?? '').trim().slice(0, 600),
  };
}

function designReview(value, previous) {
  const obj = value && typeof value === 'object' ? value : {};
  const prior = previous && typeof previous === 'object' ? previous : {};
  const settledDecisions = [...new Set([
    ...list(prior.settledDecisions, 40),
    ...list(obj.settledDecisions, 40),
  ])].slice(0, 40);
  const openQuestions = (Array.isArray(obj.openQuestions) ? obj.openQuestions : [])
    .map(designQuestion)
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
 * 대사 문단 정책. 한국어 웹소설의 기존 계약은 그대로 두고, 비ko 신규 작품은
 * `natural`(그 언어의 일반적인 대사+발화자 서술)을 기본으로 한다. 명시된
 * strict/relaxed/natural 는 언어와 무관하게 그대로 존중한다.
 */
function resolveDialogueBreakMode(format, promptFamily) {
  const explicit = DIALOGUE_BREAK_MODES.includes(format?.dialogueBreakMode) ? format.dialogueBreakMode : null;
  if (promptFamily !== PROMPT_FAMILY_KO) return explicit ?? 'natural';
  const serialization = String(format?.serialization ?? '웹소설 연재');
  if (/웹\s*(?:소설|연재)|web\s*(?:novel|serial)/i.test(serialization)) return 'strict';
  return explicit ?? 'strict';
}

function narrativeContract(value) {
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
      ?? '전문 지식 없이도 장면의 즉시 목표, 대사의 표면 뜻, 선택의 결과를 붙잡을 수 있게 쓴다.').trim().slice(0, 300),
    registerPolicy: String(obj.registerPolicy
      ?? '정밀한 시각·수치·전문어는 문서와 작전 상황에 쓰고, 일상 대화와 서술에서는 인물이 실제로 쓸 자연스러운 표현을 우선한다.').trim().slice(0, 300),
  };
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function normalizeReadabilityContract(value) {
  const obj = value && typeof value === 'object' ? value : {};
  return {
    schemaVersion: 1,
    surfaceEase: oneOf(obj.surfaceEase, ['easy', 'standard', 'dense'], READABILITY_DEFAULTS.surfaceEase),
    conceptPacing: oneOf(obj.conceptPacing, ['slow', 'standard', 'fast'], READABILITY_DEFAULTS.conceptPacing),
    inferenceLoad: oneOf(obj.inferenceLoad, ['explicit', 'balanced', 'subtext-heavy'], READABILITY_DEFAULTS.inferenceLoad),
    complexityRamp: oneOf(obj.complexityRamp, ['onboarding-first', 'steady', 'dense-start'], READABILITY_DEFAULTS.complexityRamp),
    confirmedByUser: obj.confirmedByUser === true,
  };
}

export function normalizeStoryProfile(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  return {
    ...profile,
    narrativeContract: narrativeContract(profile.narrativeContract),
    readabilityContract: normalizeReadabilityContract(profile.readabilityContract),
  };
}

function ensureReadabilityQuestion(review, readability, mode) {
  if (mode !== 'review' || readability.confirmedByUser) return review;
  const question = {
      id: READABILITY_QUESTION_ID,
      title: '읽기 난도',
      question: '주제의 깊이와 별개로, 문장 난도·새 개념 투입 속도·독자가 추론할 양·초반 복잡성 상승 방식을 어떻게 할까요?',
      recommendation: '권장은 ‘쉽게 읽히는 문장 + 느린 개념 투입 + 표면 뜻은 명확하게 + 초반은 익숙해진 뒤 복잡해짐’입니다. 주제적 깊이는 이와 별개로 높일 수 있습니다.',
    };
  const withoutRequired = review.openQuestions.filter((item) => item.id !== READABILITY_QUESTION_ID);
  const openQuestions = [...withoutRequired.slice(0, 4), question];
  return {
    ...review,
    askedQuestionIds: [...new Set([...(review.askedQuestionIds ?? []), READABILITY_QUESTION_ID])].slice(0, 40),
    openQuestions,
  };
}

function explicitReadabilityChoice(value) {
  const source = String(value ?? '');
  const signals = [
    /surfaceEase|표면\s*(?:가독성|난도)|문장\s*(?:난도|난이도)|쉽게\s*읽|읽(?:기|기는).{0,8}쉽/i,
    /conceptPacing|개념.{0,12}(?:속도|천천|빠르|보통)|새\s*개념/i,
    /inferenceLoad|추론\s*(?:부담|량)|표면\s*뜻|서브텍스트/i,
    /complexityRamp|(?:초반|첫\s*(?:아크|장|화)|복잡(?:도|성)).{0,20}(?:복잡|적응|쉽|완만|상승)|onboarding-first|dense-start/i,
  ];
  return signals.every((pattern) => pattern.test(source));
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

export async function runStoryProfile({ store, workId, brief, mode = 'review', feedback = '', language = null, length = null, providers }) {
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
  const source = String(brief || foundation?.brief || '').trim();
  if (!source) throw new Error('작품의 장르·톤·이야기 방향을 설명하는 brief가 필요합니다.');
  const response = await providers.complete({
    model: MODEL, jsonMode: true, step: 'story-profile',
    messages: [
        { role: 'system', content: '당신은 장르 이름을 외우는 분류기가 아니라 소설 작법 프로필 컴파일러다. 자유로운 복합 장르 요청을 독립 축으로 분해한다. engineGenre는 제공된 목록 중 연속성 검사에 가장 유용한 하나를 고른다. 톤을 장르로 오인하지 않는다. 검증 불가능한 취향을 hard 규칙으로 만들지 않는다. review는 작품 발견 인터뷰다. 독서 쾌감과 주제적 깊이, 장르 문법과 차별점, 주인공 욕망·결핍·도덕선, 핵심 장치의 효용·한계·오판, 1화 압력과 첫 보상, 초반 고구마 허용치, 세계관 새 개념 예산, 시점과 정보 차이, 조연의 독립 욕망과 관계 강도, 대사·리듬·분량, 피할 전개 중 결과를 실질적으로 바꾸는 미결정만 한 라운드 최대 5개 질문한다. 주제의 깊이와 표면 가독성을 같은 축으로 취급하지 않는다. readabilityContract.confirmedByUser는 brief나 feedback에 문장 난도·개념 속도·추론 부담·복잡성 상승 방식에 대한 사용자 선택이 있을 때만 true다. 기존 settledDecisions와 askedQuestionIds를 존중해 이미 확정되거나 물었던 결정을 반복하지 않는다. 모델이 작품 설계 중 정할 이름·소품·화별 미세 규칙은 묻지 않는다. 중요한 미결정이 없으면 질문 수를 채우지 말고 openQuestions를 빈 배열로 둔다. 순수 JSON만 출력한다.' },
      { role: 'user', content: [
        `작품 브리프: ${source}`, `기존 엔진 장르: ${foundation?.genre ?? '(신작)'}`,
        `기존 프로필: ${existing ? JSON.stringify(existing) : '(없음)'}`,
        `이번 라운드 답변·수정 피드백: ${feedback || '(없음)'}`, `허용 engineGenre: ${ENGINE_GENRES.join(', ')}`, '',
        'JSON 스키마:',
        '{"genreLabel":"사용자가 이해할 복합 장르명","engineGenre":"허용 목록 중 하나","subgenres":["..."],"tones":["..."],"storyEngines":["성장/생존/복수/탐험/관계/경영 등"],"themes":["..."],"format":{"pov":"...","length":{"unit":"legacyCodeUnits|graphemes|words","target":3000},"serialization":"...","dialogueBreakMode":"strict|relaxed|natural"},"narrativeContract":{"depthMode":"light-webnovel|commercial-dramatic|deep-world-driven","readerPromise":"독자가 이 작품에서 기대할 핵심 경험","openingPressure":"초반에 반드시 체감시킬 세계/관계의 압력","viewpointReason":"첫 시점이 이 인물이어야 하는 이유","expositionPolicy":"설명할 정보와 장면으로만 체감시킬 정보의 원칙","readerLegibility":"전문 지식 없이도 독자가 장면의 목표·대사 표면 뜻·결과를 붙잡게 하는 원칙","registerPolicy":"정밀 시각·수치·전문어와 일상 표현을 상황별로 쓰는 원칙"},"readabilityContract":{"surfaceEase":"easy|standard|dense","conceptPacing":"slow|standard|fast","inferenceLoad":"explicit|balanced|subtext-heavy","complexityRamp":"onboarding-first|steady|dense-start","confirmedByUser":false},"povDesign":{"mode":"1인칭|3인칭제한|전지적|다중시점 등","openingViewpoint":"첫 화 시점 인물 또는 서술 위치","narrativeDistance":"서술자가 인물 내면과 세계를 어느 거리에서 다루는가","readerKnowledgePolicy":"독자가 시점 인물보다 많이/적게 아는 정보 정책","switchPolicy":"시점 전환 허용 조건"},"voiceContract":{"genreVoiceRecipe":{"narration":"이 장르에서 해야 하는 서술 방식","dialogue":"이 장르에서 해야 하는 대사 방식","exposition":"세계/정보를 문장으로 처리하는 방식","rhythm":"문장 길이와 박자"},"narrationExamples":[{"situation":"상황","example":"해야 하는 서술 예시","craftReason":"왜 이 문장이 이 장르에 맞는가"}],"dialogueExamples":[{"situation":"상황","example":"해야 하는 대사 예시","craftReason":"왜 이 말투가 맞는가"}],"emotionalRendering":"감정을 이름 붙이지 않고 드러내는 방식"},"tracking":{"engineBacked":["엔진이 구조적으로 검사 가능한 축"],"semantic":["모델이 의미적으로 확인할 축"]},"promptGuidance":{"worldbuild":["..."],"cast":["..."],"arc":["..."],"draft":["..."],"avoid":["..."]},"designReview":{"settledDecisions":["이번까지 확정된 결정"],"openQuestions":[{"id":"안정적인_id","title":"짧은 제목","question":"지금 답할 결정 질문","recommendation":"권장 답과 이유"}]}}',
        '각 guidance는 추상 형용사가 아니라 장면과 판단에 적용 가능한 한 문장 규칙으로 작성한다.',
        'deep-world-driven을 고르면 초반 목표는 사건 해결보다 세계 질서와 인물 결핍의 충돌을 각인하는 것이다.',
      ].join('\n') },
    ],
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
  const profile = {
    workId, profileSchemaVersion: STORY_PROFILE_SCHEMA_VERSION, contractVersion: MCP_CONTRACT_VERSION,
    language: workLanguage.language,
    genreLabel: String(obj.genreLabel ?? source).slice(0, 200),
    engineGenre: ENGINE_SET.has(proposedEngine) ? proposedEngine : 'other',
    subgenres: list(obj.subgenres), tones: list(obj.tones), storyEngines: list(obj.storyEngines), themes: list(obj.themes),
    format: {
      pov: String(obj.format?.pov ?? foundation?.povMode ?? '3인칭제한').slice(0, 100),
      length: { unit: resolvedLength.unit, target: resolvedLength.target },
      serialization: String(obj.format?.serialization ?? '웹소설 연재').slice(0, 200),
      dialogueBreakMode: resolveDialogueBreakMode(obj.format, workLanguage.promptFamily),
    },
    narrativeContract: narrativeContract(obj.narrativeContract),
    readabilityContract: normalizeReadabilityContract({
      ...obj.readabilityContract,
      confirmedByUser: mode === 'review'
        && obj.readabilityContract?.confirmedByUser === true
        && explicitReadabilityChoice(`${source}\n${feedback}`),
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
    designReview(obj.designReview, existing?.designReview),
    profile.readabilityContract,
    mode,
  );
  await store.saveStoryProfile(workId, profile);
  return {
    profile,
    language: profile.language,
    length: profile.format.length,
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

export async function runStoryProfileDecide({ store, workId, action }) {
  const profile = normalizeStoryProfile(await store.loadStoryProfile(workId));
  if (!profile) throw new Error('검토할 StoryProfile이 없습니다.');
  if (action === 'approve') {
    const readability = { ...profile.readabilityContract, confirmedByUser: true };
    const settled = `읽기 난도: ${readability.surfaceEase} / 개념 속도: ${readability.conceptPacing} / 추론 부담: ${readability.inferenceLoad} / 복잡성: ${readability.complexityRamp}`;
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

export function renderStoryProfile(profile) {
  profile = normalizeStoryProfile(profile);
  if (!profile || profile.status !== 'active') return '';
  const p = profile.promptGuidance;
  return [
    `## 승인된 작품 StoryProfile — ${profile.genreLabel}`,
    `- 엔진 기준 장르: ${profile.engineGenre}`, `- 서브장르: ${profile.subgenres.join(', ') || '없음'}`,
    `- 톤: ${profile.tones.join(', ') || '없음'}`, `- 이야기 동력: ${profile.storyEngines.join(', ') || '없음'}`,
    `- 테마: ${profile.themes.join(', ') || '없음'}`, `- 의미 추적: ${profile.tracking.semantic.join(', ') || '없음'}`,
    profile.narrativeContract ? `- 독서 계약: ${profile.narrativeContract.depthMode} / ${profile.narrativeContract.readerPromise || '미정'}` : '',
    profile.narrativeContract?.readerLegibility ? `- 독자 접근성: ${profile.narrativeContract.readerLegibility}` : '',
    profile.narrativeContract?.registerPolicy ? `- 표현 레지스터: ${profile.narrativeContract.registerPolicy}` : '',
    `- 읽기 난도: 표면=${profile.readabilityContract.surfaceEase} / 개념=${profile.readabilityContract.conceptPacing} / 추론=${profile.readabilityContract.inferenceLoad} / 상승=${profile.readabilityContract.complexityRamp}`,
    profile.povDesign ? `- 시점 설계: ${profile.povDesign.mode} / 첫 시점 ${profile.povDesign.openingViewpoint || '미정'}` : '',
    renderVoiceContract(profile.voiceContract),
    '- 회차 작법:', ...p.draft.map((item) => `  - ${item}`), '- 피할 것:', ...p.avoid.map((item) => `  - ${item}`),
  ].filter(Boolean).join('\n');
}

function renderVoiceContract(contract) {
  if (!contract) return '';
  const recipe = contract.genreVoiceRecipe ?? {};
  const lines = [
    recipe.narration ? `- 서술 레시피: ${recipe.narration}` : '',
    recipe.dialogue ? `- 대사 레시피: ${recipe.dialogue}` : '',
    recipe.exposition ? `- 설명 레시피: ${recipe.exposition}` : '',
    recipe.rhythm ? `- 문장 리듬: ${recipe.rhythm}` : '',
    ...(contract.narrationExamples ?? []).map((item) => `- 서술 예시(${item.situation || '상황'}): ${item.example}${item.craftReason ? ` / 이유=${item.craftReason}` : ''}`),
    ...(contract.dialogueExamples ?? []).map((item) => `- 대사 예시(${item.situation || '상황'}): ${item.example}${item.craftReason ? ` / 이유=${item.craftReason}` : ''}`),
    contract.emotionalRendering ? `- 감정 처리: ${contract.emotionalRendering}` : '',
  ].filter(Boolean);
  return lines.length ? ['## 작품 Voice Contract', ...lines].join('\n') : '';
}

export function compileBriefWithProfile(brief, profile, stage) {
  profile = normalizeStoryProfile(profile);
  if (!profile || profile.status !== 'active') return brief;
  const stages = Array.isArray(stage) ? stage : [stage];
  const rules = stages.flatMap((name) => profile.promptGuidance?.[name] ?? []);
  const contract = profile.narrativeContract
    ? [`독서 계약: ${profile.narrativeContract.depthMode}`, `초반 압력: ${profile.narrativeContract.openingPressure}`, `설명 정책: ${profile.narrativeContract.expositionPolicy}`, `독자 접근성: ${profile.narrativeContract.readerLegibility}`, `표현 레지스터: ${profile.narrativeContract.registerPolicy}`].filter(Boolean)
    : [];
  const readability = profile.readabilityContract
    ? [`표면 가독성: ${profile.readabilityContract.surfaceEase}`, `새 개념 속도: ${profile.readabilityContract.conceptPacing}`, `독자 추론 부담: ${profile.readabilityContract.inferenceLoad}`, `복잡성 상승: ${profile.readabilityContract.complexityRamp}`]
    : [];
  const pov = profile.povDesign
    ? [`시점 설계: ${profile.povDesign.mode}`, `첫 시점 이유: ${profile.povDesign.viewpointReason || profile.narrativeContract?.viewpointReason || ''}`].filter(Boolean)
    : [];
  const voice = renderVoiceContract(profile.voiceContract);
  return [brief, '', `[StoryProfile: ${profile.genreLabel}]`, `서브장르: ${profile.subgenres.join(', ')}`, `톤: ${profile.tones.join(', ')}`, `이야기 동력: ${profile.storyEngines.join(', ')}`, ...contract, ...readability, ...pov, voice, ...rules.map((r) => `- ${r}`), ...profile.promptGuidance.avoid.map((r) => `- 금지: ${r}`)].filter(Boolean).join('\n');
}

/** Put durable genre/tone rules on the engine's system-prompt override seam. */
export function profileToPromptOverride(profile, instruction = '') {
  if (!profile || profile.status !== 'active') return instruction ? { freeNotes: String(instruction).slice(0, 1000) } : undefined;
  const draft = profile.promptGuidance?.draft ?? [];
  const avoid = profile.promptGuidance?.avoid ?? [];
  const voice = profile.voiceContract ? renderVoiceContract(profile.voiceContract) : '';
  return {
    genrePolicy: [profile.genreLabel, ...(profile.subgenres ?? []), ...(profile.storyEngines ?? [])].filter(Boolean).join(' · ').slice(0, 500),
    toneGuideline: [...(profile.tones ?? []), ...draft].filter(Boolean).join(' / ').slice(0, 500),
    freeNotes: [voice, ...avoid.map((item) => `금지: ${item}`), instruction].filter(Boolean).join('\n').slice(0, 1400),
  };
}
