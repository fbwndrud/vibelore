/**
 * Orchestrator — runs a pipeline of named steps with bounded retries.
 *
 * Execution contract:
 *   - Bounded revise loop: at most `maxAttempts` (default 3).
 *   - On exhaustion, the orchestrator returns a `clean-fail` result. The
 *     caller can report the failure without publishing the candidate chapter.
 */
export const DEFAULT_REVISE_POLICY = { maxAttempts: 3 };
class DefaultOrchestrator {
    async runStep(ctx, step, input) {
        ctx.log.debug('orchestrator.runStep:start', { step: step.name, jobId: ctx.jobId });
        const startedAt = Date.now();
        const output = await step.run(ctx, input);
        ctx.log.debug('orchestrator.runStep:end', {
            step: step.name,
            jobId: ctx.jobId,
            elapsedMs: Date.now() - startedAt,
        });
        return output;
    }
    async runWithRevise(ctx, step, input, policy = DEFAULT_REVISE_POLICY) {
        const maxAttempts = policy.maxAttempts;
        let attempts = 0;
        let lastError;
        while (attempts < maxAttempts) {
            attempts += 1;
            ctx.log.debug('orchestrator.runWithRevise:attempt', {
                step: step.name,
                jobId: ctx.jobId,
                attempt: attempts,
                maxAttempts,
            });
            const startedAt = Date.now();
            let outcome;
            try {
                outcome = await step.run(ctx, input);
            }
            catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                ctx.log.warn('orchestrator.runWithRevise:threw', {
                    step: step.name,
                    jobId: ctx.jobId,
                    attempt: attempts,
                    reason,
                });
                lastError = reason;
                continue;
            }
            ctx.log.debug('orchestrator.runWithRevise:attemptEnd', {
                step: step.name,
                jobId: ctx.jobId,
                attempt: attempts,
                elapsedMs: Date.now() - startedAt,
                ok: outcome.ok,
            });
            if (outcome.ok) {
                return { ok: true, output: outcome.output, cleanFailed: false, attempts };
            }
            lastError = outcome.reason;
            if (!outcome.recoverable) {
                return { ok: false, cleanFailed: true, attempts, lastError };
            }
        }
        return { ok: false, cleanFailed: true, attempts, lastError };
    }
}
export function createOrchestrator() {
    return new DefaultOrchestrator();
}
