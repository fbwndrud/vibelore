import { describe, expect, it, vi } from '../_support/vitest-shim.mjs';
import { runCoherenceJudge } from '../../src/generators/text/steps/coherence-judge.js';
const writerModel = { provider: 'openai', modelId: 'gpt-5.4-mini-2026-03-17' };
const SAMPLE = '주인공이 동굴 입구에서 멈췄다. 어둠 너머 빛이 보였다.';
describe('runCoherenceJudge', () => {
    it('valid response → score + reason', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: JSON.stringify({ score: 85, reason: '본문이 plan 의도 잘 따름.' }),
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
        };
        const r = await runCoherenceJudge({
            prose: SAMPLE,
            chapterNumber: 5,
            writerModel,
            providers,
        });
        expect(r.score).toBe(85);
        expect(r.reason).toMatch(/plan/);
        const req = providers.complete.mock.calls[0][0];
        expect(req.step).toBe('coherence-judge');
        expect(req.jsonMode).toBe(true);
    });
    it('LLM throw → score null', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => {
                throw new Error('rate');
            }),
        };
        const r = await runCoherenceJudge({
            prose: SAMPLE,
            chapterNumber: 5,
            writerModel,
            providers,
        });
        expect(r.score).toBeNull();
        expect(r.reason).toBeNull();
    });
    it('malformed JSON → score null', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({ text: '{bogus', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } })),
        };
        const r = await runCoherenceJudge({
            prose: SAMPLE,
            chapterNumber: 5,
            writerModel,
            providers,
        });
        expect(r.score).toBeNull();
    });
    it('out-of-range score → null', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: JSON.stringify({ score: 150, reason: 'x' }),
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
        };
        const r = await runCoherenceJudge({
            prose: SAMPLE,
            chapterNumber: 5,
            writerModel,
            providers,
        });
        expect(r.score).toBeNull();
    });
    it('judgeModel override is used when supplied', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: JSON.stringify({ score: 50, reason: null }),
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
        };
        await runCoherenceJudge({
            prose: SAMPLE,
            chapterNumber: 5,
            writerModel,
            judgeModel: { provider: 'anthropic', modelId: 'haiku-4-5' },
            providers,
        });
        const req = providers.complete.mock.calls[0][0];
        expect(req.model.modelId).toBe('haiku-4-5');
    });
    it('rounds float score to integer', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: JSON.stringify({ score: 72.7, reason: 'x' }),
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
        };
        const r = await runCoherenceJudge({
            prose: SAMPLE,
            chapterNumber: 5,
            writerModel,
            providers,
        });
        expect(r.score).toBe(73);
    });
});
