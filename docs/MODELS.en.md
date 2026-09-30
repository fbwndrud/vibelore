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

## Which path draws the webtoon pictures?

The host draws the pictures on the path you choose. There are two kinds of path.

| Path | What it needs | Model |
|---|---|---|
| Host built-in image tool | Access to that host. No separate key or billing | The host decides. If the tool takes a model argument, you choose among those |
| Image API | An API key in the execution environment (e.g. `OPENAI_API_KEY`), account permission and separate billing | The models that account can use |

When the first scene starts, the AI first checks and reports the paths and models it can really use on this host.
vibelore keeps no per-host model list of its own and shows you every option reported.
If there is a built-in tool, that path is proposed first; among API models, `gpt-image-2.5-sunburst` is proposed when it is offered.
Your answer is saved as the choice for the work and used for the next scenes and chapters of that work.

What was checked on Codex CLI 0.159.2:

- The built-in `image_gen` takes only `prompt`, reference image paths and whether the background is transparent, and has no model argument. Codex decides which model draws,
  and the C2PA signature of the output PNG says only `ChatGPT / gpt-image`.
- The API path runs through the CLI that comes with Codex's `imagegen` skill (`image_gen.py --model`) and needs `OPENAI_API_KEY`.
  You can choose `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`, `gpt-image-2` and others.

On a host without a built-in image tool, such as Claude Code, only the API path appears. Image models from other providers such as Gemini
can be chosen the same way if the host reports the path, but we haven't checked this ourselves.

> Check which drawing paths and models this host can use and show them to me. Tell me too whether there is a separate cost.

> From now on, draw this work with the API.

When you ask for a change as in the second example, the options are shown again and only the choice you confirm is saved.

Every automatic redesign and every redraw you ask for is a new image call. The built-in path uses the host's usage and the API path
bills that account. The vibelore server manages drawing requests, references, imports and reviews, and never generates images itself.
When a path can't run or a limit is exceeded, it does not switch to another path or model automatically. Each imported picture records
the chosen path and model, plus the model information the host actually saw, as they are.

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

For requests that need to see pictures, such as webtoon image review, the picture files are attached as images to the last user message.
Whether a model can see pictures depends on the model; if it can't, the error that endpoint returns is shown as it is.

The current adapter does not support authentication. Use it only with a trusted local endpoint,
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
