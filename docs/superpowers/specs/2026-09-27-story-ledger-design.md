# 이야기 등록부(Story Ledger) 설계

- 날짜: 2026-09-27
- 브랜치 기준: `fix/draft-continuity-handoff` (8d0aaf6 이후)
- 상태: 구현 완료 (구현 중 조정한 내용은 해당 절에 "구현 조정"으로 적었다)

## 1. 배경

한 작품 안에서 같은 물건·단서·떡밥은 여러 화에 걸쳐 다시 쓰인다. 기록은 화마다 새로 쌓이는 조각이 아니라 **고유 ID를 가진 하나의 기록**이어야 하고, 화마다 무엇이 있었는지가 **이력**으로 남아야 한다. 그래야 다시 등장할 때 "이 물건은 이런 이력을 가졌다"를 알 수 있다.

현재 코드의 문제:

1. 추적 기록이 두 체계로 나뉘어 있다.
   - `StoryState.trackedEntities`: 매 화 쓰인다. ID가 없고(`name` 등에서 키 추정), 같은 키는 통째로 덮어쓰며, 이력이 없다. 이름이 조금만 달라져도 새 기록이 된다(실측: 매 화 새 이름으로 등록).
   - `.vibelore/entities.json`: ID·별칭·상태(active/retired/destroyed)가 있지만 실제 작품 3개 모두 설계 시점 9개에서 늘지 않았다(`entityOps`가 추출에서 나온 적 없음). (구현 조정: 롤백은 이 파일도 스냅샷에서 되돌린다. 롤백이 되돌리지 못한 것은 `review-policy.json`과 `arc-summaries/`였고, 이번에 함께 되돌리도록 고쳤다.) 이 파일만 보는 "파괴된 대상 재등장" 검사는 사실상 걸릴 수 없다.
2. 떡밥 상태는 `planted/advancing/paid/parked` 넷뿐이고 이력이 없다(`lastMovedChapter`만). `paid`가 되면 영구히 추적에서 빠지고, 회수는 추출 모델의 자기 보고만으로 확정된다.
3. 장르별 추적 종류(`genreProfile.trackedEntities`)와 장르별 불변식이 코드 분기로 흩어져 있다. 추출 프롬프트는 장르와 무관하게 6종류를 모두 노출해서, 회귀물용 `Timeline`(전생/현생 듀얼 타임라인)이 모든 작품에서 "이번 화 사건 목록"으로 오용된다. 회귀물의 전생 사건 추적은 한 번도 작동하지 않았다.
4. 입력 필터 실측(2026-09-27): 500화 규모에 같은 세계관 잡음 200개를 섞어 재생했을 때, 화 계획의 떡밥 목록을 쓰면 떡밥 포함률 33/34, 쓰지 않으면 20/34였다. 유일한 누락은 직전 화에 움직였지만 계획에 없던 떡밥이었다(선택 코드가 `lastMovedChapter`를 보지 않음). 필터에서 빠진 기록은 모델이 새 기록으로 중복 등록하는 위험으로 이어진다.

## 2. 원칙

- **장르 분기 없음.** 코드는 동작이 다른 **기능** 단위만 안다. 장르 이름은 코드에 없다.
- **설정으로 켜고 끈다.** 무엇을 추적하고 점검할지는 작가의 설정이다(`lore_configure`). 기본은 모두 켜짐.
- **이력 원본은 텍스트.** 사람이 읽고 diff로 볼 수 있고, 추출 결과로부터 언제든 다시 만들 수 있어야 한다.
- **입력 크기는 화 수와 무관.** 모델 입력에는 현재 값과 최근 사건만 들어가고 전체 이력은 저장소에만 둔다.
- **모호하면 묻는다.** 중복 병합은 정확히 같을 때만 자동이고, 비슷하면 사용자 승인.

## 3. 데이터 모델

### 3.1 기능(feature)

| 기능 | 추적 대상 | 상태 |
|---|---|---|
| `objects` 대상 | 물건·장소·단서·능력 등 "것" | `active` · `lost` · `destroyed` · `retired` |
| `knowledge` 지식 | 누가 무엇을 아는가 (`fields.knownBy[]`) | `secret` · `partial` · `public` · `retired` |
| `scheduled` 예정 사건 | 일어나기로 되어 있는 일 (회귀물 전생 사건, 예언, 예약된 일정) | `pending` · `prevented` · `happened` · `altered` · `retired` |
| `hooks` 떡밥 | 독자에게 한 약속 | `open` · `dormant` · `paid` · `closed` |

물건·단서·능력 같은 구체 분류는 모델이 적는 자유 라벨(`label`)이며 동작에 영향이 없다.

### 3.2 등록부 기록 (StoryState N 안, 현재 값만)

```json
{
  "id": "signed-note",
  "feature": "objects",
  "label": "물건",
  "name": "서명 쪽지",
  "aliases": [{ "text": "그 쪽지" }, { "text": "그 종이 쪼가리", "by": "c4", "since": 5 }],
  "status": "active",
  "fields": { "holder": "c2", "state": "재서명됨" },
  "registeredAt": 4,
  "lastEventAt": 7,
  "recent": [{ "chapter": 7, "event": "mentioned", "note": "장부 정정 때 언급" }],
  "possibleDuplicateOf": null
}
```

- `aliases[].by`가 있으면 그 인물 전용 별칭이다. 기록을 찾을 때는 모든 별칭을 쓴다.
- `recent`는 최근 사건 3개까지.

### 3.3 떡밥 (StoryState N 안)

```json
{ "id": "ria-wrist-hidden", "text": "…", "status": "open", "horizon": "arc",
  "plantedAt": 2, "lastEventAt": 7, "recent": [ … ] }
```

`horizon`은 기존 값(`next/soon/arc/long/finale`)을 유지한다.

### 3.4 사건 (`.vibelore/ledger/events.jsonl`, 한 줄에 하나)

```json
{"chapter":5,"target":"record","id":"signed-note","event":"changed","note":"새벽 재서명","set":{"holder":"c2"}}
{"chapter":7,"target":"hook","id":"ria-wrist-hidden","event":"advanced","note":"…"}
{"chapter":3,"target":"chapter","event":"note","note":"(이전 전 Timeline 기록)"}
```

- 기록 사건: `registered` · `mentioned` · `changed`(`set`) · `status`(`status` 필드) · `restored` · `alias` · `merged`(`into`)
- 떡밥 사건: `planted` · `mentioned` · `advanced` · `paid`(`evidence`) · `reopened` · `parked` · `closed`
- `target:"chapter"`는 기록에 딸리지 않은 화 메모(이전 전 Timeline 오용분)만 쓴다.

### 3.5 상태 전이 규칙 (코드, 기능에 붙음)

| 규칙 | 심각도 |
|---|---|
| `destroyed` 기록에 `changed`/`status` | hard (기존 `ENTITY_UPDATE_AFTER_DESTROY`) |
| `destroyed` 기록 `mentioned` | 허용 (회상) |
| `destroyed` → 복구 | `restored` 사건 + `note` 필수, 없으면 hard |
| `paid` 떡밥 다시 사용 | `reopened` 사건으로 `open` |
| `closed` 떡밥에 사건 | soft |
| `scheduled`가 `happened`/`prevented` 뒤 다시 `pending` | soft |

### 3.6 작가 정의 추적 항목 (`customTracking`)

```json
{ "name": "금화 잔액", "feature": "objects", "pinned": true,
  "rules": [{ "type": "monotonic", "field": "amount", "direction": "down", "unless": "earned" }],
  "note": "리아는 어머니 이야기를 먼저 꺼내지 않는다" }
```

- `pinned`: 필터 상한과 무관하게 추출·작가 입력에 항상 포함.
- `rules` (결정론 메뉴, 모든 작품 공통):
  - `monotonic` — 숫자 필드가 한 방향으로만 변함(`unless` 사건 라벨이면 예외)
  - `frozenAfter` — 특정 상태 이후 변경 금지
  - `speakerOnly` — 특정 별칭·호칭은 지정 인물만 사용
- `note`: 자연어 규칙. 기존 검토 요청 안의 한 구역으로 검토 모델에 전달하고 advisory로만 보고(`AUTHOR_RULE`). 구현상 `coherence-judge` 검토가 함께 판단하므로 `disabledReviews`에서 `coherence-judge`를 끄면 판단하지 않는다. 새 모델 요청을 추가하지 않는다.
- 기본 기능 4개도 내부적으로 같은 틀의 기본값이다.

### 3.7 설정

`lore_configure(tracking={objects,knowledge,scheduled,hooks}, customTracking=[…])`, 저장은 기존 `.vibelore/review-policy.json` 옆의 작품별 설정. 끈 기능은 추출 요청에서 빠지고 검사하지 않으며 실패로 보지 않는다. `genreProfile.trackedEntities`와 장르별 불변식 분기는 제거한다. 구현 조정: 이번에는 `genreProfile.trackedEntities`만 제거하고 `genreProfile.invariants`는 남긴다(작품별 저장, 프롬프트와 승인 게이트가 읽음). 장르 불변식을 기본 작가 규칙으로 바꾸는 일은 후속 작업이다.

### 3.8 범위 밖

- 인물 관계(`relationships`)와 호칭(`addressMap`)은 현 구조 유지. ~~로맨스 `RelationshipState`는 `objects` 기록으로 옮긴다.~~ 구현 조정: 옮기지 않는다(7절).
- SQLite 색인은 이름 검색이 느려질 때 `memory.db`처럼 파생 색인으로 추가. 이번에는 만들지 않음.

## 4. 추출과 중복 판정

### 4.1 추출 입력 (켜진 기능만)

기록마다 `id · label · name · aliases · status · fields 요약 · recent 1개`. 선택 기준:

- 본문(또는 계획)이 이름·**별칭**으로 부른 기록
- 계획이 다루는 떡밥·기록 (상한 제외)
- **최근 3화 안에 사건이 있었던** 기록·떡밥 (`lastEventAt`)
- `pinned` 작가 정의 항목 (상한 제외)
- `possibleDuplicateOf`가 있는 기록은 "(중복 후보: X)" 표시

빠진 수는 지금처럼 `omitted`/`capped`로 표시.

### 4.2 추출 출력 (`delta.ledgerOps`)

```
{op:"event",    id, event, note, set?, status?, evidence?}
{op:"register", feature, label, name, aliases?, fields, note}
{op:"alias",    id, alias, by?}
{op:"plant",    text, horizon}                  떡밥 신규 (ID는 코드가 부여)
```

`trackedEntityOps`·`entityOps`·`hookChanges`는 새 추출에서 쓰지 않는다(읽기는 이전용으로 유지).

### 4.3 코드 처리 (전체 등록부 대상, 결정론)

1. `register`: 이름 정규화(NFC, 공백·따옴표·끝 조사 제거, `searchTerms`의 조사 목록 재사용) 후 같은 기능의 **모든** 기록(필터로 가려진 것, `retired` 포함)의 이름·별칭과 비교.
   - 정확히 같음 → 기존 기록의 `mentioned`/`changed` 사건으로 전환, `LEDGER_REGISTER_MERGED`(info) 기록.
   - 포함 관계 또는 단어 겹침이 높음 → 등록하되 `possibleDuplicateOf` 설정, `LEDGER_POSSIBLE_DUPLICATE`(soft).
2. 모르는 ID의 `event` → 이름·별칭으로 해석, 실패 시 `LEDGER_UNKNOWN_ID`(soft) 후 버림.
3. 상태 전이 규칙(3.5)과 작가 정의 규칙(3.6) 적용 → 기존 검사 파이프라인으로.
4. 본문 확인:
   - `changed`/`mentioned`인데 이름·별칭이 본문에 없음 → soft.
   - 떡밥 `paid`의 `evidence`가 본문 부분 문자열이 아님 → `advanced`로 낮추고 soft.
   - 인물 전용 별칭이 다른 인물 대사에 나옴 → soft.
     구현 조정: 누가 말했는지는 결정론으로 알 수 없어 두 갈래로 본다. 별칭 주인이 이번 화 등장인물에 없는데 별칭이 본문에 나오면 결정론 soft(`LEDGER_ALIAS_OWNER_ABSENT`), 그리고 설정 검사의 호칭 구역에 인물 전용 별칭을 나열해 모델이 화자를 확인한다.

### 4.4 중복 후보 해결

- guided: 승인 화면에 원고·advisory와 함께 병합 후보 목록. 승인 시 `merged` 사건(흡수된 ID는 이후 별칭처럼 해석).
- auto: 병합하지 않고 후보로 둠. 커밋을 막지 않음.
- ~~병합 결정은 `lore_decide(action="merge_records", …)`~~ 구현 조정: 승인한 병합은 설정으로 저장한다. `lore_configure(mergeRecords=[{from, into}])`로 넘기면 `review-policy.json`의 `merges`에 남고, 다음 커밋부터 반영 함수가 적용한다. 검사 영수증 발급 뒤 delta를 바꾸지 않기 위해서이며, 화 승인과 기존 작품 이전에 같은 경로를 쓴다.
- 후보는 guided에서만 묻는다. 새로 표시된 중복 후보 쌍(이전에 묻지 않은 것)과 기존 작품 이전 1회만 `ledger-merge` 요청으로 묻고, 결과는 `.vibelore/ledger/merge-candidates.json`에 두어 `lore_configure` 응답의 `mergeCandidates`로 보여 준다. auto는 묻지 않는다.

## 5. 반영 · 커밋 · 롤백

- `reduceStoryState(prev, delta)`가 `ledgerOps`를 적용해 `ledger`·`hooks`를 만든다. 순수 함수.
- 커밋: `events.jsonl`에서 `chapter ≥ N` 줄 제거 후 N화 사건 추가(재커밋 멱등).
- 롤백: `chapter > N` 줄 제거.
- 재생성: 1..N화 `artifacts/N.json`의 `ledgerOps`로 로그 재구성. 로그와 커밋된 화가 어긋나면 `lore_status`가 보고하고 `lore_sync`가 재생성.
- 구현 조정: 원본은 화별 delta다. `events.jsonl`은 커밋·롤백·동기화 때마다 delta 재생으로 통째로 다시 만들며(줄 단위 절단이 아님), 같은 delta에서 바이트 단위로 같은 결과가 나온다.
- 구현 조정: `entities.json`은 기존 읽기 경로(엔티티 문맥, 언급 활성화)를 위해 커밋 때 등록부로부터 다시 쓴다(`ledgerEntitySnapshots`). 추출은 `entityOps`를 쓰지 않는다.

## 6. 사용처

| 요청 | 받는 것 |
|---|---|
| 추출 | 4.1 |
| 초고·수정 작가 | 관련 기록의 현재 값·최근 사건. `lastEventAt`이 오래된(기본 20화 이상) 기록이 계획이나 초점에 다시 나오면 이력 요약(최대 5개) |
| 화 계획 | `open` 떡밥, 오래된 `dormant` 떡밥, `pending` 예정 사건 |
| 검사(코드) | 3.5, 3.6 결정론 규칙, 파괴된 대상 재등장(등록부 기준), 인물 전용 별칭 |
| 검사(모델) | 작가 정의 자연어 규칙 구역(기존 검토 요청 안) |
| 기억 검색 | 사건 `note` 색인 |

모든 입력은 기존 필터·상한 안에 있다. 예외는 `pinned`와 계획의 떡밥뿐이고, 이력 요약은 5개 상한.

## 7. 기존 작품 이전

1. 재생(결정론): 1화부터 옛 delta를 `ledgerOps`로 변환해 반영.
   - `trackedEntityOps` → `trackedRecordKey`로 등록/사건. 종류 매핑: Artifact·Clue → `objects`, KnowledgeMatrix·RegressionKnowledge → `knowledge`, Timeline → `target:"chapter"` 화 메모. 구현 조정: RelationshipState·PowerSystem은 옮기지 않는다(관계는 관계 상태, 힘의 규칙은 세계 설정).
   - 구현 조정: 옛 상태(`ledger` 키 없음)의 작품은 delta 재생이 끝난 등록부를 다음 화의 기준으로 쓴다. 로그·현재 등록부·병합·새 `ledgerOps`가 같은 ID 체계를 쓰기 위해서다.
   - 떡밥 변화 → 이전 상태와의 `phase` 차이로 사건(`planted`/`advanced`/`paid`/`parked`), 차이가 없으면 `mentioned`.
   - `entities.json` 초기 등록 → 0화 `registered`.
2. 병합 후보: 작품마다 모델 요청 1건으로 같은 대상 묶음 제안 → 사용자 승인분만 `merged`.
3. 스크래치 사본으로 먼저 실행해 결과 보고. **실제 `works/` 적용은 별도 확인 후.**
4. 이전하지 않은 작품은 읽기 시 변환해서 계속 열린다.

## 8. 테스트

- 반영: 사건 적용, 전이 규칙, `restored`·`reopened`, `paid` 근거 확인
- 중복 판정: 정확 일치 → 사건 전환, 유사 → 후보, **필터로 가려진 기록도 검출**
- 인물 전용 별칭, `monotonic`/`frozenAfter`/`speakerOnly`, `pinned` 입력 포함, 끈 기능 미요청
- 로그: 재커밋 멱등, 롤백 절단, 재생성 = 누적
- `test/long-run-inputs.test.js` 가드를 등록부로 확장(300 vs 1000화, 이력 요약 5개 상한)
- 입력 필터 실측을 테스트로 고정: 최근 사건이 있었던 떡밥 포함
- 이전: 고정 픽스처 작품의 재생 결과 스냅샷
- ko·multilingual 문구

## 9. 작업 순서 (단계마다 테스트 통과 상태로 커밋)

1. 엔진 데이터 모델·반영·전이 규칙 (기존 구조와 병행)
2. `events.jsonl` 저장·커밋·롤백·재생성·상태 점검
3. 추출 프롬프트·파싱(`ledgerOps`)·중복 판정·근거 확인
4. 입력 렌더(추출·작가·계획·검사)·이력 요약·최근 사건 규칙
5. 검사: 파괴 대상, 인물 전용 별칭, 작가 정의 규칙, 자연어 규칙 구역
6. `lore_configure` `tracking`·`customTracking`, 장르별 분기 제거
7. 이전(재생 + 병합 후보)
8. 문서·CHANGELOG, Codex 리뷰
