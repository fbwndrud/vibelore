/**
 * ADR-0001 (issue #215) — sliding window context builder.
 *
 * 1000화 작품의 token 폭증 차단. 매 draft 호출 시 builder 가 다음 priority 로
 * context 묶음 생성:
 *   1. 최근 5화 ChapterSummary (newest-first; 항상 포함)
 *   2. 최근 commitPhase 직후 StoryState carry-forward (있으면)
 *   3. (확장 hook) mid-summary / arc-summary — 본 PR 미포함, 후속.
 *
 * Budget 초과 시 oldest 순으로 trim. token estimate = chars / 2 (한국어 근사).
 * 실 tokenizer 도입은 후속.
 *
 * 이 token 근사는 **분량 계약과 무관한 컨텍스트 예산**이다. 작품 분량 목표는
 * `language-policy` 의 `length` 계약과 측정 정책이 소유하며 둘을 섞지 않는다.
 */
import { pickByFamily } from './prompt-language.js';
/** 한국어 prose 의 거친 token 추정. 정확도 보단 ratio 비교용. */
export function approxTokens(text) {
    return Math.ceil(text.length / 2);
}
const DEFAULT_BUDGET = 12_000;
const DEFAULT_WINDOW = 5;
function envBudget() {
    const raw = process.env.WRITER_CONTEXT_TOKEN_BUDGET;
    if (!raw)
        return DEFAULT_BUDGET;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET;
}
export async function buildSlidingWindow(input) {
    const tokenBudget = input.tokenBudget ?? envBudget();
    const windowSize = Math.max(0, input.recentSummaryWindow ?? DEFAULT_WINDOW);
    const summaries = windowSize > 0 && input.currentChapter > 1
        ? await input.state.loadRecentChapterSummaries(input.workId, input.currentChapter, windowSize)
        : [];
    // ensure newest-first (loadRecentChapterSummaries contract).
    const sortedNewestFirst = [...summaries].sort((a, b) => b.chapterNumber - a.chapterNumber);
    const lastStoryState = input.currentChapter > 1
        ? await input.state.loadStoryState(input.workId, (input.currentChapter - 1))
        : null;
    // greedy newest-first fill.
    const kept = [];
    let usedTokens = 0;
    for (const s of sortedNewestFirst) {
        const t = approxTokens(s.summary) + 8; // small header overhead
        if (usedTokens + t > tokenBudget)
            break;
        kept.push(s);
        usedTokens += t;
    }
    const trimmedCount = sortedNewestFirst.length - kept.length;
    return {
        recentSummaries: kept,
        lastStoryState,
        estimatedTokens: usedTokens,
        tokenBudget,
        trimmedCount,
    };
}
/**
 * Render sliding window for prompt insertion. Stable format — draft.ts 가
 * buildUserPrompt 안에 그대로 삽입.
 *
 * `context` 는 선택 인자다(구형 호출 = ko 계열, byte-identical). 요약 본문
 * (`s.summary`)·sceneTags·plotBeat 는 작품 데이터/기계 값이라 계열과 무관하게
 * 그대로 싣고, 섹션 라벨과 fallback 문구만 계열별로 고른다.
 */
export function renderSlidingWindow(window, context) {
    const labels = context === undefined || context === null
        ? LABELS_KO
        : pickByFamily(context, { ko: LABELS_KO, multilingual: LABELS_EN });
    if (window.recentSummaries.length === 0) {
        return labels.empty;
    }
    // oldest-first 로 reverse 해 reader 가 시간 순서로 읽음.
    const ordered = [...window.recentSummaries].sort((a, b) => a.chapterNumber - b.chapterNumber);
    const lines = [];
    lines.push(labels.heading(ordered.length, window));
    if (window.trimmedCount > 0) {
        lines.push(labels.trimmed(window.trimmedCount));
    }
    for (const s of ordered) {
        const tags = s.sceneTags?.length ? ` [${s.sceneTags.join(',')}]` : '';
        const beat = s.plotBeat ? ` (beat=${s.plotBeat})` : '';
        lines.push(`${labels.entryPrefix}${s.chapterNumber}${beat}${tags}: ${s.summary}`);
    }
    return lines.join('\n');
}
const LABELS_KO = {
    empty: '(이전 화 요약 없음 — 1화 또는 신규 작품)',
    heading: (count, window) => `## 최근 ${count} 화 요약 (sliding window, budget ${window.tokenBudget}t, used ~${window.estimatedTokens}t)`,
    trimmed: (count) => `(token budget 으로 더 오래된 ${count} 화 요약 생략)`,
    entryPrefix: '- 화 ',
};
const LABELS_EN = {
    empty: '(No previous chapter summaries — first chapter or a new work.)',
    heading: (count, window) => `## Recent ${count} chapter summaries (sliding window, budget ${window.tokenBudget}t, used ~${window.estimatedTokens}t)`,
    trimmed: (count) => `(${count} older chapter summaries omitted for the context token budget.)`,
    entryPrefix: '- Chapter ',
};
