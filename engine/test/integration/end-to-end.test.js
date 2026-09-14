/**
 * T3.7 — end-to-end integration test.
 *
 * Drives the full text-generator pipeline (book-create → 3 × chapter-write)
 * against a `FileStateStore` in a tmpdir and a scripted mock ProviderRegistry.
 * No real LLM traffic, no DB. The asserts target the load-bearing engine
 * invariants:
 *
 *   1. sanitize marker count = 0 — the committed `prose` must not contain the
 *      `⟦vle:…⟧` sentinel or other internal markers (`[review-note]` etc.)
 *   2. continuity gate passes on every chapter (no thrown ContinuityFailure
 *      and no CleanFailError on the happy path).
 *   3. round-trip via FileStateStore — Foundation + each StoryState + each
 *      ChapterArtifact load back identical-shape from disk.
 *
 * Plus a second test exercising the revise loop: a single continuity HARD
 * FAIL on the first commit attempt, then a passing JSON on the second; the
 * loop should commit on attempt 2 and log it.
 *
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '../_support/vitest-shim.mjs';
import { FileStateStore } from '../../src/core/state-store.js';
import { DefaultOutputSanitizer } from '../../src/core/output-sanitizer.js';
import { performBookCreate } from '../../src/generators/text/steps/worldbuild.js';
import { performChapterWriteBounded } from '../../src/generators/text/chapter-write-with-revise.js';
import { buildMockRegistry } from './_mock-provider.js';
// ─── shared fixtures ────────────────────────────────────────────────────────
const WORK_ID = 'work-int-001';
function noopLogger() {
    return {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
    };
}
function capturingLogger() {
    const entries = [];
    const log = {
        info: (msg, meta) => entries.push({ level: 'info', msg, meta }),
        warn: (msg, meta) => entries.push({ level: 'warn', msg, meta }),
        error: (msg, meta) => entries.push({ level: 'error', msg, meta }),
        debug: (msg, meta) => entries.push({ level: 'debug', msg, meta }),
    };
    return { log, entries };
}
/**
 * Build a JobContext bound to the provided StateStore + ProviderRegistry.
 * `kind` is settable so book-create vs chapter-write contexts differ only
 * structurally — the rest of the surface is shared.
 */
function makeCtx(opts) {
    return {
        jobId: randomUUID(),
        workId: WORK_ID,
        kind: opts.kind,
        model: { provider: 'openai', modelId: 'mock-2026-05-20' },
        state: new FileStateStore(opts.rootDir),
        providers: opts.providers,
        sanitizer: new DefaultOutputSanitizer(),
        log: opts.log ?? noopLogger(),
    };
}
// ─── scripted LLM payloads ──────────────────────────────────────────────────
const WORLDBUILD_JSON = JSON.stringify({
    premise: '테스트 작품',
    worldFacts: [{ id: 'wf1', statement: '주인공은 회귀자다' }],
});
/**
 * Single-character cast — female 주인공 라이덴. Intentionally female so the
 * draft prose (which uses "그녀" + has no male honorifics) does NOT raise a
 * layer-1 lexicon violation. Keeping the cast at 1 also keeps the
 * `extractDelta` `unregisteredNamed` heuristic quiet (no other names appear).
 */
const CAST_JSON = JSON.stringify({
    characters: [
        {
            id: 'c1',
            canonicalName: '라이덴',
            aliases: [],
            registeredAtChapter: 1,
            intrinsic: {
                gender: 'female',
                ageBand: '20대초반',
                role: '주인공',
                coreAppearance: ['은발'],
            },
            mutable: { status: 'alive', knownFacts: [] },
            relationships: [],
        },
    ],
});
const CHAPTER_PLAN_JSON = JSON.stringify({ plan: '라이덴의 회귀 직후 첫 행동' });
/**
 * Draft body — prose + trailing cast-manifest sentinel. The prose
 * intentionally omits male honorifics ("도련님"/"형님"/"오라버니"…) so the
 * deterministic layer-1 lexicon scan does NOT fail against the female
 * intrinsic of c1. The trailing sentinel survives extractDelta then gets
 * stripped by sanitize before commit.
 */
const DRAFT_PROSE = '라이덴은 천천히 눈을 떴다. 다시 깨어난 그녀는 결심했다.';
const DRAFT_RAW = DRAFT_PROSE +
    '\n\n' +
    '⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":["라이덴"]}]}⟧';
const EXTRACT_DELTA_JSON = JSON.stringify({
    newAddressEntries: [],
    relationshipOps: [],
    hookChanges: [],
    mutableChanges: [],
    trackedEntityOps: [],
});
const CONTINUITY_PASS_JSON = JSON.stringify({
    intrinsicViolations: [],
    invariantViolations: [],
    unjustifiedMutable: [],
    lexiconAdditions: [],
});
const CONTINUITY_FAIL_JSON = JSON.stringify({
    intrinsicViolations: [{ characterId: 'c1', message: '테스트용 1회 fail' }],
    invariantViolations: [],
    unjustifiedMutable: [],
    lexiconAdditions: [],
});
/** Happy-path script: every chapter's mock LLM responses, repeated 3x. */
function happyScript() {
    return {
        worldbuild: [WORLDBUILD_JSON],
        castDesign: [CAST_JSON],
        chapterPlan: [CHAPTER_PLAN_JSON, CHAPTER_PLAN_JSON, CHAPTER_PLAN_JSON],
        draft: [DRAFT_RAW, DRAFT_RAW, DRAFT_RAW],
        extractDelta: [EXTRACT_DELTA_JSON, EXTRACT_DELTA_JSON, EXTRACT_DELTA_JSON],
        continuityCheck: [
            CONTINUITY_PASS_JSON,
            CONTINUITY_PASS_JSON,
            CONTINUITY_PASS_JSON,
        ],
    };
}
// ─── tests ──────────────────────────────────────────────────────────────────
describe('engine integration — end-to-end', () => {
    let rootDir;
    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'vle-engine-integ-'));
    });
    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true });
    });
    it('book-create + 3 chapter-write — sanitize marker = 0, continuity passes, round-trip via FileStateStore', async () => {
        const { registry: providers, calls } = buildMockRegistry(happyScript());
        // ─── a. book-create ─────────────────────────────────────────────────
        const bookCtx = makeCtx({ rootDir, providers, kind: 'book-create' });
        const { foundation } = await performBookCreate(bookCtx, {
            title: '테스트 작품',
            genre: 'noble-clan-regression',
            brief: '회귀 후 가문 재건',
            language: 'ko',
            targetChapters: 3,
            chapterWordCount: 1500,
        });
        expect(foundation.workId).toBe(WORK_ID);
        expect(foundation.genre).toBe('noble-clan-regression');
        expect(foundation.characters).toHaveLength(1);
        expect(foundation.characters[0]?.canonicalName).toBe('라이덴');
        expect(foundation.characters[0]?.intrinsic.gender).toBe('female');
        // ─── b. persist foundation so chapter-write can load it ─────────────
        await bookCtx.state.saveFoundation(foundation);
        // ─── c. write 3 chapters ────────────────────────────────────────────
        for (let n = 1; n <= 3; n = (n + 1)) {
            const ctx = makeCtx({ rootDir, providers, kind: 'chapter-write' });
            const { artifact } = await performChapterWriteBounded(ctx, {
                chapterNumber: n,
            });
            // ── sanitize marker = 0 ─────────────────────────────────────────
            expect(artifact.prose).not.toContain('⟦vle:');
            expect(artifact.prose).not.toContain('⟧');
            expect(artifact.prose).not.toContain('[review-note]');
            expect(artifact.prose.length).toBeGreaterThan(0);
            // ── chapter number ──────────────────────────────────────────────
            expect(artifact.chapterNumber).toBe(n);
            // ── StoryState round-trip — load by chapter back from disk ──────
            const reloaded = await ctx.state.loadStoryState(WORK_ID, n);
            expect(reloaded).not.toBeNull();
            expect(reloaded?.chapterNumber).toBe(n);
        }
        // ─── d. final asserts ───────────────────────────────────────────────
        const verifier = new FileStateStore(rootDir);
        // All 3 artifacts persisted with clean prose.
        for (const n of [1, 2, 3]) {
            const art = await verifier.loadArtifact(WORK_ID, n);
            expect(art).not.toBeNull();
            expect(art.chapterNumber).toBe(n);
            expect(art.prose).not.toContain('⟦vle:');
            expect(art.prose).not.toContain('[review-note]');
            expect(art.prose.length).toBeGreaterThan(0);
        }
        // StoryState(3) loadable.
        const ss3 = await verifier.loadStoryState(WORK_ID, 3);
        expect(ss3).not.toBeNull();
        expect(ss3?.chapterNumber).toBe(3);
        // Foundation still has 1 character (no new registrations with this mock).
        const reloadedFoundation = await verifier.loadFoundation(WORK_ID);
        expect(reloadedFoundation).not.toBeNull();
        expect(reloadedFoundation?.characters).toHaveLength(1);
        expect(reloadedFoundation?.characters[0]?.canonicalName).toBe('라이덴');
        // Call-shape sanity — one worldbuild + one castDesign for book-create,
        // and per-chapter (plan + draft + extractDelta + continuityCheck) × 3.
        const countOf = (kind) => calls.filter((c) => c.kind === kind).length;
        expect(countOf('worldbuild')).toBe(1);
        expect(countOf('castDesign')).toBe(1);
        expect(countOf('chapterPlan')).toBe(3);
        expect(countOf('draft')).toBe(3);
        expect(countOf('extractDelta')).toBe(3);
        expect(countOf('continuityCheck')).toBe(3);
        // No revise calls on the happy path.
        expect(countOf('revise')).toBe(0);
    });
    it('revise loop sanity — continuity fails on attempt 1, passes on attempt 2 → committed with attempt=2 logged', async () => {
        // Script: first continuityCheck = FAIL, second = PASS. The revise step
        // returns the original draft prose unchanged (sentinel preserved); the
        // next commitPhase iteration re-runs extractDelta + continuityCheck →
        // PASS. extractDelta is called once per commit attempt (= 2 total).
        const script = {
            // book-create not exercised by this test.
            chapterPlan: [CHAPTER_PLAN_JSON],
            draft: [DRAFT_RAW],
            extractDelta: [EXTRACT_DELTA_JSON, EXTRACT_DELTA_JSON],
            continuityCheck: [CONTINUITY_FAIL_JSON, CONTINUITY_PASS_JSON],
            // revise returns the same prose unchanged (sentinel preserved). Layer-1
            // lexicon scan won't fail it (no male honorifics + female c1), and the
            // second scripted continuityCheck JSON now passes.
            revise: [DRAFT_RAW],
        };
        const { registry: providers, calls } = buildMockRegistry(script);
        const { log, entries } = capturingLogger();
        // Seed foundation directly — this test focuses on the revise loop, not
        // book-create.
        const state = new FileStateStore(rootDir);
        await state.saveFoundation({
            workId: WORK_ID,
            genre: 'noble-clan-regression',
            worldFacts: [],
            characters: [
                {
                    id: 'c1',
                    canonicalName: '라이덴',
                    aliases: [],
                    registeredAtChapter: 1,
                    intrinsic: {
                        gender: 'female',
                        ageBand: '20대초반',
                        role: '주인공',
                        coreAppearance: ['은발'],
                    },
                    mutable: { status: 'alive', knownFacts: [] },
                    relationships: [],
                },
            ],
            intrinsicChanges: [],
            // genreProfile pulled from registry — needed because reduceStoryState +
            // continuityCheck read invariants off it. Lazy-loading via the registry
            // keeps this test independent of the static profile shape.
            genreProfile: (await import('../../src/continuity/genre-profile.js'))
                .createGenreProfileRegistry()
                .get('noble-clan-regression'),
        });
        const ctx = makeCtx({ rootDir, providers, kind: 'chapter-write', log });
        const { artifact } = await performChapterWriteBounded(ctx, {
            chapterNumber: 1,
        });
        // Committed despite the first-attempt continuity fail.
        expect(artifact.chapterNumber).toBe(1);
        expect(artifact.prose).not.toContain('⟦vle:');
        expect(artifact.prose).not.toContain('[review-note]');
        // Revise invoked exactly once (between attempt 1 and attempt 2).
        expect(calls.filter((c) => c.kind === 'revise')).toHaveLength(1);
        // continuityCheck called twice (one per commit attempt).
        expect(calls.filter((c) => c.kind === 'continuityCheck')).toHaveLength(2);
        // draft / chapterPlan still once each — bounded loop does NOT redraft.
        expect(calls.filter((c) => c.kind === 'draft')).toHaveLength(1);
        expect(calls.filter((c) => c.kind === 'chapterPlan')).toHaveLength(1);
        // Telemetry: `chapter-write-bounded:passed` with attempt=2.
        const passed = entries.find((e) => e.level === 'info' && e.msg === 'chapter-write-bounded:passed');
        expect(passed).toBeDefined();
        expect(passed.meta?.attempt).toBe(2);
    });
});
