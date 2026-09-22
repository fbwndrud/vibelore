import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { DEFAULT_ERA_RESEARCH_BUDGET, NULL_ERA_RESEARCH_PROVIDER, runEraResearch, } from '../../src/core/era-research.js';
function makeMockProvider(verdicts) {
    let i = 0;
    const provider = {
        provider: 'mock',
        callCount: 0,
        research: async () => {
            const verdict = verdicts[i++] ?? 'unknown';
            provider.callCount++;
            return {
                verdict,
                sources: ['https://example.com/era'],
                explanation: `mock-${verdict}`,
            };
        },
    };
    return provider;
}
describe('runEraResearch', () => {
    it('null provider → violations [] (skip)', async () => {
        const { violations, budgetAfter } = await runEraResearch({
            era: '1920년대 경성',
            claims: ['전차가 종로를 달렸다.'],
            chapterNumber: 1,
            provider: NULL_ERA_RESEARCH_PROVIDER,
            budget: { ...DEFAULT_ERA_RESEARCH_BUDGET },
        });
        expect(violations).toEqual([]);
        // null 응답이어도 호출은 1회 카운트 (budget 소진).
        expect(budgetAfter.used).toBe(1);
    });
    it('mock provider supports → violations []', async () => {
        const provider = makeMockProvider(['supports']);
        const { violations, budgetAfter } = await runEraResearch({
            era: '1920년대 경성',
            claims: ['전차가 종로를 달렸다.'],
            chapterNumber: 1,
            provider,
            budget: { maxCalls: 1, used: 0 },
        });
        expect(violations).toEqual([]);
        expect(provider.callCount).toBe(1);
        expect(budgetAfter.used).toBe(1);
    });
    it('mock provider contradicts → ERA_FIDELITY_CONFLICT SOFT violation', async () => {
        const provider = makeMockProvider(['contradicts']);
        const { violations } = await runEraResearch({
            era: '1920년대 경성',
            claims: ['전차가 종로에서 스마트폰을 검색했다.'],
            chapterNumber: 3,
            provider,
            budget: { maxCalls: 1, used: 0 },
        });
        expect(violations).toHaveLength(1);
        expect(violations[0].severity).toBe('soft');
        expect(violations[0].code).toBe('ERA_FIDELITY_CONFLICT');
        expect(violations[0].chapterNumber).toBe(3);
        expect(violations[0].message).toContain('시대 고증 충돌');
        expect(violations[0].message).toContain('1920년대 경성');
        expect(violations[0].message).toContain('mock-contradicts');
        expect(violations[0].message).toContain('sources:');
    });
    it('budget=1, 3 claims → 첫 1만 호출됨', async () => {
        const provider = makeMockProvider(['contradicts', 'contradicts', 'contradicts']);
        const { violations, budgetAfter } = await runEraResearch({
            era: '조선 후기',
            claims: ['claim A', 'claim B', 'claim C'],
            chapterNumber: 1,
            provider,
            budget: { maxCalls: 1, used: 0 },
        });
        expect(provider.callCount).toBe(1);
        expect(budgetAfter.used).toBe(1);
        expect(violations).toHaveLength(1);
    });
    it('budget exhausted (used >= max) → 호출 0회', async () => {
        const provider = makeMockProvider(['contradicts']);
        const { violations, budgetAfter } = await runEraResearch({
            era: '근대',
            claims: ['claim A', 'claim B'],
            chapterNumber: 1,
            provider,
            budget: { maxCalls: 2, used: 2 },
        });
        expect(provider.callCount).toBe(0);
        expect(budgetAfter.used).toBe(2);
        expect(violations).toEqual([]);
    });
    it('unknown verdict → violation 안 만듦 (잠정 verdict 신뢰 X)', async () => {
        const provider = makeMockProvider(['unknown']);
        const { violations } = await runEraResearch({
            era: '미래',
            claims: ['모호한 묘사'],
            chapterNumber: 1,
            provider,
            budget: { maxCalls: 1, used: 0 },
        });
        expect(violations).toEqual([]);
    });
});
