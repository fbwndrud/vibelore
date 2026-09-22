import { describe, it, expect } from '../_support/vitest-shim.mjs';
import { scanSentenceStats } from '../../src/continuity/sentence-stats.js';
describe('scanSentenceStats', () => {
    it('returns no violations for empty prose', () => {
        const r = scanSentenceStats({ prose: '', chapterNumber: 1 });
        expect(r.violations).toEqual([]);
        expect(r.stats.sentenceCount).toBe(0);
    });
    it('skips scan when < 10 sentences', () => {
        const prose = '한 문장. 둘. 셋. 넷.';
        const r = scanSentenceStats({ prose, chapterNumber: 1 });
        expect(r.violations).toEqual([]);
    });
    it('flags SENTENCE_MONOTONY with tight length distribution', () => {
        // 12 sentences all length ~5
        const s = '오늘은. ';
        const prose = s.repeat(12);
        const r = scanSentenceStats({ prose, chapterNumber: 1 });
        const codes = r.violations.map((v) => v.code);
        expect(codes).toContain('SENTENCE_MONOTONY');
    });
    it('flags SENTENCE_CHAOS with extreme variance', () => {
        // mix of very short and very long sentences (12 sentences total)
        const long = '아주 긴 문장 하나를 만들기 위해서 단어를 계속 추가하고 또 추가하며 길이를 늘려본다 그러면 문장이 매우 길어진다 정말 길어진다 이렇게 길어진다.';
        const prose = ['짧다.', long, '짧다.', long, '짧다.', long, '짧다.', long, '짧다.', long, '짧다.', long].join(' ');
        const r = scanSentenceStats({ prose, chapterNumber: 1 });
        expect(r.violations.some((v) => v.code === 'SENTENCE_CHAOS')).toBe(true);
    });
    it('emits soft severity only', () => {
        const prose = '오늘은. '.repeat(12);
        const r = scanSentenceStats({ prose, chapterNumber: 1 });
        expect(r.violations.every((v) => v.severity === 'soft')).toBe(true);
    });
    it('computes stats correctly for known fixture', () => {
        const prose = '오. 오. 오. 오. 오. 오. 오. 오. 오. 오. 오. 오.';
        const r = scanSentenceStats({ prose, chapterNumber: 1 });
        expect(r.stats.sentenceCount).toBeGreaterThanOrEqual(10);
        expect(r.stats.stdev).toBeLessThan(2);
    });
});
