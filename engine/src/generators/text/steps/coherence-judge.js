/**
 * ADR-0009 (issue #220) — Coherence judge.
 *
 * chapter prose 의 logical flow / continuity 평가. cheap model (jsonMode).
 * 0-100 score. fail-soft — LLM throw / malformed 시 null → caller 가 skip.
 */
import { languageSystemLines, pickByFamily, promptFamilyCaptureContext, resolveStepPromptLanguage, } from '../../../core/prompt-language.js';
export const COHERENCE_JUDGE_SYSTEM = [
    '당신은 한국어 웹소설 회차 logical-coherence 평가자다.',
    '회차 본문 + 이번 화 plan + 직전 화 요약을 읽고 0-100 점 평가.',
    '평가 기준:',
    '- 본문이 plan 의 의도를 실현했는가',
    '- 직전 화에서 자연스럽게 이어지는가',
    '- 인물 행동 / 사건 흐름에 비약 / 모순이 없는가',
    '- 문단 간 연결이 매끄러운가',
    '출력은 코드 블록 없이 순수 JSON 한 개: { "score": <0-100>, "reason": "한 줄 한국어" }',
].join(' ');
/** 점수는 기계 값, `reason` 설명 값만 목표 작품 언어로 쓴다. */
export const COHERENCE_JUDGE_SYSTEM_MULTILINGUAL = [
    'You judge the logical coherence of a chapter of serial fiction.',
    'Read the chapter text, this chapter\'s plan and the previous chapter\'s summary, and score it from 0 to 100.',
    'Criteria:',
    '- does the chapter realise the intent of the plan',
    '- does it follow naturally from the previous chapter',
    '- are there leaps or contradictions in character action and event flow',
    '- do the paragraphs connect smoothly',
    'Output one pure JSON object with no code fence: { "score": <0-100>, "reason": "one line in the target work language" }',
].join(' ');
/** ADR-0006 promptManifest 수집용 계열 정적 표면. */
export function coherenceJudgeStatic(family) {
    return pickByFamily(promptFamilyCaptureContext(family), {
        ko: COHERENCE_JUDGE_SYSTEM,
        multilingual: COHERENCE_JUDGE_SYSTEM_MULTILINGUAL,
    });
}
const JUDGE_LABELS_KO = {
    proseHeading: (n) => `## 회차 ${n} 본문`,
    plan: (plan) => `## 이번 화 plan\n${plan}`,
    prevSummary: (summary) => `## 직전 화 요약\n${summary}`,
    request: '위 본문을 0-100 점으로 평가. JSON 한 개 출력.',
};
const JUDGE_LABELS_EN = {
    proseHeading: (n) => `## Chapter ${n} text`,
    plan: (plan) => `## Plan for this chapter\n${plan}`,
    prevSummary: (summary) => `## Previous chapter summary\n${summary}`,
    request: 'Score the chapter above from 0 to 100. Output one JSON object.',
};
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
    const ctx = resolveStepPromptLanguage(input);
    const labels = pickByFamily(ctx, { ko: JUDGE_LABELS_KO, multilingual: JUDGE_LABELS_EN });
    const userPrompt = [
        labels.proseHeading(input.chapterNumber),
        input.prose,
        ``,
        input.plan ? labels.plan(input.plan) : '',
        input.prevSummary ? labels.prevSummary(input.prevSummary) : '',
        ``,
        labels.request,
    ]
        .filter((s) => s.length > 0)
        .join('\n');
    const req = {
        model: input.judgeModel ?? input.writerModel,
        jsonMode: true,
        step: 'coherence-judge',
        messages: [
            {
                role: 'system',
                // 평가 출력에는 회차 분량 목표가 필요 없다 — 계약 지시문에서 뺀다.
                content: [
                    pickByFamily(ctx, { ko: COHERENCE_JUDGE_SYSTEM, multilingual: COHERENCE_JUDGE_SYSTEM_MULTILINGUAL }),
                    ...languageSystemLines(ctx, { includeChapterLength: false }),
                ].join(' '),
            },
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
