/**
 * Context budgets (entity context, sliding window) are family-gated:
 *   - no promptFamily / 'ko' → the exact pre-0.4.0 flat `text.length / 2`
 *     estimate, so ko prompts stay byte-identical (same entities, same
 *     summaries, same `used ~Nt` headings);
 *   - 'multilingual' → script-aware tokenUnits(), so Latin text is no
 *     longer over-counted and over-trimmed.
 *
 * The ko golden numbers below were recorded at 52e5aee (before this change).
 */
import { describe, expect, it, vi } from '../_support/vitest-shim.mjs';
import { resolveEntityContext, renderEntityContext } from '../../src/core/entity-context.js';
import { buildSlidingWindow, renderSlidingWindow } from '../../src/core/sliding-window.js';
import { tokenUnits, budgetEstimator } from '../../src/core/token-units.js';

// Realistic mixed ko material: Hangul prose + ASCII ids + markdown + JSON.
// Non-Hangul characters outnumber Hangul here, which is exactly where
// tokenUnits() diverges from the legacy / 2 estimate.
const mixedKo = (n, seed) => {
    const u = `- (${seed}) 등대지기는 수리공이 도착하기 전에 널빤지를 세었다. "status": "active", "tags": ["harbor", "council"], see docs/notes.md. `;
    return u.repeat(Math.ceil(n / u.length)).slice(0, n);
};
const latin = (n, seed) => {
    const u = `(${seed}) The keeper counts planks before the repairman arrives; "status": "active". `;
    return u.repeat(Math.ceil(n / u.length)).slice(0, n);
};
/** Verbatim copy of the 52e5aee estimator (entity-context.js / sliding-window.js). */
const legacy = (text) => Math.ceil(text.length / 2);

const snaps = (text, name) => Array.from({ length: 12 }, (_, i) => ({
    entityId: `e${i}`, kind: 'location', canonicalName: `${name} ${i}`, aliases: [], status: 'active',
    attrs: { note: text(420, i), tier: 'S' },
}));
const allScene = (list) => ({ settings: list.map((s) => s.entityId), characters: [], items: [], antagonists: [], additionalRefs: [] });

function store(summaries) {
    return {
        loadStoryState: vi.fn(async () => null),
        loadRecentChapterSummaries: vi.fn(async (_w, before, limit) => summaries
            .filter((s) => s.chapterNumber < before)
            .sort((a, b) => b.chapterNumber - a.chapterNumber)
            .slice(0, limit)),
    };
}
const summaries = (text) => Array.from({ length: 7 }, (_, i) => ({ workId: 'w', chapterNumber: i + 1, summary: text(2400, i + 1), sceneTags: [], plotBeat: null }));

describe('token-units lives in engine', () => {
    it('budgetEstimator keeps the caller legacy estimator for ko and for no family', () => {
        expect(budgetEstimator(undefined, legacy)).toBe(legacy);
        expect(budgetEstimator(null, legacy)).toBe(legacy);
        expect(budgetEstimator('ko', legacy)).toBe(legacy);
        expect(budgetEstimator('multilingual', legacy)).toBe(tokenUnits);
    });
    it('rejects an unknown family instead of silently picking one', () => {
        expect(() => budgetEstimator('en', legacy)).toThrow();
    });
});

describe('resolveEntityContext — ko is byte-identical to 52e5aee', () => {
    const list = snaps(mixedKo, '항구 관문');
    for (const promptFamily of [undefined, 'ko']) {
        it(`promptFamily=${String(promptFamily)}: same entities, same used ~Nt, same render`, () => {
            const r = resolveEntityContext({ snapshots: list, scene: allScene(list), promptFamily });
            // golden values recorded at 52e5aee
            expect(r.injected.map((e) => e.entityId)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
            expect(r.estimatedTokens).toBe(1771);
            expect(r.trimmedCount).toBe(5);
            const expectedUsed = r.injected.reduce((sum, e) => sum + legacy(e.canonicalName) + legacy(JSON.stringify(e.attrs)) + 8, 0);
            expect(r.estimatedTokens).toBe(expectedUsed);
            const text = renderEntityContext(r);
            expect(text.split('\n')[0]).toBe('## 이번 화 무대 entity (7개, budget 2000t, used ~1771t)');
            expect(text.split('\n')[1]).toBe('(token budget 으로 5 개 생략)');
        });
    }
    it('the fixture is mixed enough that tokenUnits() would have changed ko', () => {
        const e = list[0];
        expect(tokenUnits(JSON.stringify(e.attrs))).toBeLessThan(legacy(JSON.stringify(e.attrs)));
    });
});

describe('resolveEntityContext — multilingual is script-aware', () => {
    const list = snaps(latin, 'Harbor Gate');
    it('the legacy estimate over-trims Latin entities', () => {
        const r = resolveEntityContext({ snapshots: list, scene: allScene(list) });
        expect(r.injected).toHaveLength(8);
        expect(r.trimmedCount).toBe(4);
    });
    it('an en work now fits every staged entity and reports tokenUnits cost', () => {
        const r = resolveEntityContext({ snapshots: list, scene: allScene(list), promptFamily: 'multilingual' });
        expect(r.injected).toHaveLength(12);
        expect(r.trimmedCount).toBe(0);
        const expectedUsed = r.injected.reduce((sum, e) => sum + tokenUnits(e.canonicalName) + tokenUnits(JSON.stringify(e.attrs)) + 8, 0);
        expect(r.estimatedTokens).toBe(expectedUsed);
    });
});

describe('buildSlidingWindow — ko is byte-identical to 52e5aee', () => {
    for (const promptFamily of [undefined, 'ko']) {
        it(`promptFamily=${String(promptFamily)}: same summaries kept, same heading`, async () => {
            const s = summaries(mixedKo);
            const w = await buildSlidingWindow({ workId: 'w', currentChapter: 8, state: store(s), tokenBudget: 3000, promptFamily });
            expect(w.recentSummaries.map((x) => x.chapterNumber)).toEqual([7, 6]);
            expect(w.estimatedTokens).toBe(2416);
            expect(w.estimatedTokens).toBe(w.recentSummaries.reduce((sum, x) => sum + legacy(x.summary) + 8, 0));
            expect(renderSlidingWindow(w).split('\n')[0]).toBe('## 최근 2 화 요약 (sliding window, budget 3000t, used ~2416t)');
        });
    }
});

describe('buildSlidingWindow — multilingual is script-aware', () => {
    it('an en work keeps more recent summaries under the same budget', async () => {
        const s = summaries(latin);
        const old = await buildSlidingWindow({ workId: 'w', currentChapter: 8, state: store(s), tokenBudget: 3000 });
        const now = await buildSlidingWindow({ workId: 'w', currentChapter: 8, state: store(s), tokenBudget: 3000, promptFamily: 'multilingual' });
        expect(old.recentSummaries).toHaveLength(2);
        expect(now.recentSummaries).toHaveLength(4);
        expect(now.estimatedTokens).toBe(now.recentSummaries.reduce((sum, x) => sum + tokenUnits(x.summary) + 8, 0));
    });
});
