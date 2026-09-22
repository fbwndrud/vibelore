/**
 * Tests for the ChapterWrite composer (T3.3).
 *
 * Drives the pipeline with a scripted ProviderRegistry (chapterPlan → draft →
 * extractDelta → continuityCheck) and a `FileStateStore` rooted in a tmp dir,
 * so the assertion surface is "what gets persisted" rather than "what the
 * mock recorded". Continuity gating is exercised via the LLM stub that
 * fabricates `intrinsicViolations` to force HARD FAIL.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '../_support/vitest-shim.mjs';
import { FileStateStore } from '../../src/core/state-store.js';
import { DefaultOutputSanitizer } from '../../src/core/output-sanitizer.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { emptyStoryState } from '../../src/continuity/story-state.js';
import { performChapterWrite, ContinuityFailure, SanitizeLeakError, } from '../../src/generators/text/steps/chapter-write.js';
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
        workId: 'work-cw',
        genre: 'action',
        worldFacts: [],
        characters: [maleChar('c1', '서준')],
        intrinsicChanges: [],
        genreProfile: registry.get('action'),
    };
}
function stubRegistry(replies) {
    const calls = [];
    const reg = {
        register: () => undefined,
        has: () => true,
        async complete(req) {
            calls.push(req);
            const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
            let text = '{}';
            if (sys.includes('회차 기획자'))
                text = replies.plan ?? '{"plan":"이번 회차는 평범했다."}';
            else if (sys.includes('한국어 웹소설 작가'))
                text = replies.draft ?? '';
            else if (sys.includes('연속성 분석기'))
                text = replies.extractDelta ?? '{}';
            else if (sys.includes('연속성 검수기'))
                text = replies.continuityCheck ?? '{}';
            return { text, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
        },
    };
    return reg;
}
async function makeCtx(opts) {
    const workId = opts.workId ?? 'work-cw';
    const ctx = {
        jobId: 'job-cw',
        workId,
        kind: 'chapter-write',
        model: { provider: 'openai', modelId: 'mock-2026-05-20' },
        state: new FileStateStore(opts.rootDir),
        providers: opts.providers,
        sanitizer: new DefaultOutputSanitizer(),
        log: noopLogger(),
    };
    return ctx;
}
const GOOD_DRAFT_PROSE = '서준은 깊은 숨을 내쉬었다. 게이트 너머에서 익숙한 기운이 새어 나오고 있었다.\n' +
    '"드디어 시작이군." 그가 중얼거렸다.';
const GOOD_DRAFT_RAW = `${GOOD_DRAFT_PROSE}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧`;
// ─── tests ──────────────────────────────────────────────────────────────────
describe('performChapterWrite', () => {
    let rootDir;
    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'vle-chapter-write-'));
    });
    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true });
    });
    it('happy path: persists artifact + StoryState(N), strips sentinel, returns ChapterArtifact', async () => {
        const providers = stubRegistry({
            draft: GOOD_DRAFT_RAW,
            extractDelta: JSON.stringify({}),
            continuityCheck: JSON.stringify({}),
        });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        const { artifact } = await performChapterWrite(ctx, { chapterNumber: 1 });
        expect(artifact.workId).toBe('work-cw');
        expect(artifact.chapterNumber).toBe(1);
        expect(artifact.prose).toContain('서준은 깊은 숨을 내쉬었다.');
        expect(artifact.prose).not.toContain('⟦vle:');
        expect(artifact.prose).not.toContain('⟧');
        expect(artifact.delta.chapterNumber).toBe(1);
        expect(artifact.delta.appearedCharacterIds).toEqual(['c1']);
        // Persisted: StoryState(1) on disk
        const saved = await ctx.state.loadStoryState('work-cw', 1);
        expect(saved).not.toBeNull();
        expect(saved.chapterNumber).toBe(1);
        // Persisted: artifact retrievable
        const reread = await ctx.state.loadArtifact('work-cw', 1);
        expect(reread).not.toBeNull();
        expect(reread.prose).toBe(artifact.prose);
    });
    it('chapter 1 starts from emptyStoryState even without prior StoryState saved', async () => {
        const providers = stubRegistry({ draft: GOOD_DRAFT_RAW });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        // No prior StoryState saved. Chapter 1 should still succeed.
        const { artifact } = await performChapterWrite(ctx, { chapterNumber: 1 });
        expect(artifact.chapterNumber).toBe(1);
    });
    it('chapter > 1 with missing prevState falls back to emptyStoryState + warns', async () => {
        const providers = stubRegistry({
            draft: GOOD_DRAFT_RAW,
        });
        const warnings = [];
        const ctx = await makeCtx({ rootDir, providers });
        ctx.log = {
            ...noopLogger(),
            warn: (msg, meta) => warnings.push({ msg, meta }),
        };
        await ctx.state.saveFoundation(makeFoundation());
        // Crucially: do NOT save StoryState for chapter 2. Pipeline must not crash —
        // a fresh chapter 3 should still proceed from an empty state with a warning.
        // We must also pretend the chapter has not been written; reduceStoryState
        // enforces chapter strictly > prev, and empty state's prev=0 satisfies this.
        const draftRaw = `${GOOD_DRAFT_PROSE}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧`;
        const stub2 = stubRegistry({ draft: draftRaw });
        ctx.providers = stub2;
        const { artifact } = await performChapterWrite(ctx, { chapterNumber: 3 });
        expect(artifact.chapterNumber).toBe(3);
        expect(warnings.find((w) => w.msg === 'chapter-write:prev-state-missing')).toBeDefined();
    });
    it('missing foundation → throws', async () => {
        const providers = stubRegistry({ draft: GOOD_DRAFT_RAW });
        const ctx = await makeCtx({ rootDir, providers });
        // No foundation saved.
        await expect(performChapterWrite(ctx, { chapterNumber: 1 })).rejects.toThrow(/foundation not found/);
    });
    it('continuityCheck HARD FAIL → throws ContinuityFailure carrying violations', async () => {
        const providers = stubRegistry({
            draft: GOOD_DRAFT_RAW,
            extractDelta: JSON.stringify({}),
            continuityCheck: JSON.stringify({
                intrinsicViolations: [
                    { characterId: 'c1', message: '서준의 성별 묘사가 Foundation 과 충돌' },
                ],
            }),
        });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        await expect(performChapterWrite(ctx, { chapterNumber: 1 })).rejects.toBeInstanceOf(ContinuityFailure);
        // No artifact or StoryState should have been persisted on failure.
        expect(await ctx.state.loadArtifact('work-cw', 1)).toBeNull();
        expect(await ctx.state.loadStoryState('work-cw', 1)).toBeNull();
    });
    it('ContinuityFailure carries the violation array for the revise loop', async () => {
        const providers = stubRegistry({
            draft: GOOD_DRAFT_RAW,
            continuityCheck: JSON.stringify({
                intrinsicViolations: [{ characterId: 'c1', message: '성별 충돌' }],
            }),
        });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        try {
            await performChapterWrite(ctx, { chapterNumber: 1 });
            throw new Error('expected ContinuityFailure');
        }
        catch (err) {
            expect(err).toBeInstanceOf(ContinuityFailure);
            const f = err;
            expect(f.violations.length).toBeGreaterThanOrEqual(1);
            expect(f.violations[0].severity).toBe('hard');
            expect(f.violations[0].code).toBe('INTRINSIC_VIOLATION');
        }
    });
    it('sanitize leak ([review-note] residue in prose) → throws SanitizeLeakError', async () => {
        const leakedRaw = '서준은 칼을 들었다. [review-note] 그리고 베었다.\n' +
            '⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧';
        const providers = stubRegistry({
            draft: leakedRaw,
            extractDelta: JSON.stringify({}),
            continuityCheck: JSON.stringify({}),
        });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        await expect(performChapterWrite(ctx, { chapterNumber: 1 })).rejects.toBeInstanceOf(SanitizeLeakError);
        // Persistence aborted before save.
        expect(await ctx.state.loadArtifact('work-cw', 1)).toBeNull();
    });
    it('chapter > 1 with prevState present → reduces from it and persists StoryState(N)', async () => {
        const providers = stubRegistry({
            draft: GOOD_DRAFT_RAW,
            extractDelta: JSON.stringify({
                newAddressEntries: [
                    { speakerId: 'c1', targetId: 'c1', term: '주군', register: 'subordinate' },
                ],
            }),
            continuityCheck: JSON.stringify({}),
        });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        // Pre-seed StoryState(1) so chapter 2 has a real predecessor.
        const prev = {
            ...emptyStoryState('work-cw'),
            chapterNumber: 1,
        };
        await ctx.state.saveStoryState(prev);
        const { artifact } = await performChapterWrite(ctx, { chapterNumber: 2 });
        expect(artifact.chapterNumber).toBe(2);
        expect(artifact.delta.newAddressEntries).toEqual([
            { speakerId: 'c1', targetId: 'c1', term: '주군', register: 'subordinate' },
        ]);
        const saved = await ctx.state.loadStoryState('work-cw', 2);
        expect(saved).not.toBeNull();
        expect(saved.chapterNumber).toBe(2);
        expect(saved.addressMap.entries['c1->c1']).toEqual({
            term: '주군',
            register: 'subordinate',
            sinceChapter: 2,
        });
    });
});
