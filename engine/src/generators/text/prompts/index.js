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
 */
export { WORLDBUILD_SYSTEM, buildWorldbuildUserPrompt, } from './worldbuild.js';
export { CAST_DESIGN_SYSTEM, buildCastDesignUserPrompt, castDesignInputFrom, } from './cast-design.js';
export { DRAFT_SYSTEM, DRAFT_FEWSHOT, buildDraftUserPrompt, } from './draft.js';
export { REVISE_SYSTEM, buildReviseUserPrompt, } from './revise.js';
