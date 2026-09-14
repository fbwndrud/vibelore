/**
 * draft prompt few-shot + reader-legibility rules.
 *
 * 검증 대상:
 *   - DRAFT_SYSTEM: 감정 표현, 핵심 개념의 표면 뜻, 문단 호흡을 모델 판단으로
 *     유지하는 positive guidance가 포함되는지.
 *   - DRAFT_FEWSHOT: 자작 한국어 showing exemplar + 1줄 해설 포함 + 과도하게 길지
 *     않은지 (각 예시 5문장 이내 운영 가드).
 *   - buildDraftSystem (runtime): showing 규칙 + few-shot 이 매 화 system 에 들어가고,
 *     기존 sentinel(cast-manifest)·arc 박자 동작은 무회귀.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { DRAFT_SYSTEM, DRAFT_FEWSHOT } from '../../src/generators/text/prompts/draft.js';
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
describe('DRAFT_SYSTEM — reader-legibility guidance', () => {
    it('행동·감각을 우선하되 필요한 짧은 감정 명시는 허용한다', () => {
        expect(DRAFT_SYSTEM).toContain('행동·감각');
        expect(DRAFT_SYSTEM).toContain('짧은 명시는 자연스럽게');
    });
    it('처음 등장한 핵심 개념의 표면 뜻을 잡아 준다', () => {
        expect(DRAFT_SYSTEM).toContain('처음 등장한 핵심 개념');
        expect(DRAFT_SYSTEM).toContain('표면 뜻');
    });
    it('원인·반응·결과가 한 박자면 짧은 서술 문단을 묶는다', () => {
        expect(DRAFT_SYSTEM).toContain('원인·반응·결과');
        expect(DRAFT_SYSTEM).toContain('한 문단에 묶어');
    });
    it('기존 sentinel 포맷·tension 규칙은 무회귀', () => {
        expect(DRAFT_SYSTEM).toContain('⟦vle:cast-manifest⟧');
        expect(DRAFT_SYSTEM).toContain('plan.tension');
    });
});
describe('DRAFT_FEWSHOT — 자작 showing exemplar', () => {
    it('non-empty 산문 + 1줄 해설("단어 없이" 류)', () => {
        expect(DRAFT_FEWSHOT.length).toBeGreaterThan(0);
        expect(DRAFT_FEWSHOT).toContain('예시');
        // 해설 라인: 어떤 감정을 단어 없이 표현했는지 명시
        expect(DRAFT_FEWSHOT).toContain('두려움');
        expect(DRAFT_FEWSHOT).toMatch(/단어 없이|그 단어 없이|설명 없이/);
    });
    it('감정 직접진술 단어를 본문 산문에 쓰지 않는다 (해설 라인 제외)', () => {
        // 해설은 괄호로 시작 — 거기서 '두려움' 등 메타 라벨을 쓰는 건 허용.
        const proseLines = DRAFT_FEWSHOT.split('\n').filter((l) => l.length > 0 && !l.trimStart().startsWith('(') && !l.startsWith('['));
        const prose = proseLines.join('\n');
        // 모범 산문 자체에는 '두려웠다/슬펐다' 같은 직접 감정 진술이 없어야 한다.
        expect(prose).not.toContain('두려웠다');
        expect(prose).not.toContain('슬펐다');
    });
    it('각 예시는 과도하게 길지 않다 (운영 가드 — 예시 산문 5문장 이내)', () => {
        // [예시 N] 헤더로 분할 후, 해설(괄호)·헤더 제외한 산문 문장 수 세기.
        const blocks = DRAFT_FEWSHOT.split(/\[예시 \d+\]/).slice(1);
        expect(blocks.length).toBeGreaterThanOrEqual(1);
        for (const block of blocks) {
            const proseLine = block
                .split('\n')
                .find((l) => l.length > 0 && !l.trimStart().startsWith('(') && !l.startsWith('['));
            expect(proseLine).toBeDefined();
            const sentences = (proseLine ?? '').split(/(?<=[.?!"」])\s+/).filter((s) => s.trim().length > 0);
            expect(sentences.length).toBeLessThanOrEqual(5);
        }
    });
});
describe('buildDraftSystem — legibility 규칙 + few-shot 매 화 적용', () => {
    it('legacy (arc undefined): legibility 규칙 + few-shot 포함', () => {
        const sys = buildDraftSystem();
        expect(sys).toContain('행동·감각');
        expect(sys).toContain('서술과 독자 이해 규칙');
        expect(sys).toContain('처음 등장한 핵심 개념');
        expect(sys).toContain('예시');
    });
    it('모든 arc 박자에서 legibility 규칙 + few-shot 유지 (박자 무관)', () => {
        for (const p of ['opening', 'rising', 'midpoint', 'falling', 'closing']) {
            const sys = buildDraftSystem(arc(p));
            expect(sys).toContain('서술과 독자 이해 규칙');
            expect(sys).toContain('예시');
            // 기존 sentinel 무회귀
            expect(sys).toContain('⟦vle:cast-manifest');
        }
    });
    it('few-shot 은 DRAFT_FEWSHOT 상수를 그대로 반영', () => {
        expect(buildDraftSystem(arc('rising'))).toContain(DRAFT_FEWSHOT);
    });
});
