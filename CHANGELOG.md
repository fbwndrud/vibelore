# Changelog

## 0.4.8 — 2026-10-01

- 활성 아크 재계획은 `ARC_IN_PROGRESS`로 거부하며 명시적 교체만 `replaceActive=true`로 허용합니다.
  아크 화수는 3~20 정수, 화당 분량 목표는 양의 정수로 MCP 입력 계약을 강화했습니다.
- `lore_write`와 `lore_resume`에 출력 스키마를 게시하고 MCP 오류에 code·message·retryable·nextAction을 추가했습니다.
- 기본 도구는 27개입니다. 기존 컷별 웹툰 마무리용 deprecated 3개는 `VIBELORE_MCP_SURFACE=compat`(30개) 또는 advanced에서 노출합니다.
- initialize 공통 지침에 초기 설정, 아크 확인, drift 동기화, critic·승인과 모델 응답 재개 규칙을 포함했습니다.

## 0.4.7 — 2026-10-01

- 발행 뒤 후처리가 중단된 화는 다음 `lore_write` 또는 guided `lore_decide` 승인
  재시도에서 같은 워크플로로 복구합니다. 발행 전 누적 PatternLedger 입력을 보존하고,
  경계 적용과 완료 이벤트를 중복 없이 마무리하며 반환값과 감사 이벤트에 복구를 표시합니다.
  복구 호출은 해당 화의 완료 결과를 반환하며 다음 호출에서 새 화를 시작합니다.
- 스냅샷 생성이 실패해도 발행과 `completed` 상태는 유지합니다. 반환값의 `nextAction`에
  해당 화의 최신 상태로 rollback할 지점이 없다는 안내와 실패 원인을 포함합니다.
- MCP initialize는 지원하는 protocolVersion만 그대로 응답합니다. 미지원 값은 서버의
  최신 지원 버전 `2025-06-18`로 협상하며 기존 `2024-11-05`, `2025-03-26` 연동을 유지합니다.
- 한·영 도구 문서의 `lore_refold` 설명을 seed부터 전체 재생하고 화별 `trackingHistory`를
  적용하는 동작에 맞췄습니다. `fromChapter`는 재구성 범위 보고에만 사용됩니다.

## 0.4.6 — 2026-09-30

- A character recorded dead comes back only on a quote from the chapter.
  The extraction asks for `evidence` with a revival; a revival whose quote
  is not in the chapter text is not recorded (`REVIVAL_WITHOUT_EVIDENCE`),
  and a dead character on stage without one stays a hard
  `DEAD_CHARACTER_ON_STAGE`. `missing` no longer counts as a revival.
- A quoted revival is reported as `DEAD_CHARACTER_REVIVED` and an `auto`
  chapter waits for the author's approval (`REVIVAL_CONFIRMATION`) instead of
  committing, since only the author knows whether the reveal is intended.

## 0.4.5 — 2026-09-30

- The README images load from the showcase media repository again; they had
  pointed at files moved out of `docs/showcase/`, so GitHub and npm showed
  broken pictures.
- `lore_webtoon_scene` no longer hard-codes the OpenAI image API. A work
  without a saved image choice first gets `needs_image_runtime`: the host
  reports the image paths it really has as `imageRuntime` (built-in tools
  and API paths, with the models each accepts). `needs_image_choice` then
  shows every option and proposes the built-in path first; the user's answer
  is kept per work and changes only with `changeImageChoice`.
- Scene jobs carry `hostRequest` for a built-in tool (for example Codex
  `image_gen`, which has no model argument) or `apiRequest` for an API.
  Imports record `host-built-in` or `api` provenance, and `observedModel`
  keeps what the host actually saw. Works confirmed on the OpenAI API before
  this change keep their saved choice.
- The local OpenAI-compatible adapter attaches the image files a request
  names (the webtoon image review) to the last user message, so a model that
  can see images reviews the actual picture.

## 0.4.4 — 2026-09-30

- Every MCP tool declares `annotations` (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`); only `lore_rollback` had them before.
  The eight status and history tools are marked read-only, and the tools
  that replace an existing plan or profile are marked destructive.
- Public tool descriptions now say what each tool writes, when to use it
  instead of a sibling, what it returns, and when it stops for
  `needs_model`. Every public input parameter has a description.
- `lore_init` no longer says to call it first for every new novel: it makes
  a hand-filled foundation, and `lore_create` refuses to run after it. The
  description points AI-designed works to `lore_profile` → `lore_create`.
- `lore_create`'s `chapterWordCount` is documented as legacy code units, not
  words, and `genre` as ignored when a StoryProfile exists.

## 0.4.3 — 2026-09-29

- The npm page shows the Korean `README.md` again. The translated READMEs
  moved to `docs/readme/`; npm picked whichever `README.*` file it found
  first, and 0.4.1 and 0.4.2 were published with the Traditional Chinese one.
- A `Dockerfile` runs the MCP server over stdio, so directories that build
  and inspect servers (such as Glama) can list its tools.

## 0.4.2 — 2026-09-28

- A continuity or language review that passes no longer ends the chapter in
  `clean_fail`:
  - `mutableChanges[].vitalStatus` (alive/dead/missing) and an inherited
    arc's `sourceEvidence[].proofStatus` are classified as machine values;
    before, every language-contract pass was rejected as
    `unclassified_generated_field`.
  - A pass keeps its verdict when a cited evidence entry is malformed (the
    entry is dropped); evidence for fail and uncertain stays strict.
- Personal character arcs keep to two active at a time across arcs:
  - Arc planning replays the planned beats over the committed arc cursor and
    rejects a new personal arc over the quota, naming the active arcs; the
    message also says a character can stay out of `characterArcs` and be
    carried by the episodes' events. The arc prompt states the rule.
  - A character's current beat comes from the committed cursor, not the
    previous plan, and an arc counts as in progress until its last stage is
    `echo`. A chapter commit leaves out a beat the cursor has already passed
    instead of failing on a regression; skipping ahead is still an error.
  - A chapter whose delta opens an arc over the quota no longer fails the
    commit: that arc start, and its later beats while the quota stays full,
    are left out and the rest of the delta applies.

## 0.4.1 — 2026-09-27

- Story ledger. Objects, knowledge, scheduled events and hooks are kept as
  one record each across the whole work, with an ID, a status, current
  values and the last three events, instead of per-chapter tracked items that
  were overwritten or registered again under a new name:
  - Record statuses: objects `active|lost|destroyed|retired`, knowledge
    `secret|partial|public|retired`, scheduled
    `pending|prevented|happened|altered|retired`. Hooks are
    `open|dormant|paid|closed`; a payoff needs a quote from the chapter
    (otherwise it counts as an advance) and a paid hook used again reopens.
    Older `planted`/`advancing` read as `open`, `parked` as `dormant`.
  - Each chapter's events go to `.vibelore/ledger/events.jsonl`. The replay
    starts from `.vibelore/ledger/seed.json` (the records before chapter 1,
    written by `lore_create`, or once from the entity snapshots for older
    works) and applies each chapter under the settings it was committed
    with, so it equals the live ledger. A commit appends its chapter; a
    rollback, refold, `lore_sync` or settings change rebuilds it.
    `lore_status` reports `ledgerLog`, which is ok only when the file exists,
    has the recorded number of lines and matches the digest of seed,
    settings and chapter extractions. A record that returns after more than
    20 quiet chapters brings up to five lines of its history into the writer
    input; otherwise inputs carry current values and recent events only.
  - An exactly equal name joins the existing record; a similar one is
    registered and flagged (`LEDGER_POSSIBLE_DUPLICATE`, soft), never merged
    on its own. A record may be registered in its first status (already
    destroyed, prevented); a status event keeps the values that changed with
    it. A dormant or paid hook that returns keeps its ID, and a passing
    mention does not count as the hook moving.
  - Hard findings: changing a destroyed record and restoring one without a
    reason. Both first re-extract once, since they are usually extraction
    slips. Everything else the ledger reports is soft.
- Tracking settings in `lore_configure`:
  - `tracking={objects, knowledge, scheduled, hooks}` turns each feature on
    or off (all on by default). A feature turned off is not asked for, not
    checked and never a failure, and `lore_context` leaves it out. A change
    applies from the next chapter; earlier chapters keep their history. What is tracked no longer depends on the
    genre (the genre profile's tracked kinds are gone).
  - `customTracking=[{name, feature, pinned?, rules?, note?}]`: an item
    links to the record with its ID, name or alias; `pinned` items are
    always in the inputs, and items with no record yet are listed as things
    to track; `rules` are deterministic checks
    (`monotonic` with `unless`, `frozenAfter`, `speakerOnly`), soft unless
    `severity: "hard"`; `note` is a natural-language rule the
    `coherence-judge` review judges per item ID and reports as an
    `AUTHOR_RULE` advisory, with no extra model request (an answer with no
    verdicts leaves the review incomplete).
  - Speaker-only aliases (an alias with `by`): reported when the term appears
    while that character is not in the chapter, listed in the continuity
    check's address section and shown to the planner and writer.
  - Merges: in `guided`, `lore_write` asks one `ledger-merge` request about
    newly flagged pairs only (`auto` never asks); the proposals show as
    `mergeCandidates` in the guided approval result and in
    `lore_configure`, and `mergeRecords=[{from, into}]` approves them from
    the next chapter (`atChapter`). The merged record keeps the `into` ID;
    its status and values come from the record with the later event.
  - The chapter plan sees hook IDs and `hooksTouched` keeps existing IDs
    only.
- Existing works move to the ledger on their own: the history log and the
  ledger are replayed from the committed chapters without a model call
  (`Timeline` entries become chapter notes; `RelationshipState` and
  `PowerSystem` entries are not carried over), and `guided` asks once for
  merge candidates (at most 150 records: flagged pairs first).
- Engine: `foldEntityOps` and `scanDestroyedEntityMentions` are removed
  from the public exports; the ledger review reports destroyed mentions.
- Rollback also restores `review-policy.json` (review and tracking settings,
  approved merges) and the arc summaries; before, both were deleted.
- The language-field classifier (version 5) and the extraction context
  (version 2) changed, so check receipts issued before the upgrade no longer
  apply: a chapter checked and waiting for approval is checked once more.
- Review fixes for the bounded state inputs and the long memory:
  - Hooks the plan touches are never cut by the 12-hook cap; related records
    left out by a cap are counted separately from unrelated ones.
  - Tracked items the text names by an identity field (name, id, title) rank
    above items that only share a state word.
  - Known facts the focus shares words with survive the three-fact limit;
    relationships between two focused characters rank first.
  - Character names match as words ("조연5" no longer matches "조연50").
  - The chapter plan lists and accepts only characters registered by that
    chapter.
  - The continuity check sees the previous value of every tracked item the
    chapter changes, so ownership invariants have both sides.
  - The character review shows character descriptions again.
  - Only arcs with status `completed` are summarized (rejected plans keep
    their numbers); a missing arc archive stops the chain instead of building
    on a hole; blank answers are not stored. An unusable answer does not stop
    the chapter: the result carries `quality.longMemory` and the summary is
    asked again next time.
  - The current arc so far uses stored chapter summaries (a plan beat only
    where none exists, labelled) for chapters before the five-chapter window;
    retrieval no longer repeats them. `lore_rewrite` reads the long memory too.
  - docs/TOOLS(.en).md describe the `lore_configure` settings arguments.
- Long memory across arcs. When an arc is finished, the next `lore_write`
  first asks one `arc-summary` request per unsummarized arc: from the
  previous story so far and the arc's chapter summaries it returns an arc
  summary (at most 800 characters) and the updated story so far (at most
  2000). Works with finished arcs are summarized the same way. The chapter
  plan and the draft read the latest story so far, the last two arc
  summaries and the current arc's chapters so far, ahead of the five-chapter
  summary window; this does not grow with the number of arcs. Stored in
  `.vibelore/arc-summaries/`.
- Per-chapter state inputs no longer grow with the length of the work.
  Each request lists what its focus text touches (the prose for extraction
  and the continuity check, the plan for the draft, the character review and
  the chapter plan) and counts the rest:
  - open hooks the focus shares words with, the plan's `hooksTouched`, those
    planted in the last three chapters and, for the chapter plan, the three
    longest open ones; at most 12;
  - tracked items the focus names first, then those the named characters
    hold; at most 30 for extraction, 12 for writers;
  - characters in the cast or named in the focus, plus writers see
    characters lost in the last five chapters; address terms and
    relationships between those;
  - the continuity check lists Foundation characters on the page only
    (evidence paths keep the Foundation index);
  - the chapter plan's cast list gives full lines for the core cast, named
    and recently registered characters and names only for up to 30 others.
  A synthetic 300- and 1000-chapter work guards this
  (test/long-run-inputs.test.js): the 1000-chapter render may be at most 20%
  larger than the 300-chapter one and must keep every needle the prose or
  plan touches. Thundertrail chapter 8 extraction: 13.5K to 9.5K characters.
- `lore_rewrite` carries the planned cast and characters the intent or the
  chapter names, not every registered character.
- With the pattern review off, no placeholder entry is written to the
  experience ledger and repetition checks skip the chapter. A turned-off
  profile check is listed in the review audit (`review.disabled`).
- Character renders list aliases, so a reviewer can attribute a nickname to
  the right character. `lore_rewrite` again carries every registered
  character, not only the plan's cast.
- The shared-block pointer tells the model to read it as the value of that
  place, so quotes and `fieldPath` keep naming the request's own field.
- Request prompts changed in this release, so a `lore_write` parked before
  upgrading asks the changed requests again when resumed.
- Optional draft sections can be left out per work:
  `lore_configure(disabledDraftSections=[...])` with `older-memory`,
  `previous-tail`, `author-craft` and `style-anchor`. The plan, setting,
  current state and recent summary window always stay. The draft audit
  records which sections were off.
- `lore_write(sharedOnce=true)`: a `needs_model` response carries each
  shared prose block once (`sharedBlocks`) and every request starts with a
  one-line reference to it; replacing that line with the block restores the
  exact default request. The default stays self-contained requests.
- The language-contract request carries the prose verbatim before the
  title, summary and delta JSON. Escaped inside JSON it never matched the
  shared prose block, so it could not reuse the chapter's prompt cache.
- A lone relayed request that carries the shared chapter prose (the
  continuity check, which parks after the review batch) gets the same
  shared-prefix layout, so it reads the prefix that batch cached. Warm-first
  stays off for a lone request. The CLI relay instruction and the operations
  guide ask for `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`: a subscription-signed CLI
  writes the cache with a 1-hour TTL at twice the input price.
- `needs_model` responses carry `inputReport`: for each request its
  sections with character counts, the shared prose size and whether it can
  reuse the cached shared block. `lore_write` keeps the last report on the
  workflow (`lore_workflow_status`) and reports `trimmedContext` when the
  draft's summary window or memory budget left something out.
- The per-chapter reviews can be turned off per work:
  `lore_configure(disabledReviews=[...])` stores the full list
  (story-profile-check, coherence-judge, editorial-quality,
  character-fidelity, reader-hook, pattern-ledger; unknown names are
  rejected). A review that is off is not requested and is recorded as
  `disabled_by_user`, which does not count as a failed review, so `auto`
  still commits. Results list `quality.disabledReviews`. Continuity
  extraction and checking stay on.
- Fix: an arc approved after the previous arc completed is now published with
  the next commit. Commits, context assembly and status read plans from the
  working store where the approval tools write them; they used to read the
  plans sealed in the last publication, so a finished arc stayed the published
  arc forever and context showed "no arc plan".
- The character packet shows each character's goal for the current chapter
  from its plan. The choice owner's goal used to stay the first chapter's
  immediate want for the rest of the work.
- Carried relationships in the draft name both ends ("A→B"). Records without
  a direction are left out; they used to be shown under the target's name as
  if that character held the feeling.
- The draft request carries characters, world facts and the previous state as
  text instead of JSON (src/core/prompt-sections.js). The state section keeps
  what bears on the chapter: the cast's current place and condition, every
  dead or missing character, address terms within the cast, open threads,
  directed relationships touching the cast and the tracked items the cast
  holds or the plan names, most recent first. Foundation's design-time place
  and condition appear only in chapter one; design-time knowledge stays.
  Appearance is given where a character first enters. On the thundertrail
  chapter 8 request this cuts the prompt from 34.7K to 19.3K characters.
- Tracked records note the chapter that last changed them (`updatedChapter`).
- The episode-plan request carries the arc beat, character beats, world
  facts, cast, recent summaries (labelled, oldest first), the previous plan
  and the current state as text instead of JSON. Thundertrail chapter 8:
  23.2K to 12.2K characters.
- The continuity extraction and check requests take text sections instead of
  JSON. Extraction sees the whole state index with exact keys, hook ids,
  planting chapters and address terms (it used to get address keys without
  terms and hook ids without text), the known entities, and the cast with the
  work's influence dimension ids, so it stops inventing dimension names. The
  check sees characters and world facts with the paths it may cite as
  evidence, the current state instead of Foundation's design-time place, and
  only the Delta fields its tasks judge (appearances, address terms, state
  changes, tracked-item changes).
- The StoryProfile drift check reads the rendered profile with the user's
  settled decisions, the arc beat, who is on stage and what the plan withheld
  or deferred, instead of the raw profile JSON and the whole plan JSON, so a
  deferred payoff is not taken for drift. Both check paths share the input.
  Thundertrail chapter 8: 19.1K to 7.8K characters.
- The reader-hook review reads the plan as the same text the other reviews
  get, plus the reader-experience fields only it judges (expected outcome and
  on-page evidence, turn, payoff proof, cost, exit value, agendas), instead of
  the plan JSON. The unused plan JSON view is removed.
- The character-fidelity review gets its own input instead of the general
  context render: each on-stage character once as text (no appearance), the
  chapter plan, the character packet, the current state and the previous
  chapter's summary. Characters were sent twice before (JSON and context).
  Thundertrail chapter 8: about 21K to 12.5K characters besides the prose.
- Fix: the coherence review receives the previous chapter's summary its
  instructions ask for; it was never passed. The plan heading is no longer
  doubled.
- The editorial review's earlier summaries are labelled by chapter and run
  oldest first; they were unlabelled and newest first.
- The pattern review sees the character ID table and the categories the
  previous two chapters were filed under. Repetition is detected by exact
  category name, and without the earlier names the reviewer invented new
  ones each chapter. Supporting-agency keys given as names are stored as IDs.
- The reader-hook review's checklist is no longer thrown away: items it
  marks `fail` are shown as advisories with the evidence, and the receipt
  keeps the dimension scores and the full checklist (`readerHookDetail`).
- The narrative-boundary request carries what the decision needs: the arc
  promise and reader contract, the current beat in full, the next beat's
  event, and the plan's intended results (choice and result, next state,
  scene results, remaining cost). Earlier beats, opposition, voice shifts
  and the plan's scene staging are left out; the character curves are shown
  on the last beat. Thundertrail chapter 8: 6.2K to 2.1K characters besides
  the prose.
- `lore_rewrite` sends characters, world facts and the previous state as the
  same text the draft gets (shared `renderWriterFoundation`), instead of
  JSON. The state section is focused on the chapter being rewritten.
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
- Drafts and `lore_rewrite` no longer assemble the `lore_context` render to
  take its summary window and older memory, so an oversized reference render
  cannot stop `lore_write`. A dedicated selection
  (`selectWriterContinuity`) retrieves older memory without counting world
  facts and open hooks against the memory budget, since the draft already
  carries them in its setting and state sections; it never refuses. The draft
  audit records how many summaries the window trimmed and how many matching
  memories the budget left out (`contextAudit.memory`). `lore_context` still
  refuses an oversized context.
- A guard test fixes what each per-chapter request carries before the prose:
  no JSON input, the sections it judges from, and a size bound
  (test/request-inputs.test.js).
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
