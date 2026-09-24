# 시작 안내

vibelore는 따로 여는 앱이 아닙니다. 평소 쓰는 AI 코딩 도구(Claude Code, Codex, Grok CLI)에
붙여 쓰는 도구입니다. 채팅창에 “다음 화를 써 줘”라고 말하면, AI가 vibelore를 불러 설정을
확인하고 검사하면서 소설을 씁니다.

```mermaid
flowchart LR
    U[사용자 요청] --> H[Claude Code / Codex / Grok]
    H -->|도구 호출| V[vibelore]
    V -->|설정·검사 결과| H
    H -->|원고·승인 요청| U
```

## 1. 설치

필요한 것은 Node.js 22.13 이상(22.x), 24.x 또는 26.x, 그리고 AI 코딩 도구 하나입니다.
`npm install`도 빌드도 없습니다.

AI 도구에게 저장소 주소를 주고 등록을 부탁하세요.

> https://github.com/fbwndrud/vibelore 를 받아서 MCP 서버로 등록해 줘.

등록이 끝나면 AI 도구를 한 번 다시 시작합니다. 그다음 연결을 확인합니다.

> vibelore 도구가 연결됐는지 확인해 줘. 아직 작품은 만들지 마.

도구가 보이면 준비가 끝났습니다. 보이지 않으면 [연결 문제 해결](TROUBLESHOOTING.md#도구가-보이지-않아요)을 보세요.

<details>
<summary>npm으로 등록하려면</summary>

저장소 없이 npm 패키지 `vibelore`로 서버를 실행합니다. 명령만 바뀌고 나머지 설정은 아래와 같습니다.

```bash
claude mcp add-json vibelore '{"command":"npx","args":["-y","vibelore"]}' --scope project
```

Codex는 `command = "npx"`, `args = ["-y", "vibelore"]`, Grok CLI는 `grok mcp add vibelore -- npx -y vibelore`입니다.
Windows에서는 `npx` 앞에 `cmd /c`를 붙입니다(`"command":"cmd","args":["/c","npx","-y","vibelore"]`).
이 방식은 MCP 서버만 등록하므로 인터뷰 스킬은 저장소 방식이나 Codex 플러그인으로 설치합니다.
</details>

<details>
<summary>저장소를 받아 직접 등록하려면</summary>

```bash
git clone https://github.com/fbwndrud/vibelore.git /absolute/path/to/vibelore
node --version
```

**Claude Code**

```bash
claude mcp add-json vibelore \
  '{"command":"node","args":["/absolute/path/to/vibelore/src/server.js"]}' \
  --scope project
```

**Codex** (`~/.codex/config.toml` 또는 프로젝트의 `.codex/config.toml`)

```toml
[mcp_servers.vibelore]
command = "node"
args = ["/absolute/path/to/vibelore/src/server.js"]
startup_timeout_sec = 30
tool_timeout_sec = 6000
required = true
```

Codex 설정 키의 의미는 [OpenAI 설정 레퍼런스](https://learn.chatgpt.com/docs/config-file/config-reference)를 보세요.

**Grok CLI**

```bash
grok mcp add vibelore -- node /absolute/path/to/vibelore/src/server.js
```

호스트별 확인 명령과 검증한 버전은 [HOSTS.md](../HOSTS.md)에 있습니다.
</details>

MCP 서버만 등록하면 인터뷰 스킬이 자동으로 로드되지 않을 수 있습니다. 그럴 때는 요청에
이 한 줄을 덧붙이세요.

> vibelore 설치 폴더의 AGENTS.md와 이번 작업에 맞는 인터뷰 스킬을 읽고 진행해.

## 2. 새 작품 만들기

쓰고 싶은 이야기를 한두 문장으로 말하면 됩니다.

> 새 소설을 시작하고 싶어. 심야버스 기사가 승객의 후회를 듣는 현대 판타지야. 작품 인터뷰부터 하고, 계획은 내가 확인한 뒤 확정해 줘.

AI가 작품을 저장할 폴더와 짧은 작품 이름을 물어볼 수 있습니다. 작품 이름은 나중에 여러
작품을 구분할 때 쓰는 영문 이름입니다.

AI는 아직 정하지 않은 취향을 묻고 다음을 준비합니다.

| 준비하는 것 | 사용자가 정할 것 |
|---|---|
| 작품 방향 | 어떤 독자에게 어떤 재미·분위기·속도로 보여줄지 |
| 세계와 인물 | 이야기의 규칙, 주요 인물의 성격과 관계 |
| 전체 이야기 | 핵심 갈등, 큰 전환, 이야기의 끝 |
| 문체 | 서술 거리, 문장 리듬, 대사와 설명의 느낌 |
| 첫 아크 | 다음 몇 화에서 무엇이 일어나고 바뀔지 |

인터뷰는 여러 번 이어질 수 있습니다. 결과를 보고 “승인” 또는 고칠 방향으로 답하세요.
다 맡기고 싶으면 “묻지 말고 자동으로 정해서 진행해”라고 하면 됩니다.

## 3. 다음 화 쓰기

> 다음 화를 써 줘. 원고와 검토 의견을 보여 주고, 내가 승인하면 저장해.

AI가 이번 화 계획 → 초고 → 설정 검사와 검토 → 필요한 수정까지 하고 원고를 보여 줍니다.
직접 고친 파일이 있으면 그것부터 확인합니다.

- **확인 후 저장:** 원고와 검토 의견을 읽고 “승인”하거나 고칠 방향을 말합니다.
- **자동 저장:** “자동으로 진행해”라고 하면 검사와 검토를 통과한 원고를 바로 저장합니다.
  검토가 실패하면 저장하지 않고 원고를 남겨 둔 채 확인을 요청합니다.

문체나 감정 속도에 대한 지적은 참고 의견입니다. 지적이 있다고 의도한 표현을 무조건 고치지는
않습니다. 반대로 검사를 통과했다고 모든 문제가 없다는 뜻도 아닙니다.

마음에 든 화가 생기면 문체 기준으로 삼을 수 있습니다.

> 1~3화를 앞으로의 문체 기준으로 삼아 줘. 인물 가까이에서 관찰하고 어려운 설정도 짧게 설명하는 방식이 좋아.

원고는 작품 폴더의 `chapters/`, 설정은 `world/`와 `characters/`에 저장됩니다. 파일을 직접
고쳤다면 다음 화를 쓰기 전에 “변경 사항 확인해 줘”라고 하세요.

## 4. 중간에 멈췄을 때, 근거가 궁금할 때

작업은 저장되므로 처음부터 다시 할 필요가 없습니다.

> 방금 멈춘 작업을 확인하고 이어서 해 줘.

왜 이렇게 썼는지 보고 싶으면:

> 이번 화에 어떤 문체 기준이 전달됐고, 검토에서 무엇을 발견했는지 보여 줘.

같은 AI가 쓰고 검토한 결과는 자기검토이며 독립된 독자 평가가 아닙니다. 실패, 손수정, 백업은
[문제 해결](TROUBLESHOOTING.md)을 보세요.

## 5. 이미 쓴 소설 이어받기

원본을 먼저 백업하고, 새로 만들지 말고 읽어 달라고 요청하세요.

> `/absolute/path/to/existing-novel`에 있는 소설을 이어서 쓰고 싶어. 기존 파일은 덮어쓰지 말고, 설정과 원고 구조를 확인해서 필요한 준비만 안내해 줘. 아직 본문은 쓰지 마.

`world/`, `characters/`, `chapters/` 구조로 된 작품은 그대로 이어갑니다. 다른 형식의 문서가
이 구조로 자동 변환되지는 않으니, 어디까지 정리할지 먼저 확인하세요.

## 6. 웹툰으로 만들기

> 1화를 웹툰으로 만들어 줘. 그림체와 글자 표현부터 물어보고, 러프를 보여 준 뒤 본 그림으로 진행해.

이미지를 만들고 볼 수 있는 AI 도구가 필요합니다. 이미지 모델과 비용은 먼저 확인받고,
소설과 웹툰은 따로 저장합니다. 완성본은 세로로 긴 SVG·HTML입니다.

자세한 순서는 [웹툰 만들기](WEBTOON.md)를 보세요.

## 다음 문서

- [아키텍처](ARCHITECTURE.md): AI·vibelore·작품 파일이 연결되는 방식
- [모델 설정](MODELS.md): 글 쓰는 모델과 그림 그리는 모델
- [문제 해결과 백업](TROUBLESHOOTING.md): 멈춤, 손수정, 되돌리기
- [문서 목차](README.md): 사용 안내와 상세 기술 참조
