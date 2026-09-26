# Changelog

## Unreleased

- Fix: an arc approved after the previous arc completed is now published with
  the next commit. Commits, context assembly and status read plans from the
  working store where the approval tools write them; they used to read the
  plans sealed in the last publication, so a finished arc stayed the published
  arc forever and context showed "no arc plan".
- Fix: the draft prompt now receives the recent chapter summaries (the
  sliding window, up to five chapters, oldest first). Before, `lore_write`
  passed the summary count instead of the summaries, so the writer saw only
  the previous chapter's closing scene and the carried state.
- The draft prompt also receives older retrieved memory (summaries beyond the
  window, entities and off-cast characters, up to eight items) as canon
  material, not instructions. World facts, the planned cast and active hooks
  are left out there because Foundation and the previous state already carry
  them.
- Retrieval no longer returns summaries already in the window, and a redraft
  no longer sees canon registered in the chapter it replaces or later. The
  `lore_context` memory section changes accordingly.
- Over its continuity budget the draft drops the lowest-ranked memory, then
  the oldest summaries, then shortens the newest summary instead of failing.
  Continuity text with control characters, reserved markup or instruction-like
  content is left out. Every omission is recorded in the draft trace.
- Memory search splits words with `Intl.Segmenter` in the work language, so
  `ja`, `zh-Hant`, `th`, `ar` and accented Latin works retrieve older memory,
  and a Korean word with a common particle also matches its stem (`수아가`
  and `수아는` meet at `수아`).
- StoryState records character state per chapter (`characterStates`): the
  extractor may set `vitalStatus` (`alive`, `dead`, `missing`), and location,
  status and accumulated known facts carry forward. A character recorded dead
  who is in a later chapter's cast manifest is a hard
  `DEAD_CHARACTER_ON_STAGE` violation unless that chapter records them alive
  again. The writer sees `characterStates`, and the manifest rules now say a
  remembered or mentioned character is not an appearance.
- The extractor can emit `entityOps` (register, update, retire with
  `cause: "destroyed"`), so entity lifecycle reaches the entity snapshots on
  commit. It is shown the known entities. A destroyed entity named again in a
  later chapter is a soft `DESTROYED_ENTITY_MENTION` advisory.
- Tracked entities keep one record per natural key within a kind (name, fact,
  event, from/to and similar) instead of one record per kind, so a new
  KnowledgeMatrix fact or Timeline event no longer erases the earlier ones.
  Prompts show the latest eight records per kind.
- Relationships carry a `from` side; `A -> C` and `B -> C` of the same kind
  are separate entries. Legacy entries without `from` stay as they are.
- The extractor and the semantic checker see active hook text and phase,
  character states and recent tracked records, not only ids. The writing
  context lists only open hooks under unresolved hooks.
- Address entries are recorded only when the chapter prose supports them:
  the term must occur in the prose and must not contain another registered
  character's name or alias. The extractor, `lore_commit` with a preset delta
  and `lore_refold` apply the check, rejected entries surface as a soft
  `ADDRESS_ENTRY_REJECTED` advisory, and a refold clears entries an earlier
  extractor wrote with speaker and target swapped.
- The previous-scene join rule now opens a chapter straight into a new action
  or reaction and forbids repeating or restating the previous chapter's last
  sentence, line or image. Before, it asked the writer to show how the scene
  continued, and chapters opened by replaying the last line.
- Payoff guidance asks for results the reader feels through action, dialogue
  and change in the scene instead of "on-screen evidence", which pulled
  climaxes toward documents and ledgers.
- Cast design no longer seeds every character with the example's silver hair
  and left-cheek scar: the schema examples are neutral placeholders, and a
  rule asks for different kinds of marks on different body parts, not a mark
  on everyone.
- Edits to `world/` or `characters/` no longer stall writing with no way out.
  `lore_sync action=validate` shows which world facts and characters changed
  and which published plans mention them, and `action=apply` with that
  approval id publishes the edited Foundation without a model call. Plans are
  not rewritten and published chapters are not re-checked; the approval goes
  stale if the files change after validation.
- Default-surface guidance no longer points to advanced-only tools:
  `lore_status`, the writing context and `lore_sync` now name `lore_write`
  (which creates the chapter plan) instead of `lore_episode_plan`,
  `lore_episode_decide` or `lore_refold`. An edit to an earlier chapter is
  reported as not yet supported by the default tools.
- A hand edit that only changes whitespace or line breaks in `world/`,
  `characters/` or `chapters/` no longer counts as working-tree drift, so it
  neither blocks `lore_write` nor triggers a model re-check. Fingerprints now
  also record a whitespace-free content digest; fingerprints captured before
  this keep comparing raw bytes until the next capture.
- An oversized assembled writing context no longer stops `lore_write`,
  `lore_rewrite` or the character review. Those paths record the overflow in
  the context trace and the draft audit (`contextOverflow`) and continue,
  without older memory when the world facts and active hooks alone exceed
  the memory budget. `lore_context` still refuses an oversized context.
- A whole-chapter rewrite (`lore_rewrite`) gets the same recent summaries and
  older memory a draft of that chapter would get.
- The memory index is rebuilt from an empty file, so a `memory.db` written by
  a Node build with a different SQLite (such as one with FTS5) or a damaged
  file no longer blocks context assembly.
- Webtoon scenes: a previous scene whose image review failed is no longer
  sent to the image model as a drawing reference, so its defects do not carry
  into the next scene. The continuity review still compares against it, and
  a changed previous image still stops the workflow. A passed previous scene
  is carried as before.

## 0.4.0 — 2026-09-24

- Integrate novel work language (BCP 47) support end to end, with an
  8-language regression sample (`ko`, `en`, `ja`, `zh-Hant`, `es`, `ar`, `fr`,
  `th`) covering novel writing and the scene webtoon flow.
- Scene webtoons inherit the work's language; the image prompt names the
  language, script and reading direction (including right-to-left for `ar`).
- Lettering comparison between the plan and the observed image text is NFC
  normalized, and the reviewer transcribes observed text in the drawn script.
- Right-to-left scene prompts (such as `ar`) also state the page reading
  order: rows top to bottom, panels within a row right to left, and the first
  spoken line at the right or top. Left-to-right prompts are unchanged.
- Scene lettering drops a matched dialogue quotation pair (any script) that
  wraps the whole line and Markdown emphasis around a word or phrase, and
  keeps the inner words verbatim; lone or inner quote marks, apostrophes and
  censor asterisks (`f*ck`, `시*`) stay. The image prompt and the
  plan-vs-source check use the same normalization; review accepts a drawn
  wrapping quote pair but fails literally drawn emphasis markers.
- The lettering match accepts both standard placements of Arabic tanween
  al-fath (on the final alif or on the letter before it). Other diacritic
  differences still fail.
- Physical in-scene writing (plan text kind `physical`) is lettered on its
  paper, sign or screen, never in a balloon, and the scene planner is told the
  five text kinds. Scene image prompts in every language, including `ko`, now
  also forbid invented numbers, notes, tables, charts and signage.
- Scene direction fields must be Latin-script English regardless of the work
  language.
- Scene user-facing messages (questions, warnings, notices) are `ko` or `en`
  by work language.
- Deprecate the `lore_webtoon_plan` per-panel path: new MCP workflow starts on
  that path are blocked with `WEBTOON_PANEL_PATH_DEPRECATED`, directing
  callers to `lore_webtoon_scene`.
- Episode-plan repair instructions follow the work-language prompt family
  instead of a fixed language.
- Restore the advisory story-profile check on the `lore_write` contract-check
  path.
- Closing-arc chapters get the cliffhanger advisory again on the contract
  check path (the arc position is passed to the detectors).
- The approval language gate classifies the cast-design `intrinsic.genderLabel`
  as work-language text, so `lore_create` no longer ends in `clean_fail
  INCOMPLETE_LANGUAGE_EVIDENCE` after every reviewer answer passed. A generated
  `intrinsic.ageBand` ("early twenties") is now reviewed as work-language text
  instead of being exempt as an enum; only the `unknown` default stays machine.
  A new test derives the fields from the live generator prompt schemas.
- Review-mode StoryProfiles no longer fail the language gate for every non-`ko`
  work because of a fixed English "Reading difficulty" question. The model now
  writes that open question in the work language like the others, and it is
  reviewed as generated text. When the model omits it, the host inserts its
  static `ko`/`en` question, which is bound to the approval hash but is not a
  work-language artifact.
- Chapter summaries (`summaries/NNN.md`) use the canonical format heading:
  v1 works keep `## 요약`, v2 (non-`ko`) works write `## Summary`. Reading
  accepts both headings, so summaries already written with `## 요약` in a v2
  work still load.
- Relayed requests (`needs_model`) carry the execution note, JSON note and
  shared-prefix markers in the work's prompt family: `ko` works keep the
  Korean text byte for byte, other works get English, so a Korean note no
  longer pulls a non-`ko` answer into Korean. The shared chapter-prose label
  follows the family too.
- Non-`ko` StoryProfiles no longer get English host defaults ("Design question
  N", "web serial", the reader-legibility and register-policy guidance) in
  work-language fields when the model omits them. The multilingual prompt asks
  for those values in the work language; if one is still missing it is stored
  empty and the runtime prompt guidance falls back to the static instruction.
  `ko` defaults are unchanged.
- Fix the writing-context token budget (`src/tools/context.js`) to estimate
  non-`ko` works with the script-aware `tokenUnits()` estimator instead of a
  flat `chars / 2`, which overcounted sparse scripts like English by roughly
  2x and could throw a false `context_overflow` on a legitimately sized
  English chapter while `ko` passed. `ko` works keep the exact 0.3.10
  `chars / 2` estimate, byte for byte, including on mixed Hangul/ASCII/JSON
  content. The `context_overflow` error text now follows the work's `ko`/`en`
  prompt family and no longer implies an automatic scene split or re-plan
  that the product does not perform.
- Non-`ko` works also use `tokenUnits()` for the staged-entity budget, the
  recent-summary sliding window and optional memory selection, so English and
  other Latin-script works are no longer trimmed at about half the material a
  `ko` work of the same content gets. The `used ~Nt` numbers in those prompt
  headings change for non-`ko` works. `ko` works, and engine callers that
  name no prompt family, keep the exact 0.3.10 `/ 2` estimates, so the same
  entities, summaries and memories are selected with the same headings.
  `tokenUnits()` now has a single implementation in the engine, and the plugin
  re-exports it.
- Fix the `lore_write` post-review quality-gate revise cap. It held only
  within one call: the attempt counter restarted on every resume, so a host
  resuming after each round trip could get unlimited quality revisions. The
  workflow now stores how many quality revisions it applied. Across resumes
  it allows two revisions and then ends in `clean_fail`, the same as one
  uninterrupted call. A new user round refills the budget:
  `lore_decide(action="request_revision")`, or `retryValidation` on a
  `clean_fail` draft. The mandatory-validation budget is unchanged.
- The staged-entity and recent-summary sections of the writing context now use
  English labels in non-`ko` works, for example `## Entities on stage this
  chapter` and `## Recent N chapter summaries`. Like every other heading in the
  prompt, they follow the prompt family (canonical files such as the stored
  summaries keep the v1/v2 format rule). `ko` works keep the Korean labels byte
  for byte.

### Existing Korean works: what changes in `lore_write`

Korean (`ko`) works keep the Korean prompt family, but every chapter now goes
through the same contract validation gate as other languages.

- **Validation gate and receipts.** Each chapter is checked against the live
  work contract (plans, profile, language, published HEAD). A passing check
  issues a validation receipt bound to that identity, and commit consumes it.
  A plan or contract change after the check makes the receipt stale instead of
  committing it.
- **Persistent validation budget.** Extraction and semantic validation share a
  three-attempt budget per validation epoch that survives resumes. A model
  transport failure returns `provider_error` without spending the budget, and
  the next `lore_write` resumes.
- **`clean_fail` and `retryValidation`.** When the budget runs out the draft is
  kept. A bare `lore_write` returns the same `clean_fail` without calling a
  model; `lore_write(retryValidation=true)` re-checks the kept draft in a new
  epoch.
- **Re-validation instead of redrafting.** When only canon, plans or the
  contract changed after the check (an arc or episode plan edit,
  `STALE_WORK_CONTRACT`, or a hand edit published with `lore_sync`),
  `lore_write` (bare or with `retryValidation=true`) re-validates the same kept
  prose under the current contract instead of drafting again.
  - It covers a `clean_fail` draft, a guided draft waiting for approval, and a
    `ready_to_commit` draft whose auto-commit failed.
  - The old receipt and approval are void. The re-check issues a fresh receipt
    with a fresh three-attempt budget (also for a `clean_fail` that had spent
    its budget), repairs hard violations within that budget, then asks for
    approval (`guided`) or commits (`auto`) as usual.
  - A draft that was waiting for the user's decision stays `guided` even when
    the call asks for `auto`; the fresh receipt goes through `lore_decide`.
  - A pending `lore_decide(action="request_revision")` feedback is carried
    over: the new workflow applies that revision to the kept draft under the
    current contract.
  - `lore_write` drafts the chapter again only with a new `instruction`, or
    when the kept draft no longer exists.
  - The check runs in a new workflow. The old one stays in the history as
    `clean_fail`, marked `workflow_superseded` (`mode`: `revalidate`,
    `revise` or `redraft`); the new one records the inherited prose as
    `inheritedDraft.proseHash`. If nothing changed, `lore_write` returns the
    kept draft without calling a model.
- **`lore_workflow_inspect` can show the kept draft.** With `detail="full"` it
  returns the kept or parked draft prose as `draftProse`; the default
  `detail="summary"` leaves it out.
- **New checks.** Each chapter gets a language-compliance request and a
  generated title, and the detector plan adds `scanStyle`,
  `scanSentenceStats`, `scanEntityMentions`, and, where they apply,
  `scanWorldGroupConflict` and `scanFanficLeak`. Soft and advisory findings
  still never block a commit.
- **One more host round trip.** A chapter now takes 5 host model round trips
  instead of 4: draft; extraction with the independent reviews; the semantic
  continuity check; the chapter title, summary and narrative boundary together
  (they read the same final prose); then the language-compliance proof. The
  extra pass is the language-compliance proof, which checks the generated
  title and summary and so has to come after them.

## 0.3.10 — 2026-09-24

- Support Node.js 26: `engines` is now `^22.13.0 || ^24.0.0 || ^26.0.0` and CI
  runs Node 26. The full engine and plugin suites pass on Node 22.23, 24.21 and
  26.10.
- Installation docs note the `cmd /c npx` form for Windows hosts and no longer
  pin a specific version in the npm example.

## 0.3.9 — 2026-09-24

- Publish to npm as `vibelore`. Hosts can run the MCP server with
  `npx -y vibelore` instead of cloning the repository; the npm path registers
  the server only, so skills still come from the repository or the Codex
  plugin. The Codex plugin name stays `vibelore-plugin`.

## 0.3.8 — 2026-09-24

- `lore_webtoon_scene` no longer fails with
  `SCENE_REQUIRES_CONFIRMED_API_SELECTION` on a work without a confirmed image
  API choice. Start returns `needs_image_choice` with the proposed model,
  billing and data-transfer notice; calling start again with
  `confirmImageChoice` and the user's own answer in `feedback` saves the choice
  for this work. `imageModel` proposes a different OpenAI image model.
- Replace an absolute local path in the Thundertrail showcase data with a
  repository-relative one.
- Keep `textPolicyVersion` through segmented webtoon plan assembly; the outline
  probe and part checks now use the same scope as the final plan check, and
  plan-part requests state a per-part shot cap and layout bounds.
- Make the advisory review timeout configurable with
  `VIBELORE_REVIEW_TIMEOUT_MS` (default 45s). It only applies when the server
  calls a local adapter itself; the host relay is unaffected.
- Scene webtoons now re-plan automatically when the preflight or the image
  review fails: `lore_webtoon_scene` takes `autoRevisions` (0~3, default 2) at
  start, turns the observed defects (panel count, mismatched text or speaker,
  continuity, blocking findings) into feedback, and issues a new image job.
  Failed attempts stay in `attempts`; `0` keeps the old stop at
  `scene_needs_revision`. Workflows started before this keep a budget of 0.
- The scene image prompt forbids speaker name tags, text beyond the quoted
  lines and copying lettering from reference images, and asks for an exact
  panel count without insets. A revision's preflight adds only positive emphasis:
  `renderBrief.focusTextIds` (the server re-quotes those exact lines) and up to
  three short `renderBrief.corrections` describing the wanted result. Wording
  about the earlier attempt, the wrong output or negations is rejected
  (`SCENE_CORRECTION_NOT_POSITIVE`).
- Lay out independent requests in one `needs_model` batch so they share a
  byte-identical prompt prefix: when a workflow-declared shared text (this
  chapter's prose) appears once in two or more requests, `system` becomes the
  execution note alone and `user` starts with a deterministic shared block,
  followed by the original role instruction and step data. No request gains
  material it did not have; request ids, audit exchanges and direct providers
  are unchanged.
- Add a `promptCache` hint (`sharedPrefixId`, `sharedPrefixEndMarker`,
  `sharedPrefixChars`, `estimatedSharedTokens`, `groupSize`, `warmFirst`) and
  tell hosts that answer with fresh processes to send the `warmFirst` request
  first and the rest after its first output. Claude Code CLI hosts must move
  the shared block into `--system-prompt`; see OPERATIONS.md.

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
