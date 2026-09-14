import { describe, it, expect } from '../_support/vitest-shim.mjs';
import { DefaultSensitiveLexicon, scanSensitive, KO_SENSITIVE_SEED, } from '../../src/continuity/sensitive-lexicon.js';
describe('SensitiveLexicon', () => {
    it('seed has >= 80 entries across 7 categories', () => {
        expect(KO_SENSITIVE_SEED.length).toBeGreaterThanOrEqual(80);
        const cats = new Set(KO_SENSITIVE_SEED.map((e) => e.category));
        expect(cats.size).toBe(7);
    });
    it('lookup finds seed entries', () => {
        const lex = new DefaultSensitiveLexicon();
        const seedEntry = KO_SENSITIVE_SEED[0];
        expect(lex.lookup(seedEntry.term)?.term).toBe(seedEntry.term);
    });
    it('byCategory partitions correctly', () => {
        const lex = new DefaultSensitiveLexicon();
        const profanity = lex.byCategory('profanity');
        expect(profanity.length).toBeGreaterThan(0);
        expect(profanity.every((e) => e.category === 'profanity')).toBe(true);
    });
    it('all() returns full seed', () => {
        const lex = new DefaultSensitiveLexicon();
        expect(lex.all().length).toBe(KO_SENSITIVE_SEED.length);
    });
});
describe('scanSensitive', () => {
    const lex = new DefaultSensitiveLexicon();
    it('returns no violations for clean prose', () => {
        const r = scanSensitive({
            prose: '맑은 봄날의 평범한 일상이었다.',
            chapterNumber: 1,
            lexicon: lex,
            mode: 'adult',
        });
        expect(r.violations).toEqual([]);
    });
    it('emits violation when prose contains sensitive term', () => {
        const profEntry = KO_SENSITIVE_SEED.find((e) => e.category === 'profanity' && e.adultSeverity !== 'allow');
        expect(profEntry).toBeDefined();
        const prose = `대화: "${profEntry.term}!"`;
        const r = scanSensitive({ prose, chapterNumber: 1, lexicon: lex, mode: 'adult' });
        expect(r.violations.length).toBeGreaterThan(0);
        expect(r.violations[0].code.startsWith('SENSITIVE_')).toBe(true);
    });
    it('youth mode tightens severity vs adult', () => {
        const entry = KO_SENSITIVE_SEED.find((e) => e.adultSeverity === 'soft' && e.youthSeverity === 'hard');
        expect(entry).toBeDefined();
        const prose = `텍스트 ${entry.term}`;
        const adultR = scanSensitive({ prose, chapterNumber: 1, lexicon: lex, mode: 'adult' });
        const youthR = scanSensitive({ prose, chapterNumber: 1, lexicon: lex, mode: 'youth' });
        expect(adultR.violations[0].severity).toBe('soft');
        expect(youthR.violations[0].severity).toBe('hard');
    });
    it('allow severity emits no violation', () => {
        const entry = KO_SENSITIVE_SEED.find((e) => e.adultSeverity === 'allow');
        expect(entry).toBeDefined();
        const prose = `텍스트 ${entry.term}`;
        const r = scanSensitive({ prose, chapterNumber: 1, lexicon: lex, mode: 'adult' });
        expect(r.violations.find((v) => v.message.includes(entry.term))).toBeUndefined();
    });
});

// NEP-S5 실검증이 발굴한 오탐 회귀 가드: 동사 '보다'의 활용형 '보지 않/못/말…'이
// sexual-explicit '보지'와 substring 충돌해 youth 모드 hard fail을 유발했다.
// notFollowedBy 문맥 가드가 활용형은 통과시키고 명사 문맥은 계속 잡아야 한다.
describe('scanSensitive — 동사 활용형 문맥 가드 (notFollowedBy)', () => {
    const lex = new DefaultSensitiveLexicon();
    const codes = (prose) =>
        scanSensitive({ prose, chapterNumber: 1, lexicon: lex, mode: 'youth' })
            .violations.map((v) => v.code);

    it("동사 활용형 '보지 않겠다'는 위반 아님 (실검증 오탐 재현 케이스)", () => {
        expect(codes('재의 연대기가 사라지는 것을 더는 보지 않겠다는 결의가 전해졌다.')).toEqual([]);
    });
    it("'보지 못했다' / '보지도 않았다' / '보지 마' 전부 위반 아님", () => {
        expect(codes('그는 끝내 그 광경을 보지 못했다.')).toEqual([]);
        expect(codes('뒤를 보지도 않았다.')).toEqual([]);
        expect(codes('이쪽을 보지 마.')).toEqual([]);
    });
    it('명사 문맥(조사 직결)은 계속 hard 위반', () => {
        const out = scanSensitive({ prose: '보지가', chapterNumber: 1, lexicon: lex, mode: 'youth' });
        expect(out.violations).toHaveLength(1);
        expect(out.violations[0].severity).toBe('hard');
        expect(out.violations[0].code).toBe('SENSITIVE_SEXUAL_EXPLICIT');
    });
    it('한 prose에 활용형과 명사 문맥이 공존하면 위반 1건', () => {
        const out = scanSensitive({ prose: '보지 않았다. 그러나 보지가 문제였다.', chapterNumber: 1, lexicon: lex, mode: 'youth' });
        expect(out.violations).toHaveLength(1);
    });
});
