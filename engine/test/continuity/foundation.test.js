import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { appendIntrinsicChange, createFoundation, registerCharacter, resolveCharacter, } from '../../src/continuity/foundation.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
const registry = createGenreProfileRegistry();
const makeFoundation = () => createFoundation({
    workId: 'work-1',
    genre: 'action',
    genreProfile: registry.get('action'),
});
const makeChar = (overrides = {}) => ({
    id: 'c1',
    canonicalName: '주인공',
    aliases: [],
    registeredAtChapter: 1,
    intrinsic: {
        gender: 'male',
        ageBand: '20대초반',
        birthOrder: '장남',
        role: '주인공',
        coreAppearance: ['은발', '벽안'],
    },
    mutable: {
        status: 'alive',
        knownFacts: [],
    },
    relationships: [],
    ...overrides,
});
describe('createFoundation', () => {
    it('creates an empty registry bound to genre + profile', () => {
        const f = makeFoundation();
        expect(f.workId).toBe('work-1');
        expect(f.genre).toBe('action');
        expect(f.worldFacts).toEqual([]);
        expect(f.characters).toEqual([]);
        expect(f.intrinsicChanges).toEqual([]);
        expect(f.genreProfile.genre).toBe('action');
    });
});
describe('registerCharacter', () => {
    it('appends a character and returns a new Foundation instance (pure)', () => {
        const f1 = makeFoundation();
        const c = makeChar();
        const f2 = registerCharacter(f1, c);
        expect(f2).not.toBe(f1);
        expect(f1.characters).toHaveLength(0);
        expect(f2.characters).toHaveLength(1);
        expect(f2.characters[0]).toBe(c);
    });
    it('throws DUPLICATE_CHARACTER_ID when id already exists', () => {
        const f1 = registerCharacter(makeFoundation(), makeChar());
        expect.assertions(2);
        try {
            registerCharacter(f1, makeChar({ canonicalName: '다른이름' }));
        }
        catch (err) {
            expect(err).toBeInstanceOf(Error);
            expect(err.code).toBe('DUPLICATE_CHARACTER_ID');
        }
    });
});
describe('appendIntrinsicChange', () => {
    const makeEvent = (overrides = {}) => ({
        characterId: 'c1',
        atChapter: 3,
        field: 'gender',
        from: 'male',
        to: 'female',
        narrativeCause: '마법 성전환 의식',
        ...overrides,
    });
    it('throws MISSING_NARRATIVE_CAUSE for empty cause', () => {
        const f = registerCharacter(makeFoundation(), makeChar());
        expect.assertions(1);
        try {
            appendIntrinsicChange(f, makeEvent({ narrativeCause: '' }));
        }
        catch (err) {
            expect(err.code).toBe('MISSING_NARRATIVE_CAUSE');
        }
    });
    it('throws MISSING_NARRATIVE_CAUSE for whitespace-only cause', () => {
        const f = registerCharacter(makeFoundation(), makeChar());
        expect.assertions(1);
        try {
            appendIntrinsicChange(f, makeEvent({ narrativeCause: '   \t\n  ' }));
        }
        catch (err) {
            expect(err.code).toBe('MISSING_NARRATIVE_CAUSE');
        }
    });
    it('throws UNKNOWN_CHARACTER when characterId is not registered', () => {
        const f = makeFoundation();
        expect.assertions(1);
        try {
            appendIntrinsicChange(f, makeEvent({ characterId: 'ghost' }));
        }
        catch (err) {
            expect(err.code).toBe('UNKNOWN_CHARACTER');
        }
    });
    it('appends when from matches base intrinsic — returns new Foundation', () => {
        const f1 = registerCharacter(makeFoundation(), makeChar());
        const ev = makeEvent();
        const f2 = appendIntrinsicChange(f1, ev);
        expect(f2).not.toBe(f1);
        expect(f1.intrinsicChanges).toHaveLength(0);
        expect(f2.intrinsicChanges).toHaveLength(1);
        expect(f2.intrinsicChanges[0]).toBe(ev);
    });
    it('throws INTRINSIC_LOCKED when from does not match base', () => {
        const f = registerCharacter(makeFoundation(), makeChar());
        expect.assertions(1);
        try {
            appendIntrinsicChange(f, makeEvent({ from: 'female' }));
        }
        catch (err) {
            expect(err.code).toBe('INTRINSIC_LOCKED');
        }
    });
    it('chains: second event from must match first event to', () => {
        let f = registerCharacter(makeFoundation(), makeChar());
        f = appendIntrinsicChange(f, makeEvent({ atChapter: 3, from: 'male', to: 'female' }));
        // good: from=female matches prior event's to
        const f2 = appendIntrinsicChange(f, makeEvent({ atChapter: 5, from: 'female', to: 'nonbinary' }));
        expect(f2.intrinsicChanges).toHaveLength(2);
        // bad: from=male does NOT match prior to=female → INTRINSIC_LOCKED
        expect.assertions(2);
        try {
            appendIntrinsicChange(f, makeEvent({ atChapter: 5, from: 'male', to: 'nonbinary' }));
        }
        catch (err) {
            expect(err.code).toBe('INTRINSIC_LOCKED');
        }
    });
});
describe('resolveCharacter', () => {
    it('throws UNKNOWN_CHARACTER when id absent', () => {
        const f = makeFoundation();
        expect.assertions(1);
        try {
            resolveCharacter(f, 5, 'ghost');
        }
        catch (err) {
            expect(err.code).toBe('UNKNOWN_CHARACTER');
        }
    });
    it('throws UNKNOWN_CHARACTER when chapter precedes registeredAtChapter', () => {
        const f = registerCharacter(makeFoundation(), makeChar({ registeredAtChapter: 5 }));
        expect.assertions(1);
        try {
            resolveCharacter(f, 3, 'c1');
        }
        catch (err) {
            expect(err.code).toBe('UNKNOWN_CHARACTER');
        }
    });
    it('returns base intrinsic at chapter before any event', () => {
        let f = registerCharacter(makeFoundation(), makeChar());
        f = appendIntrinsicChange(f, {
            characterId: 'c1',
            atChapter: 5,
            field: 'gender',
            from: 'male',
            to: 'female',
            narrativeCause: '마법 성전환',
        });
        const out = resolveCharacter(f, 3, 'c1');
        expect(out.intrinsic.gender).toBe('male');
    });
    it('returns folded intrinsic at chapter where events have applied', () => {
        let f = registerCharacter(makeFoundation(), makeChar());
        f = appendIntrinsicChange(f, {
            characterId: 'c1',
            atChapter: 3,
            field: 'gender',
            from: 'male',
            to: 'female',
            narrativeCause: '마법 성전환',
        });
        f = appendIntrinsicChange(f, {
            characterId: 'c1',
            atChapter: 5,
            field: 'ageBand',
            from: '20대초반',
            to: '30대초반',
            narrativeCause: '시간 도약',
        });
        const out = resolveCharacter(f, 10, 'c1');
        expect(out.intrinsic.gender).toBe('female');
        expect(out.intrinsic.ageBand).toBe('30대초반');
        // unrelated fields preserved
        expect(out.intrinsic.role).toBe('주인공');
        expect(out.canonicalName).toBe('주인공');
    });
    it('isolates events by characterId — other character events do not bleed in', () => {
        let f = registerCharacter(makeFoundation(), makeChar());
        f = registerCharacter(f, makeChar({ id: 'c2', canonicalName: '조연', intrinsic: {
                gender: 'female',
                ageBand: '30대초반',
                role: '조연',
                coreAppearance: ['흑발'],
            } }));
        f = appendIntrinsicChange(f, {
            characterId: 'c2',
            atChapter: 3,
            field: 'gender',
            from: 'female',
            to: 'male',
            narrativeCause: '신비한 변신',
        });
        const c1 = resolveCharacter(f, 10, 'c1');
        expect(c1.intrinsic.gender).toBe('male'); // base preserved — c2 event ignored
        const c2 = resolveCharacter(f, 10, 'c2');
        expect(c2.intrinsic.gender).toBe('male'); // c2 event applied
    });
});
