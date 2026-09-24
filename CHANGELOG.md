# Changelog

## Unreleased

- Keep `textPolicyVersion` through segmented webtoon plan assembly; the outline
  probe and part checks now use the same scope as the final plan check, and
  plan-part requests state a per-part shot cap and layout bounds.
- Make the advisory review timeout configurable with
  `VIBELORE_REVIEW_TIMEOUT_MS` (default 45s). It only applies when the server
  calls a local adapter itself; the host relay is unaffected.

## 0.3.7 — 2026-09-22

- Raise the writer packet ceiling from 1400 to 4000 token units and share the
  constant between the draft step and the plan-stage check. The packet carries
  only this episode's plan, the arc beat and a capped residue, so the ceiling
  now acts as a compressor for a verbose plan instead of a tight cut.

## 0.3.6 — 2026-09-22

- Check the writer packet budget when an episode plan is accepted: a plan
  that would overflow the 1400-token packet gets one `episode-plan-repair`
  request asking for shorter sentences, and a repaired plan that still
  overflows fails at planning time instead of after the plan is saved.
- Stop spending packet budget on duplicates: an exit state that repeats the
  next question is rendered once, and a previous-chapter arc residue that
  names the beat this episode already carries is dropped from Character Carry.

## 0.3.5 — 2026-09-22

- Rewrite README around what a writer sees: hero with showcase panels,
  without/with contrast, 30-second novel and webtoon flows, per-host
  collapsible install, feature list, philosophy summary and FAQ. Webtoon
  adaptation is presented alongside novel writing instead of as an appendix.

## 0.3.4 — 2026-09-22

- Split the model-profile `quality` stage: `review` now covers the advisory
  reviews (coherence, editorial, character, reader, arc, profile drift) and
  `light` applies to it, while `quality` keeps delta extraction, the semantic
  continuity check and the pattern ledger on the default model because their
  answers become story state and future draft constraints.
- Document batched round trips, the plan repair request, the host execution
  note and the new stage in README, MODELS, TOOLS, MCP and ARCHITECTURE.

## 0.3.3 — 2026-09-22

- Drop the engine chapter-plan host round trip from `lore_write`: the draft
  prompt already takes its plan from the approved EpisodePlan packet and the
  engine answer never reached it.
- Append a self-contained execution note to every relayed request so CLI
  hosts answer from the provided `system`/`user` alone without reading files
  or spending agent turns.
- Align the Codex plugin manifest version with the package version.

## 0.3.2 — 2026-09-22

- Batch independent `lore_write` model requests into one host round trip
  (extraction, profile check and reviews; then the delta-dependent continuity
  check and arc review; then boundary and summary). A resumed workflow no
  longer exposes requests built on placeholder answers or re-logs stage events.
- Validate optional episode-plan modules (character agendas, reveal contracts)
  at planning time with the commit validator and issue one
  `episode-plan-repair` request instead of failing after drafting and review.
- Send compact JSON in continuity prompts and ask the extractor for compact
  output; give reviewers an EpisodePlan view without bookkeeping fields or
  duplicated scene aliases.
- Tell hosts that requests in one `needs_model` response are independent and
  may be answered in parallel.

## 0.3.1 — 2026-09-21

- Add `lore_webtoon_scene`: an opt-in path that adapts a fixed source range
  into one English scene brief, checks it before any paid image call, renders
  the whole scene with in-image lettering, and reviews the actual image.
- Reduce the drawing request to a short `renderBrief` with a `drawability`
  verdict during preflight; overloaded moments block generation instead of
  being passed to the image model as advisories.
- Let the user choose the panel count as an integer or `auto`; `auto` picks
  3–12 panels afresh on every adaptation, the interview offers 4/6/8/9/auto,
  and counts below three return a continuity warning.
- Continue from a previous scene with `previousWorkflowId`, comparing the two
  actual images for identity, setting and action transition.
- Include scene workflows in snapshot recovery and keep panel workflows on the
  existing tools.

## 0.3.0 — 2026-09-20

- Add three public webtoon tools for adaptation planning, image/lettering work,
  and version-bound approvals, with separate webtoon state and publication.
- Require art, lettering and format choices; select essential story beats,
  review bounded scene packets, and approve rough storyboards before final art.
- Schedule independent shots from approved roughs while retaining sequential
  image dependencies and actual adjacent-image continuity reviews.
- Separate dialogue, thoughts, narration, sound effects and in-world writing;
  export SVG/HTML masters with bundled OFL-licensed font outlines.
- Persist confirmed image model/execution choices without server-side paid API
  calls. Preserve novel input validation, locking, recovery and model profiles.
- Add workflow documentation, host guidance and synthetic MCP regressions.
- Keep webtoon publication and bound audit/pending runs across prose rollback,
  including interrupted recovery, without restoring stale prose authorizations.

Live image-quality certification is separate from automated workflow tests.

## 0.2.0 — 2026-09-14

- Leak checks now look for generic machine annotations.
- Added an optional `modelProfile` to `lore_write`: per-stage model and
  reasoning-effort hints (`default`, `light`, `identity`, `planning`, `draft`,
  `quality`, `final`) surfaced on each `needs_model` request, persisted on the
  workflow, and honored directly by the local provider for `provider: "local"`.
- Redefined the StoryState hook record with vibelore's own field names and
  lifecycle values; snapshots from earlier builds are normalized on load.
- Added a source check and a release approval gate;
  successful technical checks do not authorize public redistribution.

## 0.1.0 — 2026-09-13

First public Apache-2.0 release of the local novel-writing MCP server.

- Guided and automatic writing workflows with continuity checks, review evidence,
  human approval, and editable Markdown manuscripts.
- Version-2 recovery snapshots validate identity, file inventory and hashes.
  Rollback publishes a consistent new canonical state, archives stale approvals,
  and resumes interrupted materialization on the next MCP call.
- Validated MCP inputs, bounded input queues, cross-process project locking,
  and a 120-second timeout for optional local model requests.
- Node.js 22.13.0+ in the 22.x family and Node.js 24.x support; no dependency
  installation or build step. CI checks Linux, macOS, and Windows.
- Public history excludes private novels, local host settings and experimental
  model transcripts. See SECURITY.md.

Legacy snapshots without a version-2 manifest require manual migration into a
separate work directory. Network filesystems and multi-tenant hosting are not
supported. Model judgments remain advisory and do not guarantee literary quality.
