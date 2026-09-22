/**
 * ADR-0001 (issue #215) — runChapterSummary step.
 *
 * commitPhase 끝에서 sanitize.clean prose 를 입력으로 cheap model 호출 →
 * 200-500자 한국어 summary + plotBeat + sceneTags + povCharacter. JSON mode.
 *
 * fail-soft: LLM 호출이 throw 또는 parse 실패 시 fallback summary (prose 의
 * 첫 N글자 + meta empty) 반환. chapter commit 자체는 영향 0.
 */
const CHAPTER_SUMMARY_SYSTEM = [
    '당신은 한국어 웹소설 회차 요약 작가다.',
    '회차 본문을 읽고 다음 정보를 JSON 한 개로 출력한다.',
    '키:',
    '- summary: 200-500자 한 문단 한국어 요약. 핵심 사건 + 인물 변화 + 결말 분위기.',
    '- plotBeat: ["inciting", "rising", "climax", "falling", "denouement"] 중 하나 또는 null.',
    '- sceneTags: ["전투", "대화", "회상", "이동", "감정", "음모"] 등에서 0-3개 선택 (자유 단어 가능, 최대 5개).',
    '- povCharacter: 화자 캐릭터 ID (Foundation 에 등록된 c1, c2 식) 또는 null.',
    '본문 외 추론 금지. 출력은 코드 블록 없이 순수 JSON.',
].join(' ');
function fallbackSummary(prose, targetChars) {
    const trimmed = prose.replace(/\s+/g, ' ').trim();
    if (trimmed.length <= targetChars)
        return trimmed;
    return trimmed.slice(0, targetChars - 1) + '…';
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
function coerceResult(parsed, fallback) {
    if (parsed && typeof parsed === 'object') {
        const obj = parsed;
        const summary = typeof obj.summary === 'string' && obj.summary.length > 0 ? obj.summary : fallback;
        const plotBeat = typeof obj.plotBeat === 'string' ? obj.plotBeat : null;
        const sceneTags = Array.isArray(obj.sceneTags)
            ? obj.sceneTags.filter((t) => typeof t === 'string').slice(0, 5)
            : [];
        const povCharacter = typeof obj.povCharacter === 'string' ? obj.povCharacter : null;
        return { summary, plotBeat, sceneTags, povCharacter };
    }
    return { summary: fallback, plotBeat: null, sceneTags: [], povCharacter: null };
}
export async function runChapterSummary(input) {
    const target = input.targetChars ?? 400;
    const fallback = fallbackSummary(input.prose, target);
    const model = input.summaryModel ?? input.writerModel;
    const userPrompt = [
        `## 회차 ${input.chapterNumber} 본문`,
        input.prose,
        '',
        `위 본문을 ${target}자 내외로 요약하고 plotBeat / sceneTags / povCharacter 와 함께 JSON 한 개로 출력.`,
    ].join('\n');
    const req = {
        model,
        jsonMode: true,
        step: 'chapter-summary',
        messages: [
            { role: 'system', content: CHAPTER_SUMMARY_SYSTEM },
            { role: 'user', content: userPrompt },
        ],
    };
    let text = '';
    try {
        const res = await input.providers.complete(req);
        text = res.text;
    }
    catch {
        return { summary: fallback, plotBeat: null, sceneTags: [], povCharacter: null };
    }
    return coerceResult(tryParse(text), fallback);
}
