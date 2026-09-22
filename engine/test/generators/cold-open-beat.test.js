/**
 * cold-open-beat — Arc Flow Stage A (EPIC #191).
 *
 * STRONG_EVENT_CATALOG + 첫 1,200자 윈도우 strong-event 키워드 lint.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { COLD_OPEN_WINDOW_CHARS, STRONG_EVENT_CATALOG, buildColdOpenInstruction, detectStrongEventInColdOpen, } from '../../src/generators/text/steps/cold-open-beat.js';
describe('STRONG_EVENT_CATALOG', () => {
    it('has 6 archetypes', () => {
        expect(STRONG_EVENT_CATALOG).toHaveLength(6);
    });
    it('every archetype has keywords + hint', () => {
        for (const a of STRONG_EVENT_CATALOG) {
            expect(a.keywords.length).toBeGreaterThan(0);
            expect(a.hint.length).toBeGreaterThan(10);
            expect(a.label.length).toBeGreaterThan(0);
        }
    });
    it('catalog ids are unique', () => {
        const ids = STRONG_EVENT_CATALOG.map((a) => a.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
describe('detectStrongEventInColdOpen', () => {
    it('detects death keyword in opening', () => {
        const prose = '아버지가 어제 죽었다. 나는 시신 앞에서 한참을 서 있었다.';
        const result = detectStrongEventInColdOpen(prose);
        expect(result.present).toBe(true);
        expect(result.matched).toContain('death');
        expect(result.firstMatchAt).toBeGreaterThanOrEqual(0);
    });
    it('detects betrayal keyword', () => {
        const prose = '친구가 나를 배신했다.';
        const result = detectStrongEventInColdOpen(prose);
        expect(result.present).toBe(true);
        expect(result.matched).toContain('betrayal');
    });
    it('detects promise keyword', () => {
        const prose = '반드시 그를 찾아내겠다고 다짐했다.';
        const result = detectStrongEventInColdOpen(prose);
        expect(result.present).toBe(true);
        expect(result.matched).toContain('promise');
    });
    it('detects fated-encounter keyword', () => {
        const prose = '지하철에서 처음 본 사람의 눈빛이 마음에 박혔다.';
        const result = detectStrongEventInColdOpen(prose);
        expect(result.present).toBe(true);
        expect(result.matched).toContain('fated-encounter');
    });
    it('returns present=false for bland opening (no strong event)', () => {
        const prose = '오늘은 평범한 하루였다. 아침을 먹고 학교에 갔다. 친구들과 점심을 먹었다.';
        const result = detectStrongEventInColdOpen(prose);
        expect(result.present).toBe(false);
        expect(result.matched).toHaveLength(0);
        expect(result.firstMatchAt).toBe(-1);
    });
    it('ignores keywords appearing AFTER the cold-open window', () => {
        // 첫 1,200자 = padding 만, 1,201자 부터 strong event → 무시.
        const padding = '평범한 일상.'.repeat(120); // ~720자
        const padding2 = '오늘 하루 정말 평온했고 햇살이 좋았다.'.repeat(20); // 추가 ~720자
        const longProse = padding + padding2 + '갑자기 그가 죽었다.';
        expect(longProse.length).toBeGreaterThan(COLD_OPEN_WINDOW_CHARS);
        const result = detectStrongEventInColdOpen(longProse);
        expect(result.present).toBe(false);
    });
    it('records multiple archetypes when several keywords appear', () => {
        const prose = '아버지가 죽었고, 친구는 나를 배신했다. 마지막 편지가 도착했다.';
        const result = detectStrongEventInColdOpen(prose);
        expect(result.matched.length).toBeGreaterThanOrEqual(2);
    });
});
describe('buildColdOpenInstruction', () => {
    it('produces a non-empty system-prompt fragment with all 6 archetype labels', () => {
        const instr = buildColdOpenInstruction();
        expect(instr.length).toBeGreaterThan(100);
        for (const a of STRONG_EVENT_CATALOG) {
            expect(instr).toContain(a.label);
        }
    });
    it('cites the 1,200자 window threshold', () => {
        expect(buildColdOpenInstruction()).toContain(String(COLD_OPEN_WINDOW_CHARS));
    });
});
