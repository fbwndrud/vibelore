# Per-host installation — what is verified and what is not

[한국어](HOSTS.md) | English

Only what was checked is written here, not what is remembered. Lines that could not be checked are marked as such.
If a format changes, fix this file first.

Host live-call check date: 2026-08-22<br>
Server handshake and default 26 / advanced 39 tool schema check date: 2026-09-04<br>
Webtoon-integrated surface: default 30 / advanced 43 (with the scene path). Kept distinct from the past host live-call records below.

| Host | Settings location | Format | Status |
|---|---|---|---|
| Claude Code 2.1.231 | `.mcp.json` (project) / `claude mcp add` | JSON, `mcpServers` wrapper | Full writing round trip live-called ✅ |
| Codex CLI 0.144.5 | `~/.codex/config.toml` or `.codex/config.toml` | TOML, `[mcp_servers.<name>]` | Full writing round trip live-called ✅ |
| Grok CLI 1.0.5 | `~/.grok/config.toml` or `.grok/config.toml` | TOML, `[mcp_servers.<name>]` | Full writing round trip live-called ✅ |

For Claude, Codex and Grok, the full round trip `lore_init` → `lore_status` →
`lore_context` → `lore_check` → `lore_resume` → `lore_commit` → the next chapter's
`lore_context` was confirmed with an isolated temporary work. All three hosts read chapter 1's summary
in the chapter 2 context. Grok did the handshake with protocol
`2025-11-25` after the first trust approval of the project folder. It found 6 tools on the surface at the time; the
default 26 and advanced 39 tool surface of the time, which expanded after that, was confirmed on 2026-09-04 with a local MCP handshake and automated tests. Codex's non-interactive smoke
could not ask for tool approval automatically, so
`--dangerously-bypass-approvals-and-sandbox` was used only for read-only calls in a trusted local project.

## Claude Code

```bash
claude mcp add-json vibelore '{"command":"node","args":["'"$PWD"'/src/server.js"]}' --scope project
```

Or copy `hosts/claude/.mcp.json` to the root of the work directory and fix the path.
When `type` is omitted, it is read as stdio (the docs state: "Claude Code reads an entry with no
`type` as a stdio server"). Check the registration with `claude mcp get vibelore`. Project settings
need approval on first use. On Claude Code 2.1.231 the full writing round trip
succeeded.

To run the writing loop automatically, copy `hosts/claude/skills/novel/` under `.claude/skills/`.

## Codex CLI

Paste the block in `hosts/codex/config.toml` into `~/.codex/config.toml` and fix the path.
If `hosts/codex/AGENTS.md` is put at the root of the work directory, Codex follows the writing order.

On Codex CLI 0.144.5, a project setting with only `command` and `args` was recognized as a stdio server,
and the full writing round trip succeeded. No separate `transport` key was
needed.

The current Codex configuration reference defines `mcp_servers.<id>.command` as the stdio launch command, and
`cwd`, `startup_timeout_sec`, `tool_timeout_sec`, `required` and so on as optional settings.
[Official OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

## Grok CLI

```bash
grok mcp add vibelore -- node "$PWD/src/server.js"
```

Or paste `hosts/grok/config.toml` into `~/.grok/config.toml`. Optional keys are `env`,
`startup_timeout_sec` (default 30) and `tool_timeout_sec` (default 6000). The first run
loads the engine modules and finishes well within the default 30 seconds, but if it times out on a slow disk,
raise `startup_timeout_sec`.

Grok CLI 1.0.5 was confirmed to read the root `AGENTS.md` as project instructions. Its Claude
compatibility mode also discovers `.claude/skills/novel/SKILL.md`.

## Host capabilities needed for webtoon production

For webtoons, the same MCP connection adds the default path `lore_webtoon_scene` (generating a whole scene as one image, dialogue included,
without roughs). `lore_webtoon_plan`, `lore_webtoon_render` and `lore_webtoon_decide` are
[deprecated] and are used only to continue per-panel work already started. Plugin installation includes the webtoon interview skill too.
Registering only MCP doesn't install the skills automatically, so tell the host to read
`skills/webtoon-discovery-interview/SKILL.md` in the vibelore install path. If you copy only the skill,
its relative-path reference documents can break, so read the original inside the install tree.

Actual drawing needs image generation, reference image attachment, local file storage, and viewing images and composites.
The Codex execution contract follows the [image connection guide](skills/webtoon-discovery-interview/references/codex-images.md).
For other hosts, check that they actually provide equivalent capabilities before running requests.
The scene path calls only the OpenAI image API model the user chose and never substitutes another model. On the per-panel path (deprecated), if the chosen model can't be specified, it stops at `needs_image_runtime` and doesn't substitute a paid path automatically.

This branch's regression tests check, with synthetic images, the scene path's MCP round trip, pre-generation check and image review, and the per-panel path's (deprecated) rough approval and final approval.
The novel host live-call records at the top don't mean live image generation or aesthetic verification for webtoons.
The complete flow and its constraints are in the [webtoon guide](docs/WEBTOON.en.md).

## Protocol version and fallback

The server returns the `protocolVersion` the client sent in `initialize` as it is.
If none was sent, it answers with `2025-06-18`. This fallback value was **not confirmed by documentation** —
if version negotiation rejects it, adjust `FALLBACK_PROTOCOL` in `src/server.js`.

## Sources

- Claude Code MCP docs — https://code.claude.com/docs/en/mcp
- Codex CLI 0.144.5 built-in help — `codex mcp --help`, `codex mcp add --help`
- xAI/Grok MCP docs — https://docs.x.ai/build/features/mcp-servers
