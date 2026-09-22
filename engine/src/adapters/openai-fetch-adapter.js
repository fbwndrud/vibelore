/**
 * OpenAI-compatible provider adapter using Node.js fetch.
 *
 * The adapter handles request construction, JSON response parsing, provider errors,
 * and usage reporting without an SDK dependency. Provider credentials and model
 * selection are supplied by the caller.
 */

import { addAdditionalProperties } from '../core/json-schema.js';

/**
 * Normalized provider failure. Carries only non-sensitive metadata.
 * `message` is a fixed template — it never embeds key / URL / body / prompt.
 * NEP-V3 (ADR-0033 D3): `timeout:true` selects the job-deadline-exhausted
 * template. Its message embeds the `PROVIDER_JOB_TIMEOUT` code text itself —
 * dispatchJob's catch handler (packages/engine-runtime/src/runtime.js) only
 * forwards `error.message` onto the job row, never the `.code` property, so
 * the code must be legible in the message for it to reach `jobs.error_message`
 * (mirrors the `CODE: detail` convention other coded errors in this port use).
 */
export class ProviderCallError extends Error {
    constructor({ status = null, code = null, retryable = false, network = false, timeout = false } = {}) {
        super(
            timeout
                ? 'openai call failed: PROVIDER_JOB_TIMEOUT'
                : network
                    ? 'openai call failed: network'
                    : `openai call failed: HTTP ${status}`,
        );
        this.name = 'ProviderCallError';
        this.provider = 'openai';
        this.status = network || timeout ? null : status;
        this.code = code;
        this.retryable = retryable;
    }
}

/** OpenAI Structured Outputs (strict) response_format, or json_object, or none. */
function buildResponseFormat(req) {
    if (req.jsonSchema) {
        return {
            type: 'json_schema',
            json_schema: {
                name: 'response',
                strict: true,
                schema: addAdditionalProperties(req.jsonSchema),
            },
        };
    }
    if (req.jsonMode) {
        return { type: 'json_object' };
    }
    return undefined;
}

/**
 * Request body shaping — omits temperature/response_format when unset; drops
 * telemetry-only `step`. max_completion_tokens resolves as: explicit `req.maxTokens`
 * wins; (`max_tokens` is REJECTED by gpt-5-family models — NEP-W 실검증 HTTP 400 실측)
 * otherwise the adapter's `defaultMaxTokens` applies (the effective output cap,
 * since engine steps leave maxTokens unset — R1-b); `null` default → omitted.
 */
function buildBody(req, defaultMaxTokens) {
    const body = {
        model: req.model.modelId,
        // Re-map to {role, content} so no extra message fields ride along.
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) {
        body.max_completion_tokens = req.maxTokens;
    } else if (defaultMaxTokens !== undefined && defaultMaxTokens !== null) {
        body.max_completion_tokens = defaultMaxTokens;
    }
    const responseFormat = buildResponseFormat(req);
    if (responseFormat) body.response_format = responseFormat;
    return body;
}

/** choices/usage-tolerant response normalization (mirrors reference `?? ''` / `?? 0`). */
function normalizeResponse(data) {
    const text = data?.choices?.[0]?.message?.content ?? '';
    const usage = data?.usage ?? {};
    return {
        text,
        usage: {
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            totalTokens: usage.total_tokens ?? 0,
        },
    };
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createOpenAIAdapter({
    apiKey,
    baseURL = 'https://api.openai.com/v1',
    fetchImpl = globalThis.fetch,
    timeoutMs = 120000,
    maxRetries = 2,
    retryDelayMs = 500,
    // R1-b — effective per-request output cap when a step leaves maxTokens unset.
    // `null` disables the default (no max_completion_tokens unless the request supplies one).
    defaultMaxTokens = 8192,
    // NEP-V3 (ADR-0033 D3) — job-level deadline propagation. `deadlineAt` is an
    // absolute epoch-ms instant (or null/undefined to disable — the default —
    // which keeps every attempt's timeout at the plain `timeoutMs`, byte-identical
    // to the pre-V3 adapter). `now` is an injectable clock (defaults to
    // `Date.now`) purely so tests can drive "deadline already exhausted" /
    // "exhausts mid-retry" deterministically without a real sleep.
    deadlineAt = null,
    now = () => Date.now(),
} = {}) {
    if (!apiKey) {
        // Do not echo any provided value — just state the requirement.
        throw new Error('createOpenAIAdapter: apiKey required');
    }
    const url = `${baseURL}/chat/completions`;

    async function complete(req) {
        const payload = JSON.stringify(buildBody(req, defaultMaxTokens));

        for (let attempt = 0; ; attempt += 1) {
            // Deadline pre-check — BEFORE every attempt, including retries after the
            // backoff delay below. Exhausted budget fails fast (no fetch call), never
            // retried (retryable:false — more time will not fix an exhausted deadline).
            let attemptTimeoutMs = timeoutMs;
            if (deadlineAt != null) {
                const remainingMs = deadlineAt - now();
                if (remainingMs <= 0) {
                    throw new ProviderCallError({ code: 'PROVIDER_JOB_TIMEOUT', retryable: false, timeout: true });
                }
                attemptTimeoutMs = Math.min(timeoutMs, remainingMs);
            }
            let response;
            try {
                response = await fetchImpl(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`,
                    },
                    body: payload,
                    // Fresh timeout signal per attempt, shrunk to the job deadline's
                    // remaining budget when one is set (NEP-V3).
                    signal: AbortSignal.timeout(attemptTimeoutMs),
                });
            } catch {
                // Network / abort — retryable. Original error is discarded (no leak).
                if (attempt < maxRetries) {
                    await delay(retryDelayMs * 2 ** attempt);
                    continue;
                }
                throw new ProviderCallError({ network: true, retryable: true });
            }

            if (response.ok) {
                let data;
                try {
                    data = await response.json();
                } catch {
                    // 2xx but unparseable body — normalized, non-retryable.
                    throw new ProviderCallError({
                        status: response.status,
                        code: 'BAD_RESPONSE',
                        retryable: false,
                    });
                }
                return normalizeResponse(data);
            }

            const status = response.status;
            const retryable = status === 429 || status >= 500;

            // Lift the non-sensitive error.code, then discard the body entirely.
            let code = null;
            try {
                const errBody = await response.json();
                code = errBody?.error?.code ?? null;
            } catch {
                code = null;
            }

            if (retryable && attempt < maxRetries) {
                await delay(retryDelayMs * 2 ** attempt);
                continue;
            }
            throw new ProviderCallError({ status, code, retryable });
        }
    }

    return { provider: 'openai', complete };
}
