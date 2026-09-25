# Model settings

[한국어](MODELS.md) | English

The **text model** that writes the novel and the **image model** that draws the webtoon are chosen separately.
Installing vibelore does not add access to any particular model or an image generation capability.

## Which model writes the novel?

By default, the current model of the connected AI app or CLI answers the planning, draft and review requests.
Choose the model and thinking level in that app or CLI. You do not need to give vibelore a
separate provider API key for normal novel writing.

> Write this work with the currently selected model. If the model execution has to change, tell me first.

vibelore's checks and approval steps stay the same whatever model you choose.
This document does not guarantee quality rankings or speed for any model.

## How is the webtoon image model chosen?

The default path (whole scene) uses only the OpenAI image API. The model is one of `gpt-image-2`, `gpt-image-2.5-sunburst` (default)
and `gpt-image-2.5-flare`. When the first scene starts, the AI shows the model, execution path, separate billing and what gets sent,
and your answer is saved as the choice for the work. The same choice is used for the next scenes and chapters of that work.

| Execution path | What it needs | Who runs it |
|---|---|---|
| OpenAI image API | A tool that can call the chosen model, `OPENAI_API_KEY` in the execution environment, account permission and consent to separate billing | The host AI's API execution environment |
| Host built-in image tool | Only for work already started on the per-panel path (deprecated) | The host AI |

Every automatic redesign and every redraw you ask for is a new image call and costs money.
The vibelore server manages image requests, references, imports and reviews, and never calls an API directly.
The server accepting a model name does not mean your account can actually use it.
Images are generated after the model and path are confirmed to be runnable. When a path can't run or a limit is exceeded,
it does not switch to another model or a paid path automatically.

> Check the image model to use for the webtoon and which execution paths are runnable. Explain first whether there is a separate cost, and keep my choice for this work.

For the actual production steps, see [Making a webtoon](WEBTOON.en.md).

## Optional: local text model

If you run a local model yourself, you can connect an OpenAI-compatible `/chat/completions` endpoint.
Set both environment variables **in the environment where the MCP server runs**.

```bash
VIBELORE_LOCAL_BASE_URL=http://127.0.0.1:11434/v1 \
VIBELORE_LOCAL_MODEL=your-installed-model \
node /absolute/path/to/vibelore/src/server.js
```

Replace `your-installed-model` with the actual ID of the model you installed. When both values are set, that endpoint is
used instead of the host's text answers. This is not an image generation setting.

The current adapter does not support authentication or passing a thinking level. Use it only with a trusted local endpoint,
and check first that the model's long-form and structured answers are suitable for the work.

## Advanced: per-stage model hints for writing

Normal use needs no setting here. If you integrate directly, you can record the model requested per stage with
`lore_write`'s `modelProfile`. A value is a model ID or `{ provider, modelId, reasoningEffort }`.

- `default`: the base model
- `light`: a lighter model applied to planning (`planning`), draft (`draft`) and advisory review (`review`)
- `identity`, `planning`, `draft`, `review`, `quality`, `final`: individual stages

`review` covers stages whose results stay advisory only, such as the coherence, editorial, character, reader-pull, arc and
profile-drift reviews. `quality` covers stages whose answers go into the canonical state or the next chapter's
constraints, such as state extraction, the semantic continuity check and the pattern ledger. `light` applies to `review` but
not to `quality`, so even with a lighter model set, the base model extracts the established facts.
To change `quality`, set it explicitly.

The model is chosen in this order: the explicit stage value → that stage's `light` → `default`.
This value is a **hint** passed to the host; it does not force the session model to switch.
The local adapter applies the model ID given with `provider: "local"` to the request.
The profile is kept when that writing work is resumed.

For argument examples see the [writing tool reference](TOOLS.en.md#lore_write); for actual host check records see
[HOSTS.en.md](../HOSTS.en.md).
