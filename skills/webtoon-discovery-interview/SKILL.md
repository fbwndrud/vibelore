---
name: webtoon-discovery-interview
description: Use when adapting a vibelore novel, world and characters into a webtoon (웹툰화, 웹툰 각색, 웹툰으로 만들기). It inherits the existing settings and interviews only the differences of webtoon presentation. With the `lore_webtoon_scene` whole-scene path it settles the direction, references, panel count and image model, then runs the pre-generation check and the visual review. The per-panel `lore_webtoon_plan` path is deprecated and used only to continue existing work. The next scene continues with `previousWorkflowId`.
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
Webtoon dialogue is always the original text in the work language and is never translated.
Check the work language with `lore_status` or the StoryProfile's `language`; if the key is missing, it is ko. The image
prompt automatically states the language, script (ISO 15924) and reading direction, so don't create separate
translation instructions in the interview.

## Inputs to gather, in order

1. **Source range.** `sourceChapters`, and `sourceUnitIds` if needed. Specify only the range that was read.
2. **Art style and direction.** Take the user's own answer and turn it into an English `direction`. Show the English text you wrote to
   the user, and pass it on only after they confirm it matches their intent.
3. **Reference images.** File paths of character and background reference images and an English `description`. The field name is `hash`
   (`inputHash` is a field only for the `asset` that imports a generated scene image; they are different contracts).
4. **`panelCount`.** An integer 1-12 or `"auto"`. The user chooses. If not chosen, the result is
   `needs_interview` (options `4, 6, 8, 9, auto`); `auto` lets the AI choose 3-12 panels anew for each adaptation, and fewer
   than 3 panels are shown as a continuity warning in the response `warnings`.
5. **Image model, execution path and cost.** If this work has no confirmed API choice, the `action="start"` call
   returns `needs_image_choice` (`imageChoice.id`, the model, execution path and billing in
   `imageChoice.policy`, and the notice text `imageChoice.notice`). Show it as is, take the user's own answer, then
   call again with the same `start` arguments plus `confirmImageChoice=imageChoice.id` and `feedback=<the user's own answer>`;
   this confirms it as this work's choice. A displayed default or no answer is not treated as approval.

The detailed contract follows the [default path](../../docs/reference/WEBTOON_WORKFLOW.md#기본-경로-장면-통합-제작).
For `needs_model` (`webtoon-scene-plan`, `webtoon-scene-preflight`,
`webtoon-scene-image-review`), read the request's system/user and the actual evidence and answer `lore_resume` with the
exact `runId` and JSON per request ID. This is model work; keep it separate from questions for the user.
Lookups use `lore_workflow_status`/`history(lane="webtoon")`.

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

Distinguish finishing a run from verifying the quality of the work. A failed automatic review falls back to user review, and only
results that passed the source, hash and range checks can be approved by the user. Report generation quality, reader response and actual cost
only as far as they were measured.

## Appendix: per-panel path (deprecated)

The following applies only to continuing per-panel work already started. New work uses the scene path above.

Start with `lore_webtoon_plan`. Use the source project's `project` and `workId`, and specify only the source
range that was read as `sourceChapters`. Read and reuse the novel intent already approved; don't reinterpret it as a new
webtoon preference.

### Questions and answers

- For multilingual works, read [Work language contract and integration scope](../../docs/reference/WEBTOON_WORKFLOW.md#작품-언어-계약과-통합-범위). Convey explanations to the user in the conversation language, and keep the production text in the source language of `languageContract`. Submit selected values and IDs as they are. For a language contract error or an unsupported-lettering error, explain the supported scope and stop; don't work around it with an arbitrary translation.
- For new work, read [Required choices: art, lettering, page format](../../docs/reference/WEBTOON_WORKFLOW.md#제작-전-필수-선택--작화문자판면) and ask W04/W15/W16 first. If an Ask tool is provided, show user-facing names and differences and take the choice. Ask about art and page format separately, and allow direct specification too. Announce the unsupported state of page formats before the choice. Don't promise unsupported lettering designs as if they were implemented.
- Read `inherited` and the source material of each question's `inherited.documentIds`, and first separate "established facts / undecided visual elements / needs approval to change". Compare future states in the current documents with that chapter's manuscript and the state at the time. Don't re-create character names, personalities, relationships or world rules.
- All `questions` of `needs_interview` are the current round. Based on the inherited facts, show only the presentation not yet decided, with a number, the question, a recommendation and the difference between choices, and wait for the answer. Source facts don't replace the user's answer about webtoon preferences. Don't pass the questions on to the novel creation tools.
- Pass answers to `lore_webtoon_plan` of the same `workflowId` as `responses: { <questionId>: <the user's own answer> }`. Pass a natural-language answer covering several questions as `feedback` so the model organizes it. The model doesn't choose preferences on the user's behalf.
- A displayed recommendation or no answer is not an answer. While undecided items remain in `coverage`, continue the same interview. Pass corrections as a new answer to that question ID.
- Find out the version to check, existing settings and tool support by reading the material. Adaptation latitude, preferences and production limits are the user's decisions.
- Only when the current webtoon request explicitly says “알아서/자동으로/묻지 말고” (or "automatically", "don't ask" in the user's language) may you use `mode="auto"`. Don't extend an auto instruction given for novel writing to the webtoon. This mode records the default choices as delegated, but for new work the user must choose art, lettering and page format. Reuse choices already settled for the same work.

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

- For a new episode, after reference approval read [Composition rough approval and parallel drawing](../../docs/reference/WEBTOON_WORKFLOW.md#구도-러프-승인과-병렬-작화) and set `continuityPlan.version=2`. `needs_continuity_plan` means the setting is needed first, and `needs_continuity_roughs` and `needs_continuity_review` follow the same procedure. Don't automatically replace the version or images of existing work.
- `needs_model`: read the request's system/user and the actual evidence, and pass the exact `runId` and JSON per request ID to `lore_resume`. This is model work; keep it separate from questions for the user. If you don't answer, the work waits.
- `webtoon-editorial`: read [Scene selection and adaptation review](references/editorial-selection.md) first. It is an editorial candidate that comes before the panel plan, choosing scenes based on the inherited reader promise and the user's answers. Don't interpret the source mapping as an obligation to draw every scene.
- A visual critic answers `inspectedImages=true` only after actually opening the images and HTML in `artifacts`. Put the shot IDs read into `coveredIds`, and don't hide failures or findings. Don't call a review by the same host an independent reader evaluation.
- `needs_image_choice`, `needs_image_runtime`, `needs_reference_images` or `needs_images`: read [Codex image execution](references/codex-images.md). Confirm the model, built-in/API path and cost choice, and reuse it within the same work. Generate, fix, keep and import only the current `jobs`. Pass reference images in `references` and panels in `assets`, with the exact `inputHash`.
- `webtoon-layout-analyze`: look at the images in the actual request and return the speaker's mouth, the point where a sound effect originates, the protected areas of faces and key actions, and placement candidates. Already-confirmed evidence for the same image hash can be reused. Record low confidence as it is. The server computes actual font metrics, occlusion, reading order and tail visibility, and meaning and aesthetics are reviewed separately on the composite.
- To change only balloon or sound effect positions, read [Lettering v2 revision flow](../../docs/reference/WEBTOON_WORKFLOW.md#조판-v2--그림을-다시-그리지-않는-수정) and specify `revisionTarget.kind="lettering"` with the target panels and feedback. `layout_blocked` is a state to check the reason and re-review candidates; it is not approval to regenerate images.
- The exporter provides the SVG master, the HTML preview and the lettering JSON. v2 text is outline paths of a fixed font, and wording changes go through the original plan and a lettering recomputation. Splitting into PNG/JPEG for platforms, arbitrary fonts, curved tails and independent reader verification are out of the current scope.

### Resuming and limits

If `needs_format_support`, keep the page-format choice as it is and report why it is unsupported. Proceed with the vertical format only if the user changes W16. Page panel layout, reading order, page-turn staging and output are not completed by a simple prompt change.

Look up with `lore_workflow_status` or `history` using `lane="webtoon"` and the exact `workflowId`. Resolve source drift with `lore_sync` first. For hand edits to the webtoon, read the diff and the feedback and re-review with `adoptEdits=true`. Don't edit `.vibelore/` directly to bypass approval.

Distinguish finishing a run from verifying the quality of the work. A failed automatic critic falls back to user review, and only results that passed the source/hash/range checks can be approved by the user. Report generation quality, reader response and actual cost only as far as they were measured.
