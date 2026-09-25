/**
 * ADR-0001 (issue #215) — runChapterSummary step.
 *
 * commitPhase 끝에서 sanitize.clean prose 를 입력으로 cheap model 호출 →
 * 200-500자 한국어 summary + plotBeat + sceneTags + povCharacter. JSON mode.
 *
 * fail-soft: LLM 호출이 throw 또는 parse 실패 시 fallback summary (prose 앞부분 +
 * meta empty) 반환. chapter commit 자체는 영향 0. 언어 계약이 명시된 호출은
 * `summaryStatus:'fallback'` + `fallbackReason` 로 그 사실을 밝히고, 계약 없는
 * 구형 호출은 기존 반환 shape 를 그대로 유지한다.
 */
import { truncateLength } from '../../../core/length-measure.js';
import { languageSystemLines, pickByFamily, promptFamilyCaptureContext, resolveDerivedLength, resolveStepPromptLanguage, } from '../../../core/prompt-language.js';
/**
 * 요약 분량의 기본 목표. **회차 분량과 다른 값**이며 단위는 작품 계약의 측정
 * 단위를 그대로 쓴다(`resolveDerivedLength`). 구형 ko 기본(3000 코드 단위 회차 →
 * 400 코드 단위 요약)의 비율을 그대로 옮긴 값이다.
 */
export const DEFAULT_SUMMARY_TARGET = 400;
export const CHAPTER_SUMMARY_SYSTEM = [
    '당신은 한국어 웹소설 회차 요약 작가다.',
    '회차 본문을 읽고 다음 정보를 JSON 한 개로 출력한다.',
    '키:',
    '- summary: 200-500자 한 문단 한국어 요약. 핵심 사건 + 인물 변화 + 결말 분위기.',
    '- plotBeat: ["inciting", "rising", "climax", "falling", "denouement"] 중 하나 또는 null.',
    '- sceneTags: ["전투", "대화", "회상", "이동", "감정", "음모"] 등에서 0-3개 선택 (자유 단어 가능, 최대 5개).',
    '- povCharacter: 화자 캐릭터 ID (Foundation 에 등록된 c1, c2 식) 또는 null.',
    '본문 외 추론 금지. 출력은 코드 블록 없이 순수 JSON.',
].join(' ');
/**
 * 다국어 계열 요약 지시. 요구 분량은 system 이 아니라 user 프롬프트가 계약 단위로
 * 말한다 — **회차 분량 목표는 요약 목표가 아니므로** 같은 프롬프트에 두 수치를
 * 나란히 싣지 않는다. plotBeat enum 과 JSON 키는 기계 계약이라 동일하다.
 */
export const CHAPTER_SUMMARY_SYSTEM_MULTILINGUAL = [
    'You summarise chapters of serial fiction.',
    'Read the chapter and output one JSON object with these keys.',
    'Keys:',
    '- summary: one paragraph in the target work language. Key events, what changed for the characters, and the mood it ends on.',
    '- plotBeat: one of ["inciting", "rising", "climax", "falling", "denouement"], or null. Keep the enum value verbatim.',
    '- sceneTags: 0-3 short tags in the target work language (free wording, at most 5).',
    '- povCharacter: the viewpoint character id as registered in the Foundation (c1, c2, …), or null.',
    'Infer nothing beyond the chapter text. Output pure JSON with no code fence.',
].join(' ');
/** ADR-0006 promptManifest 수집용 계열 정적 표면. */
export function chapterSummaryStatic(family) {
    return pickByFamily(promptFamilyCaptureContext(family), {
        ko: CHAPTER_SUMMARY_SYSTEM,
        multilingual: CHAPTER_SUMMARY_SYSTEM_MULTILINGUAL,
    });
}
/**
 * LLM 실패 시 본문 앞부분으로 만드는 fallback.
 *
 * 자르는 일은 전부 공유 `truncateLength`(`core/length-measure.js`)가 한다. 단위·
 * locale·segmenter 판정은 계약의 `measurementPolicy` 가 소유하므로 여기서 words /
 * graphemes / legacyCodeUnits 별 절단 규칙을 **다시 만들지 않는다**. 목표는 요약
 * 자신의 목표(`summaryLength.target`)이며 회차 분량 목표가 아니다.
 *
 * 측정 정책이 이 런타임에서 충실하지 않으면(`UNSUPPORTED_LENGTH_MEASUREMENT` 등)
 * 코드 단위 절단으로 몰래 대체하지 않고 자르지 않은 본문을 돌려준다 — 잘렸다는
 * 거짓 신호보다 안 잘린 사실이 낫고, 요약 실패는 회차 commit 을 막지 않는다.
 */
function fallbackSummary(prose, summaryLength, measurementPolicy) {
    const trimmed = String(prose ?? '').replace(/\s+/g, ' ').trim();
    if (trimmed.length === 0)
        return trimmed;
    try {
        return truncateLength(trimmed, measurementPolicy, summaryLength.target);
    }
    catch {
        return trimmed;
    }
}
/**
 * fallback 출처(2B/chunk3 결정). **계약이 명시된 호출에만** 덧붙이는 추가 필드이며
 * 구형(암묵적 ko) 호출의 반환 shape 은 그대로 둔다.
 *
 * 여기서 말하는 것은 "요약이 LLM 결과가 아니라 본문 앞부분"이라는 사실 하나뿐이다.
 * 단위·언어 검증을 통과했다는 주장은 하지 않는다 — 검증은 phase 3 게이트 소유다.
 */
export const SUMMARY_FALLBACK_REASONS = Object.freeze({
    PROVIDER_FAILURE: 'provider_failure',
    MALFORMED_RESULT: 'malformed_result',
});
function fallbackResult(fallback, reason, explicit) {
    const base = { summary: fallback, plotBeat: null, sceneTags: [], povCharacter: null };
    // 구형 호출은 기존 shape 그대로 — 새 키를 얻지 않는다.
    if (!explicit)
        return base;
    return { ...base, summaryStatus: 'fallback', fallbackReason: reason };
}
function tryParse(raw) {
    const fenced = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();
    try {
        return JSON.parse(fenced);
    }
    catch {
        return null;
    }
}
function coerceResult(parsed, fallback, explicit) {
    if (parsed && typeof parsed === 'object') {
        const obj = parsed;
        const plotBeat = typeof obj.plotBeat === 'string' ? obj.plotBeat : null;
        const sceneTags = Array.isArray(obj.sceneTags)
            ? obj.sceneTags.filter((t) => typeof t === 'string').slice(0, 5)
            : [];
        const povCharacter = typeof obj.povCharacter === 'string' ? obj.povCharacter : null;
        if (typeof obj.summary === 'string' && obj.summary.length > 0)
            return { summary: obj.summary, plotBeat, sceneTags, povCharacter };
        // 파싱은 됐지만 요약 문자열이 없다 — 본문 앞부분으로 대체된 사실을 밝힌다.
        // meta 필드는 모델이 준 값을 그대로 살린다(구형 동작과 동일).
        const base = { summary: fallback, plotBeat, sceneTags, povCharacter };
        return explicit
            ? { ...base, summaryStatus: 'fallback', fallbackReason: SUMMARY_FALLBACK_REASONS.MALFORMED_RESULT }
            : base;
    }
    return fallbackResult(fallback, SUMMARY_FALLBACK_REASONS.MALFORMED_RESULT, explicit);
}
export async function runChapterSummary(input) {
    const ctx = resolveStepPromptLanguage(input);
    // 요약 분량은 회차 분량이 아니다. 단위만 계약에서 물려받고 목표는 따로 정한다.
    // 구형 `targetChars` 는 이름 그대로 legacyCodeUnits 목표로만 인정한다.
    const summaryLength = resolveDerivedLength(ctx, {
        length: input.summaryLength ?? null,
        legacyCodeUnitTarget: input.targetChars ?? null,
        defaultTarget: DEFAULT_SUMMARY_TARGET,
        scope: 'chapter-summary',
    });
    // 절단 정책은 계약의 measurementPolicy 하나뿐이다 — 요약이 별도 측정 locale·
    // 단위를 새로 만들지 않는다(단위는 계약, 목표는 요약 자신).
    const fallback = fallbackSummary(input.prose, summaryLength, ctx.contract.measurementPolicy);
    const model = input.summaryModel ?? input.writerModel;
    const labels = pickByFamily(ctx, { ko: SUMMARY_LABELS_KO, multilingual: SUMMARY_LABELS_EN });
    const userPrompt = [
        labels.proseHeading(input.chapterNumber),
        input.prose,
        '',
        labels.request(summaryLength),
    ].join('\n');
    const systemPrompt = [
        pickByFamily(ctx, { ko: CHAPTER_SUMMARY_SYSTEM, multilingual: CHAPTER_SUMMARY_SYSTEM_MULTILINGUAL }),
        // 회차 분량 줄은 뺀다 — 요약 목표와 나란히 두면 서로 모순된 지시가 된다.
        ...languageSystemLines(ctx, { includeChapterLength: false }),
    ].join(' ');
    const req = {
        model,
        jsonMode: true,
        step: 'chapter-summary',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
    };
    let text = '';
    try {
        const res = await input.providers.complete(req);
        text = res.text;
    }
    catch {
        return fallbackResult(fallback, SUMMARY_FALLBACK_REASONS.PROVIDER_FAILURE, ctx.explicit);
    }
    return coerceResult(tryParse(text), fallback, ctx.explicit);
}
/**
 * 요구 분량은 계약의 측정 단위로 말한다. 구형 ko(legacyCodeUnits)는 기존 '자'
 * 문구를 그대로 써 프롬프트가 변하지 않는다.
 */
const SUMMARY_LABELS_KO = {
    proseHeading: (chapterNumber) => `## 회차 ${chapterNumber} 본문`,
    request: ({ unit, target }) => unit === 'legacyCodeUnits'
        ? `위 본문을 ${target}자 내외로 요약하고 plotBeat / sceneTags / povCharacter 와 함께 JSON 한 개로 출력.`
        : `위 본문을 ${target} ${unit} 내외로 요약하고 plotBeat / sceneTags / povCharacter 와 함께 JSON 한 개로 출력.`,
};
const SUMMARY_LABELS_EN = {
    proseHeading: (chapterNumber) => `## Chapter ${chapterNumber} text`,
    request: ({ unit, target }) => `Summarise the chapter above in about ${target} ${unit} of the target work language, and output it together with plotBeat / sceneTags / povCharacter as one JSON object.`,
};
