/**
 * ChapterWrite — composed pipeline impl for `TextGeneratorSteps.writeChapter`.
 *
 * Engine design §4.3 pipeline:
 *
 *   loadState → chapterPlan → draft(+ cast-manifest sentinel)
 *     → registerCharacter? (deferred — see jsdoc on `performChapterWrite`)
 *     → lexicon scan (folded into continuityCheck)
 *     → extractDelta → continuityCheck
 *     → [HARD FAIL → bounded revise — see chapter-write-with-revise.ts]
 *     → sanitize (strip sentinels, assert no leak)
 *     → commitState (reduceStoryState + saveArtifact)
 *
 * T3.4 split: the body is broken into `draftPhase` (loadState + chapterPlan +
 * draft) and `commitPhase` (extractDelta + continuityCheck + sanitize +
 * commitState). The revise wrapper in `chapter-write-with-revise.ts` calls
 * `draftPhase` once and then re-runs `commitPhase` with revised prose on each
 * iteration of the bounded retry loop. `performChapterWrite` remains as a
 * single-shot convenience that throws ContinuityFailure / SanitizeLeakError on
 * the first failure — exactly as before T3.4.
 *
 * The manifest identifies characters and address terms for deterministic checks.
 */
import { renderEntityContext, resolveEntityContext } from '../../../core/entity-context.js';
import { scanEntityMentions } from '../../../core/mention-scan.js';
import { resolveWorkPromptLanguage } from '../../../core/prompt-language.js';
import { buildSlidingWindow, renderSlidingWindow } from '../../../core/sliding-window.js';
import { DefaultHonorificLexicon } from '../../../continuity/honorific-lexicon.js';
import { continuityCheck, extractDelta, } from '../../../continuity/continuity-check.js';
import { emptyStoryState, reduceStoryState, } from '../../../continuity/story-state.js';
import { DefaultStyleLexicon } from '../../../continuity/style-lexicon.js';
import { scanStyle } from '../../../continuity/style-scan.js';
import { DefaultEmotionVerbLexicon } from '../../../continuity/emotion-verb-lexicon.js';
import { DefaultSimileMarkerLexicon } from '../../../continuity/simile-marker-lexicon.js';
import { DefaultOnomatopoeiaLexicon } from '../../../continuity/onomatopoeia-lexicon.js';
import { scanQuality } from '../../../continuity/quality-scan.js';
import { scanSentenceStats } from '../../../continuity/sentence-stats.js';
import { scanDialogueMarkerVariety } from '../../../continuity/dialogue-marker-variety.js';
import { detectCliffhanger } from '../../../continuity/cliffhanger-detector.js';
import { detectGapSkip } from '../../../continuity/gap-skip-detector.js';
import { scanDialogueRatio } from '../../../continuity/dialogue-ratio.js';
import { scanInfoRestate } from '../../../continuity/info-restate-detector.js';
import { scanFanficLeak } from '../../../continuity/fanfic-leak-detector.js';
import { scanWorldGroupConflict } from '../../../continuity/world-group-conflict-detector.js';
import { DefaultSensitiveLexicon, scanSensitive, } from '../../../continuity/sensitive-lexicon.js';
import { ENGINE_GENRES } from '../../../continuity/genre-profile.js';
import { resolveNarrator } from '../../../continuity/pov-narrator.js';
import { checkPov } from '../../../continuity/pov-check.js';
import { DEFAULT_ERA_RESEARCH_BUDGET, NULL_ERA_RESEARCH_PROVIDER, runEraResearch, } from '../../../core/era-research.js';
import {
    VALIDATION_ERROR_CODES,
    ValidationContractError,
} from '../../../core/validation-contract.js';
import {
    checkChapterPublication,
    consumeChapterPublication,
    isExplicitNewContractContext,
    prepareChapterPublication,
    withGateContext,
} from '../chapter-validation.js';
import { runChapterPlan } from './chapter-plan.js';
import { runChapterSummary } from './chapter-summary.js';
import { runCoherenceJudge } from './coherence-judge.js';
import { runDraft } from './draft.js';
import { QualityGateFailure, evaluateChapterQuality, failsToViolations, } from '../../../continuity/quality-gate.js';
// Re-export so chapter-write-with-revise.ts can catch from a single barrel.
export { QualityGateFailure };
import { runProsodyScan } from '../../../continuity/prosody-scan.js';
import { COLD_OPEN_WINDOW_CHARS, detectStrongEventInColdOpen, } from './cold-open-beat.js';
/**
 * Layer-2 continuity gate raised this. Thrown by `commitPhase` so the
 * bounded-revise loop can catch it specifically without confusing a
 * sanitize/state error with a content error.
 */
export class ContinuityFailure extends Error {
    name = 'ContinuityFailure';
    violations;
    constructor(violations) {
        super(`ChapterWrite: continuity check failed with ${violations.length} violation(s); ` +
            `first: ${violations[0]?.code ?? 'unknown'} — ${violations[0]?.message ?? ''}`);
        this.violations = violations;
    }
}
/**
 * OutputSanitizer detected residual sentinel/leak after strip. This is a
 * structural failure of the writer (it did not emit a clean prose body) and
 * is not retriable as a continuity issue — the revise loop must produce a
 * fresh draft, not edit this one.
 */
export class SanitizeLeakError extends Error {
    name = 'SanitizeLeakError';
    constructor(message) {
        super(message);
    }
}
function runAuxScans(args) {
    const { prose, chapterNumber, foundation, sensitiveMode, castManifest, arcPosition } = args;
    const out = [];
    const emotionLexicon = new DefaultEmotionVerbLexicon();
    if (isEngineGenre(foundation.genre)) {
        out.push(...scanStyle({
            prose,
            chapterNumber,
            genre: foundation.genre,
            lexicon: new DefaultStyleLexicon(),
        }).violations);
    }
    out.push(...scanQuality({
        prose,
        chapterNumber,
        emotionLexicon,
        simileLexicon: new DefaultSimileMarkerLexicon(),
        onomatopoeiaLexicon: new DefaultOnomatopoeiaLexicon(),
    }).violations);
    out.push(...scanSentenceStats({ prose, chapterNumber }).violations);
    out.push(...scanDialogueMarkerVariety({ prose, chapterNumber }).violations);
    out.push(...detectCliffhanger({ prose, chapterNumber, arcPosition }).violations);
    out.push(...detectGapSkip({ prose, chapterNumber }).violations);
    out.push(...scanDialogueRatio({
        prose,
        chapterNumber,
        genreProfile: foundation.genreProfile,
    }).violations);
    out.push(...scanInfoRestate({ prose, chapterNumber, foundation }).violations);
    out.push(...scanFanficLeak({ prose, chapterNumber, foundation }).violations);
    out.push(...scanWorldGroupConflict({ prose, chapterNumber, foundation }).violations);
    out.push(...scanSensitive({
        prose,
        chapterNumber,
        lexicon: new DefaultSensitiveLexicon(),
        mode: sensitiveMode,
    }).violations);
    // N3 POV cross-check — HARD POV_VIOLATION on narrator knowledge leak.
    const { narratorId } = resolveNarrator({ prose, foundation, castManifest });
    out.push(...checkPov({
        prose,
        chapterNumber,
        foundation,
        narratorId,
        emotionLexicon,
    }).violations);
    return out;
}
function isEngineGenre(genre) {
    return ENGINE_GENRES.includes(genre);
}
// T11.2 — heuristic claim extraction. 첫 5 sentence 만 LLM 에 보내 비용 제한.
const ERA_CLAIM_LIMIT = 5;
function extractEraClaims(prose) {
    return prose
        .split(/(?<=[.!?。…])\s+|\n+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, ERA_CLAIM_LIMIT);
}
/**
 * Phase 1 — loadState + chapterPlan + draft.
 *
 * Side effects: none (no writes). Pure prep so the bounded revise loop can
 * call `commitPhase` repeatedly without redoing the (expensive) plan + draft
 * pair on every attempt.
 */
export async function draftPhase(ctx, input) {
    const { chapterNumber } = input;
    // 1. loadState ─────────────────────────────────────────────────────────────
    const foundation = await ctx.state.loadFoundation(ctx.workId);
    if (!foundation) {
        throw new Error(`ChapterWrite: foundation not found for work ${ctx.workId}`);
    }
    // 다국어 Phase 2A — 작품 언어 계약. **저장된 Foundation 메타데이터가 원천**이라
    // 생성 때 정한 언어가 이후 집필 호출에서 인자를 다시 받지 않아도 유지된다.
    // `ctx.workContract`/`ctx.language` 는 확인용이며 어긋나면 거부한다. 언어
    // 메타데이터가 없는 구형 작품은 호출자 인자대로(없으면 암묵적 ko)라 프롬프트가
    // 기존과 동일하다.
    const promptLanguage = resolveWorkPromptLanguage({
        foundation,
        workContract: ctx.workContract ?? null,
        language: ctx.language ?? null,
        length: ctx.length ?? null,
    });
    let prevState;
    if (chapterNumber === 1) {
        prevState = emptyStoryState(ctx.workId);
    }
    else {
        const loaded = await ctx.state.loadStoryState(ctx.workId, chapterNumber - 1);
        if (!loaded) {
            ctx.log.warn('chapter-write:prev-state-missing', {
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
    // 2. chapterPlan ───────────────────────────────────────────────────────────
    // Arc Flow Stage A — Arc context 가 있으면 plan 도 Arc 박자별 instruction 으로 생성.
    // ADR-0004 (#217) — plan output 의 scene declaration 도 함께 받음 (entity context).
    const planOutput = await runChapterPlan({
        foundation,
        prevState,
        chapterNumber,
        providers: ctx.providers,
        model: ctx.model,
        arc: ctx.arc,
        promptLanguage,
    });
    const { plan, scene, tension, openingContract } = planOutput;
    // 3. ADR-0001 (#215) — sliding window 묶음 (최근 N 화 ChapterSummary).
    //    가능하면 buildSlidingWindow → renderSlidingWindow → draft prompt 삽입.
    //    state.loadRecentChapterSummaries 미구현 (legacy StateStore) 또는 fail 시
    //    silently skip — draft 는 기존 path 그대로.
    let slidingWindowRender;
    try {
        if (typeof ctx.state.loadRecentChapterSummaries === 'function') {
            const window = await buildSlidingWindow({
                workId: ctx.workId,
                currentChapter: chapterNumber,
                state: ctx.state,
            });
            slidingWindowRender = renderSlidingWindow(window, promptLanguage);
        }
    }
    catch (err) {
        ctx.log.warn('chapter-write:sliding-window-failed', {
            workId: ctx.workId,
            chapterNumber,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    // 3b. ADR-0004 (#217) — entity context (이번 화 무대 entity 만 inject).
    //     plan 의 scene declaration + 작품 entity snapshot → resolveEntityContext.
    //
    //     P4b (#516, Epic #511) — NovelAI Lorebook activation-key 패턴 보강:
    //     직전 화(N-1) prose 에 canonicalName/alias 가 멘션된 entity 를
    //     scene.additionalRefs 에 합류시킨다. plan LLM 이 scene declaration 에서
    //     빠뜨린 entity 도 직전 화에 실제 등장했다면 prompt 에 도달 → 설정 모순
    //     방지. 실패는 기존 path 와 동일하게 fail-soft.
    let entityContextRender;
    try {
        if (typeof ctx.state.loadEntitySnapshots === 'function') {
            const snapshots = await ctx.state.loadEntitySnapshots(ctx.workId);
            let effectiveScene = scene;
            if (chapterNumber > 1 && snapshots.length > 0) {
                const prevArtifact = await ctx.state.loadArtifact(ctx.workId, chapterNumber - 1);
                if (prevArtifact && prevArtifact.prose.length > 0) {
                    const mention = scanEntityMentions({ text: prevArtifact.prose, snapshots });
                    const declared = new Set([
                        ...scene.settings,
                        ...scene.characters,
                        ...scene.items,
                        ...scene.antagonists,
                        ...scene.additionalRefs,
                    ]);
                    const activated = mention.mentionedIds.filter((id) => !declared.has(id));
                    if (activated.length > 0) {
                        effectiveScene = {
                            ...scene,
                            additionalRefs: [...scene.additionalRefs, ...activated],
                        };
                        ctx.log.info('chapter-write:mention-activated', {
                            workId: ctx.workId,
                            chapterNumber,
                            sourceChapter: chapterNumber - 1,
                            activatedIds: activated,
                            matchedTerms: mention.matchedTerms,
                        });
                    }
                }
            }
            const ctxRes = resolveEntityContext({ scene: effectiveScene, snapshots });
            entityContextRender = renderEntityContext(ctxRes, promptLanguage);
        }
    }
    catch (err) {
        ctx.log.warn('chapter-write:entity-context-failed', {
            workId: ctx.workId,
            chapterNumber,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    // 4. draft ─────────────────────────────────────────────────────────────────
    const { raw } = await runDraft({
        foundation,
        prevState,
        chapterNumber,
        plan,
        // EPIC #364 S3 (#367) — chapter-plan tension 슬롯을 draft step 으로 배선.
        // 없으면 draft 가 섹션 생략 (legacy 호환).
        tension,
        openingContract,
        providers: ctx.providers,
        model: ctx.model,
        // Arc Flow Stage A (EPIC #191) — handler 가 채워 넣은 활성 Arc 컨텍스트.
        // NULL 이면 draft.ts 가 Arc 헤더 생략 (legacy 작품 호환).
        arc: ctx.arc,
        slidingWindowRender,
        entityContextRender,
        // Engine Version Management Phase J (§11.2) — author custom prompt override.
        // NULL 이면 draft.ts 가 override 블록 생략 (legacy 작품 byte-identical).
        customPromptOverride: ctx.customPromptOverride,
        promptLanguage,
        // 승인된 포맷 정책(대사 문단 모드). 계약에 고정돼 있으면 계약이 이기고,
        // 어긋나면 조용히 덮지 않고 오류다. NULL 이면 계열 기본값.
        dialogueBreakMode: ctx.dialogueBreakMode ?? null,
    });
    return { prose: raw, foundation, prevState, chapterNumber, plan };
}
/**
 * Phase 2 — extractDelta → continuityCheck → sanitize → commitState.
 *
 * The revise loop calls this repeatedly with new `prose` on each attempt.
 * Throws `ContinuityFailure` on HARD FAIL (recoverable via revise) and
 * `SanitizeLeakError` on residual sentinels (not recoverable in this loop —
 * indicates the writer/reviser produced structurally broken output).
 *
 * Persistence (saveStoryState + saveArtifact) only happens on the success
 * path — a thrown error leaves the StateStore untouched.
 */
export function throwPreparedFailure(prepared, chapterNumber) {
    if (prepared.failure === 'sanitize-leak')
        throw new SanitizeLeakError(prepared.message);
    if (prepared.failure === 'continuity')
        throw new ContinuityFailure(prepared.violations);
    if (prepared.failure === 'quality')
        throw new QualityGateFailure(chapterNumber, prepared.fails, prepared.violations);
    throw new Error(`ChapterWrite: unpublished validation failure ${prepared.failure ?? 'unknown'}`);
}

async function commitNewContract(ctx, args) {
    const receipt = args.validationReceipt ?? args.receipt ?? ctx.validationReceipt ?? null;
    const canonical = args.canonical ?? args.canonicalArtifact ?? null;
    if (receipt == null || canonical == null)
        throw new ValidationContractError(VALIDATION_ERROR_CODES.MISSING_VALIDATION_RECEIPT, {
            reason: receipt == null ? 'absent' : 'missing_canonical_artifact',
        });
    return consumeChapterPublication(ctx, {
        ...args,
        validationReceipt: receipt,
        canonical,
        receipt,
    });
}

export async function commitPhase(ctx, args) {
    const storedFoundation = await ctx.state.loadFoundation(ctx.workId);
    if (isExplicitNewContractContext(ctx, { ...args, foundation: storedFoundation }))
        return commitNewContract(ctx, args);
    const { prose: raw, foundation, prevState, chapterNumber } = args;
    // 다국어 Phase 2A — commit 단계의 LLM 호출(coherence judge / chapter summary)도
    // draft 와 같은 계약을 본다. 원천은 draftPhase 와 동일하게 저장된 Foundation
    // 메타데이터이며, 언어 메타데이터가 없는 구형 작품은 프롬프트가 기존과 같다.
    const promptLanguage = resolveWorkPromptLanguage({
        foundation,
        workContract: ctx.workContract ?? null,
        language: ctx.language ?? null,
        length: ctx.length ?? null,
    });
    // 4. extractDelta ──────────────────────────────────────────────────────────
    // cast-manifest sentinel parsed BEFORE sanitize (sanitize strips it).
    const manifestBlock = ctx.sanitizer.extractBlock(raw, 'cast-manifest');
    const castManifestRaw = manifestBlock?.body ?? '{"cast":[]}';
    // Shared lexicon — currently per-call. Future task will lift this to
    // JobContext so `lexiconAdditions` from continuityCheck persist across
    // chapters within a single job.
    const lexicon = new DefaultHonorificLexicon();
    const { delta, manifest, unregisteredNamed } = await extractDelta({
        prose: raw,
        castManifestRaw,
        chapterNumber,
        foundation,
        prevState,
        providers: ctx.providers,
        model: ctx.model,
    });
    // 5. continuityCheck (aggregates layer-1 lexicon scan + layer-2 LLM) ───────
    const check = await continuityCheck({
        prose: raw,
        chapterNumber,
        delta,
        prevState,
        foundation,
        lexicon,
        providers: ctx.providers,
        model: ctx.model,
    });
    if (!check.passed) {
        ctx.log.warn('chapter-write:continuity-failed', {
            workId: ctx.workId,
            chapterNumber,
            hardCount: check.violations.filter((v) => v.severity === 'hard').length,
            softCount: check.violations.filter((v) => v.severity === 'soft').length,
        });
        throw new ContinuityFailure(check.violations);
    }
    // 6. sanitize ──────────────────────────────────────────────────────────────
    const sanitize = ctx.sanitizer.sanitize(raw);
    if (sanitize.leaked) {
        ctx.log.error('chapter-write:sanitize-leak', {
            workId: ctx.workId,
            chapterNumber,
            removedBlockCount: sanitize.removed.length,
        });
        throw new SanitizeLeakError(`ChapterWrite: output-sanitizer detected residual sentinel/leak in chapter ${chapterNumber}`);
    }
    // 6b. Phase 7+ aux scans — style / quality / structural SOFT signals + ────
    // sensitive content (HARD in youth mode only). Runs on clean prose so the
    // detectors don't trip on sentinel markers. HARD aborts before persistence.
    // Arc Flow Stage A — arcPosition 전달 → cliffhanger-detector 가 closing 만 lint.
    const auxViolations = runAuxScans({
        prose: sanitize.clean,
        chapterNumber,
        foundation,
        sensitiveMode: args.sensitiveMode ?? 'adult',
        castManifest: manifest,
        arcPosition: ctx.arc?.currentPosition,
    });
    // 6c. T11.2 era-research — eraResearch=true 장르 + worldEra 설정 시만.
    if (foundation.genreProfile.eraResearch === true && foundation.worldEra) {
        const provider = ctx.eraResearch ?? NULL_ERA_RESEARCH_PROVIDER;
        const claims = extractEraClaims(sanitize.clean);
        const { violations: eraViolations } = await runEraResearch({
            era: foundation.worldEra,
            claims,
            chapterNumber,
            provider,
            budget: { ...DEFAULT_ERA_RESEARCH_BUDGET },
        });
        auxViolations.push(...eraViolations);
    }
    const auxHard = auxViolations.filter((v) => v.severity === 'hard');
    if (auxHard.length > 0) {
        ctx.log.warn('chapter-write:aux-hard-fail', {
            workId: ctx.workId,
            chapterNumber,
            codes: auxHard.map((v) => v.code),
        });
        throw new ContinuityFailure([...check.violations, ...auxViolations]);
    }
    if (auxViolations.length > 0) {
        ctx.log.info('chapter-write:aux-soft', {
            workId: ctx.workId,
            chapterNumber,
            softCount: auxViolations.length,
            codes: auxViolations.map((v) => v.code),
        });
    }
    // 6d. Arc Flow Stage A (EPIC #191) telemetry — prosody + cold-open. ───────
    // Stage A 는 baseline 측정만, retry / hard fail X. log 만 출력.
    const prosody = runProsodyScan(sanitize.clean);
    ctx.log.info('chapter-write:prosody-baseline', {
        workId: ctx.workId,
        chapterNumber,
        score: prosody.score,
        breakdown: prosody.breakdown,
        sample: prosody.sample,
    });
    // ADR-0009 (#220) — chapter quality gate. opt-in via ctx.qualityThreshold.
    // 작가가 Work.metadata.qualityThreshold 를 set 하지 않은 작품은 gate skip
    // (코스트 + LLM 호출도 X). set 한 경우만 prosody + coherence judge + 평가.
    // fail 시 QualityGateFailure → bounded revise loop.
    if (ctx.qualityThreshold) {
        // codex #10 — `coherence === null` opts OUT of the coherence axis: skip
        // the judge LLM call entirely (no cost, no request) and evaluate prosody
        // only. Any other value (a number, or unset → engine default) keeps the
        // judge, so the prior behaviour is byte-identical for those cases.
        let coherence = { score: null, reason: null };
        if (ctx.qualityThreshold.coherence !== null) {
            coherence = await runCoherenceJudge({
                prose: sanitize.clean,
                chapterNumber,
                plan: args.plan,
                writerModel: ctx.model,
                providers: ctx.providers,
                promptLanguage,
            });
        }
        const qualityResult = evaluateChapterQuality({
            chapterNumber,
            prosodyScore: prosody.score,
            coherenceScore: coherence.score,
            threshold: ctx.qualityThreshold,
        });
        ctx.log.info('chapter-write:quality-gate', {
            workId: ctx.workId,
            chapterNumber,
            pass: qualityResult.pass,
            prosody: prosody.score,
            coherence: coherence.score,
            coherenceReason: coherence.reason,
            threshold: qualityResult.threshold,
            fails: qualityResult.fails,
        });
        if (!qualityResult.pass) {
            throw new QualityGateFailure(chapterNumber, qualityResult.fails, failsToViolations(chapterNumber, qualityResult.fails));
        }
    }
    if (chapterNumber === 1) {
        const coldOpen = detectStrongEventInColdOpen(sanitize.clean);
        ctx.log.info('chapter-write:cold-open-baseline', {
            workId: ctx.workId,
            chapterNumber,
            present: coldOpen.present,
            matched: coldOpen.matched,
            firstMatchAt: coldOpen.firstMatchAt,
            windowChars: COLD_OPEN_WINDOW_CHARS,
        });
    }
    // 7. commitState — fold delta into StoryState(N), persist artifact + state ─
    const nextDelta = { ...delta, chapterNumber };
    const nextState = reduceStoryState(prevState, nextDelta);
    await ctx.state.saveStoryState(nextState);
    const artifact = {
        workId: ctx.workId,
        chapterNumber,
        prose: sanitize.clean,
        delta: nextDelta,
    };
    await ctx.state.saveArtifact(artifact);
    // ADR-0001 (#215) — chapter summary 영속. fail-soft: runChapterSummary 의
    // 자체 fallback + 영속 fail swallow → chapter 발행 영향 0. saveChapterSummary
    // 미구현 legacy StateStore 도 skip.
    //
    // ⚠ phase 3(영수증/발행 게이트 소유자) 확인 지점: 이 요약 생성은 위의
    // `saveStoryState` + `saveArtifact` **뒤** 에 일어난다. 즉 회차 산출물이 이미
    // 저장된 뒤 요약 LLM 이 돈다. 발행/승인 게이트가 요약까지 포함한 영수증을
    // 요구한다면 이 순서를 게이트 쪽에서 다뤄야 한다 — 이번 범위(2A)는 프롬프트
    // 언어/분량 배선만 하고 기존 순서를 그대로 보존한다.
    if (typeof ctx.state.saveChapterSummary === 'function') {
        try {
            const summary = await runChapterSummary({
                prose: sanitize.clean,
                chapterNumber,
                writerModel: ctx.model,
                providers: ctx.providers,
                promptLanguage,
                // 요약 분량은 회차 분량 계약이 아니다. 호스트가 계약 단위로 명시하면
                // 그것을, 없으면 계약 단위의 기본 요약 목표를 쓴다.
                summaryLength: ctx.summaryLength ?? null,
            });
            await ctx.state.saveChapterSummary({
                workId: ctx.workId,
                chapterNumber,
                summary: summary.summary,
                plotBeat: summary.plotBeat,
                sceneTags: summary.sceneTags,
                povCharacter: summary.povCharacter,
                registeredEntities: [],
            });
        }
        catch (err) {
            ctx.log.warn('chapter-write:summary-failed', {
                workId: ctx.workId,
                chapterNumber,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    // Unregistered named characters surfaced by extractDelta — future task will
    // either (a) tighten the writer's manifest so the names disappear, or
    // (b) run a follow-up registerCharacter LLM call to add them to Foundation
    // before the next chapter.
    if (unregisteredNamed.length > 0) {
        ctx.log.warn('chapter-write:unregistered-named', {
            workId: ctx.workId,
            chapterNumber,
            unregisteredNamed,
        });
    }
    return { artifact };
}
/**
 * Single-shot composer: `draftPhase` then `commitPhase`. Throws
 * `ContinuityFailure` on HARD FAIL or `SanitizeLeakError` on residual
 * sentinels. For the bounded retry loop, use
 * `performChapterWriteBounded` from `chapter-write-with-revise.ts`.
 */
export async function performChapterWrite(ctx, input) {
    const gateCtx = withGateContext(ctx, input);
    const drafted = await draftPhase(gateCtx, input);
    if (isExplicitNewContractContext(gateCtx, { ...input, foundation: drafted.foundation })) {
        const prepared = await prepareChapterPublication(gateCtx, { ...drafted, ...input });
        if (!prepared.ok)
            throwPreparedFailure(prepared, drafted.chapterNumber);
        const checked = await checkChapterPublication(gateCtx, prepared);
        return commitPhase(gateCtx, {
            ...drafted,
            ...checked,
            validationReceipt: checked.receipt,
            canonical: checked.canonical,
        });
    }
    return commitPhase(ctx, drafted);
}
