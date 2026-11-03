# Webtoon Visual Review Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. The user has authorized proceeding without further planning questions.

**Goal:** Run actual Terra inspection and make evidence-based visual review reusable.
**Architecture:** Persist an optional work-level reviewer hint in the existing support policy. Version the review contract independently from the image binding and explicitly reopen only the review stage for existing images.
**Tech Stack:** Node.js ESM, native node:test, MCP host relay.
**Spec:** docs/superpowers/specs/2026-10-29-webtoon-review.md

## Global Constraints

- Preserve existing pending request IDs, image bytes, image model and novel canon.
- No further paid image call; no GitHub Actions.
- Host hints are not verified execution provenance.

## Review Focus

- Null and omitted model settings have different semantics: clear vs preserve.
- Existing pending requests remain answerable after code/config updates.
- Re-review invalidates only its old review run, not the image/preflight.
- Failed/uncertain observations cannot be overridden by aggregate true booleans.
- References and actual observations, rather than intended poses, support verdicts.

## Task 1: Persist and route the reviewer

Files: src/core/review-policy.js, src/tools/configure.js, src/tools/webtoon-scene.js, src/server.js; test/review-policy.test.js, test/webtoon-scene.test.js.

- [x] Add failing tests for model persistence/null/invalid input and image-review-only host routing.
- [x] Run tests and confirm missing functionality fails.
- [x] Implement work-level webtoonReviewModel and explicit action=review on the preserved image; leave existing pending runs pinned.
- [x] Verify model selection and re-review without image jobs or budget/revision changes.

## Task 2: Require visible evidence

Files: src/core/webtoon-scene.js, new src/core/webtoon-scene-review.js, src/tools/webtoon-scene.js, scene fixtures/tests, docs/MODELS.md and .en.md, docs/reference/WEBTOON_WORKFLOW.md and .en.md, skills/webtoon-discovery-interview/SKILL.md, AGENTS.md.

- [x] Add failing tests for incomplete observations and failed/uncertain checks overriding broad pass claims.
- [x] Implement the versioned prompt/checks and attach available scene references with role descriptions.
- [x] Verify legacy pending reviews stay valid and new reviews demand all five evidence checks.
- [x] Run npm test and npm run check:source; review the diff.
- [x] Configure this work for gpt-6.1-terra, reopen the same image review, obtain Terra's actual answer to the new request, and import it.
- [x] Preserve the result, prompt and reviewer audit; show the first scene with honest remaining defects.

## Verification and review record

- Baseline: 39 existing scene/policy tests passed.
- New behavior tests failed before implementation: reviewer persistence/routing, explicit re-review, required visual observations and failure precedence.
- Targeted scene/style/language/runtime/source tests: 72 passed. New review tests: 6 passed.
- Full local `npm test`: 1,030 passed, zero failed. `npm run check:source` and `git diff --check` passed.
- Actual GPT-6.1 Terra agent inspected the generated scene with the adopted cast/style and environment reference; its exact v2 response was imported against the real request ID. Native result is scene_needs_revision; no additional drawing job was issued.
- Terra code review found that the pending-request archive needed its run ID, request ID, start time and partial response. A regression assertion failed, then passed after archiving the entire pending object. The full suite above includes that fix.
- Visual semantics remain model judgments: evidence structure does not prove the correctness of a not_applicable classification. The prompt requires a reason and retained evidence for human review.
- Changes remain in the current checkout. Novel canon and earlier image editions are preserved.
