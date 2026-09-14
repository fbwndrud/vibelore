/**
 * draft.ts — Arc-aware system prompt (EPIC #191 PR6).
 *
 * buildDraftSystem 이 ctx.arc.currentPosition 별로 instruction 분기.
 * Legacy (arc undefined) 는 기존 '한 회차에 갈등1+진행1+훅1' 유지.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { __buildDraftSystemForTest as buildDraftSystem } from '../../src/generators/text/steps/draft.js';
function arc(position) {
    return {
        arcId: 'a1',
        arcNumber: 1,
        title: 'Main',
        summary: '',
        promise: 'X',
        type: 'standard',
        estimatedEpisodes: 20,
        currentPosition: position,
        currentChapterInArc: 1,
    };
}
describe('buildDraftSystem — Arc-aware', () => {
    it('legacy (arc undefined) keeps "한 회차에 갈등 1개, 진행 1개, 다음 회차 훅 1개"', () => {
        const sys = buildDraftSystem();
        expect(sys).toContain('한 회차에 갈등 1개, 진행 1개, 다음 회차 훅 1개');
    });
    it('arc=opening: "도입 박자" + 마무리 X', () => {
        const sys = buildDraftSystem(arc('opening'));
        expect(sys).toContain('도입 박자');
        expect(sys).toContain('무리하게 마무리하지 말 것');
        expect(sys).not.toContain('한 회차에 갈등 1개');
    });
    it('arc=rising: "상승 박자" + 일직선', () => {
        const sys = buildDraftSystem(arc('rising'));
        expect(sys).toContain('상승 박자');
        expect(sys).toContain('일직선');
        expect(sys).toContain('매 화 self-contained');
    });
    it('arc=midpoint: 반전 1', () => {
        const sys = buildDraftSystem(arc('midpoint'));
        expect(sys).toContain('중간 박자');
        expect(sys).toContain('반전');
    });
    it('arc=falling: 떡밥 회수', () => {
        const sys = buildDraftSystem(arc('falling'));
        expect(sys).toContain('하강 박자');
        expect(sys).toContain('떡밥 회수');
    });
    it('arc=closing: Arc Promise 정산 + cliffhanger', () => {
        const sys = buildDraftSystem(arc('closing'));
        expect(sys).toContain('종결 박자');
        expect(sys).toContain('Arc Promise');
        expect(sys).toContain('cliffhanger');
    });
    it('manifest 규칙은 모든 모드에서 유지', () => {
        for (const p of ['opening', 'rising', 'midpoint', 'falling', 'closing']) {
            const sys = buildDraftSystem(arc(p));
            expect(sys).toContain('⟦vle:cast-manifest');
            expect(sys).toContain('characterId');
        }
        expect(buildDraftSystem()).toContain('⟦vle:cast-manifest');
    });
});
