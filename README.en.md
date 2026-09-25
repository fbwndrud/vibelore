# vibelore

[한국어](README.md) | English | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md) | [繁體中文](README.zh-Hant.md) | [ไทย](README.th.md) | [العربية](README.ar.md)

**A local tool for writing web novels with AI and turning them into webtoons. The lore holds up even after hundreds of chapters.**

*Write serial fiction with your AI coding agent, keep the lore consistent for hundreds of chapters, then adapt it into webtoon scenes. Local, Markdown, no extra API keys for writing.*

[![Node](https://img.shields.io/badge/node-22.13%2B%20%7C%2024%20%7C%2026-brightgreen)](docs/GETTING_STARTED.en.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Grok-black)](HOSTS.en.md)
[![Showcase](https://img.shields.io/badge/showcase-3%20works-orange)](https://fbwndrud.github.io/vibelore/showcase/)

You attach it as an MCP server to an AI coding tool such as Claude Code, Codex or Grok CLI. That AI writes the prose and draws the pictures;
vibelore remembers the world, characters, foreshadowing and timeline, checks every chapter, and finalizes nothing before you approve it.

<table>
<tr>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/executionprincess/"><img src="docs/showcase/executionprincess/img/ep01-s9.webp" width="260" alt="The Princess One Minute Before Her Execution, chapter 1, scene 9"></a><br><sub><i>The Princess One Minute Before Her Execution</i> · romance fantasy regression revenge</sub></td>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/verdict-live/"><img src="docs/showcase/verdict-live/img/ep01-s6.webp" width="260" alt="Verdict LIVE, chapter 1, scene 6"></a><br><sub><i>Verdict LIVE</i> · cyber-wrecker thriller</sub></td>
<td align="center"><a href="https://fbwndrud.github.io/vibelore/showcase/thundertrail/"><img src="docs/showcase/thundertrail/img/ep01-s1.webp" width="260" alt="Lightning on the Road, chapter 1, scene 1"></a><br><sub><i>Lightning on the Road</i> · fantasy road action</sub></td>
</tr>
</table>

These are all real results of adapting novels written with vibelore into webtoons. A different AI made each work.

- **[The Princess One Minute Before Her Execution](https://fbwndrud.github.io/vibelore/showcase/executionprincess/)**: GPT-6 Sol handled everything from the design to the novel and the webtoon adaptation.
- **[Verdict LIVE](https://fbwndrud.github.io/vibelore/showcase/verdict-live/)**: Claude Opus 5.5 wrote the novel and the webtoon adaptation, and Codex drew the pictures.
- **[Lightning on the Road](https://fbwndrud.github.io/vibelore/showcase/thundertrail/)**: Codex, Claude and Grok each adapted the same novel. There is also a [model comparison](https://fbwndrud.github.io/vibelore/showcase/thundertrail/compare.html).

We didn't pick only the scenes that came out well. Scenes that failed review, the prompts and even the costs are all visible in the [work list](https://fbwndrud.github.io/vibelore/showcase/). The showcase works and site are in Korean.

---

## If you just hand a long novel to an AI

**❌ Without vibelore**

- Around chapter 10, forms of address change, dead characters speak again, and ability rules quietly shift.
- Both you and the AI forget the foreshadowing planted in chapter 3.
- When the session breaks, you start by pasting "the story so far" again.
- To turn it into a webtoon, you explain panel layout, character looks and dialogue placement from scratch every time.

**✅ With vibelore**

- The world, characters and prose stay as a Markdown canon, and every chapter's draft is checked against it: **hard violations are fixed, soft violations are asked about.**
- Planning goes whole work → arc → chapter, and only what you approve becomes a constraint on the next chapter.
- Interrupted work resumes where it stopped, only manuscripts that pass the checks are committed, and you can roll back chapter by chapter.
- The work language is set with a single `language` argument, and languages other than Korean use the same flow.
- A webtoon production flow comes along: it takes the characters and state from the source as they are, settles the source range, art style, reference art, panel count and image model, then generates each scene as one image, dialogue included.

## 30-second demo

Say this in the host's chat.

> Write the next chapter. Show it to me when you're done, and finalize it when I approve.

```text
Interview ─▶ Work design ─▶ Arc plan ─▶ Chapter plan ─▶ Draft ─▶ Setting/timeline/language check ─▶ Review ─▶ Approval ─▶ Commit
 (once)       (approve)      (approve)   (auto)                   hard violations fixed              advisory  user        Markdown
```

Work design covers generating the world and characters, then approving the whole story (StorySpine) and the
work's own writer skill (WriterSkill); writing starts only after it. The work-language check applies to every work, Korean works included.

When the manuscript and the review evidence arrive, answer "approve" or "fix this part and try again". `auto` mode commits
automatically once the mandatory checks pass and the review completes. Advisory review findings are recorded but don't block the
commit, and if the review doesn't finish, the draft goes back to waiting for approval. A webtoon also takes one sentence.

> Make chapter 1 into a webtoon. Ask me about the production direction first.

```text
Range·style·references·panels·image model ─▶ Scene direction ─▶ Pre-generation check ─▶ Scene image with dialogue ─▶ Image review
 (your choices)                               (English)          hard block              work language, verbatim      fail: auto re-plan
```

The panel count is an integer (1-12) or `auto`, and the reference art is character and background image files you supply.
The image model is one of the OpenAI API models `gpt-image-2`, `gpt-image-2.5-sunburst` (default) and `gpt-image-2.5-flare`,
and the host calls it. If the pre-generation check or the image review fails, it re-plans from the findings and generates
again (2 times by default, at most 3, and each one is a paid image call). The result is the scene image plus `scene.html`
under `.vibelore/webtoon/candidates/`.

## Installation

Give the repository address to the AI coding tool you use (Claude Code, Codex, Grok CLI) and ask.

> Clone https://github.com/fbwndrud/vibelore and register it as an MCP server.

All you need is Node.js 22.13 or later (22.x), 24.x or 26.x. There is no build and no dependency install.
When registration is done, restart the AI tool once.

<details>
<summary>To register with npm</summary>

Run the MCP server from the npm package [`vibelore`](https://www.npmjs.com/package/vibelore) without cloning the repository.

```bash
claude mcp add-json vibelore '{"command":"npx","args":["-y","vibelore"]}' --scope project
```

For Codex use `command = "npx"`, `args = ["-y", "vibelore"]`; for Grok CLI use `grok mcp add vibelore -- npx -y vibelore`.
On Windows, put `cmd /c` in front of `npx` (`"command":"cmd","args":["/c","npx","-y","vibelore"]`).
To pin a particular version, write `vibelore@<version>`. The npm path registers only the MCP server, so install the interview skills
with the repository method below or the Codex plugin.
</details>

<details>
<summary>To clone the repository and register it yourself</summary>

```bash
git clone https://github.com/fbwndrud/vibelore.git
```

Claude Code:

```bash
claude mcp add-json vibelore '{"command":"node","args":["/absolute/path/to/vibelore/src/server.js"]}' --scope project
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.vibelore]
command = "node"
args = ["/absolute/path/to/vibelore/src/server.js"]
startup_timeout_sec = 30
tool_timeout_sec = 6000
```

Grok CLI:

```bash
grok mcp add vibelore -- node /absolute/path/to/vibelore/src/server.js
```

For Claude Code, the writing-loop skill is in `hosts/claude/skills/novel/`, and the story and webtoon interview skills are in `skills/story-discovery-interview/` and `skills/webtoon-discovery-interview/`. Copy all of them under `.claude/skills/`. This repository can also be installed as a Codex plugin (`.codex-plugin/plugin.json`).
</details>

Once installed, start your first work. Describe the story you want to write in a sentence or two.

> I want to start a new novel. It's about a late-night bus driver who listens to passengers' regrets. Start with the story interview.

The interview asks only about preferences that change the result, 4-5 at a time. To skip it, say "decide automatically
without asking". If you get stuck, see [Getting started](docs/GETTING_STARTED.en.md).

## What it does

- **Story interview.** Instead of a genre name, it asks about pace, difficulty, emotion, reward and taboos to build a reading contract (StoryProfile), then generates the world and characters automatically.
- **Arc design.** It gets approval first for a 3-20 chapter promise and thin events, pressures and turns, and fills in the per-chapter plans automatically at writing time.
- **Checks and revision every chapter.** It compares the draft against characters, forms of address, point of view, timeline and foreshadowing, and when it conflicts with established facts, revises and re-checks automatically (at most 3 checks, with at most 2 revisions between them). Taste comments such as style or rhythm stay advisory only.
- **Style reference.** Mark a chapter you like as the style anchor, and later chapters follow its texture.
- **Rollbacks.** Roll the whole work back to a given chapter and write again from the next one (the state before the rollback is kept so it can be restored).
- **Webtoon adaptation.** It takes the source state, confirms the source range, art style, reference art, panel count and image model, then finishes each scene as one image, dialogue included.

**What it doesn't do.** A web GUI (the host chat is the interface), paid API calls by the MCP server itself (the host runs image APIs),
rewriting an earlier chapter or recomputing the later state with the default tools (only the recovery tools `lore_rewrite` and
`lore_refold` on `VIBELORE_MCP_SURFACE=advanced` do that), guarantees of literary quality,
concurrent editing or multi-tenancy, and automatic splitting into PNG/JPEG for platforms.

## Common tasks

| What you want | Say this to the host |
|---|---|
| I don't like the last chapter | Edit the manuscript by hand, then "Check the changes" → check → approve |
| I wrote up to chapter 3 but want to redo it from chapter 2 | "Roll back to chapter 1" → "Write the next chapter" |
| I want to roll everything back to chapter 5 | "Roll back to chapter 5" |
| This chapter's style is just right; keep it like this | "Approve chapter 3 as the style reference. Reason: the dialogue is short and dry" |
| I edited a story-setting file by hand | "Check the changes" → it tells you the scope of impact and what to do next |
| I want to see why it was written this way | "Show me the review evidence and the actual writing request for this chapter" |
| I want to turn an existing novel into a webtoon | "Adapt chapter 1 into a webtoon. Ask me about the production direction first" |
| I want to redraw a webtoon scene | "Redraw this scene of chapter 1 [like this]" |

For revisions, resuming and backups, see [Troubleshooting and backups](docs/TROUBLESHOOTING.en.md).

## How a webtoon is made

<table>
<tr>
<td><img src="docs/showcase/thundertrail/img/ep01-s4.webp" width="180" alt="Lightning on the Road, chapter 1, scene 4"></td>
<td><img src="docs/showcase/thundertrail/img/ep02-s6.webp" width="180" alt="Lightning on the Road, chapter 2, scene 6"></td>
<td valign="top">

It turns a novel you already wrote into a webtoon as it is. Character looks, the world and the situation up to that chapter come from the source, so there is nothing to explain again.

1. **Source range and direction.** It asks which chapter and paragraphs to adapt, the art style, the lettering and how much layout freedom to give, and sums it up as English direction for you to confirm.
2. **Reference art.** You point to character and background reference image files (at least one). A continuing scene also uses the finished image of the scene before it.
3. **Panel count and image model.** You choose the panel count (1-12 or auto) and the image model and its cost. The model choice is kept per work.
4. **Finish.** Scene direction → pre-generation check → one scene image with the dialogue drawn in → review of the actual image. If it fails, it re-plans and draws again automatically (2 times by default, at most 3). The production examples above were made this way.

The method of approving per-panel roughs first is deprecated and only continues work already in progress.
</td>
</tr>
</table>

The pictures are drawn by the OpenAI image model you choose (`gpt-image-2`, `gpt-image-2.5-sunburst` (default) or `gpt-image-2.5-flare`), which the host calls through the API. It needs its own API key and billing; before the first scene you are shown the model, the cost and what gets sent, and your answer fixes the choice for the work. Webtoon results are stored apart from the novel canon and never change the novel.
For the detailed steps, see the [webtoon production guide](docs/WEBTOON.en.md).

## Why vibelore

It is not a tool that writes the novel for you from a set of rules. It first agrees on the reading experience, keeps the AI's creative ability alive,
and takes responsibility only for the memory, causality, consistency, approval and recovery that easily break down in a long work.

- **The reading contract comes first.** Not a genre name but pace, difficulty, emotion, reward and taboos are settled, and that promise is kept every chapter.
- **Causality beats decoration.** Rather than adding more setting details, it makes actions, reactions and consequences connect, and builds characters from accumulated choices, not explanation.
- **The human has final authority.** The Markdown manuscript is canon, and an advisory is not an order to revise automatically.

| Party | Responsibility |
|---|---|
| User | The reading experience they want, important preferences, final approval |
| Host AI | Judging ideas, building scenes, generating prose, dialogue and images, semantic critique |
| vibelore | Passing on canon and plans, guaranteeing order, conflict checks, recording review evidence, commit and recovery |
| Markdown canon | The final facts of the world, characters, prose and summaries |

For the overall direction see the [philosophy](docs/PHILOSOPHY.en.md); for the structure see the [architecture](docs/ARCHITECTURE.en.md).

## Supported genres

There are 25 genre presets, and each preset tracks different setting items (timeline, regression knowledge, relationship state, power
system, etc.).

`Regression hunter` `Villainess isekai` `Academy fantasy` `Noble-house regression` `Exile revenge` `Mystery thriller` `Action`
`Comedy` `Historical` `LitRPG` `Streaming LitRPG` `Progression` `System apocalypse` `Tower climbing` `Isekai`
`Cultivation` `Xianxia` `Xuanhuan` `Dungeon core` `Romance fantasy` `SF` `Horror` `Cozy healing` `Modern urban` `Other`

Genres not on the list and mixed genres work too. The interview breaks the genre down into tone, subgenre and story engine to make
the work profile, and the setting check uses the closest preset.

## Work language

The language a work is written in is set with the optional `language` argument accepted by `lore_profile`, `lore_init`
and `lore_create` (the `language` of `lore_write` only confirms that it matches the stored language). When the user states the writing language in natural language, the host normalizes it into a BCP 47
tag (`ja`, `pt-BR`, `zh-Hant`, etc.) and passes it on; if no language is chosen, the argument is omitted.
Existing works without a language key are an implicit `ko`. The conversation language and the work language are independent, so you can
write a Japanese work while talking in Korean.

> I want to create a work called `harbor_summer` in `/absolute/path/to/my-novel`. Write the prose in Spanish.

- There are two prompt families. `ko` uses Korean-specific instructions, and every other language (including English) uses a family that
  combines the shared English instructions with the target language. The prose, titles, summaries, world and character descriptions, and descriptive
  values in plans and reviews follow the target language, while machine-read values such as JSON keys, enums and IDs are not translated.
- Length is measured in a unit that fits the language. Korean uses the existing character count; other languages use graphemes
  or words, and writing systems with many combining characters such as Arabic and Hebrew, as well as Thai, which has no spaces between words,
  are handled within the same contract.
- Before the foundation exists, you can change the language by approving a new profile revision, and a value that differs from the
  approved language is rejected with `LANGUAGE_CONTRACT_CONFLICT`. After the foundation is created, it can't be changed, and a different
  value is rejected with `WORK_LANGUAGE_IMMUTABLE` instead of silently overwriting it.
- Every chapter is checked to confirm the prose, summary and plan were written in the work language, and semantic invariants such as
  point of view, character registration and world settings are examined by the same checker regardless of language.
- Webtoons follow the work language too. Dialogue is not translated; it goes into the image as the original text in the work language,
  and the image prompt states the language, script and reading direction (right to left for Arabic).

Novel writing and the scene webtoon flow were checked with an acceptance sample in 8 languages: English, Spanish, Japanese, French,
Korean, Arabic, Traditional Chinese and Thai. The host model in that sample was Claude Sonnet 5. For the details of the argument
contract, see [Work language and length units](docs/TOOLS.en.md#work-language-and-length-units).

## Where the files are

```text
my-novel/
├── world/         world settings — you may edit these
├── characters/    character settings — you may edit these
├── chapters/      prose — you may edit these
├── summaries/     per-chapter summaries
├── webtoon/       approved results and SVG/HTML masters of deprecated per-panel work
└── .vibelore/     check records, recovery snapshots, webtoon scene results (webtoon/candidates/) — don't touch
```

Manuscripts and production records stay on your computer. The manuscript and reference images needed for a request may be sent
to the connected host and model service. The boundaries are in the [security guide](SECURITY.md).
The copyright of the manuscript belongs to its author, and this repository's license does not apply to it.

## Models and cost

- **The novel** is written by whatever model you chose in the host session. There is no separate API key. You can give per-stage hints that hand the planning, draft and review stages to a lighter model (in host relay they are hints; only a local model actually switches); the stages that extract established facts stay on the base model unless you set them.
- **Webtoon images** come from the OpenAI image API (`gpt-image-2`, `gpt-image-2.5-sunburst` (default), `gpt-image-2.5-flare`), called by the host, with its own key and billing. The confirmed model is saved per work and never changed or substituted arbitrarily.
- **Local text models** can be connected through environment variables to an OpenAI-compatible endpoint.

For detailed settings, see [Model settings](docs/MODELS.en.md).

## FAQ

<details>
<summary>Is there a GUI?</summary>

No. The chat of Claude Code, Codex or Grok CLI is the interface, and the results come out as Markdown manuscripts and, for webtoons, one PNG/JPEG image per scene (lettering included) plus `scene.html`.
</details>

<details>
<summary>Does it cost extra?</summary>

Novel writing runs within the host's subscription or credits. By default vibelore doesn't call a model directly (unless you connect a local model). Webtoon images come from the OpenAI image API, called by the host, and follow that account's billing.
</details>

<details>
<summary>If it stops midway, do I start over?</summary>

No. Workflows are saved, so "continue" resumes from the same point. Only manuscripts that pass the checks are committed, and per-chapter snapshots let you roll back. See [Troubleshooting](docs/TROUBLESHOOTING.en.md#work-stopped-midway).
</details>

<details>
<summary>Can I edit the story setting or prose by hand?</summary>

Yes. `world/`, `characters/` and `chapters/` are there for people to edit. After editing, say "check the changes" and it tells you the scope of impact and what to do next.
</details>

<details>
<summary>What if what the checker caught is actually a twist I intended?</summary>

A hard violation is a conflict with established facts, so it gets fixed; if it really is a twist, change the setting file first. A soft violation may be the author's intent, so the AI doesn't fix it automatically and asks you.
</details>

<details>
<summary>Can I write in languages other than Korean?</summary>

Yes. The writing language is set when the work is created (in the profile or with `lore_create`/`lore_init`), and the interview is held in the language you use. The guides have Korean originals and English versions (`*.en.md`). See [Work language](#work-language) above.
</details>

## Further reading

- [Getting started](docs/GETTING_STARTED.en.md) — registration, first work, next chapter, when you get stuck
- [Webtoon production](docs/WEBTOON.en.md) — source range and required choices, whole-scene production and review
- [Troubleshooting and backups](docs/TROUBLESHOOTING.en.md) — resuming work, hand edits, rollbacks, keeping files
- [Model settings](docs/MODELS.en.md) — choosing text and image models, cost paths, local models
- [Tool reference](docs/TOOLS.en.md) — the full contract of the tools the host calls
- [Architecture](docs/ARCHITECTURE.en.md) — novel and webtoon production structure, the roles of the AI and the server, storage boundaries
- [All documents](docs/README.en.md) · [Per-host verification records](HOSTS.en.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

Apache-2.0. The rights to manuscripts and images belong to the people who made them.
