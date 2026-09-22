/**
 * character.contradiction — Arc Flow Stage A (EPIC #191).
 *
 * registerCharacter enforceContradiction 모드 + checkContradictionStrength 휴리스틱.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { checkContradictionStrength, getContradiction, } from '../../src/continuity/character.js';
import { createFoundation, registerCharacter } from '../../src/continuity/foundation.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
const registry = createGenreProfileRegistry();
const baseChar = (overrides = {}) => ({
    id: 'c1',
    canonicalName: '주인공',
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
    contradiction: '모범생 학생회장이지만 비밀리에 빈집털이',
    ...overrides,
});
const makeFoundation = () => createFoundation({
    workId: 'work-1',
    genre: 'action',
    genreProfile: registry.get('action'),
});
describe('registerCharacter — enforceContradiction', () => {
    it('accepts a Character with a contradiction string', () => {
        const f = registerCharacter(makeFoundation(), baseChar(), { enforceContradiction: true });
        expect(f.characters).toHaveLength(1);
    });
    it('rejects empty contradiction with MISSING_CONTRADICTION when enforced', () => {
        expect(() => registerCharacter(makeFoundation(), baseChar({ contradiction: '' }), {
            enforceContradiction: true,
        })).toThrow(/MISSING_CONTRADICTION|contradiction/i);
    });
    it('rejects whitespace-only contradiction when enforced', () => {
        expect(() => registerCharacter(makeFoundation(), baseChar({ contradiction: '   ' }), {
            enforceContradiction: true,
        })).toThrow(/MISSING_CONTRADICTION|contradiction/i);
    });
    it('rejects missing contradiction field when enforced', () => {
        const c = baseChar();
        delete c.contradiction;
        expect(() => registerCharacter(makeFoundation(), c, { enforceContradiction: true })).toThrow(/MISSING_CONTRADICTION|contradiction/i);
    });
    it('passes through legacy Character (no contradiction) when NOT enforced', () => {
        const c = baseChar();
        delete c.contradiction;
        const f = registerCharacter(makeFoundation(), c);
        expect(f.characters).toHaveLength(1);
    });
});
describe('getContradiction', () => {
    it('returns the contradiction when set', () => {
        expect(getContradiction(baseChar({ contradiction: 'X' }))).toBe('X');
    });
    it('returns empty string when missing', () => {
        const c = baseChar();
        delete c.contradiction;
        expect(getContradiction(c)).toBe('');
    });
    it('returns empty string when contradiction is non-string (defensive)', () => {
        const c = baseChar();
        c.contradiction = 42;
        expect(getContradiction(c)).toBe('');
    });
});
describe('checkContradictionStrength', () => {
    it('returns missing for empty string', () => {
        expect(checkContradictionStrength('')).toBe('missing');
        expect(checkContradictionStrength('   ')).toBe('missing');
    });
    it('returns weak for archetype binary opposites', () => {
        expect(checkContradictionStrength('선과 악')).toBe('weak');
        expect(checkContradictionStrength('강함과 약함')).toBe('weak');
        expect(checkContradictionStrength('빛과 어둠')).toBe('weak');
    });
    it('returns weak for short bare nouns (< 25 chars, no verb marker)', () => {
        expect(checkContradictionStrength('선악 양면')).toBe('weak');
    });
    it('returns strong for 20+ char concrete description', () => {
        expect(checkContradictionStrength('모범생 학생회장이지만 비밀리에 빈집털이')).toBe('strong');
    });
    it('returns strong for shorter strings with action verb markers', () => {
        expect(checkContradictionStrength('우정과 야망 사이에서 매번 결정한다')).toBe('strong');
    });
});
