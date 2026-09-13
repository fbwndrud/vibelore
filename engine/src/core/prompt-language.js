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
    resolveExistingWorkLanguage,
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
        assertRequestedFields(ctx.contract, { language, length, legacyLength });
        assertFoundationMatchesContext(ctx, foundation);
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

function foundationHasLanguageKey(foundation) {
    return ('language' in foundation) || ('workContract' in foundation);
}

/**
 * 기존 작품의 생애 단계 — 공유 `resolveExistingWorkLanguage` 가 판정한다.
 * 키가 없으면 암묵적 ko. 키가 있는데 값이 없으면 손상 상태다 — 다른 필드로
 * 채워 넣지 않는다(`language:null` + 유효한 계약도 `INVALID_LANGUAGE_TAG`).
 */
function assertExistingWorkLifecycle(foundation, requested) {
    if (foundation === null || foundation === undefined)
        return;
    if ('language' in foundation && (foundation.language === null || foundation.language === undefined))
        throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, {
            reason: 'missing_stored_language',
            scope: 'work',
        });
    if ('workContract' in foundation && (foundation.workContract === null || foundation.workContract === undefined))
        throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT, {
            scope: 'foundation',
            reason: 'not_a_language_contract',
        });
    const storedContract = foundation.workContract ?? null;
    const storedLanguage = foundation.language ?? null;
    resolveExistingWorkLanguage({
        requested,
        workLanguage: storedContract?.language ?? storedLanguage,
        workHasLanguageKey: foundationHasLanguageKey(foundation),
    });
}

/**
 * Foundation 안 workContract 와 최상위 language 가 서로 다르면, 요청이 한쪽과
 * 같아도 조용히 하나를 고르지 않는다.
 */
function assertStoredContractLanguage(foundation) {
    if (foundation === null || foundation === undefined || !('workContract' in foundation))
        return;
    const storedContract = foundation.workContract;
    if (!isLanguageContract(storedContract))
        throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.INVALID_LENGTH_CONTRACT, {
            scope: 'foundation',
            reason: 'not_a_language_contract',
        });
    if ('language' in foundation)
        resolvePromptLanguageContext({ workContract: storedContract, language: foundation.language });
}

function assertRequestedFields(contract, { language = null, length = null, legacyLength = null } = {}) {
    if ((language === null || language === undefined)
        && (length === null || length === undefined)
        && (legacyLength === null || legacyLength === undefined))
        return;
    resolvePromptLanguageContext({
        workContract: contract,
        ...(language === null || language === undefined ? {} : { language }),
        ...(length === null || length === undefined ? {} : { length }),
        ...(legacyLength === null || legacyLength === undefined ? {} : { legacyLength }),
    });
}

function assertStoredCanonicalFormat(ctx, foundation) {
    if (foundation === null || foundation === undefined || !('canonicalFormatVersion' in foundation))
        return;
    const stored = foundation.canonicalFormatVersion;
    if (stored === null || stored === undefined)
        throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.INVALID_FORMAT_VERSION, {
            scope: 'foundation',
            reason: 'missing_stored_format_version',
            stored: stored ?? null,
        });
    const actual = ctx.contract.formatPolicy?.canonicalFormatVersion ?? null;
    if (stored !== actual)
        conflict({
            scope: 'foundation',
            reason: 'canonical_format_version_differs',
            requested: actual,
            stored,
        });
}

/**
 * 이미 해석된 컨텍스트가 저장된 Foundation 과 같은 작품의 것인지 확인한다.
 *
 * `promptLanguage` 빠른 경로도 `resolveWorkPromptLanguage` 와 같은 생애 단계·
 * null 판정을 쓴다. 저장된 `workContract` 가 있으면 목표 수치만 다른 계약으로
 * 바꿔 비교하지 않는다 — 현재 실행 스냅샷은 플러그인 권한 경계가 골라 넘긴다.
 */
function assertFoundationMatchesContext(ctx, foundation) {
    if (foundation === null || foundation === undefined)
        return;
    assertExistingWorkLifecycle(foundation, [ctx.language]);
    assertStoredContractLanguage(foundation);
    const storedContract = foundation.workContract ?? null;
    const storedLanguage = foundation.language ?? null;
    if (storedContract !== null && storedContract !== undefined) {
        assertSameContract(storedContract, ctx.contract);
        assertSameLength(ctx, foundation.length ?? null, 'foundation');
        assertStoredCanonicalFormat(ctx, foundation);
        return;
    }
    if (storedLanguage !== null && storedLanguage !== undefined)
        resolvePromptLanguageContext({ workContract: ctx.contract, language: storedLanguage });
    assertSameLength(ctx, foundation.length ?? null, 'foundation');
    assertStoredCanonicalFormat(ctx, foundation);
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

/**
 * 작품 단위 프롬프트 언어 해석 — **저장된 Foundation 메타데이터가 원천**이다.
 *
 * 생성 시점에 언어를 정한 작품은 이후 집필 호출이 매번 언어를 다시 넘기지 않는다.
 * 그때 호출 인자가 비었다는 이유로 구형 ko 로 떨어지면 작품 언어가 조용히 바뀐다.
 * 그래서 순서는 다음과 같다:
 *
 *   1. `foundation.workContract` — 승인된 계약. 그대로 쓴다. 함께 온 분량 인자는
 *      단위와 목표를 모두 확인하며, 목표만 다른 값으로 바꾸지 않는다. 현재 실행
 *      계약이 다르면 플러그인 권한 경계가 그 스냅샷을 Foundation 으로 넘긴다.
 *   2. `foundation.language`(+`foundation.length`) — 저장된 언어로 계약을 조립한다.
 *      이 호출에 승인된 계약이 함께 왔다면 저장된 분량·정본 포맷과 맞는지 확인한다.
 *   3. 언어 메타데이터가 **아예 없는** 기존 작품 — 이미 선택된 **암묵적 ko** 다.
 *      "미선택" 이 아니므로 다른 언어를 요청하면 `WORK_LANGUAGE_IMMUTABLE` 이고,
 *      인자가 없으면 기존 동작(구형 ko 프롬프트) 그대로다.
 *
 * 작품의 생애 단계 판정은 공유 `resolveExistingWorkLanguage` 가 한다(이 모듈이 별도
 * 관례를 만들지 않는다). 키 자체가 없는 것과 `language:null` 은 다르다 — 후자는
 * 손상된 메타데이터이며 구형 fallback 이 아니다.
 *
 * Foundation 이 없는 신규 호출만 명시 언어·분량으로 새 계약을 조립한다.
 */
export function resolveWorkPromptLanguage(input = {}) {
    const {
        workContract = null, length = null, legacyLength = null, foundation = null,
    } = input ?? {};
    const { language = null } = input ?? {};
    if (foundation === null || foundation === undefined)
        return resolvePromptLanguageContext({ workContract, language, length, legacyLength });
    const storedContract = foundation.workContract ?? null;
    const storedLanguage = foundation.language ?? null;
    const storedLength = foundation.length ?? null;
    assertExistingWorkLifecycle(foundation, [language, workContract?.language ?? null]);
    assertStoredContractLanguage(foundation);

    if (storedContract !== null && storedContract !== undefined) {
        const ctx = resolvePromptLanguageContext({ workContract: storedContract });
        if (workContract !== null && workContract !== undefined)
            assertSameContract(ctx.contract, workContract);
        assertSameLength(ctx, storedLength, 'foundation');
        assertStoredCanonicalFormat(ctx, foundation);
        assertRequestedFields(ctx.contract, { language, length, legacyLength });
        return ctx;
    }
    if (storedLanguage !== null && storedLanguage !== undefined) {
        if (workContract !== null && workContract !== undefined) {
            const ctx = resolvePromptLanguageContext({
                workContract,
                language: storedLanguage,
                ...(length === null ? {} : { length }),
                ...(legacyLength === null ? {} : { legacyLength }),
            });
            assertSameLength(ctx, storedLength, 'foundation');
            assertStoredCanonicalFormat(ctx, foundation);
            if (language !== null)
                resolvePromptLanguageContext({ workContract: ctx.contract, language });
            return ctx;
        }
        // 계약 없이 `language` 만 저장한 작품. 저장된 분량·포맷 키가 있으면 그
        // 값이 제약이고, 없는 필드는 기본값을 만들어 강요하지 않는다.
        const formatKeyPresent = 'canonicalFormatVersion' in foundation;
        const ctx = resolvePromptLanguageContext({
            workContract: buildLanguageContract({
                language: storedLanguage,
                length,
                legacyLength,
                storedLength,
                ...(formatKeyPresent
                    ? {
                        storedCanonicalFormatVersion: foundation.canonicalFormatVersion,
                        storedFormatVersionKeyPresent: true,
                    }
                    : {}),
            }),
        });
        assertSameLength(ctx, storedLength, 'foundation');
        assertStoredCanonicalFormat(ctx, foundation);
        if (language !== null)
            resolvePromptLanguageContext({ workContract: ctx.contract, language });
        return ctx;
    }
    // 언어 메타데이터가 없는 구형 작품 — 호출자 인자대로(없으면 암묵적 ko).
    return resolvePromptLanguageContext({ workContract, language, length, legacyLength });
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
