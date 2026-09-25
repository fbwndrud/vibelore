# Making a webtoon from an existing novel

[한국어](WEBTOON.md) | English

This turns a novel written with vibelore into **webtoon scenes**. Character looks, the world, and the situation up to that chapter
are taken straight from the source. The novel manuscript is left untouched and the webtoon is saved separately.

You don't need to write tool calls yourself. Just talk to the AI as in the examples below.

## What you need

- **vibelore connected:** install it as in [Getting started](GETTING_STARTED.en.md) and check that the tools are visible.
- **The source:** a work written with vibelore and the chapter to adapt. For a novel written elsewhere, first do
  [Continue a novel you already wrote](GETTING_STARTED.en.md#5-continue-a-novel-you-already-wrote).
- **An AI that can open images:** the host must call the image API and be able to open the images it made to review them.
  Connecting vibelore does not add a drawing capability.
- **The OpenAI image API:** the host draws with one of the OpenAI image models `gpt-image-2`, `gpt-image-2.5-sunburst` (default)
  and `gpt-image-2.5-flare`, called through the API. The AI tool's built-in image feature is not used on this path.
  The API needs its own key and billing. Don't paste the key into the chat; set it in the execution environment.
- **Reference art:** at least one character or background reference image file (PNG/JPEG) inside the work folder.

The finished result is one PNG/JPEG image per scene with the dialogue drawn in, plus `scene.html` that shows it.
A page format such as one tall vertical image is set in the direction. Splitting it for platform upload is a separate job.
The manuscript and images stay on your computer, but material needed to make and review the images can be
sent to the connected AI service. See [Data and security](../SECURITY.md).

## How to ask

> Make chapter 1 into a webtoon. Read the source settings, and ask me about the adaptation direction, art style and lettering first. Draw each whole scene as one image, dialogue included.

If you have several works, mention the work folder or work name too. You can also combine several chapters into one episode,
as in "source chapters 1-2 into webtoon episode 1". Within one work, webtoon episodes are made one at a time.

If the interview skill wasn't loaded, add this line.

> Read `skills/webtoon-discovery-interview/SKILL.md` in the vibelore install folder and follow that procedure.

## Two production methods

| | Whole scene (default) | Per panel (deprecated) |
|---|---|---|
| Unit of drawing | One scene in one image, dialogue included | One panel at a time |
| Rough check | None | Yes. The final art starts only after approval |
| Lettering | Drawn inside the image. Changing it means redrawing | Placed on top of the image. Easy to change just the wording |
| When it fits | When you want to see a chapter quickly | When you want to direct each shot |

New work is made only with the whole-scene method. The per-panel method is used only to finish work already in progress
and cannot be started anew. The [showcase](https://fbwndrud.github.io/vibelore/showcase/) works were also made
with the whole-scene method.

## What you decide at the start

Character names, relationships and world rules come from the source. The interview decides only **what to emphasize and how to
show it**.

| What you decide | Example answer |
|---|---|
| The source range and the core of the adaptation | "The opening of chapter 1; the strangeness of coming back is the center. Cut exposition, but keep the motive of looking for his daughter." |
| Art style | "Vivid color, natural anatomy, slightly exaggerated expressions." |
| Lettering, page format and layout freedom | "Inner thoughts in light boxes, actual speech in balloons. Draw it as one tall vertical image." |
| Reference art | "Use `refs/hero.png` for the character and `refs/street.png` for the street." |
| Panel count | "Use auto." |
| Image model and cost | "Use the default model; I know every redraw costs money." |

Lettering, page format and layout freedom are not separate menu choices; they go into the English direction (`direction`).
When the AI shows your answers summed up in English, check that they mean what you meant.

Even if you say "just go ahead", the panel count and the image model and its cost are confirmed with you. The image model is kept
once chosen, for this work's later scenes and episodes too, and when it can't run it is not secretly switched to another model.
Reference art is named each time a scene starts.

## Whole scene: one image, dialogue included

The source paragraph range is split into scenes, and each scene goes through direction → pre-generation check → image → review of the actual
image. The image model chosen earlier is reused, and the drawing follows the character and background reference art you name.

> Draw the first scene of chapter 1 as one image. Use auto for the panel count, and if there is a previous scene, review it as a continuation.

At the start you are asked for the **panel count**. Choose from `4, 6, 8, 9, auto`, or give a number from 1 to 12.

- A number fixes that panel count. If the image has a different number of panels, it doesn't count as done.
- `auto` lets the AI choose 3 to 12 panels for each scene.
- 1-2 panels are allowed, but the sense of continuity with the scenes around it can weaken. 3 or more are recommended.

Panel sizes and layout are left to the image model. If you name the previous scene, the two images are reviewed side by side
for continuity of characters, background and action. If the pre-generation check or the image review fails, the AI re-plans from
the faults and redraws (2 times by default, at most 3, and each one costs an image call). If it still fails, you are shown the result
and the evidence and asked how to fix it. There is no separate approval step; a scene that passes the review is done.

## Per panel (deprecated): what you check at each step

This applies only to per-panel work already in progress. New work is made with the whole-scene method above.

| Step | What you see | What to check |
|---|---|---|
| 1. Direction | Settings taken from the source and the interview summary | Is it the mood, art style and adaptation range you want? |
| 2. Adaptation | Scenes kept, panel order, actual dialogue | Does the story hold together without reading the novel? |
| 3. Reference art | Art of this episode's characters, costumes and places | Do they look like the same characters? |
| 4. Rough | Simple sketches of only characters, props and movement | Is it clear who does what where, and does it flow naturally into the next panel? |
| 5. Art and lettering | A review copy with dialogue, monologue and sound effects on the finished art | Are action, gaze, balloon tails and reading order natural? |
| 6. Final | SVG and HTML with every panel | Are you happy with the flow of the whole episode? |

If there's a problem, say how to fix it at that step. Approving an earlier step does not approve the final.
The rough is the step for **layout and action**, not faces or coloring.

The panel count depends on how much of the source is trimmed. The default 40 panels is only a cap, not an amount to fill.

## Art and lettering

**Continuing scenes refer to the previous image.** When linked to the previous scene, that reviewed image is
looked at together, and continuity of characters, background and action is checked before drawing. The per-panel method (deprecated) starts action panels
that need a new composition from the rough and the reference art. For the detailed structure, see
[Architecture](ARCHITECTURE.en.md#webtoon-production-structure).

On the whole-scene method, dialogue, inner thoughts, sound effects and sign text are all drawn inside the image by the image model.
Dialogue is not translated; it goes in as the original text in the work language. The AI opens the actual image to check the text
and who is speaking. Fixing even one word means redrawing the scene, which is a new image cost.

### Lettering on the per-panel method (deprecated)

| Kind of text | How it is made | How to fix it |
|---|---|---|
| Dialogue | A speaker is set and a balloon is placed on the art | Ask to change the wording or the balloon position |
| Inner thoughts and narration | A box, or unboxed text, distinct from dialogue | Ask to change the wording or how it's shown |
| Sound effects | Placed separately where the sound happens | Ask to change position, size or emphasis |
| Text on signs, monitors and documents | Generated as part of the image | Ask to fix the wrong part of the image |

Balloon overlap and text size are checked by code. Who is speaking and whether the action is natural need the AI's image
review and your check. Passing the checks does not mean there are no staging problems at all.

## Where is the finished result?

The result of a whole-scene job stays in the work folder under `.vibelore/webtoon/candidates/<workflowId>/r<revision>/`
as the scene image (PNG/JPEG), `scene.html`, and the plan and review JSON. Nothing is written to the `webtoon/` folder. `<revision>` goes up with each redesign or retry,
and `<workflowId>` is different for each job.

```text
my-novel/
├── chapters/                    source novel — never overwritten by webtoon production
└── .vibelore/
    └── webtoon/candidates/<workflowId>/r<revision>/
        ├── scene.png             scene image with the dialogue drawn in (scene.jpg for JPEG)
        ├── scene.html            page showing the scene image and the review evidence
        ├── scene-plan.json       scene adaptation plan
        └── image-review.json     review of the actual image
```

The per-panel method (deprecated) saves to `webtoon/episodes/<episode>-<workflowId>/` once adaptation and approval are done, as
`episode.html`, `episode.svg`, `editorial.md`, `script.md` and `lettering.json`.

> Check the progress of webtoon episode 1, and open the finished scene HTML.

What you see during review is the same candidate file. The scene text is inside the image, so say what to fix and have it redrawn.
On the per-panel method, don't edit the text in the SVG or HTML directly either; ask for a script change and regeneration. Nothing is uploaded to an external service automatically.

## Fix or continue

For an episode in progress, just say **what to change**.

For a whole-scene job, say something like "fix the problems the review observed in this scene (panel count, lettering, continuity) and redraw it",
and it adapts, checks and generates again from that feedback (each time is a new image cost). The automatic redesign budget is
spent only on failed checks and reviews.

For the per-panel method (deprecated), ask with the scope separated like this.

- Adaptation: "I don't get why he walks toward the enemy right after telling them to run. Rework the actions and lines around it."
- Rough: "In these three panels, fix the composition so the character's direction of movement and the monster's position connect."
- Art: "Fix only the hand and the grip on the weapon in this panel, and keep the character design."
- Lettering layout: "Leave the art and dialogue as they are, and move the balloons so they don't cover faces."

Which steps are reviewed again depends on the scope of the change. Unchanged panels are reused, but when an earlier
image or composition they refer to changes, the related panels are looked at again too. Asking first how much will be redrawn saves unnecessary image
cost.

If it stopped midway:

> Check the **webtoon** work in progress and continue from the remaining steps. Don't create a new job.

To start the next episode:

> Check that the webtoon episode 1 scene finished its review (completed), then start webtoon episode 2 from source chapter 2. Reuse the existing art style and reference art.

Adapting a finished episode again creates a new job while keeping the earlier result. Editing the source later
does not automatically change the source of a webtoon in production. To remake it from the new source, ask for
that.

If something goes wrong see [Troubleshooting and backups](TROUBLESHOOTING.en.md); if you integrate MCP directly, see
the [webtoon execution contract](reference/WEBTOON_WORKFLOW.en.md).
