/**
 * Bounded revision around the chapter-writing pipeline.
 *
 * Draft once, then retry continuity checks and commit with revised prose up to
 * maxAttempts. Exhaustion or malformed metadata raises CleanFailError without
 * publishing a partial artifact. Callers opt in through performChapterWriteBounded.
 */
import { ContinuityFailure, QualityGateFailure, SanitizeLeakError, commitPhase, draftPhase, throwPreparedFailure, } from './steps/chapter-write.js';
import { resolveWorkPromptLanguage } from '../../core/prompt-language.js';
import {
    checkChapterPublication,
    isExplicitNewContractContext,
    prepareChapterPublication,
    withGateContext,
} from './chapter-validation.js';
import { runRevise } from './steps/revise.js';
/**
 * Bounded-loop exhaustion error. Carries the last set of continuity
 * violations (or a synthetic SANITIZE_LEAK violation) so the caller can log /
 * surface them, plus the total number of attempts consumed.
 *
 * `code = 'CLEAN_FAIL'` lets callers distinguish exhausted revision from success.
 */
export class CleanFailError extends Error {
    violations;
    attempts;
    name = 'CleanFailError';
    code = 'CLEAN_FAIL';
    constructor(violations, attempts) {
        super(`Chapter clean-fail after ${attempts} attempt(s): ${violations.length} violation(s)` +
            (violations[0] ? ` — first: ${violations[0].code} — ${violations[0].message}` : ''));
        this.violations = violations;
        this.attempts = attempts;
    }
}
const DEFAULT_MAX_ATTEMPTS = 3;
/**
 * Shared bounded loop: commitPhase → (on HARD FAIL) runRevise → retry, up to
 * `maxAttempts` total. Extracted so `performChapterWriteBounded` (draft) and
 * `performChapterRewriteBounded` (rewrite) share the exact same recovery /
 * exhaustion / sanitize-leak semantics — the only difference between the two
 * callers is how `initialProse` is produced.
 *
 * Throws `CleanFailError` on exhaustion or immediate sanitize leak. Re-throws
 * any non-continuity system error unmodified.
 */
export async function runBoundedCommitLoop(ctx, input, opts = {}) {
    const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const { foundation, prevState, chapterNumber, plan, logPrefix } = input;
    // 다국어 Phase 2A — 수정 단계도 draft/commit 과 같은 계약을 본다. 원천은 저장된
    // Foundation 메타데이터이며, 언어 메타데이터가 없는 구형 작품은 revise 프롬프트가
    // 기존과 동일하다.
    const promptLanguage = resolveWorkPromptLanguage({
        foundation,
        workContract: ctx.workContract ?? null,
        language: ctx.language ?? null,
        length: ctx.length ?? null,
    });
    let currentProse = input.initialProse;
    let lastViolations = [];
    const gateCtx = withGateContext(ctx, input);
    const newContract = isExplicitNewContractContext(gateCtx, input);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (newContract) {
                const prepared = await prepareChapterPublication(gateCtx, {
                    prose: currentProse,
                    foundation,
                    prevState,
                    chapterNumber,
                    plan,
                    title: input.title,
                    summary: input.summary,
                    sensitiveMode: input.sensitiveMode,
                });
                if (!prepared.ok)
                    throwPreparedFailure(prepared, chapterNumber);
                const checked = await checkChapterPublication(gateCtx, prepared);
                const result = await commitPhase(gateCtx, {
                    prose: currentProse,
                    foundation,
                    prevState,
                    chapterNumber,
                    plan,
                    validationReceipt: checked.receipt,
                    canonical: checked.canonical,
                    languageCompliance: checked.languageCompliance,
                    coverage: checked.coverage,
                    checkerPlan: checked.checkerPlan,
                    identity: checked.identity,
                });
                ctx.log.info(`${logPrefix}:passed`, {
                    jobId: ctx.jobId,
                    workId: ctx.workId,
                    chapterNumber,
                    attempt,
                });
                return result;
            }
            const result = await commitPhase(ctx, {
                prose: currentProse,
                foundation,
                prevState,
                chapterNumber,
                // ADR-0009 (#220) — plan 전달 → coherence-judge 가 plan 의도 대비 평가.
                plan,
            });
            ctx.log.info(`${logPrefix}:passed`, {
                jobId: ctx.jobId,
                workId: ctx.workId,
                chapterNumber,
                attempt,
            });
            return result;
        }
        catch (err) {
            if (err instanceof ContinuityFailure) {
                lastViolations = err.violations;
                if (attempt === maxAttempts) {
                    ctx.log.warn(`${logPrefix}:exhausted`, {
                        jobId: ctx.jobId,
                        workId: ctx.workId,
                        chapterNumber,
                        attempts: attempt,
                        violationCount: lastViolations.length,
                    });
                    break;
                }
                ctx.log.info(`${logPrefix}:revising`, {
                    jobId: ctx.jobId,
                    workId: ctx.workId,
                    chapterNumber,
                    attempt,
                    violationCount: lastViolations.length,
                });
                const { revisedProse } = await runRevise({
                    prose: currentProse,
                    violations: lastViolations,
                    foundation,
                    chapterNumber,
                    providers: ctx.providers,
                    model: ctx.model,
                    promptLanguage,
                    dialogueBreakMode: ctx.dialogueBreakMode ?? null,
                });
                currentProse = revisedProse;
                continue;
            }
            // ADR-0009 (#220) — QualityGateFailure 도 ContinuityFailure 와 동일
            // path. fails 를 violations 로 변환해 revise prompt 에 흘려보낸다.
            if (err instanceof QualityGateFailure) {
                lastViolations = err.violations;
                if (attempt === maxAttempts) {
                    ctx.log.warn(`${logPrefix}:quality-exhausted`, {
                        jobId: ctx.jobId,
                        workId: ctx.workId,
                        chapterNumber,
                        attempts: attempt,
                        fails: err.fails,
                    });
                    break;
                }
                ctx.log.info(`${logPrefix}:quality-revise`, {
                    jobId: ctx.jobId,
                    workId: ctx.workId,
                    chapterNumber,
                    attempt,
                    fails: err.fails,
                });
                const { revisedProse } = await runRevise({
                    prose: currentProse,
                    violations: lastViolations,
                    foundation,
                    chapterNumber,
                    providers: ctx.providers,
                    model: ctx.model,
                    promptLanguage,
                    dialogueBreakMode: ctx.dialogueBreakMode ?? null,
                });
                currentProse = revisedProse;
                continue;
            }
            if (err instanceof SanitizeLeakError) {
                // Sanitize residue is not LLM-recoverable in this loop. Treat as
                // immediate clean-fail with a synthetic violation so the caller has a
                // single typed surface to refund/fail against.
                ctx.log.error(`${logPrefix}:sanitize-leak`, {
                    jobId: ctx.jobId,
                    workId: ctx.workId,
                    chapterNumber,
                    attempt,
                    message: err.message,
                });
                throw new CleanFailError([
                    {
                        severity: 'hard',
                        code: 'SANITIZE_LEAK',
                        message: err.message,
                        chapterNumber,
                    },
                ], attempt);
            }
            // Anything else — system error (provider, state-store, programmer bug).
            // Bubble up unmodified so the host's error reporting sees the real type.
            throw err;
        }
    }
    throw new CleanFailError(lastViolations, maxAttempts);
}
/**
 * Wrap `performChapterWrite` with a bounded revise loop. On continuity HARD
 * FAIL, runs `runRevise` and retries commit-phase up to `maxAttempts` total.
 * Throws `CleanFailError` on exhaustion or immediate sanitize leak.
 *
 * Signature matches `TextGeneratorSteps.writeChapter` so it can be plugged in
 * directly via the `TextGenerator` constructor.
 */
export async function performChapterWriteBounded(ctx, input, opts = {}) {
    // 1. draftPhase once — expensive, no point re-running on a continuity fail.
    const gateCtx = withGateContext(ctx, input);
    const drafted = await draftPhase(gateCtx, input);
    return runBoundedCommitLoop(gateCtx, {
        initialProse: drafted.prose,
        foundation: drafted.foundation,
        prevState: drafted.prevState,
        chapterNumber: drafted.chapterNumber,
        plan: drafted.plan,
        logPrefix: 'chapter-write-bounded',
        title: input.title,
        summary: input.summary,
        sensitiveMode: input.sensitiveMode,
    }, opts);
}
