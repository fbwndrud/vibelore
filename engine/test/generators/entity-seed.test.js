import { describe, expect, it, vi } from '../_support/vitest-shim.mjs';
import { runEntitySeed } from '../../src/generators/text/steps/entity-seed.js';
const writerModel = { provider: 'openai', modelId: 'gpt-5.4-mini-2026-03-17' };
describe('runEntitySeed', () => {
    function mockProviders(text) {
        return {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => ({
                text,
                usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
            })),
        };
    }
    it('valid LLM response → entities returned', async () => {
        const providers = mockProviders(JSON.stringify({
            entities: [
                { kind: 'location', canonicalName: '강남 게이트', aliases: ['게이트1'], attrs: { tier: 'S' } },
                { kind: 'monster', canonicalName: '모래뱀', aliases: [], attrs: { level: 7 } },
            ],
        }));
        const r = await runEntitySeed({
            genre: 'streaming-litrpg',
            brief: '게이트 헌터 이야기',
            title: '게이트 헌터',
            language: 'ko',
            providers,
            writerModel,
        });
        expect(r.entities).toHaveLength(2);
        expect(r.entities[0].canonicalName).toBe('강남 게이트');
        const req = providers.complete.mock.calls[0][0];
        expect(req.step).toBe('entity-seed');
        expect(req.jsonMode).toBe(true);
    });
    it('provider throws → empty entities (fail-soft)', async () => {
        const providers = {
            register: vi.fn(),
            has: vi.fn(),
            complete: vi.fn(async () => {
                throw new Error('rate limit');
            }),
        };
        const r = await runEntitySeed({
            genre: 'streaming-litrpg',
            brief: 'x',
            title: 'x',
            language: 'ko',
            providers,
            writerModel,
        });
        expect(r.entities).toEqual([]);
    });
    it('malformed JSON → empty entities', async () => {
        const providers = mockProviders('{bogus');
        const r = await runEntitySeed({
            genre: 'streaming-litrpg',
            brief: 'x',
            title: 'x',
            language: 'ko',
            providers,
            writerModel,
        });
        expect(r.entities).toEqual([]);
    });
    it('schema validation fail → empty entities', async () => {
        const providers = mockProviders(JSON.stringify({
            entities: [{ kind: 'invalid-kind', canonicalName: 'x' }],
        }));
        const r = await runEntitySeed({
            genre: 'streaming-litrpg',
            brief: 'x',
            title: 'x',
            language: 'ko',
            providers,
            writerModel,
        });
        expect(r.entities).toEqual([]);
    });
    it('duplicate canonicalName dedupes', async () => {
        const providers = mockProviders(JSON.stringify({
            entities: [
                { kind: 'location', canonicalName: '서울' },
                { kind: 'location', canonicalName: '서울' },
                { kind: 'location', canonicalName: '부산' },
            ],
        }));
        const r = await runEntitySeed({
            genre: 'streaming-litrpg',
            brief: 'x',
            title: 'x',
            language: 'ko',
            providers,
            writerModel,
        });
        expect(r.entities).toHaveLength(2);
    });
    it('seedModel override is used when supplied', async () => {
        const providers = mockProviders(JSON.stringify({ entities: [] }));
        await runEntitySeed({
            genre: 'streaming-litrpg',
            brief: 'x',
            title: 'x',
            language: 'ko',
            providers,
            writerModel,
            seedModel: { provider: 'anthropic', modelId: 'haiku-4-5' },
        });
        const req = providers.complete.mock.calls[0][0];
        expect(req.model.modelId).toBe('haiku-4-5');
    });
});
