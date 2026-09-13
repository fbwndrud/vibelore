/**
 * prompt-language — 프롬프트 계열 라우팅과 조립 helper (다국어 Phase 2A).
 *
 * `language-policy.js` 가 소유한 계약 의미(태그 정규화, 분량 단위, 측정 정책,
 * system 지시문)를 **다시 해석하지 않고** 프롬프트 단계에서 쓸 수 있는 형태로만
 * 감싼다. 여기서 새로 정하는 것은 두 가지뿐이다:
 *
 *   1. 단계별 문자열을 ko / multilingual **두 계열 중 하나로 고르는 방법**
 *      (`pickByFamily`). 세 번째 계열이나 언어별 분기를 만들지 않는다.
 *   2. 계약이 아예 주어지지 않은 구형 호출의 해석 — `IMPLICIT_LEGACY_LANGUAGE`
 *      (ko) 이며, 이때는 `directive` system 줄을 붙이지 않아 기존 ko 프롬프트가
 *      byte-identical 로 유지된다.
 *
 * 하지 않는 것:
 * - 분량 기본값/clamp 재정의. 전부 `resolveLengthContract` 가 정한다.
 * - 공급된 계약의 언어·단위 재해석이나 조용한 override. 불일치는 오류다.
 * - 사용자 자유 텍스트의 system 삽입. 자유 텍스트는 작가 데이터 블록으로만 간다.
 */
import {
    IMPLICIT_LEGACY_LANGUAGE,
    LANGUAGE_ERROR_CODES,
    LanguagePolicyError,
    PROMPT_FAMILY_KO,
    PROMPT_FAMILY_MULTILINGUAL,
    buildLanguageContract,
    buildLanguageDirective,
    computeLanguageContractHash,
    normalizeLanguageTag,
    resolveLengthContract,
} from './language-policy.js';

/** 계약 없는 구형 호출의 실행 해석. "미설정" 이 아니라 이미 선택된 암묵적 ko. */
export const DEFAULT_PROMPT_LANGUAGE = IMPLICIT_LEGACY_LANGUAGE;

const CONTEXT_BRAND = Symbol.for('vibelore.promptLanguageContext');

/** 이미 조립된 PromptLanguageContext 인가. */
export function isPromptLanguageContext(value) {
    return value !== null && typeof value === 'object' && value[CONTEXT_BRAND] === true;
}

/**
 * `buildLanguageContract` 가 **완성한** 언어 계약인가.
 *
 * 평범한 `{language, length}` 옵션과 완성된 계약을 구분하는 유일한 기준이다.
 * 옵션을 계약으로 오인하면 `buildLanguageContract` 를 건너뛰어 measurementPolicy
 * 없는 반쪽 계약이 만들어지고 `legacyLength` 충돌 검사도 사라진다 — 그래서
 * 측정 정책·형식 정책·계열까지 **전부** 갖춘 경우에만 계약으로 인정한다.
 */
export function isLanguageContract(value) {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && typeof value.schemaVersion === 'number'
        && typeof value.language === 'string'
        && typeof value.promptFamily === 'string'
        && value.length !== null && typeof value.length === 'object'
        && typeof value.length.unit === 'string'
        && typeof value.length.target === 'number'
        && value.measurementPolicy !== null && typeof value.measurementPolicy === 'object'
        && value.formatPolicy !== null && typeof value.formatPolicy === 'object';
}

/** 옵션 객체 안에 계약 조립용 키가 하나라도 있으면 계약 자체로 볼 수 없다. */
const OPTION_ONLY_KEYS = ['workContract', 'legacyLength', 'allowedLanguageExceptions'];

function looksLikeOptions(value) {
    return value !== null
        && typeof value === 'object'
        && OPTION_ONLY_KEYS.some((key) => key in value);
}

function conflict(details) {
    throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LANGUAGE_CONTRACT_CONFLICT, details);
}

/**
 * 프롬프트 단계가 쓰는 언어 컨텍스트를 만든다.
 *
 * @param {{
 *   workContract?: object|null,   // 이미 승인된 언어 계약. 있으면 **그대로** 쓴다.
 *   language?: string|object|null,// 계약이 없을 때의 목표 언어. 임의의 알려진 태그 허용.
 *   length?: {unit:string,target:number}|null,
 *   legacyLength?: {chapterChars?:number,chapterWordCount?:number,targetChars?:number}|null,
 *   allowedLanguageExceptions?: Array|undefined,
 * }} [input]
 * @returns {Readonly<{
 *   contract: object, language: string, promptFamily: string, isKo: boolean,
 *   length: {unit:string,target:number}, directive: object,
 *   systemLines: readonly string[], explicit: boolean,
 * }>}
 */
export function resolvePromptLanguageContext(input = {}) {
    if (isPromptLanguageContext(input))
        return input;
    // 완성된 계약만 그대로 받는다. `{language, length}` 같은 평범한 옵션은 반드시
    // buildLanguageContract 를 거쳐야 measurementPolicy 와 중복 검사가 살아 있다.
    if (!looksLikeOptions(input) && isLanguageContract(input))
        return resolvePromptLanguageContext({ workContract: input });

    const { workContract = null, language = null, length = null, legacyLength = null, allowedLanguageExceptions } = input ?? {};

    let contract;
    let explicit;
    if (workContract !== null && workContract !== undefined) {
        if (!isLanguageContract(workContract))
            throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT, {
                scope: 'workContract',
                reason: 'not_a_language_contract',
            });
        // 공급된 계약은 재조립하지 않는다. 함께 온 language/length/legacyLength 는
        // 전부 **확인용** 이며, 하나라도 어긋나면 조용히 고르지 않고 거부한다.
        const contractTag = normalizeLanguageTag(workContract.language);
        if (language !== null && language !== undefined) {
            const requestedTag = normalizeLanguageTag(language);
            if (requestedTag.tag !== contractTag.tag)
                conflict({ scope: 'prompt', requested: requestedTag.tag, stored: contractTag.tag });
        }
        if (length !== null && length !== undefined
            && (length.unit !== workContract.length.unit || length.target !== workContract.length.target))
            throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT, {
                scope: 'prompt',
                length: { unit: length.unit ?? null, target: length.target ?? null },
                contract: { unit: workContract.length.unit, target: workContract.length.target },
            });
        if (legacyLength !== null && legacyLength !== undefined)
            // 구형 인자끼리의 중복(chapterChars vs chapterWordCount vs targetChars)과
            // 계약 단위/목표와의 불일치를 같은 resolver 로 검사한다. 결과는 버리고
            // 계약을 그대로 쓴다 — 여기서 분량을 다시 정하지 않는다.
            resolveLengthContract({
                language: contractTag,
                length: workContract.length,
                legacyLength,
            });
        contract = workContract;
        explicit = true;
    }
    else {
        explicit = language !== null && language !== undefined;
        contract = buildLanguageContract({
            language: explicit ? language : DEFAULT_PROMPT_LANGUAGE,
            length,
            legacyLength,
            ...(allowedLanguageExceptions === undefined ? {} : { allowedLanguageExceptions }),
            languageSource: explicit ? 'requested' : 'default',
        });
    }

    const directive = buildLanguageDirective(contract);
    const promptFamily = directive.promptFamily;
    return Object.freeze({
        [CONTEXT_BRAND]: true,
        contract,
        language: contract.language,
        promptFamily,
        isKo: promptFamily === PROMPT_FAMILY_KO,
        length: contract.length,
        directive,
        // 계약이 명시된 경우에만 지시문을 붙인다. 구형 ko 호출은 기존 프롬프트 그대로.
        systemLines: explicit ? directive.system : Object.freeze([]),
        // 계약에 고정된 포맷 규칙(phase 3 이 formatPolicy 에 넣는다)이 있으면 그것이
        // 원천이고, 없으면 계열 기본값이다.
        dialogueBreakMode: pinnedDialogueBreakMode(contract) ?? defaultDialogueBreakMode(promptFamily),
        explicit,
    });
}

// ─── 포맷 정책(대사 문단 규칙) ──────────────────────────────────────────────

/**
 * ko 는 모바일 웹소설 관습(대사 독립 문단)을 그대로 두고, 비ko 는 목표 언어의
 * 산문 관습(서술 문단 안 대사 + 인라인 화자 표기)을 기본으로 한다. `strict` /
 * `relaxed` 는 기존 검사기(`webnovel-format`)의 의미를 그대로 유지한다.
 */
export const DIALOGUE_BREAK_MODES = Object.freeze(['strict', 'relaxed', 'natural']);
export const DEFAULT_DIALOGUE_BREAK_MODE_KO = 'strict';
export const DEFAULT_DIALOGUE_BREAK_MODE_MULTILINGUAL = 'natural';

/**
 * phase 3 이 `formatPolicy` 에 승인된 포맷 규칙을 넣어 계약 hash 에 묶기 전까지
 * 쓰는 안정적인 오류 코드. 필드가 계약으로 승격되면 `LANGUAGE_ERROR_CODES` 로
 * 옮긴다(코드 문자열은 그대로 유지).
 */
export const PROMPT_FORMAT_ERROR_CODES = Object.freeze({
    FORMAT_POLICY_CONFLICT: 'FORMAT_POLICY_CONFLICT',
    INVALID_DIALOGUE_BREAK_MODE: 'INVALID_DIALOGUE_BREAK_MODE',
});

function defaultDialogueBreakMode(promptFamily) {
    return promptFamily === PROMPT_FAMILY_KO
        ? DEFAULT_DIALOGUE_BREAK_MODE_KO
        : DEFAULT_DIALOGUE_BREAK_MODE_MULTILINGUAL;
}

function pinnedDialogueBreakMode(contract) {
    const pinned = contract?.formatPolicy?.dialogueBreakMode;
    if (pinned === undefined || pinned === null)
        return null;
    if (!DIALOGUE_BREAK_MODES.includes(pinned))
        throw new LanguagePolicyError(PROMPT_FORMAT_ERROR_CODES.INVALID_DIALOGUE_BREAK_MODE, {
            scope: 'workContract',
            received: typeof pinned === 'string' ? pinned : null,
            allowed: DIALOGUE_BREAK_MODES,
        });
    return pinned;
}

/**
 * 이번 호출에 적용할 대사 문단 모드. 계약에 고정된 값이 있으면 그것이 이기고,
 * 호출자가 다른 값을 함께 넘기면 조용히 덮지 않고 충돌로 거부한다.
 *
 * @param {object} context
 * @param {string|null} [requested] 호스트가 승인한 모드(프로필 `format.dialogueBreakMode`).
 */
export function resolveDialogueBreakMode(context, requested = null) {
    const ctx = resolvePromptLanguageContext(context);
    const pinned = pinnedDialogueBreakMode(ctx.contract);
    if (requested === null || requested === undefined)
        return ctx.dialogueBreakMode;
    if (!DIALOGUE_BREAK_MODES.includes(requested))
        throw new LanguagePolicyError(PROMPT_FORMAT_ERROR_CODES.INVALID_DIALOGUE_BREAK_MODE, {
            scope: 'requested',
            received: typeof requested === 'string' ? requested : null,
            allowed: DIALOGUE_BREAK_MODES,
        });
    if (pinned !== null && pinned !== requested)
        throw new LanguagePolicyError(PROMPT_FORMAT_ERROR_CODES.FORMAT_POLICY_CONFLICT, {
            scope: 'dialogueBreakMode',
            requested,
            stored: pinned,
        });
    return requested;
}

/**
 * 단계(step) 입력에서 언어 컨텍스트를 뽑는 공용 경로.
 *
 * 파이프라인은 이미 해석된 `promptLanguage` 를 넘기고, 단독 호출자는
 * `workContract`(승인된 계약) 또는 `language`/`length`(옵션)를 넘긴다. 둘이 함께
 * 오면 조용히 하나를 고르지 않고 일치하는지 확인한다.
 *
 * `input.language` 는 표시 문자열이 아니라 **목표 언어 선택**이다. 검증은
 * `normalizeLanguageTag`(Intl 식별) 이 하며 허용 목록은 없다. 식별 불가한 값은
 * 조용히 표시값으로 강등되지 않고 `INVALID_LANGUAGE_TAG` 로 거부된다 — 프롬프트가
 * 지시하는 언어와 계약 언어가 갈라지는 상태를 만들지 않기 위해서다.
 *
 * `allowLanguageField:false` 는 `language` 키가 언어 선택이 아닌 **다른 뜻**으로
 * 쓰이는 단계를 위한 탈출구로 남겨 둔다. 현재 생성 경로 중 쓰는 곳은 없다.
 *
 * 넘어온 **모든** 명시 인자(`workContract` / `language` / `length` /
 * `legacyLength`)가 확인 대상이다. 이미 해석된 `promptLanguage` 가 함께 와도
 * 나머지 인자를 버리지 않는다 — 버리면 호출자가 적은 분량·언어가 조용히 사라진다.
 */
export function resolveStepPromptLanguage(input = {}, { allowLanguageField = true } = {}) {
    const language = allowLanguageField ? (input.language ?? null) : null;
    const length = input.length ?? null;
    const legacyLength = input.legacyLength ?? null;
    const foundation = input.foundation ?? null;
    if (input.promptLanguage) {
        const ctx = resolvePromptLanguageContext(input.promptLanguage);
        if (input.workContract !== undefined && input.workContract !== null)
            assertSameContract(ctx.contract, input.workContract);
        // 언어·분량·구형 분량은 각각 계약과 맞는지 확인한다. 결과는 버리고 이미
        // 해석된 컨텍스트를 그대로 쓴다(여기서 계약을 다시 정하지 않는다).
        if (language !== null || length !== null || legacyLength !== null)
            resolvePromptLanguageContext({
                workContract: ctx.contract,
                ...(language === null ? {} : { language }),
                ...(length === null ? {} : { length }),
                ...(legacyLength === null ? {} : { legacyLength }),
            });
        assertFoundationLanguage(ctx, foundation);
        return ctx;
    }
    return resolveWorkPromptLanguage({
        workContract: input.workContract ?? null,
        language,
        length,
        legacyLength,
        foundation,
    });
}

/**
 * 저장된 작품 언어 메타데이터(Foundation)가 이 컨텍스트와 같은 작품의 것인지
 * 확인한다.
 *
 * 언어·측정 단위·포맷 정책·승인된 예외는 **같아야** 한다(작품 언어는 불변이다).
 * 회차 분량 **목표 수치**는 저장값이 생성 시점 기본값이고 회차별 지정이 기존부터
 * 지원되므로 같은 단위 안에서 다른 값을 허용한다.
 */
function assertFoundationLanguage(ctx, foundation) {
    if (foundation === null || foundation === undefined)
        return;
    const storedContract = foundation.workContract ?? null;
    if (storedContract !== null && storedContract !== undefined) {
        if (!isLanguageContract(storedContract))
            throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT, {
                scope: 'foundation',
                reason: 'not_a_language_contract',
            });
        resolvePromptLanguageContext({ workContract: ctx.contract, language: storedContract.language });
        // 회차 목표만 이 컨텍스트의 값으로 맞춘 뒤 나머지를 전부 비교한다.
        assertSameContract(contextWithRequestedLength(storedContract, { length: ctx.length }).contract, ctx.contract);
    }
    const storedLanguage = foundation.language ?? null;
    if (storedLanguage !== null && storedLanguage !== undefined)
        resolvePromptLanguageContext({ workContract: ctx.contract, language: storedLanguage });
    assertSameLengthUnit(ctx, foundation.length ?? null, 'foundation');
}

function assertSameLength(ctx, length, scope) {
    if (length === null || length === undefined)
        return;
    if (length.unit !== ctx.length.unit || length.target !== ctx.length.target)
        throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT, {
            scope,
            length: { unit: length.unit ?? null, target: length.target ?? null },
            contract: { unit: ctx.length.unit, target: ctx.length.target },
        });
}

/** 측정 단위만 비교한다(목표 수치는 회차별로 달라질 수 있다). */
function assertSameLengthUnit(ctx, length, scope) {
    if (length === null || length === undefined)
        return;
    if (length.unit !== ctx.length.unit)
        throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT, {
            scope,
            reason: 'measurement_unit_differs_from_work',
            length: { unit: length.unit ?? null, target: length.target ?? null },
            contract: { unit: ctx.length.unit, target: ctx.length.target },
        });
}

/**
 * 작품 단위 프롬프트 언어 해석 — **저장된 Foundation 메타데이터가 원천**이다.
 *
 * 생성 시점에 언어를 정한 작품은 이후 집필 호출이 매번 언어를 다시 넘기지 않는다.
 * 그때 호출 인자가 비었다는 이유로 구형 ko 로 떨어지면 작품 언어가 조용히 바뀐다.
 * 그래서 순서는 다음과 같다:
 *
 *   1. `foundation.workContract` — 승인된 계약. 그대로 쓴다.
 *   2. `foundation.language`(+`foundation.length`) — 저장된 언어로 계약을 조립한다.
 *   3. 둘 다 없는 구형 작품 — 호출자 인자(없으면 암묵적 ko). 기존 동작 그대로.
 *
 * 호출자가 언어·계약·분량을 함께 넘기면 **확인용**이며, 어긋나면 저장된 값을 조용히
 * 덮지 않고 거부한다(언어 변경은 v1 범위가 아니다).
 */
export function resolveWorkPromptLanguage(input = {}) {
    const {
        workContract = null, language = null, length = null, legacyLength = null, foundation = null,
    } = input ?? {};
    const storedContract = foundation?.workContract ?? null;
    const storedLanguage = foundation?.language ?? null;
    const storedLength = foundation?.length ?? null;

    if (storedContract !== null && storedContract !== undefined) {
        const ctx = resolvePromptLanguageContext({ workContract: storedContract });
        if (workContract !== null && workContract !== undefined)
            assertSameContract(ctx.contract, workContract);
        if (storedLanguage !== null && storedLanguage !== undefined)
            resolvePromptLanguageContext({ workContract: ctx.contract, language: storedLanguage });
        assertSameLength(ctx, storedLength, 'foundation');
        if (language !== null)
            resolvePromptLanguageContext({ workContract: ctx.contract, language });
        if (length === null && legacyLength === null)
            return ctx;
        // 이 호출에 **승인된 계약이 함께 왔다면** 그 계약의 분량이 고정값이다.
        // 어긋난 분량 인자는 조용히 덮지 않고 거부한다.
        if (workContract !== null && workContract !== undefined) {
            resolvePromptLanguageContext({
                workContract,
                ...(length === null ? {} : { length }),
                ...(legacyLength === null ? {} : { legacyLength }),
            });
            return ctx;
        }
        // 저장된 계약의 분량은 **생성 시점 기본값**이다(`resolveLengthContract` 의
        // storedLength 와 같은 뜻). 회차별 분량 요청은 기존에 지원되는 기능이므로
        // 언어·측정 정책은 그대로 두고 목표 수치만 요청값으로 바꾼다. 측정 단위까지
        // 바뀌는 요청은 다른 것을 세겠다는 뜻이라 거부한다.
        return contextWithRequestedLength(ctx.contract, { length, legacyLength });
    }
    if (storedLanguage !== null && storedLanguage !== undefined) {
        // 저장된 언어로 계약을 조립한다. 저장된 분량·정본 포맷 버전은 기본값이고
        // 호출 인자가 이긴다(`resolveLengthContract` 의 storedLength 의미와 동일).
        const storedFormatVersion = foundation?.canonicalFormatVersion ?? null;
        const ctx = resolvePromptLanguageContext({
            workContract: buildLanguageContract({
                language: storedLanguage,
                length,
                legacyLength,
                storedLength,
                storedCanonicalFormatVersion: storedFormatVersion,
                ...(storedFormatVersion === null ? {} : { storedFormatVersionKeyPresent: true }),
            }),
        });
        if (workContract !== null && workContract !== undefined)
            assertSameContract(ctx.contract, workContract);
        if (language !== null)
            resolvePromptLanguageContext({ workContract: ctx.contract, language });
        return ctx;
    }
    // 언어 메타데이터가 없는 구형 작품 — 호출자 인자대로(없으면 암묵적 ko).
    return resolvePromptLanguageContext({ workContract, language, length, legacyLength });
}

/**
 * 저장된 계약의 언어·측정 정책·승인된 예외를 유지하고 **회차 분량 목표만** 요청값으로
 * 바꾼 컨텍스트. 계약을 새로 해석하는 것이 아니라 phase 1 의 `storedLength`(기본값)
 * / 요청값 우선순위를 그대로 적용한다.
 *
 * 측정 단위가 바뀌는 요청은 거부한다 — 작품은 단어로 세면서 이 회차만 코드 단위로
 * 세는 상태를 만들지 않는다.
 */
function contextWithRequestedLength(stored, { length = null, legacyLength = null } = {}) {
    const requestedUnit = length?.unit ?? (legacyLength ? 'legacyCodeUnits' : null);
    if (requestedUnit !== null && requestedUnit !== stored.length.unit)
        throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT, {
            scope: 'foundation',
            reason: 'requested_unit_differs_from_work_contract',
            length: { unit: requestedUnit, target: length?.target ?? null },
            contract: { unit: stored.length.unit, target: stored.length.target },
        });
    const rebuilt = buildLanguageContract({
        language: stored.language,
        length,
        legacyLength,
        storedLength: stored.length,
        storedCanonicalFormatVersion: stored.formatPolicy?.canonicalFormatVersion ?? null,
        storedFormatVersionKeyPresent: stored.formatPolicy?.canonicalFormatVersion !== undefined,
        allowedLanguageExceptions: stored.allowedLanguageExceptions ?? [],
        templateVersion: stored.templateVersion,
        checkerPolicyVersion: stored.checkerPolicyVersion,
        measurementLocale: stored.measurementPolicy?.requestedLocale ?? null,
        languageSource: stored.provenance?.languageSource ?? 'requested',
    });
    // 계약에 고정된 추가 포맷 정책(phase 3 의 `dialogueBreakMode` 등)은 잃지 않는다.
    const contract = Object.freeze({
        ...rebuilt,
        formatPolicy: Object.freeze({ ...stored.formatPolicy, ...rebuilt.formatPolicy }),
    });
    return resolvePromptLanguageContext({ workContract: contract });
}

/**
 * 같은 의미의 계약인지 확인한다.
 *
 * 언어·분량만 비교하면 고정된 포맷 정책(`dialogueBreakMode`, canonicalFormatVersion)
 * 이나 승인된 언어 예외가 다른 두 계약이 같은 것으로 통과해, 어느 쪽 규칙으로
 * 프롬프트를 쓸지 조용히 결정된다. hash 대상 필드 전체를 비교해 거부한다.
 */
export function assertSameContract(contract, other) {
    if (!isLanguageContract(other))
        throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT, {
            scope: 'workContract',
            reason: 'not_a_language_contract',
        });
    // 언어·분량 불일치는 각자의 전용 오류 코드로 먼저 보고한다.
    resolvePromptLanguageContext({ workContract: other, language: contract.language, length: contract.length });
    if (computeLanguageContractHash(contract) !== computeLanguageContractHash(other))
        conflict({
            scope: 'workContract',
            reason: 'contract_differs_beyond_language_and_length',
            requested: other.language,
            stored: contract.language,
        });
}

/**
 * 단계별 문자열을 계열로 고른다. 계열은 정확히 둘이며 fallthrough 가 없다 —
 * 한국어 system 에 목표 언어 한 줄만 덧붙이는 형태를 구조적으로 막는다.
 */
export function pickByFamily(context, variants) {
    const ctx = resolvePromptLanguageContext(context);
    if (typeof variants !== 'object' || variants === null)
        throw new TypeError('pickByFamily: variants must be an object with ko/multilingual keys');
    if (!(PROMPT_FAMILY_KO in variants) || !(PROMPT_FAMILY_MULTILINGUAL in variants))
        throw new TypeError(`pickByFamily: variants must define both '${PROMPT_FAMILY_KO}' and '${PROMPT_FAMILY_MULTILINGUAL}'`);
    const chosen = ctx.isKo ? variants[PROMPT_FAMILY_KO] : variants[PROMPT_FAMILY_MULTILINGUAL];
    return typeof chosen === 'function' ? chosen(ctx) : chosen;
}

/**
 * 분량 목표의 표시 문자열. 단위를 항상 함께 적어 "단어" 지시와 문자 counter 가
 * 어긋나지 않게 한다. 구형 legacyCodeUnits + ko 는 기존처럼 숫자만 쓴다.
 */
export function formatLengthTarget(context) {
    const ctx = resolvePromptLanguageContext(context);
    const { unit, target } = ctx.length;
    if (ctx.isKo && unit === 'legacyCodeUnits')
        return String(target);
    return `${target} ${unit}`;
}

/**
 * 계약 지시문 줄. 구형 ko 호출에서는 빈 배열이라 프롬프트가 변하지 않는다.
 *
 * `includeChapterLength:false` 는 **회차 분량이 그 단계의 출력 분량이 아닌**
 * 단계(요약·기획·평가 등)를 위한 것이다. "회차 3000" 과 "요약 400" 을 한 프롬프트에
 * 나란히 실어 서로 모순된 목표를 주지 않는다. 제거 판정은 문구가 아니라 계약의
 * `목표 단위` 조합(`${target} ${unit}`)으로 하므로 지시문 문구가 바뀌어도 따라간다.
 *
 * @param {object} context
 * @param {{ includeChapterLength?: boolean }} [options]
 */
export function languageSystemLines(context, options = {}) {
    const { includeChapterLength = true } = options;
    const ctx = resolvePromptLanguageContext(context);
    if (includeChapterLength)
        return ctx.systemLines;
    const marker = `${ctx.length.target} ${ctx.length.unit}`;
    return Object.freeze(ctx.systemLines.filter((line) => !line.includes(marker)));
}

/**
 * 회차 분량 계약에서 **파생되는** 다른 단계의 출력 분량(요약 길이 등)을 정한다.
 *
 * 규칙:
 * - 단위는 언제나 작품 계약의 측정 단위다. 요약만 다른 측정 locale/단위를 새로
 *   발명하지 않는다(측정 정책은 계약이 이미 소유한다).
 * - 구형 `targetChars` 류 인자는 이름 그대로 `legacyCodeUnits` 목표로만 인정한다.
 *   계약 단위가 graphemes/words 인데 코드 단위 목표가 오면 조용히 재해석하지 않고
 *   충돌로 거부하고, 호출자가 같은 단위의 명시 목표를 주게 한다.
 * - 실제 세기(counter)는 여기서 하지 않는다. 2B(Grok) 소유다.
 *
 * @param {object} context
 * @param {{ length?: {unit:string,target:number}|null, legacyCodeUnitTarget?: number|null,
 *           defaultTarget: number, scope?: string }} input
 * @returns {{ unit: string, target: number, source: 'explicit'|'legacy'|'default' }}
 */
export function resolveDerivedLength(context, { length = null, legacyCodeUnitTarget = null, defaultTarget, scope = 'derived' } = {}) {
    const ctx = resolvePromptLanguageContext(context);
    const unit = ctx.length.unit;
    const assertTarget = (value) => {
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
            throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT, {
                scope,
                reason: 'target_not_positive_integer',
            });
        return value;
    };
    const hasLegacy = legacyCodeUnitTarget !== null && legacyCodeUnitTarget !== undefined;
    if (length !== null && length !== undefined) {
        if (length.unit !== unit)
            throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT, {
                scope,
                reason: 'derived_unit_differs_from_contract',
                length: { unit: length.unit ?? null, target: length.target ?? null },
                contract: { unit, target: ctx.length.target },
            });
        // 신규 목표와 구형 코드 단위 목표를 **동시에** 넘긴 경우. 앞선 값을 조용히
        // 쓰지 않는다 — 정확히 같은 코드 단위 목표일 때만 중복을 허용한다.
        if (hasLegacy && (unit !== 'legacyCodeUnits' || length.target !== legacyCodeUnitTarget))
            throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT, {
                scope,
                reason: 'derived_length_duplicate_disagrees',
                length: { unit: length.unit ?? null, target: length.target ?? null },
                legacy: { unit: 'legacyCodeUnits', target: legacyCodeUnitTarget },
                contract: { unit, target: ctx.length.target },
            });
        return Object.freeze({ unit, target: assertTarget(length.target), source: 'explicit' });
    }
    if (hasLegacy) {
        if (unit !== 'legacyCodeUnits')
            throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT, {
                scope,
                reason: 'legacy_code_unit_target_under_non_legacy_contract',
                legacy: { unit: 'legacyCodeUnits', target: legacyCodeUnitTarget },
                contract: { unit, target: ctx.length.target },
            });
        return Object.freeze({ unit, target: assertTarget(legacyCodeUnitTarget), source: 'legacy' });
    }
    return Object.freeze({ unit, target: assertTarget(defaultTarget), source: 'default' });
}

/**
 * ADR-0006 promptManifest 수집 전용 컨텍스트. 계열을 대표하는 언어만 정하고
 * `explicit:false` 라 언어 지시문(태그·목표 수치)이 붙지 않는다 — 캡처 결과가
 * 작품별 값 없이 **계열 정적 문자열**로 남는다. 생성 경로에서 쓰지 않는다.
 */
export function promptFamilyCaptureContext(family) {
    if (family !== PROMPT_FAMILY_KO && family !== PROMPT_FAMILY_MULTILINGUAL)
        throw new TypeError(`promptFamilyCaptureContext: unknown prompt family '${String(family)}'`);
    if (family === PROMPT_FAMILY_KO)
        return Object.freeze({ ...resolvePromptLanguageContext({}), capture: true });
    // 대표 언어로 계열만 고르고 지시문은 떼어 낸다 — 캡처 문자열에 특정 목표 언어
    // 태그나 작품별 분량 수치가 들어가지 않게 한다.
    const base = resolvePromptLanguageContext({ language: MULTILINGUAL_CAPTURE_LANGUAGE });
    return Object.freeze({ ...base, systemLines: Object.freeze([]), explicit: false, capture: true });
}

/**
 * 다국어 계열의 대표 언어. 목표 언어가 아니라 계열 라우팅용이며 캡처 결과에는
 * 태그가 남지 않는다(`explicit:false`).
 */
export const MULTILINGUAL_CAPTURE_LANGUAGE = 'en';
