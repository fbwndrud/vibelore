import { describe, it, expect } from '../_support/vitest-shim.mjs';
import { detectCliffhanger, CLIFFHANGER_TRIGGERS } from '../../src/continuity/cliffhanger-detector.js';
describe('detectCliffhanger', () => {
    it('returns no violations for empty prose', () => {
        expect(detectCliffhanger({ prose: '', chapterNumber: 1 }).violations).toEqual([]);
    });
    it('flags CLIFFHANGER_MISSING when last paragraph has no trigger', () => {
        const prose = '평범한 본문이다.\n\n그렇게 하루가 끝났다.';
        const r = detectCliffhanger({ prose, chapterNumber: 1 });
        expect(r.violations.length).toBe(1);
        expect(r.violations[0].code).toBe('CLIFFHANGER_MISSING');
        expect(r.violations[0].severity).toBe('soft');
    });
    it('passes with interrogative ending', () => {
        const prose = '본문.\n\n그것은 무엇이었을까?';
        const r = detectCliffhanger({ prose, chapterNumber: 1 });
        expect(r.violations).toEqual([]);
    });
    it('passes with unfinished-event marker', () => {
        const prose = '본문.\n\n바로 그때 문이 열리려는 순간 그는 깨달았다.';
        const r = detectCliffhanger({ prose, chapterNumber: 1 });
        expect(r.violations).toEqual([]);
    });
    it('passes with reversal marker', () => {
        const prose = '평범한 흐름이 이어졌다.\n\n하지만 그것은 시작에 불과했다.';
        const r = detectCliffhanger({ prose, chapterNumber: 1 });
        expect(r.violations).toEqual([]);
    });
    it('only inspects the last paragraph', () => {
        // earlier paragraphs have triggers, last one does not
        const prose = '하지만 그것은 시작이었다.\n\n평범하게 끝났다.';
        const r = detectCliffhanger({ prose, chapterNumber: 1 });
        expect(r.violations.length).toBe(1);
    });
    it('trigger seed has >= 25 entries', () => {
        expect(CLIFFHANGER_TRIGGERS.length).toBeGreaterThanOrEqual(25);
    });
});
describe('detectCliffhanger — Arc-aware (EPIC #191)', () => {
    const blandProse = '평범한 본문이다.\n\n그렇게 하루가 끝났다.';
    it('flags CLIFFHANGER_MISSING when arcPosition=closing and no trigger', () => {
        const r = detectCliffhanger({ prose: blandProse, chapterNumber: 5, arcPosition: 'closing' });
        expect(r.violations.length).toBe(1);
        expect(r.violations[0].code).toBe('CLIFFHANGER_MISSING');
    });
    it('does NOT flag when arcPosition=opening (Arc 도입 박자 = 자유)', () => {
        const r = detectCliffhanger({ prose: blandProse, chapterNumber: 1, arcPosition: 'opening' });
        expect(r.violations).toEqual([]);
    });
    it('does NOT flag when arcPosition=rising', () => {
        const r = detectCliffhanger({ prose: blandProse, chapterNumber: 3, arcPosition: 'rising' });
        expect(r.violations).toEqual([]);
    });
    it('does NOT flag when arcPosition=midpoint', () => {
        const r = detectCliffhanger({ prose: blandProse, chapterNumber: 5, arcPosition: 'midpoint' });
        expect(r.violations).toEqual([]);
    });
    it('does NOT flag when arcPosition=falling', () => {
        const r = detectCliffhanger({ prose: blandProse, chapterNumber: 7, arcPosition: 'falling' });
        expect(r.violations).toEqual([]);
    });
    it('still passes when arcPosition=closing and cliffhanger present', () => {
        const prose = '본문.\n\n그것은 무엇이었을까?';
        const r = detectCliffhanger({ prose, chapterNumber: 10, arcPosition: 'closing' });
        expect(r.violations).toEqual([]);
    });
    it('legacy mode (no arcPosition) keeps existing strict behavior', () => {
        const r = detectCliffhanger({ prose: blandProse, chapterNumber: 3 });
        expect(r.violations.length).toBe(1);
        expect(r.violations[0].code).toBe('CLIFFHANGER_MISSING');
    });
});
