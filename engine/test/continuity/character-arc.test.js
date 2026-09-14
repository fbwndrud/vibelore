/**
 * character-arc — Arc Flow Stage A (EPIC #191 / Stage A #192).
 *
 * advanceCursor 의 6-beat 순서 + active arc quota + seedInitialArcPromiseFromSynopsis.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { CHARACTER_ARC_BEATS, MAX_ACTIVE_CHARACTER_ARCS, activeArcCount, advanceCursor, isCharacterTracked, seedInitialArcPromiseFromSynopsis, } from '../../src/continuity/character-arc.js';
describe('CHARACTER_ARC_BEATS', () => {
    it('has 6 beats in fixed order', () => {
        expect(CHARACTER_ARC_BEATS).toEqual([
            'wound',
            'attempt',
            'collapse',
            'companion',
            'self-choice',
            'echo',
        ]);
    });
});
describe('activeArcCount + isCharacterTracked', () => {
    it('counts only non-echo cursors as active', () => {
        const cursor = {
            hero: { beat: 'attempt', enteredAtChapter: 3 },
            rival: { beat: 'echo', enteredAtChapter: 20 },
            sidekick: { beat: 'wound', enteredAtChapter: 5 },
        };
        expect(activeArcCount(cursor)).toBe(2);
        expect(isCharacterTracked(cursor, 'hero')).toBe(true);
        expect(isCharacterTracked(cursor, 'rival')).toBe(true);
        expect(isCharacterTracked(cursor, 'unknown')).toBe(false);
    });
    it('empty cursor has zero active', () => {
        expect(activeArcCount({})).toBe(0);
    });
});
describe('advanceCursor — entry rules', () => {
    it('accepts wound as first beat for new character', () => {
        const next = advanceCursor({}, { characterId: 'hero', nextBeat: 'wound', chapterNumber: 1 });
        expect(next.hero?.beat).toBe('wound');
        expect(next.hero?.enteredAtChapter).toBe(1);
    });
    it('rejects non-wound first beat with ARC_MUST_START_AT_WOUND', () => {
        expect(() => advanceCursor({}, { characterId: 'hero', nextBeat: 'attempt', chapterNumber: 1 })).toThrow(/ARC_MUST_START_AT_WOUND|wound/i);
    });
    it('enforces MAX_ACTIVE_CHARACTER_ARCS quota on new wounds', () => {
        expect(MAX_ACTIVE_CHARACTER_ARCS).toBe(2);
        let cursor = {};
        cursor = advanceCursor(cursor, { characterId: 'a', nextBeat: 'wound', chapterNumber: 1 });
        cursor = advanceCursor(cursor, { characterId: 'b', nextBeat: 'wound', chapterNumber: 1 });
        expect(activeArcCount(cursor)).toBe(2);
        try {
            advanceCursor(cursor, { characterId: 'c', nextBeat: 'wound', chapterNumber: 2 });
            throw new Error('expected throw');
        }
        catch (err) {
            expect(err.code).toBe('ACTIVE_ARC_QUOTA_EXCEEDED');
        }
    });
    it('frees a slot when an existing arc reaches echo (3rd new wound OK)', () => {
        let cursor = {};
        cursor = advanceCursor(cursor, { characterId: 'a', nextBeat: 'wound', chapterNumber: 1 });
        // a 를 차근차근 echo 까지 진행
        for (const beat of ['attempt', 'collapse', 'companion', 'self-choice', 'echo']) {
            cursor = advanceCursor(cursor, { characterId: 'a', nextBeat: beat, chapterNumber: 2 });
        }
        expect(activeArcCount(cursor)).toBe(0);
        // b, c 둘 다 신규 wound 가능
        cursor = advanceCursor(cursor, { characterId: 'b', nextBeat: 'wound', chapterNumber: 3 });
        cursor = advanceCursor(cursor, { characterId: 'c', nextBeat: 'wound', chapterNumber: 3 });
        expect(activeArcCount(cursor)).toBe(2);
    });
});
describe('advanceCursor — progression rules', () => {
    it('advances one beat at a time in order', () => {
        let cursor = advanceCursor({}, { characterId: 'h', nextBeat: 'wound', chapterNumber: 1 });
        cursor = advanceCursor(cursor, { characterId: 'h', nextBeat: 'attempt', chapterNumber: 2 });
        expect(cursor.h?.beat).toBe('attempt');
        expect(cursor.h?.enteredAtChapter).toBe(2);
    });
    it('rejects skipping a beat (wound → collapse)', () => {
        const c0 = advanceCursor({}, { characterId: 'h', nextBeat: 'wound', chapterNumber: 1 });
        try {
            advanceCursor(c0, { characterId: 'h', nextBeat: 'collapse', chapterNumber: 2 });
            throw new Error('expected throw');
        }
        catch (err) {
            expect(err.code).toBe('ARC_BEAT_OUT_OF_ORDER');
        }
    });
    it('rejects regression (attempt → wound)', () => {
        let cursor = advanceCursor({}, { characterId: 'h', nextBeat: 'wound', chapterNumber: 1 });
        cursor = advanceCursor(cursor, { characterId: 'h', nextBeat: 'attempt', chapterNumber: 2 });
        try {
            advanceCursor(cursor, { characterId: 'h', nextBeat: 'wound', chapterNumber: 3 });
            throw new Error('expected throw');
        }
        catch (err) {
            expect(err.code).toBe('ARC_BEAT_OUT_OF_ORDER');
        }
    });
    it('allows repeating the same beat (note update)', () => {
        const c0 = advanceCursor({}, { characterId: 'h', nextBeat: 'wound', chapterNumber: 1 });
        const c1 = advanceCursor(c0, { characterId: 'h', nextBeat: 'wound', chapterNumber: 3, note: '재인용' });
        expect(c1.h?.beat).toBe('wound');
        expect(c1.h?.enteredAtChapter).toBe(3);
        expect(c1.h?.note).toBe('재인용');
    });
    it('rejects advancing an already-echoed character', () => {
        let cursor = advanceCursor({}, { characterId: 'h', nextBeat: 'wound', chapterNumber: 1 });
        for (const beat of ['attempt', 'collapse', 'companion', 'self-choice', 'echo']) {
            cursor = advanceCursor(cursor, { characterId: 'h', nextBeat: beat, chapterNumber: 2 });
        }
        try {
            advanceCursor(cursor, { characterId: 'h', nextBeat: 'echo', chapterNumber: 3 });
            throw new Error('expected throw');
        }
        catch (err) {
            expect(err.code).toBe('CHARACTER_ARC_ECHOED');
        }
    });
});
describe('advanceCursor — purity', () => {
    it('does not mutate the input cursor', () => {
        const original = { hero: { beat: 'wound', enteredAtChapter: 1 } };
        const snapshot = JSON.stringify(original);
        advanceCursor(original, { characterId: 'hero', nextBeat: 'attempt', chapterNumber: 2 });
        expect(JSON.stringify(original)).toBe(snapshot);
    });
});
describe('seedInitialArcPromiseFromSynopsis', () => {
    it('returns first sentence when short enough', () => {
        expect(seedInitialArcPromiseFromSynopsis('주인공이 도시를 떠난다. 그리고 시작된다.')).toBe('주인공이 도시를 떠난다.');
    });
    it('clamps to 120 chars with ellipsis on long single-sentence synopsis', () => {
        const long = '가'.repeat(200); // 1 long unbroken sentence
        const result = seedInitialArcPromiseFromSynopsis(long);
        expect(result.length).toBeLessThanOrEqual(120);
        expect(result.endsWith('...')).toBe(true);
    });
    it('returns placeholder for empty synopsis', () => {
        expect(seedInitialArcPromiseFromSynopsis('')).toBe('(약속 미설정)');
        expect(seedInitialArcPromiseFromSynopsis('   ')).toBe('(약속 미설정)');
    });
    it('splits on newline as well as terminal punctuation', () => {
        const sample = '첫 줄 promise.\n그리고 나머지';
        expect(seedInitialArcPromiseFromSynopsis(sample)).toBe('첫 줄 promise.');
    });
});
