# Webtoon execution contract — for hosts and integration developers

[한국어](WEBTOON_WORKFLOW.md) | English

## Default path: whole-scene production

New webtoon work uses `lore_webtoon_scene` by default. It generates a whole scene together with its lettering, without roughs.
Existing per-panel work is not changed automatically. The approved API model choice is reused, and the character and background references (`references`) are passed on every start. This path uses only the OpenAI image API (`gpt-image-2`, `gpt-image-2.5-sunburst` (default), `gpt-image-2.5-flare`); there is no host built-in image tool path.
The new path pins the source paragraph range and proceeds as **scene adaptation and English direction → pre-generation check → scene image with lettering → visual review of the actual image**.
The user chooses the panel count as `panelCount`, an integer (1-12) or `"auto"`. If it isn't chosen, the result is `needs_interview` (options `4, 6, 8, 9, auto`) and no model or image calls are issued. `auto` is decided anew for each adaptation from the `panelCount` (integer 3-12) in the `webtoon-scene-plan` answer; if it is missing or out of range, it fails with `SCENE_PANEL_COUNT_UNRESOLVED`. The decided number is recorded in the `scene_panel_count_resolved` event and then used as is for the renderBrief length, the image request and the check of the observed panel count. `revise` resets the auto value so that the new adaptation chooses again. Integers under 3 are allowed, but a continuity-loss warning is put in the response `warnings` without blocking. Changing `panelCount` after the start is `SCENE_PANEL_COUNT_PINNED` (an auto job allows only `"auto"`). Panel size, layout and camera are left to the image model. The unit of events is not the panel.
Distinguish the source's facts from its uncertainties, and preserve the speaker and wording of the source dialogue. The structural check only confirms that the source text is included and linked to evidence; it does not replace the semantic review.
Dialogue is the original text in the work language, and the image prompt states the language, script and reading direction. Direction fields allow only Latin-script English.

1. Pass `action="start"`, the user-chosen `panelCount`, `sourceChapters`, optional `sourceUnitIds`, an English `direction`, and the user-supplied `references:[{id,path,hash,description}]`. References are PNG/JPEG files inside the project, and descriptions are written in English too. References are required (at least one, at most 16 including the previous scene, and the id `previous-scene` is reserved); without them the start fails with `SCENE_REFERENCES_REQUIRED`. Don't guess a new API billing choice in this tool. For a work with no confirmed choice, it returns `needs_image_choice` and `imageChoice` (model, billing and transmission notice) before any model or image call. Show it to the user, and when the user chooses, call again with the same start arguments plus `confirmImageChoice: imageChoice.id` and the user's own answer as `feedback`. Another model can be proposed with `imageModel`. The confirmed choice is kept for the next scenes and episodes of this work. If there is an existing active job, use a different production project.
2. Answer the `webtoon-scene-plan` request with one scene brief. Then in `webtoon-scene-preflight`, review the actual source text and the brief for source fidelity, space/physics, temporal causality and information load. After the four checks, build the `renderBrief` to be sent. Reduce it to one style line and as many short moment descriptions as the user's panel count, and link the exact dialogue with textIds. Don't demand several consecutive actions in one moment, and trim movement and setup that are understood even when omitted. `drawability` judges this final request again for source fidelity, user direction, continuity and length. Overload is not passed on as advisory; it is blocked before generation. The 30-word style limit and 35-word-per-moment limit only restrict verbosity; they don't replace the semantic review. An image request is issued only when the four checks and drawability pass with no blocking finding. On failure, it redesigns in the same job within the automatic redesign budget (`autoRevisions`, default 2), using the failure evidence as feedback. When the budget runs out, it is `scene_preflight_blocked`, and you continue with `action="revise"` and feedback.
3. The host calls the API using the exact prompt, references, model and inputHash of `needs_scene_image.jobs`. The endpoint is `apiRequest.endpoint` (`/v1/images/edits` when references exist), with the `referenceImages` attached as actual files in order. For the execution details, follow [Codex image execution](../../skills/webtoon-discovery-interview/references/codex-images.md#scene-path-needs_scene_image). One scene image includes the finished art and the source lettering. The image model is sent only the short renderBrief, dialogue and reference roles; fact lists, duplicate spatial descriptions, uncertainty lists and earlier error reports are not sent. The review evidence is kept separately. If the request to be sent changes, the earlier image import hash is void. Roughs, per-panel art and separate vector lettering are not generated on this path.
4. Import with `asset:{path, inputHash: jobs[0].inputHash, provenance:{kind:"openai-api", requestedModel: apiRequest.model, selectionId: apiRequest.selectionId}}`. Any other provenance fails with `IMAGE_EXECUTION_PROVENANCE_REQUIRED`. Every automatic redesign and every `revise` is a new paid image call. `webtoon-scene-image-review` checks the actual image and every line, speaker and reading order. It records the observed lettering and never passes an unviewed review. On failure, it turns the observed defects (a panel count difference, lettering or speaker different from the source, continuity, blocking findings) into feedback and, within the automatic redesign budget, issues planning, checking and an image request again. The images, reviews and feedback of failed attempts remain in `attempts`. When the budget runs out, `scene_needs_revision` shows the results and evidence. The image model is instructed not to draw text or speaker name tags other than the quoted lines, and not to copy text from the reference images. On a redesign, the pre-generation check produces only positive emphasis. `renderBrief.focusTextIds` are the IDs of lines that especially need exact lettering, and the server quotes the exact source text again. `renderBrief.corrections` (up to 3 lines, 20 words per line) describe only the wanted result. Earlier attempts, wrong results and prohibition words (not, no, never, instead, previous, fix, etc.) are refused, because showing the wrong form to the image model again pulls it toward that form.
5. Lookups use the existing `lane="webtoon"` and the workflow ID. The scene path has no user approval step. `completed` means the host's scene review passed; it does not mean the novel canon or an existing episode was replaced or published. The result is kept under `.vibelore/webtoon/candidates/<workflowId>/r<revision>/` as `scene.png`/`scene.jpg`, `scene.html`, and the plan and review JSON; nothing is written to `webtoon/`. The lettering is part of the raster, so don't describe it as separately editable lettering. If the user wants panels split or partial edits, handle that as a separate follow-up job.

When `previousWorkflowId` is given, the previous scene's actual image, design and review results are inherited. The source text must start at the paragraph right after the previous range. Even if the previous scene has a needs-revision verdict, you can continue while keeping that record, but a failure is never turned into an approval. Record the evidence of character, background and action transitions from comparing the two actual images, and the observed panel count; a panel count mismatch or a continuity failure blocks completion. The panel count mode is not applied retroactively to existing stored jobs. Scene jobs stored before the short `renderBrief` was introduced use the new request format from the next `revise`, and the image import receipts up to then are not reused.

Starting a new per-panel job with `lore_webtoon_plan` is refused with `WEBTOON_PANEL_PATH_DEPRECATED`. A `workflowId` that doesn't exist is still `WEBTOON_WORKFLOW_NOT_FOUND`. Per-panel jobs already started still support continuing the plan, render, approval, `lore_resume`, and `lane="webtoon"` status and history lookups; for details, follow [Appendix: per-panel path (deprecated)](#appendix-per-panel-path-deprecated).

The user production guide is [Making a webtoon](../WEBTOON.en.md). This document is the current execution contract for hosts
and integration developers who answer MCP requests. Error and compatibility descriptions
do not mean available production options.

It adapts an existing Vibelore novel, world and characters into webtoon scenes. It pins the source version and manages
direction interview → scene adaptation and English direction → pre-generation check → scene image with lettering → visual review of the actual image
as a separate workflow. It starts with the `webtoon-discovery-interview` skill or
`lore_webtoon_scene`. The output is a scene raster image (PNG/JPEG) with the lettering drawn in, plus `scene.html`, and the actual image generation is done by the host. SVG/HTML masters exist only on the per-panel path (deprecated).

## Work language contract and integration scope

In multilingual builds, the work language and the host conversation language are independent. `src/core/webtoon-language.js` uses `resolveWorkLanguage` when the same install has the shared `work-language.js`, and pins the approved language, contract hash and allowed quotation exceptions into the source snapshot's `languageContract`. It does not look up files in a separate repository at runtime, and it does not overwrite the work language with webtoon preferences. In older versions without the shared handler, only existing Korean works without a language key are compatible, and works with an explicit language are blocked with `WEBTOON_LANGUAGE_CONTRACT_UNAVAILABLE`. Conflict and corruption errors of the handler are not hidden behind a Korean default.

- Scene path: the image model letters the dialogue in the work language's script (`sceneLetteringLine`), and the image review transcribes the text in the script it is drawn in and compares it with the source. There is no glyph pre-check. The server's questions, warnings and notices are ko or English.
- (Per-panel path) Questions, options and recommendations come in two families: ko and English guidance. The host conveys their meaning in the user's conversation language, without leaving out the W04/W15/W16 choices and the unsupported notices. Values such as `standard`, `minimal` and `page-rtl` are not translated. No new webtoon default that asks for the work language is created.
- (Per-panel path) The same language contract and target-language guidance are passed to generation and to single and parallel split review requests. English guidance or Korean schema examples are not copied into the work's dialogue. The episode HTML keeps the plan's work-language tag, and the reader guidance for non-Korean works uses the English family.
- (Per-panel path) The plan check confirms glyph and shaping support for the strings actually lettered. On failure, it records the panel/text index and the cause in `plan_invalid`'s `WEBTOON_TEXT_RENDERING_UNSUPPORTED` and stops before generating reference images. `render="image"` text on signs and monitors keeps its separate image review path. A missing font is not worked around with a Korean translation or dialogue drawn into the image.

Existing works without a language key are read as ko. Older installs without the shared handler support only this compatibility path, and a source with an explicit language stops with the error above.

### Preventing quality regressions (per-panel path)

Panels with a lettering style applied are also split by episode order, not by object identity. It checks together that a segment's script, surrounding panels, image paths and source text point to the same range. An explicit answer identical to an existing delegated or undecided value is also accepted as `answered`, and a confirmation that doesn't change the value does not needlessly reopen later choices.

The new policy is verified on the actual MCP stdio path from rough setup → rough review → user approval → drawing → link review of the actual images → final approval. Legacy regression tests reproduce jobs that had no stored policy fields with explicitly named test-only legacy fixtures. Production has no option to remove the policy. Reviews of synthetic fixtures are not reported as visual quality evaluations.

## Appendix: per-panel path (deprecated)

Below is the execution contract of the per-panel rough-approval path. Starting new work with `lore_webtoon_plan` is refused with `WEBTOON_PANEL_PATH_DEPRECATED`. A `workflowId` that doesn't exist is `WEBTOON_WORKFLOW_NOT_FOUND`. Per-panel jobs already started still support continuing the plan, `lore_webtoon_render`, `lore_webtoon_decide`, `lore_resume`, and `lane="webtoon"` status and history lookups. New work uses the [default path](#default-path-whole-scene-production).

- Required choices: [art, lettering, page format](#required-choices-before-production--art-lettering-page-format), [start and interview](#start-and-interview), [production order](#production-order).
- Execution and resumption: [state table](#continue-by-state), [rough approval and parallel drawing](#composition-rough-approval-and-parallel-drawing), [revision and resumption](#revision-and-resumption).

### Required choices before production — art, lettering, page format

A new workflow stores `presentationVersion=1`. The first `needs_interview` round is the unanswered items among **W04 art, W15 lettering and W16 page format**. The rest of the interview and production proceed only after all three are settled as the user's `answered`. `mode="auto"` does not choose these items on the user's behalf either. Choices in an already approved work profile are reused in the next episode. A new version is not inserted into existing workflows in progress, and they are not asked again. When a new episode starts from an older profile, only the missing W15/W16 are confirmed additionally.

- **W04 art:** freely specify the desired impression of line, shading, coloring, proportion and background density. The American comics style and Japanese manga style in the options are broad reference names and don't guarantee a particular quality or page format. An art name like Japanese style is not interpreted as a choice of page-format output. This direction is passed to the existing reference image and panel generation requests.
- **W15 lettering:** choose from `standard` (round dialogue balloons, dark monologue boxes, caption boxes), `soft` (light monologue boxes) and `minimal` (no monologue or caption boxes, white text outline for legibility). None of them attaches a tail to monologue. A direct specification is taken as a JSON string with four fields `{ "dialogue":"round|square", "thought":"dark|light|plain", "caption":"box|plain", "sfx":"contextual|plain|impact" }`. contextual chooses the normal or emphasized sound effect per panel; the others fix that presentation. Arbitrary fonts, cloud balloons and curved tails are not supported yet. An unsupported request is not silently changed to the default.
- **W16 page format:** `scroll`, `page-ltr`, `page-rtl`. Currently only scroll is supported through generation, lettering and output. The page formats keep the choice and reading direction and hold production at `needs_format_support`. It doesn't proceed vertically until the user changes it.

Show the returned `questions.options` with names the user understands, take the answer and put the chosen value in `responses`. Free description is passed as `feedback` and organized into supported fields with the source evidence. If the meaning can't be settled or is outside the supported range, confirm with the user. The choice is pinned in the contract and `plan.presentation`, and the lettering design is applied to the actual lettering. When the design changes, the lettering check hash changes too, so an earlier review isn't passed as is. The lettering design is not put into the image input, so that choice alone does not change a panel's image input hash.

### Composition rough approval and parallel drawing

A new episode starts with `storyboardPolicyVersion=2`. After reference image approval, set `lore_webtoon_render(continuityPlan={version:2,...}, feedback="composition design direction")`. Without it, `needs_continuity_plan` and empty jobs are returned, and final art imports are refused too. You can't drop to v1 to bypass the required approval. Existing stored jobs without this policy field keep their earlier state and are not migrated or regenerated automatically. Use the v1 fields of "Continuous scene production" below, but include every planned panel in reading order.

`adaptation and script approval → simple composition rough → per-panel and link review → user rough approval → drawing by dependency → link review of the actual images → lettering and look/final approval`

1. **Decide the composition first.** Separate the location layout from the camera, and write down the number of characters and monsters, direction of movement, points of contact, before/after state and the decisive moment. One rough batch is at most 6 consecutive panels. Even when a long fight is split, continue the immediately preceding `previousShotId` and check the boundary. A `reset` after the first panel needs a `resetReason` explaining an actual change of time or place. A mere change of batch is not treated as a new scene.
2. **A rough is not finished art.** With `needs_continuity_roughs.jobs`, draw only numbers, silhouettes to identify characters, simple props and floor, movement arrows, contact points and dialogue space. The purpose is action and reading order rather than detailed faces, costumes and textures. Import the actual returned images as `continuityRoughs`. Pass the `feedback` of revision jobs too. Up to 3 independent rough batches can run at once.
3. **Review with what was actually read.** `roughReviewJobs` give the actual image paths of the target batch and the batch before the boundary. Even while other roughs are being generated, review the batches whose needed images are ready first. Besides the basic fields of `continuityReviews(kind="rough")`, the job's `contextHash`, `observations:[{shotId,verdict,evidence}]` for every panel, and `transitions:[{from,to,verdict,evidence}]` for every earlier link are needed. When a neighboring rough changes, update that link review too. `verdict` is `clear|unclear|contradiction`; passed=true only when all are clear. If numbers, silhouettes or contact points aren't visible, don't pass it by imagining from the source or instructions.
4. **The user checks the roughs.** When every batch's review passes, `storyboard.html` and `approval.kind="storyboard"` are returned. Show them with the episode order and dialogue, and get approval with the current approval ID. This step is not approved automatically even in `mode="auto"`. Request revisions with `request_revision`, `revisionTarget:{kind:"storyboard",sceneIds:[...]}` and `feedback`. When sceneIds is omitted, all roughs are made again. Valid batches not selected and earlier files are kept. Changes to dialogue, events or panel count go back to `kind="adaptation"`.
5. **Use the approved rough as the actual drawing input.** Attach the `role="storyboard"` file of `referenceImages` together with the character references and pass `continuityPrompt` too. Finish only the one panel for the `shotId`/`panelIndex`, without copying numbers, arrows or other panels. Character appearance follows the character references; composition, movement and contact follow the rough. The `kind="shot"` review of a finished panel needs `composition:{verdict,evidence}` as evidence of matching the rough.

#### What runs in parallel

| Target | v2 execution condition | Review kept |
| --- | --- | --- |
| Independent rough batches | Share the approved script and references, up to 3 at once | Inside the batch and at its boundary, overall user approval |
| New-composition `cut` in action | Runs on the approved rough. Doesn't wait for or automatically attach the finished image of the previous panel | Causal state is passed on, and the two actual images are compared after generation |
| `continue` where pose and props carry over | Runs after the immediately preceding finished image is reviewed | The previous image actually attached and matching the rough |
| Explicit `anchorShotId` | Runs after the anchor image is reviewed | The specified reference image attached |

The host runs only the ready jobs of `needs_images.jobs`, up to 3, and imports them in order of completion. The server manages readiness and input hashes and never runs paid API workers itself. A cut's input hash is not affected by the completion order of previous panels that aren't attached. continue/anchor are still sequential dependencies, so generating them together before the preceding review is refused.

`continuity.transitions` gives the paths and combined hash of **two adjacent actual finished images**. Review the connection of position, gaze, movement, contact and result with `continuityReviews:[{kind:"transition",id,hash,inspectedImages:true,passed,evidence}]`. They can be checked as they become ready, and unreviewed or failed links cannot move on to look/final. When an individual panel is revised, only the panels that depend on the actual image are made again, and both link reviews are updated to the new image hash. Unrelated cut art is not regenerated in a chain.

A review is the host's report of what it actually viewed, not an independent evaluation or an aesthetic guarantee. The existing lettering, composite and final approvals are kept. Tests verify approval blocking, detection of file changes, parallel ready jobs, sequential dependencies, local invalidation and link reviews. Measured API time, cost and final staging quality are measured in separate productions. Because roughs and a user check are added, the first generation time is not guaranteed to always get shorter. The costs this aims to reduce are unnecessary serial waiting and rework of finished art.

### Reducing waits and duplication

`efficiencyVersion=1` in new workflows reduces execution and transfer without removing quality checks. It does not automatically change the stored data or approval state of existing episodes.

- `lore_workflow_status(lane="webtoon")` defaults to `detail="summary"`. It leaves out the repeated source, full plan, reference details and full list of outputs, while keeping the current approval ID, failures and findings, and progress. Look up the full data with `detail="full"` or `lore_workflow_inspect`. `needs_images` in new jobs is also summarized by default, without shrinking the actual instructions, references and hashes of the jobs to run. You can ask for the full answer with `lore_webtoon_render(detail="full")`.
- Independent segment reviews issue up to 3 **different request IDs** in the same run. Each request keeps the existing maximum of 6 panels, surrounding context and common guidance. Answers can be submitted to `lore_resume` as they complete, and a state with only some answers received and its audit history are stored. Completed slots are not called again after a restart. Drafts depend on the previous scene and are processed sequentially, and the whole-flow review also runs separately after the segment reviews end. Whether the host actually runs them concurrently depends on the host's execution environment and permissions.
- If you have confirmed that the composite can't be opened, pass `reviewAccess={available:false,reason:"the actual restriction"}` in a render call with no pending approval or model answer. It doesn't dress up the geometric and original-art checks as passes; it skips only the impossible composite review request and drops to a failure receipt and waiting for user approval. If it is undecided whether it can be viewed, review the first segment first. If that answer reports a global restriction `inspectionUnavailable={scope:"composite",reason:"..."}`, don't repeat the remaining segments and the whole read-through request. Existing findings are kept. Defects in some panels must not be reported as a global inability to view.
- `reviewAccess.available=true` is only the host's report about the possibility of viewing, not a completed review or permission to bypass a security restriction. Update it and review when the viewing environment has actually recovered after a revision request at a failed gate. Approval and incomplete states don't pass automatically.
- Image jobs advise `scheduling.strategy="ready-first"` and a maximum concurrency of 3. Don't wait for a whole batch of independent scenes; check each finished panel and import it immediately. `assets` and the actual review of the same file, `continuityReviews(kind="shot")`, can be sent in one call. The review is linked after the file and input hash are confirmed, so the following panel opens immediately. The workaround of generating parent and child images together before review is still refused. The server itself doesn't call a paid image API or run workers.

To the existing questions of the adaptation review we added **whether, after omissions, question → answer, the target of instructions and the speaker's prior knowledge still read from the webtoon itself**. It is not a new check stage or a rule banning particular expressions. Semantic judgment is still the model's advisory and does not guarantee complete automatic detection.

### Text roles and production paths

A new workflow stores `textPolicyVersion=1` and requires a plan with the same value. It is not applied automatically to existing workflows, approved versions or the source canon. The model and execution path choice and the profile/plan/references/look/final approval procedure are unchanged.

- `dialogue`: actual speech. The character ID is kept and it is lettered in its own balloon. Offscreen speech is marked `delivery="offscreen"`, and its tail anchor is the screen edge the sound comes from. It is not linked to the mouth of another visible character.
- `thought`: a particular character's inner thoughts. A speaker ID is needed. Tailless dark background with light text, distinct from plain narration.
- `caption`: narrator explanation or time compression. `speaker="narrator"`. A minor character's direct line is not replaced with a named caption.
- `sfx`: lettered separately at the point where the sound originates. The existing normal/emphasized sound effects and collision checks are kept.
- `ui`: text on actual objects such as signs, notice boards, monitors and documents. Under the new policy, specify `render="image"`, the exact `text`, and a `surface` describing the object and its surface position. It is included in the generation request and the image input hash, and no lettering box is made. Passing dialogue, monologue, captions or sound effects as `render="image"` is refused.

Minor characters not among the main characters link their source evidence with the panel's `voices: [{id, description, sourceIds}]`. Main character IDs or narrator/system can't be redefined. Dialogue refers to this voice ID as the speaker, and only onscreen speakers are included in the generation request's `visibleVoices`. Whether that minor character actually appears in the source is for the model review; the source ID check alone doesn't guarantee the meaning.

In lettering analysis, object text returns `textIndex, observedText, surfaceBounds:[x,y,w,h], confidence, reason`. If the text read from the actual image differs from the expected string or can't be confirmed, it is blocked with `PHYSICAL_TEXT_MISMATCH` or similar. The review is bound to the image hash, and this entry doesn't take balloon candidates or tails. That surface area is automatically included in the occlusion check of other dialogue and sound effects. Errors are fixed by partially editing or regenerating the image and reviewing again. It is not passed by covering it with an added caption box.

The source text, role and target object remain in the plan JSON and the approved script, so text management isn't lost even when the text is in the image. This check is a structure that verifies the host's report of what it actually read, not independent OCR or a guarantee of the image model's accuracy. Generation requests pass the same text guidance to single and split adaptation and to partial and full reviews. The separate box output of the old `ui` stays compatible only for unversioned old plans.

The new text policy applies to new production. It does not update existing episode candidates, images, lettering or approval states, or start a new episode automatically.

### Segmented production

A per-panel job started with `segmented=true` limits the size of tasks while keeping the existing tools and approval stages. The policy is fixed at start, and changing it later fails with `SEGMENTED_POLICY_REQUIRES_NEW_WORKFLOW`. New per-panel jobs can't be started. This option does not guarantee model capability or quality.

- After the overall selection, `webtoon-plan-outline` builds an episode outline without individual panels, the purpose of each scene, entry/exit states and the source assignment.
- `webtoon-plan-part` writes 1-6 panels per scene. It receives the common guidance, the overall map, the relevant source text and the last 2 panels of the previous scene. The source assignment, panel cap, scene IDs and script structure are checked before merging. The overall cap is not divided into per-scene quotas.
- Script and visual reviews request up to 6 panels per sequence together with 1 panel before and after. Each target panel's `observations` and the adjacent links' `transitions` need `clear|unclear|contradiction` and actual evidence. Submitting only a list of IDs does not complete it.
- The last overall review receives a thin flow map and partial findings and focuses on repetition, disclosure and emotional payoff. The visual review is given the actual original art paths, their lettering, and the composite path. What wasn't actually seen is left as `inspectedImages=false`.
- Lettering analysis is split into the same scene batches too, and the server stores the finished map and issues the next request. The host doesn't need to combine several requests by hand.
- The common guidance keeps the full value of the approved user direction and the contract/source hashes. The whole source and the cumulative artifact list are not repeated in every review request. Partial tasks receive the relevant source text and established settings.
- Partial review results are bound to the content, adjacent panels and image/lettering binding. Unchanged reviews are reused, and batches whose input changed and the final read-through are requested again. An explicit revision request allows incomplete reviews to be retried. A new adaptation rebuilds the outline and partial drafts.

`segmented.reviews[].complete` means the evidence format and range and the reported viewing are in place; it is not an automatic pass on aesthetics or meaning. `unclear` and `contradiction` are left as advisory findings, and an incomplete partial review can't be overwritten by overall completion. The existing user approval and novel canon protection rules are kept. Reviews are host self-reports, not independent reader evaluations.

Currently only one webtoon job in progress is allowed per work. If the previous episode is unapproved, a request to create the next episode doesn't approve or close it automatically. Closing it without adoption while keeping the existing candidates, or proceeding with approval, needs the user's decision.

### Continuous scene production — v1 compatible behavior

To supplement the space, camera and action links of an existing approved script, answer the current look gate with `request_revision`, then set render's `continuityPlan`. The novel, dialogue and event order are not changed. The setting keeps the earlier art of those panels and releases the generation link. Scenario or panel count changes go through the existing adaptation revision path.

`continuityPlan={version:1,scenes:[{id,environmentId,layout,cameraAxis}],shots:[{shotId,sceneId,transition,previousShotId?,anchorShotId?,visibleCharacters?,background?,blocking,camera,before,after,change,decisiveMoment}]}`. `reset` is a new scene, `continue` a continuous shot that inherits up to the previous image, and `cut` a transition that inherits only the causal state and shoots with a new composition. Both `continue` and `cut` require a `previousShotId` earlier in the same place and an actual review, but `cut` doesn't automatically attach the previous image. Only an explicitly given `anchorShotId` is attached as an additional visual reference. `visibleCharacters` selects only the approved characters needed on this screen (an empty array is an insert panel without characters). `background` is `establish|partial|abstract`, and abstract excludes architectural background references. `layout` is the actual location layout, `cameraAxis` the side the camera shoots from, and `blocking` the positions of characters, monsters and props. Don't confuse screen left/right with world coordinates. For fights, choose the decisive moment of expression, contact, turn or impact, and don't stand characters in every panel like background. For conversations and meals, prioritize continuity of seats, gazes and props.

Resetting the plan invalidates only changed scenes and their dependent panels. Scenes whose definition and panel items are identical and whose rough review is valid for the current input keep their roughs, art and reviews. The input binding of kept roughs is recombined with the new overall plan. Earlier candidate files are not deleted, and changed scenes and feedback stay in the workflow history. Sending the same plan again alone does not force reviewed roughs to be replaced.

Make continuous roughs per scene with the jobs of `needs_continuity_roughs` and import them with `continuityRoughs:[{sceneId,inputHash,path,provenance}]`. After reading the actual art, submit `continuityReviews:[{kind:"rough",id:sceneId,hash,inspectedImages:true,passed,evidence}]`. A failed rough doesn't open the final art. To replace a rough, set the plan again to invalidate the dependent art as well.

After the rough review, `needs_images.jobs` shows only runnable panels. `blockedJobs` marks dependencies on earlier panels not yet generated or reviewed. Generation actually attaches the existing character and space `referenceImages` plus the additional `previous-shot` and `scene-anchor` files. Pass `continuityPrompt` together with the basic request too. Writing a path in the prompt is not attaching an image. Continuity supplements camera and layout and does not change the script.

After import, the next panel opens only after the actual continuity is reviewed with `continuityReviews:[{kind:"shot",id:shotId,hash,inspectedImages:true,passed,evidence}]`. Revising an earlier panel also releases the following panels that depended on it via previous/anchor, and the file and generation input hashes distinguish the kept original from the new link. A rejected panel is not used as is as a later reference. Per-scene generation can run in parallel, but within one link it runs sequentially after review.

This review is a host report, not an independent verdict, user approval or staging quality guarantee. The existing look/final gates and lettering review are kept. Staged reference links apply to jobs that currently specify `continuityPlan` and are not inserted arbitrarily into old jobs.

To change only the model while keeping the approved character and background references, propose it with `lore_webtoon_render(imageModel="gpt-image-2.5-flare", imageExecution="openai-api", preserveReferences=true)` and pass the user's answer to the current `confirmImageChoice` ID. The existing references' design, actual file hashes, original approval history and generation model are kept. New panel requests use the new model, and each reference comes with `provenance` and `reuse` audit information. Unapproved references and changed files can't be reused. The default, as before, rebuilds references per model. Plan approval updated by the model change is still required.

The image model and execution path are remembered per work after the user confirms them. The server's default suggestion and actual account availability are separate, and you must check that the executing host supports the chosen model.

### Source input and inheritance

The basic input is not an uploaded plain text but **an existing Vibelore work project**. Creating a new world and characters from scratch or comparing different image providers is not part of the basic production flow. Vibelore handles the source, adaptation, continuity and approval, and the executing host handles image generation and editing with the approved instructions and reference images. Image production proceeds only on hosts that can actually generate and view images.

| What to inherit from the existing work | What to add for the webtoon | Handling principle |
|---|---|---|
| World rules, period, technology and space settings in `world/` | Reference images for the shape, color, material, lighting and space of backgrounds | Keep established facts and fill in only visual elements not described |
| Character IDs, personalities, relationships and appearance in `characters/` | Reference images for face, build, costume, expressions and poses | Settle the visual expression of the same character, not a new character |
| Established manuscript in `chapters/` | Webtoon episode structure, sequences, panels, dialogue and scroll pacing | Don't fix novel chapters and webtoon episodes one-to-one |
| Approved StoryProfile, work identity and writing intent | Expression, action and caption transitions of inner states, and the reader experience | Don't mechanically turn the novel's sentence rules into panel count rules |
| StoryState and chapter plans around that chapter | Costume, injuries, props, relationships and reader knowledge at the panel's point in time | Don't apply future states to past scenes |

Designs added in the webtoon are kept as webtoon settings. Distinguish proposals that change the source's facts from proposals that just fill empty visual information, and don't write them back into the novel canon automatically. If the source text, the current structured data and point-in-time states conflict, don't pick one arbitrarily; resolve it by syncing or by confirming with the user.

#### The interview confirms the visual direction; it does not re-create

First organize and show "what the source already settled / what is empty for visualization / what needs approval to change". Don't ask again about character names, personalities, relationships or world rules. Ask only about what can't be answered from the source: art style, details of appearance, exaggeration of expressions, visualization of exposition, adaptation latitude, scroll pace, content level and scope of approval.

The existing 14 areas and 8 branches are coverage to prevent missed questions. They don't mean asking every item from scratch every time. Reuse webtoon choices already answered, and show facts settled by the novel settings as inherited evidence. But "facts settled in the novel" alone are not treated as "the user approved the webtoon preference". The current answer's `inherited` provides the pinned source settings and the original text of user-added documents, and each question's `inherited` provides the related characters, world facts, document IDs and decision boundaries. The host reads these to explain the actual undecided visual elements. It is not a complete automatic checker that judges semantically whether something is undecided.

#### Production order

1. Pin the existing work and the source chapter range and version, and read the settings, manuscript and the state at that time.
2. Approve the adaptation and visualization direction through the webtoon difference interview.
3. Before panel planning, decide the main reader experience and what in each scene to emphasize, condense, omit or defer. From this editorial candidate, make a separate webtoon scenario and rough storyboard with text. The panel count and the needed characters, spaces and props are derived from that result.
4. With a runnable approved model, make reference image candidates starting with this episode's main characters and recurring spaces, and review them in a representative scene. Don't generate every character of the work in advance.
5. Settle the space, camera and before/after state of every panel and make simple roughs of up to 6 panels. Review the actual panels and boundary links, then get the user's storyboard approval.
6. Actually attach the approved roughs, character references and panel states and generate only the ready jobs. cut is generated in parallel with a new composition; continue/anchor wait for the reviewed preceding image. Interactions are drawn in the same scene, and the links of the actual adjacent images are checked too.
7. Assemble the panel images with editable dialogue and captions, and review faces, acting, space, text and scroll flow. Generating a whole episode as one image is not the default.
8. Fix the needed part of problem panels and approve the final anew. The next episode reuses the approved reference images and updates only the point-in-time state.

Reference images are linked to character and place IDs, the point in time and costume they apply to, the approved version and the image hash. A panel request holds the source evidence, the approved references of those characters and places, composition and action, features to keep, features to change, and text space. The previous generation is not used unconditionally as the correct answer for the next panel. To prevent a face changed by a revision from becoming the reference in a chain, go back to the approved reference and compare.

#### Connecting Codex image generation and the plugin

`Check runnability → Vibelore's needs_images → host image generation and editing → check the actual result → keep it in the work folder → import as assets → review and approve` is the basic path. The server calling a Codex-specific tool directly is different from the host agent connecting the tools. Currently the server provides the requests and image import, and Codex itself handles calling the built-in tool.

The server's built-in path issues requests only for the `gpt-image-2` policy. This is the server's support contract, not an observation of which model the current host actually runs. Check the host's actual capability and returned results. Don't silently switch to a separately billed API or another provider.

On a per-panel job in progress, `lore_webtoon_plan.imageModel` must match the current requested model; change it with `lore_webtoon_render`. It no longer sets the model candidate for new work. Existing stored policies and hashes are not changed automatically.

On an approved plan without panel images, propose the model and path with `lore_webtoon_render(imageModel, imageExecution)`. `needs_image_choice` returns the current choice ID and the cost and retention scope, and generates no images. When the user chooses, confirm with `confirmImageChoice` and the user's own answer as `feedback`. The script and earlier reference files are kept, and the contract, reference links, plan review and approval IDs are updated. The choice is kept for the next panels and episodes of the same work and confirmed again only when changed. If it conflicts with the billing path of an earlier W11, the explicit latest choice applies, but the other production constraints are not erased.

When the API is chosen, the host sets the generation jobs' `apiRequest.model` in the actual API call. Reference images use the generations path, and panels with references the edits path. The host runs them with the image generation skill's bundled CLI. The server itself currently doesn't call the API. `imageRuntime.available` tells whether requests can be issued; it is not a verification of the key, account permission or payment balance. Check the key in the host's execution environment, and don't put it in the conversation or MCP arguments. [API image generation guide](https://developers.openai.com/api/docs/guides/image-generation)

If 2.5 is confirmed on the built-in path, the current tool has no argument to select a model ID, so it waits with `needs_image_runtime`. It does not automatically substitute the model or a paid path because execution failed. Importing an API result needs `provenance.kind=openai-api`, the chosen `requestedModel` and the current `selectionId`. This is a consistency check of the host's report, not independent proof about the actual provider. Distinguish `targetModel` from the observed model, and don't make up snapshot or call IDs that weren't returned.

Check the actually returned image files, keep them by version in the work folder and import them. A failed generation request is not recorded as a finished image. Dialogue and captions are edited separately from the art by default, and text baked into an image is not treated as the final text source.

### Current scope

- 16 required areas and 8 in-depth branches that open depending on the answers. Partial answers, resuming corrected and dependent questions, keeping all original answers.
- Pins the exact files of the existing source and the StoryState at that time. The latest mutable character states are excluded from past adaptation input.
- Asks the model for a source mapping, sequences, exact dialogue and a minimal visual bible, and approves after structural checks and advisory review.
- PNG/JPEG import, an SVG master combined with editable text and a mobile HTML preview, approval of the visual references and final bytes.
- A workflow and publication separate from the novel. Resumes model work with the exact run ID and keeps failure records.

#### Scene selection

After direction approval, a new job proceeds `webtoon-editorial → webtoon-plan → webtoon-plan-review → plan approval`. All three model stages use `needs_model` and `lore_resume`. No separate user approval stage is added; **the selection and the panel plan are bound to the same plan approval.** W03 asks about the main experience, secondary experiences and the boundary of what to cut. Stored existing answers are not replaced with new preferences arbitrarily.

`editorial.focus` holds the main experience, secondary experiences and what to give up; `beats` hold, for beats that group source units, expand/condense/omit/defer, the reason, the change for the reader, visual evidence and context preservation. The whole source is mapped to this map, but omitted beats don't have to be drawn. The plan includes the same `editorial` and `panelCountReason`, and per-panel `beatIds/purpose/readerDelta`. The default `maxShots=40` is the existing production safety cap, not a demand to fill 40 panels.

The server blocks missing or duplicated source units, panels that use excluded beats, missing panels for beats kept, mismatches of a panel's source and beat, and changes to the selection binding. Whether an omission is semantically good, whether the causality actually reads, and whether a stillness carries emotion are left to the review and the user's judgment. Panel generation requests also pass that beat, experience and panel role and are bound to the image input hash. An image whose purpose of expression changed is not reused unconditionally.

`editorial.json/md` candidates are stored by version and published to `webtoon/episodes/.../editorial.md` after approval. For `editorial_invalid`, read the error and retry with plan's `retry=true`. Automatic migration is not forced on existing workflows. Only when re-doing the adaptation while waiting for the current plan/look/final approval is the new selection flow activated, with the explicit request below. The source, contract and production cap stay pinned, and earlier candidates and approval files are kept.

```js
lore_webtoon_decide({
  project: "/absolute/path/to/work", workId: "my-work", workflowId: "wt-...",
  approvalId: "현재 승인 ID", action: "request_revision",
  revisionTarget: { kind: "adaptation" },
  feedback: "이번 화의 핵심 경험과 덜어낼 장면, 반드시 남길 맥락"
})
```

This request is different from `lettering`, which fixes only lettering. It releases the existing visual approvals and goes back to a new plan approval, and it doesn't generate new images automatically.

The current server manages user confirmation and per-work retention of the image model and execution path, requests, PNG/JPEG import, lettering computation, and review and approval. The server doesn't call a paid image API directly or charge costs. `needs_images` is a generation request and doesn't mean generation is complete. The provided output is SVG/HTML; splitting into PNG/JPEG for platforms is not provided.

### Start and interview

```js
// Continues per-panel work already started. Starting anew without an existing workflow fails with WEBTOON_PANEL_PATH_DEPRECATED.
lore_webtoon_plan({
  project: "/absolute/path/to/work", workId: "my-work", workflowId: "wt-existing"
})
```

The arguments described below are the values that were set when that job started.

`sourceChapters` are existing source chapter numbers. `episode` is the webtoon episode number to make, and several source chapters can be combined into one. One workflow handles one webtoon episode. Batch runs of several launch episodes are not provided yet. If the source has a publication it must be synced first, and a manuscript without a publication is marked `manuscript_snapshot`.

Show the user the question round returned by `needs_interview`. Pass the answers to the same workflow.

```js
lore_webtoon_plan({
  project: "/absolute/path/to/work", workId: "my-work", workflowId: "wt-...",
  responses: { W01: "처음 읽는 독자에게 보여줄 한 화의 맛보기", W02: "사건과 관계는 유지하고 설명은 압축" }
})
```

`responses` per question ID store the original answers as they are. If several decisions were answered in natural language, pass them as `feedback` and the model organizes them with the source evidence. Even if the model returns an empty question list, it isn't complete while the decision coverage is empty. Use `mode="auto"` explicitly only for delegating webtoon choices.

### Continue by state

| State | Next action |
|---|---|
| `needs_interview` | Show the user the current questions and resume with responses/feedback |
| `needs_model` | The model reads the request and answers with `lore_resume`. Empty answers keep it waiting |
| `awaiting_approval` | Show the actual output of the current `approval.kind` among profile/plan/references/storyboard/look/final, then decide |
| `needs_format_support` | Keep the page-format choice and explain that it is unsupported. Don't generate until the user changes W16 |
| `plan_invalid` | Check the hard errors and the source text and regenerate with `retry=true`. At most 3 retries |
| `model_failed` | Check the failure and `retry=true`. The same user answers and source are kept |
| `layout_blocked` | Read lettering.issues and nextAction and give render the target panels and feedback for lettering. Images are not regenerated automatically |
| `plan_accepted` | Start with `lore_webtoon_render(quality="preview")`. If there are unapproved references, the reference requests come first |
| `needs_reference_images` | Generate and review the reference images, import them as references, then approve references |
| `needs_continuity_plan` | Submit the version=2 space, composition and before/after state of every panel as continuityPlan with feedback |
| `needs_continuity_roughs` | Generate only the current rough jobs and import them as continuityRoughs |
| `needs_continuity_review` | Check the actual images and adjacent links of roughReviewJobs or continuity and submit the review with the current hash |
| `needs_image_choice` | Show the model, built-in/API path, cost and retention scope within the work, and confirm with the current confirmImageChoice ID and the user's own answer as feedback |
| `needs_image_runtime` | Check a host path that can choose the requested model. Separate billing is connected only after the user chooses, and the current jobs are not run |
| `needs_images` | Generate and review images with a runnable approved model and import PNG/JPEG files inside the project as assets |
| `look_accepted` | After importing every shot image, generate and review the final with `quality="final"` |
| `completed` | Use the local approved version and the SVG/HTML master. Start the next episode with `lore_webtoon_scene` |

```js
lore_webtoon_decide({
  project: "/absolute/path/to/work", workId: "my-work", workflowId: "wt-...",
  approvalId: "wa-...", action: "approve"
})
```

An approval applies only to the current single gate. `request_revision` goes back to that gate with feedback. To change a profile preference, send a new answer to that question ID to `plan`. `hold` keeps it waiting for approval and `reject` ends the job.

### Images and outputs

A new job approves the reference images first. Return the IDs and `inputHash` received in each request as they are. The hashes in the examples below are placeholders.

```js
lore_webtoon_render({
  project: "/absolute/path/to/work", workId: "my-work", workflowId: "wt-...",
  quality: "references",
  references: [{ referenceId: "ref-character-...", inputHash: "요청의 실제 inputHash", path: "art/hero-v1.png", provenance: { kind: "codex-built-in" } }]
})
```

A new job goes through composition planning, rough review and the user's storyboard approval after `references` approval. After that, `needs_images.jobs` include the per-panel approved roughs, the actual paths, hashes and roles of references, and the generation prompt. References and panels can't be imported at once to bypass approval.

```js
lore_webtoon_render({
  project: "/absolute/path/to/work", workId: "my-work", workflowId: "wt-...",
  quality: "preview",
  assets: [{ shotId: "shot-1", inputHash: "요청의 실제 inputHash", path: "art/shot-1.png", provenance: { kind: "codex-built-in" } }]
})
```

Under the new rough policy, the look step comes after all panel art and the needed actual link reviews are done. For old jobs, the minimum visual sample is two shots (one shot for a one-panel plan), and the final needs every shot. Imported images store their bytes and hash, so approved images are kept even if the original path changes. Up to 20 MiB per file and about 60 MiB in total for reference images and episode images are allowed. Changing a reference image releases the reuse of panels that use that reference, and the current bindings of references, roughs and previews are reviewed again. A visual review failure is not approved automatically even at the reference image stage.

Request a revision of selected panels with `quality="preview", regenerateShotIds=["shot-1"], feedback="move the gaze to the door handle"`. If approval is pending, first answer the current gate with `request_revision`. Use the new job's `kind="edit"`, `editTarget`, `referenceImages` and `inputHash`. The original image is kept as the edit input, and late generation answers from before the revision are not imported. A completed job is re-planned in a new workflow.

Old workflows stored before this link, without `imagePolicy`, resume with the existing import method. If reference image approval with the new link is needed, finish or reject the existing job and start the next one with `lore_webtoon_scene` (`newWorkflow=true` is refused with `WEBTOON_PANEL_PATH_DEPRECATED`). Stored approvals are not silently converted to the new contract.

Candidates are stored in `.vibelore/webtoon/candidates/`, and the approved profile, scenario and final master in `webtoon/`. Model requests and answers are linked to the existing model-exchanges audit records. The webtoon publication lives in `.vibelore/webtoon-publication/` and does not move the novel HEAD. If the hash at generation time differs from the actual file, the final can't be approved.

### Revision and resumption

#### Lettering v2 — revisions without redrawing

New workflows use v2. An old workflow switches to v2 on an explicit lettering revision request, and its existing look approval is released. The novel canon, approved dialogue, image bytes and reference bindings are kept.

It proceeds `actual panel analysis (needs_model) → compute candidate placements → geometric checks → build SVG/HTML → review of the actual composite (needs_model) → look approval`. The map holds normalized coordinates on the original image, anchors at the speaker's mouth or the sound's cause, protected rectangles, candidate centers, and confidence and evidence. If the image, text, height or font hash changes, the existing map is not reused.

While approval is pending, make the request at the current gate.

```js
lore_webtoon_decide({
  project: "/absolute/path/to/work", workId: "my-work", workflowId: "wt-...",
  approvalId: "현재 look 또는 final 승인 ID", action: "request_revision",
  revisionTarget: { kind: "lettering", shotIds: ["shot-32"] },
  feedback: "오른쪽 인물의 첫 발화가 먼저 읽히도록 하고 얼굴을 가리지 않게"
})
```

If look was already approved or it is `layout_blocked`, send the same `revisionTarget` and `feedback` with `quality="preview"` to `lore_webtoon_render`. Don't mix assets, references or regenerateShotIds into this path. Changing dialogue wording is a plan revision and changing images is the regenerateShotIds path, both distinct from a lettering revision. A `model_failed` from a failed lettering model run is retried with **render's retry=true**. Don't restart the adaptation with plan's retry.

- `lettering.json`: source text, font hash, analysis map, up to 3 candidates, selected ID and check receipt. The font is the bundled Gowun Dodum (SIL OFL 1.1); actual advances and glyph bounds are read, and SVG text is output as outline paths to eliminate fallback font errors. Strings are kept in the JSON; the SVG text nodes are not edited directly.
- `lettered-samples.html`: the currently selected lettering for only the panels that have actual art. `lettering-options.html` and the per-panel candidate SVGs are for comparison. To change the candidate choice, give the panel and candidate number as feedback and review again. Earlier candidate data is also passed to the model; it is not an API that approves a candidate ID directly.
- `lettering.technicalStatus`, `reviewStatus`, `approvalStatus`: distinguish the geometric check, the host review and the final user approval. `planned/images/checked` distinguish partial samples from the whole episode. A review completed is not a guarantee of independence or aesthetic pass.
- On approval, the lettering, map and font bindings and the actual output bytes are checked again. An earlier approval ID can't be reused. Final approval needs the actual art of every planned panel and a new final review.

A sound effect map entry's `sfxStyle` takes `plain` (default 58px) or `impact` (76px, heavy stroke, white outline). impact is used optionally for strong hit sounds, and the enlarged text and outline go through the rotation and occlusion checks too. This option doesn't apply to dialogue. A mask is applied to the body border at the joint of a balloon and its straight tail to remove the closed seam. This improvement doesn't change dialogue center, size or line breaks, and it is not a curved-tail feature.

The current computation checks font-measured line breaks, dialogue order, avoidance of rectangular protected areas, overlap between balloons, collision and minimum protrusion of straight tails, and the rotated bounds of sound effects. The candidate search is a bounded beam search, not a proof of optimality. Geometric checks can't correct a face, speaker or sound source the host specified wrongly. Curved tails, arbitrary masks, multiple fonts, complex script shaping, structured text-space reservation before drawing, and genre-specific sound effect styles are not implemented yet. Only precomposed Korean and supported glyphs are handled, and unsupported characters are blocked.

Give `lane="webtoon"` to `lore_workflow_status` and `lore_workflow_history`. Giving `workflowId` looks up the exact job. Omitting this option looks up the existing novel workflow. With `includeModelExchanges=true` you can also check the actual inputs and answers.

If there are hand edits in `webtoon/`, automatic overwriting stops. Read the edited files and the diff, confirm the intent, then re-review with `lore_webtoon_plan(adoptEdits=true, feedback="intent of the edit")`. The earlier canon is kept until the new plan is approved.

When the plan is rebuilt, for example because of a dialogue fix, shots whose image input didn't change are reused. Shots whose source, action, characters, costume, space or visual reference changed are prepared again. Even when reused, the changed final text and assembly files are reviewed and approved anew.

The source version of an existing plan is pinned. A new source HEAD is shown as an upstream change, but the job doesn't switch to the new version automatically. Requests that silently change the scope during work are refused. The server supports one active webtoon job per work, and concurrent change requests are told to retry with `WEBTOON_BUSY`.
