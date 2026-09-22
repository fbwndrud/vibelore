/**
 * arc-context — Arc Flow Stage A (EPIC #191 / Stage A #192).
 *
 * 5-구간 ratio 경계값 + label 매핑 검증.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { ARC_POSITION_LABEL_KO, arcPositionFromRatio, } from '../../src/core/arc-context.js';
describe('arcPositionFromRatio', () => {
    it('returns opening at chapter 1 of long arc (ratio ~0.025)', () => {
        expect(arcPositionFromRatio(1, 20)).toBe('opening');
    });
    it('returns rising at chapter 5 of 20 (ratio 0.225)', () => {
        expect(arcPositionFromRatio(5, 20)).toBe('rising');
    });
    it('returns midpoint at chapter 10 of 20 (ratio 0.475)', () => {
        expect(arcPositionFromRatio(10, 20)).toBe('midpoint');
    });
    it('returns falling at chapter 14 of 20 (ratio 0.675)', () => {
        expect(arcPositionFromRatio(14, 20)).toBe('falling');
    });
    it('returns closing at last chapter of arc (ratio ~0.975)', () => {
        expect(arcPositionFromRatio(20, 20)).toBe('closing');
    });
    it('returns midpoint for single-chapter arc (1/1 → ratio 0.5)', () => {
        // 1-화 arc 는 즉시 중간점 — 도입/종결 의미 없음.
        expect(arcPositionFromRatio(1, 1)).toBe('midpoint');
    });
    it('falls back to opening when estimatedEpisodes <= 0', () => {
        expect(arcPositionFromRatio(3, 0)).toBe('opening');
        expect(arcPositionFromRatio(3, -1)).toBe('opening');
    });
    it('clamps overshoot at closing (chapter beyond estimate)', () => {
        // 작가가 추정보다 더 길게 쓰면 closing 으로 사실상 stuck — Stage B drift detector 가 reconciles.
        expect(arcPositionFromRatio(30, 20)).toBe('closing');
    });
    it('boundary just below midpoint stays rising (ratio 0.448)', () => {
        // chapter 9.5 of 20 → 9-th 화 결과 = rising. 10-th 화 부터 midpoint.
        expect(arcPositionFromRatio(9, 20)).toBe('rising');
    });
    it('boundary just at falling threshold (12/20 ratio 0.575)', () => {
        expect(arcPositionFromRatio(12, 20)).toBe('falling');
    });
});
describe('ARC_POSITION_LABEL_KO', () => {
    it('has a Korean label for every ArcPosition', () => {
        expect(ARC_POSITION_LABEL_KO.opening).toMatch(/도입/);
        expect(ARC_POSITION_LABEL_KO.rising).toMatch(/상승/);
        expect(ARC_POSITION_LABEL_KO.midpoint).toMatch(/중간/);
        expect(ARC_POSITION_LABEL_KO.falling).toMatch(/하강/);
        expect(ARC_POSITION_LABEL_KO.closing).toMatch(/종결/);
    });
});
