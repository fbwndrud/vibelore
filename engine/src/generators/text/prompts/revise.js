/**
 * Revise prompt — bounded partial rewrite to fix listed continuity violations.
 *
 * Used by T3.4's revise loop after continuityCheck flags hard violations. The
 * goal is **minimum-edit-distance** repair: we do NOT want the model to take
 * the opportunity to "improve" pacing, swap scene order, or reword unaffected
 * paragraphs. That would invalidate prevState assumptions and could cascade
 * violations elsewhere in the chapter.
 *
 * Each ReviseViolation references the offending span (paragraph anchor or
 * quote) plus the rule that broke. The model must touch only those spans and
 * the cast-manifest sentinel (which may need updating if a character is
 * added/removed from the chapter).
 *
 * 다국어 Phase 2A — 계열은 정확히 둘이다(ko / multilingual). 위반 ID·JSON 키·
 * sentinel 은 기계 계약이라 두 계열에서 동일하고, 분량 수정 계약은 **작품 계약의
 * 측정 단위**로만 말한다(코드 단위 수치를 문자군/단어 목표로 둔갑시키지 않는다).
 */
import { LANGUAGE_ERROR_CODES, LanguagePolicyError } from '../../../core/language-policy.js';
import {
    pickByFamily, promptFamilyCaptureContext, resolveDerivedLength, resolveDialogueBreakMode,
    resolveStepPromptLanguage,
} from '../../../core/prompt-language.js';

/**
 * 문단·대사 배치 규칙 한 줄. 계열이 아니라 **포맷 정책**(`dialogueBreakMode`)이
 * 정한다. ko + `strict` 는 기존 문구 그대로라 구형 프롬프트가 변하지 않는다.
 */
const REVISE_PARAGRAPH_RULE_KO = Object.freeze({
    strict: '7) 문단 경계의 빈 줄을 일반 줄바꿈으로 바꾸지 않는다. 일반 산문 문단 내부 문장은 공백으로 잇고, 서로 다른 문단과 독립 대사 앞뒤에는 빈 줄을 둔다.',
    relaxed: '7) 문단 경계의 빈 줄을 일반 줄바꿈으로 바꾸지 않는다. 대사는 서술 문단 안에 놓을 수 있지만 긴 서술 뒤에 파묻지 않는다.',
    natural: '7) 문단 경계의 빈 줄을 일반 줄바꿈으로 바꾸지 않는다. 대사와 문단의 배치는 목표 언어 산문 관습을 따르며, 수정이 필요한 장면 밖에서는 원문의 문단 구획을 그대로 둔다.',
});
const REVISE_PARAGRAPH_RULE_MULTILINGUAL = Object.freeze({
    strict: '7) Do not turn paragraph breaks into ordinary line breaks. Give each line of dialogue its own paragraph, and keep paragraphs short enough to read on a phone.',
    relaxed: '7) Do not turn paragraph breaks into ordinary line breaks. Dialogue may sit inside a narrative paragraph, but do not bury it at the end of a long stretch of narration.',
    natural: '7) Do not turn paragraph breaks into ordinary line breaks. Place dialogue and paragraphs by the prose conventions of the target language, and leave the original paragraph structure untouched outside the scenes you must repair.',
});

function reviseSystemLines(paragraphRule) {
    return [
        '당신은 한국어 웹소설 교정자이다.',
        '제공된 본문에서 명시된 위반 사항만 정확히 수정한다. 연속성 위반은 최소 수정하고, 독서 체험 위반은 해당 장면을 다시 설계할 수 있다.',
        '엄수 사항:',
        '1) 위반에 직접 관련된 장면만 고친다. 위반과 무관한 장면은 한 글자도 변경 금지. 단, QUALITY_GATE_LENGTH는 원문의 사건과 문단을 보존한 채 인과적 행동, 반응, 선택의 여파를 완전한 장면 단위로 추가하는 확장 작업이다.',
        '2) 사건의 확정 결과와 정본은 보존한다. 단, STATIC_POWER·ON_THE_NOSE_DIALOGUE·CLEAN_CONFLICT_RESET·TELEGRAPHED_TURN·SCENE_THIN·PLAN_SHAPED_PROSE·QUALITY_GATE_READER_HOOK 위반은 해당 장면 안에서 행동 순서, 정보 공개 시점, 대사, 작은 선택과 대가를 재구성해 원인을 고친다.',
        '3) 캐릭터 intrinsic(gender·ageBand·role·coreAppearance) 충돌은 본문 묘사를 Foundation 사실에 맞추는 방향으로 수정 — Foundation 을 부정하지 말 것.',
        '4) 호칭 위반은 AddressMap / HonorificLexicon 함의를 따르도록 표현만 교체. 새 인물을 임의로 추가 금지.',
        '5) cast-manifest sentinel 은 본문 변경에 맞춰 갱신. 본문에서 등장이 사라지면 manifest 에서도 제거, 새로 등장하면 추가.',
        '6) QUALITY_GATE_LENGTH 수정에서는 기존 본문을 삭제·요약·압축하지 않는다. 위반에 명시된 recommendedChars 이상이 되도록 장면을 확장하고, 출력 직전 전체 본문 길이를 확인한다.',
        paragraphRule,
        '8) 출력은 수정된 전체 본문(순수 산문) + 빈 줄 1개 + cast-manifest sentinel 한 줄. 변경 로그·메타 설명 출력 금지.',
        'sentinel 예시: ⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":["선배"]}]}⟧',
    ].join(' ');
}

/**
 * 다국어 계열 교정 지시. ko 규칙의 번역이 아니라 같은 교정 원칙을 영어 지시로 쓴
 * 별도 계열이다. 위반 코드·JSON 키·sentinel 문법은 기계 계약이라 그대로 둔다.
 */
function reviseSystemLinesMultilingual(paragraphRule) {
    return [
        'You are a copy-editor for serial fiction written in the target work language.',
        'Repair only the violations listed for the chapter you are given. Continuity violations get the smallest possible edit; reading-experience violations allow you to redesign the affected scene.',
        'Rules:',
        '1) Touch only the scenes the violations point at. Leave every unrelated scene character-for-character identical. The one exception is QUALITY_GATE_LENGTH, which is an expansion task: keep the existing events and paragraphs and add causal action, reaction and the aftermath of choices as whole scenes.',
        '2) Preserve settled outcomes and canon. For STATIC_POWER, ON_THE_NOSE_DIALOGUE, CLEAN_CONFLICT_RESET, TELEGRAPHED_TURN, SCENE_THIN, PLAN_SHAPED_PROSE and QUALITY_GATE_READER_HOOK, fix the cause inside that scene by reordering action, moving when information is revealed, and rewriting dialogue, small choices and their costs. Keep the violation codes verbatim.',
        '3) When the prose contradicts a character intrinsic (gender, ageBand, role, coreAppearance), change the prose to match the Foundation — never contradict the Foundation.',
        '4) For address-term violations, replace only the wording so it follows the AddressMap and the address conventions of the target language. Do not invent new characters.',
        '5) Update the cast-manifest sentinel to match the edited prose: drop characters who no longer appear, add characters who now do.',
        '6) In a QUALITY_GATE_LENGTH repair, never delete, summarise or compress existing prose. Expand the scene until it reaches the repair target stated in the length section below, and check the total length before you output.',
        paragraphRule,
        '8) Output the full revised prose (plain prose only) + one blank line + the cast-manifest sentinel on one line. No change log, no meta commentary.',
        'Sentinel example: ⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":["senpai"]}]}⟧',
    ].join(' ');
}

/** 구형 상수 — ko + `strict` 계열 정적 표면. 값은 기존과 동일하다. */
export const REVISE_SYSTEM = reviseSystemLines(REVISE_PARAGRAPH_RULE_KO.strict);
/** 다국어 계열 정적 표면(비ko 기본 포맷 모드 = `natural`). */
export const REVISE_SYSTEM_MULTILINGUAL = reviseSystemLinesMultilingual(REVISE_PARAGRAPH_RULE_MULTILINGUAL.natural);

const REVISE_PATCH_SYSTEM_KO_TAIL = [
    '전체 원고를 다시 쓰지 말고, 번호가 붙은 원문 문단에 적용할 JSON 패치만 만든다.',
    '위반을 고치는 데 필요한 최소 문단만 replacement로 바꾸고, 새 장면이 꼭 필요할 때만 insertion을 사용한다.',
    '문단 번호, 사건 결과, 인물의 말투, 시점, 빈 문단으로 형성된 호흡을 보존한다.',
    '출력은 순수 JSON 하나뿐이며 설명이나 마크다운을 붙이지 않는다.',
];
export const REVISE_PATCH_SYSTEM = [
    '당신은 한국어 웹소설의 국소 교정자이다.',
    ...REVISE_PATCH_SYSTEM_KO_TAIL,
].join(' ');
export const REVISE_PATCH_SYSTEM_MULTILINGUAL = [
    'You are a local copy-editor for serial fiction written in the target work language.',
    'Do not rewrite the whole chapter. Produce only a JSON patch applied to the numbered source paragraphs.',
    'Replace the fewest paragraphs needed to fix the violations, and use an insertion only when a new scene is genuinely required.',
    'Preserve paragraph numbering, settled outcomes, each character\'s voice, the viewpoint, and the rhythm the blank lines create.',
    'Output exactly one pure JSON object, with no explanation and no markdown.',
].join(' ');

/**
 * 이번 호출에 쓸 revise system. 포맷 모드는 계약에 고정된 값 → 호출자가 승인해
 * 넘긴 값 → 계열 기본값(ko=strict / 비ko=natural) 순으로 정해진다.
 *
 * @param {object} context PromptLanguageContext 또는 `{workContract|language}` 옵션
 * @param {{ dialogueBreakMode?: string|null, patchMode?: boolean }} [options]
 */
export function reviseSystemFor(context, { dialogueBreakMode = null, patchMode = false } = {}) {
    const mode = resolveDialogueBreakMode(context, dialogueBreakMode);
    if (patchMode)
        return pickByFamily(context, {
            ko: REVISE_PATCH_SYSTEM,
            multilingual: REVISE_PATCH_SYSTEM_MULTILINGUAL,
        });
    return pickByFamily(context, {
        ko: () => reviseSystemLines(REVISE_PARAGRAPH_RULE_KO[mode]),
        multilingual: () => reviseSystemLinesMultilingual(REVISE_PARAGRAPH_RULE_MULTILINGUAL[mode]),
    });
}

/** ADR-0006 promptManifest 수집용 계열 정적 표면(계열 기본 포맷 모드). */
export function reviseSystemStatic(family) {
    return reviseSystemFor(promptFamilyCaptureContext(family));
}
export function revisePatchSystemStatic(family) {
    return reviseSystemFor(promptFamilyCaptureContext(family), { patchMode: true });
}

// ─── 분량 수정 계약 ─────────────────────────────────────────────────────────

const LENGTH_VIOLATION_CODE = 'QUALITY_GATE_LENGTH';
/** 구형 위반 필드는 이름 그대로 `legacyCodeUnits` 계측값으로만 인정한다. */
const LEGACY_COUNT_FIELDS = Object.freeze(['actualChars', 'minChars']);

function legacyCount(violation, field) {
    const value = violation?.[field];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 분량 수정 계약의 수치를 **작품 계약의 측정 단위**로 정리한다.
 *
 * - 계약 단위가 `legacyCodeUnits` 면 구형 `actualChars`/`minChars`/`recommendedChars`
 *   를 그대로 쓴다(기존 프롬프트 유지).
 * - 계약 단위가 graphemes/words 인데 구형 코드 단위 수치만 오면 조용히 재해석하지
 *   않고 `LENGTH_CONTRACT_CONFLICT` 로 거부한다. 코드 단위로 잰 값을 "단어 850개"
 *   라고 적으면 모델과 검사기가 서로 다른 것을 세게 된다.
 * - 계약 단위로 계측한 값은 `violation.lengthMeasurement`(`{unit, actual, min,
 *   recommended}`)로 온다. 단위가 계약과 다르면 역시 충돌이다.
 */
function lengthRepairContract(ctx, violation) {
    const unit = ctx.length.unit;
    const measured = violation?.lengthMeasurement ?? null;
    if (measured !== null && measured !== undefined) {
        if (typeof measured !== 'object' || Array.isArray(measured) || measured.unit !== unit)
            throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT, {
                scope: 'revise-length',
                reason: 'measurement_unit_differs_from_contract',
                measurement: { unit: measured?.unit ?? null },
                contract: { unit, target: ctx.length.target },
            });
        const goal = resolveDerivedLength(ctx, {
            length: typeof measured.recommended === 'number' ? { unit, target: measured.recommended } : null,
            defaultTarget: ctx.length.target,
            scope: 'revise-length',
        });
        return {
            unit,
            actual: typeof measured.actual === 'number' ? measured.actual : null,
            min: typeof measured.min === 'number' ? measured.min : null,
            goal,
        };
    }
    const legacyGoal = legacyCount(violation, 'recommendedChars') ?? legacyCount(violation, 'targetChars');
    const legacyCounts = LEGACY_COUNT_FIELDS.map((field) => legacyCount(violation, field));
    if (unit !== 'legacyCodeUnits' && legacyCounts.some((value) => value !== null))
        throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LENGTH_CONTRACT_CONFLICT, {
            scope: 'revise-length',
            reason: 'legacy_code_unit_measurement_under_non_legacy_contract',
            legacy: Object.fromEntries(LEGACY_COUNT_FIELDS.map((field, i) => [field, legacyCounts[i]])),
            contract: { unit, target: ctx.length.target },
        });
    // `legacyCodeUnitTarget` 경로가 계약 단위와의 충돌을 대신 판정한다.
    const goal = resolveDerivedLength(ctx, {
        legacyCodeUnitTarget: legacyGoal,
        defaultTarget: ctx.length.target,
        scope: 'revise-length',
    });
    return { unit, actual: legacyCounts[0], min: legacyCounts[1], goal };
}

const LENGTH_LABELS_KO = {
    heading: '## 분량 수정 계약',
    // 구형 legacyCodeUnits 는 기존 '자' 문구를 그대로 유지한다.
    actual: ({ unit, actual }, fallback) => unit === 'legacyCodeUnits'
        ? `현재 본문: ${actual ?? fallback}자`
        : `현재 본문: ${actual === null ? '(미계측)' : `${actual} ${unit}`}`,
    min: ({ unit, min }) => unit === 'legacyCodeUnits'
        ? `통과 하한: ${min ?? '위반 메시지 참조'}자`
        : `통과 하한: ${min === null ? '(위반 메시지 참조)' : `${min} ${unit}`}`,
    goal: ({ unit, goal }) => unit === 'legacyCodeUnits'
        ? `이번 수정 목표: ${goal.source === 'default' ? '통과 하한보다 충분히 길게' : goal.target}자 이상`
        : `이번 수정 목표: ${goal.target} ${unit} 이상`,
    guidance: '원문의 기존 사건·대사·문단을 삭제하거나 압축하지 말고, 선택의 준비·충돌·즉각적 여파를 완전한 장면으로 추가한다. 단순 묘사 반복이나 같은 정보의 재진술로 채우지 않는다.',
};
const LENGTH_LABELS_EN = {
    heading: '## Length repair contract',
    actual: ({ unit, actual }) => `Current prose: ${actual === null ? '(not measured)' : `${actual} ${unit}`}`,
    min: ({ unit, min }) => `Passing floor: ${min === null ? '(see the violation message)' : `${min} ${unit}`}`,
    goal: ({ unit, goal }) => `Repair target: at least ${goal.target} ${unit}`,
    guidance: 'Do not delete or compress the existing events, dialogue or paragraphs. Add the preparation for a choice, the collision and its immediate aftermath as complete scenes. Do not pad with repeated description or restatements of the same information.',
};

function lengthRepairSection(ctx, violations, originalProse) {
    const violation = violations.find((item) => item.code === LENGTH_VIOLATION_CODE);
    if (!violation)
        return [];
    const repair = lengthRepairContract(ctx, violation);
    const labels = pickByFamily(ctx, { ko: LENGTH_LABELS_KO, multilingual: LENGTH_LABELS_EN });
    return [
        labels.heading,
        labels.actual(repair, String(originalProse ?? '').length),
        labels.min(repair),
        labels.goal(repair),
        labels.guidance,
        ``,
    ];
}

// ─── user 프롬프트 ──────────────────────────────────────────────────────────

const PATCH_LABELS_KO = {
    chapterNumber: '## 회차 번호',
    violations: '## 위반 사항',
    style: '## 작품 문체 정본',
    foundation: '## Foundation 컨텍스트',
    limitHeading: '## 수정 한도',
    limit: (maxOperations, paragraphCount) => `replacement와 insertion을 합쳐 최대 ${maxOperations}개. 원문 문단은 총 ${paragraphCount}개다.`,
    lengthNote: 'QUALITY_GATE_LENGTH가 있으면 기존 문단을 유지하고 insertion으로 인과적 행동·반응·선택의 여파를 추가한다.',
    paragraphs: '## 번호가 붙은 원문 문단',
    manifest: '## 현재 cast-manifest',
    schema: '## 출력 JSON 스키마',
    schemaNote: (paragraphCount) => `replacements의 paragraph는 기존 문단 번호다. insertions의 afterParagraph는 0부터 ${paragraphCount}까지다.`,
    outputNote: '바꾸지 않는 원문은 출력하지 않는다. castManifest는 본문의 실제 등장 인물과 호칭만 반영한다.',
};
const PATCH_LABELS_EN = {
    chapterNumber: '## Chapter number',
    violations: '## Violations',
    style: '## Canonical style of this work',
    foundation: '## Foundation context',
    limitHeading: '## Edit budget',
    limit: (maxOperations, paragraphCount) => `At most ${maxOperations} operations, replacements and insertions combined. The source has ${paragraphCount} paragraphs.`,
    lengthNote: 'If QUALITY_GATE_LENGTH is listed, keep the existing paragraphs and add causal action, reaction and the aftermath of choices through insertions.',
    paragraphs: '## Numbered source paragraphs',
    manifest: '## Current cast-manifest',
    schema: '## Output JSON schema',
    schemaNote: (paragraphCount) => `paragraph in replacements is an existing paragraph number. afterParagraph in insertions ranges from 0 to ${paragraphCount}.`,
    outputNote: 'Do not echo paragraphs you leave unchanged. castManifest must reflect only the characters and address terms that actually appear in the prose.',
};

function styleSection(input, labels) {
    if (!input.styleContext)
        return [];
    return [
        labels.style,
        typeof input.styleContext === 'string' ? input.styleContext : JSON.stringify(input.styleContext, null, 2),
        ``,
    ];
}

export function buildRevisePatchUserPrompt(input) {
    const ctx = resolveStepPromptLanguage(input);
    const labels = pickByFamily(ctx, { ko: PATCH_LABELS_KO, multilingual: PATCH_LABELS_EN });
    const paragraphs = String(input.originalProse ?? '').replace(/\r\n/g, '\n').trim()
        .split(/\n\s*\n/).map((text, index) => ({ paragraph: index + 1, text: text.trim() })).filter((item) => item.text);
    return [
        labels.chapterNumber,
        String(input.chapterNumber),
        ``,
        labels.violations,
        JSON.stringify(input.violations, null, 2),
        ``,
        ...styleSection(input, labels),
        labels.foundation,
        JSON.stringify(input.foundationContext, null, 2),
        ``,
        labels.limitHeading,
        labels.limit(input.maxOperations, paragraphs.length),
        labels.lengthNote,
        ``,
        labels.paragraphs,
        JSON.stringify(paragraphs, null, 2),
        ``,
        labels.manifest,
        input.castManifestRaw || '{"cast":[]}',
        ``,
        labels.schema,
        // JSON 스키마 예시 문자열의 자리표시자만 계열을 따르고 키는 기계 계약이다.
        pickByFamily(ctx, {
            ko: '{"replacements":[{"paragraph":3,"text":"교체할 문단 전체"}],"insertions":[{"afterParagraph":3,"text":"추가할 한 개 이상의 문단"}],"castManifest":{"cast":[{"characterId":"c1","addressTermsUsed":["도련님"]}]}}',
            multilingual: '{"replacements":[{"paragraph":3,"text":"the full replacement paragraph"}],"insertions":[{"afterParagraph":3,"text":"one or more new paragraphs"}],"castManifest":{"cast":[{"characterId":"c1","addressTermsUsed":["young master"]}]}}',
        }),
        labels.schemaNote(paragraphs.length),
        labels.outputNote,
    ].join('\n');
}

const REVISE_LABELS_KO = {
    chapterNumber: '## 회차 번호',
    language: '## 언어',
    violations: '## 위반 사항 (이것과 관련된 장면만 수정)',
    style: '## 작품 문체 정본',
    foundation: '## Foundation 컨텍스트 (수정 시 일치시킬 정본)',
    original: '## 원본 본문',
    output: '## 출력',
    outputLines: [
        '수정된 전체 본문 + 빈 줄 1개 + 갱신된 inline cast-manifest sentinel 한 줄.',
        '위반 외 장면은 원본과 글자 단위로 동일해야 한다. 변경 설명을 추가하지 말 것.',
    ],
};
const REVISE_LABELS_EN = {
    chapterNumber: '## Chapter number',
    language: '## Target work language (BCP 47)',
    violations: '## Violations (repair only the scenes these point at)',
    style: '## Canonical style of this work',
    foundation: '## Foundation context (the canon your repair must match)',
    original: '## Original prose',
    output: '## Output',
    outputLines: [
        'The full revised prose + one blank line + the updated inline cast-manifest sentinel on one line.',
        'Every scene outside the violations must stay character-for-character identical to the original. Do not add an explanation of your changes.',
    ],
};

export function buildReviseUserPrompt(input) {
    const ctx = resolveStepPromptLanguage(input);
    const labels = pickByFamily(ctx, { ko: REVISE_LABELS_KO, multilingual: REVISE_LABELS_EN });
    return [
        labels.chapterNumber,
        String(input.chapterNumber),
        ``,
        labels.language,
        // 계약이 정한 태그를 적는다 — 자유 텍스트를 언어 지시문으로 보간하지 않는다.
        ctx.language,
        ``,
        labels.violations,
        JSON.stringify(input.violations, null, 2),
        ``,
        ...lengthRepairSection(ctx, input.violations, input.originalProse),
        ...styleSection(input, labels),
        labels.foundation,
        JSON.stringify(input.foundationContext, null, 2),
        ``,
        labels.original,
        input.originalProse,
        ``,
        labels.output,
        ...labels.outputLines,
    ].join('\n');
}
