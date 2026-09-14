import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { effectiveIntrinsic, } from '../../src/continuity/character.js';
const makeBase = () => ({
    gender: 'male',
    ageBand: '20대초반',
    birthOrder: '장남',
    role: '주인공',
    coreAppearance: ['은발', '벽안'],
});
describe('effectiveIntrinsic', () => {
    it('returns a deep clone of base when no events apply', () => {
        const base = makeBase();
        const out = effectiveIntrinsic(base, [], 1);
        expect(out).toEqual(base);
        expect(out).not.toBe(base);
        expect(out.coreAppearance).not.toBe(base.coreAppearance);
    });
    it('applies a single event whose chapter is within atChapter', () => {
        const base = makeBase();
        const events = [
            {
                characterId: 'c1',
                atChapter: 3,
                field: 'gender',
                from: 'male',
                to: 'female',
                narrativeCause: '마법 성전환',
            },
        ];
        const out = effectiveIntrinsic(base, events, 5);
        expect(out.gender).toBe('female');
        // base untouched
        expect(base.gender).toBe('male');
    });
    it('ignores events at chapters beyond atChapter', () => {
        const base = makeBase();
        const events = [
            {
                characterId: 'c1',
                atChapter: 10,
                field: 'gender',
                from: 'male',
                to: 'female',
                narrativeCause: '마법 성전환',
            },
        ];
        const out = effectiveIntrinsic(base, events, 5);
        expect(out.gender).toBe('male');
    });
    it('chains multiple events on the same field — final equals last applied', () => {
        const base = makeBase();
        const events = [
            {
                characterId: 'c1',
                atChapter: 2,
                field: 'ageBand',
                from: '20대초반',
                to: '20대중반',
                narrativeCause: '시간 경과',
            },
            {
                characterId: 'c1',
                atChapter: 4,
                field: 'ageBand',
                from: '20대중반',
                to: '30대초반',
                narrativeCause: '시간 도약',
            },
        ];
        const out = effectiveIntrinsic(base, events, 10);
        expect(out.ageBand).toBe('30대초반');
    });
    it('throws data-integrity error when `from` does not match current', () => {
        const base = makeBase();
        const events = [
            {
                characterId: 'c1',
                atChapter: 2,
                field: 'gender',
                from: 'female', // base has 'male'
                to: 'nonbinary',
                narrativeCause: '버그',
            },
        ];
        expect(() => effectiveIntrinsic(base, events, 5)).toThrow(/data-integrity: intrinsic gender expected "female" but base has "male"/);
    });
    it('applies events on different fields independently', () => {
        const base = makeBase();
        const events = [
            {
                characterId: 'c1',
                atChapter: 2,
                field: 'gender',
                from: 'male',
                to: 'female',
                narrativeCause: '마법 성전환',
            },
            {
                characterId: 'c1',
                atChapter: 3,
                field: 'coreAppearance',
                from: ['은발', '벽안'],
                to: ['흑발', '벽안', '이마 흉터'],
                narrativeCause: '전투 후 변모',
            },
        ];
        const out = effectiveIntrinsic(base, events, 10);
        expect(out.gender).toBe('female');
        expect(out.coreAppearance).toEqual(['흑발', '벽안', '이마 흉터']);
        // unrelated fields preserved
        expect(out.role).toBe('주인공');
        expect(out.birthOrder).toBe('장남');
        // base untouched
        expect(base.coreAppearance).toEqual(['은발', '벽안']);
    });
});
