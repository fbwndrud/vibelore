import { describe, expect, it, vi } from '../_support/vitest-shim.mjs';
import { runChapterSummary } from '../../src/generators/text/steps/chapter-summary.js';
const writerModel = { provider: 'openai', modelId: 'gpt-5.4-mini-2026-03-17' };
const SAMPLE_PROSE = '주인공이 동굴 입구에서 멈췄다. 어둠 너머의 빛이 천천히 다가왔다. 그는 칼자루를 쥐었다.';
describe('runChapterSummary', () => {
    it('returns LLM result when JSON is well-formed', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: JSON.stringify({
                    summary: '주인공이 동굴에서 적과 마주친다.',
                    plotBeat: 'rising',
                    sceneTags: ['전투', '긴장'],
                    povCharacter: 'c1',
                }),
                usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            })),
        };
        const r = await runChapterSummary({
            prose: SAMPLE_PROSE,
            chapterNumber: 5,
            writerModel,
            providers,
        });
        expect(r.summary).toBe('주인공이 동굴에서 적과 마주친다.');
        expect(r.plotBeat).toBe('rising');
        expect(r.sceneTags).toEqual(['전투', '긴장']);
        expect(r.povCharacter).toBe('c1');
        const req = providers.complete.mock.calls[0][0];
        expect(req.step).toBe('chapter-summary');
        expect(req.jsonMode).toBe(true);
    });
    it('LLM throws → fallback summary derived from prose (truncated)', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => {
                throw new Error('rate limit');
            }),
        };
        const r = await runChapterSummary({
            prose: SAMPLE_PROSE,
            chapterNumber: 5,
            writerModel,
            providers,
            targetChars: 30,
        });
        expect(r.summary.length).toBeLessThanOrEqual(30);
        expect(r.plotBeat).toBeNull();
        expect(r.sceneTags).toEqual([]);
        expect(r.povCharacter).toBeNull();
    });
    it('malformed JSON → fallback summary, empty meta', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: '{bogus',
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
        };
        const r = await runChapterSummary({
            prose: SAMPLE_PROSE,
            chapterNumber: 5,
            writerModel,
            providers,
        });
        expect(r.summary.length).toBeGreaterThan(0);
        expect(r.plotBeat).toBeNull();
    });
    it('code-fenced JSON parsed correctly', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: '```json\n{"summary":"요약본","plotBeat":null,"sceneTags":[],"povCharacter":null}\n```',
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
        };
        const r = await runChapterSummary({
            prose: SAMPLE_PROSE,
            chapterNumber: 5,
            writerModel,
            providers,
        });
        expect(r.summary).toBe('요약본');
    });
    it('sceneTags clamped to 5 entries', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: JSON.stringify({
                    summary: 's',
                    plotBeat: null,
                    sceneTags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
                    povCharacter: null,
                }),
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
        };
        const r = await runChapterSummary({
            prose: SAMPLE_PROSE,
            chapterNumber: 5,
            writerModel,
            providers,
        });
        expect(r.sceneTags).toHaveLength(5);
    });
    it('summaryModel override is used when supplied', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text: JSON.stringify({ summary: 's', plotBeat: null, sceneTags: [], povCharacter: null }),
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
        };
        await runChapterSummary({
            prose: SAMPLE_PROSE,
            chapterNumber: 5,
            writerModel,
            summaryModel: { provider: 'anthropic', modelId: 'haiku-4-5' },
            providers,
        });
        const req = providers.complete.mock.calls[0][0];
        expect(req.model.provider).toBe('anthropic');
        expect(req.model.modelId).toBe('haiku-4-5');
    });
});
