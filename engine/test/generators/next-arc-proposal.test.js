import { describe, expect, it, vi } from '../_support/vitest-shim.mjs';
import { runNextArcProposal } from '../../src/generators/text/steps/next-arc-proposal.js';
const writerModel = { provider: 'openai', modelId: 'gpt-5.4-mini-2026-03-17' };
const currentArc = {
    arcId: 'arc1',
    arcNumber: 1,
    title: 'Arc 1',
    summary: '',
    promise: '주인공이 게이트를 정복한다',
    type: 'standard',
    estimatedEpisodes: 10,
    currentPosition: 'closing',
    currentChapterInArc: 9,
};
const baseInput = {
    currentArc,
    workSummary: '주인공이 게이트를 차례로 정복하며 동료를 모은다.',
    characters: [{ id: 'c1', canonicalName: '윤서', role: 'protagonist' }],
    entities: [{ kind: 'location', canonicalName: '강남 게이트' }],
    workMeta: { genre: 'streaming-litrpg', targetChapters: 100, totalChaptersSoFar: 10 },
    writerModel,
};
function mockProviders(text) {
    return {
        register: vi.fn(),
        has: vi.fn(),
        complete: vi.fn(async () => ({
            text,
            usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
        })),
    };
}
describe('runNextArcProposal', () => {
    it('valid LLM response → coerced proposal', async () => {
        const providers = mockProviders(JSON.stringify({
            arcNumber: 2,
            title: '신의 영역',
            promise: '주인공이 신을 만난다',
            type: 'volume',
            estimatedEpisodes: 20,
            scopedEntities: [{ kind: 'location', canonicalName: '신전', reason: '새 무대' }],
            carryOverCharacters: ['c1'],
            newCharacterSeeds: [{ canonicalName: '대제사장', role: 'mentor', contradiction: '신과 거리' }],
            transitionHook: '하늘이 열렸다',
        }));
        const r = await runNextArcProposal({ ...baseInput, providers });
        expect(r).not.toBeNull();
        expect(r.arcNumber).toBe(2);
        expect(r.title).toBe('신의 영역');
        expect(r.type).toBe('volume');
        expect(r.estimatedEpisodes).toBe(20);
        expect(r.scopedEntities).toHaveLength(1);
        expect(r.carryOverCharacters).toEqual(['c1']);
        expect(r.transitionHook).toBe('하늘이 열렸다');
        const req = providers.complete.mock.calls[0][0];
        expect(req.step).toBe('next-arc-proposal');
        expect(req.jsonMode).toBe(true);
    });
    it('LLM throw → null', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => {
                throw new Error('rate');
            }),
        };
        const r = await runNextArcProposal({ ...baseInput, providers });
        expect(r).toBeNull();
    });
    it('malformed JSON → null', async () => {
        const providers = mockProviders('{bogus');
        const r = await runNextArcProposal({ ...baseInput, providers });
        expect(r).toBeNull();
    });
    it('missing required fields (title/promise) → null', async () => {
        const providers = mockProviders(JSON.stringify({ arcNumber: 2 }));
        const r = await runNextArcProposal({ ...baseInput, providers });
        expect(r).toBeNull();
    });
    it('estimatedEpisodes out of range → clamped to default 12', async () => {
        const providers = mockProviders(JSON.stringify({
            title: 't',
            promise: 'p',
            type: 'standard',
            estimatedEpisodes: 999,
        }));
        const r = await runNextArcProposal({ ...baseInput, providers });
        expect(r.estimatedEpisodes).toBe(12);
    });
    it('unknown type → clamped to "standard"', async () => {
        const providers = mockProviders(JSON.stringify({ title: 't', promise: 'p', type: 'bogus' }));
        const r = await runNextArcProposal({ ...baseInput, providers });
        expect(r.type).toBe('standard');
    });
    it('arcNumber missing → uses currentArc.arcNumber + 1', async () => {
        const providers = mockProviders(JSON.stringify({ title: 't', promise: 'p' }));
        const r = await runNextArcProposal({ ...baseInput, providers });
        expect(r.arcNumber).toBe(2);
    });
    it('proposalModel override is used', async () => {
        const providers = mockProviders(JSON.stringify({ title: 't', promise: 'p' }));
        await runNextArcProposal({
            ...baseInput,
            providers,
            proposalModel: { provider: 'anthropic', modelId: 'haiku-4-5' },
        });
        const req = providers.complete.mock.calls[0][0];
        expect(req.model.modelId).toBe('haiku-4-5');
    });
    it('passes bounded character narrative seeds into proposal planning', async () => {
        const providers = mockProviders(JSON.stringify({ title: 't', promise: 'p', carryOverCharacters: ['c1'] }));
        await runNextArcProposal({
            ...baseInput,
            characterArcSeeds: '- c1/윤서 (complicated)\n  남은 압력: 동료를 믿고 지휘할 수 있는가\n  근거: 9화에서 지휘권을 넘겼다 [choice-9]',
            providers,
        });
        const prompt = providers.complete.mock.calls[0][0].messages.map((message) => message.content).join('\n');
        expect(prompt).toMatch(/동료를 믿고 지휘할 수 있는가/);
        expect(prompt).toMatch(/choice-9/);
        expect(prompt).toMatch(/resolved 질문은 반복하지 않는다/);
    });
    it('scopedEntities/newCharacterSeeds capped (>20 / >10)', async () => {
        const big = Array.from({ length: 30 }, (_, i) => ({
            kind: 'location',
            canonicalName: `loc${i}`,
        }));
        const bigC = Array.from({ length: 20 }, (_, i) => ({ canonicalName: `n${i}` }));
        const providers = mockProviders(JSON.stringify({
            title: 't',
            promise: 'p',
            scopedEntities: big,
            newCharacterSeeds: bigC,
        }));
        const r = await runNextArcProposal({ ...baseInput, providers });
        expect(r.scopedEntities).toHaveLength(20);
        expect(r.newCharacterSeeds).toHaveLength(10);
    });
});
