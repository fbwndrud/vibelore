# vibelore

**AI로 장편 웹소설을 써도 설정이 무너지지 않게 지켜 주는 로컬 도구.**

Claude Code, Codex, Grok 같은 AI 코딩 도구에 붙여서 씁니다. 본문은 그 AI가 쓰고,
vibelore는 세계관·인물·복선·시간선을 기억하고 매 화 검사합니다. API 키도, 빌드도, 서버도 필요 없습니다.

[![Node](https://img.shields.io/badge/node-22.13%2B%20%7C%2024-brightgreen)](docs/GETTING_STARTED.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Grok-black)](HOSTS.md)

---

## 이런 분을 위한 도구입니다

- 웹소설·웹연재를 수십 화, 수백 화 단위로 쓰고 싶은 분
- AI에게 초고를 맡기면 10화쯤부터 인물 이름·호칭·능력·시간선이 꼬이는 걸 겪어 본 분
- Claude Code, Codex, Grok CLI 중 하나를 이미 쓰고 있는 분
- 원고와 설정을 Markdown 파일로 직접 들고 있고 싶은 분

## 할 수 있는 것 / 없는 것

| 됩니다 | 안 됩니다 |
|---|---|
| 작품 인터뷰로 장르·톤·시점·독자 약속을 정하고 세계관과 인물을 자동 생성 | OpenAI·Anthropic·Google·xAI API 키를 넣어 직접 호출 |
| 전체 스토리 → 아크 → 화 단위로 계획하고 승인 후 집필 | 웹에서 쓰는 GUI (호스트 채팅창이 인터페이스) |
| 매 화 초고를 설정·인물·시간선과 대조해 검사, 최대 3회 자동 수정 | 후속 화 자동 수정 (2화를 고치면 3화 재검사는 직접 요청) |
| 마음에 든 화를 문체 기준으로 지정해 이후 화가 따라가게 | 문학적 품질 보증 (검토는 참고 의견) |
| 앞 화 다시 쓰기, 특정 화 시점으로 전체 되돌리기 | 여러 사람이 같은 작품을 동시에 편집 |
| 원고·설정을 사람이 읽고 고치는 Markdown 파일로 보관 | 네트워크 드라이브·멀티테넌트 서버 |

## 3분 시작

**1. 받기**

```bash
git clone https://github.com/fbwndrud/vibelore.git
```

Node.js 22.13 이상(22.x) 또는 24.x만 있으면 됩니다. `npm install`이나 빌드는 없습니다.

**2. 호스트에 등록** (하나만)

```bash
# Claude Code
claude mcp add-json vibelore '{"command":"node","args":["/absolute/path/to/vibelore/src/server.js"]}' --scope project
```

```bash
# Grok CLI
grok mcp add vibelore -- node /absolute/path/to/vibelore/src/server.js
```

```toml
# Codex — ~/.codex/config.toml
[mcp_servers.vibelore]
command = "node"
args = ["/absolute/path/to/vibelore/src/server.js"]
startup_timeout_sec = 30
tool_timeout_sec = 6000
```

이 저장소는 `.codex-plugin/plugin.json`을 포함한 Codex 플러그인이기도 합니다. 플러그인
설치 메뉴에 사용자 저장소 추가 기능이 있다면 이 저장소 주소를 넣으면 인터뷰 스킬과
MCP 서버가 함께 로드됩니다.

**3. 호스트에게 말하기**

새 작품:

> `/absolute/path/to/my-novel`에 `night_bus`라는 작품을 만들고 싶어. 심야버스에서 승객의 후회를 듣는 기사 이야기야. 작품 발견 인터뷰부터 진행해.

인터뷰가 결과를 바꾸는 취향을 한 라운드에 4~5개씩 묻습니다. 건너뛰려면 "묻지 말고 자동으로"라고 하면 됩니다.

다음 화:

> `night_bus` 다음 화를 guided 모드로 써 줘.

계획 → 초고 → 검사 → 수정 → 승인 대기까지 한 번에 돌아갑니다. 원고를 보고 "승인" 또는
"이 부분 고쳐서 다시"라고 답하면 됩니다. `auto` 모드는 검사와 검토를 통과하면 자동 커밋합니다.

막히면 [시작 안내](docs/GETTING_STARTED.md)를 보세요.

## 자주 하는 일

| 하고 싶은 것 | 호스트에게 이렇게 |
|---|---|
| 1화가 마음에 안 들어, 설정은 그대로 두고 다시 | "`night_bus` 1화를 [이런 방향]으로 다시 써 줘" → 검사 → 승인 |
| 3화까지 썼는데 2화를 고치고 싶어 | 2화 다시 쓰기 → 승인 → "이후 상태 재계산해 줘" → 필요하면 3화 재검사 요청 |
| 5화 시점으로 전부 되돌리고 싶어 | "`night_bus`를 5화 시점으로 롤백해 줘" |
| 이 화 문체가 딱 좋아, 앞으로 이렇게 | "`night_bus` 3화를 문체 기준으로 승인해 줘. 이유: 대사가 짧고 건조해서" |
| 설정 파일을 손으로 고쳤어 | "`night_bus` 변경 사항 확인해 줘" → 영향 범위와 다음 할 일을 알려 줌 |
| 왜 이렇게 썼는지 근거를 보고 싶어 | "이번 화 검토 근거와 실제 집필 요청을 보여 줘" |

자세한 절차는 [운영과 복구](docs/OPERATIONS.md)에 있습니다.

## 지원 장르

25개 장르 프리셋이 있고, 프리셋마다 추적하는 설정 항목(시간선, 회귀 지식, 관계 상태, 능력
체계 등)이 다릅니다.

`회귀 헌터` `악역영애 이세계` `아카데미 판타지` `가문 회귀` `추방 복수` `추리 스릴러` `액션`
`코미디` `역사` `LitRPG` `스트리밍 LitRPG` `성장물` `시스템 아포칼립스` `탑 등반` `이세계`
`수련` `선협` `현환` `던전 코어` `로맨스 판타지` `SF` `호러` `일상 힐링` `현대 도시` `기타`

목록에 없는 장르나 복합 장르도 됩니다. 인터뷰가 장르를 톤·서브장르·이야기 동력으로 분해해
작품 프로필로 만들고, 설정 검사는 가장 가까운 프리셋을 씁니다. 딱 맞는 프리셋이 없으면
기본 검사(인물·호칭·복선)만 돕니다.

## 파일은 어디에

```text
my-novel/
├── world/         세계 설정 — 직접 고쳐도 됩니다
├── characters/    인물 설정 — 직접 고쳐도 됩니다
├── chapters/      본문 — 직접 고쳐도 됩니다
├── summaries/     화별 요약
└── .vibelore/     검사 기록·복구 스냅샷 — 건드리지 마세요
```

원고는 전부 내 컴퓨터에 있습니다. vibelore는 어디에도 전송하지 않습니다.
원고의 저작권은 작성자에게 있으며 이 저장소의 라이선스가 적용되지 않습니다.

## 모델은 뭘 쓰나

호스트 세션에서 선택한 모델을 그대로 씁니다. 모델과 생각 수준은 호스트에서 바꾸세요.
권장은 강한 모델에 `high`입니다. 단계별로 모델을 나누거나 Ollama 같은 로컬 모델을 붙이려면
[모델과 프로바이더](docs/MODELS.md)를 보세요.

## 더 읽기

- [시작 안내](docs/GETTING_STARTED.md) — 등록, 첫 작품, 다음 화, 막혔을 때
- [운영과 복구](docs/OPERATIONS.md) — 다시 쓰기, 되돌리기, 실패 대응
- [모델과 프로바이더](docs/MODELS.md) — 권장 모델, 단계별 모델 지정, 로컬 모델
- [도구 레퍼런스](docs/TOOLS.md) — 호스트가 호출하는 도구 전체 계약
- [아키텍처](docs/ARCHITECTURE.md) · [MCP 계약](docs/MCP.md) · [설계 철학](docs/PHILOSOPHY.md)
- [호스트별 검증 기록](HOSTS.md) · [기여](CONTRIBUTING.md) · [보안](SECURITY.md) · [자료 출처](docs/PROVENANCE.md)

Apache-2.0. 0.1.0 공개 뒤 자료 유래를 재검토해 외부 참고에서 온 어휘와 스키마를 vibelore
자체 정의로 교체했습니다. 기록은 [PROVENANCE](docs/PROVENANCE.md)에 있습니다.
