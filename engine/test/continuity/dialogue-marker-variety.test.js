import { describe, it, expect } from '../_support/vitest-shim.mjs';
import { scanDialogueMarkerVariety, KO_SPEECH_TAGS } from '../../src/continuity/dialogue-marker-variety.js';
describe('scanDialogueMarkerVariety', () => {
    it('returns no violations for empty prose', () => {
        expect(scanDialogueMarkerVariety({ prose: '', chapterNumber: 1 }).violations).toEqual([]);
    });
    it('skips scan when total tags < 5', () => {
        const prose = '그가 말했다. 그녀가 답했다.';
        const r = scanDialogueMarkerVariety({ prose, chapterNumber: 1 });
        expect(r.violations).toEqual([]);
    });
    it('flags DIALOGUE_TAG_MONOTONY when 말했다 dominates', () => {
        const prose = '그가 말했다. 그녀가 말했다. 그가 말했다. 그녀가 말했다. 그가 말했다. 그녀가 말했다. 한 명이 외쳤다.';
        const r = scanDialogueMarkerVariety({ prose, chapterNumber: 1 });
        expect(r.violations.some((v) => v.code === 'DIALOGUE_TAG_MONOTONY')).toBe(true);
        expect(r.violations[0].severity).toBe('soft');
        expect(r.stats.saidRatio).toBeGreaterThan(0.8);
    });
    it('passes with varied dialogue tags', () => {
        const prose = '그가 말했다. 그녀가 외쳤다. 그가 속삭였다. 그녀가 중얼거렸다. 그가 답했다. 그녀가 물었다.';
        const r = scanDialogueMarkerVariety({ prose, chapterNumber: 1 });
        expect(r.violations).toEqual([]);
    });
    it('tags lexicon has >= 50 entries', () => {
        expect(KO_SPEECH_TAGS.length).toBeGreaterThanOrEqual(50);
    });
    it('stats reports correctly', () => {
        const prose = '말했다. 말했다. 말했다. 말했다. 외쳤다. 속삭였다.';
        const r = scanDialogueMarkerVariety({ prose, chapterNumber: 1 });
        expect(r.stats.totalTags).toBeGreaterThanOrEqual(5);
        expect(r.stats.saidCount).toBe(4);
    });
});
