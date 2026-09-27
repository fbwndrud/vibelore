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
    it('asks about author rules and returns their verdicts', async () => {
        let seen = '';
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: async (req) => {
                seen = req.messages.at(-1).content;
                return { text: JSON.stringify({ score: 80, reason: 'ok', authorRules: [{ rule: '리아는 어머니 이야기를 먼저 꺼내지 않는다', verdict: 'fail', evidence: '"엄마가…"' }] }) };
            },
        };
        const out = await runCoherenceJudge({
            prose: '본문', chapterNumber: 3, plan: '', prevSummary: '', writerModel: {}, providers,
            authorRules: ['리아는 어머니 이야기를 먼저 꺼내지 않는다'],
        });
        expect(seen).toContain('리아는 어머니 이야기를 먼저 꺼내지 않는다');
        expect(out.authorRules[0].verdict).toBe('fail');
    });
    it('no author rules given → no authorRules key', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({ text: JSON.stringify({ score: 80, reason: 'ok' }) })),
        };
        const out = await runCoherenceJudge({ prose: SAMPLE, chapterNumber: 3, writerModel, providers });
        expect(out.authorRules).toBeUndefined();
    });
    it('malformed authorRules entry is dropped, not the whole review', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: JSON.stringify({ score: 80, reason: 'ok', authorRules: [
                    { rule: '유효', verdict: 'warn', evidence: 'x' },
                    { rule: '검증 불가', verdict: 'maybe' },
                    { verdict: 'pass' },
                ] }),
            })),
        };
        const out = await runCoherenceJudge({
            prose: SAMPLE, chapterNumber: 3, writerModel, providers, authorRules: ['유효'],
        });
        expect(out.score).toBe(80);
        expect(out.authorRules).toHaveLength(1);
        expect(out.authorRules[0]).toEqual({ rule: '유효', verdict: 'warn', evidence: 'x' });
    });
});
