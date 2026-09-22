/**
 * Tests for `performChapterWriteBounded` — T3.4 bounded revise loop.
 *
 * Strategy: drive the pipeline with a scripted ProviderRegistry that
 * recognises each LLM call by system-prompt keyword and returns deterministic
 * payloads. A test-local call counter lets us flip continuityCheck from FAIL
 * → FAIL → PASS to verify both the recovery and exhaustion paths without
 * spawning real LLM traffic.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '../_support/vitest-shim.mjs';
import { FileStateStore } from '../../src/core/state-store.js';
import { DefaultOutputSanitizer } from '../../src/core/output-sanitizer.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { performChapterWriteBounded, CleanFailError, } from '../../src/generators/text/chapter-write-with-revise.js';
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
        workId: 'work-cwb',
        genre: 'action',
        worldFacts: [],
        characters: [maleChar('c1', '서준')],
        intrinsicChanges: [],
        genreProfile: registry.get('action'),
    };
}
const GOOD_DRAFT_PROSE = '서준은 깊은 숨을 내쉬었다. 게이트 너머에서 익숙한 기운이 새어 나오고 있었다.\n' +
    '"드디어 시작이군." 그가 중얼거렸다.';
const GOOD_DRAFT_RAW = `${GOOD_DRAFT_PROSE}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":[]}]}⟧`;
const REVISED_DRAFT_RAW = `${GOOD_DRAFT_PROSE}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":["주군"]}]}⟧`;
const LEAKED_DRAFT_RAW = '서준은 칼을 들었다. [review-note] 그리고 베었다.\n' +
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
            if (sys.includes('회차 기획자')) {
                kind = 'plan';
                text = '{"plan":"이번 회차는 평범했다."}';
            }
            else if (sys.includes('한국어 웹소설 작가')) {
                kind = 'draft';
                text = opts.draft ?? GOOD_DRAFT_RAW;
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
                text = opts.revise ?? REVISED_DRAFT_RAW;
            }
            calls.push({ kind, request: req });
            return { text, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
        },
    };
    return { registry: reg, calls };
}
async function makeCtx(opts) {
    const workId = opts.workId ?? 'work-cwb';
    return {
        jobId: 'job-cwb',
        workId,
        kind: 'chapter-write',
        model: { provider: 'openai', modelId: 'mock-2026-05-20' },
        state: new FileStateStore(opts.rootDir),
        providers: opts.providers,
        sanitizer: new DefaultOutputSanitizer(),
        log: opts.log ?? noopLogger(),
    };
}
// ─── tests ──────────────────────────────────────────────────────────────────
describe('performChapterWriteBounded', () => {
    let rootDir;
    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'vle-chapter-write-bounded-'));
    });
    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true });
    });
    it('happy path: commit passes on first attempt → no revise call, artifact persisted', async () => {
        const { registry: providers, calls } = stubRegistry({
            continuityCheckSequence: [{}], // PASS
        });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        const { artifact } = await performChapterWriteBounded(ctx, { chapterNumber: 1 });
        expect(artifact.chapterNumber).toBe(1);
        expect(artifact.prose).toContain('서준은 깊은 숨을 내쉬었다.');
        expect(artifact.prose).not.toContain('⟦vle:');
        // Plan + draft + extractDelta + continuityCheck = 4 calls. No revise.
        expect(calls.find((c) => c.kind === 'revise')).toBeUndefined();
        expect(calls.filter((c) => c.kind === 'continuityCheck')).toHaveLength(1);
        // Artifact persisted.
        const reread = await ctx.state.loadArtifact('work-cwb', 1);
        expect(reread).not.toBeNull();
    });
    it('fails twice then passes: revise called twice, third commit-phase succeeds', async () => {
        const { registry: providers, calls } = stubRegistry({
            continuityCheckSequence: [
                { intrinsicViolations: [{ characterId: 'c1', message: '성별 충돌 #1' }] },
                { intrinsicViolations: [{ characterId: 'c1', message: '성별 충돌 #2' }] },
                {}, // PASS on attempt 3
            ],
        });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        const { artifact } = await performChapterWriteBounded(ctx, { chapterNumber: 1 });
        expect(artifact.chapterNumber).toBe(1);
        // commit-phase invokes continuityCheck once per attempt = 3 total.
        expect(calls.filter((c) => c.kind === 'continuityCheck')).toHaveLength(3);
        // Revise invoked between attempts 1→2 and 2→3 = 2 calls.
        expect(calls.filter((c) => c.kind === 'revise')).toHaveLength(2);
        // Draft only once — bounded loop does not re-draft.
        expect(calls.filter((c) => c.kind === 'draft')).toHaveLength(1);
        expect(calls.filter((c) => c.kind === 'plan')).toHaveLength(1);
    });
    it('fails three times: throws CleanFailError with violations + attempts=3, no artifact persisted', async () => {
        const { registry: providers, calls } = stubRegistry({
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
            await performChapterWriteBounded(ctx, { chapterNumber: 1 });
        }
        catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(CleanFailError);
        const cf = caught;
        expect(cf.code).toBe('CLEAN_FAIL');
        expect(cf.attempts).toBe(3);
        expect(cf.violations.length).toBeGreaterThan(0);
        expect(cf.violations[0].code).toBe('INTRINSIC_VIOLATION');
        // commit-phase attempted 3 times.
        expect(calls.filter((c) => c.kind === 'continuityCheck')).toHaveLength(3);
        // Revise invoked between attempts 1→2 and 2→3 only (NOT after the final
        // failure — the loop short-circuits on the last attempt).
        expect(calls.filter((c) => c.kind === 'revise')).toHaveLength(2);
        // No artifact / StoryState persisted on clean-fail.
        expect(await ctx.state.loadArtifact('work-cwb', 1)).toBeNull();
        expect(await ctx.state.loadStoryState('work-cwb', 1)).toBeNull();
    });
    it('SanitizeLeakError: immediate CleanFailError, NO revise attempted', async () => {
        const { registry: providers, calls } = stubRegistry({
            draft: LEAKED_DRAFT_RAW,
            continuityCheckSequence: [{}], // PASS — so leak is the only failure mode
        });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        let caught;
        try {
            await performChapterWriteBounded(ctx, { chapterNumber: 1 });
        }
        catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(CleanFailError);
        const cf = caught;
        expect(cf.attempts).toBe(1);
        expect(cf.violations).toHaveLength(1);
        expect(cf.violations[0].code).toBe('SANITIZE_LEAK');
        expect(calls.find((c) => c.kind === 'revise')).toBeUndefined();
    });
    it('custom maxAttempts=1: fails immediately on first failure with attempts=1', async () => {
        const { registry: providers, calls } = stubRegistry({
            continuityCheckSequence: [
                { intrinsicViolations: [{ characterId: 'c1', message: '성별 충돌' }] },
            ],
        });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        let caught;
        try {
            await performChapterWriteBounded(ctx, { chapterNumber: 1 }, { maxAttempts: 1 });
        }
        catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(CleanFailError);
        expect(caught.attempts).toBe(1);
        expect(calls.filter((c) => c.kind === 'continuityCheck')).toHaveLength(1);
        expect(calls.find((c) => c.kind === 'revise')).toBeUndefined();
    });
    it('revise prompt is invoked with violations + original prose', async () => {
        const { registry: providers, calls } = stubRegistry({
            continuityCheckSequence: [
                { intrinsicViolations: [{ characterId: 'c1', message: '서준 성별 충돌' }] },
                {}, // PASS on attempt 2
            ],
        });
        const ctx = await makeCtx({ rootDir, providers });
        await ctx.state.saveFoundation(makeFoundation());
        await performChapterWriteBounded(ctx, { chapterNumber: 1 });
        const reviseCalls = calls.filter((c) => c.kind === 'revise');
        expect(reviseCalls).toHaveLength(1);
        const reviseUser = reviseCalls[0].request.messages.find((m) => m.role === 'user')?.content ?? '';
        // The user prompt embeds the violation message + original prose.
        expect(reviseUser).toContain('서준 성별 충돌');
        expect(reviseUser).toContain('서준은 깊은 숨을 내쉬었다.');
        // And references the cast-manifest sentinel (sentinel survives revise input).
        expect(reviseUser).toContain('cast-manifest');
    });
    it('logs attempt=N on success — telemetry hook', async () => {
        const infoLog = [];
        const log = {
            ...noopLogger(),
            info: (msg, meta) => infoLog.push({ msg, meta: meta }),
        };
        const { registry: providers } = stubRegistry({
            continuityCheckSequence: [
                { intrinsicViolations: [{ characterId: 'c1', message: 'x' }] },
                {},
            ],
        });
        const ctx = await makeCtx({ rootDir, providers, log });
        await ctx.state.saveFoundation(makeFoundation());
        await performChapterWriteBounded(ctx, { chapterNumber: 1 });
        const passed = infoLog.find((l) => l.msg === 'chapter-write-bounded:passed');
        expect(passed).toBeDefined();
        expect(passed.meta.attempt).toBe(2);
    });
});
