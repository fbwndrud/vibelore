# vibelore's direction and philosophy

[한국어](PHILOSOPHY.md) | English

## In one sentence

vibelore is not a set of rules that writes the novel for you. It is **a writing foundation that first agrees on the reading experience
the user wants, keeps the AI's creative ability alive, and takes responsibility for the memory, causality, consistency, approval and recovery
that easily break down in a long work**.

## What we want to build

A good result is not a manuscript with lots of settings or a high check score. It is a manuscript where readers understand the situation
without effort, find the characters' choices convincing, want to read the next chapter, and feel it is the same work
even after many chapters.

vibelore aims for the following.

1. **Settle the reading contract first.** Instead of taking only a genre name, it agrees on pace, difficulty, emotion, reward, taboos and allowed range as a StoryProfile.
2. **Separate depth from difficulty.** A deep theme can still read easily. The default is easy sentences and step-by-step introduction of concepts, with complexity raised only in the scenes that need it.
3. **Causality beats decoration.** Rather than adding special settings, it makes actions, reactions and consequences connect.
4. **Build characters by accumulation, not explanation.** It doesn't repeat a personality sheet; choices, costs and relationship changes carry into the next chapter and the next arc.
5. **Leave room for the AI's judgment.** Preferences and style are not fixed as detailed prohibition lists. It gives per-work positive examples and higher-level promises and lets the model solve the scene.
6. **The human has final authority.** The Markdown manuscript is canon, and a soft advisory is not an order to revise automatically.
7. **Work can continue after a failure.** Interrupted generation resumes, only checked prose is committed, and a snapshot can restore it.

## Boundaries of responsibility

| Party | Responsibility |
|---|---|
| User | The reading experience they want, important preferences, final approval |
| Host AI | Judging ideas, building scenes, generating dialogue and prose, semantic critique |
| vibelore MCP | Passing on approved preferences, canon and plans, guaranteeing order, conflict checks, recording review evidence and provenance, accumulating state, commit and recovery |
| Markdown canon | The final facts of the world, characters, prose and summaries |

Deterministic code is not made to judge literary taste, and the AI is not allowed to skip canon conflicts or the commit order
on its own. Each party does what it is good at.

## Design principles

### Small interface, deep module

By default the user calls `lore_write`. Inside, planning, context assembly, draft,
checks, limited revision, receipts, approval and commit follow one another. Handling a lot of complexity behind a small
interface like this is what we call a **deep module**.

Exposing every internal step would give more freedom to call, but it would push wrong orders and state branches onto the
user. So the default surface shows only 30 complete tools, webtoon production included, and the per-stage primitive tools
live on the `advanced` surface.

### Firm higher promises, thin per-chapter choices

```text
StoryProfile  what experience the reader gets
StorySpine    where the whole work moves
WriterSkill   what prose delivers that experience
ArcPlan       what changes over the next few chapters
EpisodePlan   what this chapter's pressure and turn are
Prose         how the characters resolve it in the actual scene
```

The higher up, the longer the promise lasts; the lower down, the larger the model's on-the-spot judgment. A per-chapter plan
does not write sentences and jokes in advance, and the StoryProfile is not reinterpreted every chapter.

### Don't mix hard and soft

- **hard invariant**: problems that must be stopped, such as a conflict with established facts, a hash mismatch of the checked prose, or a wrong commit order.
- **soft advisory**: observations that may be the author's intent, such as style, density, emotional pacing or possible repetition.

Hard violations are fixed. Soft findings are shown with their evidence but are not used as a reason for automatic rewriting.
A manuscript is not passed on a single average score, and serious individual problems are looked at separately.

A high score does not erase individual findings. A failed review is recorded distinctly from a good evaluation,
and the manuscript is kept and returned to the user's judgment. Conditional automatic style rewriting is not introduced at present.

### Examples belong to the work

The same prohibited phrasing is not applied to a whole genre. Character voice examples belong to the character, examples of an arc's
relationship change belong to the arc, and the work's style reference belongs to the approved StyleAnchor. These pieces of information do not
intrude on each other's roles.

Approved preferences have to reach the actual writing request. The chosen style examples and the reasons for exclusion are recorded,
and they are passed to the next writing without the user repeating the same preference every chapter. This does not guarantee that the first manuscript
is enjoyable or make later preference feedback unnecessary.

### Leave the evidence and limits of evaluation together

A self-review by the same host is not called an independent reader evaluation. A record linking the manuscript and contract hashes to the actual requests and answers
is evidence of what was evaluated, not proof that the evaluator read carefully.
Passing a program check is also distinguished from improving reader satisfaction.

## What it does not do

- It does not build its own novel generation model to replace the AI.
- It does not unify every genre under one style or difficulty.
- It does not treat the amount of settings, the number of technical terms or the number of twists as a work's depth.
- It does not promote all preference feedback into permanent hard rules.
- It does not turn a character's future narrative into a fixed biography from the start.
- It does not keep real novels used for internal evaluation, generated manuscripts or one-off experiment outputs in the product repository.
- It does not expose unverified experimental features on the default MCP surface.

## Criteria for adding a feature

A new feature has to pass these questions.

1. Is it a problem that recurs across several genres and works?
2. Does it give the model better context, or does it restrict its choices too much?
3. Can it be solved inside an existing module?
4. Is a new tool the user has to know about really needed?
5. If it fails, can it be rolled back without damaging the canon?
6. Can it be verified with synthetic fixtures and product tests?

If it is a matter of taste in one particular manuscript, solve it first in the StoryProfile, WriterSkill, ArcPlan or StyleAnchor.
Only when the same structural failure is confirmed across several works is it raised to a universal rule of the engine.

## Success criteria

vibelore's success is judged not by the number of features but by these results.

- A first-time reader is not left out of the dialogue and world information.
- Characters' authority, relationships, choices and consequences connect naturally.
- The work keeps the reading difficulty and information pace it asked for.
- A character's past changes remain in their present actions, and the next arc inherits those results.
- Point of view, style and narrative density don't change suddenly across many generated chapters.
- The canon and internal state can be recovered after interruptions, hand edits and rewrites.

The concrete flow is in [ARCHITECTURE.en.md](ARCHITECTURE.en.md), and the actual tool contracts are in
[TOOLS.en.md](TOOLS.en.md).
