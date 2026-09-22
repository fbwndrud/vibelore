/**
 * createUsageTrackingRegistry — a ProviderRegistry decorator that tallies token
 * usage per engine `step` and enforces a logical-call budget before delegating.
 *
 * NEP-S2. Wraps an inner registry (`./provider-registry.js`). `register()` and
 * `has()` pass straight through. `complete()` increments a call counter on
 * entry — exceeding `maxLogicalCalls` throws `ProviderCallBudgetError` WITHOUT
 * touching the inner registry (a hard runaway guard). On success it folds the
 * response usage into running totals and a per-step breakdown, mapping
 * `promptTokens → inputTokens` / `completionTokens → outputTokens`.
 * `snapshot()` returns a deep, immutable copy of the accumulated tallies.
 */

/** Thrown when the per-registry logical-call budget is exceeded. */
export class ProviderCallBudgetError extends Error {
    constructor(calls) {
        super(`provider call budget exceeded: ${calls}`);
        this.name = 'ProviderCallBudgetError';
        this.code = 'PROVIDER_CALL_BUDGET_EXCEEDED';
        this.calls = calls;
    }
}

export function createUsageTrackingRegistry(inner, { maxLogicalCalls = 12 } = {}) {
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let logicalCalls = 0;
    /** @type {Map<string, {inputTokens:number, outputTokens:number, totalTokens:number, calls:number}>} */
    const byStep = new Map();

    async function complete(req) {
        // Pre-increment: the rejected call still counts toward the budget number.
        logicalCalls += 1;
        if (logicalCalls > maxLogicalCalls) {
            throw new ProviderCallBudgetError(logicalCalls);
        }

        const res = await inner.complete(req);

        const usage = res?.usage ?? {};
        const inTok = usage.promptTokens ?? 0;
        const outTok = usage.completionTokens ?? 0;
        const totTok = usage.totalTokens ?? 0;

        inputTokens += inTok;
        outputTokens += outTok;
        totalTokens += totTok;

        const step = req.step ?? 'unknown';
        const bucket = byStep.get(step) ?? {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            calls: 0,
        };
        bucket.inputTokens += inTok;
        bucket.outputTokens += outTok;
        bucket.totalTokens += totTok;
        bucket.calls += 1;
        byStep.set(step, bucket);

        return res;
    }

    function snapshot() {
        const byStepCopy = {};
        for (const [step, b] of byStep) {
            byStepCopy[step] = {
                inputTokens: b.inputTokens,
                outputTokens: b.outputTokens,
                totalTokens: b.totalTokens,
                calls: b.calls,
            };
        }
        return { inputTokens, outputTokens, totalTokens, logicalCalls, byStep: byStepCopy };
    }

    return {
        complete,
        register: (adapter) => inner.register(adapter),
        has: (provider) => inner.has(provider),
        snapshot,
    };
}
