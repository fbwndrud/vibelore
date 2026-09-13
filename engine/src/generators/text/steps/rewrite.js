/**
 * rewrite — author-directed full chapter rewrite LLM call.
 *
 * EPIC #254 (다시쓰기). The host (chapter-rewrite handler) loads the existing
 * `EngineChapterArtifact.prose` for the from-chapter and the composed
 * `intentSummary`, then calls `runRewrite` once. The output is raw prose + a
 * trailing `⟦vle:cast-manifest …⟧` sentinel — the SAME shape as `runDraft`,
 * so the bounded loop in `chapter-rewrite-with-revise.ts` can re-use
 * `commitPhase` (extractDelta → continuityCheck → sanitize → commit) verbatim.
 *
 * The sentinel discipline is load-bearing: if the model omits the
 * cast-manifest block, `commitPhase`'s sanitizer reports `leaked` and throws
 * `SanitizeLeakError`. The system prompt (`REWRITE_SYSTEM`) restates the
 * sentinel contract from `draft.ts` for this reason.
 *
 */
import { resolveCharacter } from '../../../continuity/foundation.js';
import { languageSystemLines, resolveStepPromptLanguage } from '../../../core/prompt-language.js';
import { buildRewriteUserPrompt, rewriteSystemFor, } from '../prompts/rewrite.js';
import { isHookActive } from '../../../continuity/story-state.js';
/**
 * Project the Foundation into the compact context the rewrite prompt needs:
 * all characters registered at/before the chapter + the genre's hard
 * invariants. Mirrors the draft.ts projection (canonical reference for the
 * model to align to without ballooning context).
 */
function buildFoundationContext(foundation, chapterNumber) {
    // P4b (#516) — Codex 비활성(disabled) 캐릭터 제외 + contradiction(한 줄
    // 소개) 포함. draft.ts 의 summariseCharacterForPrompt 와 동일 정책.
    const characters = foundation.characters
        .filter((c) => c.registeredAtChapter <= chapterNumber && c.disabled !== true)
        .map((c) => {
        try {
            const resolved = resolveCharacter(foundation, chapterNumber, c.id);
            return {
                id: resolved.id,
                canonicalName: resolved.canonicalName,
                aliases: [...resolved.aliases],
                intrinsic: {
                    gender: resolved.intrinsic.gender,
                    ageBand: resolved.intrinsic.ageBand,
                    role: resolved.intrinsic.role,
                    coreAppearance: [...resolved.intrinsic.coreAppearance],
                },
                ...(typeof resolved.contradiction === 'string' &&
                    resolved.contradiction.trim().length > 0
                    ? { contradiction: resolved.contradiction }
                    : {}),
            };
        }
        catch {
            return {
                id: c.id,
                canonicalName: c.canonicalName,
                aliases: [...c.aliases],
                intrinsic: {
                    gender: c.intrinsic.gender,
                    ageBand: c.intrinsic.ageBand,
                    role: c.intrinsic.role,
                    coreAppearance: [...c.intrinsic.coreAppearance],
                },
                ...(typeof c.contradiction === 'string' && c.contradiction.trim().length > 0
                    ? { contradiction: c.contradiction }
                    : {}),
            };
        }
    });
    return {
        genre: foundation.genre,
        worldFacts: foundation.worldFacts.map((f) => f.statement),
        characters,
        invariants: foundation.genreProfile.invariants.map((inv) => ({
            id: inv.id,
            severity: inv.severity,
            description: inv.description,
        })),
    };
}
/** Project StoryState N-1 into the compact carry-forward summary. Read-only. */
function buildPrevStateSummary(prevState) {
    return {
        chapterNumber: prevState.chapterNumber,
        addressMap: prevState.addressMap.entries,
        openHooks: (prevState.hooks ?? [])
            .filter(isHookActive)
            .map((h) => ({ id: h.id, text: h.text, phase: h.phase })),
        relationships: prevState.relationships,
    };
}
/**
 * Run one rewrite LLM call. Returns the full rewritten prose (with the trailing
 * cast-manifest sentinel). Caller (bounded loop) feeds this through
 * `commitPhase`, retrying with `runRevise` on continuity HARD FAIL.
 */
export async function runRewrite(input) {
    // 다국어 Phase 2A — system 과 user 가 같은 계약을 본다. 계약도 언어도 없으면
    // 구형 ko 해석이라 프롬프트가 기존과 동일하다.
    const promptLanguage = resolveStepPromptLanguage(input);
    const userPrompt = buildRewriteUserPrompt({
        chapterNumber: input.chapterNumber,
        promptLanguage,
        intentSummary: input.intentSummary,
        previousProse: input.previousProse,
        foundationContext: buildFoundationContext(input.foundation, input.chapterNumber),
        prevStateSummary: buildPrevStateSummary(input.prevState),
        // P4b (#516) — 멘션 entity 섹션 (없으면 prompt 그대로).
        entityContextRender: input.entityContextRender,
    });
    const response = await input.providers.complete({
        model: input.model,
        // No jsonMode — rewrite output is prose + a single trailing sentinel block.
        step: 'rewrite',
        messages: [
            {
                role: 'system',
                content: [
                    rewriteSystemFor(promptLanguage, {
                        // 승인된 대사·문단 모드. 계약 고정값과 어긋나면 오류.
                        dialogueBreakMode: input.dialogueBreakMode ?? null,
                    }),
                    // 다시쓰기 분량은 **원본 대비 ±20%**(규칙 5)라 회차 분량 목표
                    // 줄은 뺀다 — 한 프롬프트에 서로 다른 분량 기준을 싣지 않는다.
                    ...languageSystemLines(promptLanguage, { includeChapterLength: false }),
                ].join(' '),
            },
            { role: 'user', content: userPrompt },
        ],
    });
    return { prose: response.text };
}
