import { describe, it, expect } from '../_support/vitest-shim.mjs';
import { detectGapSkip, GAP_SKIP_MARKERS } from '../../src/continuity/gap-skip-detector.js';
describe('detectGapSkip', () => {
    it('returns no violations for empty prose', () => {
        expect(detectGapSkip({ prose: '', chapterNumber: 1 }).violations).toEqual([]);
    });
    it('flags NO_TIME_SKIP when zero time-skip markers across chapter', () => {
        const prose = '그는 일어났다. 밥을 먹었다. 일을 시작했다. 평범한 하루였다.';
        const r = detectGapSkip({ prose, chapterNumber: 1 });
        expect(r.violations.length).toBe(1);
        expect(r.violations[0].code).toBe('NO_TIME_SKIP');
        expect(r.violations[0].severity).toBe('soft');
    });
    it('passes with day-skip marker', () => {
        const prose = '평범한 하루였다. 다음 날 그는 다시 일을 시작했다.';
        const r = detectGapSkip({ prose, chapterNumber: 1 });
        expect(r.violations).toEqual([]);
    });
    it('passes with long-skip marker', () => {
        const prose = '시간이 빠르게 지나갔다. 몇 달 후 그는 새로운 도시에 도착했다.';
        const r = detectGapSkip({ prose, chapterNumber: 1 });
        expect(r.violations).toEqual([]);
    });
    it('passes with scene-cut marker', () => {
        const prose = '평범한 흐름. 시간이 흘러 그는 다시 그곳을 찾았다.';
        const r = detectGapSkip({ prose, chapterNumber: 1 });
        expect(r.violations).toEqual([]);
    });
    it('marker seed has >= 30 entries', () => {
        expect(GAP_SKIP_MARKERS.length).toBeGreaterThanOrEqual(30);
    });
});
