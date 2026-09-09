/**
 * Public library surface of @vibelore/novel-engine.
 *
 * Hosts import the exports below. Files inside subdirectories are implementation
 * details unless their interfaces are explicitly documented.
 */
export { CAST_MODALITIES } from './core/types.js';
export { normalizeCustomPromptOverride, renderCustomPromptOverride, } from './core/custom-prompt-override.js';
export { arcPositionFromRatio, ARC_POSITION_LABEL_KO } from './core/arc-context.js';
export { formatArcHeader } from './generators/text/steps/draft.js';
export { checkContradictionStrength, getContradiction } from './continuity/character.js';
export { STRONG_EVENT_CATALOG, COLD_OPEN_WINDOW_CHARS, detectStrongEventInColdOpen, buildColdOpenInstruction, } from './generators/text/steps/cold-open-beat.js';
export { runProsodyScan } from './continuity/prosody-scan.js';
export { CHARACTER_ARC_BEATS, MAX_ACTIVE_CHARACTER_ARCS, activeArcCount, isCharacterTracked, advanceCursor, seedInitialArcPromiseFromSynopsis, } from './continuity/character-arc.js';
export { createProviderRegistry } from './core/provider-registry.js';
export { createUsageTrackingRegistry, ProviderCallBudgetError, } from './core/usage-tracking-registry.js';
export { createOpenAIAdapter, ProviderCallError } from './adapters/openai-fetch-adapter.js';
export { ENGINE_VERSION, collectPromptManifest, collectPromptManifestWithHash, computePromptManifestHash, } from './core/engine-version.js';
export { DEFAULT_QUALITY_THRESHOLD, PROSODY_LEVELS, prosodyThresholdForLevel, QualityGateFailure, evaluateChapterQuality, failsToViolations, } from './continuity/quality-gate.js';
export { runCoherenceJudge } from './generators/text/steps/coherence-judge.js';
export { runNextArcProposal } from './generators/text/steps/next-arc-proposal.js';
export { validateAndFoldNarrativePlan } from './core/narrative-planning.js';
export { prepareNarrativeCommit } from './core/planning-authority.js';
// SDK provider 어댑터(OpenAI/Anthropic/Google/XAI)·CLI 는 이식 제외(NEP-S1 D2) — 등록은 createProviderRegistry 로 주입.
export { SENTINEL_OPEN, SENTINEL_CLOSE, RESERVED_SENTINEL_TAGS, DefaultOutputSanitizer, } from './core/output-sanitizer.js';
export { SENTINEL_KINDS, SENTINEL_SCHEMAS, SENTINEL_FAIL_POLICY, castManifestV1Schema, entityOpsV1Schema, arcCursorOpsV1Schema, hookOpsV1Schema, sentinelEnvelopeSchema, validateSentinelBlock, extractAllSentinels, attemptSentinelRepair, } from './core/sentinel-schema.js';
export { FileStateStore } from './core/state-store.js';
export { MemoryStateStore } from './core/memory-state-store.js';
export { EMPTY_SCENE, renderEntityContext, resolveEntityContext, } from './core/entity-context.js';
export { scanEntityMentions } from './core/mention-scan.js';
export { approxTokens, buildSlidingWindow, renderSlidingWindow } from './core/sliding-window.js';
export { runChapterSummary } from './generators/text/steps/chapter-summary.js';
export { ENTITY_KINDS, ATTRS_SCHEMAS, DEFAULT_ENTITY_PROFILE, STREAMING_LITRPG_PROFILE, entityProfileFor, } from './continuity/entity-profile.js';
export { foldEntityOps, scanDestroyedEntityMentions } from './continuity/entity-ops.js';
export { runEntitySeed } from './generators/text/steps/entity-seed.js';
export { runEraResearch, DEFAULT_ERA_RESEARCH_BUDGET, NULL_ERA_RESEARCH_PROVIDER, } from './core/era-research.js';
export { DEFAULT_REVISE_POLICY, createOrchestrator } from './core/orchestrator.js';
export { effectiveIntrinsic } from './continuity/character.js';
export { createFoundation, registerCharacter, appendIntrinsicChange, resolveCharacter, } from './continuity/foundation.js';
export { reduceStoryState, emptyStoryState } from './continuity/story-state.js';
export { DefaultHonorificLexicon, KO_HONORIFIC_SEED } from './continuity/honorific-lexicon.js';
export { ENGINE_GENRES, createGenreProfileRegistry } from './continuity/genre-profile.js';
export { GENRE_FACETS, facetsForGenre, allGenresCovered } from './continuity/genre-facets.js';
export { scanLexicon } from './continuity/lexicon-scan.js';
export { extractDelta, continuityCheck } from './continuity/continuity-check.js';
export { TextGenerator } from './generators/text/text-generator.js';
export { performBookCreate } from './generators/text/steps/worldbuild.js';
export { llmCastDesign } from './generators/text/steps/cast-design.js';
export { foundationInit } from './generators/text/steps/foundation-init.js';
// Foundation review REVISE (rewrite-revise-worklock.plan Item 2) — fold founder
// feedback onto an existing Foundation, append-only (no character removal).
export { reviseFoundation } from './generators/foundation/revise-foundation.js';
export { runChapterPlan } from './generators/text/steps/chapter-plan.js';
export { runDraft, DEFAULT_TARGET_WORD_COUNT } from './generators/text/steps/draft.js';
// Phase J merge test surface — draft system/user prompt builders (module-private otherwise).
export { __buildDraftSystemForTest, __buildUserPromptForTest, } from './generators/text/steps/draft.js';
export { performChapterWrite, draftPhase, commitPhase, ContinuityFailure, SanitizeLeakError, } from './generators/text/steps/chapter-write.js';
export { runRevise } from './generators/text/steps/revise.js';
// EPIC #254 (다시쓰기) — author-directed chapter rewrite step.
export { runRewrite } from './generators/text/steps/rewrite.js';
export { REWRITE_SYSTEM, buildRewriteUserPrompt, } from './generators/text/prompts/rewrite.js';
export { performChapterWriteBounded, runBoundedCommitLoop, CleanFailError, } from './generators/text/chapter-write-with-revise.js';
// EPIC #254 (다시쓰기) — bounded rewrite (runRewrite + shared commit/revise loop).
export { performChapterRewriteBounded } from './generators/text/chapter-rewrite-with-revise.js';
// V-D6 (NEP-V5, novel-engine-wiring-plan.md §8.1): the Korean content-sensitivity
// lexicon (notFollowedBy context guard — not a naive substring blocklist), so
// Host moderation gates can reuse the SAME
// scan the engine's own chapter-write step runs, instead of a second ad-hoc list.
export { DefaultSensitiveLexicon, scanSensitive, KO_SENSITIVE_SEED } from './continuity/sensitive-lexicon.js';
// 다국어 Phase 1 — 작품 언어/분량 계약. MCP 도구·프롬프트 selector·검사기(2B)가
// 같은 정책 결정과 측정 계약을 공유하기 위한 공개 표면.
export { LANGUAGE_POLICY_SCHEMA_VERSION, LANGUAGE_DIRECTIVE_VERSION, MEASUREMENT_POLICY_VERSION, FORMAT_POLICY_VERSION, CHECKER_POLICY_VERSION, PROMPT_FAMILY_KO, PROMPT_FAMILY_MULTILINGUAL, PROMPT_FAMILIES, LENGTH_UNITS, DEFAULT_LENGTH_TARGET, LEGACY_LENGTH_FIELDS, IMPLICIT_LEGACY_LANGUAGE, GRAPHEME_MEASUREMENT_LOCALE, CANONICAL_FORMAT_VERSION_LEGACY_KO, CANONICAL_FORMAT_VERSION_MULTILINGUAL, LANGUAGE_EXCEPTION_KINDS, LANGUAGE_ERROR_CODES, LENGTH_MEASUREMENT_CONTRACT, LanguagePolicyError, normalizeLanguageTag, inspectLanguageTag, identifyLanguage, promptFamilyFor, resolveCreationLanguage, resolveExistingWorkLanguage, defaultLengthFor, resolveLengthContract, resolveMeasurementPolicy, isWordMeasurementSupported, computeMeasurementPolicyHash, validateLengthMeasurementResult, resolveCanonicalFormatVersion, normalizeLanguageExceptions, buildLanguageContract, canonicalizeLanguageContract, computeLanguageContractHash, buildLanguageDirective, } from './core/language-policy.js';
