# 3회차 비평: 실패 시나리오로 본 실행 계약 결함

## 순위별 결함

### 1. 전송 직전 crash 때 중복 전송 (치명)

**실패 시나리오**
1. worker가 `prepared` 상태의 attempt로 HTTP 요청을 보낸다.
2. 응답을 받기 전에, 그리고 `dispatched`를 기록하기 전에 프로세스가 종료된다.
3. lease가 만료되면 다른 worker가 이 attempt를 아직 보내지 않은 `prepared`로 보고 다시 보낸다. 결과는 이중 청구와 두 개의 candidate다.

**충돌 계약**
- `Attempt: prepared → dispatched`에는 "보내기 시작했으나 결과를 모름"이라는 영속 상태가 없다.
- 문서가 정한 "전송 뒤 timeout은 outcome_unknown" 규칙은 전송 사실이 기록된 뒤에만 작동한다.
- `commandId`가 중복이면 이전 결과를 돌려준다는 규칙도 명시되어 있지 않다.

**최소 수정**
- 네트워크 호출 전에 `dispatching{attemptId, requestDigest, leaseToken}`을 commit한다.
- 복구 시 `dispatching`은 무조건 `outcome_unknown`으로 바꾸고, 자동 재전송 대상에서 뺀다.
- provider가 client request ID를 지원하면 그 값을 `attemptId`에서 만든다.
- 같은 `commandId`가 다시 오면 기존 job/attempt를 반환한다.

**수용 검사**
- fault injection 지점: commit 직후, send 직후, 응답 수신 직후 kill.
- 어느 경우에도 같은 attemptId로 외부 요청이 두 번 나가지 않아야 한다.
- 새 attempt는 사용자 결정이나 명시한 retry policy로만 생겨야 한다.

### 2. 예산 예약에 동시성과 정산 계약이 없음

**실패 시나리오**
- 남은 예산이 10건분인데 TTS command 20건이 동시에 들어온다. 각 job이 같은 snapshot의 잔액을 읽으면 20건이 모두 발급된다.
- 반대 방향의 문제도 있다. `outcome_unknown` 5건이 예약을 무기한 붙잡아, 이후 해당 장면 작업이 영구히 막힌다.

**부재 계약**
- `budgetReservation`이라는 필드만 있고 다음이 정의되어 있지 않다.
  - 예약을 언제, 어떤 transaction에서 잡는지
  - 해제·정산·보류 상태
  - provider 사용량과 대조하는 절차

**최소 수정**
- `BudgetLedger` 항목을 attemptId 키로 둔다.
- `reserve`는 outbox와 같은 SQLite write transaction에서 잔액을 조건부 차감한다.
- 상태는 `reserved → settled(실측) | released(전송 전 확정 실패) | held_unknown`으로 둔다.
- `held_unknown`은 사용자가 "청구된 것으로 간주" 또는 reconciliation으로만 해소한다.
- UI에는 보류 금액을 따로 표시한다.

**수용 검사**
- 20건 병렬 발행 시 10건 이하만 dispatch되는지.
- kill 후 보류 금액이 유지되는지.
- reconciliation이 settled로 전환하는지.

### 3. 승인↔publish가 원자적이지 않고, 기준 판본이 모호함

**실패 시나리오**
- 사용자가 export v1을 승인한다. render 중에 shot 5를 수정한다.
- 이때 두 해석이 모두 가능하다.
  - "검토 중 이미지가 달라지면 완료 불가"를 따르면, 고정된 v1까지 막힌다.
  - "직전 재확인"을 따르면, 확인과 commit 사이에 adoption이 바뀌는 TOCTOU 창이 생긴다.

**충돌 계약**
- `publish transaction 직전에 재확인`이 transaction 바깥 검사로 읽힌다.
- 승인 대상이 고정 manifest closure인지, 현재 working selection인지 정해져 있지 않다.

**최소 수정**
- 승인 대상은 `manifest.closureDigest`(resolved revision과 bytes hash)로 한정한다.
- publish transaction 안에서 다음 세 값이 같음을 CAS로 확인한다: `receipt.closureDigest`, render 입력 digest, 출력 검사 digest.
- working selection이 바뀌어도 고정 manifest의 publish는 막지 않는다. 다만 "현재 편집본과 다름"을 표시한다.
- 출력 파일은 temp → checksum → rename → 등록 순서로 처리한다.

**수용 검사**
- render 중 adoption 변경: v1은 publish되고, v2에는 승인이 없다.
- receipt와 출력 digest가 불일치하면 publish가 거부된다.

### 4. 영역 편집의 좌표 정합과 같은 base 병렬 수정

**실패 시나리오 A (좌표 정합)**
- 원본은 3000×2000이고 EXIF 회전이 있다.
- provider가 1024×1024로 padding 또는 crop한 결과를 돌려준다.
- compositor가 원본 좌표 mask를 그대로 적용하면 수정 영역이 어긋난다.

**실패 시나리오 B (병렬 수정)**
- 같은 base에서 머리 수정 A와 손 수정 B를 따로 만든다.
- A를 채택한 뒤 B를 채택하면 A의 변경이 조용히 사라진다.

**부재 계약**
- "원본 좌표"의 기준(회전 적용 후 decode 크기)이 없다.
- provider 출력 geometry를 원본 좌표로 되돌리는 규칙이 없다.
- 채택 시 `candidate.baseAssetRevision`과 현재 채택본을 비교하는 규칙이 없다.

**최소 수정**
- AssetRevision에 `canonicalPixelSpace`를 기록한다.
- provider 출력의 역변환을 recipe에 저장한다. 비율 불일치가 허용치를 넘으면 composite 경로를 거부한다.
- base가 현재 채택본과 다르면 `stale-base`로 표시하고, 다음 중 하나를 고르게 한다: 결정론 재합성(mask 영역만 현재 채택본 위에 얹기), 재생성, 대체.

**수용 검사**
- 보호 영역(mask와 feather 밖)이 원본과 bit-identical인지 hard byte 검사한다.
- A→B 순차 채택 시 경고가 뜨고, 재합성 결과에 두 수정이 모두 남는지 확인한다.

### 5. 전역 `expectedProjectRevision`로 인한 conflict 폭주

**실패 시나리오**
- 40개 발화 생성이 진행되는 동안 `candidate_ready` event마다 project revision이 올라간다.
- 사용자가 inspector에서 저장할 때마다 conflict가 난다.
- 이를 피하려고 클라이언트가 자동 rebase를 넣으면, 같은 slot 충돌까지 은폐될 위험이 생긴다.

**충돌 계약**
- command는 프로젝트 전역 revision을 요구한다.
- 그런데 "서로 다른 target은 재기반 가능"하다는 규칙의 판정 단위가 없다.

**최소 수정**
- CAS를 aggregate 단위 revision으로 한다(slot adoption, timeline intent, utterance, RoleBinding).
- worker가 쓰는 candidate·attempt 기록은 사용자 의도 aggregate의 revision을 올리지 않는다.

**수용 검사**
- 생성 job 40건이 진행되는 중 다른 shot의 카메라 편집이 conflict 0으로 저장된다.
- 같은 slot에 대한 동시 채택은 한쪽이 거부된다.

### 6. 음성 재생성 시 연속성과 편집 stack

**실패 시나리오**
- u3를 재생성할 때 provider model alias가 갱신되었거나 voice ID가 만료되어 다른 음색이 된다.
- u2와 u4는 digest가 그대로이므로 `review-stale`조차 되지 않는다.
- 이전 take에 쌓인 trim·gain stack이 새 take에 자동 재적용되어, 길이가 다른 음원을 잘라 버린다.

**부재 계약**
- take recipe에 resolved model version이 없다.
- voice 연속성은 stale 사유로 다뤄지지 않는다.
- 재생성 후 operation stack 처리 규칙이 없다.

**최소 수정**
- capability snapshot에 resolved model과 voice 버전을 pin한다. 해석이 불가능하면 `unknown`으로 둔다.
- 버전이 바뀐 재생성은 같은 occurrence의 인접 take를 `review-stale(voice-continuity)`로 표시한다.
- 만료된 voice는 예약 전에 job을 차단한다.
- operation stack은 자동 적용하지 않고 "이전 편집 재적용" 제안으로 둔다.

**수용 검사**
- model snapshot을 바꾼 fixture에서 u3를 재생성하면 u2·u4에 사유가 붙는지.
- 길이가 다른 새 take에 trim이 자동 적용되지 않는지.

## 개선된 점

- subject와 state를 갖는 slot 구조.
- Production override와 IdentityLink.
- `sourceOrigin` 계보를 rebase 영향에 포함.
- import도 byte 검증과 quarantine을 거치며, 가짜 attempt를 만들지 않음.
- `input-invalid`와 `review-stale`의 분리.
- exactly-once 과금을 주장하지 않음.
- semantic review를 advisory로 한정.
- 원작 정본은 vibelore 쪽 승인으로만 변경.

이 경계들은 일관적이며 유지해야 한다.

## 아직 검증되지 않은 것

- 위 실패 지점에 대한 fault injection 전체.
- Google API의 operation lookup과 client request ID 지원 여부.
- native mask 지원 여부와 provider 출력 geometry.
- 실제 비용 reconciliation.
- 40인 UI 성능.
- preview/export 1-frame 동기.
- blob GC와 진행 중 attempt·backup 사이의 race.

모두 실행되지 않았으므로 통과로 표시하면 안 된다.