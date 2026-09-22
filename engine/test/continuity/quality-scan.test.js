import { describe, it, expect } from '../_support/vitest-shim.mjs';
import { scanQuality } from '../../src/continuity/quality-scan.js';
import { DefaultEmotionVerbLexicon } from '../../src/continuity/emotion-verb-lexicon.js';
import { DefaultSimileMarkerLexicon } from '../../src/continuity/simile-marker-lexicon.js';
import { DefaultOnomatopoeiaLexicon } from '../../src/continuity/onomatopoeia-lexicon.js';
describe('scanQuality', () => {
    const emo = new DefaultEmotionVerbLexicon();
    const sim = new DefaultSimileMarkerLexicon();
    const ono = new DefaultOnomatopoeiaLexicon();
    it('returns no violations for empty prose', () => {
        expect(scanQuality({ prose: '', chapterNumber: 1, emotionLexicon: emo, simileLexicon: sim, onomatopoeiaLexicon: ono }).violations).toEqual([]);
    });
    it('flags SHOW_NOT_TELL_LOW when many emotion-verbs but no similes', () => {
        // 3+ emotion verbs from seed, no simile markers.
        const verbs = emo.all().slice(0, 5).map((e) => e.verb);
        const prose = verbs.map((v) => `그는 ${v}.`).join(' ') + ' 추가 문장이 한참 이어진다. 그리고 또 무엇인가가 있었다. 여러 문장이 더 있다.';
        const result = scanQuality({ prose, chapterNumber: 1, emotionLexicon: emo, simileLexicon: sim, onomatopoeiaLexicon: ono });
        expect(result.violations.some((v) => v.code === 'SHOW_NOT_TELL_LOW')).toBe(true);
    });
    it('flags EMOTION_OVERTELL with dense 1인칭+emotion', () => {
        const verbs = emo.all().slice(0, 4).map((e) => e.verb);
        const prose = verbs.map((v) => `나는 ${v}.`).join(' ');
        const result = scanQuality({ prose, chapterNumber: 1, emotionLexicon: emo, simileLexicon: sim, onomatopoeiaLexicon: ono });
        expect(result.violations.some((v) => v.code === 'EMOTION_OVERTELL')).toBe(true);
    });
    it('flags ONOMATOPOEIA_OVERUSE with dense onomatopoeia', () => {
        const ws = ono.all().slice(0, 12).map((e) => e.word);
        const prose = ws.join(' ');
        const result = scanQuality({ prose, chapterNumber: 1, emotionLexicon: emo, simileLexicon: sim, onomatopoeiaLexicon: ono });
        expect(result.violations.some((v) => v.code === 'ONOMATOPOEIA_OVERUSE')).toBe(true);
    });
    it('flags SIMILE_TOO_SPARSE for long prose without simile markers', () => {
        // 600+ words, no simile markers, no emotion verbs > 3 to avoid show-not-tell collision.
        const prose = '평범한 글을 쓴다. '.repeat(120);
        const result = scanQuality({ prose, chapterNumber: 1, emotionLexicon: emo, simileLexicon: sim, onomatopoeiaLexicon: ono });
        expect(result.violations.some((v) => v.code === 'SIMILE_TOO_SPARSE')).toBe(true);
    });
    it('all aux violations are SOFT', () => {
        const prose = '나는 슬펐다. 나는 기뻤다. 나는 두려웠다.';
        const result = scanQuality({ prose, chapterNumber: 1, emotionLexicon: emo, simileLexicon: sim, onomatopoeiaLexicon: ono });
        expect(result.violations.every((v) => v.severity === 'soft')).toBe(true);
    });
});
