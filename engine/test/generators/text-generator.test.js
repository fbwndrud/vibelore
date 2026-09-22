/**
 * Tests for TextGenerator shell (T3.1).
 *
 * Verifies plan() returns the correct step labels, run() dispatches to the
 * injected sub-step mocks, and validate() applies the post-hoc sanity checks
 * documented in the engine design. Continuity gating is NOT exercised here —
 * that lives inside the chapter-write step (T3.3) and has its own test
 * surface.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { createFoundation } from '../../src/continuity/foundation.js';
import { TextGenerator, } from '../../src/generators/text/text-generator.js';
function noopLogger() {
    return {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
    };
}
function makeCtx() {
    return {
        jobId: 'job-text-test',
        log: noopLogger(),
    };
}
const registry = createGenreProfileRegistry();
function makeCharacter() {
    return {
        id: 'c1',
        canonicalName: '주인공',
        aliases: [],
        registeredAtChapter: 1,
        intrinsic: {
            gender: 'male',
            ageBand: '20대초반',
            birthOrder: '장남',
            role: '주인공',
            coreAppearance: ['은발'],
        },
        mutable: { status: 'alive', knownFacts: [] },
        relationships: [],
    };
}
function makeFoundationWithCast() {
    const base = createFoundation({
        workId: 'work-1',
        genre: 'action',
        genreProfile: registry.get('action'),
    });
    return { ...base, characters: [makeCharacter()] };
}
function makeArtifact(prose) {
    return {
        workId: 'work-1',
        chapterNumber: 1,
        prose,
        delta: {
            chapterNumber: 1,
            appearedCharacterIds: [],
            newAddressEntries: [],
            relationshipOps: [],
            hookChanges: [],
            mutableChanges: [],
            trackedEntityOps: [],
        },
    };
}
const BOOK_CREATE_INPUT = {
    kind: 'book-create',
    title: 'T',
    genre: 'action',
    language: 'ko',
    targetChapters: 10,
    chapterWordCount: 4000,
};
describe('TextGenerator.plan', () => {
    it('returns book-create plan with correct step labels', async () => {
        const gen = new TextGenerator();
        const plan = await gen.plan(makeCtx(), BOOK_CREATE_INPUT);
        expect(plan.kind).toBe('book-create');
        expect(plan.steps).toEqual([
            'worldbuild',
            'castDesign',
            'genreProfileBind',
            'foundationInit',
        ]);
        expect(plan.meta?.input).toEqual(BOOK_CREATE_INPUT);
    });
    it('returns chapter-write plan with correct step labels', async () => {
        const gen = new TextGenerator();
        const plan = await gen.plan(makeCtx(), { kind: 'chapter-write', chapterNumber: 3 });
        expect(plan.kind).toBe('chapter-write');
        expect(plan.steps).toEqual([
            'loadState',
            'chapterPlan',
            'draft',
            'registerCharacter',
            'lexiconScan',
            'extractDelta',
            'continuityCheck',
            'revise',
            'sanitize',
            'commitState',
        ]);
    });
    it('returns chapter-rewrite plan with correct step labels', async () => {
        const gen = new TextGenerator();
        const plan = await gen.plan(makeCtx(), { kind: 'chapter-rewrite', fromChapter: 5 });
        expect(plan.kind).toBe('chapter-rewrite');
        expect(plan.steps).toEqual(['loadState', 'rewriteFromChapter']);
    });
    it('default steps throw when invoked without injection', async () => {
        const gen = new TextGenerator();
        const plan = await gen.plan(makeCtx(), BOOK_CREATE_INPUT);
        await expect(gen.run(makeCtx(), plan)).rejects.toThrow(/T3\.2/);
    });
});
describe('TextGenerator.run', () => {
    it('book-create dispatches to steps.worldbuild and wraps result', async () => {
        const foundation = makeFoundationWithCast();
        const steps = {
            async worldbuild(_ctx, input) {
                expect(input.title).toBe('T');
                expect(input.genre).toBe('action');
                expect(input.targetChapters).toBe(10);
                return { foundation };
            },
            async writeChapter() {
                throw new Error('unexpected');
            },
            async rewriteFromChapter() {
                throw new Error('unexpected');
            },
        };
        const gen = new TextGenerator(steps);
        const plan = await gen.plan(makeCtx(), BOOK_CREATE_INPUT);
        const out = await gen.run(makeCtx(), plan);
        expect(out).toEqual({ kind: 'book-create', foundation });
    });
    it('chapter-write dispatches to steps.writeChapter and wraps result', async () => {
        const artifact = makeArtifact('once upon a time');
        const steps = {
            async worldbuild() {
                throw new Error('unexpected');
            },
            async writeChapter(_ctx, input) {
                expect(input.chapterNumber).toBe(7);
                return { artifact };
            },
            async rewriteFromChapter() {
                throw new Error('unexpected');
            },
        };
        const gen = new TextGenerator(steps);
        const plan = await gen.plan(makeCtx(), { kind: 'chapter-write', chapterNumber: 7 });
        const out = await gen.run(makeCtx(), plan);
        expect(out).toEqual({ kind: 'chapter-write', artifact });
    });
    it('chapter-rewrite dispatches to steps.rewriteFromChapter and wraps result', async () => {
        const artifacts = [makeArtifact('a'), makeArtifact('b')];
        const steps = {
            async worldbuild() {
                throw new Error('unexpected');
            },
            async writeChapter() {
                throw new Error('unexpected');
            },
            async rewriteFromChapter(_ctx, input) {
                expect(input.fromChapter).toBe(4);
                return { artifacts };
            },
        };
        const gen = new TextGenerator(steps);
        const plan = await gen.plan(makeCtx(), { kind: 'chapter-rewrite', fromChapter: 4 });
        const out = await gen.run(makeCtx(), plan);
        expect(out).toEqual({ kind: 'chapter-rewrite', artifacts });
    });
    it('throws on unknown plan kind', async () => {
        const gen = new TextGenerator();
        const bogus = {
            kind: 'something-else',
            steps: [],
            meta: { input: BOOK_CREATE_INPUT },
        };
        await expect(gen.run(makeCtx(), bogus)).rejects.toThrow(/TextGenerator\.run: unknown plan kind something-else/);
    });
    it('throws when plan.meta.input is missing', async () => {
        const gen = new TextGenerator();
        const broken = { kind: 'book-create', steps: [] };
        await expect(gen.run(makeCtx(), broken)).rejects.toThrow(/plan\.meta\.input missing/);
    });
});
describe('TextGenerator.validate', () => {
    it('book-create: empty characters → passed=false with violation', async () => {
        const gen = new TextGenerator();
        const foundation = createFoundation({
            workId: 'work-1',
            genre: 'action',
            genreProfile: registry.get('action'),
        });
        const result = await gen.validate(makeCtx(), { kind: 'book-create', foundation });
        expect(result.passed).toBe(false);
        expect(result.violations).toContain('foundation missing workId/genre/characters');
    });
    it('book-create: foundation with workId/genre/characters → passed=true', async () => {
        const gen = new TextGenerator();
        const result = await gen.validate(makeCtx(), {
            kind: 'book-create',
            foundation: makeFoundationWithCast(),
        });
        expect(result.passed).toBe(true);
        expect(result.violations).toEqual([]);
    });
    it('chapter-write: empty prose → passed=false with violation', async () => {
        const gen = new TextGenerator();
        const result = await gen.validate(makeCtx(), {
            kind: 'chapter-write',
            artifact: makeArtifact(''),
        });
        expect(result.passed).toBe(false);
        expect(result.violations).toContain('chapter prose empty');
    });
    it('chapter-write: non-empty prose → passed=true', async () => {
        const gen = new TextGenerator();
        const result = await gen.validate(makeCtx(), {
            kind: 'chapter-write',
            artifact: makeArtifact('hello world'),
        });
        expect(result.passed).toBe(true);
        expect(result.violations).toEqual([]);
    });
    it('chapter-rewrite: empty artifacts → passed=false with violation', async () => {
        const gen = new TextGenerator();
        const result = await gen.validate(makeCtx(), {
            kind: 'chapter-rewrite',
            artifacts: [],
        });
        expect(result.passed).toBe(false);
        expect(result.violations).toContain('rewrite produced no artifacts');
    });
    it('chapter-rewrite: non-empty artifacts → passed=true', async () => {
        const gen = new TextGenerator();
        const result = await gen.validate(makeCtx(), {
            kind: 'chapter-rewrite',
            artifacts: [makeArtifact('x')],
        });
        expect(result.passed).toBe(true);
        expect(result.violations).toEqual([]);
    });
});
