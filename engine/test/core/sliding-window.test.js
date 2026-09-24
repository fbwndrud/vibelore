import { describe, expect, it, vi } from '../_support/vitest-shim.mjs';
import { approxTokens, buildSlidingWindow, renderSlidingWindow, } from '../../src/core/sliding-window.js';
function summary(n, text = `요약 ${n}`) {
    return {
        workId: 'w1',
        chapterNumber: n,
        summary: text,
        plotBeat: n % 5 === 0 ? 'climax' : null,
        sceneTags: ['전투'],
        povCharacter: 'c1',
    };
}
function buildStore(summaries) {
    return {
        loadFoundation: vi.fn(),
        saveFoundation: vi.fn(),
        loadStoryState: vi.fn(async () => null),
        saveStoryState: vi.fn(),
        loadArtifact: vi.fn(),
        saveArtifact: vi.fn(),
        loadJob: vi.fn(),
        saveJob: vi.fn(),
        saveChapterSummary: vi.fn(),
        loadRecentChapterSummaries: vi.fn(async (_w, before, limit) => {
            return summaries
                .filter((s) => s.chapterNumber < before)
                .sort((a, b) => b.chapterNumber - a.chapterNumber)
                .slice(0, limit);
        }),
    };
}
describe('approxTokens', () => {
    it('script-aware estimate — dense (Hangul) stays / 2, sparse (Latin) is / 4', () => {
        expect(approxTokens('')).toBe(1);
        expect(approxTokens('한국어')).toBe(2);
        expect(approxTokens('abcd')).toBe(1);
    });
});
describe('buildSlidingWindow', () => {
    it('chapter 1 → empty (no prior summaries, no prevState)', async () => {
        const state = buildStore([]);
        const w = await buildSlidingWindow({ workId: 'w1', currentChapter: 1, state });
        expect(w.recentSummaries).toEqual([]);
        expect(w.lastStoryState).toBeNull();
        expect(w.estimatedTokens).toBe(0);
        expect(state.loadRecentChapterSummaries).not.toHaveBeenCalled();
    });
    it('chapter 6 with 5 prior summaries → all kept under default budget', async () => {
        const summaries = [summary(1), summary(2), summary(3), summary(4), summary(5)];
        const state = buildStore(summaries);
        const w = await buildSlidingWindow({ workId: 'w1', currentChapter: 6, state });
        expect(w.recentSummaries).toHaveLength(5);
        // newest-first
        expect(w.recentSummaries[0].chapterNumber).toBe(5);
        expect(w.recentSummaries[4].chapterNumber).toBe(1);
        expect(w.trimmedCount).toBe(0);
    });
    it('budget trims oldest summaries first', async () => {
        const big = 'x'.repeat(800); // approxTokens ~200 (Latin is sparse-script, / 4)
        const summaries = [
            summary(1, big),
            summary(2, big),
            summary(3, big),
            summary(4, big),
            summary(5, big),
        ];
        const state = buildStore(summaries);
        const w = await buildSlidingWindow({
            workId: 'w1',
            currentChapter: 6,
            state,
            tokenBudget: 1000, // ~2.5 summaries
        });
        expect(w.recentSummaries.length).toBeLessThan(5);
        expect(w.trimmedCount).toBeGreaterThan(0);
        // newest-first preserved
        expect(w.recentSummaries[0].chapterNumber).toBe(5);
    });
    it('recentSummaryWindow override caps lookup', async () => {
        const summaries = Array.from({ length: 10 }, (_, i) => summary(i + 1));
        const state = buildStore(summaries);
        const w = await buildSlidingWindow({
            workId: 'w1',
            currentChapter: 11,
            state,
            recentSummaryWindow: 3,
        });
        expect(w.recentSummaries).toHaveLength(3);
        expect(w.recentSummaries.map((s) => s.chapterNumber)).toEqual([10, 9, 8]);
    });
    it('loadStoryState called for prev chapter only when currentChapter > 1', async () => {
        const state = buildStore([summary(1)]);
        await buildSlidingWindow({ workId: 'w1', currentChapter: 2, state });
        expect(state.loadStoryState).toHaveBeenCalledWith('w1', 1);
    });
});
describe('renderSlidingWindow', () => {
    it('empty window → noticeable placeholder', () => {
        const text = renderSlidingWindow({
            recentSummaries: [],
            lastStoryState: null,
            estimatedTokens: 0,
            tokenBudget: 12000,
            trimmedCount: 0,
        });
        expect(text).toMatch(/이전 화 요약 없음/);
    });
    it('renders summaries oldest-first with beat/tag markers', () => {
        const text = renderSlidingWindow({
            recentSummaries: [summary(3), summary(2), summary(1)],
            lastStoryState: null,
            estimatedTokens: 100,
            tokenBudget: 12000,
            trimmedCount: 0,
        });
        // oldest first
        const i1 = text.indexOf('화 1');
        const i3 = text.indexOf('화 3');
        expect(i1).toBeGreaterThan(-1);
        expect(i1).toBeLessThan(i3);
    });
    it('trimmedCount > 0 → note included', () => {
        const text = renderSlidingWindow({
            recentSummaries: [summary(1)],
            lastStoryState: null,
            estimatedTokens: 10,
            tokenBudget: 100,
            trimmedCount: 4,
        });
        expect(text).toMatch(/4 화 요약 생략/);
    });
});
