# 호스트별 설치 — 확인된 것과 확인되지 않은 것

기억으로 쓰지 않고 확인한 것만 적습니다. 확인하지 못한 줄은 그렇게 표시했습니다.
포맷이 바뀌면 이 파일을 먼저 고치세요.

호스트 실호출 확인일: 2026-08-22<br>
서버 자체 handshake·기본 26개/고급 39개 도구 schema 확인일: 2026-09-04

| 호스트 | 설정 위치 | 형식 | 상태 |
|---|---|---|---|
| Claude Code 2.1.231 | `.mcp.json` (프로젝트) / `claude mcp add` | JSON, `mcpServers` 래퍼 | 전체 집필 왕복 실호출 ✅ |
| Codex CLI 0.144.5 | `~/.codex/config.toml` 또는 `.codex/config.toml` | TOML, `[mcp_servers.<name>]` | 전체 집필 왕복 실호출 ✅ |
| Grok CLI 1.0.5 | `~/.grok/config.toml` 또는 `.grok/config.toml` | TOML, `[mcp_servers.<name>]` | 전체 집필 왕복 실호출 ✅ |

Claude, Codex, Grok 모두 격리된 임시 작품으로 `lore_init` → `lore_status` →
`lore_context` → `lore_check` → `lore_resume` → `lore_commit` → 다음 화
`lore_context` 전체 왕복을 확인했습니다. 세 호스트 모두 2화 컨텍스트에서 1화 요약을
읽었습니다. Grok은 프로젝트 폴더 최초 신뢰 승인 뒤 protocol
`2025-11-25`로 handshake했습니다. 당시 표면에서 6개 도구를 발견했으며, 이후 확장된 현재
기본 26개와 고급 39개 도구 표면은 2026-09-04 로컬 MCP handshake와 자동 테스트로 확인했습니다. Codex의 비대화형 smoke는
도구 승인을 자동으로 물을 수 없어, 신뢰한 로컬 프로젝트에서 읽기 전용 호출에 한해
`--dangerously-bypass-approvals-and-sandbox`를 사용했습니다.

## Claude Code

```bash
claude mcp add-json vibelore '{"command":"node","args":["'"$PWD"'/src/server.js"]}' --scope project
```

또는 `hosts/claude/.mcp.json` 을 작품 디렉터리 루트에 복사하고 경로를 고칩니다.
`type` 을 생략하면 stdio 로 읽힙니다 (문서 명시: "Claude Code reads an entry with no
`type` as a stdio server"). 등록 확인은 `claude mcp get vibelore`. 프로젝트 설정은
최초 사용 시 승인이 필요합니다. Claude Code 2.1.231에서 전체 집필 왕복까지
성공했습니다.

집필 루프를 자동으로 태우려면 `hosts/claude/skills/novel/` 을 `.claude/skills/` 아래로
복사하세요.

## Codex CLI

`hosts/codex/config.toml` 의 블록을 `~/.codex/config.toml` 에 붙이고 경로를 고칩니다.
`hosts/codex/AGENTS.md` 는 작품 디렉터리 루트에 두면 Codex 가 집필 순서를 따릅니다.

Codex CLI 0.144.5에서 `command`와 `args`만 둔 프로젝트 설정이 stdio 서버로
인식됐으며, 전체 집필 왕복까지 성공했습니다. 별도 `transport` 키는 필요하지
않았습니다.

현재 Codex 설정 레퍼런스는 `mcp_servers.<id>.command`를 stdio 실행 명령으로,
`cwd`, `startup_timeout_sec`, `tool_timeout_sec`, `required` 등을 선택 설정으로 정의합니다.
[공식 OpenAI 설정 레퍼런스](https://learn.chatgpt.com/docs/config-file/config-reference)

## Grok CLI

```bash
grok mcp add vibelore -- node "$PWD/src/server.js"
```

또는 `hosts/grok/config.toml` 을 `~/.grok/config.toml` 에 붙입니다. 선택 키로 `env`,
`startup_timeout_sec`(기본 30), `tool_timeout_sec`(기본 6000) 이 있습니다. 첫 실행은
엔진 모듈을 로드하므로 기본 30초 안에 충분히 끝나지만, 느린 디스크에서 걸리면
`startup_timeout_sec` 을 올리세요.

Grok CLI 1.0.5는 루트 `AGENTS.md`를 프로젝트 지시로 읽는 것을 확인했습니다. Claude
호환 모드가 `.claude/skills/novel/SKILL.md`도 함께 발견합니다.

## 프로토콜 버전

서버는 클라이언트가 `initialize` 에 보낸 `protocolVersion` 을 그대로 되돌려줍니다.
보내지 않으면 `2025-06-18` 로 답합니다. 이 폴백 값은 **문서로 확인하지 않았습니다** —
버전 협상에서 거절당하면 `src/server.js` 의 `FALLBACK_PROTOCOL` 을 조정하세요.

## 출처

- Claude Code MCP 문서 — https://code.claude.com/docs/en/mcp
- Codex CLI 0.144.5 내장 도움말 — `codex mcp --help`, `codex mcp add --help`
- xAI/Grok MCP 문서 — https://docs.x.ai/build/features/mcp-servers
