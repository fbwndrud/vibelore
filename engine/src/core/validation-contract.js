/**
 * validation-contract — 발행 게이트가 공유하는 하나의 결정적 검증기 (다국어 Phase 3).
 *
 * 여기서 정하는 것: 발행 산출물 묶음의 정본화와 hash, 구조화된 `languageCompliance`
 * 판정의 검증, 필수 불변식 coverage 의 **별도** 검증, 검사 영수증과 승인의 결합 확인.
 * `workflow.js` / `check.js` / `sync.js` 가 발급하고 `commit.js` / workflow 승인 /
 * sync apply 가 소비하는 값이 전부 이 모듈을 지난다.
 *
 * 여기서 하지 않는 것: provider 호출, 파일 IO, 영수증 저장, 요약·delta 생성,
 * 문자 비율·문자 체계 추정, 실행하지 않은 검사의 통과 합성, **입력 문자열의 변형**.
 * 판정 근거가 없으면 성공을 만들지 않고 안정적인 `.code` 를 가진 오류를 던진다.
 *
 * 언어 태그와 승인된 인용 예외의 구문 계약은 `language-policy.js` 가 유일한 결정
 * 지점이며(두 번째 resolver 를 만들지 않는다), wildcard 예외는 기존
 * `normalizeLanguageExceptions()` 가 그대로 거부한다. 검사 계획과 coverage 값의
 * 의미는 `continuity/checker-registry.js` 가 소유하고 이 모듈은 **판정만** 한다.
 *
 * 신뢰 경계: 이 모듈은 호출자가 넘긴 "이미 통과한 평가 결과"를 권한으로 취급하지
 * 않는다. 영수증 발급·소비는 실제 산출물·작업 계약·신뢰 검사 계획으로 다시 계산한
 * 결과에만 근거한다. JSON 으로 저장됐다 돌아온 객체는 자기 신고일 뿐이다.
 */
import { createHash } from 'node:crypto';
import {
    computeLanguageContractHash,
    normalizeLanguageExceptions,
    normalizeLanguageTag,
} from './language-policy.js';

export const VALIDATION_CONTRACT_SCHEMA_VERSION = 1;
export const ARTIFACT_SCHEMA_VERSION = 1;
/** 영수증 재사용 키의 일부. 다른 버전이 발급한 영수증은 소비하지 않는다. */
export const VALIDATOR_VERSION = 'validation-contract-v1';
/**
 * 언어 필드 분류기의 버전. 선언된 스키마 이름표가 바뀌면 올린다.
 * 호출자 투영과 함께 판정 hash · 영수증 신원에 묶인다.
 */
export const LANGUAGE_FIELD_CLASSIFIER_VERSION = 4;
/** 호출자가 추가 이름을 넘기지 않은 기본 투영. 기본 API 는 이 값으로 동작한다. */
export const DEFAULT_LANGUAGE_FIELD_PROJECTION = Object.freeze({
    humanTextFields: Object.freeze([]),
});

/** 모델이 돌려주는 판정. 영수증의 판정(`passed`)과 다른 축이다. */
export const VALIDATION_VERDICTS = Object.freeze(['pass', 'fail', 'uncertain']);
export const RECEIPT_VERDICT_PASSED = 'passed';

/** 발행 산출물의 종류. 화 원고와 승인 묶음은 스키마도 필수 검사도 다르다. */
export const ARTIFACT_KIND_CHAPTER = 'chapter';
export const ARTIFACT_KIND_APPROVAL = 'approval';
export const ARTIFACT_KINDS = Object.freeze([ARTIFACT_KIND_CHAPTER, ARTIFACT_KIND_APPROVAL]);

/** 화 원고 묶음은 정확히 이 다섯 필드다. 승인 묶음이 이를 흉내 내지 않는다. */
export const ARTIFACT_FIELDS = Object.freeze(['prose', 'title', 'summary', 'semanticDelta', 'castManifestRaw']);
/** 작품 언어 계약이 적용되는 발행 값. */
export const LANGUAGE_SCOPED_ARTIFACT_FIELDS = Object.freeze(['prose', 'title', 'summary', 'semanticDelta']);
/** 기계 계약(키·ID·enum). 언어 판정의 근거가 될 수 없다. */
export const MACHINE_EXEMPT_ARTIFACT_FIELDS = Object.freeze(['castManifestRaw']);

/** 최초 발행 전 승인 게이트(프로필·기반·작품·작가·아크·화 계획)의 묶음. */
export const APPROVAL_ARTIFACT_KINDS = Object.freeze([
    'profile', 'foundation', 'story', 'writer', 'arc', 'episode',
]);
export const APPROVAL_ARTIFACT_FIELDS = Object.freeze(['approvalKind', 'revision', 'value']);
export const APPROVAL_LANGUAGE_SCOPED_FIELDS = Object.freeze(['value']);
export const APPROVAL_MACHINE_EXEMPT_FIELDS = Object.freeze(['approvalKind', 'revision']);

/**
 * 스키마가 소유한 기계 계약 이름. ID·enum·경로·sentinel 키는 어떤 산출물에서도 언어
 * 판정의 근거가 아니다. 한국어로 적힌 기계 enum 값(`pov: '3인칭제한'`, `mode` 등)도
 * 여기서 면제된다 — 값이 한국어라는 사실이 작품 언어 위반의 증거가 되지 못한다.
 */
export const MACHINE_CONTRACT_FIELD_NAMES = Object.freeze([
    'requestedLocale', 'resolvedLocale', 'segmenterGranularity', 'baseLanguage', 'icu', 'gender', 'register',
    'appearedCharacterIds', 'approvalKind', 'arcId', 'arcNumber', 'artifactHash', 'artifactKind', 'artifactSchemaVersion',
    'at', 'beatId', 'canonicalFormatVersion', 'chapter', 'chapterId', 'characterId', 'checkId',
    'checkerId', 'checksum', 'code', 'commit', 'contractHash', 'createdAt', 'dialogueBreakMode',
    'digest', 'engineGenre', 'entityId', 'epoch', 'eventId', 'from', 'fromBeat', 'genre', 'hash',
    'nextBeat', 'hookId', 'horizon', 'id', 'ids', 'invariantId', 'key', 'kind', 'language', 'locale', 'mode', 'op',
    'path', 'payoffTiming', 'phase', 'planSourceHash', 'pov', 'povCharacter', 'povMode', 'promptFamily', 'revision', 'role', 'schemaVersion',
    'speakerId',
    'scope', 'sentinel', 'serialization', 'severity', 'sha', 'slug', 'sourceHead', 'status',
    'storyTime', 'tag', 'target', 'targetId', 'timestamp', 'to', 'toBeat', 'transactionTime', 'type',
    'unit', 'updatedAt', 'uri', 'url', 'validationEpoch', 'version', 'worldline', 'workId',
]);

/**
 * 같은 이름이라도 스키마가 다르면 계약이 다르다. `intrinsic.role` 은 기존 한국어
 * 휴리스틱이 읽는 **자유 서술**이고, workflow 의 `role` 은 enum 이다. 경로로 구분한다.
 */
export const HUMAN_TEXT_PATH_OVERRIDES = Object.freeze([
    'intrinsic.role',
    // StoryProfile 의 시점 서술. `format.pov` 와 `povDesign.mode` 는 프로필 프롬프트가
    // 자유 문장으로 받는 값이라(`3인칭제한`, `三人称限定(千尋視点固定)`) enum 이 아니다.
    // 실제 아랍어 표본에서 영어 용어가 섞인 이 값을 검토자가 지목했을 때 machine 면제로
    // 근거를 거부하면 3회 시도가 전부 소진된다.
    'format.pov', 'povDesign.mode',
    // cast-design 스키마의 관계·기억·관계별 말투 값. `kind` 는 다른 스키마에서 enum 이지만
    // `relationships[].kind` 는 "라이벌"/"師と手伝い" 같은 생성 서술이다.
    'relationships.kind', 'relationships.state', 'mutable.knownFacts',
    'relationVariants.adjustment', 'relationVariants.sample',
    // ChapterDelta 의 `relationshipOps[].state` 는 관계 변화를 서술한 문장이다(`kind` 는
    // working_relationship 같은 기계 라벨로 남는다). 2026-09-15 ja 1화 표본.
    'relationshipOps.state',
    // ChapterDelta 의 `mutableChanges[].status` 는 "혼자 남아 빈 배정표를 붙잡고 자책함" 같은 상태
    // 서술이다(foundation `mutable.status` 의 alive 같은 enum 과 다른 계약). 2026-09-15 ko 1화 표본.
    'mutableChanges.status',
]);

/**
 * 사용자 입력의 출처를 보존하는 필드. 사용자가 대화에서 쓴 언어 그대로 남아야 하며
 * 작품 언어로 옮겨 쓰는 대상이 아니다(영어 소설의 한국어 브리프를 위반으로 잡지 않는다).
 */
export const USER_PROVENANCE_FIELD_NAMES = Object.freeze([
    'direction', 'feedback', 'rationale', 'sourceBrief', 'userAnswerEvidence', 'userQuote', 'userSource',
]);

/**
 * `semanticDelta` 안에서 **생성된 자연어**인 필드. 엔진의 entity-ops / hook-ops 와
 * 의미 영향(influence) 스키마에서 문장을 담는 이름이다. 여기에 없는 중첩 값은 기계
 * 계약이거나 분류되지 않았으므로 언어 판정의 근거가 되지 못한다.
 */
export const SEMANTIC_DELTA_HUMAN_TEXT_FIELDS = Object.freeze([
    // influenceEvents: `anchor` 는 본문 근거 인용, behavioralProof 의 `alternativesAvailable`/`chosen` 은
    // 선택지 서술이다(2026-09-15 ja 1화 표본에서 미분류로 3회 소진).
    'alternativesAvailable', 'anchor', 'chosen',
    'belief', 'behavioralProof', 'competingHypotheses', 'cost', 'costPaid', 'description',
    'descriptions', 'fact', 'facts', 'hypothesis', 'interpretation', 'interpretations',
    'noInfluenceReason', 'plotBeat', 'sceneTags', 'knownFactsAdded', 'label', 'location', 'name', 'names', 'nextChoiceBias', 'note', 'notes',
    'reason', 'resolution', 'summary', 'term', 'terms', 'text', 'title', 'value',
]);

/**
 * 승인 묶음 `value` 안의 **생성된 자연어**. StoryProfile / ArcPlan / EpisodePlan /
 * WriterSkill / openingContract 이 실제로 쓰는 필드 이름이다
 * (`src/tools/story-profile.js`, `arc.js`, `episode-plan.js`, `writer-skill.js`,
 * `engine/src/generators/text/steps/chapter-plan.js`).
 */
export const APPROVAL_VALUE_HUMAN_TEXT_FIELDS = Object.freeze([
    'activeQuestion', 'aestheticThesis', 'antiFixation', 'audition', 'avoid', 'beat', 'belief',
    'causedByChoice', 'characterWound', 'closingState', 'coreAttention', 'craftReason',
    'description', 'detail', 'dialogue', 'discoverySpaces', 'draft', 'emotionalRendering',
    'escalation', 'example', 'exposition', 'expositionPolicy', 'fact', 'fallback',
    'firstIrreversibleChoice', 'genreLabel', 'genreVoiceRecipe', 'goal', 'hook', 'hypothesis',
    'immediateGoal', 'interpretation', 'knowledge', 'noInfluenceReason', 'plotBeat', 'sceneTags', 'knownFactsAdded', 'label', 'location',
    'logline', 'misbelief', 'name', 'names', 'narration',
    'narrativeDistance', 'nextChoiceBias', 'note', 'notes', 'openingPressure', 'openingViewpoint',
    'outcome', 'plan', 'premise', 'pressure', 'promise', 'promisePaid', 'proofOnPage',
    'protagonistImmediateWant', 'question', 'readerBridge', 'readerKnowledgePolicy',
    'readerLegibility', 'readerPromise', 'reason', 'recommendation', 'redLine', 'registerPolicy',
    'resolution', 'rhythm', 'rules', 'sceneTransformations', 'situation', 'stake', 'storyEngines',
    'subgenres', 'summary', 'surfaceEvent', 'switchPolicy', 'term', 'terms', 'text', 'themes',
    'ticking', 'tickingLoss', 'title', 'tones', 'value', 'viewpointReason', 'voice',
    'voiceExamples', 'withheldContext', 'worldPressure',
]);

/** 두 kind 의 교집합. 어떤 계획도 이 둘을 필수에서 뺄 수 없다. */
export const ALWAYS_MANDATORY_INVARIANTS = Object.freeze(['SCHEMA', 'OUTPUT_LANGUAGE']);
/** 화 원고는 등록표의 무조건 불변식을 전부 필수로 갖는다. */
export const CHAPTER_REQUIRED_INVARIANTS = Object.freeze([
    'SCHEMA', 'INTRINSIC', 'WORLD', 'REGISTRATION', 'LENGTH', 'FORMAT', 'OUTPUT_LANGUAGE',
]);
/** 계획이 실제 정본 맥락으로 required/not_applicable/advisory 중 하나로 확정해야 한다. */
export const CHAPTER_CONDITIONAL_INVARIANTS = Object.freeze(['ADDRESSING', 'POV', 'SENSITIVE']);
/** 승인 묶음은 원고가 아니다. 구조 검사는 실제 필요한 것만 더한다. */
export const APPROVAL_REQUIRED_INVARIANTS = Object.freeze(['SCHEMA', 'OUTPUT_LANGUAGE']);
/** 원고 전용 검사. 승인 묶음에 붙이면 계획 자체가 잘못된 것이다. */
export const APPROVAL_FORBIDDEN_INVARIANTS = Object.freeze(['ADDRESSING', 'FORMAT', 'LENGTH', 'POV', 'SENSITIVE']);

/** 등록표의 coverage 값 + 실제로 들어올 수 있는 미완료 상태. */
export const COVERAGE_VALUES = Object.freeze([
    'validated', 'unvalidated', 'not_applicable', 'failed', 'uncertain', 'error',
]);

export const VALIDATION_ERROR_CODES = Object.freeze({
    INVALID_ARTIFACT_BUNDLE: 'INVALID_ARTIFACT_BUNDLE',
    UNKNOWN_ARTIFACT_FIELD: 'UNKNOWN_ARTIFACT_FIELD',
    NON_SERIALIZABLE_ARTIFACT_VALUE: 'NON_SERIALIZABLE_ARTIFACT_VALUE',
    ARTIFACT_KIND_MISMATCH: 'ARTIFACT_KIND_MISMATCH',
    INVALID_LANGUAGE_COMPLIANCE: 'INVALID_LANGUAGE_COMPLIANCE',
    ARTIFACT_HASH_MISMATCH: 'ARTIFACT_HASH_MISMATCH',
    INCOMPLETE_LANGUAGE_EVIDENCE: 'INCOMPLETE_LANGUAGE_EVIDENCE',
    UNAPPROVED_LANGUAGE_EXCEPTION: 'UNAPPROVED_LANGUAGE_EXCEPTION',
    LANGUAGE_TARGET_MISMATCH: 'LANGUAGE_TARGET_MISMATCH',
    INVALID_CHECKER_PLAN: 'INVALID_CHECKER_PLAN',
    CHECKER_PLAN_MISMATCH: 'CHECKER_PLAN_MISMATCH',
    INVALID_COVERAGE_REPORT: 'INVALID_COVERAGE_REPORT',
    COVERAGE_INCOMPLETE: 'COVERAGE_INCOMPLETE',
    OUTPUT_LANGUAGE_MISMATCH: 'OUTPUT_LANGUAGE_MISMATCH',
    VALIDATION_INCOMPLETE: 'VALIDATION_INCOMPLETE',
    MISSING_VALIDATION_RECEIPT: 'MISSING_VALIDATION_RECEIPT',
    INVALID_RECEIPT: 'INVALID_RECEIPT',
    INCOMPLETE_EXPECTATION: 'INCOMPLETE_EXPECTATION',
    RECEIPT_IDENTITY_MISMATCH: 'RECEIPT_IDENTITY_MISMATCH',
    CONTRACT_HASH_MISMATCH: 'CONTRACT_HASH_MISMATCH',
    LANGUAGE_COMPLIANCE_HASH_MISMATCH: 'LANGUAGE_COMPLIANCE_HASH_MISMATCH',
    COVERAGE_HASH_MISMATCH: 'COVERAGE_HASH_MISMATCH',
    STALE_VALIDATION_RECEIPT: 'STALE_VALIDATION_RECEIPT',
    RECEIPT_ALREADY_CONSUMED: 'RECEIPT_ALREADY_CONSUMED',
    VALIDATOR_VERSION_MISMATCH: 'VALIDATOR_VERSION_MISMATCH',
    INVALID_APPROVAL_BINDING: 'INVALID_APPROVAL_BINDING',
});

/**
 * 정적 사용자 안내 문구. 구체적인 값은 `err.details` 로만 전달하며 문구에 사용자
 * 입력이나 모델 출력을 끼워 넣지 않는다.
 */
const VALIDATION_ERROR_MESSAGES = Object.freeze({
    INVALID_ARTIFACT_BUNDLE: {
        ko: '발행 산출물 묶음이 올바르지 않다. 필수 값이 빠지면 빈 값으로 대신하지 않는다.',
        en: 'The publication artifact bundle is invalid. A missing required value is not silently empty.',
    },
    UNKNOWN_ARTIFACT_FIELD: {
        ko: '계약에 없는 산출물 필드가 있다. 발행 값을 hash 밖에 둘 수 없다.',
        en: 'The bundle contains a field outside the contract. Publishable values cannot sit outside the hash.',
    },
    NON_SERIALIZABLE_ARTIFACT_VALUE: {
        ko: '결정적으로 직렬화할 수 없는 값이 산출물에 있다.',
        en: 'The bundle contains a value that cannot be serialized deterministically.',
    },
    ARTIFACT_KIND_MISMATCH: {
        ko: '산출물의 종류가 기대와 다르다. 승인 묶음과 화 원고는 같은 검사가 아니다.',
        en: 'The artifact kind differs from the expectation. Approval bundles and chapters are not the same check.',
    },
    INVALID_LANGUAGE_COMPLIANCE: {
        ko: '출력 언어 판정의 형식이 올바르지 않다. 이는 판정 성공이 아니다.',
        en: 'The output-language judgment is malformed. This is not a successful judgment.',
    },
    ARTIFACT_HASH_MISMATCH: {
        ko: '판정이 가리키는 산출물이 실제로 결합된 묶음과 다르다.',
        en: 'The judgment refers to a different artifact than the bound bundle.',
    },
    INCOMPLETE_LANGUAGE_EVIDENCE: {
        ko: '출력 언어 판정의 근거가 불완전하다. 실패에는 실제 자연어 필드의 인용과 사유가 필요하다.',
        en: 'The output-language evidence is incomplete. A failure needs a real in-field natural-text quote and a reason.',
    },
    UNAPPROVED_LANGUAGE_EXCEPTION: {
        ko: '판정이 승인되지 않은 인용 예외를 주장한다.',
        en: 'The judgment claims a language exception that was never approved.',
    },
    LANGUAGE_TARGET_MISMATCH: {
        ko: '판정의 대상 언어가 작품의 목표 언어와 다르다.',
        en: 'The judgment targets a different language than the work contract.',
    },
    INVALID_CHECKER_PLAN: {
        ko: '검사 계획이 올바르지 않다. 필수 불변식 집합은 산출물 종류가 정하며 계획이 낮출 수 없다.',
        en: 'The checker plan is invalid. The mandatory invariant set follows the artifact kind and a plan cannot lower it.',
    },
    CHECKER_PLAN_MISMATCH: {
        ko: '영수증이 다른 검사 계획에 묶여 있다.',
        en: 'The receipt is bound to a different checker plan.',
    },
    INVALID_COVERAGE_REPORT: {
        ko: '불변식 coverage 보고의 형식이 올바르지 않다.',
        en: 'The invariant coverage report is malformed.',
    },
    COVERAGE_INCOMPLETE: {
        ko: '필수 불변식이 검증되지 않았다. 검사 완료로 처리하지 않는다.',
        en: 'A mandatory invariant is not validated. The check is not complete.',
    },
    OUTPUT_LANGUAGE_MISMATCH: {
        ko: '출력 언어 계약 위반이 확인됐다.',
        en: 'An output-language contract violation was confirmed.',
    },
    VALIDATION_INCOMPLETE: {
        ko: '검증이 완료되지 않았다. 미검증 항목이 남아 있다.',
        en: 'Validation is incomplete. Unvalidated items remain.',
    },
    MISSING_VALIDATION_RECEIPT: {
        ko: '검사 영수증이 없다. 발행 전에 검사를 거쳐야 한다.',
        en: 'The validation receipt is missing. The artifact must be checked before publication.',
    },
    INVALID_RECEIPT: {
        ko: '검사 영수증의 형식이 올바르지 않거나 신원 값이 위조됐다.',
        en: 'The validation receipt is malformed or its identity was forged.',
    },
    INCOMPLETE_EXPECTATION: {
        ko: '확인해야 할 기대 신원 값이 빠졌다. 확인하지 않은 값을 통과로 처리하지 않는다.',
        en: 'A required expectation is missing. Unverified values are not treated as verified.',
    },
    RECEIPT_IDENTITY_MISMATCH: {
        ko: '검사 영수증이 다른 작업·화·원천·계획에 속한다.',
        en: 'The receipt belongs to a different work, chapter, source or plan.',
    },
    CONTRACT_HASH_MISMATCH: {
        ko: '핀된 작업 계약 hash 가 현재 계약과 다르다.',
        en: 'The pinned work-contract hash differs from the current contract.',
    },
    LANGUAGE_COMPLIANCE_HASH_MISMATCH: {
        ko: '결합된 출력 언어 판정이 영수증의 판정과 다르다.',
        en: 'The bound output-language judgment differs from the one in the receipt.',
    },
    COVERAGE_HASH_MISMATCH: {
        ko: '결합된 불변식 coverage 가 영수증의 coverage 와 다르다.',
        en: 'The bound invariant coverage differs from the one in the receipt.',
    },
    STALE_VALIDATION_RECEIPT: {
        ko: '오래된 검사 영수증이다. 값이 원래대로 돌아와도 부활하지 않으며 새 epoch 로 재검사한다.',
        en: 'The receipt is stale. Reverting values does not revive it; re-validate under a new epoch.',
    },
    RECEIPT_ALREADY_CONSUMED: {
        ko: '이미 소비된 검사 영수증이다.',
        en: 'The validation receipt was already consumed.',
    },
    VALIDATOR_VERSION_MISMATCH: {
        ko: '다른 검증기 버전이 발급한 영수증이다.',
        en: 'The receipt was issued by a different validator version.',
    },
    INVALID_APPROVAL_BINDING: {
        ko: '승인이 해당 검사에 묶여 있지 않다.',
        en: 'The approval is not bound to this validation.',
    },
});

/** 결정적 오류. `.code` 는 안정적인 계약이며 호스트가 그대로 노출할 수 있다. */
export class ValidationContractError extends Error {
    constructor(code, details = {}) {
        const messages = VALIDATION_ERROR_MESSAGES[code] ?? { ko: code, en: code };
        super(messages.en);
        this.name = 'ValidationContractError';
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.messages = Object.freeze({ ...messages });
    }
}

function fail(code, details) {
    throw new ValidationContractError(code, details);
}

// ─── 결정적 직렬화 ──────────────────────────────────────────────────────────

function compareCodePoints(a, b) {
    if (a === b)
        return 0;
    return a < b ? -1 : 1;
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/** hash 전용 직렬화. 키는 코드 포인트 순, 배열 순서는 데이터이므로 보존한다. */
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort(compareCodePoints);
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/;

// ─── 정본 산출물 묶음 ───────────────────────────────────────────────────────

/**
 * 산출물 값의 정규화 겸 검증. 결정적으로 직렬화할 수 없는 값은 조용히 버리지 않고
 * 경로와 함께 거부한다.
 *
 * 문자열은 **정확히 보존**한다. NFC 통일은 하지 않는다 — NFD 원고와 시각적으로 같은
 * NFC 원고는 `legacyCodeUnits` 길이가 다르므로, 둘이 같은 `artifactHash` 를 가지면
 * 검사된 길이를 우회한 치환이 통과한다. 정본화는 **객체 키 순서**만 정한다.
 */
function canonicalValue(value, path, seen) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'boolean' || value === null)
        return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            fail(VALIDATION_ERROR_CODES.NON_SERIALIZABLE_ARTIFACT_VALUE, { path, reason: 'non_finite_number' });
        return value;
    }
    if (Array.isArray(value) || isPlainObject(value)) {
        if (seen.has(value))
            fail(VALIDATION_ERROR_CODES.NON_SERIALIZABLE_ARTIFACT_VALUE, { path, reason: 'circular_reference' });
        seen.add(value);
        let out;
        if (Array.isArray(value)) {
            out = Object.freeze(value.map((item, index) => canonicalValue(item, `${path}[${index}]`, seen)));
        }
        else {
            const result = {};
            for (const key of Object.keys(value).sort(compareCodePoints)) {
                const child = value[key];
                if (child === undefined)
                    fail(VALIDATION_ERROR_CODES.NON_SERIALIZABLE_ARTIFACT_VALUE, {
                        path: `${path}.${key}`,
                        reason: 'undefined_value',
                    });
                result[key] = canonicalValue(child, `${path}.${key}`, seen);
            }
            out = Object.freeze(result);
        }
        seen.delete(value);
        return out;
    }
    fail(VALIDATION_ERROR_CODES.NON_SERIALIZABLE_ARTIFACT_VALUE, { path, reason: 'unsupported_type', received: typeof value });
    return null;
}

/**
 * 문자열 필드의 검증. **값은 그대로 돌려준다** — 공백 여부는 비어 있음을 판정할 때만
 * 보고, 발행된 바이트를 깎지 않는다(인용 근거가 발행 문자열과 정확히 대조돼야 한다).
 */
function requiredText(value, field, { allowEmpty = false } = {}) {
    if (typeof value !== 'string')
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { field, reason: 'not_a_string', received: typeof value });
    if (!allowEmpty && value.trim() === '')
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { field, reason: 'empty_required_field' });
    return value;
}

function isEmptyContainer(value) {
    return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
}

/**
 * 입력이 어느 종류의 산출물인지. 명시적 `artifactKind` 가 우선이며, 승인 묶음은
 * `kind`(또는 `approvalKind`) + `value` 조합으로 구분한다.
 */
export function artifactKindOf(input) {
    if (!isPlainObject(input))
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, {
            reason: 'not_an_object',
            received: input === null || input === undefined ? 'absent' : typeof input,
        });
    if (Object.hasOwn(input, 'artifactKind')) {
        if (!ARTIFACT_KINDS.includes(input.artifactKind))
            fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, {
                reason: 'unknown_artifact_kind',
                received: typeof input.artifactKind === 'string' ? input.artifactKind : null,
            });
        return input.artifactKind;
    }
    if (Object.hasOwn(input, 'value') && (Object.hasOwn(input, 'kind') || Object.hasOwn(input, 'approvalKind')))
        return ARTIFACT_KIND_APPROVAL;
    return ARTIFACT_KIND_CHAPTER;
}

/**
 * 발행 직전 화 원고 묶음의 정본화. `prose` 만이 아니라 제목·요약·의미 delta·cast
 * manifest 를 함께 묶는다. 누락은 빈 값이 아니라 오류이며, 계약에 없는 키는 hash 밖의
 * 발행 값을 만들지 않도록 거부한다. 요약을 자동 생성하지 않는다.
 *
 * @param {{ prose: string, title: string, summary: string|object|Array,
 *           semanticDelta: object|Array, castManifestRaw: string|object|Array }} bundle
 */
export function canonicalArtifact(bundle) {
    if (!isPlainObject(bundle))
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { reason: 'not_an_object', received: bundle === null ? 'null' : typeof bundle });
    if (Object.hasOwn(bundle, 'artifactKind') && bundle.artifactKind !== ARTIFACT_KIND_CHAPTER)
        fail(VALIDATION_ERROR_CODES.ARTIFACT_KIND_MISMATCH, {
            expected: ARTIFACT_KIND_CHAPTER,
            received: typeof bundle.artifactKind === 'string' ? bundle.artifactKind : null,
        });

    const allowed = new Set([...ARTIFACT_FIELDS, 'artifactSchemaVersion', 'artifactKind']);
    for (const key of Object.keys(bundle)) {
        if (!allowed.has(key))
            fail(VALIDATION_ERROR_CODES.UNKNOWN_ARTIFACT_FIELD, { field: key });
    }
    if (Object.hasOwn(bundle, 'artifactSchemaVersion') && bundle.artifactSchemaVersion !== ARTIFACT_SCHEMA_VERSION)
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, {
            reason: 'unknown_artifact_schema_version',
            received: bundle.artifactSchemaVersion ?? null,
        });
    for (const field of ARTIFACT_FIELDS) {
        if (!Object.hasOwn(bundle, field) || bundle[field] === undefined || bundle[field] === null)
            fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { reason: 'missing_required_field', field });
    }

    const prose = requiredText(bundle.prose, 'prose');
    const title = requiredText(bundle.title, 'title');

    let summary;
    if (typeof bundle.summary === 'string') {
        summary = requiredText(bundle.summary, 'summary');
    }
    else if (Array.isArray(bundle.summary) || isPlainObject(bundle.summary)) {
        if (isEmptyContainer(bundle.summary))
            fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { field: 'summary', reason: 'empty_required_field' });
        summary = canonicalValue(bundle.summary, 'summary', new Set());
    }
    else {
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { field: 'summary', reason: 'invalid_type', received: typeof bundle.summary });
    }

    // delta 와 manifest 는 "명시적으로 비어 있음" 이 정당한 값이다. 키 자체의 부재만 오류다.
    if (!Array.isArray(bundle.semanticDelta) && !isPlainObject(bundle.semanticDelta))
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, {
            field: 'semanticDelta', reason: 'invalid_type', received: typeof bundle.semanticDelta,
        });
    const semanticDelta = canonicalValue(bundle.semanticDelta, 'semanticDelta', new Set());

    let castManifestRaw;
    if (typeof bundle.castManifestRaw === 'string')
        // 기존 엔진에서 "manifest 없음" 의 정당한 표현은 빈 문자열이다. 발행된 바이트를 그대로 둔다.
        castManifestRaw = requiredText(bundle.castManifestRaw, 'castManifestRaw', { allowEmpty: true });
    else if (Array.isArray(bundle.castManifestRaw) || isPlainObject(bundle.castManifestRaw))
        castManifestRaw = canonicalValue(bundle.castManifestRaw, 'castManifestRaw', new Set());
    else
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, {
            field: 'castManifestRaw', reason: 'invalid_type', received: typeof bundle.castManifestRaw,
        });

    return Object.freeze({
        artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
        artifactKind: ARTIFACT_KIND_CHAPTER,
        prose,
        title,
        summary,
        semanticDelta,
        castManifestRaw,
    });
}

/**
 * 최초 발행 전 승인 게이트(프로필·기반·작품·작가·아크·화 계획)의 정본 산출물.
 *
 * 승인 묶음은 화 원고가 아니다. 언어 검증을 재사용하려고 가짜 `prose`/`title`/`summary`
 * 를 지어내지 않고, 자체 스키마와 자체 kind hash 를 갖는다. `revision` 이 hash 에 들어가
 * 승인이 특정 개정본에 묶인다.
 *
 * @param {{ kind: string, revision: string|number, value: string|object|Array }} input
 */
export function canonicalApprovalArtifact(input) {
    if (!isPlainObject(input))
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, {
            reason: 'not_an_object',
            received: input === null || input === undefined ? 'absent' : typeof input,
        });
    if (Object.hasOwn(input, 'artifactKind') && input.artifactKind !== ARTIFACT_KIND_APPROVAL)
        fail(VALIDATION_ERROR_CODES.ARTIFACT_KIND_MISMATCH, {
            expected: ARTIFACT_KIND_APPROVAL,
            received: typeof input.artifactKind === 'string' ? input.artifactKind : null,
        });

    const allowed = new Set(['kind', 'approvalKind', 'revision', 'value', 'artifactSchemaVersion', 'artifactKind']);
    for (const key of Object.keys(input)) {
        if (!allowed.has(key))
            fail(VALIDATION_ERROR_CODES.UNKNOWN_ARTIFACT_FIELD, { field: key, artifactKind: ARTIFACT_KIND_APPROVAL });
    }
    if (Object.hasOwn(input, 'artifactSchemaVersion') && input.artifactSchemaVersion !== ARTIFACT_SCHEMA_VERSION)
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, {
            reason: 'unknown_artifact_schema_version',
            received: input.artifactSchemaVersion ?? null,
        });
    if (Object.hasOwn(input, 'kind') && Object.hasOwn(input, 'approvalKind') && input.kind !== input.approvalKind)
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { field: 'kind', reason: 'conflicting_approval_kind' });

    const rawKind = Object.hasOwn(input, 'kind') ? input.kind : input.approvalKind;
    if (!APPROVAL_ARTIFACT_KINDS.includes(rawKind))
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, {
            field: 'kind',
            reason: 'unknown_approval_kind',
            received: typeof rawKind === 'string' ? rawKind : null,
        });

    if (!Object.hasOwn(input, 'revision') || input.revision === undefined || input.revision === null)
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { reason: 'missing_required_field', field: 'revision' });
    let revision;
    if (typeof input.revision === 'number') {
        if (!Number.isInteger(input.revision) || input.revision <= 0)
            fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { field: 'revision', reason: 'invalid_revision' });
        revision = input.revision;
    }
    else {
        revision = requiredText(input.revision, 'revision');
    }

    if (!Object.hasOwn(input, 'value') || input.value === undefined || input.value === null)
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { reason: 'missing_required_field', field: 'value' });
    let value;
    if (typeof input.value === 'string') {
        value = requiredText(input.value, 'value');
    }
    else if (Array.isArray(input.value) || isPlainObject(input.value)) {
        if (isEmptyContainer(input.value))
            fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { field: 'value', reason: 'empty_required_field' });
        value = canonicalValue(input.value, 'value', new Set());
    }
    else {
        fail(VALIDATION_ERROR_CODES.INVALID_ARTIFACT_BUNDLE, { field: 'value', reason: 'invalid_type', received: typeof input.value });
    }

    return Object.freeze({
        artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
        artifactKind: ARTIFACT_KIND_APPROVAL,
        approvalKind: rawKind,
        revision,
        value,
    });
}

/** 종류에 맞는 정본화. 화 원고와 승인 묶음은 서로의 hash 공간을 공유하지 않는다. */
function canonicalizeByKind(input) {
    return artifactKindOf(input) === ARTIFACT_KIND_APPROVAL
        ? canonicalApprovalArtifact(input)
        : canonicalArtifact(input);
}

/** 묶음이든 정본 산출물이든 같은 canonical JSON 을 만든다(멱등). */
export function canonicalizeArtifact(input) {
    return canonicalJson(canonicalizeByKind(input));
}

/**
 * 항상 다시 정규화해서 계산한다. 입력에 hash 필드를 넣어 파생 hash 를 위조할 수
 * 없으며(계약 밖 키는 거부), 제목·요약·delta·manifest 중 무엇이 바뀌어도 값이 바뀐다.
 * 문자열을 NFC 로 접지 않으므로 NFD/NFC 치환도 다른 hash 가 된다.
 */
export function computeArtifactHash(input) {
    return sha256(canonicalizeArtifact(input));
}

// ─── 출력 언어 판정 ─────────────────────────────────────────────────────────

const COMPLIANCE_KEYS = new Set(['verdict', 'artifactHash', 'evidence', 'allowedExceptions', 'language', 'notes']);
const EVIDENCE_KEYS = new Set(['fieldPath', 'quote', 'reason']);
const EXCEPTION_KEYS = new Set(['kind', 'language', 'scope', 'rationale']);
/** 평가 결과가 JSON 으로 저장됐다 돌아온 모양. 이 밖의 키가 있으면 결과가 아니다. */
const EVALUATED_COMPLIANCE_KEYS = new Set([
    'schemaVersion', 'verdict', 'satisfied', 'artifactHash', 'artifactKind',
    'targetLanguage', 'evidence', 'allowedExceptions', 'failureCode',
    'classifierVersion', 'languageFieldProjection',
]);

const MACHINE_FIELD_NAME_SET = new Set(MACHINE_CONTRACT_FIELD_NAMES);
const USER_PROVENANCE_FIELD_NAME_SET = new Set(USER_PROVENANCE_FIELD_NAMES);
const HUMAN_TEXT_PATH_OVERRIDE_SET = new Set(HUMAN_TEXT_PATH_OVERRIDES);
/** 기계 계약과 자연어가 섞이는 구역. 선언된 이름만 언어 판정 대상이다. */
const MIXED_TEXT_ROOTS = new Set(['semanticDelta', 'value']);

function parseCompliance(compliance) {
    let value = compliance;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        }
        catch {
            fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'invalid_json' });
        }
    }
    if (!isPlainObject(value))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, {
            reason: 'not_an_object',
            received: value === null ? 'null' : typeof value,
        });
    for (const key of Object.keys(value)) {
        if (!COMPLIANCE_KEYS.has(key))
            fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'unknown_field', field: key });
    }
    for (const key of ['verdict', 'artifactHash', 'evidence', 'allowedExceptions', 'language']) {
        if (!Object.hasOwn(value, key))
            fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'missing_field', field: key });
    }
    if (!Array.isArray(value.evidence))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'evidence_not_an_array' });
    if (!Array.isArray(value.allowedExceptions))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'allowed_exceptions_not_an_array' });
    return value;
}

/** `summary.beats[0]` 같은 경로를 segment 목록으로. 문법 위반은 null. */
function parseFieldPath(raw) {
    if (typeof raw !== 'string' || raw === '')
        return null;
    const root = /^[A-Za-z][A-Za-z0-9_]*/.exec(raw);
    if (!root)
        return null;
    const segments = [{ type: 'key', value: root[0] }];
    let rest = raw.slice(root[0].length);
    while (rest !== '') {
        // 모델이 만드는 개방 기록 키(`genreDetails.개방권한`)는 ASCII 식별자가 아니다.
        // 유니코드 문자·숫자·밑줄은 점 표기로, 공백·구두점이 든 키는 `["..."]` 로 받는다.
        const key = /^\.([\p{L}\p{N}_]+)/u.exec(rest);
        if (key) {
            segments.push({ type: 'key', value: key[1] });
            rest = rest.slice(key[0].length);
            continue;
        }
        const quoted = /^\["((?:[^"\\]|\\.)*)"\]/.exec(rest);
        if (quoted) {
            segments.push({ type: 'key', value: quoted[1].replace(/\\(.)/g, '$1') });
            rest = rest.slice(quoted[0].length);
            continue;
        }
        const index = /^\[(\d+)\]/.exec(rest);
        if (index) {
            segments.push({ type: 'index', value: Number(index[1]) });
            rest = rest.slice(index[0].length);
            continue;
        }
        return null;
    }
    return segments;
}

function resolveFieldPath(artifact, segments) {
    let cursor = artifact;
    for (const segment of segments) {
        if (segment.type === 'index') {
            if (!Array.isArray(cursor) || segment.value >= cursor.length)
                return { found: false, value: null };
            cursor = cursor[segment.value];
            continue;
        }
        if (!isPlainObject(cursor) || !Object.hasOwn(cursor, segment.value))
            return { found: false, value: null };
        cursor = cursor[segment.value];
    }
    return { found: true, value: cursor };
}

function evidenceFail(reason, index, extra = {}) {
    fail(VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE, { reason, index, ...extra });
}

/**
 * 호출자가 넘긴 추가 자연어 이름만 정본화한다. 순서·중복은 의미가 아니므로
 * 코드 포인트 순·유일로 접고, 빈 추가는 기본 투영과 같다.
 * 필수 자연어 필드를 빼거나 기계·출처 이름을 자연어로 바꿀 수는 없다.
 */
function canonicalizeLanguageFieldProjection(languageFields) {
    if (languageFields === null || languageFields === undefined)
        return DEFAULT_LANGUAGE_FIELD_PROJECTION;
    if (!isPlainObject(languageFields))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'invalid_language_field_projection' });
    for (const key of Object.keys(languageFields)) {
        if (key !== 'humanTextFields')
            fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'unknown_language_field_projection', field: key });
    }
    const extra = languageFields.humanTextFields ?? [];
    if (!Array.isArray(extra))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'invalid_language_field_projection' });
    const unique = new Set();
    for (const name of extra) {
        if (typeof name !== 'string' || name.trim() === '')
            fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'invalid_language_field_projection' });
        if (MACHINE_FIELD_NAME_SET.has(name) || USER_PROVENANCE_FIELD_NAME_SET.has(name))
            fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, {
                reason: 'machine_field_projection_conflict', field: name,
            });
        unique.add(name);
    }
    if (unique.size === 0)
        return DEFAULT_LANGUAGE_FIELD_PROJECTION;
    return Object.freeze({
        humanTextFields: Object.freeze([...unique].sort(compareCodePoints)),
    });
}

/**
 * 산출물 종류가 소유한 언어 필드 분류. 호출자는 스키마에 묶인 **추가** 자연어 이름만
 * 투영할 수 있고, 필수 자연어 필드를 빼거나 기계 계약 이름을 자연어로 바꿀 수 없다.
 */
function resolveLanguageFields(artifactKind, languageFields) {
    const projection = canonicalizeLanguageFieldProjection(languageFields);
    const base = artifactKind === ARTIFACT_KIND_APPROVAL
        ? APPROVAL_VALUE_HUMAN_TEXT_FIELDS
        : SEMANTIC_DELTA_HUMAN_TEXT_FIELDS;
    const humanTextFields = new Set(base);
    for (const name of projection.humanTextFields)
        humanTextFields.add(name);
    return { humanTextFields, projection };
}

/**
 * 분류기 버전과 정본 추가 이름표의 신원. 영수증 `checkId` 와 판정 hash 가 이걸 묶는다.
 */
export function computeLanguageFieldProjectionHash(languageFields = null) {
    const projection = canonicalizeLanguageFieldProjection(languageFields);
    return sha256(canonicalJson({
        schemaVersion: VALIDATION_CONTRACT_SCHEMA_VERSION,
        classifierVersion: LANGUAGE_FIELD_CLASSIFIER_VERSION,
        humanTextFields: projection.humanTextFields,
    }));
}

/**
 * 근거가 가리키는 경로가 실제 자연어 필드인지. ID·enum·JSON 키·경로·sentinel 은 언어
 * 판정의 대상이 아니므로 근거가 되지 못한다. 분류되지 않은 중첩 값도 근거가 아니다
 * (통째로 "모든 문자열은 언어 대상" 으로 두면 기계 ID 불일치가 언어 실패로 둔갑한다).
 */
function classifyLeafPath(keys, artifactKind, humanTextFields, isString) {
    const root = keys[0];
    const leaf = keys[keys.length - 1];
    const parent = keys.length >= 2 ? keys[keys.length - 2] : null;
    // Actual entity schemas own open natural-language attribute records. A leaf
    // named "type" inside attrs is descriptive content, unlike the op's enum.
    const openAttributes = root === 'semanticDelta' && (
        (keys[1] === 'entityOps' && keys[2] === 'fields' && keys.length > 3)
        || (keys[1] === 'trackedEntityOps' && keys[2] === 'data' && keys[3] === 'attrs' && keys.length > 4));
    if (openAttributes) return null;
    // cast-design 의 `dramaticModel.genreDetails` 는 모델이 작품별 키를 만드는 개방
    // 기록이다(`{"개방권한": "..."}`). 키는 기계 계약이 아니고 값은 생성 서술이므로,
    // 그 아래 문자열은 이름 목록 없이도 언어 판정 대상이다. `genreDetails` 이름 자체가
    // 잎인 경우(빈 문자열 등)는 여기 해당하지 않는다.
    const genreDetailsIndex = keys.indexOf('genreDetails');
    if (genreDetailsIndex >= 1 && genreDetailsIndex < keys.length - 1
        && keys[genreDetailsIndex - 1] === 'dramaticModel') return null;
    // 사용자가 쓴 브리프·피드백·인용은 작품 언어로 옮겨 쓰는 값이 아니다.
    if (keys.length > 1 && USER_PROVENANCE_FIELD_NAME_SET.has(leaf))
        return 'user_provenance_field';
    // 같은 이름이라도 스키마가 다르면 계약이 다르다(`intrinsic.role` 은 자유 서술).
    const humanByPath = parent !== null && HUMAN_TEXT_PATH_OVERRIDE_SET.has(`${parent}.${leaf}`);
    // 판정은 **잎**에서 한다. `ops` 같은 구조 컨테이너는 그 아래 생성 문장을 면제하지 않는다.
    if (!humanByPath && keys.length > 1 && MACHINE_FIELD_NAME_SET.has(leaf))
        return 'machine_field';
    // trackedEntityOps.data is an open schema record; machine leaves above stay exempt.
    if (root === 'semanticDelta' && keys[1] === 'trackedEntityOps' && keys[2] === 'data' && keys.length > 3) return null;
    if (!MIXED_TEXT_ROOTS.has(root))
        return null;
    if (keys.length === 1) {
        // 승인 값 전체가 하나의 자연어 문장인 경우만 뿌리 자체를 지목할 수 있다.
        if (artifactKind === ARTIFACT_KIND_APPROVAL && isString)
            return null;
        return 'unclassified_field';
    }
    return (humanByPath || humanTextFields.has(leaf)) ? null : 'unclassified_field';
}

function classifyNestedEvidence(segments, root, resolvedValue, artifactKind, humanTextFields) {
    const keys = segments.filter((segment) => segment.type === 'key').map((segment) => segment.value);
    return classifyLeafPath(keys, artifactKind, humanTextFields, typeof resolvedValue === 'string');
}

/**
 * 산출물의 언어 대상 구역을 실제로 훑어 **분류되지 않은 생성 문자열**을 모은다.
 * 근거로 지목되지 않았다는 이유로 새 생성 필드가 조용히 검증을 건너뛰지 못하게 한다.
 * 기계 계약·사용자 출처 값은 대상이 아니며, 빈 문자열은 언어를 담지 않는다.
 */
/** `parseFieldPath` 가 다시 읽을 수 있는 키 표기. 점 표기가 안 되는 키는 따옴표로 감싼다. */
function formatPathKey(key) {
    return /^[\p{L}\p{N}_]+$/u.test(key)
        ? `.${key}`
        : `["${key.replace(/[\\"]/g, (ch) => `\\${ch}`)}"]`;
}

function collectUnclassifiedGeneratedFields(artifact, artifactKind, humanTextFields) {
    const scoped = artifactKind === ARTIFACT_KIND_APPROVAL
        ? APPROVAL_LANGUAGE_SCOPED_FIELDS
        : LANGUAGE_SCOPED_ARTIFACT_FIELDS;
    const unclassified = [];
    const visit = (value, keys, path) => {
        if (typeof value === 'string') {
            if (value.trim() === '')
                return;
            if (classifyLeafPath(keys, artifactKind, humanTextFields, true) === 'unclassified_field')
                unclassified.push(path);
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((item, index) => visit(item, keys, `${path}[${index}]`));
            return;
        }
        if (isPlainObject(value)) {
            for (const key of Object.keys(value))
                visit(value[key], [...keys, key], `${path}${formatPathKey(key)}`);
        }
    };
    for (const field of scoped) {
        if (Object.hasOwn(artifact, field))
            visit(artifact[field], [field], field);
    }
    return unclassified;
}

/**
 * 근거 한 건의 검증. 인용이 **지목한 필드에 실제로 있는지**까지 확인하며, 비교는
 * 발행된 문자열과 정확히 대조한다(정규화 접기 없음). 문자 비율이나 문자 체계 추정은
 * 쓰지 않는다.
 */
function validateEvidenceEntry(entry, index, artifact, artifactKind, humanTextFields) {
    if (!isPlainObject(entry))
        evidenceFail('entry_not_an_object', index);
    for (const key of Object.keys(entry)) {
        if (!EVIDENCE_KEYS.has(key))
            evidenceFail('unknown_field', index, { field: key });
    }
    const fieldPath = typeof entry.fieldPath === 'string' ? entry.fieldPath.trim() : '';
    const quote = typeof entry.quote === 'string' ? entry.quote : '';
    const reason = typeof entry.reason === 'string' ? entry.reason : '';
    if (fieldPath === '')
        evidenceFail('missing_field_path', index);
    if (quote.trim() === '')
        evidenceFail('missing_quote', index, { fieldPath });
    if (reason.trim() === '')
        evidenceFail('missing_reason', index, { fieldPath });

    const segments = parseFieldPath(fieldPath);
    if (!segments)
        evidenceFail('malformed_field_path', index, { fieldPath });
    const root = segments[0].value;
    const scoped = artifactKind === ARTIFACT_KIND_APPROVAL ? APPROVAL_LANGUAGE_SCOPED_FIELDS : LANGUAGE_SCOPED_ARTIFACT_FIELDS;
    const exempt = artifactKind === ARTIFACT_KIND_APPROVAL ? APPROVAL_MACHINE_EXEMPT_FIELDS : MACHINE_EXEMPT_ARTIFACT_FIELDS;
    // 기계 계약(키·ID·enum)은 언어 판정 대상이 아니므로 실패 근거가 될 수 없다.
    if (exempt.includes(root))
        evidenceFail('machine_exempt_field', index, { fieldPath });
    if (!scoped.includes(root))
        evidenceFail('unknown_field_path', index, { fieldPath });

    const resolved = resolveFieldPath(artifact, segments);
    if (!resolved.found)
        evidenceFail('field_path_not_found', index, { fieldPath });
    if (typeof resolved.value !== 'string')
        evidenceFail('field_not_text', index, { fieldPath });

    const classification = classifyNestedEvidence(segments, root, resolved.value, artifactKind, humanTextFields);
    if (classification !== null)
        evidenceFail(classification, index, { fieldPath });

    if (!resolved.value.includes(quote))
        evidenceFail('quote_not_in_field', index, { fieldPath });

    return Object.freeze({ fieldPath, quote, reason });
}

function exceptionKey(entry) {
    return canonicalJson({ kind: entry.kind, language: entry.language, scope: entry.scope });
}

function validateClaimedException(entry, index, approvedKeys) {
    if (!isPlainObject(entry))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'exception_not_an_object', index });
    for (const key of Object.keys(entry)) {
        if (!EXCEPTION_KEYS.has(key))
            fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'unknown_exception_field', index, field: key });
    }
    const kind = typeof entry.kind === 'string' ? entry.kind.trim() : '';
    const scope = typeof entry.scope === 'string' ? entry.scope.trim() : '';
    if (kind === '' || scope === '' || entry.language === undefined || entry.language === null)
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'incomplete_exception', index });
    const claimed = Object.freeze({ kind, language: normalizeLanguageTag(entry.language).tag, scope });
    if (!approvedKeys.has(exceptionKey(claimed)))
        fail(VALIDATION_ERROR_CODES.UNAPPROVED_LANGUAGE_EXCEPTION, {
            index, kind: claimed.kind, language: claimed.language, scope: claimed.scope,
        });
    return claimed;
}

/**
 * 목표 언어의 결정. 명시 인자와 작업 계약이 **둘 다** 있으면 서로 같아야 한다 —
 * 명시 인자가 계약을 조용히 덮어쓰지 못한다.
 */
function resolveTargetLanguage(targetLanguage, workContract) {
    const contractLanguage = isPlainObject(workContract) && workContract.language !== undefined && workContract.language !== null
        ? normalizeLanguageTag(workContract.language)
        : null;
    const explicit = targetLanguage !== null && targetLanguage !== undefined
        ? normalizeLanguageTag(targetLanguage)
        : null;
    if (explicit === null && contractLanguage === null)
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { missing: ['targetLanguage'] });
    if (explicit !== null && contractLanguage !== null && explicit.tag !== contractLanguage.tag)
        fail(VALIDATION_ERROR_CODES.LANGUAGE_TARGET_MISMATCH, {
            reason: 'explicit_target_conflicts_with_contract',
            expected: contractLanguage.tag,
            received: explicit.tag,
        });
    return explicit ?? contractLanguage;
}

/**
 * 승인된 예외의 결정. 명시 목록과 계약의 목록이 둘 다 있으면 같은 집합이어야 한다 —
 * 호출자가 계약보다 넓은 예외를 조용히 끼워 넣지 못한다.
 */
function resolveApprovedExceptions(allowedLanguageExceptions, workContract, target) {
    const fromContract = isPlainObject(workContract) && workContract.allowedLanguageExceptions !== undefined
        ? normalizeLanguageExceptions(workContract.allowedLanguageExceptions, { language: target })
        : null;
    const explicit = allowedLanguageExceptions !== null && allowedLanguageExceptions !== undefined
        ? normalizeLanguageExceptions(allowedLanguageExceptions, { language: target })
        : null;
    if (explicit !== null && fromContract !== null && canonicalJson(explicit) !== canonicalJson(fromContract))
        fail(VALIDATION_ERROR_CODES.UNAPPROVED_LANGUAGE_EXCEPTION, {
            reason: 'exception_override_conflict',
            expected: fromContract.length,
            received: explicit.length,
        });
    return explicit ?? fromContract ?? Object.freeze([]);
}

/**
 * 구조화된 `languageCompliance` 를 **실제로 결합된 묶음**·목표 언어·승인된 예외와
 * 대조한다. 해석 가능한 판정(`pass`/`fail`/`uncertain`)은 결과로 돌려주고,
 * 해석 불가능한 응답(잘못된 JSON·모양·hash, 빠진 language 태그, 근거 없는 실패,
 * 지목한 필드에 없는 인용, 기계 계약 필드를 근거로 든 실패)은 **판정이 아니므로**
 * 던진다. 원시 응답의 `language` 는 작품 목표 언어와 같은 BCP 47 이어야 한다.
 *
 * `artifact` 는 화 원고 묶음이거나 `canonicalApprovalArtifact()` 의 승인 묶음이다.
 * 호출자 투영과 분류기 버전은 평가 결과와 그 hash 에 그대로 남는다.
 *
 * @param {{ compliance: object|string, artifact: object, workContract?: object|null,
 *           targetLanguage?: string|object|null, allowedLanguageExceptions?: Array|null,
 *           languageFields?: { humanTextFields?: string[] }|null }} input
 */
export function evaluateLanguageCompliance({
    compliance,
    artifact,
    workContract = null,
    targetLanguage = null,
    allowedLanguageExceptions = null,
    languageFields = null,
    passEvidence = 'strict',
} = {}) {
    const canonical = canonicalizeByKind(artifact);
    const artifactKind = canonical.artifactKind;
    const artifactHash = sha256(canonicalJson(canonical));

    const target = resolveTargetLanguage(targetLanguage, workContract);
    // wildcard 예외 등 승인 목록 자체의 구문 위반은 기존 언어 계약 resolver 가 거부한다.
    const approved = resolveApprovedExceptions(allowedLanguageExceptions, workContract, target);
    const approvedKeys = new Set(approved.map((entry) => exceptionKey(entry)));
    const { humanTextFields, projection } = resolveLanguageFields(artifactKind, languageFields);

    const parsed = parseCompliance(compliance);
    if (!VALIDATION_VERDICTS.includes(parsed.verdict))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, {
            reason: 'unknown_verdict',
            received: typeof parsed.verdict === 'string' ? parsed.verdict : null,
        });
    if (typeof parsed.artifactHash !== 'string' || !HEX64.test(parsed.artifactHash))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'invalid_artifact_hash' });
    if (parsed.artifactHash !== artifactHash)
        fail(VALIDATION_ERROR_CODES.ARTIFACT_HASH_MISMATCH, { expected: artifactHash, received: parsed.artifactHash });
    // 원시 응답의 language 는 작품 목표 언어와 같아야 한다. 태그가 없으면 판정이 아니고,
    // 문자 비율로 모델의 참을 증명하지 않는다.
    const judged = normalizeLanguageTag(parsed.language);
    if (judged.tag !== target.tag)
        fail(VALIDATION_ERROR_CODES.LANGUAGE_TARGET_MISMATCH, { expected: target.tag, received: judged.tag });

    // A fail stands or falls on its evidence, so every entry must be a real
    // in-field quote. A pass needs no evidence at all, so a caller reading a raw
    // model answer may ask (`passEvidence: 'drop-invalid'`) to drop decorative
    // citations (a machine field, a quote shortened with an ellipsis) instead of
    // spending one of its attempts (2026-09-15 ko sample: three passes, each
    // undone by one such citation). Stored records are always re-read strictly:
    // a persisted pass that carries an invalid citation was not produced here.
    const evidence = parsed.verdict === 'pass' && passEvidence === 'drop-invalid'
        ? parsed.evidence.flatMap((entry, index) => {
            try {
                return [validateEvidenceEntry(entry, index, canonical, artifactKind, humanTextFields)];
            }
            catch (error) {
                if (error?.code === VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE)
                    return [];
                throw error;
            }
        })
        : parsed.evidence
            .map((entry, index) => validateEvidenceEntry(entry, index, canonical, artifactKind, humanTextFields));
    if (parsed.verdict === 'fail' && evidence.length === 0)
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE, { reason: 'fail_without_evidence' });
    const claimedExceptions = parsed.allowedExceptions
        .map((entry, index) => validateClaimedException(entry, index, approvedKeys));

    if (parsed.verdict === 'pass') {
        // 통과를 받아들이기 전에 실제 산출물을 훑는다. 분류되지 않은 새 생성 필드는
        // 조용히 빠지는 대신 명시적 투영을 요구하며, 그때까지 검증은 불완전하다.
        const unclassified = collectUnclassifiedGeneratedFields(canonical, artifactKind, humanTextFields);
        if (unclassified.length > 0)
            fail(VALIDATION_ERROR_CODES.INCOMPLETE_LANGUAGE_EVIDENCE, {
                reason: 'unclassified_generated_field',
                fieldPaths: Object.freeze(unclassified.slice(0, 20)),
            });
    }

    let failureCode = null;
    if (parsed.verdict === 'fail')
        failureCode = VALIDATION_ERROR_CODES.OUTPUT_LANGUAGE_MISMATCH;
    else if (parsed.verdict === 'uncertain')
        failureCode = VALIDATION_ERROR_CODES.VALIDATION_INCOMPLETE;

    return Object.freeze({
        schemaVersion: VALIDATION_CONTRACT_SCHEMA_VERSION,
        classifierVersion: LANGUAGE_FIELD_CLASSIFIER_VERSION,
        verdict: parsed.verdict,
        satisfied: parsed.verdict === 'pass',
        artifactKind,
        artifactHash,
        targetLanguage: target.tag,
        languageFieldProjection: projection,
        evidence: Object.freeze(evidence),
        allowedExceptions: Object.freeze(claimedExceptions),
        failureCode,
    });
}

/** 파생 값(`satisfied`/`failureCode`)은 hash 대상이 아니다. */
export function computeLanguageComplianceHash(result) {
    if (!isPlainObject(result)
        || !VALIDATION_VERDICTS.includes(result.verdict)
        || typeof result.artifactHash !== 'string'
        || typeof result.targetLanguage !== 'string'
        || !Array.isArray(result.evidence)
        || !Array.isArray(result.allowedExceptions))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'not_an_evaluated_result' });
    return sha256(canonicalJson({
        schemaVersion: result.schemaVersion ?? VALIDATION_CONTRACT_SCHEMA_VERSION,
        classifierVersion: result.classifierVersion ?? LANGUAGE_FIELD_CLASSIFIER_VERSION,
        verdict: result.verdict,
        artifactKind: result.artifactKind ?? ARTIFACT_KIND_CHAPTER,
        artifactHash: result.artifactHash,
        targetLanguage: result.targetLanguage,
        languageFieldProjection: result.languageFieldProjection ?? DEFAULT_LANGUAGE_FIELD_PROJECTION,
        evidence: result.evidence,
        allowedExceptions: result.allowedExceptions,
    }));
}

/** 저장됐다 돌아온 평가 결과인지. 원시 모델 응답은 `language` 만 있고 `targetLanguage` 가 없다. */
function looksLikeEvaluatedCompliance(value) {
    return isPlainObject(value) && Object.hasOwn(value, 'targetLanguage');
}

/**
 * 평가 결과를 **다시 판정 입력으로 되돌린다**. 저장된 객체는 신뢰 권한이 아니므로
 * 실제 산출물·계약으로 다시 평가해야 한다. `targetLanguage` 는 원시 `language` 로
 * 묶어 재평가·계약 일치 검사에 넘긴다.
 */
function complianceInputFrom(value) {
    if (!looksLikeEvaluatedCompliance(value))
        return value;
    for (const key of Object.keys(value)) {
        if (!EVALUATED_COMPLIANCE_KEYS.has(key))
            fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'not_an_evaluated_result', field: key });
    }
    if (typeof value.targetLanguage !== 'string' || value.targetLanguage.trim() === '')
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'missing_field', field: 'language' });
    return {
        verdict: value.verdict,
        artifactHash: value.artifactHash,
        evidence: Array.isArray(value.evidence) ? value.evidence.map((entry) => ({ ...entry })) : value.evidence,
        allowedExceptions: Array.isArray(value.allowedExceptions)
            ? value.allowedExceptions.map((entry) => ({ ...entry }))
            : value.allowedExceptions,
        language: value.targetLanguage,
    };
}

/**
 * 산출물이 없어 재평가할 수 없을 때의 최소 일관성 검사. 목표 언어가 계약과 다르거나
 * 근거 없는 실패를 담은 결과는 hash 하기 전에 거부한다.
 */
function assertEvaluatedComplianceConsistent(result, { artifactKind, artifactHash, targetLanguage }) {
    if (!isPlainObject(result) || !VALIDATION_VERDICTS.includes(result.verdict))
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'not_an_evaluated_result' });
    for (const key of Object.keys(result)) {
        if (!EVALUATED_COMPLIANCE_KEYS.has(key))
            fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, { reason: 'not_an_evaluated_result', field: key });
    }
    if (artifactKind !== null && (result.artifactKind ?? ARTIFACT_KIND_CHAPTER) !== artifactKind)
        fail(VALIDATION_ERROR_CODES.ARTIFACT_KIND_MISMATCH, {
            expected: artifactKind, received: result.artifactKind ?? null,
        });
    if (artifactHash !== null && result.artifactHash !== artifactHash)
        fail(VALIDATION_ERROR_CODES.ARTIFACT_HASH_MISMATCH, { expected: artifactHash, received: result.artifactHash ?? null });
    if (targetLanguage !== null && result.targetLanguage !== targetLanguage)
        fail(VALIDATION_ERROR_CODES.LANGUAGE_TARGET_MISMATCH, { expected: targetLanguage, received: result.targetLanguage ?? null });
    if (result.verdict === 'fail')
        fail(VALIDATION_ERROR_CODES.OUTPUT_LANGUAGE_MISMATCH, { evidence: result.evidence ?? [] });
    if (result.verdict === 'uncertain')
        fail(VALIDATION_ERROR_CODES.VALIDATION_INCOMPLETE, { reason: 'language_verdict_uncertain' });
}

// ─── 필수 불변식 coverage ───────────────────────────────────────────────────

function requiredIdsFromRows(rows) {
    const required = new Set();
    const notApplicable = new Set();
    const advisory = new Set();
    for (const row of rows) {
        if (!isPlainObject(row))
            fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, { reason: 'row_not_an_object' });
        const id = row.invariantId;
        if (id === null || id === undefined)
            continue;
        if (typeof id !== 'string' || id.trim() === '')
            fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, { reason: 'invalid_invariant_id' });
        if (row.invariant === 'required')
            required.add(id);
        else if (row.invariant === 'not_applicable')
            notApplicable.add(id);
        else if (row.invariant === 'advisory')
            advisory.add(id);
        else
            // `conditional` 같은 미해결 요구도는 계획 단계에서 확정돼야 한다.
            fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, {
                reason: 'unresolved_requirement',
                invariantId: id,
                received: typeof row.invariant === 'string' ? row.invariant : null,
            });
    }
    return { required, notApplicable, advisory };
}

function idSet(list, reason) {
    const out = new Set();
    for (const id of list) {
        if (typeof id !== 'string' || id.trim() === '')
            fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, { reason });
        out.add(id);
    }
    return out;
}

function resolvePlan(plan) {
    let rows = null;
    let meta = {};
    if (Array.isArray(plan)) {
        rows = plan;
    }
    else if (isPlainObject(plan)) {
        meta = plan;
        if (Array.isArray(plan.rows))
            rows = plan.rows;
        else if (Array.isArray(plan.requiredInvariantIds)) {
            const required = idSet(plan.requiredInvariantIds, 'invalid_invariant_id');
            const notApplicable = idSet(plan.notApplicableInvariantIds ?? [], 'invalid_invariant_id');
            const advisory = idSet(plan.advisoryInvariantIds ?? [], 'invalid_invariant_id');
            return { required, notApplicable, advisory, meta };
        }
    }
    if (rows === null)
        fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, { reason: 'unknown_plan_shape' });
    return { ...requiredIdsFromRows(rows), meta };
}

function assertArtifactKind(artifactKind) {
    if (!ARTIFACT_KINDS.includes(artifactKind))
        fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, {
            reason: 'unknown_artifact_kind',
            received: typeof artifactKind === 'string' ? artifactKind : null,
        });
    return artifactKind;
}

/**
 * 필수 집합은 **산출물 종류**가 정한다. 계획이 등록표의 무조건 불변식을 빠뜨리면
 * 계획 자체가 잘못된 것이며, 보고가 스스로 신고한 `requiredIds` 로 낮출 수 없다.
 * 조건부 불변식의 적용 여부는 소비자가 정본 맥락으로 만든 계획이 확정해야 한다.
 */
function assertPlanForArtifactKind(resolved, artifactKind) {
    const { required, notApplicable, advisory } = resolved;
    if (required.size === 0)
        fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, { reason: 'no_required_invariants', artifactKind });
    if (artifactKind === ARTIFACT_KIND_CHAPTER) {
        const missing = CHAPTER_REQUIRED_INVARIANTS.filter((id) => !required.has(id));
        if (missing.length > 0)
            fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, {
                reason: 'missing_mandatory_invariant', artifactKind, missing,
            });
        const unresolved = CHAPTER_CONDITIONAL_INVARIANTS
            .filter((id) => !required.has(id) && !notApplicable.has(id) && !advisory.has(id));
        if (unresolved.length > 0)
            fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, {
                reason: 'unresolved_conditional_invariant', artifactKind, missing: unresolved,
            });
        return;
    }
    const missing = APPROVAL_REQUIRED_INVARIANTS.filter((id) => !required.has(id));
    if (missing.length > 0)
        fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, {
            reason: 'missing_mandatory_invariant', artifactKind, missing,
        });
    // 승인 묶음에는 원고가 없다. 화 원고 전용 검사를 필수로 다는 계획은 통과할 수 없는 가짜다.
    const forbidden = APPROVAL_FORBIDDEN_INVARIANTS.filter((id) => required.has(id));
    if (forbidden.length > 0)
        fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, {
            reason: 'chapter_only_invariant', artifactKind, forbidden,
        });
}

/**
 * 신뢰 검사 계획의 신원. 발급과 소비가 **같은 계획**을 참조했는지 확인하는 데 쓰며
 * 영수증 `checkId` 에 묶인다.
 */
export function computeCheckerPlanHash({ plan, artifactKind = ARTIFACT_KIND_CHAPTER } = {}) {
    const kind = assertArtifactKind(artifactKind);
    const resolved = resolvePlan(plan);
    assertPlanForArtifactKind(resolved, kind);
    return sha256(canonicalJson({
        schemaVersion: VALIDATION_CONTRACT_SCHEMA_VERSION,
        artifactKind: kind,
        checkerPolicyVersion: resolved.meta.checkerPolicyVersion ?? null,
        requiredIds: [...resolved.required].sort(compareCodePoints),
        notApplicableIds: [...resolved.notApplicable].sort(compareCodePoints),
        advisoryIds: [...resolved.advisory].sort(compareCodePoints),
    }));
}

function coverageValueOf(raw, id) {
    let value = raw;
    if (isPlainObject(value))
        value = value.coverage;
    if (typeof value !== 'string')
        fail(VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT, { reason: 'invalid_entry', invariantId: id });
    if (!COVERAGE_VALUES.includes(value))
        fail(VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT, { reason: 'unknown_coverage_value', invariantId: id, received: value });
    return value;
}

function resolveCoverage(coverage) {
    const map = new Map();
    if (Array.isArray(coverage)) {
        for (const entry of coverage) {
            if (!isPlainObject(entry) || typeof entry.id !== 'string')
                fail(VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT, { reason: 'invalid_entry' });
            map.set(entry.id, coverageValueOf(entry, entry.id));
        }
        return map;
    }
    if (!isPlainObject(coverage))
        fail(VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT, {
            reason: 'unknown_report_shape',
            received: coverage === null ? 'null' : typeof coverage,
        });
    // 평가 결과가 저장됐다 돌아온 경우 보고된 값만 다시 읽는다. `complete` 는 신뢰하지 않는다.
    const source = isPlainObject(coverage.coverageById)
        ? coverage.coverageById
        : (isPlainObject(coverage.invariants) ? coverage.invariants : coverage);
    for (const id of Object.keys(source)) {
        // 보고되지 않은 필수는 `null` 로 남는다. 누락은 통과가 아니라 차단이다.
        if (source[id] === null)
            continue;
        map.set(id, coverageValueOf(source[id], id));
    }
    return map;
}

/** 필수 불변식별 차단 사유. 제출된 not_applicable 은 필수를 면제하지 못한다. */
function blockingReason(value) {
    if (value === null)
        return 'missing';
    if (value === 'not_applicable')
        return 'not_applicable_cannot_waive';
    return value;
}

/**
 * 언어 판정과 **분리된** 필수 불변식 검증. 필수 집합은 호출자가 넘긴 신뢰 계획과
 * 산출물 종류에서만 나오며 이 모듈이 계획을 지어내지 않는다. advisory/soft 는 값이
 * 무엇이든 막지 않고, 계획이 표시한 비적용만 정당한 not_applicable 이다.
 *
 * `artifactKind` 의 기본값은 가장 엄격한 `'chapter'` 다 — 종류를 밝히지 않은 호출이
 * 조용히 약한 필수 집합을 얻지 못한다.
 *
 * @param {{ plan: object|Array, coverage: object|Array, artifactKind?: string }} input
 */
export function evaluateInvariantCoverage({ plan, coverage, artifactKind = ARTIFACT_KIND_CHAPTER } = {}) {
    const kind = assertArtifactKind(artifactKind);
    const resolved = resolvePlan(plan);
    assertPlanForArtifactKind(resolved, kind);
    const { required, notApplicable, advisory, meta } = resolved;
    const checkerPlanHash = computeCheckerPlanHash({ plan, artifactKind: kind });

    const reported = resolveCoverage(coverage);
    const requiredIds = [...required].sort(compareCodePoints);
    const coverageById = {};
    const satisfiedIds = [];
    const blocked = [];
    for (const id of requiredIds) {
        const value = reported.has(id) ? reported.get(id) : null;
        coverageById[id] = value;
        if (value === 'validated')
            satisfiedIds.push(id);
        else
            blocked.push(Object.freeze({ id, coverage: value, reason: blockingReason(value) }));
    }

    const notApplicableIds = [...notApplicable].filter((id) => !required.has(id)).sort(compareCodePoints);
    for (const id of notApplicableIds) {
        coverageById[id] = reported.has(id) ? reported.get(id) : null;
    }
    const advisoryIds = [...advisory].filter((id) => !required.has(id) && !notApplicable.has(id)).sort(compareCodePoints);
    const advisoryRows = advisoryIds.map((id) => Object.freeze({
        id,
        coverage: reported.has(id) ? reported.get(id) : null,
    }));
    const unrecognized = [...reported.keys()]
        .filter((id) => !required.has(id) && !notApplicable.has(id) && !advisory.has(id))
        .sort(compareCodePoints);

    return Object.freeze({
        schemaVersion: VALIDATION_CONTRACT_SCHEMA_VERSION,
        artifactKind: kind,
        checkerPolicyVersion: meta.checkerPolicyVersion ?? null,
        checkerPlanHash,
        promptFamily: meta.promptFamily ?? null,
        requiredIds: Object.freeze(requiredIds),
        coverageById: Object.freeze(coverageById),
        satisfiedIds: Object.freeze(satisfiedIds),
        notApplicableIds: Object.freeze(notApplicableIds),
        advisory: Object.freeze(advisoryRows),
        unrecognized: Object.freeze(unrecognized),
        blocked: Object.freeze(blocked),
        complete: blocked.length === 0,
    });
}

export function computeCoverageHash(result) {
    if (!isPlainObject(result)
        || !Array.isArray(result.requiredIds)
        || !isPlainObject(result.coverageById)
        || typeof result.complete !== 'boolean')
        fail(VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT, { reason: 'not_an_evaluated_result' });
    return sha256(canonicalJson({
        schemaVersion: result.schemaVersion ?? VALIDATION_CONTRACT_SCHEMA_VERSION,
        artifactKind: result.artifactKind ?? ARTIFACT_KIND_CHAPTER,
        checkerPolicyVersion: result.checkerPolicyVersion ?? null,
        checkerPlanHash: result.checkerPlanHash ?? null,
        requiredIds: result.requiredIds,
        coverageById: result.coverageById,
        complete: result.complete,
    }));
}

/**
 * 신뢰 계획 없이 저장된 coverage 결과를 받았을 때의 내부 일관성 검사.
 * `{complete:true, requiredIds:[], coverageById:{}}` 같은 자기 신고는 통과가 아니다.
 */
function assertEvaluatedCoverageConsistent(result, artifactKind) {
    if (!isPlainObject(result)
        || !Array.isArray(result.requiredIds)
        || !isPlainObject(result.coverageById)
        || typeof result.complete !== 'boolean')
        fail(VALIDATION_ERROR_CODES.INVALID_COVERAGE_REPORT, { reason: 'not_an_evaluated_result' });
    if ((result.artifactKind ?? ARTIFACT_KIND_CHAPTER) !== artifactKind)
        fail(VALIDATION_ERROR_CODES.ARTIFACT_KIND_MISMATCH, {
            expected: artifactKind, received: result.artifactKind ?? null,
        });
    const required = new Set(result.requiredIds);
    const mandatory = artifactKind === ARTIFACT_KIND_CHAPTER ? CHAPTER_REQUIRED_INVARIANTS : APPROVAL_REQUIRED_INVARIANTS;
    const missing = mandatory.filter((id) => !required.has(id));
    if (missing.length > 0)
        fail(VALIDATION_ERROR_CODES.INVALID_CHECKER_PLAN, {
            reason: 'missing_mandatory_invariant', artifactKind, missing,
        });
    const blocked = [...required]
        .filter((id) => result.coverageById[id] !== 'validated')
        .map((id) => Object.freeze({ id, coverage: result.coverageById[id] ?? null, reason: blockingReason(result.coverageById[id] ?? null) }));
    if (blocked.length > 0 || !result.complete)
        fail(VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE, { blocked });
}

// ─── 검사 영수증 ────────────────────────────────────────────────────────────

const RECEIPT_IDENTITY_FIELDS = Object.freeze([
    'schemaVersion', 'validatorVersion', 'workId', 'chapter', 'workflowId', 'runId',
    'validationEpoch', 'sourceHead', 'planSourceHash', 'artifactKind', 'checkerPlanHash',
    'languageFieldProjectionHash',
    'contractHash', 'artifactHash', 'languageComplianceHash', 'coverageHash',
]);
const RECEIPT_FIELDS = Object.freeze([
    ...RECEIPT_IDENTITY_FIELDS, 'verdict', 'consumed', 'stale', 'staleReason', 'issuedBy', 'checkId',
]);

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function positiveInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function assertReceiptShape(receipt) {
    if (!isPlainObject(receipt))
        fail(VALIDATION_ERROR_CODES.MISSING_VALIDATION_RECEIPT, {
            reason: 'not_an_object',
            received: receipt === null || receipt === undefined ? 'absent' : typeof receipt,
        });
    for (const key of Object.keys(receipt)) {
        if (!RECEIPT_FIELDS.includes(key))
            fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'unknown_field', field: key });
    }
    for (const key of RECEIPT_FIELDS) {
        if (!Object.hasOwn(receipt, key))
            fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'missing_field', field: key });
    }
    if (receipt.schemaVersion !== VALIDATION_CONTRACT_SCHEMA_VERSION)
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'unknown_schema_version', received: receipt.schemaVersion ?? null });
    if (!nonEmptyString(receipt.validatorVersion))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_validator_version' });
    if (!nonEmptyString(receipt.workId))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_work_id' });
    if (receipt.chapter !== null && !positiveInteger(receipt.chapter))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_chapter' });
    if (!nonEmptyString(receipt.workflowId) && !nonEmptyString(receipt.runId))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'missing_workflow_or_run_id' });
    if (!positiveInteger(receipt.validationEpoch))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_validation_epoch' });
    if (!ARTIFACT_KINDS.includes(receipt.artifactKind))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_artifact_kind' });
    // 최초 발행 전에는 원천 HEAD 가 없다. 키는 필수이고 값은 명시적 null 이 정당하다.
    if (receipt.sourceHead !== null && !nonEmptyString(receipt.sourceHead))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_hash_member', field: 'sourceHead' });
    for (const key of ['planSourceHash', 'checkerPlanHash', 'languageFieldProjectionHash', 'contractHash', 'artifactHash', 'languageComplianceHash', 'coverageHash']) {
        if (!nonEmptyString(receipt[key]))
            fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_hash_member', field: key });
    }
    if (typeof receipt.consumed !== 'boolean' || typeof receipt.stale !== 'boolean')
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_lifecycle_flag' });
    if (!nonEmptyString(receipt.checkId))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_check_id' });
}

/** 신원 + 계획·계약·산출물·판정·coverage hash 로 계산한다. 소비/stale/발급처는 신원이 아니다. */
export function computeReceiptCheckId(receipt) {
    if (!isPlainObject(receipt))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'not_an_object' });
    const identity = {};
    for (const key of RECEIPT_IDENTITY_FIELDS) {
        identity[key] = receipt[key] ?? null;
    }
    return sha256(canonicalJson(identity));
}

/**
 * 통과 영수증 발급.
 *
 * 호출자가 넘긴 `languageCompliance` / `coverage` 의 `verdict:'pass'` 나
 * `complete:true` 를 **믿지 않는다**. 실제 산출물·작업 계약·승인된 예외와 신뢰
 * `checkerPlan` 으로 다시 계산한 결과에만 근거해 발급하며, 영수증에 박히는 hash 도
 * 재계산된 결과의 것이다.
 */
export function buildValidationReceipt(input = {}) {
    if (!isPlainObject(input))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'not_an_object' });
    const {
        workId,
        chapter = null,
        workflowId = null,
        runId = null,
        validationEpoch,
        planSourceHash,
        workContract,
        artifact,
        checkerPlan,
        languageCompliance,
        coverage,
        targetLanguage = null,
        allowedLanguageExceptions = null,
        languageFields = null,
        validatorVersion = VALIDATOR_VERSION,
        issuedBy = null,
    } = input;

    // 키 자체가 없으면 "최초 발행 전" 과 "호출자가 잊음" 을 구분할 수 없다.
    if (!Object.hasOwn(input, 'sourceHead') || input.sourceHead === undefined)
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { missing: ['sourceHead'] });
    const sourceHead = input.sourceHead;

    if (!isPlainObject(workContract) || !nonEmptyString(workContract.language))
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'invalid_work_contract' });
    if (checkerPlan === null || checkerPlan === undefined)
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { missing: ['checkerPlan'] });

    const canonical = canonicalizeByKind(artifact);
    const artifactKind = Object.hasOwn(input, 'artifactKind') ? assertArtifactKind(input.artifactKind) : canonical.artifactKind;
    if (artifactKind !== canonical.artifactKind)
        fail(VALIDATION_ERROR_CODES.ARTIFACT_KIND_MISMATCH, { expected: artifactKind, received: canonical.artifactKind });
    const contractHash = computeLanguageContractHash(workContract);
    const artifactHash = sha256(canonicalJson(canonical));

    // 저장된 평가 결과든 원시 응답이든 실제 묶음·계약으로 **다시** 판정한다.
    const evaluatedLanguage = evaluateLanguageCompliance({
        compliance: complianceInputFrom(languageCompliance),
        artifact: canonical,
        workContract,
        targetLanguage,
        allowedLanguageExceptions,
        languageFields,
    });
    if (evaluatedLanguage.artifactHash !== artifactHash)
        fail(VALIDATION_ERROR_CODES.ARTIFACT_HASH_MISMATCH, { expected: artifactHash, received: evaluatedLanguage.artifactHash });
    if (evaluatedLanguage.verdict === 'fail')
        fail(VALIDATION_ERROR_CODES.OUTPUT_LANGUAGE_MISMATCH, { evidence: evaluatedLanguage.evidence });
    if (evaluatedLanguage.verdict === 'uncertain')
        fail(VALIDATION_ERROR_CODES.VALIDATION_INCOMPLETE, { reason: 'language_verdict_uncertain' });

    // coverage 도 신뢰 계획으로 다시 평가한다. 보고가 신고한 requiredIds 는 필수를 낮추지 못한다.
    const evaluatedCoverage = evaluateInvariantCoverage({ plan: checkerPlan, coverage, artifactKind });
    if (!evaluatedCoverage.complete)
        fail(VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE, { blocked: evaluatedCoverage.blocked });

    const receipt = {
        schemaVersion: VALIDATION_CONTRACT_SCHEMA_VERSION,
        validatorVersion,
        verdict: RECEIPT_VERDICT_PASSED,
        workId,
        chapter,
        workflowId: nonEmptyString(workflowId) ? workflowId : null,
        runId: nonEmptyString(runId) ? runId : null,
        validationEpoch,
        sourceHead,
        planSourceHash,
        artifactKind,
        checkerPlanHash: evaluatedCoverage.checkerPlanHash,
        languageFieldProjectionHash: computeLanguageFieldProjectionHash(languageFields),
        contractHash,
        artifactHash,
        languageComplianceHash: computeLanguageComplianceHash(evaluatedLanguage),
        coverageHash: computeCoverageHash(evaluatedCoverage),
        consumed: false,
        stale: false,
        staleReason: null,
        issuedBy,
        checkId: '',
    };
    receipt.checkId = computeReceiptCheckId(receipt);
    assertReceiptShape(receipt);
    return Object.freeze(receipt);
}

/**
 * stale 표시는 순수 변환이며 되돌릴 수 없다. 태그·HEAD 가 원래 값으로 복구돼도 같은
 * 영수증은 부활하지 않으며, 명시적인 새 epoch 의 새 영수증이 필요하다.
 */
export function markReceiptStale(receipt, reason = 'contract_drift') {
    assertReceiptShape(receipt);
    return Object.freeze({ ...receipt, stale: true, staleReason: nonEmptyString(reason) ? reason : 'contract_drift' });
}

export function markReceiptConsumed(receipt) {
    assertReceiptShape(receipt);
    return Object.freeze({ ...receipt, consumed: true });
}

const EXPECTED_REQUIRED_KEYS = Object.freeze([
    'workId', 'chapter', 'validationEpoch', 'sourceHead', 'planSourceHash', 'artifactKind',
]);

function proofPresent(value) {
    return value !== null && value !== undefined;
}

function assertExpectation(expected, { artifact, workContract, languageCompliance, coverage }) {
    if (!isPlainObject(expected))
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { reason: 'not_an_object' });
    const missing = EXPECTED_REQUIRED_KEYS.filter((key) => !Object.hasOwn(expected, key) || expected[key] === undefined);
    if (!Object.hasOwn(expected, 'workflowId') && !Object.hasOwn(expected, 'runId'))
        missing.push('workflowId|runId');
    // 계획 hash 만으로는 조건부 POV/ADDRESSING/SENSITIVE 를 재구성할 수 없다.
    if (!Object.hasOwn(expected, 'checkerPlan') || expected.checkerPlan === null || expected.checkerPlan === undefined)
        missing.push('checkerPlan');
    if (!proofPresent(artifact))
        missing.push('artifact');
    if (!proofPresent(workContract))
        missing.push('workContract');
    if (!proofPresent(languageCompliance))
        missing.push('languageCompliance');
    if (!proofPresent(coverage))
        missing.push('coverage');
    if (missing.length > 0)
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { missing });
    assertArtifactKind(expected.artifactKind);
    if (!positiveInteger(expected.validationEpoch))
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { reason: 'invalid_validation_epoch' });
    if (Object.hasOwn(expected, 'minValidationEpoch') && !positiveInteger(expected.minValidationEpoch))
        fail(VALIDATION_ERROR_CODES.INCOMPLETE_EXPECTATION, { reason: 'invalid_min_validation_epoch' });
}

function assertIdentity(receipt, expected, field) {
    if (receipt[field] !== expected[field])
        fail(VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH, {
            field,
            expected: expected[field] ?? null,
            received: receipt[field] ?? null,
        });
}

/**
 * 소비 측 투영. 생략은 기본 투영이다. 명시 인자와 `expected.languageFields` 가
 * 둘 다 있으면 같은 정본이어야 하며, 발급 때와 다른 투영으로 재평가하지 않는다.
 */
function resolveConsumptionLanguageFields(expected, languageFields) {
    const hasExpected = Object.hasOwn(expected, 'languageFields');
    const hasCaller = languageFields !== null && languageFields !== undefined;
    const fromExpected = hasExpected ? canonicalizeLanguageFieldProjection(expected.languageFields) : null;
    const fromCaller = hasCaller ? canonicalizeLanguageFieldProjection(languageFields) : null;
    if (fromExpected !== null && fromCaller !== null
        && canonicalJson(fromExpected) !== canonicalJson(fromCaller)) {
        fail(VALIDATION_ERROR_CODES.INVALID_LANGUAGE_COMPLIANCE, {
            reason: 'language_field_projection_conflict',
        });
    }
    const projection = fromCaller ?? fromExpected ?? DEFAULT_LANGUAGE_FIELD_PROJECTION;
    const hash = computeLanguageFieldProjectionHash(projection);
    if (Object.hasOwn(expected, 'languageFieldProjectionHash') && expected.languageFieldProjectionHash !== hash) {
        fail(VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH, {
            field: 'languageFieldProjectionHash',
            expected: expected.languageFieldProjectionHash,
            received: hash,
        });
    }
    return { projection, hash };
}

/**
 * 소비처(commit / workflow 승인 / sync apply)가 쓰는 단일 게이트.
 *
 * 검사 순서가 계약의 일부다: 존재 → 기대값 완전성 → 모양 → checkId 재계산 →
 * verdict → consumed → stale → validator 버전 → epoch → 신원 → 검사 계획 →
 * 계약/산출물 hash → 언어·coverage 재평가와 hash. stale/consumed 를 신원 비교보다
 * 먼저 보므로 값이 원상 복구돼도 죽은 영수증이 살아나지 않는다.
 *
 * 공급된 `languageCompliance` / `coverage` 는 신뢰 권한이 아니다. 소비는 실제 묶음·
 * 작업 계약·언어 판정·coverage 와 신뢰 검사 계획 전체가 있어야 하며, 그 입력으로
 * **다시 평가**한 결과에만 근거한다. 계획 hash 만으로는 조건부 필수를 재구성할 수
 * 없고, 수동으로 맞춘 신원 hash 와 `checkId` 도 보고서 없이 통과가 아니다.
 * 언어 필드 투영은 발급 때와 같아야 하며, 생략은 기본 투영이다. 다른 투영으로 재평가하지 않는다.
 */
export function validateValidationReceipt({
    receipt,
    expected,
    artifact = null,
    workContract = null,
    languageCompliance = null,
    coverage = null,
    languageFields = null,
} = {}) {
    if (receipt === null || receipt === undefined)
        fail(VALIDATION_ERROR_CODES.MISSING_VALIDATION_RECEIPT, { reason: 'absent' });
    assertExpectation(expected, { artifact, workContract, languageCompliance, coverage });
    assertReceiptShape(receipt);

    if (computeReceiptCheckId(receipt) !== receipt.checkId)
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, { reason: 'check_id_mismatch' });
    if (receipt.verdict !== RECEIPT_VERDICT_PASSED)
        fail(VALIDATION_ERROR_CODES.INVALID_RECEIPT, {
            reason: 'verdict_not_passed',
            received: typeof receipt.verdict === 'string' ? receipt.verdict : null,
        });
    if (receipt.consumed)
        fail(VALIDATION_ERROR_CODES.RECEIPT_ALREADY_CONSUMED, { checkId: receipt.checkId });
    if (receipt.stale)
        fail(VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT, {
            reason: 'receipt_marked_stale',
            staleReason: receipt.staleReason ?? null,
            checkId: receipt.checkId,
        });

    const expectedValidator = Object.hasOwn(expected, 'validatorVersion') ? expected.validatorVersion : VALIDATOR_VERSION;
    if (receipt.validatorVersion !== expectedValidator)
        fail(VALIDATION_ERROR_CODES.VALIDATOR_VERSION_MISMATCH, {
            expected: expectedValidator, received: receipt.validatorVersion,
        });

    if (receipt.validationEpoch < expected.validationEpoch)
        fail(VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT, {
            reason: 'epoch_superseded', expected: expected.validationEpoch, received: receipt.validationEpoch,
        });
    if (receipt.validationEpoch !== expected.validationEpoch)
        fail(VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH, {
            field: 'validationEpoch', expected: expected.validationEpoch, received: receipt.validationEpoch,
        });
    if (Object.hasOwn(expected, 'minValidationEpoch') && receipt.validationEpoch < expected.minValidationEpoch)
        fail(VALIDATION_ERROR_CODES.STALE_VALIDATION_RECEIPT, {
            reason: 'epoch_below_minimum', expected: expected.minValidationEpoch, received: receipt.validationEpoch,
        });

    assertIdentity(receipt, expected, 'workId');
    assertIdentity(receipt, expected, 'chapter');
    assertIdentity(receipt, expected, 'sourceHead');
    assertIdentity(receipt, expected, 'planSourceHash');
    assertIdentity(receipt, expected, 'artifactKind');
    if (Object.hasOwn(expected, 'workflowId'))
        assertIdentity(receipt, expected, 'workflowId');
    if (Object.hasOwn(expected, 'runId'))
        assertIdentity(receipt, expected, 'runId');

    const expectedPlanHash = computeCheckerPlanHash({
        plan: expected.checkerPlan, artifactKind: expected.artifactKind,
    });
    // 기대에 계획이 있으면 그 hash 가 정본이다. 별도 checkerPlanHash 가 계획을 덮어
    // 다른 조건부 집합을 통과시키지 못한다.
    if (Object.hasOwn(expected, 'checkerPlanHash') && expected.checkerPlanHash !== expectedPlanHash)
        fail(VALIDATION_ERROR_CODES.CHECKER_PLAN_MISMATCH, {
            expected: expectedPlanHash, received: expected.checkerPlanHash,
        });
    if (expectedPlanHash !== receipt.checkerPlanHash)
        fail(VALIDATION_ERROR_CODES.CHECKER_PLAN_MISMATCH, {
            expected: expectedPlanHash, received: receipt.checkerPlanHash,
        });

    const consumptionProjection = resolveConsumptionLanguageFields(expected, languageFields);
    if (consumptionProjection.hash !== receipt.languageFieldProjectionHash)
        fail(VALIDATION_ERROR_CODES.RECEIPT_IDENTITY_MISMATCH, {
            field: 'languageFieldProjectionHash',
            expected: consumptionProjection.hash,
            received: receipt.languageFieldProjectionHash,
        });

    const contractHash = computeLanguageContractHash(workContract);
    if (contractHash !== receipt.contractHash)
        fail(VALIDATION_ERROR_CODES.CONTRACT_HASH_MISMATCH, { expected: contractHash, received: receipt.contractHash });
    if (Object.hasOwn(expected, 'contractHash') && expected.contractHash !== receipt.contractHash)
        fail(VALIDATION_ERROR_CODES.CONTRACT_HASH_MISMATCH, { expected: expected.contractHash, received: receipt.contractHash });

    const canonical = canonicalizeByKind(artifact);
    if (canonical.artifactKind !== receipt.artifactKind)
        fail(VALIDATION_ERROR_CODES.ARTIFACT_KIND_MISMATCH, {
            expected: receipt.artifactKind, received: canonical.artifactKind,
        });
    const artifactHash = sha256(canonicalJson(canonical));
    if (artifactHash !== receipt.artifactHash)
        fail(VALIDATION_ERROR_CODES.ARTIFACT_HASH_MISMATCH, { expected: artifactHash, received: receipt.artifactHash });
    if (Object.hasOwn(expected, 'artifactHash') && expected.artifactHash !== receipt.artifactHash)
        fail(VALIDATION_ERROR_CODES.ARTIFACT_HASH_MISMATCH, { expected: expected.artifactHash, received: receipt.artifactHash });

    const evaluatedLanguage = evaluateLanguageCompliance({
        compliance: complianceInputFrom(languageCompliance),
        artifact: canonical,
        workContract,
        languageFields: consumptionProjection.projection,
    });
    assertEvaluatedComplianceConsistent(evaluatedLanguage, {
        artifactKind: receipt.artifactKind,
        artifactHash: receipt.artifactHash,
        targetLanguage: normalizeLanguageTag(workContract.language).tag,
    });
    const languageHash = computeLanguageComplianceHash(evaluatedLanguage);
    if (languageHash !== receipt.languageComplianceHash)
        fail(VALIDATION_ERROR_CODES.LANGUAGE_COMPLIANCE_HASH_MISMATCH, {
            expected: languageHash, received: receipt.languageComplianceHash,
        });
    if (Object.hasOwn(expected, 'languageComplianceHash') && expected.languageComplianceHash !== receipt.languageComplianceHash)
        fail(VALIDATION_ERROR_CODES.LANGUAGE_COMPLIANCE_HASH_MISMATCH, {
            expected: expected.languageComplianceHash, received: receipt.languageComplianceHash,
        });

    const evaluatedCoverage = evaluateInvariantCoverage({
        plan: expected.checkerPlan, coverage, artifactKind: receipt.artifactKind,
    });
    if (!evaluatedCoverage.complete)
        fail(VALIDATION_ERROR_CODES.COVERAGE_INCOMPLETE, { blocked: evaluatedCoverage.blocked });
    if (evaluatedCoverage.checkerPlanHash !== receipt.checkerPlanHash)
        fail(VALIDATION_ERROR_CODES.CHECKER_PLAN_MISMATCH, {
            expected: receipt.checkerPlanHash, received: evaluatedCoverage.checkerPlanHash ?? null,
        });
    const coverageHash = computeCoverageHash(evaluatedCoverage);
    if (coverageHash !== receipt.coverageHash)
        fail(VALIDATION_ERROR_CODES.COVERAGE_HASH_MISMATCH, {
            expected: coverageHash, received: receipt.coverageHash,
        });
    if (Object.hasOwn(expected, 'coverageHash') && expected.coverageHash !== receipt.coverageHash)
        fail(VALIDATION_ERROR_CODES.COVERAGE_HASH_MISMATCH, { expected: expected.coverageHash, received: receipt.coverageHash });

    return Object.freeze({
        ok: true,
        checkId: receipt.checkId,
        workId: receipt.workId,
        chapter: receipt.chapter,
        workflowId: receipt.workflowId,
        runId: receipt.runId,
        validationEpoch: receipt.validationEpoch,
        sourceHead: receipt.sourceHead,
        planSourceHash: receipt.planSourceHash,
        artifactKind: receipt.artifactKind,
        checkerPlanHash: receipt.checkerPlanHash,
        languageFieldProjectionHash: receipt.languageFieldProjectionHash,
        contractHash: receipt.contractHash,
        artifactHash: receipt.artifactHash,
        languageComplianceHash: receipt.languageComplianceHash,
        coverageHash: receipt.coverageHash,
        validatorVersion: receipt.validatorVersion,
    });
}

// ─── 승인 결합 ──────────────────────────────────────────────────────────────

const APPROVAL_BINDING_FIELDS = Object.freeze(['checkId', 'validationEpoch', 'artifactHash']);

/** 승인 descriptor 조립. 문체 승인이 언어 검증을 대신하지 못하도록 같은 검사에 묶는다. */
export function buildApprovalBinding(receipt, { approvedBy = null, decision = 'approve' } = {}) {
    assertReceiptShape(receipt);
    return Object.freeze({
        checkId: receipt.checkId,
        validationEpoch: receipt.validationEpoch,
        artifactKind: receipt.artifactKind,
        artifactHash: receipt.artifactHash,
        contractHash: receipt.contractHash,
        approvedBy,
        decision,
    });
}

export function validateApprovalBinding({ approval, receipt } = {}) {
    assertReceiptShape(receipt);
    if (!isPlainObject(approval))
        fail(VALIDATION_ERROR_CODES.INVALID_APPROVAL_BINDING, {
            reason: 'missing_approval',
            received: approval === null || approval === undefined ? 'absent' : typeof approval,
        });
    for (const field of APPROVAL_BINDING_FIELDS) {
        if (!Object.hasOwn(approval, field))
            fail(VALIDATION_ERROR_CODES.INVALID_APPROVAL_BINDING, { reason: 'missing_binding_member', field });
        if (approval[field] !== receipt[field])
            fail(VALIDATION_ERROR_CODES.INVALID_APPROVAL_BINDING, {
                reason: 'binding_mismatch', field, expected: receipt[field], received: approval[field] ?? null,
            });
    }
    for (const field of ['artifactKind', 'contractHash']) {
        if (Object.hasOwn(approval, field) && approval[field] !== receipt[field])
            fail(VALIDATION_ERROR_CODES.INVALID_APPROVAL_BINDING, {
                reason: 'binding_mismatch', field, expected: receipt[field], received: approval[field] ?? null,
            });
    }
    return Object.freeze({
        ok: true,
        checkId: receipt.checkId,
        validationEpoch: receipt.validationEpoch,
        artifactKind: receipt.artifactKind,
        artifactHash: receipt.artifactHash,
        contractHash: receipt.contractHash,
    });
}

/** Validate the concrete manifest consumed by extractDelta before its legacy
 * permissive parser can erase malformed metadata. Empty raw text explicitly
 * denotes no manifest. The character identity check uses the trusted foundation. */
export function validatePublicationManifest(raw, { foundation } = {}) {
    if (raw === '') return Object.freeze({ valid: true });
    const invalid = (reason) => Object.freeze({ valid: false, code: 'INVALID_CAST_MANIFEST', reason });
    if (typeof raw !== 'string' || !raw.trim()) return invalid('expected_raw_json_or_explicit_empty');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return invalid('invalid_json'); }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.cast)) return invalid('invalid_cast_shape');
    if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) return invalid('unsupported_schema_version');
    const known = new Set((foundation?.characters ?? []).map(character => character.id));
    const seen = new Set();
    for (const entry of parsed.cast) {
        if (!isPlainObject(entry) || typeof entry.characterId !== 'string' || !entry.characterId.trim()
            || !known.has(entry.characterId) || seen.has(entry.characterId)) return invalid('unregistered_or_invalid_character');
        seen.add(entry.characterId);
        for (const field of ['name', 'role']) if (entry[field] !== undefined && typeof entry[field] !== 'string') return invalid('invalid_entry_field');
        if (entry.addressTermsUsed !== undefined && (!Array.isArray(entry.addressTermsUsed)
            || entry.addressTermsUsed.some(term => typeof term !== 'string'))) return invalid('invalid_address_terms');
    }
    return Object.freeze({ valid: true });
}
