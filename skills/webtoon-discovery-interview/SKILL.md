---
name: webtoon-discovery-interview
description: Use when adapting a vibelore novel, world and characters into a webtoon (웹툰화, 웹툰 각색, 웹툰으로 만들기). It inherits the existing settings and interviews only the differences of webtoon presentation. With the `lore_webtoon_scene` whole-scene path it adopts a user-chosen style sample with `lore_webtoon_style` and settles references, panel count and image model, then runs the pre-generation check and the visual review. The per-panel `lore_webtoon_plan` path is deprecated and used only to continue existing work. The next scene continues with `previousWorkflowId`.
---

# Webtoon discovery interview

Linked docs are the canonical Korean versions; each has an English sibling (`<name>.en.md`) next to it.

## Purpose and path

New webtoon work uses `lore_webtoon_scene`. This path generates a whole scene, dialogue included, as one image without roughs or
per-panel art; the purpose of this interview is to settle that tool's inputs together with the user.

The per-panel `lore_webtoon_plan`/`lore_webtoon_render`/`lore_webtoon_decide` path is deprecated.
Starting new work on it is refused with `WEBTOON_PANEL_PATH_DEPRECATED`. Follow
[Appendix: per-panel path (deprecated)](#appendix-per-panel-path-deprecated) only to continue per-panel work already started.

For a feature development request, implement and verify this flow, but don't start an interview or image production for a real work on your own.

## The conversation language and the work language are separate

Talk with the user in the user's conversation language: a Korean-speaking user gets the questions, options, recommendations and
summaries in natural Korean, an English-speaking user in English, and so on. These instructions are in English only for maintainability.
Questions, options and notices the server returns in `needs_interview`, `warnings` and `imageChoice.notice` are already
worded for `ko` or `en`; show them as returned rather than re-translating them.
Webtoon dialogue is always the original text in the work language and is never translated.
Check the work language with `lore_configure`: `language.tag` is the resolved work language (a work with no language key
already resolves to `ko`). `lore_status` doesn't return it. The image
prompt automatically states the language, script (ISO 15924) and reading direction, so don't create separate
translation instructions in the interview.

## Direct choice or delegation

Interpret the user's latest words in the current request context before asking questions. "알아서 해줘", "you choose" and
"don't ask me" are explicit delegation, not missing answers. Record the actual words in `delegation.userAnswer` and choose
`scope=preview|style|production`: preview only creates a sample and waits; style also delegates adoption; production covers the
requested source range and defaults an omitted panel count to `auto`. "그림체만" delegates style only. "알아서, 먼저 보여줘"
uses preview, and a reply to a style question does not automatically delegate the whole production. A vague "좋아" approves
only the concrete pending choice. Silence is neither adoption nor delegation. User-specified style, count and references stay fixed.

Use an existing style and image choice. For a new choice, report actual runtime capabilities; under delegation the tool selects
a built-in path without another user question. New API billing requires explicit authority (`apiPolicy=allow`) or the normal
cost confirmation. The default `existing-only` permits an already approved API; "돈 쓰지 마" is `forbid` and overrides it.
Record stated retry limits in `maxAutoRevisions`; 0 means no automatic redraw. It is a per-scene retry cap, not a total billing
budget. For total image-call or money limits, track actual calls in the host and fit sample/reference/scene generation inside
that limit; a one-image request can use a supplied/existing style or create the requested final scene directly with `direction`.
Ask only for genuinely missing source/identity facts or permission outside the grant. Never invent novel facts to fill gaps.

For delegated style adoption, open the actual sample and call `approve` with `choice={inspectedImage:true,imageHash,rationale}`.
The tool records the host's choice separately from the user delegation; show the sample and reason with the result and keep
working within the request scope. `needs_style_decision` is host work, not a user question or a `lore_resume` request. At
`awaiting_style_approval` the user chooses instead. Change a candidate's grant with `set_mode(delegation=..., proposalId)`;
`delegation=null` plus the latest user `feedback` restores direct choice without drawing another sample. `reject` closes it.

Delegation belongs to this request; a saved style is reusable, but its old grant is not authority for new production. Existing
scenes change only when explicitly requested: list their exact IDs in `reviseWorkflows` and `applyToWorkflows`, then call
scene `revise` for those IDs. Stop at the retry budget, report factual failures and style advisory, and retain the results.
On "stop", close the current scene with `reject` and the user's words in `feedback`, cancel external pending calls if possible,
and preserve completed files. For changes to costs during a scene, call explicit `revise` with the latest grant; report the
allowed runtime and follow its response. Execution failure never authorizes a provider switch. After interruption, read status
and resume the existing candidate/run/job; show the result without demanding an approval already delegated.

See the full [edge cases](../../docs/reference/WEBTOON_WORKFLOW.md#선택-위임과-경계-상황).

## Inputs to gather, in order

1. **Source range.** `sourceChapters`, and `sourceUnitIds` if needed. Specify only the range that was read. For a work with no
   novel, the source is a standalone scene script adopted with `lore_scene_script` (inspect, show the preview, apply after the user
   approves); pass its `scriptId` instead of `sourceChapters`, never both.
2. **Art style.** Check `lore_webtoon_style(action="status")` first. Reuse an adopted style for the next scene unless the user asks
   to change it. For a new style, use the delegated source-based choice or ask in the user's language what they want the comic to feel like; an everyday description,
   an artist name, or a reference image can be the starting point. Do not require an art-technique questionnaire or comparisons
   of several styles. Follow [Adopting a style sample](#adopting-a-style-sample) below. The host writes the short English
   summary; the user chooses by looking at the image. Page format and adaptation priorities may remain in `direction`.
3. **Reference images.** File paths of character and background reference images the user supplies, with an English `description`.
   They are required on every `start` (at least one; total 16 including the automatically attached adopted-style sample
   and any preceding scene image; ids `adopted-style` and `previous-scene` are reserved), otherwise the start fails with `SCENE_REFERENCES_REQUIRED`. With a script source, a catalog image the script
   pinned is passed as `{id, assetId, description}` instead of a path. The confirmed image model and adopted style sample are reused between scenes; character and background references
   are supplied on each start. The field name is `hash` (`inputHash` is a field only for the `asset` that imports a generated
   scene image; they are different contracts).
4. **`panelCount`.** An integer 1-12 or `"auto"`. Respect an explicit choice; under production delegation an omitted count becomes `auto`. If not chosen, the result is
   `needs_interview` (options `4, 6, 8, 9, auto`); `auto` lets the AI choose 3-12 panels anew for each adaptation, and fewer
   than 3 panels are shown as a continuity warning in the response `warnings`.
5. **Image path, model and cost.** If this work has no confirmed choice, style `propose` or scene `start` first returns
   `needs_image_runtime`. Check what this host really offers and call the same request again with
   `imageRuntime={host, options:[...]}`: every built-in image tool (`execution="host-built-in"`, its `tool` name, whether it takes a
   model argument, the models it accepts) and every API path (`execution="api"`, `provider`, `models`, the `credential` name, never
   its value). Leave `models` empty when a path takes a model argument but you cannot tell which models the account can use. Report only what you checked; write anything unknown, such as which model a built-in tool uses, in `note`.
   Without delegation, the result is `needs_image_choice`: show every entry of `imageChoice.options`, the proposal (`imageChoice.proposed`, the
   built-in path first) and `imageChoice.notice` as they are. If the user picks another path or model, call again with
   `imageOption` and `imageModel` for a new proposal. Once they choose, call the same request again with
   `confirmImageChoice=imageChoice.id` and `feedback=<the user's own answer>` (the runtime report need not be resent); this becomes the work's choice. A displayed
   default or no answer is not approval. When the user later says to switch (for example "from now on use the API"), start with
   `changeImageChoice=true` plus a fresh `imageRuntime` and repeat the same confirmation.

The detailed contract follows the [default path](../../docs/reference/WEBTOON_WORKFLOW.md#기본-경로-장면-통합-제작).
For `needs_model` (`webtoon-scene-plan`, `webtoon-scene-preflight`,
`webtoon-scene-image-review`), read the request's system/user and the actual evidence and answer `lore_resume` with the
exact `runId` and JSON per request ID. This is model work; keep it separate from questions for the user.
Lookups use `lore_workflow_status`/`history(lane="webtoon")`.

At `needs_scene_image`, read [Codex image execution](references/codex-images.md#scene-path-needs_scene_image). Execute
`hostRequest` or `apiRequest` as selected and import the exact `inputHash` and execution provenance. Every automatic re-plan
and every `revise` consumes another image call on that path. Open each actual file in a model request's `images` before
answering; file paths or a prose description alone are not an image review.

## Adopting a style sample

The user decides visual preference and where a change applies, directly or by explicit delegation. The host interprets the words and runs the image tool; the
image model draws. Vibelore preserves the words, candidates, adopted image, short summary, input hashes and versions.
A review LLM observes source fidelity and visible defects; it does not approve the user's taste.

1. Pass the user's original words as `brief` and your English interpretation as `direction` (at most 30 words) to
   `lore_webtoon_style(action="propose")`. Include the scoped `delegation` when authorized. Use `language` for conversation notices. If the user supplies a sample to adopt,
   pass `imagePath`; no image call is issued. Otherwise follow runtime/model confirmation above and generate the single
   returned `needs_style_image` job as described in [Style samples](references/codex-images.md#style-samples-needs_style_image).
2. Open the actual returned `image.path`. With delegation, choose and continue as above. For direct choice, show it with a short explanation in the user's language: for example,
   "이 그림체로 갈까요? 더 귀엽게, 더 묵직하게 바꿔도 돼요." An image is the choice surface; don't make approval of an English
   prompt a separate user step. Do not promise an artist-name request or reference will be reproduced exactly.
3. On a change request, retain the candidate and propose another from the updated brief. On adoption, call `approve` with
   `proposalId` and the user's actual answer in `feedback`, or the required `choice` under recorded delegation. A preview alone is not adoption. Existing explicit
   authorization can be used; don't ask the same question twice. On rejection use `reject`; the old adopted style is kept.
4. A new scene automatically pins the adopted image and summary. Omit `direction` to use its summary, or provide additional
   page/adaptation direction. The sample is automatically included in planning, preflight, drawing and visual review, and
   does not replace identity references. Do not add the sample manually to `references`.
5. A new adoption applies to future scenes. Existing scenes stay pinned and `styleChange` reports the difference. If the user
   wants existing scenes redrawn, record their IDs in `applyToWorkflows` on adoption, then explicitly call scene `revise` with
   the new `styleRevisionId` and their feedback for each. Recording the scope alone does not redraw anything. Keep earlier files.

For an adopted style, the image reviewer must open the actual sample and return `styleReview` with `inspectedReference=true`,
`verdict=matches|differs|uncertain` and concrete `evidence`. Differences in style are advisory and are shown to the user; they do
not trigger automatic regeneration. Actual source, lettering and continuity failures retain their normal checks. Text-only,
image-only and combined conditioning comparisons are developer quality evaluations, not required user onboarding.

## Latin-script English sent to the server

`direction` and reference `description` use Latin-script English only. Write character names in romanization or as IDs.
Don't put dialogue to be quoted inside direction text — dialogue is referenced verbatim from separate fields and is never
translated or paraphrased.

## Continuing scenes and resuming

Link a continuing scene with `previousWorkflowId` so it inherits the previous scene's actual image, design and review results.
The source text must start at the paragraph right after the previous range.

If the pre-generation check or the image review fails, within the automatic redesign budget (`autoRevisions`, start only,
0-3, default 2) the server takes the observed defects as feedback and designs, checks and generates again. When the budget
runs out, the state is `scene_preflight_blocked` or `scene_needs_revision`; continue with `action="revise"` and the user's
feedback.

Look up with `lore_workflow_status` or `history` using `lane="webtoon"` and the exact `workflowId`.
Resolve source drift with `lore_sync` first.

Distinguish finishing a run from verifying the quality of the work. The scene path has no approval step: `completed` means the
host's own image review passed, not user approval or publication. A failed image review ends in `scene_needs_revision` once the
automatic budget is spent; show the image and the evidence, and continue with `action="revise"` only with the user's feedback.
Report generation quality, reader response and actual cost only as far as they were measured.

## Appendix: per-panel path (deprecated)

The following applies only to continuing per-panel work already started. New work uses the scene path above.

Continue with `lore_webtoon_plan` and the existing `workflowId`; starting new work (no existing workflow, or `newWorkflow` on a
finished one) is refused with `WEBTOON_PANEL_PATH_DEPRECATED`. Use the source project's `project` and `workId`. Read and reuse the novel intent already approved; don't reinterpret it as a new
webtoon preference.

### Questions and answers

- For multilingual works, read [Work language contract and integration scope](../../docs/reference/WEBTOON_WORKFLOW.md#작품-언어-계약과-통합-범위). Convey explanations to the user in the conversation language, and keep the production text in the source language of `languageContract`. Submit selected values and IDs as they are. For a language contract error or an unsupported-lettering error, explain the supported scope and stop; don't work around it with an arbitrary translation.
- If the existing workflow still has W04/W15/W16 unanswered, read [Required choices: art, lettering, page format](../../docs/reference/WEBTOON_WORKFLOW.md#제작-전-필수-선택--작화문자판면) and ask them first. If an Ask tool is provided, show user-facing names and differences and take the choice. Ask about art and page format separately, and allow direct specification too. Announce the unsupported state of page formats before the choice. Don't promise unsupported lettering designs as if they were implemented.
- Read `inherited` and the source material of each question's `inherited.documentIds`, and first separate "established facts / undecided visual elements / needs approval to change" (ko: 확정 사실 / 미정 시각 요소 / 변경 시 승인 필요; use these exact labels with a Korean user). Compare future states in the current documents with that chapter's manuscript and the state at the time. Don't re-create character names, personalities, relationships or world rules.
- All `questions` of `needs_interview` are the current round. Based on the inherited facts, show only the presentation not yet decided, with a number, the question, a recommendation and the difference between choices, and wait for the answer. Source facts don't replace the user's answer about webtoon preferences. Don't pass the questions on to the novel creation tools.
- Pass answers to `lore_webtoon_plan` of the same `workflowId` as `responses: { <questionId>: <the user's own answer> }`. Pass a natural-language answer covering several questions as `feedback` so the model organizes it. The model doesn't choose preferences on the user's behalf.
- A displayed recommendation or no answer is not an answer. While undecided items remain in `coverage`, continue the same interview. Pass corrections as a new answer to that question ID.
- Find out the version to check, existing settings and tool support by reading the material. Adaptation latitude, preferences and production limits are the user's decisions.
- Only when the current webtoon request explicitly says “알아서/자동으로/묻지 말고” (or "automatically", "don't ask" in the user's language) may you use `mode="auto"`. Don't extend an auto instruction given for novel writing to the webtoon. This mode records the default choices as delegated, but the user must still choose art, lettering and page format (W04/W15/W16). Reuse choices already settled for the same work.

### Direction and adaptation approval

If `awaiting_approval`, check `approval.kind`.

- `profile`: summarize from `decisions` and show the intent taken from the source, the adaptation range, art style, acting, lettering, scroll, intensity of expression, readers, production constraints and change policy. Call `lore_webtoon_decide(action="approve")` only after the user confirms the direction.
- `plan`: read [Scene selection and adaptation review](references/editorial-selection.md) and show the main experience, keep/condense/omit/defer and context preservation first. Then show the actual `plan`'s sequences and dialogue and why it has that number of panels, and check `board.html` in `artifacts` at mobile width. Continue with approval or a `request_revision` at the same gate.
- `references`: show `references.html` and the actual character and space reference images against the source and the approved direction. Confirm the costume, point in time and panels they apply to, and approve the current approval ID. Even after reference approval, scene samples and the final are reviewed separately.
- `storyboard`: show the composition roughs of the actual `storyboard.html` in episode order and get confirmation of movement, contact, panel links and dialogue space. Even in auto mode, get the current user approval before proceeding to the final art. Request composition changes with `revisionTarget.kind="storyboard"` at the same gate.
- `look`: open the actual imported images and the sample with lettering, and confirm with the user that art style, characters, space and balloons match the intent.
- `final`: check the actual final SVG/HTML as a full scroll and approve the current approval ID. Preview approval doesn't replace final approval.

If the preference itself changes, update the answer to that question in `lore_webtoon_plan`. To fix dialogue, order or composition within the existing contract, pass `request_revision` with specific `feedback` to the current approval gate. Answers and character preferences are decisions for that work; don't turn them into global style prohibition rules.

### Model work and image import

- For a per-panel episode already in progress, after reference approval read [Composition rough approval and parallel drawing](../../docs/reference/WEBTOON_WORKFLOW.md#구도-러프-승인과-병렬-작화) and set `continuityPlan.version=2`. `needs_continuity_plan` means the setting is needed first, and `needs_continuity_roughs` and `needs_continuity_review` follow the same procedure. Don't automatically replace the version or images of existing work.
- `needs_model`: read the request's system/user and the actual evidence, and pass the exact `runId` and JSON per request ID to `lore_resume`. This is model work; keep it separate from questions for the user. If you don't answer, the work waits.
- `webtoon-editorial`: read [Scene selection and adaptation review](references/editorial-selection.md) first. It is an editorial candidate that comes before the panel plan, choosing scenes based on the inherited reader promise and the user's answers. Don't interpret the source mapping as an obligation to draw every scene.
- A visual critic answers `inspectedImages=true` only after actually opening the images and HTML in `artifacts`. Put the shot IDs read into `coveredIds`, and don't hide failures or findings. Don't call a review by the same host an independent reader evaluation.
- `needs_image_runtime`, `needs_image_choice`, `needs_scene_image`, `needs_reference_images` or `needs_images`: read [Codex image execution](references/codex-images.md). Report the host's real image paths, confirm the user's path, model and cost choice, and reuse it within the same work. Generate, fix, keep and import only the current `jobs`. Pass reference images in `references` and panels in `assets`, with the exact `inputHash`.
- `webtoon-layout-analyze`: look at the images in the actual request and return the speaker's mouth, the point where a sound effect originates, the protected areas of faces and key actions, and placement candidates. Already-confirmed evidence for the same image hash can be reused. Record low confidence as it is. The server computes actual font metrics, occlusion, reading order and tail visibility, and meaning and aesthetics are reviewed separately on the composite.
- To change only balloon or sound effect positions, read [Lettering v2 revision flow](../../docs/reference/WEBTOON_WORKFLOW.md#조판-v2--그림을-다시-그리지-않는-수정) and specify `revisionTarget.kind="lettering"` with the target panels and feedback. `layout_blocked` is a state to check the reason and re-review candidates; it is not approval to regenerate images.
- The exporter provides the SVG master, the HTML preview and the lettering JSON. v2 text is outline paths of a fixed font, and wording changes go through the original plan and a lettering recomputation. Splitting into PNG/JPEG for platforms, arbitrary fonts, curved tails and independent reader verification are out of the current scope.

### Resuming and limits

If `needs_format_support`, keep the page-format choice as it is and report why it is unsupported. Proceed with the vertical format only if the user changes W16. Page panel layout, reading order, page-turn staging and output are not completed by a simple prompt change.

Look up with `lore_workflow_status` or `history` using `lane="webtoon"` and the exact `workflowId`. Resolve source drift with `lore_sync` first. For hand edits to the webtoon, read the diff and the feedback and re-review with `adoptEdits=true`. Don't edit `.vibelore/` directly to bypass approval.

Distinguish finishing a run from verifying the quality of the work. A failed automatic critic falls back to user review, and only results that passed the source/hash/range checks can be approved by the user. Report generation quality, reader response and actual cost only as far as they were measured.
