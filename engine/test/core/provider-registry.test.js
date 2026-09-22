/**
 * Tests for createProviderRegistry + the 4 provider adapter shapes.
 *
 * These tests verify wiring only — no real API calls. Each adapter is
 * exercised via a mock that records the LLMRequest passed in.
 */
import { describe, it, expect, vi } from '../_support/vitest-shim.mjs';
import { createProviderRegistry, } from '../../src/core/provider-registry.js';
// SDK provider 어댑터는 이식 제외(NEP-S1 D2). 이 블록이 단언하는 어댑터 표면
// (provider id + apiKey-required 생성자 계약)만 미러하는 로컬 fake {provider, complete}.
class FakeAdapter {
    constructor(provider, envVar, opts = {}) {
        const apiKey = opts.apiKey ?? (envVar ? process.env[envVar] : undefined);
        if (!apiKey) {
            throw new Error(`${provider} adapter: apiKey required (set ${envVar} or pass options.apiKey)`);
        }
        this.provider = provider;
        this._apiKey = apiKey;
    }
    async complete(_req) {
        return { text: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    }
}
class OpenAIAdapter extends FakeAdapter {
    constructor(opts) { super('openai', 'OPENAI_API_KEY', opts); }
}
class AnthropicAdapter extends FakeAdapter {
    constructor(opts) { super('anthropic', 'ANTHROPIC_API_KEY', opts); }
}
class GoogleAdapter extends FakeAdapter {
    constructor(opts) { super('google', 'GOOGLE_API_KEY', opts); }
}
class XAIAdapter extends FakeAdapter {
    constructor(opts) { super('xai', 'XAI_API_KEY', opts); }
}
function makeMockAdapter(provider, reply = {
    text: `hello from ${provider}`,
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
}) {
    const calls = [];
    return {
        provider,
        calls,
        async complete(req) {
            calls.push(req);
            return reply;
        },
    };
}
function req(provider, modelId = 'test-model-2026-01-01') {
    return {
        model: { provider, modelId },
        messages: [{ role: 'user', content: 'ping' }],
    };
}
describe('createProviderRegistry', () => {
    it('throws when completing against an unregistered provider', async () => {
        const reg = createProviderRegistry();
        await expect(reg.complete(req('openai'))).rejects.toThrow(/not registered: openai/);
    });
    it('dispatches to the registered adapter and returns its response', async () => {
        const reg = createProviderRegistry();
        const mock = makeMockAdapter('openai');
        reg.register(mock);
        const r = req('openai');
        const out = await reg.complete(r);
        expect(out.text).toBe('hello from openai');
        expect(out.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
        expect(mock.calls).toHaveLength(1);
        expect(mock.calls[0]).toBe(r);
    });
    it('reflects registered/unregistered providers via has()', () => {
        const reg = createProviderRegistry();
        expect(reg.has('openai')).toBe(false);
        expect(reg.has('anthropic')).toBe(false);
        reg.register(makeMockAdapter('openai'));
        expect(reg.has('openai')).toBe(true);
        expect(reg.has('anthropic')).toBe(false);
    });
    it('upserts on register — same provider id replaces previous adapter', async () => {
        const reg = createProviderRegistry();
        const first = makeMockAdapter('google', {
            text: 'first',
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        });
        const second = makeMockAdapter('google', {
            text: 'second',
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        });
        reg.register(first);
        reg.register(second);
        const out = await reg.complete(req('google'));
        expect(out.text).toBe('second');
        expect(first.calls).toHaveLength(0);
        expect(second.calls).toHaveLength(1);
    });
    it('registers all adapters passed via the constructor', () => {
        const reg = createProviderRegistry([
            makeMockAdapter('openai'),
            makeMockAdapter('anthropic'),
            makeMockAdapter('google'),
            makeMockAdapter('xai'),
        ]);
        expect(reg.has('openai')).toBe(true);
        expect(reg.has('anthropic')).toBe(true);
        expect(reg.has('google')).toBe(true);
        expect(reg.has('xai')).toBe(true);
    });
    it('routes by req.model.provider, not by registration order', async () => {
        const openaiMock = makeMockAdapter('openai', {
            text: 'O',
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        });
        const anthMock = makeMockAdapter('anthropic', {
            text: 'A',
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        });
        const reg = createProviderRegistry([openaiMock, anthMock]);
        expect((await reg.complete(req('anthropic'))).text).toBe('A');
        expect((await reg.complete(req('openai'))).text).toBe('O');
        expect(openaiMock.calls).toHaveLength(1);
        expect(anthMock.calls).toHaveLength(1);
    });
});
describe('adapter `provider` ids', () => {
    // Each adapter constructor reads env if no apiKey passed — set a fake key
    // so the constructor doesn't throw. No network call is made because we
    // never invoke .complete() in this block.
    it('OpenAIAdapter.provider === "openai"', () => {
        const a = new OpenAIAdapter({ apiKey: 'sk-test' });
        expect(a.provider).toBe('openai');
    });
    it('AnthropicAdapter.provider === "anthropic"', () => {
        const a = new AnthropicAdapter({ apiKey: 'sk-test' });
        expect(a.provider).toBe('anthropic');
    });
    it('GoogleAdapter.provider === "google"', () => {
        const a = new GoogleAdapter({ apiKey: 'sk-test' });
        expect(a.provider).toBe('google');
    });
    it('XAIAdapter.provider === "xai"', () => {
        const a = new XAIAdapter({ apiKey: 'sk-test' });
        expect(a.provider).toBe('xai');
    });
    it('OpenAIAdapter throws when no apiKey is available', () => {
        const prev = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;
        try {
            expect(() => new OpenAIAdapter()).toThrow(/apiKey required/);
        }
        finally {
            if (prev !== undefined)
                process.env.OPENAI_API_KEY = prev;
        }
    });
});
describe('adapter integration through registry', () => {
    it('XAIAdapter routes through the registry as provider=xai', async () => {
        // Use a stub that mirrors the XAIAdapter surface — the real one would
        // hit network on .complete(). Here we just verify provider routing.
        const stub = {
            provider: 'xai',
            complete: vi.fn(async (_r) => ({
                text: 'grok-stub',
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
        };
        const reg = createProviderRegistry([stub]);
        const out = await reg.complete(req('xai', 'grok-test'));
        expect(out.text).toBe('grok-stub');
        expect(stub.complete).toHaveBeenCalledTimes(1);
    });
});
