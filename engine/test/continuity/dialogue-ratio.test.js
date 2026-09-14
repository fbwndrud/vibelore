import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { scanDialogueRatio } from '../../src/continuity/dialogue-ratio.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
const registry = createGenreProfileRegistry();
const comedy = registry.get('comedy');
const action = registry.get('action');
describe('scanDialogueRatio', () => {
    it('returns no violations for empty prose', () => {
        const r = scanDialogueRatio({ prose: '', chapterNumber: 1, genreProfile: comedy });
        expect(r.violations).toEqual([]);
    });
    it('skips when lines < 6', () => {
        const prose = '"안녕".\n평범.\n"또".';
        const r = scanDialogueRatio({ prose, chapterNumber: 1, genreProfile: comedy });
        expect(r.violations).toEqual([]);
    });
    it('flags DIALOGUE_RATIO_OFF below min', () => {
        const prose = [
            '평범한 묘사.',
            '걸어가는 그.',
            '하늘.',
            '바람.',
            '풀잎.',
            '풍경.',
            '"하나만 대사".',
            '주변.',
            '계속.',
            '묘사가 이어진다.',
        ].join('\n');
        const r = scanDialogueRatio({ prose, chapterNumber: 1, genreProfile: comedy });
        expect(r.violations.some((v) => v.code === 'DIALOGUE_RATIO_OFF')).toBe(true);
    });
    it('flags DIALOGUE_RATIO_OFF above max', () => {
        const prose = [
            '"하나입니다 대사입니다"',
            '"둘입니다 대사입니다"',
            '"셋입니다 대사입니다"',
            '"넷입니다 대사입니다"',
            '"다섯입니다 대사입니다"',
            '"여섯입니다 대사입니다"',
            '"일곱입니다 대사입니다"',
            '"여덟입니다 대사입니다"',
            '"아홉입니다 대사입니다"',
            '"열입니다 대사입니다"',
        ].join('\n');
        const r = scanDialogueRatio({ prose, chapterNumber: 1, genreProfile: action });
        expect(r.violations.some((v) => v.code === 'DIALOGUE_RATIO_OFF')).toBe(true);
    });
    it('passes within range', () => {
        const prose = [
            '"대사 하나입니다."',
            '내레이션 라인 하나.',
            '"대사 둘입니다."',
            '"대사 셋입니다."',
            '내레이션 둘.',
            '"대사 넷입니다."',
            '"대사 다섯입니다."',
            '내레이션 셋.',
        ].join('\n');
        const r = scanDialogueRatio({ prose, chapterNumber: 1, genreProfile: comedy });
        expect(r.violations).toEqual([]);
    });
    it('all violations are SOFT', () => {
        const prose = [
            '"하나입니다 대사입니다"',
            '"둘입니다 대사입니다"',
            '"셋입니다 대사입니다"',
            '"넷입니다 대사입니다"',
            '"다섯입니다 대사입니다"',
            '"여섯입니다 대사입니다"',
            '"일곱입니다 대사입니다"',
            '"여덟입니다 대사입니다"',
        ].join('\n');
        const r = scanDialogueRatio({ prose, chapterNumber: 1, genreProfile: action });
        expect(r.violations.length).toBeGreaterThan(0);
        expect(r.violations.every((v) => v.severity === 'soft')).toBe(true);
    });
});
