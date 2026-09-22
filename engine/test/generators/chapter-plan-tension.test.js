/**
 * chapter-plan tension 슬롯 — EPIC #364 S3 (#367). plan §3.1.
 *
 * 검증 대상:
 *   - coerceTension: malformed/missing → {} (legacy 호환 fallback), 빈 string → undefined.
 *   - parsePlanPayload: tension 키가 ChapterPlanOutput 에 흡수되는지 + legacy payload 무회귀.
 *   - systemPromptFor: arc position 별 escalation/stake 강조 차등.
 *   - buildDraftUserPrompt: tension 이 plan 직렬화에 포함되는지.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { PLAN_TENSION_RULE, coerceOpeningContract, coerceTension, parsePlanPayload, planTensionEmphasis, systemPromptFor, } from '../../src/generators/text/steps/chapter-plan.js';
import { buildDraftUserPrompt, } from '../../src/generators/text/prompts/draft.js';
import { evaluateOpeningContract } from '../../src/generators/text/steps/cold-open-beat.js';
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
describe('coerceTension', () => {
    it('undefined → {}', () => {
        expect(coerceTension(undefined)).toEqual({});
    });
    it('null → {}', () => {
        expect(coerceTension(null)).toEqual({});
    });
    it('non-object (string/number/array) → {} (malformed fallback)', () => {
        expect(coerceTension('ticking')).toEqual({});
        expect(coerceTension(42)).toEqual({});
        expect(coerceTension(['ticking'])).toEqual({});
    });
    it('empty object → {}', () => {
        expect(coerceTension({})).toEqual({});
    });
    it('fills only provided non-empty string fields', () => {
        const t = coerceTension({ ticking: '자정까지 해독해야 한다', stake: '동생의 목숨' });
        expect(t).toEqual({ ticking: '자정까지 해독해야 한다', stake: '동생의 목숨' });
        expect(t.escalation).toBeUndefined();
    });
    it('empty/whitespace string → undefined (optional 의미 보존)', () => {
        const t = coerceTension({ ticking: '', stake: '   ', escalation: '추격자가 둘로 늘었다' });
        expect(t.ticking).toBeUndefined();
        expect(t.stake).toBeUndefined();
        expect(t.escalation).toBe('추격자가 둘로 늘었다');
    });
    it('non-string field values → dropped', () => {
        const t = coerceTension({ ticking: 5, stake: { x: 1 }, escalation: true });
        expect(t).toEqual({});
    });
    it('trims surrounding whitespace', () => {
        expect(coerceTension({ stake: '  명예  ' })).toEqual({ stake: '명예' });
    });
});
describe('parsePlanPayload — tension', () => {
    it('parses tension from full JSON payload', () => {
        const text = JSON.stringify({
            plan: '주인공이 단서를 쫓는다.',
            scene: { settings: [], characters: [], items: [], antagonists: [], additionalRefs: [] },
            tension: { escalation: '위협이 커진다' },
        });
        const out = parsePlanPayload(text);
        expect(out.tension).toEqual({ escalation: '위협이 커진다' });
        expect(out.plan).toBe('주인공이 단서를 쫓는다.');
    });
    it('legacy payload (no tension key) → tension {} (0 regression)', () => {
        const text = JSON.stringify({
            plan: '평범한 전개.',
            scene: { settings: [], characters: [], items: [], antagonists: [], additionalRefs: [] },
        });
        const out = parsePlanPayload(text);
        expect(out.tension).toEqual({});
        expect(out.openingContract).toEqual({});
        expect(out.plan).toBe('평범한 전개.');
    });
    it('malformed tension → {} (raw non-object)', () => {
        const text = JSON.stringify({ plan: 'x', tension: 'oops' });
        expect(parsePlanPayload(text).tension).toEqual({});
    });
    it('non-JSON text → tension {} and raw plan fallback', () => {
        const out = parsePlanPayload('이건 그냥 산문이다');
        expect(out.tension).toEqual({});
        expect(out.plan).toBe('이건 그냥 산문이다');
    });
    it('empty text → tension {}', () => {
        expect(parsePlanPayload('').tension).toEqual({});
    });
});

describe('parsePlanPayload — openingContract', () => {
    it('parses 1화 오프닝 계약 fields', () => {
        const text = JSON.stringify({
            plan: '첫 장면에서 제도의 압력을 보여 준다.',
            openingContract: {
                surfaceEvent: '주인공이 배급 심사에서 탈락한다',
                worldPressure: '도시는 미궁 자원 배급권으로 시민을 통제한다',
                characterWound: '주인공은 구조받지 못한 동료를 떠올린다',
                misbelief: '규칙을 지키면 인정받는다고 믿는다',
                firstIrreversibleChoice: '기록석 조작을 공개한다',
                withheldContext: '미궁 핵의 정체는 설명하지 않는다',
                viewpointReason: '제도 밖에서 밀려난 감각을 주인공만 체감한다',
            },
        });
        expect(parsePlanPayload(text).openingContract).toEqual({
            surfaceEvent: '주인공이 배급 심사에서 탈락한다',
            worldPressure: '도시는 미궁 자원 배급권으로 시민을 통제한다',
            characterWound: '주인공은 구조받지 못한 동료를 떠올린다',
            misbelief: '규칙을 지키면 인정받는다고 믿는다',
            firstIrreversibleChoice: '기록석 조작을 공개한다',
            withheldContext: '미궁 핵의 정체는 설명하지 않는다',
            viewpointReason: '제도 밖에서 밀려난 감각을 주인공만 체감한다',
        });
    });
    it('malformed openingContract → {}', () => {
        expect(coerceOpeningContract(null)).toEqual({});
        expect(coerceOpeningContract('oops')).toEqual({});
        expect(coerceOpeningContract([])).toEqual({});
    });
    it('drops blank and non-string fields', () => {
        expect(coerceOpeningContract({ worldPressure: '  압력  ', misbelief: '', surfaceEvent: 3 })).toEqual({ worldPressure: '압력' });
    });
});

describe('evaluateOpeningContract', () => {
    it('passes a complete opening contract', () => {
        const result = evaluateOpeningContract({
            surfaceEvent: '배급 심사에서 주인공이 탈락한다',
            worldPressure: '도시는 미궁 자원 배급권으로 시민을 통제한다',
            characterWound: '주인공은 구조하지 못한 동료의 죽음을 아직 장부로 처리하지 못했다',
            misbelief: '규칙을 정확히 따르면 제도가 자신을 인정한다고 믿는다',
            firstIrreversibleChoice: '조작된 기록석을 공개한다',
            withheldContext: '미궁 핵의 제작자와 귀환 조건은 밝히지 않는다',
            viewpointReason: '제도 밖으로 밀려난 감각을 주인공의 관찰로만 체감시킬 수 있다',
        });
        expect(result.pass).toBe(true);
        expect(result.missing).toEqual([]);
        expect(result.shallow).toEqual([]);
    });
    it('reports missing and shallow fields', () => {
        const result = evaluateOpeningContract({
            surfaceEvent: '사건',
            worldPressure: '압력',
            characterWound: '',
            misbelief: '오해',
            firstIrreversibleChoice: '선택',
            withheldContext: '비밀',
            viewpointReason: '시점',
        });
        expect(result.pass).toBe(false);
        expect(result.missing).toContain('characterWound');
        expect(result.shallow).toContain('worldPressure');
        expect(result.shallow).toContain('misbelief');
        expect(result.shallow).toContain('viewpointReason');
    });
});
describe('systemPromptFor — tension emphasis per arc position', () => {
    it('always includes the base tension rule (legacy / no arc)', () => {
        const sys = systemPromptFor(2);
        expect(sys).toContain(PLAN_TENSION_RULE);
        expect(sys).toContain('ticking');
        expect(sys).toContain('stake');
        expect(sys).toContain('escalation');
    });
    it('chapter 1 prompt asks for openingContract', () => {
        const sys = systemPromptFor(1);
        expect(sys).toContain('openingContract');
        expect(sys).toContain('worldPressure');
        expect(sys).toContain('viewpointReason');
    });
    it('rising → escalation 강제 강조', () => {
        const sys = systemPromptFor(3, arc('rising'));
        expect(sys).toContain('tension.escalation 은 이 박자에서 반드시 채운다');
    });
    it('midpoint → escalation 강제 강조', () => {
        const sys = systemPromptFor(5, arc('midpoint'));
        expect(sys).toContain('tension.escalation 은 이 박자에서 반드시 채운다');
    });
    it('closing → stake 정산 강조', () => {
        const sys = systemPromptFor(9, arc('closing'));
        expect(sys).toContain('tension.stake 는 이 박자에서 반드시 채운다');
        expect(sys).not.toContain('tension.escalation 은 이 박자에서 반드시 채운다');
    });
    it('opening / falling → no forced emphasis (all optional)', () => {
        for (const p of ['opening', 'falling']) {
            const sys = systemPromptFor(2, arc(p));
            expect(sys).toContain(PLAN_TENSION_RULE);
            expect(sys).not.toContain('반드시 채운다');
        }
    });
});
describe('planTensionEmphasis', () => {
    it('rising/midpoint → escalation', () => {
        expect(planTensionEmphasis('rising')).toContain('escalation');
        expect(planTensionEmphasis('midpoint')).toContain('escalation');
    });
    it('closing → stake', () => {
        expect(planTensionEmphasis('closing')).toContain('stake');
    });
    it('opening/falling/undefined → empty', () => {
        expect(planTensionEmphasis('opening')).toBe('');
        expect(planTensionEmphasis('falling')).toBe('');
        expect(planTensionEmphasis(undefined)).toBe('');
    });
});
describe('buildDraftUserPrompt — tension serialization', () => {
    const base = {
        chapterNumber: 4,
        language: 'ko',
        foundation: { genre: 'fantasy', worldFacts: [], characters: [] },
        prevState: { chapterNumber: 3, addressMapKeys: [], hooks: [] },
        plan: { goal: 'g', beats: ['b1'] },
        targetWordCount: 2000,
    };
    it('includes tension fields in serialized plan when present', () => {
        const prompt = buildDraftUserPrompt({
            ...base,
            plan: {
                goal: 'g',
                beats: ['b1'],
                tension: { ticking: '자정까지', stake: '동생', escalation: '추격자 증원' },
            },
        });
        expect(prompt).toContain('"ticking": "자정까지"');
        expect(prompt).toContain('"stake": "동생"');
        expect(prompt).toContain('"escalation": "추격자 증원"');
    });
    it('legacy plan (no tension) serializes without tension key (0 regression)', () => {
        const prompt = buildDraftUserPrompt(base);
        expect(prompt).not.toContain('tension');
    });
});
