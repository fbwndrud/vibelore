# 운영과 복구

한국어 | [English](OPERATIONS.en.md)

호스트 AI·연동 개발자를 위한 상세 절차입니다. 일반 사용자는 먼저
[문제 해결과 백업](TROUBLESHOOTING.md)의 요청 예시를 이용하세요.

## 공유 세계의 정의 확장

`lore_registry`는 소설과 독립된 세계 디렉터리를 사용합니다. `status → search → register`로
기존 정의를 재사용하거나 검증된 새 정의를 추가하고, `resolve`는 정확한 등록부 판본을 고정합니다.
호스트 AI의 자동 추가 범위와 실패 대응은 [SharedLore 등록부 계약](reference/SHARED_LORE_REGISTRY.md)을 따릅니다.
실제 원문·상태 채택은 `lore_universe`의 propose/decide, 작품 연결은 `lore_bind`의 inspect/apply입니다.
연결한 작품은 해당 판본과 장면 시점을 집필·검사·확정 입력에 고정합니다. 세계 변경만으로 연결을 갱신하지 않습니다.
[채택·작품 연결·복구 계약](reference/SHARED_LORE_RUNTIME.md)을 따릅니다.

## 웹툰 작업 재개·수정

웹툰은 `lore_workflow_status(lane="webtoon",workflowId="wt-...")`로 현재 단계를 읽습니다.
기본 경로(`lore_webtoon_scene`)에서 미완료 모델 요청은 실제 요청 ID로 `lore_resume`,
검증·검토 불합격은 관측 결함을 `feedback`으로 담아 `action="revise"`로 재개합니다.

컷별 경로(`lore_webtoon_plan`/`render`/`decide`, deprecated)는 이미 시작된 작업만 다음처럼
이어갑니다. 사용자 질문은 같은 workflow의 `lore_webtoon_plan(responses=...)`, 승인은 현재
`lore_webtoon_decide(approvalId=...)`로 답합니다. 조판 실패는 render의 `retry=true`로
재개합니다. 조판만 고치려면 `lettering`, 구도 러프는 `storyboard`, 사건·대사·컷 구성은
`adaptation`으로 수정 범위를 구분합니다.

세부 상태와 반입 계약은 [웹툰 안내](reference/WEBTOON_WORKFLOW.md#상태에-따라-이어가기)를 따릅니다.
실제 이미지를 못 열었다면 미완료 근거를 남기며, `.vibelore/`를 고쳐 승인을 우회하지 않습니다.
(컷별 경로) `webtoon/` 손수정은 diff와 의도를 확인한 뒤 `adoptEdits=true`로 재검토합니다. 장면 경로는 `webtoon/`에 쓰지 않습니다.
소설 rollback은 웹툰 회차의 되돌리기 도구가 아닙니다. 원작 판본과 후보·승인 이력은 별개로 보존합니다.
소설을 되돌려도 웹툰 상태·publication과 그 작업에 연결된 모델 감사·대기 요청은 유지합니다.
중단된 rollback 재개에서도 같은 경계를 지키며 이전 소설의 승인·대기 요청은 복원하지 않습니다.

이 문서의 `lore_workflow_inspect`, `lore_rewrite`, `lore_refold` 절차는 개발자용 고급
MCP 표면이 필요한 수동 복구입니다. 일반 집필과 승인에는 기본 표면의 `lore_write`,
`lore_decide`, `lore_workflow_status`, `lore_workflow_history`를 사용합니다.

## 상태를 먼저 읽기

```mermaid
flowchart TD
    Q{무엇이 궁금한가?}
    Q -->|작품 전체 진행| S[lore_status]
    Q -->|집필이 어디서 멈춤| W[lore_workflow_status]
    Q -->|왜 그렇게 됨| H[lore_workflow_history]
    Q -->|영수증·상세 상태| I[lore_workflow_inspect]
    Q -->|설계 승인 상태| P[profile/story/writer/arc/episode status]
    Q -->|복구 지점| SS[lore_snapshot_status]
```

오류가 났을 때 같은 생성 도구를 반복 호출하기 전에 상태 도구를 먼저 호출합니다.

## 정상 집필 운영

1. `lore_arc_status`에서 활성 아크와 다음 비트를 확인합니다.
2. `lore_write(autonomy="guided")`를 호출합니다.
3. `needs_model`이면 같은 `runId`로 `lore_resume`합니다.
4. 원고와 검사 결과를 읽습니다.
5. 승인하면 `lore_decide(action="approve")`합니다.
6. `lore_status`에서 다음 화와 아크 커서를 확인합니다.

`auto`도 검사 단계를 생략하지 않습니다. 필수 검토가 정상 완료된 경우 최종 사용자 승인만 생략합니다. 검토 실패 시 `CRITIC_INCOMPLETE`와 함께 같은 원고를 승인 대기로 보존합니다.

## 실패 복구표

| 결과·증상 | 원인 | 복구 |
|---|---|---|
| `needs_model` | 호스트 모델 작업 대기 | request별 답을 만들어 `lore_resume` |
| `CRITIC_INCOMPLETE` | 필수 검토 실패·불완전 응답·시간 초과 | 보존된 원고와 검토 기록을 보여주고 `lore_decide`로 승인·수정 요청·보류 |
| `clean_fail` | 검사 3회(그 사이 수정 최대 2회) 또는 검사 예산 3회 후 필수 gate 실패 | inspect로 위반 확인(`detail="full"`이면 `draftProse` 포함), 같은 원고 재검사는 `retryValidation=true`, 계획·계약 수정이나 `lore_sync` 뒤에는 `lore_write`가 같은 원고를 재검사, 새 초고는 좁힌 `instruction`으로 `lore_write` |
| 활성 ArcPlan 없음 | 본문보다 아크가 먼저 필요 | `lore_arc_plan(review)` 후 승인 |
| profile/spine/skill 없음 | 작품 설계 단계 누락 | 해당 status 확인 후 누락 단계 생성 |
| stale HEAD 또는 identity | 실행 중 정본·계획 변경 | 기존 영수증·승인 폐기, 보존 원고를 최신 계약으로 재검사(`lore_write`) |
| `CONTEXT_BUDGET_EXCEEDED` | 필수 계획·정본이 입력 예산 초과 | 중복 정본 정리 또는 정책 예산 조정 |
| `CANON_MEMORY_CONFLICT` | 검색 기억과 정본 불일치 | 검색 투영 재생성, 정본 확인 |
| `UNSAFE_MEMORY_CLAIM` | 잘못된 schema·제어 문자·지시문 | claim 격리, 원천 데이터 수정 |
| 검사 영수증 불일치 | 검사 후 본문 변경 | 변경된 본문을 다시 검사 |
| `lore_status`의 `ledgerLog.ok=false` | 이력 로그가 커밋된 화·추적 설정과 어긋남 | `lore_sync(action="validate")`로 다시 만들기 |
| runId 없음·만료 | 저장 실행이 완료·삭제됨 | workflow status 확인 후 새 실행 또는 워크플로 재개 |

## `needs_model` 복구

```mermaid
flowchart LR
    N[needs_model] --> A{모델 답을 만들 것인가?}
    A -->|예| R[lore_resume + answers]
    A -->|아니오| D[답을 멈추고 사용자에게 보고]
    R --> N2{추가 요청?}
    N2 -->|예| R
    N2 -->|아니오| C[완료 결과]
    D --> G[deterministicResult만 남고 workflow는 awaiting_model]
```

`lore_write`는 의존 관계가 없는 요청을 한 왕복에 묶어 반환합니다. 초고 뒤 시도마다 대체로
①추출·프로필 검사·독립 검토 묶음 → ②의미 연속성 검사(추출 결과 필요)와 아크 검토 →
③제목·요약·경계 판정(같은 최종 본문을 읽음) → ④언어 준수 증명(제목·요약을 검사하므로 그다음)의
네 왕복이며, 화 계획과 초고를 더하면 수정이 없는 화는 6왕복입니다. 작품 정체성(story identity)이 아직
없으면(보통 1화) 그 왕복이, 1화는 pilot contract 왕복이 더해질 수 있습니다. 계획에 제목이 있으면 ③에서 제목 요청이
빠질 뿐 왕복 수는 같습니다. 한 응답의 `requests`는 서로 독립이므로 병렬로 답하고
모든 답을 한 번의 `lore_resume`에 넘깁니다. 이 묶음들은 이번 화 본문을 공통 자료 블록으로
앞에 두므로([프롬프트 캐시](#프롬프트-캐시와-warm-first)), 요청마다 새 프로세스나 API 호출로
답하는 호스트는 `promptCache.warmFirst=true`인 요청을 먼저 보내고 첫 출력이 시작된 뒤
나머지를 병렬로 보냅니다. 회차 계획의 선택 모듈(agenda·reveal)은
커밋과 같은 검증기를 계획 단계에서 통과해야 하며, 누락 시 `episode-plan-repair` 요청이
한 번 발급됩니다. 계획이 초고 단계의 Writer Packet 상한(4000 토큰, 본문 길이와 무관한 계획 요약의 최장)을 넘을 때도 같은
요청으로 문장을 줄인 계획을 한 번 받고, 그래도 초과하면 계획 단계에서
`EPISODE_PACKET_OVERFLOW`로 멈춥니다.

언어 준수 증명이 실패하면(`OUTPUT_LANGUAGE_MISMATCH`) 근거가 저장되고 다음 시도에 수정 왕복이
더해집니다. 본문에 근거가 있으면 hard 위반으로 필수 수정(revise)을, 제목·요약에 근거가 있으면
`chapter-language-repair`를 먼저 요청한 뒤 언어 준수 증명을 다시 받습니다. `semanticDelta`에 근거가 있으면
추출과 의미 검사를 다시 합니다. 실패마다 검사 3회 중 1회를 쓰며, 다음 검사 요청에는 이전 근거가 함께 실립니다.

빈 `answers`는 소설·웹툰 어느 쪽에서도 작업을 끝내지 않고 같은 요청을 다시 돌려줍니다. 답을 멈추면
소설·설계 도구는 `needs_model` 응답의 `deterministicResult`가 유일한 결과입니다. `lore_write`에서는 멈춘
workflow 식별 정보(`preview`, `workflowId`, `chapter`)뿐이며 워크플로는 `awaiting_model`로 남습니다. 웹툰 응답에는
`deterministicResult`가 없고 같은 단계에서 대기하며, 지금까지의 결과는 `lore_workflow_status(lane="webtoon")`로 봅니다. 일반 재개에서는 실제 요청에 답하며 검토 생략 수단으로 사용하지 않습니다.

호스트가 request의 `system`과 `user`를 바꾸지 않고 답을 생성해야 합니다. 답 ID를 임의로
새로 만들지 않습니다.

## `clean_fail` 대응

`clean_fail`은 저장 실패가 아니라 품질 gate가 정식 커밋을 막은 상태입니다.

`clean_fail` 원고는 workflow에 보존됩니다. 인자 없이 `lore_write`를 다시 부르면 모델을
호출하지 않고 같은 `clean_fail`을 돌려줍니다.

1. `lore_workflow_inspect`로 hard violation과 점수를 확인합니다. 보존 원고는
   `detail="full"`일 때 `draftProse`로 함께 옵니다.
2. 분량, 정본 충돌, 아크 의무 누락 중 원인을 분리합니다.
3. 원고와 계약을 그대로 두고 검사만 다시 받으려면 `lore_write(retryValidation=true)`를 씁니다.
   새 검사 epoch와 3회 예산으로 같은 원고를 검사합니다. 계획·계약이 바뀌었다면 4와 같이 동작합니다.
4. 아크나 회차 계획을 고쳤거나, 손수정을 `lore_sync`로 발행했거나(`WORKING_TREE_DRIFT` 뒤),
   `STALE_WORK_CONTRACT`를 받았다면 `lore_write`를 다시 부릅니다(`retryValidation`은 있어도
   없어도 됩니다). 새 초고 없이 같은 원고를 현재 정본·계약으로 다시 검사합니다.
   - `clean_fail` 원고, 승인 대기 중인 guided 원고, 자동 커밋이 실패한 `ready_to_commit`
     원고에 모두 적용됩니다.
   - 이전 영수증과 승인은 무효입니다. 새 영수증과 새 3회 예산으로 검사하며(예산을 소진한
     `clean_fail`도 새 예산을 받습니다), hard 위반은 예산 안에서 최소 수정합니다.
   - 통과하면 `guided`는 다시 승인을 묻고 `auto`는 커밋합니다. 단, 사용자 승인을 기다리던
     원고는 호출이 `auto`여도 `guided`로 유지되어 `lore_decide`를 거칩니다.
   - `lore_decide(action="request_revision")`로 요청한 수정이 남아 있었다면 그 피드백을
     새 workflow가 이어받아 보존 원고에 적용한 뒤 검사합니다.
5. 사용자 의도가 바뀌었다면 좁힌 새 `instruction`으로 `lore_write`를 부릅니다. 새
   `instruction`이 있거나 보존 원고가 없을 때만 같은 화를 새 workflow에서 처음부터 다시 씁니다.
6. 아크 자체가 문제라면 원고를 억지로 고치지 말고 아크 계획을 다시 검토한 뒤 4를 따릅니다.

아무것도 바뀌지 않았다면 인자 없는 `lore_write`는 모델을 부르지 않고 보존 원고를 그대로
돌려줍니다.

재검사·수정 이어받기·새 초고는 모두 새 workflow에서 진행하며 이전 workflow를 지우지 않습니다.
이전 workflow는 `clean_fail`로 남고 이벤트 기록에 `workflow_superseded`(`mode`: `revalidate`,
`revise` 또는 `redraft`)가 붙습니다. 새 workflow의 `supersedes`가 이전 ID를 가리키고, 원고를
물려받았다면 `inheritedDraft.proseHash`가 그 원고를 가리키므로
`lore_workflow_history(workflowId=...)`로 두 시도를 모두 감사할 수 있습니다.

## 앞 화 수정

```mermaid
sequenceDiagram
    participant H as Host
    participant V as vibelore
    H->>V: lore_rewrite(chapter, intent)
    V-->>H: 수정 초안
    H->>V: lore_check(수정 초안)
    V-->>H: 검사 결과 / needs_model
    H->>V: lore_commit(검사된 동일 본문)
    H->>V: lore_refold(fromChapter)
    V-->>H: 이후 상태 재계산 결과
```

`lore_refold`를 생략하면 뒤 화 본문은 남아 있어도 StoryState가 옛 정사 기준일 수 있습니다.

## 전체 rollback

1. `lore_snapshot_status`로 복구할 회차를 확인합니다.
2. 복구하면 이후 집필과 승인 대기가 보관 영역으로 이동한다는 점을 사용자에게 보여 줍니다.
3. 양의 정수 `chapter`와 작품의 `workId`로 `lore_rollback`을 호출합니다.
4. 결과의 archive 경로, 복구된 화수와 `lore_status`의 다음 화 번호를 확인합니다.

버전 2 snapshot의 작품·회차·파일 목록·해시를 모두 검사한 뒤 복구합니다. 누락된 파일,
변조된 자료, 심볼릭 링크, 잘못된 회차 인자는 현재 원고를 변경하지 않고 거부합니다.
복구 결과는 새 Published HEAD로 발행하며, 정본·설계·상태·변경 감지 기준을 맞춥니다.
이전 승인, 모델 요청, 검사 영수증과 검색 캐시는 복원하지 않습니다. 원본은
`.vibelore/rollback-archives/<archiveId>/before/`에 보존합니다.
추적 설정·작가 정의 항목·승인한 병합(`review-policy.json`)과 아크 요약도 그 회차 시점으로
복원하며, 이야기 등록부의 이력 로그는 복원된 화들로부터 다시 만듭니다. 병합 후보 목록은 보관 영역으로 옮겨지고,
`guided`에서 필요하면 다시 묻습니다.

복구 도중 프로세스가 중단되면 `.vibelore/rollback-pending.json`과 검증된 복구 자료가
남습니다. 같은 프로젝트로 다음 MCP 도구를 호출하면 복구를 먼저 마무리합니다.
완료할 수 없으면 해당 호출이 실패하며, 이후 작업을 이어가지 않습니다. 디스크 오류를
해결한 뒤 다시 호출하세요. journal·archive·publication을 수동으로 삭제하지 마세요.
자동 재개는 프로세스 중단 대응이며 독립적인 파일 백업을 대신하지 않습니다.

과거 버전의 snapshot은 Published HEAD가 없어 안전하게 자동 복구할 수 없습니다.
`INVALID_SNAPSHOT`으로 거부되면 원본 작품 디렉터리를 먼저 별도 백업하고,
옛 snapshot의 `canonical/`을 **새로운 빈 작품 디렉터리**에 복사하여 수동으로 이어받습니다.
기존 `.vibelore/`와 섞거나 manifest 번호만 바꾸지 마세요. 새로운 작품에서 설정과 회차를
재검사하고 재발행해야 새 형식의 snapshot이 만들어집니다.

한 작품에는 여러 MCP 서버가 동시에 쓰지 못하도록 프로젝트 잠금을 사용합니다.
살아 있는 다른 서버가 작업 중이면 `PROJECT_BUSY`를 반환하며, 종료된 서버의 잠금은
다음 호출에서 회수합니다. 네트워크 공유 파일시스템은 지원하지 않습니다.

앞 화의 문장만 수정할 때는 전체 rollback보다 rewrite/refold 흐름을 사용하세요.

## 정본을 손으로 고친 뒤

- `world/`, `characters/`, `chapters/`는 직접 수정할 수 있습니다.
- `.vibelore/`는 직접 수정하지 않습니다.
- 저장된 앞 화를 바꿨다면 검사·커밋 경로와 refold가 필요합니다.
- 진행 중 워크플로가 있으면 stale이 됩니다. 상태를 확인하고 새 실행을 시작합니다.

## 이야기 등록부와 추적 설정

매 화 추출한 물건·지식·예정 사건·떡밥은 작품 전체에서 **하나의 등록부**로 관리합니다.
같은 대상은 처음 등록될 때 받은 ID 하나로 이어지고, 화마다 있었던 일은 이력으로 남습니다.
그래서 오래전에 나온 물건이 다시 등장해도 그 이력을 알고 이어 쓸 수 있습니다.

### 기록과 떡밥

| 기능 | 추적 대상 | 상태 |
|---|---|---|
| `objects` | 물건·장소·단서·능력 등 | `active` · `lost` · `destroyed` · `retired` |
| `knowledge` | 누가 무엇을 아는가 | `secret` · `partial` · `public` · `retired` |
| `scheduled` | 일어나기로 된 일(회귀 전 사건, 예언, 예약된 일정) | `pending` · `prevented` · `happened` · `altered` · `retired` |
| `hooks` | 독자에게 한 약속(떡밥) | `open` · `dormant` · `paid` · `closed` |

- 기록마다 이름, 별칭, 자유 라벨(물건·단서 같은 분류, 동작에는 영향 없음), 현재 값, 최근 사건 3개를 둡니다.
- 처음 등장한 화에 이미 부서졌거나 저지된 것은 그 상태로 등록합니다. 상태가 바뀌면서 함께 바뀐 값(비밀이 드러나며 아는 사람)도 같은 사건에 남습니다.
- 떡밥 상태: `open`은 독자가 기다리는 중, `dormant`는 잠시 쉬는 중, `paid`는 회수됨,
  `closed`는 더 다루지 않음입니다. 회수한 떡밥을 다시 쓰면 `open`으로 다시 열립니다.
  회수에는 이번 화 본문에서 그대로 인용한 근거가 필요하며, 근거가 없으면 회수 대신 진전으로 기록합니다.
  잠복·회수된 떡밥이 다시 나오면 새 떡밥으로 심지 않고 같은 ID로 다시 엽니다(추출 입력에 관련된 잠복·회수 떡밥도 ID와 함께 보입니다).
  지나가듯 언급만 한 떡밥은 움직인 것으로 치지 않아, 오래 방치된 떡밥 목록에서 빠지지 않습니다.
  예전 작품의 `planted`·`advancing`은 `open`, `parked`는 `dormant`로 읽습니다.
- 모델 입력에는 관련 기록의 현재 값과 최근 사건만 들어가므로 화 수가 늘어도 커지지 않습니다.
  20화 넘게 움직이지 않던 기록이 계획이나 본문에 다시 나오면 이력 최대 5줄을 함께 보여 줍니다.

### 이력 로그

화별 사건은 `.vibelore/ledger/events.jsonl`에 한 줄에 하나씩 남습니다. 원본은 커밋된 화의
추출 결과이고, 재생은 1화 전의 시작 기록(`.vibelore/ledger/seed.json`)에서 출발해 각 화를 그 화가
커밋될 때의 추적 설정으로 다시 반영합니다. 그래서 재생 결과와 현재 등록부가 같습니다.
커밋은 로그 끝에 그 화의 사건만 덧붙이고, rollback·refold·`lore_sync`나 추적 설정·병합이 바뀐 뒤에는
처음부터 다시 만듭니다. 직접 수정하지 않습니다.

`built.json`에는 사건 줄 수와 시작 기록·추적 설정·화별 추출 결과의 digest가 남습니다. 로그 파일이 없거나,
줄 수가 다르거나, digest가 맞지 않으면 `lore_status`의 `ledgerLog.ok`가 `false`입니다.
`lore_sync(action="validate")`로 다시 만드세요(`lore_write`도 시작할 때 다시 만듭니다).
기억 검색은 사건 메모도 색인합니다.

`seed.json`은 `lore_create`가 만든 시작 물건입니다. `entities.json`은 커밋마다 등록부에서 다시 쓰이므로
재생의 출발점이 될 수 없습니다. 이 파일 없이 만든 작품은 처음 필요할 때 한 번 만듭니다. 1화 전이면
`entities.json` 그대로, 이미 쓴 화가 있으면 1화 전에 등록된 항목을 시작 상태(`active`)로 되돌려 씁니다
(값은 그 시점 `entities.json`에 있던 것).

### 추적 켜고 끄기

`lore_configure(tracking={objects, knowledge, scheduled, hooks})`로 기능별로 켜고 끕니다.
기본은 모두 켜짐입니다. 끈 기능은 추출 요청에서 빠지고, 검사하지 않고, 실패로 보지 않으며,
기존 기록은 지우지 않고 모델 입력(`lore_context` 포함)에서만 뺍니다. 장르에 따라 추적 종류가 달라지지 않습니다.
설정 변경은 다음에 쓸 화부터 적용되고(`review-policy.json`의 `trackingHistory`에 적용 화와 함께 남음),
이미 쓴 화의 이력은 그대로 남습니다. 변경 이력이 없는 기존 설정은 1화부터 적용된 것으로 봅니다.

### 작가 정의 추적 항목

`lore_configure(customTracking=[...])`는 작가가 꼭 지키고 싶은 항목의 **전체 목록**을 교체합니다.

```json
{ "name": "금화 잔액", "feature": "objects", "pinned": true,
  "rules": [{ "type": "monotonic", "field": "amount", "direction": "down", "unless": "보상" }],
  "note": "리아는 어머니 이야기를 먼저 꺼내지 않는다" }
```

- `pinned`: 입력 상한과 관계없이 추출과 작가 입력에 항상 포함합니다.
- 항목은 ID(`u1`)나 이름·별칭이 같은 기존 기록에 연결됩니다. 이미 `o3`로 등록된 것을 나중에 항목으로 추가해도
  핀·규칙이 그 기록에 적용됩니다. 아직 기록이 없는 항목은 추출·계획·집필 입력에 "추적 요청(아직 기록 없음)"으로
  보이고, 추출기는 등장하면 그 ID로 기록합니다.
- `rules`(결정론 검사, 기본 soft, `"severity": "hard"`로 hard 지정 가능):
  - `monotonic{field, direction: up|down, unless?}`: 숫자 값이 한 방향으로만 바뀝니다.
    사건 메모에 `unless`의 말이 있으면 예외입니다.
  - `frozenAfter{status}`: 그 상태가 된 뒤에는 바뀌지 않습니다.
  - `speakerOnly{alias, by}`: 그 호칭은 지정한 인물만 씁니다.
- `note`: 자연어 규칙입니다. 새 모델 요청을 늘리지 않고 `coherence-judge` 검토가 항목 ID별로 함께 판단하며,
  어긋나면 `AUTHOR_RULE` advisory로만 보고합니다. 응답에 규칙 판정이 아예 없으면 그 검토를 미완료로 기록해
  `auto`는 승인 대기로 내려갑니다. `disabledReviews`로 `coherence-judge`를 끄면 판단하지 않습니다.

항목 ID(`u1`, `u2` …)는 이름으로 유지되고, 지운 항목의 ID는 다시 쓰지 않습니다.
잘못된 기능 이름이나 규칙에 필요한 값이 빠진 항목은 거부합니다.

### 인물 전용 별칭

별칭에 인물(`by`)이 붙으면 그 인물만 쓰는 호칭입니다. 그 인물이 이번 화 등장인물에 없는데
호칭이 본문에 나오면 soft로 알리고, 설정 검사의 호칭 구역에도 넣어 누가 말했는지 모델이 확인합니다.
계획·집필 입력에도 보이는 기록마다 한 줄로 누가 쓰는 말인지 적습니다.

### 중복 기록과 병합

- 같은 기능 안에서 이름이 정확히 같으면(공백·따옴표·대소문자 차이만) 새 기록을 만들지 않고 기존 기록의 사건으로 이어 붙입니다.
- 이름이 비슷하면(포함 관계, 조사 차이, 단어 겹침) 새 기록으로 등록하고 중복 후보로 표시합니다(`LEDGER_POSSIBLE_DUPLICATE`, soft). 자동으로 합치지 않습니다.
- `guided`에서는 새로 표시된 후보 쌍이 생긴 화에만 `lore_write`가 `ledger-merge` 모델 요청 1건을
  함께 보냅니다. 이미 물어본 쌍은 다시 묻지 않습니다. `auto`는 묻지 않습니다.
- 제안은 `guided` 승인 대기 결과(`awaiting_approval`)와 `lore_configure` 응답의 `mergeCandidates`(`{into, from[], reason}`)에
  나옵니다. 원고와 함께 사용자에게 보여 주고, 승인한 것만 `lore_configure(mergeRecords=[{from, into}])`로 넘깁니다(`from` ID마다 한 항목).
- 병합 요청에는 기록마다 상태·등록 화·마지막 사건 화가 들어가며, `into`는 먼저 등록된 기록입니다.
  기존 작품의 첫 요청은 후보 쌍의 기록부터, 최근에 움직인 순으로 최대 150개만 묻습니다.
- 승인한 병합은 다음에 쓸 화부터 적용됩니다(`atChapter`). 그 화의 추출·집필 입력에는 이미 합쳐진 기록이 보이고,
  이미 쓴 화의 이력은 나뉜 그대로 남습니다. 합친 기록은 `into`의 ID와 이름을 쓰고, 상태와 값은 마지막 사건이
  더 늦은 기록을 따르며(값은 항목별로), 등록 화는 더 이른 쪽입니다. 흡수된 ID는 이후 `into` 기록으로 읽히고 두 기록의 이력은 함께 보입니다.

### 기존 작품

등록부 이전에 쓴 작품은 별도 작업 없이 이어집니다. `lore_write`가 커밋된 화의 추출 결과를
1화부터 다시 반영해 이력 로그와 등록부를 모델 호출 없이 만들고, 다음 화는 그 결과 위에서 씁니다.
예전 추적 항목은 `objects`·`knowledge` 기록으로, 화별 사건 목록으로 쓰이던 `Timeline`은 화 메모로
옮깁니다. `RelationshipState`·`PowerSystem`은 옮기지 않습니다(관계는 인물 관계 상태에, 힘의 규칙은
세계 설정에 있습니다). `guided`에서는 처음 한 번 전체 기록을 대상으로 병합 후보를 묻습니다.
`world/`·`characters/`·`chapters/`는 바뀌지 않습니다.

업그레이드 전에 검사를 마치고 승인 대기 중이던 화는 검사 영수증이 무효가 되어 한 번 다시 검사합니다.

### 무엇이 hard인가

| 심각도 | 경우 |
|---|---|
| hard | 파괴된(`destroyed`) 기록의 값·상태 변경(`LEDGER_UPDATE_AFTER_DESTROY`), 이유 없는 복구(`LEDGER_RESTORE_NOTE_REQUIRED`), `severity:"hard"`로 지정한 작가 규칙 |
| soft | 중복 후보, 모르는 ID, 본문에 이름이 없는 사건, 근거 없는 회수, 닫힌 떡밥 재사용, 끝난 예정 사건의 `pending` 복귀, 인물 전용 별칭, 파괴된 기록의 재언급(회상일 수 있음), 작가 규칙 기본값, `AUTHOR_RULE` |

앞의 두 hard는 대개 추출 실수라서 먼저 추출을 한 번 다시 합니다. 다시 해도 같으면 수정 대상
위반으로 넘어갑니다. soft는 작가의 의도일 수 있으므로 자동으로 고치지 않고 사용자에게 보여 줍니다.

## 연결 문제

### 도구가 보이지 않음

- 설정의 `command`가 실제 `node` 실행 파일을 찾는지 확인합니다.
- `args`가 `src/server.js`의 절대 경로인지 확인합니다.
- 호스트를 재시작해 MCP 목록을 다시 읽습니다.
- Node.js 22.13.0 이상인 22.x, 24.x 또는 26.x인지 확인합니다.

### 시작 timeout

Codex 예시:

```toml
[mcp_servers.vibelore]
command = "node"
args = ["/absolute/path/to/vibelore/src/server.js"]
startup_timeout_sec = 30
tool_timeout_sec = 6000
```

장편 생성은 60초보다 길 수 있으므로 tool timeout을 충분히 둡니다.

### 직접 handshake

호스트 문제와 서버 문제를 분리할 때만 사용합니다.

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node /absolute/path/to/vibelore/src/server.js
```

`serverInfo.name`이 `vibelore`이고 `tools`에 `lore_write`가 있으면 서버 표면은 정상입니다.

## 로컬 모델 문제

```bash
VIBELORE_LOCAL_BASE_URL=http://127.0.0.1:11434/v1
VIBELORE_LOCAL_MODEL=qwen3:14b
```

- 두 환경 변수를 MCP 서버 프로세스에 함께 전달합니다.
- endpoint는 OpenAI 호환 `/v1/chat/completions`를 제공해야 합니다.
- 설정하지 않으면 호스트 릴레이를 사용합니다.
- 모델이 없어도 결정론 검사 경로는 사용할 수 있습니다.

## 백업 대상

작업을 멈춘 뒤 작품 디렉터리 전체를 숨김 파일·이미지까지 포함해 별도 위치에 보관합니다.
Git을 사용한다면 ignore 규칙으로 후보·이미지·실행 기록이 빠지지 않았는지 확인합니다.

| 경로 | 중요도 | 이유 |
|---|---:|---|
| `world/`, `characters/`, `chapters/`, `summaries/` | 필수 | 사람이 편집하는 정본 |
| `webtoon/`, 원본 그림 폴더 | 웹툰 작업 시 필수 | 승인 대본·기준 이미지·완성본과 원본 |
| `.vibelore/webtoon/`, `.vibelore/webtoon-publication/` | 웹툰 작업 시 필수 | 후보·진행 상태·웹툰 승인 이력 |
| `.vibelore/model-exchanges/`, `.vibelore/runs/` | 진행·감사 보존 시 필수 | 실제 요청·응답과 대기 실행 |
| `.vibelore/workflows/` | 진행 중이면 필수 | 재시작 후 워크플로 재개 |
| `.vibelore/check-receipts/` | 권장 | 커밋 감사 |
| `.vibelore/snapshots/` | 권장 | rollback |
| `.vibelore/review-policy.json` | 권장 | 검토·추적 설정, 작가 정의 항목, 승인한 병합 |
| `.vibelore/ledger/seed.json` | 권장 | 재생의 출발점인 1화 전 기록(없으면 `entities.json`에서 근사) |
| `.vibelore/ledger/` 나머지 | 낮음 | 이력 로그는 화별 추출 결과에서 재구축 가능, 병합 후보는 다시 물으면 됨 |
| `.vibelore/memory.db` | 낮음 | 정본에서 재구축 가능한 투영 |

## 릴리스 전 확인

```bash
npm run test:all
git diff --check
```

MCP 표면을 바꾸면 다음을 함께 갱신합니다.

1. `src/server.js`의 tool schema와 dispatch
2. [TOOLS.md](TOOLS.md)
3. [GETTING_STARTED.md](GETTING_STARTED.md)의 호출 예제
4. MCP surface 테스트

## 프롬프트 캐시와 warm-first

프롬프트 캐시는 접두부 일치이며, 캐시 항목은 앞 요청의 응답 스트리밍이 시작된 뒤에야 읽을 수
있습니다. 그래서 같은 접두부의 요청을 동시에 보내면 모두 캐시 쓰기 비용만 내고 재사용은
없습니다. vibelore는 워크플로가 공유를 선언한 자료(현재는 이번 화 본문)가 한 `needs_model`
응답의 요청 둘 이상에 그대로 들어 있을 때만 그 요청들의 배치를 바꿉니다.

| 위치 | 내용 |
|---|---|
| `system` | 실행 조건 한 줄. 묶음 안의 모든 요청이 같습니다 |
| `user` 앞부분 | `[공통 자료 시작 · chapter-prose · sha256:…]`부터 `[공통 자료 끝 · chapter-prose]`까지. 바이트 단위로 같습니다 |
| `user` 뒷부분 | `[이번 요청 역할]`(원래 `system`), `[이번 요청 자료]`(원래 `user`, 본문 자리는 공통 자료 참조 표기), JSON 조건 |

실행 조건과 표지는 작품의 프롬프트 계열을 따릅니다. `ko` 작품은 위 한국어 표지 그대로이고, 다른 언어 작품은
`[Shared material start · …]`, `[Role for this request]`, `[Material for this request]` 같은 영어 표지를 씁니다.
계열은 작품마다 고정이라 한 작품 안에서 공통 접두부는 바이트 단위로 같습니다.

요청에 추가되는 `promptCache` 힌트:

| 필드 | 의미 |
|---|---|
| `layout` | `shared-prefix-v1` |
| `sharedPrefixId` | `system`과 공통 블록의 해시. 같은 값이면 접두부가 같습니다 |
| `sharedPrefixEndMarker` | 공통 블록 끝 표식. `user`를 이 표식 뒤에서 나누면 공통 부분과 단계 부분이 됩니다 |
| `sharedPrefixChars` | 공통 블록 길이(JavaScript UTF-16 단위). 다른 언어에서는 표식으로 나누는 편이 안전합니다 |
| `estimatedSharedTokens` | 토크나이저 없이 낸 하한 추정치 |
| `groupSize` | 같은 접두부를 쓰는 요청 수 |
| `warmFirst` | 먼저 보낼 요청 하나. 추정치가 1024토큰 미만이면 모두 `false`이며 그대로 병렬로 보냅니다 |

최소 캐시 길이는 Claude Opus 5·Opus 5.5가 512토큰, Sonnet 5·Opus 4.8이 1024토큰이며
Opus 4.6·Haiku 4.5는 4096토큰입니다. API 기본 TTL은 5분이고 읽기마다 갱신되므로, 한 묶음을
몇 분 안에 처리하는 워크플로에는 1시간 TTL이 필요하지 않습니다.

호스트별 적용:

- Claude Code CLI(`claude -p`): 캐시 지점이 system 프롬프트와 마지막 user 블록에만 놓입니다.
  공통 블록을 user 안에 둔 채 보내면 접두부가 같아도 읽기가 0입니다(stdin 한 블록,
  stream-json 두 블록 모두 실측 0). `--system-prompt`에 `system` + 빈 줄 + 공통 블록을 넣고
  나머지를 stdin으로 보냅니다. `--output-format stream-json --include-partial-messages`로
  warm-first 요청의 첫 `stream_event`를 받은 뒤 나머지를 시작합니다. 구독 로그인 CLI는 캐시를
  1시간 TTL로 써서 쓰기 비용이 입력의 2배입니다. 한 묶음은 몇 분 안에 끝나므로
  `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`으로 실행합니다(쓰기 1.25배).
- Claude API 직접 호출: 공통 블록을 별도 text 블록으로 나누고 그 블록에 `cache_control`을 둡니다.
- 자동 접두부 캐시를 쓰는 호스트(Codex 등): 배치 그대로 보내면 됩니다. 해당 호스트의 최소
  길이와 라우팅 조건을 따르며 vibelore는 적중을 보장하지 않습니다.
- 한 대화 안에서 직접 답하거나 서브에이전트로 답하는 호스트: 호스트 자체 문맥이 앞에 붙으므로
  이 배치로 얻는 이득이 없거나 작습니다. 병렬 답변 규칙은 그대로입니다.

`lore_write(sharedOnce=true)`를 쓰면 응답의 `sharedBlocks`에 공통 블록을 한 번만 싣고, 각
요청 user 맨 앞의 `promptCache.sharedBlockRef` 문자열(줄바꿈 포함)을 같은 `sharedBlockId` 블록의
`text`로 정확히 바꿔 완성합니다. 완성한 user는 기본 응답과 바이트 단위로 같습니다. 요청을 직접 조립하는 호스트에서
응답 크기를 줄이는 선택 옵션이며, 기본 응답은 요청마다 자기완결입니다.

배치 변경은 표시 방식만 바꿉니다. 요청 ID는 엔진 원 요청의 fingerprint 그대로이고, 감사
기록(`modelExchanges`)은 원 요청을 저장하며, 직접 provider는 이 배치를 보지 않습니다.

## 검토 응답과 감사

1. `needs_model`의 각 요청에서 실제 `system`·`user`와 현재 원고를 읽습니다. 같은 단계라도 원고나 계약이 달라지면 다른 요청입니다. 준비된 점수를 단계 이름에 맞춰 일괄 공급하지 않습니다.
2. 원문에서 관찰한 경험과 승인된 약속의 구현을 구분합니다. 현재 계획을 주지 않은 편집 요청에 별도로 계획을 덧붙이지 않습니다. 미래에 지급할 약속이나 의도적인 지연을 현재 누락으로 단정하지 않습니다.
3. 높은 점수에도 약점이 있으면 findings에 근거를 남깁니다. 취향 의견은 자동 수정 지시로 바꾸지 않습니다. 응답할 수 없거나 검토가 실패했을 때 임의의 통과 점수를 만들지 않습니다.
4. 주어진 요청 ID로 `lore_resume`합니다. 서버는 실제 요청·응답과 원고·계약 해시를 연결합니다. 이 연결은 같은 평가를 재개하는 장치이며 평가자가 성실히 읽었거나 독립적이라는 증명은 아닙니다.
5. 매 화 검토(`story-profile-check`, `coherence-judge`, `editorial-quality`, `character-fidelity`, `reader-hook`, `pattern-ledger`)는 작가를 돕는 선택 기능입니다. 사용자가 원하면 `lore_configure`에 `disabledReviews`로 끌 목록 전체를 넘깁니다. 꺼진 검토는 요청하지 않고 `disabled_by_user`로 기록하며 auto 커밋을 막지 않습니다. `editorial-quality`를 끄면 분량·밀도 조언도 나오지 않습니다. 연속성 추출·검사는 끌 수 없습니다. 초고 요청의 선택 섹션(`older-memory`, `previous-tail`, `author-craft`, `style-anchor`)도 `disabledDraftSections`로 뺄 수 있고, 적용 결과는 `draft_context_supplied.disabledDraftSections`에 남습니다.
6. `lore_workflow_history`와 `quality.review`에서 전체 발견 및 출처를 확인합니다. 같은 호스트 문맥으로 작성·검토했다면 자기검토로 보고합니다. 근거와 실행 경로를 조사할 때만 `includeModelExchanges=true`로 전문을 조회합니다.

`lore_workflow_history` 호출 인자 예시:

```json
{
  "project": "/absolute/path/to/my-novel",
  "workId": "my-novel",
  "limit": 100,
  "includeModelExchanges": true
}
```

`workflowId`를 생략하면 현재 실행을 조회합니다. 과거 실행을 조사하려면 해당 ID를 함께
지정합니다. 전문은 조회한 이벤트에 연결된 것만 반환하므로 필요한 이벤트가 범위 밖에 있으면
`limit`을 늘립니다. 이전 버전에서 저장하지 않은 요청·응답은 소급 복원하지 않습니다.

| 확인할 내용 | 기록 위치 |
|---|---|
| 어떤 취향과 예시가 초고에 들어갔는가 | `draft_context_supplied.draftContract` |
| 높은 점수에도 어떤 약점이 발견됐는가 | `reviews_completed.review.records[].findings` |
| 어떤 원고·계약을 누가 검토했는가 | 검토 record의 `proseHash`, `contractDigest`, `requestId`, `evaluator` |
| 검토가 정상 완료됐는가 | `quality.review.status`, 각 record의 `status`와 `failure` |
| 각 모델 요청에 무엇이 얼마나 들어갔는가 | `needs_model.inputReport`(요청별 절·글자 수·공유 캐시 여부), `lore_workflow_status`의 `workflow.lastInputReport` |
| 초고 연속성에서 무엇이 잘렸는가 | `needs_model.trimmedContext`, `workflow.contextAudit.memory` |
| 사용자가 어떤 검토를 껐는가 | `quality.disabledReviews`, `quality.review.disabled`, record `status: "disabled_by_user"` |
| 실제 요청·응답 전문은 무엇인가 | `modelExchanges`, 이벤트·검토 record의 `exchangeId` |
| 어떤 설치 소스로 실행했는가 | `runtime_identified` |

`CRITIC_INCOMPLETE`는 검토 실행이 완료되지 않았다는 뜻입니다. 원고 자체의 hard 위반과
구분하고, 보존된 원고와 실패 근거를 확인한 뒤 승인·수정 요청·보류를 선택합니다. 승인하더라도
실패 이력은 남습니다. provider 호출의 시간 제한(기본 45초, `VIBELORE_REVIEW_TIMEOUT_MS`)은 서버가
로컬 어댑터를 직접 호출할 때 적용되며, `needs_model` 이후 호스트가 답변을 준비하는
시간을 제한하는 것이 아닙니다.

원고·검토를 공개할 때는 사용자가 공개하려는 자료를 선택해 전후 비교와 수정 이유를 작성합니다. 전체 모델 요청·응답 저장이 대화 전체의 외부 공개 승인을 뜻하지 않습니다. 조건부 자동 문체 재작성 정책은 아직 도입하지 않았습니다.
