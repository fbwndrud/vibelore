# Lore Studio Google Interactions adapter contract

Verified against official Google documentation on 2026-10-09 (Asia/Seoul), before Task 6 implementation. This records the implemented surface, superseding legacy SDK-shaped examples for this adapter. All automated examples and browser QA used synthetic local HTTP fixtures; no paid Google call or speech-quality audition was performed.

## Surface and catalogue

The [image guide](https://ai.google.dev/gemini-api/docs/image-generation), [speech guide](https://ai.google.dev/gemini-api/docs/speech-generation), [structured-output guide](https://ai.google.dev/gemini-api/docs/structured-output), and [Interactions reference](https://ai.google.dev/api/interactions-api) describe `POST https://generativelanguage.googleapis.com/v1beta/interactions`, authenticated by a backend-only `x-goog-api-key` header. Studio pins that guide's v1beta surface, snake_case fields, `store: true`, and `stream: false`; it does not mix legacy `generateContent`/`candidates`/`inlineData` contracts.

The [model catalogue](https://ai.google.dev/gemini-api/docs/models) lists image IDs `gemini-nano-banana-2.1`, `gemini-3.1-flash-image`, and `gemini-3-pro-image`; TTS IDs `gemini-3.8-flash-tts` and `gemini-3.8-flash-lite-tts`; text ID `gemini-3.8-flash`. Catalogue presence does not establish account access, quota, region availability, quality, or a resolved immutable model version. The adapter reports those limitations.

## Requests and results

Image requests carry text and canonical PNG references in `input`, with `response_format: {type: 'image', aspect_ratio, image_size}`. The guide's Pro high-fidelity reference counts are inconsistent. Studio conservatively limits Pro to five references and other supported image models to fourteen total; this is application policy, not a resolution of Google's discrepancy. Output count and identity fidelity are not guaranteed. No native pixel-mask field, alpha guarantee, layer guarantee, or exact preservation guarantee was found. Protected-region editing therefore produces a separate locally derived composite with its own pixel evidence, not a Google native-mask claim.

Audio requests carry only the effective utterance's spoken text in `input[].content[].text`; acting direction is a `speech_metadata` annotation with `style`. `generation_config.speech_config` is an array containing the selected `voice`. Unary output requests `audio/wav` at 24,000 Hz. The documented WAV already has a RIFF header and must not receive a second PCM wrapper. Text annotation indices are not timestamps and never become word alignment. The [voices reference](https://ai.google.dev/api/voices) distinguishes prebuilt names from stored `voice_...` identifiers. Task 6 accepts those explicit identifiers only; it does not create, clone, list-account, or refresh voices outside a budgeted job. Stored-voice expiry and actual emitted voice identity remain unverified.

Structured text sets `response_format: {type: 'text', mime_type: 'application/json', schema}`. Studio semantically validates proposals against pinned source units, declared occurrences, stable IDs, and the existing scene authority. Valid citations do not prove literary fidelity. The complete immutable proposal is shown for human review and changes the scene only through an explicit CAS-checked `proposal.apply` command.

Results are read from every `steps[]` item of type `model_output`, then its `content[]` blocks. Image/audio blocks carry `type`, `mime_type`, and base64 `data`; text blocks carry `text`. Studio strictly checks base64, actual PNG/WAV containers, decodability, and JSON. Response `model` is retained as `returnedModel`, never promoted to a resolved model version. Actual emitted voice is not inferred from the request or WAV container.

## Uncertainty, retention, and billing

A returned Interaction ID is saved through a fenced worker callback before output decoding. Explicit recovery uses `GET /v1beta/interactions/{id}` only when an actual saved ID exists and the provider still retains it. `store: true` does not guarantee indefinite retention. A lost synchronous response without an ID cannot be recovered by lookup. Network failures, ambiguous 5xx responses, incomplete output, and malformed output after dispatch preserve an unknown outcome and held reservation; there is no hidden retry or model fallback.

Usage token fields are optional and are not invoices. Missing usage remains unknown; token counts do not settle money. Retrying an unknown attempt requires an explicit duplicate-charge-risk decision. Billing reconciliation is separately audited and does not invent a Google billing response.

## Local verification and credentials

The Google adapter tests and local HTTP helper exercise actual request shapes, valid PNG/WAV/JSON, multiple outputs, missing usage, malformed base64, mismatched containers, indices without timestamps, 5xx/network ambiguity, saved-ID lookup, direct engine/MCP voice mismatch, and restored-queue/retry validation. Test transports use explicit local endpoints or a rejecting fetch stub; child CLI/MCP tests clear inherited `GEMINI_API_KEY`.

Credentials resolve from a configured backend environment name (default `GEMINI_API_KEY`) or an explicitly named existing macOS Keychain service. Studio does not scan Keychain entries, create/store credentials, put keys in browser state/URLs, or expose provider error bodies. The configured daemon installs adapters before opening the engine and owns its worker; default MCP has no worker, and an unconfigured daemon does not consume another process's queued generation jobs.
