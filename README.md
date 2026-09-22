# vibelore

**AI로 장편 웹소설을 써도 설정이 무너지지 않게 지켜 주는 로컬 도구.**

Claude Code, Codex, Grok 같은 AI 코딩 도구에 붙여서 씁니다. 본문은 그 AI가 쓰고,
vibelore는 세계관·인물·복선·시간선을 기억하고 매 화 검사합니다. 기존 소설을 세로형 웹툰으로 각색하는 제작 흐름도 제공합니다.
기본 소설 집필에는 별도 API 키나 빌드·원격 서버가 필요 없습니다. 웹툰 이미지는 생성 가능한 호스트가 필요하며, API 경로는 별도 키와 과금이 필요합니다.

[![Node](https://img.shields.io/badge/node-22.13%2B%20%7C%2024-brightgreen)](docs/GETTING_STARTED.md)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Grok-black)](HOSTS.md)

**실제 결과 보기** → [『길 위의 번개』 세 모델 웹툰 쇼케이스](https://fbwndrud.github.io/vibelore/showcase/thundertrail/) · [모델 비교와 비용](https://fbwndrud.github.io/vibelore/showcase/thundertrail/compare.html)

---

## 이런 분을 위한 도구입니다

- 웹소설·웹연재를 수십 화, 수백 화 단위로 쓰고 싶은 분
- AI에게 초고를 맡기면 10화쯤부터 인물 이름·호칭·능력·시간선이 꼬이는 걸 겪어 본 분
- Claude Code, Codex, Grok CLI 중 하나를 이미 쓰고 있는 분
- 원고와 설정을 Markdown 파일로 직접 들고 있고 싶은 분

## 할 수 있는 것 / 없는 것

| 됩니다 | 안 됩니다 |
|---|---|
| 작품 인터뷰로 장르·톤·시점·독자 약속을 정하고 세계관과 인물을 자동 생성 | MCP 서버 자체에서 유료 생성 API 실행 (이미지 API는 선택한 호스트가 실행) |
| 전체 스토리 → 아크 → 화 단위로 계획하고 승인 후 집필 | 웹에서 쓰는 GUI (호스트 채팅창이 인터페이스) |
| 매 화 초고를 설정·인물·시간선과 대조해 검사, 최대 3회 자동 수정 | 후속 화 자동 수정 (2화를 고치면 3화 재검사는 직접 요청) |
| 마음에 든 화를 문체 기준으로 지정해 이후 화가 따라가게 | 문학적 품질 보증 (검토는 참고 의견) |
| 앞 화 다시 쓰기, 특정 화 시점으로 전체 되돌리기 | 여러 사람이 같은 작품을 동시에 편집 |
| 원고·설정을 사람이 읽고 고치는 Markdown 파일로 보관 | 네트워크 드라이브·멀티테넌트 서버 |
| 기존 소설 각색 → 러프 승인 → 작화 요청·조판 → SVG/HTML 웹툰 완성본 | 플랫폼용 PNG/JPEG 자동 분할 |

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
| 기존 소설을 웹툰으로 만들고 싶어 | "`night_bus` 1화를 웹툰으로 각색해 줘. 제작 방향부터 물어봐 줘" |

수정·재개·백업은 [문제 해결과 백업](docs/TROUBLESHOOTING.md)을 보세요.
앞 화 재작성처럼 고급 복구 도구가 필요한 작업은 AI가 사용 가능 여부와 영향을 먼저 확인합니다.

## 기존 소설을 웹툰으로

원작의 세계관·인물·해당 화 상태를 가져오고, 무엇을 살리고 덜어낼지 먼저 정합니다.
40컷을 채우는 방식이 아니라 핵심 경험에 필요한 컷만 고릅니다.

작화 스타일·문자 표현·판면을 사용자에게 확인한 뒤, 각색 대본과 기준 이미지를 승인받습니다.
이어서 동선·접점·대사 여백을 담은 단순 러프를 검토하고 **사용자 러프 승인 후** 본 작화로 넘어갑니다.
액션의 새 구도는 병렬 제작할 수 있고, 식사처럼 자세·소품이 이어지는 컷은 앞 그림을 참조합니다.
대사·독백·효과음은 별도로 조판하고, 간판·모니터 글자는 사물 안에 그린 뒤 실제 읽힘을 확인합니다.

이미지 모델·실행 경로·비용을 확인해 작품별로 유지합니다. MCP는 요청·참조·검토·승인을 관리하고,
호스트가 실제 생성과 시각 검토를 수행합니다. 원작과 웹툰의 승인·저장은 별개입니다.
완성본은 세로형 SVG/HTML로 제공합니다.
자세한 시작·수정·재개 절차는 [웹툰 제작 안내](docs/WEBTOON.md)를 보세요.

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
├── webtoon/       승인된 웹툰 설정·각색·SVG/HTML 마스터
└── .vibelore/     검사 기록·복구 스냅샷 — 건드리지 마세요
```

원고와 제작 기록은 내 컴퓨터에 보관합니다. 연결한 호스트·모델 서비스에는 요청에 필요한
원고와 참조 이미지가 전달될 수 있습니다. 데이터 경계는 [보안 안내](SECURITY.md)를 확인하세요.
원고의 저작권은 작성자에게 있으며 이 저장소의 라이선스가 적용되지 않습니다.

## 모델은 뭘 쓰나

호스트 세션에서 선택한 모델을 그대로 씁니다. 모델과 생각 수준은 호스트에서 바꾸세요.
검토만 가벼운 모델에 맡기는 단계별 힌트를 쓸 수 있으며, 확정 사실을 추출하는 단계는
기준 모델이 유지됩니다. 단계별 모델 힌트를 지정하거나 로컬 텍스트 모델을 붙이려면
[모델과 프로바이더](docs/MODELS.md)를 보세요.

웹툰 이미지 모델 선택은 소설 집필 모델과 별개이며, 사용자가 확인한 선택을 작품별로 저장합니다.

## 실제 결과 보기

1~3화를 각각 Codex(gpt-6-astra)·Claude(claude-opus-5)·Grok(grok-4.6)이 각색하고 같은 이미지 모델(gpt-image-2.5-sunburst)로 그린 결과를 검토 판정·비용과 함께 가감 없이 공개합니다.

- [쇼케이스 리더](https://fbwndrud.github.io/vibelore/showcase/thundertrail/) — 장면 이미지 ↔ 원문 나란히, 장면별 검토 근거·프롬프트·각색 JSON
- [모델 비교](https://fbwndrud.github.io/vibelore/showcase/thundertrail/compare.html) — 통과율, 차단 근거 귀속(이미지 모델/각색/파이프라인), 소설·각색·이미지 비용, 직접 해보기 명령
- 소스: https://github.com/fbwndrud/vibelore/tree/main/docs/showcase

## 더 읽기

- [시작 안내](docs/GETTING_STARTED.md) — 등록, 첫 작품, 다음 화, 막혔을 때
- [웹툰 제작](docs/WEBTOON.md) — 각색, 필수 선택, 구도 러프, 작화·조판과 승인
- [문제 해결과 백업](docs/TROUBLESHOOTING.md) — 작업 재개, 손수정, 되돌리기, 파일 보관
- [모델 설정](docs/MODELS.md) — 텍스트·이미지 모델 선택, 비용 경로, 로컬 모델
- [도구 레퍼런스](docs/TOOLS.md) — 호스트가 호출하는 도구 전체 계약
- [아키텍처](docs/ARCHITECTURE.md) — 소설·웹툰 제작 구조, AI와 서버의 역할, 저장 경계
- [전체 문서](docs/README.md) — 사용자 안내와 연동·운영 상세 참조
- [호스트별 검증 기록](HOSTS.md) · [기여](CONTRIBUTING.md) · [보안](SECURITY.md)
