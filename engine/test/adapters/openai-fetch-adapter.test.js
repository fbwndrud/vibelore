/**
 * Tests for createOpenAIAdapter (fetch-based ProviderAdapter) — NEP-S2.
 *
 * fetchImpl is mocked via vi.fn; no network. Assertions verify request-body
 * shaping (json_schema strict / json_object / step-omission), usage mapping,
 * retry/backoff classification, and — critically — that thrown errors never
 * leak the API key, upstream URL, or prompt content.
 */
import { describe, it, expect, vi } from '../_support/vitest-shim.mjs';
import {
  createOpenAIAdapter,
  ProviderCallError,
} from '../../src/adapters/openai-fetch-adapter.js';

// ─── fetch Response fakes ───────────────────────────────────────────────────

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function errResponse(status, body) {
  return {
    ok: false,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

const SUCCESS_BODY = {
  choices: [{ message: { content: 'hello world' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

function baseReq(extra = {}) {
  return {
    model: { provider: 'openai', modelId: 'gpt-x' },
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
    ...extra,
  };
}

describe('createOpenAIAdapter', () => {
  // (1) 정상 응답 text/usage 매핑 + URL/method/signal/response_format 부재
  it('maps text + usage from a normal response and POSTs to /chat/completions', async () => {
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS_BODY));
    // defaultMaxTokens:null so "no max_completion_tokens when the req omits it" holds — the
    // absence assertion below measures req-shaping, not the new default (R1-b).
    const adapter = createOpenAIAdapter({
      apiKey: 'sk-test123',
      fetchImpl,
      retryDelayMs: 0,
      defaultMaxTokens: null,
    });

    expect(adapter.provider).toBe('openai');

    const res = await adapter.complete(baseReq());
    expect(res.text).toBe('hello world');
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeDefined();

    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-x');
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ]);
    // no temperature/maxTokens/response_format when not requested
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('response_format');
  });

  // (2) json_schema strict 변환 — additionalProperties:false 재귀 확인
  it('transforms jsonSchema into a strict json_schema response_format (recursively)', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    const adapter = createOpenAIAdapter({ apiKey: 'sk-x', fetchImpl, retryDelayMs: 0 });

    const jsonSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        nested: {
          type: 'object',
          properties: { x: { type: 'number' } },
        },
        list: {
          type: 'array',
          items: { type: 'object', properties: { y: { type: 'string' } } },
        },
      },
    };
    await adapter.complete(baseReq({ jsonSchema }));

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('response');
    expect(body.response_format.json_schema.strict).toBe(true);

    const s = body.response_format.json_schema.schema;
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.nested.additionalProperties).toBe(false);
    expect(s.properties.list.items.additionalProperties).toBe(false);
    // required covers every property key under strict
    expect(s.required).toEqual(['name', 'nested', 'list']);
  });

  // (3) jsonMode → json_object
  it('uses json_object response_format when jsonMode is set', async () => {
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS_BODY));
    const adapter = createOpenAIAdapter({ apiKey: 'sk-x', fetchImpl, retryDelayMs: 0 });

    await adapter.complete(baseReq({ jsonMode: true }));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  // (4) 429 1회 → 성공 재시도 (fetch 목 2회 호출)
  it('retries once on 429 then succeeds', async () => {
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS_BODY));
    fetchImpl.mockImplementationOnce(async () =>
      errResponse(429, { error: { code: 'rate_limit_exceeded' } }),
    );
    const adapter = createOpenAIAdapter({ apiKey: 'sk-x', fetchImpl, retryDelayMs: 0 });

    const res = await adapter.complete(baseReq());
    expect(res.text).toBe('hello world');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // (5) 400 즉시 실패 · 재시도 없음
  it('fails immediately on 400 with no retry', async () => {
    const fetchImpl = vi.fn(async () =>
      errResponse(400, { error: { code: 'invalid_request_error' } }),
    );
    const adapter = createOpenAIAdapter({ apiKey: 'sk-x', fetchImpl, retryDelayMs: 0 });

    let caught;
    try {
      await adapter.complete(baseReq());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderCallError);
    expect(caught.provider).toBe('openai');
    expect(caught.status).toBe(400);
    expect(caught.retryable).toBe(false);
    expect(caught.code).toBe('invalid_request_error');
    expect(caught.message).toBe('openai call failed: HTTP 400');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // (6) maxRetries 소진 후 ProviderCallError(retryable:true)
  it('throws a retryable ProviderCallError after exhausting retries on 5xx', async () => {
    const fetchImpl = vi.fn(async () => errResponse(503, { error: { code: 'server_error' } }));
    const adapter = createOpenAIAdapter({
      apiKey: 'sk-x',
      fetchImpl,
      retryDelayMs: 0,
      maxRetries: 2,
    });

    let caught;
    try {
      await adapter.complete(baseReq());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderCallError);
    expect(caught.retryable).toBe(true);
    expect(caught.status).toBe(503);
    // initial attempt + 2 retries = 3 fetch calls
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  // (7) 네트워크 reject 재시도
  it('retries on a network reject and normalizes to a retryable error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });
    const adapter = createOpenAIAdapter({
      apiKey: 'sk-x',
      fetchImpl,
      retryDelayMs: 0,
      maxRetries: 1,
    });

    let caught;
    try {
      await adapter.complete(baseReq());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderCallError);
    expect(caught.retryable).toBe(true);
    expect(caught.status).toBeNull();
    expect(caught.message).toBe('openai call failed: network');
    // initial attempt + 1 retry = 2 fetch calls
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // (8) 유출 부재 — 던져진 에러의 어디에도 키·URL·messages 마커 부재
  it('never leaks the api key, upstream URL, or prompt content in thrown errors', async () => {
    const secretKey = 'sk-verysecret-abc123';
    const secretMarker = '비밀프롬프트-marker';

    // network-error path: original error message embeds key + URL
    const netFetch = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED https://api.openai.com/v1 key=${secretKey}`);
    });
    const netAdapter = createOpenAIAdapter({
      apiKey: secretKey,
      fetchImpl: netFetch,
      retryDelayMs: 0,
      maxRetries: 0,
    });

    let netErr;
    try {
      await netAdapter.complete({
        model: { provider: 'openai', modelId: 'gpt-x' },
        messages: [{ role: 'user', content: secretMarker }],
      });
    } catch (e) {
      netErr = e;
    }
    expect(netErr).toBeInstanceOf(ProviderCallError);
    const netBlob = JSON.stringify(netErr) + '\n' + String(netErr.message) + '\n' + String(netErr.stack);
    expect(netBlob).not.toContain('sk-');
    expect(netBlob).not.toContain('api.openai.com');
    expect(netBlob).not.toContain(secretMarker);

    // http-error path: leaky body echoes key + prompt marker
    const httpFetch = vi.fn(async () =>
      errResponse(500, {
        error: { message: `bad key ${secretKey}`, code: 'internal_error' },
        echo: secretMarker,
      }),
    );
    const httpAdapter = createOpenAIAdapter({
      apiKey: secretKey,
      fetchImpl: httpFetch,
      retryDelayMs: 0,
      maxRetries: 0,
    });

    let httpErr;
    try {
      await httpAdapter.complete({
        model: { provider: 'openai', modelId: 'gpt-x' },
        messages: [{ role: 'user', content: secretMarker }],
      });
    } catch (e) {
      httpErr = e;
    }
    expect(httpErr).toBeInstanceOf(ProviderCallError);
    const httpBlob =
      JSON.stringify(httpErr) + '\n' + String(httpErr.message) + '\n' + String(httpErr.stack);
    expect(httpBlob).not.toContain('sk-');
    expect(httpBlob).not.toContain('api.openai.com');
    expect(httpBlob).not.toContain(secretMarker);
    // code extraction from the body is allowed (it is not sensitive)
    expect(httpErr.code).toBe('internal_error');
    expect(httpErr.message).toBe('openai call failed: HTTP 500');
  });

  // (9) apiKey 미제공 생성 throw
  it('throws at construction when apiKey is missing', () => {
    expect(() => createOpenAIAdapter({ fetchImpl: vi.fn() })).toThrow(/apiKey required/);
    expect(() => createOpenAIAdapter({ apiKey: '', fetchImpl: vi.fn() })).toThrow(/apiKey required/);
  });

  // (10) Authorization 헤더 Bearer <key> — 단언 자체는 목 내부에서만
  it('sends Authorization: Bearer <key> and JSON content-type', async () => {
    const key = 'sk-authcheck-999';
    let authSeen = false;
    let contentTypeSeen = false;
    const fetchImpl = vi.fn(async (_url, init) => {
      // assert INSIDE the mock so the raw key never surfaces in outer assertions
      if (init.headers.Authorization === `Bearer ${key}`) authSeen = true;
      if (init.headers['Content-Type'] === 'application/json') contentTypeSeen = true;
      return okResponse(SUCCESS_BODY);
    });
    const adapter = createOpenAIAdapter({ apiKey: key, fetchImpl, retryDelayMs: 0 });
    await adapter.complete(baseReq());
    expect(authSeen).toBe(true);
    expect(contentTypeSeen).toBe(true);
  });

  // (11) step 필드 요청 body 미포함 (텔레메트리 메타)
  it('omits the telemetry-only `step` field from the request body', async () => {
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS_BODY));
    const adapter = createOpenAIAdapter({ apiKey: 'sk-x', fetchImpl, retryDelayMs: 0 });

    await adapter.complete(baseReq({ step: 'draft', temperature: 0.5, maxTokens: 100 }));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('step');
    expect(body.temperature).toBe(0.5);
    expect(body.max_completion_tokens).toBe(100);
  });

  // (12) 2xx 정규화 — choices/usage 결손도 throw 아닌 text ''·usage 0 처리
  it('normalizes a 2xx body with missing choices/usage to empty text + zeroed usage', async () => {
    const fetchImpl = vi.fn(async () => okResponse({}));
    const adapter = createOpenAIAdapter({ apiKey: 'sk-x', fetchImpl, retryDelayMs: 0 });

    const res = await adapter.complete(baseReq());
    expect(res.text).toBe('');
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  // (13) 2xx 비JSON 본문 → ProviderCallError(BAD_RESPONSE), 재시도 없음
  it('normalizes a non-JSON 2xx body to a ProviderCallError(BAD_RESPONSE)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new Error('Unexpected token < in JSON');
      },
      async text() {
        return '<html>not json</html>';
      },
    }));
    const adapter = createOpenAIAdapter({ apiKey: 'sk-x', fetchImpl, retryDelayMs: 0 });

    let caught;
    try {
      await adapter.complete(baseReq());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderCallError);
    expect(caught.code).toBe('BAD_RESPONSE');
    expect(caught.retryable).toBe(false);
    // fixed-template message, no upstream body echoed
    expect(caught.message).toBe('openai call failed: HTTP 200');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // (14) 시도마다 새 AbortSignal — 재시도 시 signal 객체가 갱신됨
  it('uses a fresh AbortSignal on each attempt', async () => {
    const signals = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      signals.push(init.signal);
      return signals.length === 1
        ? errResponse(429, { error: { code: 'rate_limit_exceeded' } })
        : okResponse(SUCCESS_BODY);
    });
    const adapter = createOpenAIAdapter({ apiKey: 'sk-x', fetchImpl, retryDelayMs: 0 });

    await adapter.complete(baseReq());
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeDefined();
    expect(signals[1]).toBeDefined();
    expect(signals[0]).not.toBe(signals[1]);
  });

  // (15) 에러 경로에서 console 호출 0 · cause 체이닝 부재 (보안 핵심)
  it('emits no console output and does not chain the original cause on error paths', async () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
    const original = {};
    let consoleCalls = 0;
    for (const m of methods) {
      original[m] = console[m];
      console[m] = () => {
        consoleCalls += 1;
      };
    }
    try {
      const fetchImpl = vi.fn(async () => {
        throw new Error('connect ECONNREFUSED https://api.openai.com/v1 key=sk-leak-xyz');
      });
      const adapter = createOpenAIAdapter({
        apiKey: 'sk-leak-xyz',
        fetchImpl,
        retryDelayMs: 0,
        maxRetries: 0,
      });

      let err;
      try {
        await adapter.complete(baseReq());
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ProviderCallError);
      expect(err.cause).toBeUndefined();
      expect(consoleCalls).toBe(0);
    } finally {
      for (const m of methods) console[m] = original[m];
    }
  });

  // (16) defaultMaxTokens 기본값(8192) — req.maxTokens 부재 시 실효 출력캡 (R1-b)
  it('applies defaultMaxTokens (8192) as max_completion_tokens when the request omits maxTokens', async () => {
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS_BODY));
    const adapter = createOpenAIAdapter({ apiKey: 'sk-x', fetchImpl, retryDelayMs: 0 });

    await adapter.complete(baseReq());
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.max_completion_tokens).toBe(8192);
  });

  // (17) req.maxTokens 우선 — defaultMaxTokens 를 덮어쓴다
  it('lets an explicit req.maxTokens take priority over defaultMaxTokens', async () => {
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS_BODY));
    const adapter = createOpenAIAdapter({
      apiKey: 'sk-x',
      fetchImpl,
      retryDelayMs: 0,
      defaultMaxTokens: 8192,
    });

    await adapter.complete(baseReq({ maxTokens: 256 }));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.max_completion_tokens).toBe(256);
  });

  // (18) defaultMaxTokens:null — req 도 부재면 max_completion_tokens 미적용(cap 미설정)
  it('omits max_completion_tokens entirely when defaultMaxTokens is null and the request omits it', async () => {
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS_BODY));
    const adapter = createOpenAIAdapter({
      apiKey: 'sk-x',
      fetchImpl,
      retryDelayMs: 0,
      defaultMaxTokens: null,
    });

    await adapter.complete(baseReq());
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  // ── NEP-V3 (ADR-0033 D3) — job deadline propagation ────────────────────────
  describe('deadline (NEP-V3)', () => {
    // (19) attempt timeout shrinks to min(timeoutMs, remaining) once a deadline is set
    it('shrinks the AbortSignal timeout to min(timeoutMs, remaining) when deadlineAt is set', async () => {
      const fetchImpl = vi.fn(async () => okResponse(SUCCESS_BODY));
      const originalTimeout = AbortSignal.timeout;
      const seenMs = [];
      AbortSignal.timeout = (ms) => {
        seenMs.push(ms);
        return originalTimeout(ms);
      };
      try {
        const adapter = createOpenAIAdapter({
          apiKey: 'sk-x',
          fetchImpl,
          retryDelayMs: 0,
          timeoutMs: 120000,
          now: () => 1_000_000,
          deadlineAt: 1_000_000 + 5000, // 5s remaining, far under the 120s default
        });
        await adapter.complete(baseReq());
        expect(seenMs).toEqual([5000]);
      } finally {
        AbortSignal.timeout = originalTimeout;
      }
    });

    // (20) remaining already <= 0 at the first attempt: immediate PROVIDER_JOB_TIMEOUT,
    // zero fetch calls (not even one attempt, let alone a retry).
    it('fails fast with PROVIDER_JOB_TIMEOUT when the deadline has already passed, no fetch call', async () => {
      const fetchImpl = vi.fn(async () => okResponse(SUCCESS_BODY));
      const adapter = createOpenAIAdapter({
        apiKey: 'sk-x',
        fetchImpl,
        retryDelayMs: 0,
        maxRetries: 2,
        now: () => 2_000_000,
        deadlineAt: 1_999_999, // already 1ms in the past
      });
      let caught;
      try {
        await adapter.complete(baseReq());
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ProviderCallError);
      expect(caught.code).toBe('PROVIDER_JOB_TIMEOUT');
      expect(caught.retryable).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(0);
    });

    // (21) remaining exhausts BETWEEN a retryable failure and the next attempt: the
    // pending retry is abandoned — only the one fetch call that already happened.
    it('abandons a pending retry once the deadline is exhausted mid-loop', async () => {
      const fetchImpl = vi.fn(async () => errResponse(503, { error: { code: 'server_error' } }));
      let call = 0;
      const nowFn = () => {
        call += 1;
        // attempt 0 sees 500ms remaining (proceeds); attempt 1's pre-check sees the
        // deadline already passed (600ms later) and must not fetch again.
        return call === 1 ? 1_000_000 : 1_000_600;
      };
      const adapter = createOpenAIAdapter({
        apiKey: 'sk-x',
        fetchImpl,
        retryDelayMs: 0,
        maxRetries: 2,
        now: nowFn,
        deadlineAt: 1_000_500,
      });
      let caught;
      try {
        await adapter.complete(baseReq());
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ProviderCallError);
      expect(caught.code).toBe('PROVIDER_JOB_TIMEOUT');
      expect(caught.retryable).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    // (22) deadlineAt unset (default, codex #18 f) — byte-identical: the plain
    // timeoutMs reaches AbortSignal.timeout unshrunk, exactly like the pre-V3 adapter.
    it('uses the plain timeoutMs (no shrink) when deadlineAt is not set', async () => {
      const fetchImpl = vi.fn(async () => okResponse(SUCCESS_BODY));
      const originalTimeout = AbortSignal.timeout;
      const seenMs = [];
      AbortSignal.timeout = (ms) => {
        seenMs.push(ms);
        return originalTimeout(ms);
      };
      try {
        const adapter = createOpenAIAdapter({ apiKey: 'sk-x', fetchImpl, retryDelayMs: 0, timeoutMs: 45000 });
        await adapter.complete(baseReq());
        expect(seenMs).toEqual([45000]);
      } finally {
        AbortSignal.timeout = originalTimeout;
      }
    });
  });
});
