---
name: novel
description: >-
  The writing loop for continuing a novel. Use it when the user says things like
  "다음 화 써줘", "N화 집필", "이어서 써", "초고 검사해줘", "설정 안 깨지게 써줘",
  "write the next chapter", "continue the story", "check this draft", or when working
  in a vibelore project directory (one with world/, characters/, chapters/). It keeps
  the order of getting context through the lore_* tools, writing, validating and committing.
---

# Novel writing loop

The `vibelore` MCP manages the work's world, characters, continuity and writing order together. Default writing
uses the integrated `lore_write` workflow and does not bypass it with low-level steps.

Talk with the user in the user's conversation language (Korean with a Korean-speaking user, English with an English-speaking
user, and so on). These instructions are in English only for maintainability.

## Order

1. **`lore_write`** — `guided` by default; `auto` when the user explicitly says to go ahead on your own (“알아서”, "automatically").
2. **`lore_resume`** — answer the `needs_model` requests and continue the same workflow. The `requests` in one answer
   are independent of each other, so you may generate them in parallel with subagents, and pass all answers in one
   `lore_resume`. Review bundles come as several requests in one round trip.
3. **`lore_decide`** — show the checked guided manuscript to the user, then approve or reject.
4. Check progress with **`lore_workflow_status`** and the audit history with **`lore_workflow_history`**.

The workflow runs the per-chapter plan, the original draft prompt, the continuity check, the coherence judge, up to 3 checked
attempts (at most 2 revisions between them), the check receipt, the summary and the commit in order. A chapter of an active workflow
can't be bypassed with the low-level `lore_commit` without a receipt. When the third check fails, it ends (`clean_fail`) with the manuscript kept and
doesn't restart automatically. State `retryValidation=true` only to run validation again on the same manuscript.

## Work language

If the user states the writing language, normalize it into a BCP 47 tag and pass it as the optional `language` argument of
`lore_profile`, `lore_init`, `lore_create` and `lore_write` — Japanese → `ja`, Brazilian Portuguese → `pt-BR`,
Traditional Chinese → `zh-Hant`. Keep script and region subtags as they are. If the user didn't choose a language,
omit the argument so the language already set is used as is. Don't fill in the default `ko` on your own.

The conversation language and the work language are separate. You can write a work in another language while talking in Korean.
Write the prose, titles, summaries, settings, character descriptions and the descriptive values of plans and reviews in the work language,
and don't translate JSON keys, enum values, IDs, paths or sentinel tags.

Before generation, the only way to change the language is to create a new profile revision and get it approved again
(`LANGUAGE_CONTRACT_CONFLICT`); the language of a work already created can't be changed
(`WORK_LANGUAGE_IMMUTABLE`). Don't overwrite the prose language; suggest a new work instead.

Language and continuity are required gates. A manuscript that fails them is not eligible for approval or publication, whether by `auto`
or by the user's explicit approval. Only when the required gates pass and just the critic fails or is incomplete is the same
manuscript kept waiting for approval.

## Points that need judgment

**Hard and soft violations are different.** A hard violation directly conflicts with established facts about the world or
characters — a dead character speaks, a fixed appearance changes, or the settings of an unregistered character
are changed. Fix it. A soft violation is a comment mixed with taste, such as style, rhythm or dialogue ratio.
It may be the author's intent, so it is better to ask the user whether to fix it.

**The tool can be wrong.** If what the checker caught is actually a twist the author intended,
say so and get the user's judgment. Don't ruin the prose to beat the tool.

**If a setting has to change, fix the file, not the prose.** If a character's established setting really
has to change, the right move is to edit `characters/<id>.md` directly. Those files are
Markdown so people can read and edit them, and the tool respects hand edits.

**Empty answers don't finish the run.** Calling `lore_resume` with no answers returns the same requests again, so
never retry with empty answers. If you can't produce model answers, stop and tell the user: the `deterministicResult` in
the `needs_model` response is the only output, and for `lore_write` it only identifies the paused workflow
(`preview`, `workflowId`, `chapter`) and holds no findings; the workflow stays paused in `awaiting_model` until the requests are answered.
Deterministic findings alone need `lore_check(deterministicOnly=true)` on the advanced surface.
