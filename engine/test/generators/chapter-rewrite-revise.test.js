/**
 * Tests for `performChapterRewriteBounded` — EPIC #254 bounded rewrite loop.
 *
 * Mirrors chapter-write-revise.test.ts: a scripted ProviderRegistry recognises
 * each LLM call by system-prompt keyword. The rewrite path replaces the
 * plan+draft pair with a single `runRewrite` call, then reuses the shared
 * commit/revise loop.
 *
 * Covers:
 *   - happy path: rewrite passes commit on first attempt → artifact overwritten,
 *     sentinel stripped, no revise call.
 *   - bounded retry: continuity FAIL → revise → PASS.
 *   - exhaustion: CleanFailError, no artifact persisted.
 *   - prevState(N-1) is read but NOT mutated.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '../_support/vitest-shim.mjs';
import { FileStateStore } from '../../src/core/state-store.js';
import { DefaultOutputSanitizer } from '../../src/core/output-sanitizer.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { performChapterRewriteBounded } from '../../src/generators/text/chapter-rewrite-with-revise.js';
import { runRewrite } from '../../src/generators/text/steps/rewrite.js';
import { CleanFailError } from '../../src/generators/text/chapter-write-with-revise.js';
// ─── helpers ────────────────────────────────────────────────────────────────
function noopLogger() {
    return {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
    };
}
const registry = createGenreProfileRegistry();
function maleChar(id, name) {
    return {
        id,
        canonicalName: name,
        aliases: [],
        registeredAtChapter: 1,
        intrinsic: {
            gender: 'male',
            ageBand: '20대초반',
            role: '주인공',
            coreAppearance: ['흑발'],
        },
        mutable: { status: 'alive', knownFacts: [] },
        relationships: [],
    };
}
function makeFoundation() {
    return {
        workId: 'work-crb',
        genre: 'action',
        worldFacts: [],
        characters: [maleChar('c1', '서준')],
        intrinsicChanges: [],
        genreProfile: registry.get('action'),
    };
}
const ORIGINAL_PROSE = '서준은 문을 열었다. 어두운 복도가 길게 뻗어 있었다.';
const REWRITTEN_PROSE = '서준은 문을 거칠게 밀쳤다. 복도 끝에서 무언가 움직였다.\n' +
    '"누구야." 그가 낮게 내뱉었다.';
const REWRITE_RAW = `${REWRITTEN_PROSE}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧`;
const REVISED_RAW = `${REWRITTEN_PROSE}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":["주군"]}]}⟧`;
const LEAKED_RAW = '서준은 칼을 들었다. [review-note] 그리고 베었다.\n' +
    '⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧';
function stubRegistry(opts = {}) {
    const calls = [];
    const continuitySequence = opts.continuityCheckSequence ?? [{}];
    let continuityIdx = 0;
    const reg = {
        register: () => undefined,
        has: () => true,
        async complete(req) {
            const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
            let kind = 'unknown';
            let text = '{}';
            // Order matters: the rewrite system prompt also contains '한국어 웹소설 작가',
            // so classify the unique '다시쓰기 지시' marker FIRST.
            if (sys.includes('다시쓰기 지시')) {
                kind = 'rewrite';
                text = opts.rewrite ?? REWRITE_RAW;
            }
            else if (sys.includes('연속성 분석기')) {
                kind = 'extractDelta';
                text = '{}';
            }
            else if (sys.includes('연속성 검수기')) {
                kind = 'continuityCheck';
                const i = Math.min(continuityIdx, continuitySequence.length - 1);
                continuityIdx += 1;
                text = JSON.stringify(continuitySequence[i]);
            }
            else if (sys.includes('한국어 웹소설 교정자')) {
                kind = 'revise';
                text = opts.revise ?? REVISED_RAW;
            }
            calls.push({ kind, request: req });
            return { text, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
        },
    };
    return { registry: reg, calls };
}
async function makeCtx(opts) {
    return {
        jobId: 'job-crb',
        workId: 'work-crb',
        kind: 'chapter-rewrite',
        model: { provider: 'openai', modelId: 'mock-2026-05-20' },
        state: new FileStateStore(opts.rootDir),
        providers: opts.providers,
        sanitizer: new DefaultOutputSanitizer(),
        log: opts.log ?? noopLogger(),
    };
}
// ─── runRewrite unit ──────────────────────────────────────────────────────
describe('runRewrite', () => {
    it('emits prose + cast-manifest sentinel and forwards the intent into the prompt', async () => {
        const { registry: providers, calls } = stubRegistry();
        const { prose } = await runRewrite({
            previousProse: ORIGINAL_PROSE,
            intentSummary: '[Direction]\n갈등 강화',
            foundation: makeFoundation(),
            prevState: emptyStoryState('work-crb'),
            chapterNumber: 2,
            providers,
            model: { provider: 'openai', modelId: 'mock' },
        });
        expect(prose).toContain('⟦vle:cast-manifest');
        const rewriteCall = calls.find((c) => c.kind === 'rewrite');
        expect(rewriteCall).toBeDefined();
        const userPrompt = rewriteCall.request.messages.find((m) => m.role === 'user')?.content ?? '';
        expect(userPrompt).toContain('갈등 강화');
        expect(userPrompt).toContain(ORIGINAL_PROSE);
        expect(rewriteCall.request.step).toBe('rewrite');
    });
});
// ─── performChapterRewriteBounded ─────────────────────────────────────────
describe('performChapterRewriteBounded', () => {
    let rootDir;
    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'vle-chapter-rewrite-bounded-'));
    });
    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true });
    });
    it('happy path: commit passes on first attempt → artifact overwritten, no revise', async () => {
        const { registry: providers, calls } = stubRegistry({ continuityCheckSequence: [{}] });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        const { artifact } = await performChapterRewriteBounded(ctx, {
            chapterNumber: 1,
            previousProse: ORIGINAL_PROSE,
            intentSummary: '[Direction]\n갈등 강화',
        });
        expect(artifact.chapterNumber).toBe(1);
        expect(artifact.prose).toContain('서준은 문을 거칠게 밀쳤다.');
        expect(artifact.prose).not.toContain('⟦vle:');
        // No plan/draft calls at all — rewrite skips chapterPlan.
        expect(calls.filter((c) => c.kind === 'rewrite')).toHaveLength(1);
        expect(calls.find((c) => c.kind === 'revise')).toBeUndefined();
        expect(calls.filter((c) => c.kind === 'continuityCheck')).toHaveLength(1);
        const reread = await ctx.state.loadArtifact('work-crb', 1);
        expect(reread).not.toBeNull();
        expect(reread.prose).toContain('서준은 문을 거칠게 밀쳤다.');
    });
    it('fails once then passes: revise called once, second commit succeeds', async () => {
        const { registry: providers, calls } = stubRegistry({
            continuityCheckSequence: [
                { intrinsicViolations: [{ characterId: 'c1', message: '성별 충돌' }] },
                {}, // PASS on attempt 2
            ],
        });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        const { artifact } = await performChapterRewriteBounded(ctx, {
            chapterNumber: 1,
            previousProse: ORIGINAL_PROSE,
            intentSummary: '갈등 강화',
        });
        expect(artifact.chapterNumber).toBe(1);
        // rewrite runs once — bounded loop does not re-rewrite, it revises.
        expect(calls.filter((c) => c.kind === 'rewrite')).toHaveLength(1);
        expect(calls.filter((c) => c.kind === 'revise')).toHaveLength(1);
        expect(calls.filter((c) => c.kind === 'continuityCheck')).toHaveLength(2);
    });
    it('fails three times: CleanFailError, no artifact persisted', async () => {
        const { registry: providers } = stubRegistry({
            continuityCheckSequence: [
                { intrinsicViolations: [{ characterId: 'c1', message: '성별 #1' }] },
                { intrinsicViolations: [{ characterId: 'c1', message: '성별 #2' }] },
                { intrinsicViolations: [{ characterId: 'c1', message: '성별 #3' }] },
            ],
        });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        let caught;
        try {
            await performChapterRewriteBounded(ctx, {
                chapterNumber: 1,
                previousProse: ORIGINAL_PROSE,
                intentSummary: '갈등 강화',
            });
        }
        catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(CleanFailError);
        expect(caught.attempts).toBe(3);
        expect(await ctx.state.loadArtifact('work-crb', 1)).toBeNull();
    });
    it('SanitizeLeakError: immediate CleanFailError, no revise', async () => {
        const { registry: providers, calls } = stubRegistry({
            rewrite: LEAKED_RAW,
            continuityCheckSequence: [{}],
        });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        let caught;
        try {
            await performChapterRewriteBounded(ctx, {
                chapterNumber: 1,
                previousProse: ORIGINAL_PROSE,
                intentSummary: '갈등 강화',
            });
        }
        catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(CleanFailError);
        expect(caught.violations[0].code).toBe('SANITIZE_LEAK');
        expect(calls.find((c) => c.kind === 'revise')).toBeUndefined();
    });
    it('throws when foundation is missing', async () => {
        const { registry: providers } = stubRegistry();
        const ctx = await makeCtx({ rootDir, providers });
        // No saveFoundation.
        await expect(performChapterRewriteBounded(ctx, {
            chapterNumber: 1,
            previousProse: ORIGINAL_PROSE,
            intentSummary: '갈등 강화',
        })).rejects.toThrow(/foundation not found/);
    });
    it('does NOT mutate prevState (N-1) — only StoryState(N) is written', async () => {
        const { registry: providers } = stubRegistry({ continuityCheckSequence: [{}] });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        // Seed an N-1 (chapter 1) StoryState. We rewrite chapter 2, which reads
        // chapter-1 state as prevState. That state must survive untouched.
        const n1 = { ...emptyStoryState('work-crb'), chapterNumber: 1 };
        await ctx.state.saveStoryState(n1);
        await performChapterRewriteBounded(ctx, {
            chapterNumber: 2,
            previousProse: ORIGINAL_PROSE,
            intentSummary: '갈등 강화',
        });
        // N-1 (chapter 1) state unchanged.
        const rereadN1 = await ctx.state.loadStoryState('work-crb', 1);
        expect(rereadN1).not.toBeNull();
        expect(rereadN1.chapterNumber).toBe(1);
        // N (chapter 2) state newly written by commitPhase.
        const rereadN = await ctx.state.loadStoryState('work-crb', 2);
        expect(rereadN).not.toBeNull();
        expect(rereadN.chapterNumber).toBe(2);
    });
});
