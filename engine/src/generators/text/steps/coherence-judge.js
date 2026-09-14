/**
 * ADR-0009 (issue #220) — Coherence judge.
 *
 * chapter prose 의 logical flow / continuity 평가. cheap model (jsonMode).
 * 0-100 score. fail-soft — LLM throw / malformed 시 null → caller 가 skip.
 */
const COHERENCE_JUDGE_SYSTEM = [
    '당신은 한국어 웹소설 회차 logical-coherence 평가자다.',
    '회차 본문 + 이번 화 plan + 직전 화 요약을 읽고 0-100 점 평가.',
    '평가 기준:',
    '- 본문이 plan 의 의도를 실현했는가',
    '- 직전 화에서 자연스럽게 이어지는가',
    '- 인물 행동 / 사건 흐름에 비약 / 모순이 없는가',
    '- 문단 간 연결이 매끄러운가',
    '출력은 코드 블록 없이 순수 JSON 한 개: { "score": <0-100>, "reason": "한 줄 한국어" }',
].join(' ');
function tryParse(raw) {
    const fenced = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();
    try {
        return JSON.parse(fenced);
    }
    catch {
        return null;
    }
}
export async function runCoherenceJudge(input) {
    const userPrompt = [
        `## 회차 ${input.chapterNumber} 본문`,
        input.prose,
        ``,
        input.plan ? `## 이번 화 plan\n${input.plan}` : '',
        input.prevSummary ? `## 직전 화 요약\n${input.prevSummary}` : '',
        ``,
        `위 본문을 0-100 점으로 평가. JSON 한 개 출력.`,
    ]
        .filter((s) => s.length > 0)
        .join('\n');
    const req = {
        model: input.judgeModel ?? input.writerModel,
        jsonMode: true,
        step: 'coherence-judge',
        messages: [
            { role: 'system', content: COHERENCE_JUDGE_SYSTEM },
            { role: 'user', content: userPrompt },
        ],
    };
    let text = '';
    try {
        const res = await input.providers.complete(req);
        text = res.text;
    }
    catch {
        return { score: null, reason: null };
    }
    const parsed = tryParse(text);
    if (!parsed || typeof parsed !== 'object')
        return { score: null, reason: null };
    const obj = parsed;
    const score = typeof obj.score === 'number' && obj.score >= 0 && obj.score <= 100
        ? Math.round(obj.score)
        : null;
    const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 200) : null;
    return { score, reason };
}
