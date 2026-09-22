/**
 * Tests for bounded retry and failure reporting.
 *
 * Exhaustion and non-recoverable errors must return a failure without an
 * unbounded retry loop.
 */
import { describe, it, expect } from '../_support/vitest-shim.mjs';
import { createOrchestrator, } from '../../src/core/orchestrator.js';
function makeLogger() {
    const entries = [];
    const log = {
        info: (msg, meta) => entries.push({ level: 'info', msg, meta }),
        warn: (msg, meta) => entries.push({ level: 'warn', msg, meta }),
        error: (msg, meta) => entries.push({ level: 'error', msg, meta }),
        debug: (msg, meta) => entries.push({ level: 'debug', msg, meta }),
    };
    return { log, entries };
}
function makeCtx() {
    const { log, entries } = makeLogger();
    // Only `log` + `jobId` are touched by the orchestrator. Cast a partial.
    const ctx = { jobId: 'job-test', log };
    return { ctx, entries };
}
function sequencedStep(name, outcomes) {
    let calls = 0;
    const step = {
        name,
        async run() {
            const entry = outcomes[calls];
            calls += 1;
            if (entry instanceof Error)
                throw entry;
            return entry;
        },
    };
    return { step };
}
describe('DefaultOrchestrator.runStep', () => {
    it('returns step output on success and logs debug bracketing', async () => {
        const orch = createOrchestrator();
        const { ctx, entries } = makeCtx();
        const step = {
            name: 'echo',
            async run(_ctx, input) {
                return `v=${input}`;
            },
        };
        const out = await orch.runStep(ctx, step, 7);
        expect(out).toBe('v=7');
        const debugMsgs = entries.filter((e) => e.level === 'debug').map((e) => e.msg);
        expect(debugMsgs).toContain('orchestrator.runStep:start');
        expect(debugMsgs).toContain('orchestrator.runStep:end');
    });
    it('rethrows when step.run throws (no retry)', async () => {
        const orch = createOrchestrator();
        const { ctx } = makeCtx();
        const step = {
            name: 'boom',
            async run() {
                throw new Error('explode');
            },
        };
        await expect(orch.runStep(ctx, step, undefined)).rejects.toThrow('explode');
    });
});
describe('DefaultOrchestrator.runWithRevise', () => {
    it('ok on attempt 1 → attempts=1, cleanFailed=false', async () => {
        const orch = createOrchestrator();
        const { ctx } = makeCtx();
        const { step } = sequencedStep('writer', [
            { ok: true, output: 'prose-A' },
        ]);
        const result = await orch.runWithRevise(ctx, step, undefined);
        expect(result.ok).toBe(true);
        expect(result.cleanFailed).toBe(false);
        expect(result.attempts).toBe(1);
        expect(result.output).toBe('prose-A');
        expect(result.lastError).toBeUndefined();
    });
    it('ok on attempt 2 after one recoverable fail → attempts=2', async () => {
        const orch = createOrchestrator();
        const { ctx } = makeCtx();
        const { step } = sequencedStep('writer', [
            { ok: false, reason: 'soft-violation', recoverable: true },
            { ok: true, output: 'prose-B' },
        ]);
        const result = await orch.runWithRevise(ctx, step, undefined);
        expect(result.ok).toBe(true);
        expect(result.cleanFailed).toBe(false);
        expect(result.attempts).toBe(2);
        expect(result.output).toBe('prose-B');
    });
    it('3 recoverable fails → cleanFailed=true, attempts=3, lastError set', async () => {
        const orch = createOrchestrator();
        const { ctx } = makeCtx();
        const { step } = sequencedStep('writer', [
            { ok: false, reason: 'r1', recoverable: true },
            { ok: false, reason: 'r2', recoverable: true },
            { ok: false, reason: 'r3', recoverable: true },
        ]);
        const result = await orch.runWithRevise(ctx, step, undefined);
        expect(result.ok).toBe(false);
        expect(result.cleanFailed).toBe(true);
        expect(result.attempts).toBe(3);
        expect(result.lastError).toBe('r3');
        expect(result.output).toBeUndefined();
    });
    it('non-recoverable fail on attempt 1 → cleanFailed=true, attempts=1', async () => {
        const orch = createOrchestrator();
        const { ctx } = makeCtx();
        const { step } = sequencedStep('writer', [
            { ok: false, reason: 'sentinel-injection', recoverable: false },
        ]);
        const result = await orch.runWithRevise(ctx, step, undefined);
        expect(result.ok).toBe(false);
        expect(result.cleanFailed).toBe(true);
        expect(result.attempts).toBe(1);
        expect(result.lastError).toBe('sentinel-injection');
    });
    it('async throw is captured as recoverable; later attempt can succeed', async () => {
        const orch = createOrchestrator();
        const { ctx, entries } = makeCtx();
        const { step } = sequencedStep('writer', [
            new Error('network-down'),
            { ok: true, output: 'recovered' },
        ]);
        const result = await orch.runWithRevise(ctx, step, undefined);
        expect(result.ok).toBe(true);
        expect(result.attempts).toBe(2);
        expect(result.output).toBe('recovered');
        const warns = entries.filter((e) => e.level === 'warn');
        expect(warns.length).toBeGreaterThanOrEqual(1);
        expect(warns[0]?.meta?.reason).toBe('network-down');
    });
    it('synchronous throw inside step.run propagates as captured recoverable failure', async () => {
        const orch = createOrchestrator();
        const { ctx } = makeCtx();
        const step = {
            name: 'sync-throw',
            // Throw synchronously before the await resolves. Wrapped in Promise by
            // async fn so the runtime surfaces it as a rejection — orchestrator
            // must still treat it as recoverable until attempts exhausted.
            run() {
                throw new Error('sync-bad');
            },
        };
        const result = await orch.runWithRevise(ctx, step, undefined, { maxAttempts: 2 });
        expect(result.ok).toBe(false);
        expect(result.cleanFailed).toBe(true);
        expect(result.attempts).toBe(2);
        expect(result.lastError).toBe('sync-bad');
    });
    it('respects custom RetryPolicy.maxAttempts', async () => {
        const orch = createOrchestrator();
        const { ctx } = makeCtx();
        const { step } = sequencedStep('writer', [
            { ok: false, reason: 'r1', recoverable: true },
            { ok: false, reason: 'r2', recoverable: true },
            { ok: false, reason: 'r3', recoverable: true },
            { ok: false, reason: 'r4', recoverable: true },
            { ok: false, reason: 'r5', recoverable: true },
        ]);
        const result = await orch.runWithRevise(ctx, step, undefined, { maxAttempts: 5 });
        expect(result.attempts).toBe(5);
        expect(result.cleanFailed).toBe(true);
        expect(result.lastError).toBe('r5');
    });
});
