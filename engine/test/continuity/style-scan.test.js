import { describe, it, expect } from '../_support/vitest-shim.mjs';
import { scanStyle } from '../../src/continuity/style-scan.js';
import { DefaultStyleLexicon } from '../../src/continuity/style-lexicon.js';
describe('scanStyle', () => {
    const lex = new DefaultStyleLexicon();
    it('returns no violations for clean prose', () => {
        const result = scanStyle({
            prose: '맑은 봄날, 그는 새 책을 펼쳤다. 글자가 햇볕에 반짝였다.',
            chapterNumber: 1,
            genre: 'regression-hunter',
            lexicon: lex,
        });
        expect(result.violations).toEqual([]);
    });
    it('flags LEXICAL_FATIGUE when one term repeats >= 3', () => {
        const entries = lex.forGenre('regression-hunter');
        expect(entries.length).toBeGreaterThan(0);
        const term = entries[0].surface;
        const prose = `${term} 한참 흘렀다. ${term} 다시. ${term} 또. 그러나 시간은 멈추지 않았다.`;
        const result = scanStyle({
            prose,
            chapterNumber: 2,
            genre: 'regression-hunter',
            lexicon: lex,
        });
        const codes = result.violations.map((v) => v.code);
        expect(codes).toContain('LEXICAL_FATIGUE');
        expect(result.violations.every((v) => v.severity === 'soft')).toBe(true);
    });
    it('flags CLICHE_DENSITY when many fatigue terms over short prose', () => {
        const entries = lex.forGenre('regression-hunter').slice(0, 8);
        const prose = entries.map((e) => e.surface).join(' ');
        const result = scanStyle({
            prose,
            chapterNumber: 3,
            genre: 'regression-hunter',
            lexicon: lex,
        });
        expect(result.violations.some((v) => v.code === 'CLICHE_DENSITY')).toBe(true);
    });
    it('returns no violations for unknown genre', () => {
        const result = scanStyle({
            prose: '아무 말. 아무 말. 아무 말.',
            chapterNumber: 1,
            genre: 'nope',
            lexicon: lex,
        });
        expect(result.violations).toEqual([]);
    });
    it('handles empty prose without error', () => {
        expect(scanStyle({ prose: '', chapterNumber: 1, genre: 'comedy', lexicon: lex }).violations).toEqual([]);
    });
});
