/**
 * chapter-rewrite-with-revise — bounded revise loop wrapping `runRewrite`.
 *
 * EPIC #254 (다시쓰기). Mirrors `chapter-write-with-revise.ts` but replaces the
 * draft step with `runRewrite`:
 *
 *   1. Load foundation + prevState(N-1) from the StateStore. The from-chapter's
 *      OWN StoryState is NOT loaded/mutated — rewrite re-derives the chapter's
 *      delta via commitPhase. prevState (N-1) is the continuity anchor and MUST
 *      NOT be mutated by this pass (downstream chapters depend on it).
 *   2. `runRewrite` once → prose (+ trailing cast-manifest sentinel).
 *   3. Re-use the shared bounded loop (`runBoundedCommitLoop`) — commitPhase →
 *      (on continuity HARD FAIL) runRevise → retry up to `maxAttempts`. On
 *      exhaustion / sanitize leak it throws `CleanFailError`, exactly like the
 *      chapter-write path.
 *
 * commitPhase persists the new StoryState(N) + EngineChapterArtifact(N) on
 * success — overwriting the from-chapter's artifact prose with the rewritten
 * body (upsert on (workId, chapterNumber)). prevState (N-1) is untouched.
 *
 * v1 scope: SINGLE chapter only (cascadeCount=1). Multi-chapter cascade is a
 * follow-up — the host refunds the excess cascade hold. See the plan §1.
 *
 */
import { EMPTY_SCENE, renderEntityContext, resolveEntityContext } from '../../core/entity-context.js';
import { scanEntityMentions } from '../../core/mention-scan.js';
import { emptyStoryState } from '../../continuity/story-state.js';
import { resolveWorkPromptLanguage } from '../../core/prompt-language.js';
import { runBoundedCommitLoop, } from './chapter-write-with-revise.js';
import { withGateContext } from './chapter-validation.js';
import { runRewrite } from './steps/rewrite.js';
/**
 * Bounded rewrite: `runRewrite` once, then the shared commit/revise loop.
 *
 * Loads foundation + prevState(N-1) from `ctx.state`. For chapterNumber=1 the
 * prevState is the empty story state (no N-1 exists). prevState is read-only:
 * commitPhase folds the rewritten chapter's delta onto it to produce
 * StoryState(N), but never writes back to N-1.
 *
 * Throws `CleanFailError` on continuity exhaustion / sanitize leak (host
 * reports the unsuccessful rewrite). Throws a plain Error if the foundation is missing.
 */
export async function performChapterRewriteBounded(ctx, input, opts = {}) {
    ctx = withGateContext(ctx, input);
    const { chapterNumber, previousProse, intentSummary } = input;
    const foundation = await ctx.state.loadFoundation(ctx.workId);
    if (!foundation) {
        throw new Error(`ChapterRewrite: foundation not found for work ${ctx.workId}`);
    }
    // 다국어 Phase 2A — 다시쓰기와 이어지는 수정/commit 이 같은 계약을 본다. 원천은
    // 저장된 Foundation 메타데이터이며 호출 인자는 확인용이다.
    const promptLanguage = resolveWorkPromptLanguage({
        foundation,
        workContract: ctx.workContract ?? null,
        language: ctx.language ?? null,
        length: ctx.length ?? null,
    });
    // prevState = StoryState committed after chapter N-1. This is the continuity
    // anchor — we read it but never mutate it. chapter 1 has no predecessor.
    let prevState;
    if (chapterNumber === 1) {
        prevState = emptyStoryState(ctx.workId);
    }
    else {
        const loaded = await ctx.state.loadStoryState(ctx.workId, chapterNumber - 1);
        if (!loaded) {
            ctx.log.warn('chapter-rewrite:prev-state-missing', {
                workId: ctx.workId,
                chapterNumber,
                fallback: 'emptyStoryState',
            });
            prevState = emptyStoryState(ctx.workId);
        }
        else {
            prevState = loaded;
        }
    }
    // P4b (#516, Epic #511) — 멘션 기반 entity activation (NovelAI Lorebook
    // activation-key 패턴). rewrite 는 chapter-plan 의 scene declaration 이 없어
    // ADR-0004 entity context 가 전혀 주입되지 않았다 — 원본 prose 에 멘션된
    // entity 를 스캔해 그 설정(attrs/aliases)을 prompt 에 포함시킨다. 설정을
    // 모른 채 재집필하며 생기는 모순(불 마법사 → 얼음 마법사 류) 방지.
    // 실패는 fail-soft — entity 없는 legacy prompt 로 진행.
    let entityContextRender;
    try {
        if (typeof ctx.state.loadEntitySnapshots === 'function') {
            const snapshots = await ctx.state.loadEntitySnapshots(ctx.workId);
            if (snapshots.length > 0) {
                const mention = scanEntityMentions({ text: previousProse, snapshots });
                if (mention.mentionedIds.length > 0) {
                    const ctxRes = resolveEntityContext({
                        scene: { ...EMPTY_SCENE, additionalRefs: mention.mentionedIds },
                        snapshots,
                        promptFamily: promptLanguage.promptFamily,
                    });
                    entityContextRender = renderEntityContext(ctxRes, promptLanguage);
                    ctx.log.info('chapter-rewrite:mention-activated', {
                        workId: ctx.workId,
                        chapterNumber,
                        activatedIds: mention.mentionedIds,
                        matchedTerms: mention.matchedTerms,
                    });
                }
            }
        }
    }
    catch (err) {
        ctx.log.warn('chapter-rewrite:entity-context-failed', {
            workId: ctx.workId,
            chapterNumber,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    // 1. runRewrite once — expensive LLM call, no point re-running on a
    //    continuity fail (the revise loop edits the rewritten prose instead).
    const { prose } = await runRewrite({
        previousProse,
        intentSummary,
        foundation,
        prevState,
        chapterNumber,
        arc: ctx.arc,
        entityContextRender,
        providers: ctx.providers,
        model: ctx.model,
        promptLanguage,
        dialogueBreakMode: ctx.dialogueBreakMode ?? null,
    });
    // 2. Shared bounded commit/revise loop — identical semantics to chapter-write.
    return runBoundedCommitLoop(withGateContext(ctx, input), {
        initialProse: prose,
        foundation,
        prevState,
        chapterNumber,
        // Rewrite has no chapter-plan. New-contract planSourceHash is bound to
        // the actual rewrite intent/source prose, never a fabricated id.
        plan: intentSummary ?? previousProse,
        logPrefix: 'chapter-rewrite-bounded',
        title: input.title,
        summary: input.summary,
        sensitiveMode: input.sensitiveMode,
    }, opts);
}
