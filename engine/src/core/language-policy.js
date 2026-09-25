/**
 * language-policy — 작품 언어 계약의 단일 결정 지점 (다국어 Phase 1).
 *
 * 여기서 정하는 것: BCP 47 태그 정규화(지역/문자/확장 보존), 문법과 언어 식별의
 * 분리, ko / multilingual 프롬프트 계열, 생성·기본·구작 언어 해석, 분량 단위와
 * 목표, 측정 정책 서술, 정본 형식 버전, 승인된 인용 예외, workContract 가 참조할
 * 결정적 hash, 검증된 값만으로 조립한 system 지시문.
 *
 * 여기서 정하지 않는 것: 실제 길이 측정(세기), 연속성 스캔, 검사기 판정.
 * 길이 측정 구현은 2B(Grok) 소유이며 이 모듈은 `LENGTH_MEASUREMENT_CONTRACT` 와
 * `validateLengthMeasurementResult()` 로 인터페이스와 결과 계약만 제공한다.
 *
 * Phase 3 의존(여기서 강제하지 않음):
 * - `normalizeLanguageExceptions()` 는 **구문 검증만** 한다. 종류별 scope 의 실제
 *   유효성(인물 ID 존재, 인용 출처 확인)과 승인 revision 결합은 phase 3 의
 *   프로필/영수증 경로가 검증해야 한다. 그 전까지 본문 전체가 예외처럼 쓰이지
 *   않도록 명백한 본문/요약/설명 전역 scope 는 지금 구문 단계에서 거부한다.
 * - `formatPolicy` binds an explicitly supplied approved dialogue mode.
 *   Accepted-work callers resolve defaults; a plain constructor does not approve them.
 *
 * 실패는 전부 `LanguagePolicyError` 이며 안정적인 `.code` 를 갖는다. 사용자 자유
 * 텍스트는 어떤 경로로도 system 지시문에 삽입되지 않는다.
 */
import { createHash } from 'node:crypto';

export const LANGUAGE_POLICY_SCHEMA_VERSION = 1;
export const LANGUAGE_DIRECTIVE_VERSION = 1;
export const MEASUREMENT_POLICY_VERSION = 1;
export const FORMAT_POLICY_VERSION = 1;
/** 검사 등록표 버전의 기본값. 2B 가 검사 정책을 바꾸면 bump 한다. */
export const CHECKER_POLICY_VERSION = 1;

export const PROMPT_FAMILY_KO = 'ko';
export const PROMPT_FAMILY_MULTILINGUAL = 'multilingual';
export const PROMPT_FAMILIES = Object.freeze([PROMPT_FAMILY_KO, PROMPT_FAMILY_MULTILINGUAL]);

/** `legacyCodeUnits` 는 현재 JS `String.length` 와 동일하다. */
export const LENGTH_UNITS = Object.freeze(['legacyCodeUnits', 'graphemes', 'words']);
export const DEFAULT_LENGTH_TARGET = 3000;

/** 이름과 무관하게 전부 `legacyCodeUnits` 로만 해석하는 구형 인자들. */
export const LEGACY_LENGTH_FIELDS = Object.freeze(['chapterChars', 'chapterWordCount', 'targetChars']);

/** 언어 키가 없던 작품/프로필의 실행 해석. "미설정" 이 아니라 이미 선택된 암묵적 ko. */
export const IMPLICIT_LEGACY_LANGUAGE = 'ko';

/**
 * grapheme 측정은 언어 사전을 쓰지 않는 Unicode 문자군 계산이므로 목표 언어가
 * 아니라 **하나의 공통 측정 locale** 로 고정해 기록한다. 목표 언어는 정책의
 * `language` 필드에 따로 남긴다.
 */
export const GRAPHEME_MEASUREMENT_LOCALE = 'en';

export const CANONICAL_FORMAT_VERSION_LEGACY_KO = 1;
export const CANONICAL_FORMAT_VERSION_MULTILINGUAL = 2;

export const LANGUAGE_EXCEPTION_KINDS = Object.freeze(['properNoun', 'sourceQuote', 'characterDialogue']);

export const LANGUAGE_ERROR_CODES = Object.freeze({
    INVALID_LANGUAGE_TAG: 'INVALID_LANGUAGE_TAG',
    UNKNOWN_LANGUAGE: 'UNKNOWN_LANGUAGE',
    LANGUAGE_SELECTION_REQUIRED: 'LANGUAGE_SELECTION_REQUIRED',
    LANGUAGE_CONTRACT_CONFLICT: 'LANGUAGE_CONTRACT_CONFLICT',
    WORK_LANGUAGE_IMMUTABLE: 'WORK_LANGUAGE_IMMUTABLE',
    INVALID_LENGTH_CONTRACT: 'INVALID_LENGTH_CONTRACT',
    LENGTH_CONTRACT_CONFLICT: 'LENGTH_CONTRACT_CONFLICT',
    UNSUPPORTED_LENGTH_MEASUREMENT: 'UNSUPPORTED_LENGTH_MEASUREMENT',
    INVALID_LENGTH_MEASUREMENT: 'INVALID_LENGTH_MEASUREMENT',
    INVALID_FORMAT_VERSION: 'INVALID_FORMAT_VERSION',
    INVALID_TEMPLATE_VERSION: 'INVALID_TEMPLATE_VERSION',
    INVALID_LANGUAGE_EXCEPTION: 'INVALID_LANGUAGE_EXCEPTION',
    INVALID_DIALOGUE_BREAK_MODE: 'INVALID_DIALOGUE_BREAK_MODE',
    FORMAT_POLICY_CONFLICT: 'FORMAT_POLICY_CONFLICT',
});

/** 승인된 대사 문단 규칙. `strict`/`relaxed` 는 기존 검사기 의미, `natural` 은 산문 관습. */
export const DIALOGUE_BREAK_MODES = Object.freeze(['strict', 'relaxed', 'natural']);
export const DEFAULT_DIALOGUE_BREAK_MODE_KO = 'strict';
export const DEFAULT_DIALOGUE_BREAK_MODE_MULTILINGUAL = 'natural';

/**
 * 정적 사용자 안내 문구. 계획의 "정적인 시스템 메시지는 한국어/영어 두 계열과
 * 안정적인 오류 코드를 제공한다" 를 만족하는 최소 사전이며, 구체적인 값은
 * `err.details` 로만 전달한다(문구에 사용자 입력을 끼워 넣지 않는다).
 */
const LANGUAGE_ERROR_MESSAGES = Object.freeze({
    INVALID_LANGUAGE_TAG: {
        ko: '언어 태그가 올바른 BCP 47 형식이 아니다.',
        en: 'The language tag is not a well-formed BCP 47 tag.',
    },
    UNKNOWN_LANGUAGE: {
        ko: '형식은 유효하지만 언어를 식별할 수 없다. 언어명이나 태그를 명확히 해 달라.',
        en: 'The tag is well-formed but the language could not be identified. Please clarify the language name or tag.',
    },
    LANGUAGE_SELECTION_REQUIRED: {
        ko: '서로 다른 언어가 둘 이상 지정됐다. 하나를 선택해 달라.',
        en: 'More than one conflicting language was specified. Please choose one.',
    },
    LANGUAGE_CONTRACT_CONFLICT: {
        ko: '요청한 언어가 저장된 프로필 언어와 다르다. 프로필 언어 변경은 새 프로필 revision 으로만 가능하다.',
        en: 'The requested language differs from the stored profile language. Changing it requires a new approved profile revision.',
    },
    WORK_LANGUAGE_IMMUTABLE: {
        ko: '이미 생성된 작품의 언어는 바꿀 수 없다. 새 작품으로 만들어 달라.',
        en: 'The language of an existing work cannot be changed. Create a new work instead.',
    },
    INVALID_LENGTH_CONTRACT: {
        ko: '분량 계약이 올바르지 않다. 단위와 유한한 양의 정수 목표가 필요하다.',
        en: 'The length contract is invalid. A known unit and a finite positive integer target are required.',
    },
    LENGTH_CONTRACT_CONFLICT: {
        ko: '분량 지정이 서로 충돌한다. 단위와 목표가 모두 같아야 한다.',
        en: 'The specified length values conflict. Unit and target must both match.',
    },
    UNSUPPORTED_LENGTH_MEASUREMENT: {
        ko: '이 언어에서는 요청한 분량 단위를 측정할 수 없다. graphemes 단위를 사용할 수 있다.',
        en: 'The requested length unit cannot be measured for this language. The graphemes unit is available.',
    },
    INVALID_LENGTH_MEASUREMENT: {
        ko: '분량 측정 결과가 측정 계약과 일치하지 않는다.',
        en: 'The length measurement result does not match the measurement contract.',
    },
    INVALID_FORMAT_VERSION: {
        ko: '정본 형식 버전 값이 올바르지 않다.',
        en: 'The canonical format version value is invalid.',
    },
    INVALID_TEMPLATE_VERSION: {
        ko: '프롬프트 템플릿 버전 값이 올바르지 않다.',
        en: 'The prompt template version value is invalid.',
    },
    INVALID_LANGUAGE_EXCEPTION: {
        ko: '승인된 인용 예외가 올바르지 않다. 종류·언어·적용 범위가 필요하며 wildcard 는 받지 않는다.',
        en: 'The approved language exception is invalid. Kind, language and a bounded scope are required; wildcards are rejected.',
    },
    INVALID_DIALOGUE_BREAK_MODE: {
        ko: '대사 문단 규칙 값이 올바르지 않다. strict, relaxed, natural 만 허용한다.',
        en: 'The dialogue break mode is invalid. Only strict, relaxed, and natural are allowed.',
    },
    FORMAT_POLICY_CONFLICT: {
        ko: '명시된 포맷 규칙이 저장된 계약과 다르다.',
        en: 'The explicit format policy conflicts with the stored contract.',
    },
});

/** 결정적 오류. `.code` 는 안정적인 계약이며 호스트가 그대로 노출할 수 있다. */
export class LanguagePolicyError extends Error {
    constructor(code, details = {}) {
        const messages = LANGUAGE_ERROR_MESSAGES[code] ?? { ko: code, en: code };
        super(messages.en);
        this.name = 'LanguagePolicyError';
        this.code = code;
        this.details = Object.freeze({ ...details });
        this.messages = Object.freeze({ ...messages });
    }
}

function fail(code, details) {
    throw new LanguagePolicyError(code, details);
}

/** 제어문자 검사. 소스에 원시 제어문자를 넣지 않기 위해 코드 포인트로 판정한다. */
function hasControlCharacters(text) {
    for (const ch of text) {
        const code = ch.codePointAt(0);
        if (code < 0x20 || code === 0x7f)
            return true;
    }
    return false;
}

/** 결정적 정렬용 코드 포인트 비교. 주변 locale 에 의존하는 localeCompare 를 쓰지 않는다. */
function compareCodePoints(a, b) {
    if (a === b)
        return 0;
    return a < b ? -1 : 1;
}

// ─── 태그 정규화와 언어 식별 ────────────────────────────────────────────────

const MAX_TAG_LENGTH = 64;

let cachedDisplayNames = null;
let cachedDisplayNamesCtor = null;

/** 식별기 자체가 없으면 null. "식별 불가" 를 "알려진 언어" 로 위조하지 않는다. */
function languageDisplayNames() {
    if (typeof Intl === 'undefined' || typeof Intl.DisplayNames !== 'function') {
        cachedDisplayNames = null;
        cachedDisplayNamesCtor = null;
        return null;
    }
    if (cachedDisplayNames !== null && cachedDisplayNamesCtor === Intl.DisplayNames)
        return cachedDisplayNames;
    try {
        cachedDisplayNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
        cachedDisplayNamesCtor = Intl.DisplayNames;
    }
    catch {
        cachedDisplayNames = null;
        cachedDisplayNamesCtor = null;
    }
    return cachedDisplayNames;
}

/**
 * 런타임이 이 base language 를 언어로 식별하는가. 문법 수용과는 별개다 —
 * `kr` 는 Kanuri 이므로 유효한 알려진 언어다.
 * @returns {'known'|'unknown'|'unavailable'}
 */
function identificationStatus(baseLanguage) {
    const dn = languageDisplayNames();
    if (!dn)
        return 'unavailable';
    try {
        return dn.of(baseLanguage) === undefined ? 'unknown' : 'known';
    }
    catch {
        return 'unknown';
    }
}

/**
 * 입력을 정규화된 `LanguageTag` 로 바꾼다. 지역·문자 체계·Intl 이 수용하는
 * 확장(-u-/-t-)은 정규화된 형태로 **보존**하고, 계열 라우팅은 base language 로만
 * 한다. private-use 전용 태그처럼 언어를 식별할 수 없는 입력은 오류다.
 *
 * @param {unknown} input
 * @param {{ requireKnown?: boolean }} [options] `requireKnown:false` 는 진단용.
 * @returns {{ tag: string, baseLanguage: string, script: string|null, region: string|null,
 *             known: boolean, identification: 'known'|'unknown'|'unavailable', promptFamily: string }}
 */
export function normalizeLanguageTag(input, options = {}) {
    const { requireKnown = true } = options;
    if (input !== null && typeof input === 'object' && typeof input.tag === 'string') {
        // 이미 정규화된 LanguageTag 를 다시 넣어도 같은 결과가 나오게 한다.
        return normalizeLanguageTag(input.tag, options);
    }
    if (typeof input !== 'string')
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, { reason: 'not_a_string', received: typeof input });
    const raw = input.trim();
    if (raw === '')
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, { reason: 'empty' });
    if (raw.length > MAX_TAG_LENGTH)
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, { reason: 'too_long', length: raw.length });
    if (hasControlCharacters(raw))
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, { reason: 'control_characters' });

    let canonical;
    try {
        [canonical] = Intl.getCanonicalLocales(raw);
    }
    catch {
        // private-use 전용(`x-...`) 등 unicode locale id 가 아닌 입력이 여기로 온다.
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, { reason: 'malformed', received: raw });
    }
    if (!canonical)
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, { reason: 'malformed', received: raw });

    let locale;
    try {
        locale = new Intl.Locale(canonical);
    }
    catch {
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, { reason: 'malformed', received: raw });
    }
    const baseLanguage = locale.language;
    const identification = identificationStatus(baseLanguage);
    if (requireKnown && identification !== 'known')
        fail(LANGUAGE_ERROR_CODES.UNKNOWN_LANGUAGE, {
            received: canonical,
            baseLanguage,
            reason: identification === 'unavailable' ? 'identification_unavailable' : 'not_identifiable',
        });

    return Object.freeze({
        tag: canonical,
        baseLanguage,
        script: locale.script ?? null,
        region: locale.region ?? null,
        known: identification === 'known',
        identification,
        promptFamily: baseLanguage === PROMPT_FAMILY_KO ? PROMPT_FAMILY_KO : PROMPT_FAMILY_MULTILINGUAL,
    });
}

/**
 * 던지지 않는 검사. 문법 유효성(`valid`)과 언어 식별(`known`)을 분리해 보고한다.
 * 검사기·호스트 안내가 소비한다.
 */
export function inspectLanguageTag(input) {
    let tag = null;
    try {
        tag = normalizeLanguageTag(input, { requireKnown: false });
    }
    catch (err) {
        if (!(err instanceof LanguagePolicyError))
            throw err;
        return Object.freeze({
            valid: false,
            known: false,
            identification: 'unknown',
            tag: null,
            error: Object.freeze({ code: err.code, message: err.message, details: err.details }),
        });
    }
    if (!tag.known) {
        const err = new LanguagePolicyError(LANGUAGE_ERROR_CODES.UNKNOWN_LANGUAGE, {
            received: tag.tag,
            baseLanguage: tag.baseLanguage,
            reason: tag.identification === 'unavailable' ? 'identification_unavailable' : 'not_identifiable',
        });
        return Object.freeze({
            valid: true,
            known: false,
            identification: tag.identification,
            tag,
            error: Object.freeze({ code: err.code, message: err.message, details: err.details }),
        });
    }
    return Object.freeze({ valid: true, known: true, identification: 'known', tag, error: null });
}

/**
 * 진단·사용자 안내 전용. `displayName` 은 ICU 버전에 따라 달라질 수 있으므로
 * 계약·hash·프롬프트에는 넣지 않는다.
 */
export function identifyLanguage(input) {
    const inspected = inspectLanguageTag(input);
    if (!inspected.valid)
        return Object.freeze({
            known: false,
            tag: null,
            baseLanguage: null,
            displayName: null,
            source: 'invalid',
        });
    const dn = languageDisplayNames();
    let displayName = null;
    if (dn) {
        try {
            displayName = dn.of(inspected.tag.baseLanguage) ?? null;
        }
        catch {
            displayName = null;
        }
    }
    return Object.freeze({
        known: inspected.known,
        tag: inspected.tag.tag,
        baseLanguage: inspected.tag.baseLanguage,
        displayName,
        source: dn ? 'intl-display-names' : 'unavailable',
    });
}

/** base language 가 ko 면 한국어 특화 계열, 그 외(영어 포함)는 공통 다국어 계열. */
export function promptFamilyFor(input) {
    return normalizeLanguageTag(input).promptFamily;
}

// ─── 생애 단계별 언어 결정 ──────────────────────────────────────────────────

/**
 * 명시 언어 신호들을 하나로 좁힌다. 상충하는 값이 둘 이상이면 조용히 고르지 않고
 * 선택을 요구한다.
 */
function selectRequestedLanguage(requested) {
    if (requested === undefined || requested === null)
        return null;
    const values = Array.isArray(requested) ? requested : [requested];
    const present = values.filter((v) => v !== undefined && v !== null);
    if (present.length === 0)
        return null;
    const tags = present.map((v) => normalizeLanguageTag(v));
    const distinct = [...new Set(tags.map((t) => t.tag))].sort(compareCodePoints);
    if (distinct.length > 1)
        fail(LANGUAGE_ERROR_CODES.LANGUAGE_SELECTION_REQUIRED, { requested: distinct });
    return tags[0];
}

function resolution(language, source, implicitLegacy) {
    return Object.freeze({ language, source, implicitLegacy });
}

/**
 * foundation 이전 경로(`init`/`create`/`profile`)의 언어 결정.
 *
 * 언어 키 없는 기존 프로필은 **이미 선택된 암묵적 ko** 이므로, 다른 언어를 명시한
 * 생성 호출은 조용한 override 가 아니라 `LANGUAGE_CONTRACT_CONFLICT` 다. 의도적인
 * foundation 이전 언어 변경은 프로필 lifecycle 의 새 revision 으로 처리한다.
 *
 * @param {{ requested?: string|string[]|null,
 *           profileLanguage?: string|null,
 *           profileHasLanguageKey?: boolean }} input
 */
export function resolveCreationLanguage({ requested, profileLanguage = null, profileHasLanguageKey } = {}) {
    const requestedTag = selectRequestedLanguage(requested);
    const declared = profileLanguage === undefined || profileLanguage === null
        ? null
        : normalizeLanguageTag(profileLanguage);
    // 키가 있다고 보고됐는데 값이 없는 프로필은 손상된 계약이다.
    if (declared === null && profileHasLanguageKey === true)
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, { reason: 'missing_stored_language', scope: 'profile' });

    const implicitLegacy = declared === null && profileHasLanguageKey === false;
    const stored = declared ?? (implicitLegacy ? normalizeLanguageTag(IMPLICIT_LEGACY_LANGUAGE) : null);

    if (requestedTag && stored && requestedTag.tag !== stored.tag)
        fail(LANGUAGE_ERROR_CODES.LANGUAGE_CONTRACT_CONFLICT, {
            requested: requestedTag.tag,
            stored: stored.tag,
            implicitLegacy,
        });
    if (stored)
        return resolution(stored, implicitLegacy ? 'legacy-implicit' : 'profile', implicitLegacy);
    if (requestedTag)
        return resolution(requestedTag, 'requested', false);
    // 아무 계약도 없는 신규 호출만 ko 로 해석한다.
    return resolution(normalizeLanguageTag(IMPLICIT_LEGACY_LANGUAGE), 'default', false);
}

/**
 * 생성이 끝난 작품(`write`/`resume`/발행)의 언어 확인. v1 은 언어 변경을 지원하지
 * 않으므로 명시 인자는 일치 확인용이며 일회성 출력 override 가 아니다.
 *
 * @param {{ requested?: string|string[]|null,
 *           workLanguage?: string|null,
 *           workHasLanguageKey?: boolean }} input
 */
export function resolveExistingWorkLanguage({ requested, workLanguage = null, workHasLanguageKey } = {}) {
    const requestedTag = selectRequestedLanguage(requested);
    const storedTag = workLanguage === undefined || workLanguage === null ? null : normalizeLanguageTag(workLanguage);
    if (storedTag === null && workHasLanguageKey === true)
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, { reason: 'missing_stored_language', scope: 'work' });
    const effective = storedTag ?? normalizeLanguageTag(IMPLICIT_LEGACY_LANGUAGE);
    const implicitLegacy = storedTag === null;

    if (requestedTag && requestedTag.tag !== effective.tag)
        fail(LANGUAGE_ERROR_CODES.WORK_LANGUAGE_IMMUTABLE, {
            requested: requestedTag.tag,
            stored: effective.tag,
            implicitLegacy,
        });
    return resolution(effective, implicitLegacy ? 'legacy-implicit' : 'work', implicitLegacy);
}

// ─── 분량 계약 ──────────────────────────────────────────────────────────────

function assertLengthTarget(target, context) {
    if (typeof target !== 'number' || !Number.isFinite(target) || !Number.isInteger(target) || target <= 0)
        fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT, { ...context, reason: 'target_not_positive_integer' });
}

function normalizeLengthInput(length, context) {
    if (length === undefined || length === null)
        return null;
    if (typeof length !== 'object' || Array.isArray(length))
        fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT, { ...context, reason: 'not_an_object' });
    if (!LENGTH_UNITS.includes(length.unit))
        fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT, { ...context, reason: 'unknown_unit', unit: length.unit ?? null });
    assertLengthTarget(length.target, context);
    return Object.freeze({ unit: length.unit, target: length.target });
}

/**
 * 구형 인자는 이름과 무관하게 `legacyCodeUnits` 로만 해석한다. 호출자가 실제로
 * 중복 지정한 필드끼리 값이 다르면 충돌이다.
 */
function normalizeLegacyLengthInput(legacyLength, context) {
    if (legacyLength === undefined || legacyLength === null)
        return null;
    if (typeof legacyLength !== 'object' || Array.isArray(legacyLength))
        fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT, { ...context, reason: 'not_an_object' });
    const specified = [];
    for (const field of LEGACY_LENGTH_FIELDS) {
        const value = legacyLength[field];
        if (value === undefined || value === null)
            continue;
        assertLengthTarget(value, { ...context, field });
        specified.push({ field, target: value });
    }
    if (specified.length === 0)
        return null;
    const distinct = [...new Set(specified.map((s) => s.target))];
    if (distinct.length > 1)
        fail(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT, {
            ...context,
            reason: 'legacy_fields_disagree',
            specified: specified.map((s) => [s.field, s.target]),
        });
    return Object.freeze({
        unit: 'legacyCodeUnits',
        target: distinct[0],
        fields: Object.freeze(specified.map((s) => s.field)),
    });
}

/** 신규 length 와 구형 인자는 단위와 목표가 모두 같을 때만 함께 쓸 수 있다. */
function combineLength(length, legacy, scope) {
    if (length && legacy) {
        if (length.unit !== legacy.unit || length.target !== legacy.target)
            fail(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT, {
                scope,
                length: { unit: length.unit, target: length.target },
                legacy: { unit: legacy.unit, target: legacy.target },
                legacyFields: legacy.fields,
            });
        return { value: Object.freeze({ unit: length.unit, target: length.target }), via: 'explicit' };
    }
    if (length)
        return { value: length, via: 'explicit' };
    if (legacy)
        return { value: Object.freeze({ unit: legacy.unit, target: legacy.target }), via: 'legacy' };
    return { value: null, via: null };
}

/** 언어 계열별 기본 분량. 기존 값의 변환이 아니라 새 작품의 명시된 기본값이다. */
export function defaultLengthFor(language) {
    const tag = normalizeLanguageTag(language);
    return Object.freeze(tag.promptFamily === PROMPT_FAMILY_KO
        ? { unit: 'legacyCodeUnits', target: DEFAULT_LENGTH_TARGET }
        : { unit: 'graphemes', target: DEFAULT_LENGTH_TARGET });
}

/**
 * 분량 계약 resolver. `profile/create` 와 고급 `draft` 의 length 입력이 모두 이곳을
 * 지나며, 단계별 코드가 `chapterChars` 를 직접 읽어 기본값을 다시 정하지 않는다.
 *
 * @returns {{ unit: string, target: number,
 *             source: 'explicit'|'legacy'|'stored'|'stored-legacy'|'default' }}
 */
export function resolveLengthContract({ language, length, legacyLength, storedLength, storedLegacyLength } = {}) {
    const tag = normalizeLanguageTag(language);
    const requested = combineLength(normalizeLengthInput(length, { scope: 'requested' }), normalizeLegacyLengthInput(legacyLength, { scope: 'requested' }), 'requested');
    if (requested.value)
        return Object.freeze({ ...requested.value, source: requested.via });

    const stored = combineLength(normalizeLengthInput(storedLength, { scope: 'stored' }), normalizeLegacyLengthInput(storedLegacyLength, { scope: 'stored' }), 'stored');
    if (stored.value)
        return Object.freeze({ ...stored.value, source: stored.via === 'legacy' ? 'stored-legacy' : 'stored' });

    return Object.freeze({ ...defaultLengthFor(tag), source: 'default' });
}

// ─── 측정 정책 ──────────────────────────────────────────────────────────────

/** 2B(Grok)가 구현할 counter 인터페이스. 이 모듈은 세지 않는다. */
export const LENGTH_MEASUREMENT_CONTRACT = Object.freeze({
    contractVersion: 1,
    counter: Object.freeze({
        name: 'countLength',
        args: Object.freeze(['text: string', 'policy: MeasurementPolicy']),
        returns: '{ unit: string, count: number, measurementPolicyHash: string }',
    }),
    units: LENGTH_UNITS,
    scope: 'published-prose',
    scopeRule: 'sentinel-stripped, trimmed published prose; graphemes include whitespace and punctuation',
    wordRule: 'Intl.Segmenter word granularity in the target language, isWordLike segments only',
    graphemeRule: `Intl.Segmenter grapheme granularity in the fixed measurement locale ${GRAPHEME_MEASUREMENT_LOCALE}`,
    errorCodes: Object.freeze([
        LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT,
        LANGUAGE_ERROR_CODES.INVALID_LENGTH_MEASUREMENT,
    ]),
});

function segmenterAvailable() {
    return typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
}

function resolveSegmenterLocale(locale, granularity) {
    return new Intl.Segmenter(locale, { granularity }).resolvedOptions().locale;
}

/**
 * 목표 언어가 단어 분할을 실제로 지원하는가. `supportedLocalesOf` 와
 * `resolvedOptions()` 를 함께 확인해 호스트 기본 언어로 조용히 대체되는 경우를
 * 지원으로 세지 않는다. (로컬 확인: `kr` 요청 Segmenter 는 `en-US` 로 대체된다.)
 */
export function isWordMeasurementSupported(language) {
    let tag;
    try {
        tag = normalizeLanguageTag(language, { requireKnown: false });
    }
    catch {
        return false;
    }
    if (!segmenterAvailable())
        return false;
    try {
        if (Intl.Segmenter.supportedLocalesOf([tag.tag]).length === 0)
            return false;
        const resolved = resolveSegmenterLocale(tag.tag, 'word');
        return new Intl.Locale(resolved).language === tag.baseLanguage;
    }
    catch {
        return false;
    }
}

function runtimeDescriptor() {
    const versions = typeof process !== 'undefined' && process.versions ? process.versions : {};
    return Object.freeze({
        name: 'node',
        version: versions.node ?? null,
        icu: versions.icu ?? null,
        unicode: versions.unicode ?? null,
    });
}

/**
 * 측정 정책 서술. generation·length gate·density·요약 분량 지시가 같은 객체를
 * 공유한다. 목표 언어(`language`)와 실제 측정 locale(`requestedLocale`/
 * `resolvedLocale`)을 분리해 정직하게 기록한다.
 *
 * - `legacyCodeUnits`: JS `String.length`. locale 비의존이므로 측정 locale 없음.
 * - `graphemes`: 고정 공통 측정 locale(`GRAPHEME_MEASUREMENT_LOCALE`). 목표 언어로
 *   재지정할 수 없다.
 * - `words`: 반드시 **목표 언어**로 분할한다. 다른 measurementLocale 로 미지원
 *   목표 언어를 우회할 수 없다.
 *
 * @param {{ language: string|object, unit: string, measurementLocale?: string|null }} input
 */
export function resolveMeasurementPolicy({ language, unit, measurementLocale = null } = {}) {
    const tag = normalizeLanguageTag(language);
    if (!LENGTH_UNITS.includes(unit))
        fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT, { reason: 'unknown_unit', unit: unit ?? null });
    const overrideTag = measurementLocale === null || measurementLocale === undefined
        ? null
        : normalizeLanguageTag(measurementLocale, { requireKnown: false });

    const base = {
        measurementPolicyVersion: MEASUREMENT_POLICY_VERSION,
        unit,
        language: tag.tag,
        scope: LENGTH_MEASUREMENT_CONTRACT.scope,
        runtime: runtimeDescriptor(),
    };

    if (unit === 'legacyCodeUnits') {
        if (overrideTag)
            fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT, {
                reason: 'measurement_locale_not_applicable',
                unit,
                measurementLocale: overrideTag.tag,
            });
        // 현재 JS String.length 와 동일. locale 비의존이므로 분할기를 쓰지 않는다.
        return Object.freeze({
            ...base,
            requestedLocale: null,
            resolvedLocale: null,
            segmenterGranularity: null,
            countsWhitespace: true,
            countsPunctuation: true,
            countsWordLikeOnly: false,
        });
    }

    if (!segmenterAvailable())
        fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
            reason: 'segmenter_unavailable',
            unit,
            language: tag.tag,
            guidance: 'legacyCodeUnits',
        });

    if (unit === 'graphemes') {
        if (overrideTag && overrideTag.tag !== GRAPHEME_MEASUREMENT_LOCALE)
            fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT, {
                reason: 'grapheme_measurement_locale_fixed',
                unit,
                measurementLocale: overrideTag.tag,
                expected: GRAPHEME_MEASUREMENT_LOCALE,
            });
        // 문자군 계산은 언어 사전을 요구하지 않는다. 목표 언어가 아니라 하나의
        // 공통 측정 locale 을 쓰고 그 사실을 그대로 기록한다.
        return Object.freeze({
            ...base,
            requestedLocale: GRAPHEME_MEASUREMENT_LOCALE,
            resolvedLocale: resolveSegmenterLocale(GRAPHEME_MEASUREMENT_LOCALE, 'grapheme'),
            segmenterGranularity: 'grapheme',
            countsWhitespace: true,
            countsPunctuation: true,
            countsWordLikeOnly: false,
        });
    }

    // words: 측정 locale 은 목표 언어여야 한다. 다른 locale 로 우회할 수 없다.
    if (overrideTag && overrideTag.baseLanguage !== tag.baseLanguage)
        fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
            reason: 'measurement_locale_must_match_target',
            unit,
            language: tag.tag,
            measurementLocale: overrideTag.tag,
            guidance: 'graphemes',
        });
    const requestedLocale = overrideTag ? overrideTag.tag : tag.tag;
    const supported = Intl.Segmenter.supportedLocalesOf([requestedLocale]);
    const resolvedLocale = resolveSegmenterLocale(requestedLocale, 'word');
    const resolvedBase = new Intl.Locale(resolvedLocale).language;
    if (supported.length === 0 || resolvedBase !== tag.baseLanguage)
        // 언어 자체의 미지원이 아니라 측정 단위의 미지원이다.
        fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
            reason: 'word_segmentation_unsupported',
            unit,
            language: tag.tag,
            requestedLocale,
            resolvedLocale,
            supportedLocales: supported,
            guidance: 'graphemes',
        });

    return Object.freeze({
        ...base,
        requestedLocale,
        resolvedLocale,
        segmenterGranularity: 'word',
        countsWhitespace: false,
        countsPunctuation: false,
        countsWordLikeOnly: true,
    });
}

// ─── 결정적 직렬화 ──────────────────────────────────────────────────────────

function canonicalize(value) {
    if (Array.isArray(value))
        return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort(compareCodePoints)) {
            if (value[key] === undefined)
                continue;
            out[key] = canonicalize(value[key]);
        }
        return out;
    }
    return value;
}

function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}

export function computeMeasurementPolicyHash(policy) {
    return sha256(JSON.stringify(canonicalize(policy)));
}

/**
 * Grok 의 counter 결과가 측정 계약을 지켰는지 확인한다. 다른 정책으로 잰 수치가
 * 같은 계약의 결과로 흘러들지 않게 한다.
 */
export function validateLengthMeasurementResult(result, policy) {
    if (result === null || typeof result !== 'object' || Array.isArray(result))
        fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_MEASUREMENT, { reason: 'not_an_object' });
    if (result.unit !== policy?.unit)
        fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_MEASUREMENT, {
            reason: 'unit_mismatch',
            expected: policy?.unit ?? null,
            received: result.unit ?? null,
        });
    const { count } = result;
    if (typeof count !== 'number' || !Number.isFinite(count) || !Number.isInteger(count) || count < 0)
        fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_MEASUREMENT, { reason: 'count_not_non_negative_integer' });
    const expectedHash = computeMeasurementPolicyHash(policy);
    if (result.measurementPolicyHash !== expectedHash)
        fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_MEASUREMENT, {
            reason: 'policy_hash_mismatch',
            expected: expectedHash,
            received: typeof result.measurementPolicyHash === 'string' ? result.measurementPolicyHash : null,
        });
    return Object.freeze({ unit: result.unit, count, measurementPolicyHash: expectedHash });
}

// ─── 정본 형식 정책 ─────────────────────────────────────────────────────────

/**
 * 형식 버전은 locale 에서 매번 추론하지 않고 문서에 기록된 값을 따른다. 1 의
 * 읽기/저장을 2 로 자동 바꾸지 않으며, 키가 없던 구작에는 키를 새로 넣지 않는다.
 *
 * @param {{ language: string|object, stored?: number|null, storedHasKey?: boolean }} input
 */
export function resolveCanonicalFormatVersion({ language, stored = null, storedHasKey } = {}) {
    const tag = normalizeLanguageTag(language);
    if (stored !== null && stored !== undefined) {
        if (stored !== CANONICAL_FORMAT_VERSION_LEGACY_KO && stored !== CANONICAL_FORMAT_VERSION_MULTILINGUAL)
            fail(LANGUAGE_ERROR_CODES.INVALID_FORMAT_VERSION, { stored });
        return Object.freeze({ canonicalFormatVersion: stored, source: 'stored', writesFormatKeys: true });
    }
    // 키가 있다고 보고됐는데 값이 없는 문서는 손상된 계약이다. 새 v2 문서로 승격하지 않는다.
    if (storedHasKey === true)
        fail(LANGUAGE_ERROR_CODES.INVALID_FORMAT_VERSION, { reason: 'missing_stored_format_version', stored: stored ?? null });
    if (storedHasKey === false)
        return Object.freeze({
            canonicalFormatVersion: CANONICAL_FORMAT_VERSION_LEGACY_KO,
            source: 'legacy-implicit',
            writesFormatKeys: false,
        });
    return Object.freeze({
        canonicalFormatVersion: tag.promptFamily === PROMPT_FAMILY_KO
            ? CANONICAL_FORMAT_VERSION_LEGACY_KO
            : CANONICAL_FORMAT_VERSION_MULTILINGUAL,
        source: 'new',
        writesFormatKeys: true,
    });
}

// ─── 승인된 인용 예외 ───────────────────────────────────────────────────────

/**
 * 본문·요약·설정 설명 전체를 다른 언어로 여는 wildcard 성 scope. 구문 단계에서
 * 명백한 것만 막는다. 종류별 scope 의 실제 유효성과 승인 revision 결합은 phase 3.
 */
const WILDCARD_SCOPES = new Set([
    '*', 'all', 'any', 'everything', 'body', 'prose', 'narration', 'summary', 'description',
    '전체', '모두', '본문', '요약', '설명',
]);
const MAX_EXCEPTION_SCOPE_LENGTH = 200;

function normalizeException(entry, index) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_EXCEPTION, { index, reason: 'not_an_object' });
    if (!LANGUAGE_EXCEPTION_KINDS.includes(entry.kind))
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_EXCEPTION, { index, reason: 'unknown_kind', kind: entry.kind ?? null });
    let language;
    try {
        language = normalizeLanguageTag(entry.language);
    }
    catch (err) {
        if (!(err instanceof LanguagePolicyError))
            throw err;
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_EXCEPTION, { index, reason: 'invalid_language', cause: err.code });
    }
    const scope = typeof entry.scope === 'string' ? entry.scope.trim() : '';
    if (scope === '')
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_EXCEPTION, { index, reason: 'scope_required' });
    if (WILDCARD_SCOPES.has(scope.toLowerCase()))
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_EXCEPTION, { index, reason: 'wildcard_scope' });
    if (scope.length > MAX_EXCEPTION_SCOPE_LENGTH)
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_EXCEPTION, { index, reason: 'scope_too_long', length: scope.length });
    if (hasControlCharacters(scope))
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_EXCEPTION, { index, reason: 'scope_control_characters' });
    const rationale = typeof entry.rationale === 'string' ? entry.rationale.trim() : '';
    if (rationale === '')
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_EXCEPTION, { index, reason: 'rationale_required' });
    return Object.freeze({ kind: entry.kind, language: language.tag, scope, rationale });
}

/**
 * 승인된 인용 예외의 **구문** 정규화. `rationale` 은 작품 데이터로만 보존하며
 * system 지시문에 넣지 않는다(`buildLanguageDirective` 참고).
 *
 * phase 3 이 추가로 검증해야 하는 것: `characterDialogue` 의 scope 가 실재하는
 * 인물 ID 인지, `sourceQuote` 의 출처가 승인된 인용인지, 그리고 각 예외가 어느
 * 승인 프로필 revision 에 귀속되는지. 이 함수만으로 예외의 정당성이 확정되지
 * 않는다.
 */
export function normalizeLanguageExceptions(list, { language } = {}) {
    if (list === undefined || list === null)
        return Object.freeze([]);
    if (!Array.isArray(list))
        fail(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_EXCEPTION, { reason: 'not_an_array' });
    if (language !== undefined && language !== null)
        normalizeLanguageTag(language);
    const normalized = list.map((entry, index) => normalizeException(entry, index));
    normalized.sort((a, b) => compareCodePoints(a.kind, b.kind)
        || compareCodePoints(a.language, b.language)
        || compareCodePoints(a.scope, b.scope));
    return Object.freeze(normalized);
}

// ─── 계약 조립과 hash ───────────────────────────────────────────────────────

function assertTemplateVersion(templateVersion) {
    const ok = (typeof templateVersion === 'number' && Number.isInteger(templateVersion) && templateVersion > 0)
        || (typeof templateVersion === 'string' && templateVersion.trim() !== '' && !hasControlCharacters(templateVersion));
    if (!ok)
        fail(LANGUAGE_ERROR_CODES.INVALID_TEMPLATE_VERSION, { received: typeof templateVersion });
    return templateVersion;
}

function resolvePinnedDialogueBreakMode({
    dialogueBreakMode = null,
    formatPolicy = null,
}) {
    const fromArg = dialogueBreakMode === undefined ? null : dialogueBreakMode;
    const fromPolicy = formatPolicy && typeof formatPolicy === 'object' && !Array.isArray(formatPolicy)
        ? (formatPolicy.dialogueBreakMode === undefined ? null : formatPolicy.dialogueBreakMode)
        : null;
    if (fromArg !== null && fromPolicy !== null && fromArg !== fromPolicy) {
        fail(LANGUAGE_ERROR_CODES.FORMAT_POLICY_CONFLICT, {
            reason: 'dialogue_break_mode',
            expected: fromPolicy,
            received: fromArg,
        });
    }
    const pinned = fromArg ?? fromPolicy;
    if (pinned !== null && pinned !== undefined && pinned !== '') {
        if (!DIALOGUE_BREAK_MODES.includes(pinned)) {
            fail(LANGUAGE_ERROR_CODES.INVALID_DIALOGUE_BREAK_MODE, {
                received: typeof pinned === 'string' ? pinned : null,
                allowed: DIALOGUE_BREAK_MODES,
            });
        }
        return pinned;
    }
    if (pinned === '') {
        fail(LANGUAGE_ERROR_CODES.INVALID_DIALOGUE_BREAK_MODE, {
            received: '',
            allowed: DIALOGUE_BREAK_MODES,
        });
    }
    // Defaults become authority only at an accepted-work boundary.
    return null;
}

/**
 * workContract 의 언어 소유 부분을 조립한다. 모든 값은 JSON 직렬화 가능하며
 * `provenance` 를 뺀 나머지가 hash 대상이다.
 *
 * `formatPolicy` / `dialogueBreakMode` 는 선택이다. 둘 다 오면 값이 같아야 한다.
 * Only an explicitly supplied mode is pinned. Accepted-work callers supply defaults.
 */
export function buildLanguageContract({
    language,
    length = null,
    legacyLength = null,
    storedLength = null,
    storedLegacyLength = null,
    storedCanonicalFormatVersion = null,
    storedFormatVersionKeyPresent,
    allowedLanguageExceptions = [],
    templateVersion = LANGUAGE_DIRECTIVE_VERSION,
    checkerPolicyVersion = CHECKER_POLICY_VERSION,
    measurementLocale = null,
    languageSource = 'requested',
    formatPolicy = null,
    dialogueBreakMode = null,
} = {}) {
    const tag = normalizeLanguageTag(language);
    const resolvedLength = resolveLengthContract({ language: tag, length, legacyLength, storedLength, storedLegacyLength });
    const measurementPolicy = resolveMeasurementPolicy({ language: tag, unit: resolvedLength.unit, measurementLocale });
    const format = resolveCanonicalFormatVersion({
        language: tag,
        stored: storedCanonicalFormatVersion,
        storedHasKey: storedFormatVersionKeyPresent,
    });
    const exceptions = normalizeLanguageExceptions(allowedLanguageExceptions, { language: tag });
    const pinnedMode = resolvePinnedDialogueBreakMode({
        dialogueBreakMode,
        formatPolicy,
    });
    const assembledFormatPolicy = {
        formatPolicyVersion: FORMAT_POLICY_VERSION,
        canonicalFormatVersion: format.canonicalFormatVersion,
        writesFormatKeys: format.writesFormatKeys,
        ...(pinnedMode ? { dialogueBreakMode: pinnedMode } : {}),
    };

    return Object.freeze({
        schemaVersion: LANGUAGE_POLICY_SCHEMA_VERSION,
        language: tag.tag,
        baseLanguage: tag.baseLanguage,
        script: tag.script,
        region: tag.region,
        promptFamily: tag.promptFamily,
        templateVersion: assertTemplateVersion(templateVersion),
        directiveVersion: LANGUAGE_DIRECTIVE_VERSION,
        length: Object.freeze({ unit: resolvedLength.unit, target: resolvedLength.target }),
        measurementPolicy,
        formatPolicy: Object.freeze(assembledFormatPolicy),
        checkerPolicyVersion,
        allowedLanguageExceptions: exceptions,
        // hash 대상이 아니다 — 같은 의미의 계약이 출처 때문에 다른 hash 가 되지 않게 한다.
        provenance: Object.freeze({
            languageSource,
            lengthSource: resolvedLength.source,
            formatVersionSource: format.source,
        }),
    });
}

/** hash 대상 필드만 정렬해 직렬화한다. */
export function canonicalizeLanguageContract(contract) {
    const { provenance, ...hashed } = contract ?? {};
    return JSON.stringify(canonicalize(hashed));
}

/** workflow·relay run·검사 영수증·sync candidate 가 함께 참조하는 계약 hash. */
export function computeLanguageContractHash(contract) {
    return sha256(canonicalizeLanguageContract(contract));
}

// ─── system 지시문 조립 ─────────────────────────────────────────────────────

const UNIT_DESCRIPTION_EN = Object.freeze({
    legacyCodeUnits: 'JavaScript string length units, whitespace and punctuation included',
    graphemes: 'Unicode grapheme clusters, whitespace and punctuation included',
    words: 'word-like segments of the target language',
});

const UNIT_DESCRIPTION_KO = Object.freeze({
    legacyCodeUnits: 'JS 문자열 길이 기준, 공백과 문장부호 포함',
    graphemes: 'Unicode 문자군 기준, 공백과 문장부호 포함',
    words: '목표 언어의 단어 단위',
});

/**
 * 검증된 값(정규화된 태그, enum, 정수)만으로 system 지시문을 조립한다. 사용자 자유
 * 텍스트(예외의 `scope`/`rationale`, 문체 지침)는 어떤 경우에도 렌더링하지 않으며
 * 작품 데이터로 별도 직렬화한다.
 */
export function buildLanguageDirective(contract) {
    const tag = normalizeLanguageTag(contract?.language);
    const unit = contract?.length?.unit;
    if (!LENGTH_UNITS.includes(unit))
        fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT, { reason: 'unknown_unit', unit: unit ?? null });
    assertLengthTarget(contract?.length?.target, { scope: 'directive' });
    const target = contract.length.target;
    const exceptionKinds = Object.freeze([...new Set((contract.allowedLanguageExceptions ?? []).map((e) => e.kind))]
        .filter((kind) => LANGUAGE_EXCEPTION_KINDS.includes(kind))
        .sort(compareCodePoints));

    const system = [];
    if (tag.promptFamily === PROMPT_FAMILY_KO) {
        system.push(`작품 언어(BCP 47): ${tag.tag}.`);
        system.push('본문·제목·요약·설정 설명·인물 설명·계획과 검토의 설명 값을 작품 언어로 쓴다.');
        system.push('JSON 키, 기존 enum 값, ID, 경로, sentinel 태그는 번역하지 않는다.');
        system.push(`화당 분량 목표: ${target} ${unit} (${UNIT_DESCRIPTION_KO[unit]}).`);
        if (exceptionKinds.length > 0)
            system.push(`승인된 외국어 예외 종류: ${exceptionKinds.join(', ')}. 그 밖의 다른 언어 출력은 허용하지 않는다.`);
    }
    else {
        system.push(`Target work language (BCP 47): ${tag.tag}.`);
        if (tag.script)
            system.push(`Use the ${tag.script} script consistently.`);
        system.push('Write all prose, titles, summaries, setting and character descriptions, and plan and review explanation values in the target work language.');
        system.push('Do not translate JSON keys, existing enum values, IDs, paths, or sentinel tags.');
        system.push(`Chapter length target: ${target} ${unit} (${UNIT_DESCRIPTION_EN[unit]}).`);
        if (exceptionKinds.length > 0)
            system.push(`Approved foreign-language exceptions are limited to: ${exceptionKinds.join(', ')}. No other non-target-language output is allowed.`);
    }

    return Object.freeze({
        directiveVersion: LANGUAGE_DIRECTIVE_VERSION,
        promptFamily: tag.promptFamily,
        slots: Object.freeze({
            languageTag: tag.tag,
            baseLanguage: tag.baseLanguage,
            script: tag.script,
            region: tag.region,
            lengthUnit: unit,
            lengthTarget: target,
            allowedExceptionKinds: exceptionKinds,
        }),
        system: Object.freeze(system),
    });
}
