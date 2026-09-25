/**
 * Korean prompt module for the book and chapter pipelines.
 *
 * Centralizes the system + user prompt strings used by the BookCreate
 * (worldbuild, cast-design) and ChapterWrite (draft, revise) pipelines so
 * they are version-controllable and testable independently from the step
 * code that wires them up.
 *
 * Not included here: extractDelta + continuityCheck prompts live in
 * `continuity/continuity-check.ts` alongside their parsers — they are tightly
 * coupled to the response shape and stay co-located by design.
 *
 * Each module exports a `*_SYSTEM` string constant plus a
 * `build*UserPrompt(input)` pure builder. No I/O, no provider calls.
 *
 * 다국어 Phase 2A — 기존 이름은 **한국어 계열 값 그대로** 유지되고, 계열 선택은
 * 새 이름으로만 얹는다(`*_MULTILINGUAL` 상수 + `*SystemFor(context)` 선택자 +
 * `public*SystemStatic(family)` 캡처). 기존 호출자는 바뀐 것이 없다.
 */
export {
    WORLDBUILD_SYSTEM, WORLDBUILD_SYSTEM_MULTILINGUAL, buildWorldbuildUserPrompt,
    publicWorldbuildSystemStatic, worldbuildSystemFor,
} from './worldbuild.js';
export {
    CAST_DESIGN_SYSTEM, CAST_DESIGN_SYSTEM_MULTILINGUAL, buildCastDesignUserPrompt, castDesignInputFrom,
    castDesignSystemFor, publicCastDesignSystemStatic,
} from './cast-design.js';
export {
    DRAFT_SYSTEM, DRAFT_SYSTEM_MULTILINGUAL, DRAFT_FEWSHOT, DRAFT_FEWSHOT_MULTILINGUAL,
    buildDraftUserPrompt, draftSystemFor, publicDraftSystemStatic,
} from './draft.js';
export {
    REVISE_SYSTEM, REVISE_SYSTEM_MULTILINGUAL, REVISE_PATCH_SYSTEM, REVISE_PATCH_SYSTEM_MULTILINGUAL,
    buildReviseUserPrompt, buildRevisePatchUserPrompt, reviseSystemFor, reviseSystemStatic,
    revisePatchSystemStatic,
} from './revise.js';
export {
    REWRITE_SYSTEM, REWRITE_SYSTEM_MULTILINGUAL, buildRewriteUserPrompt, rewriteSystemFor,
    rewriteSystemStatic,
} from './rewrite.js';
export {
    REVISE_FOUNDATION_SYSTEM, REVISE_FOUNDATION_SYSTEM_MULTILINGUAL, buildReviseFoundationUserPrompt,
    reviseFoundationSystemFor, reviseFoundationSystemStatic,
} from './revise-foundation.js';
