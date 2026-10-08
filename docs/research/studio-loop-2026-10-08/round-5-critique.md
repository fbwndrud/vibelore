# 5회차 최종 비평: Lore Studio 통합 설계

**판정:** 설계와 prototype 수준에서는 서명할 수 있습니다. backend, provider, 렌더 준비가 끝났다는 서명은 아닙니다.

**근거 한계:** 저는 문서, prototype 소스, 빌더와 검증자가 제출한 기록만 읽었습니다. 브라우저나 API를 직접 실행하지 않았습니다.

## 순위별 결함

### 1. 작업 도중 원천 rebase 시 진행 중 attempt의 처리 규칙이 없음 (높음)
- **실패 시나리오:** 지호 손 수정 job이 v12 패키지로 queued 상태입니다. 그 사이 v13 RebaseDecision이 commit됩니다.
  - queued job이 v12 bytes로 그대로 dispatch되는지, 막히는지 정해져 있지 않습니다.
  - 이미 dispatching된 job의 늦은 결과는 "target의 현재 input digest"와 비교합니다. 그런데 이미지 입력 digest에는 원문 bytes가 없습니다. 그래서 v13에서 표가 사라졌는데도 결과가 stale이 아닌 정상 후보가 됩니다.
- **충돌하는 계약:**
  - `blocked:source-drift`는 "새 source 기반 작업"만 다룹니다.
  - RebaseDecision 영향 목록에는 채택본만 있고 queued, dispatching, unknown attempt가 빠져 있습니다.
- **최소 수정:**
  - Attempt snapshot에 `sourcePackageRevision`과 의존 source span을 기록합니다.
  - Rebase는 dispatch 전 job을 hold 또는 cancel 대상으로 나열합니다.
  - 진행 중인 job의 결과는 구 패키지 후보로 표시합니다. v13 production에 채택하려면 "새 문맥에서 재사용 채택" 결정을 거쳐야 합니다.
- **수용 검사:** dispatch commit과 결과 수신 사이에 rebase를 끼운 fixture를 만듭니다. 결과가 auto-ready 상태로 v13 채택 버튼을 활성화하지 않아야 합니다.

### 2. 승인 재확인 시점이 문서 안에서 서로 다르고, 정책 개정이 승인에 미치는 효과가 없음 (높음)
- **실패 시나리오:** UI가 Edition v1을 승인합니다. 동시에 MCP 명령이 advisory reviewer를 끕니다. 이때 reviewPolicyRevision이 바뀝니다.
- **충돌하는 계약:**
  - 검토 권한 절은 승인 receipt를 adoption/publish "transaction **직전**"에 재확인한다고 씁니다.
  - Edition 절은 "transaction **안에서** CAS"라고 씁니다.
  - "직전" 확인은 TOCTOU 문제를 남깁니다.
  - 꺼진 advisory는 "실패로 다시 추가하지 않는다"고 했지만, 정책 revision이 바뀐 receipt가 무효인지 유지되는지 정의가 없습니다.
- **최소 수정:**
  - 두 경로 모두 transaction 내부 CAS로 통일합니다.
  - 정책을 개정할 때 강화와 완화를 구분합니다.
    - 완화(advisory 끄기)는 기존 receipt를 유지하되 개정 사실을 기록합니다.
    - 강화는 receipt를 무효로 합니다.
- **수용 검사:** UI publish와 MCP 정책 변경을 경합시킵니다. 결과는 둘 중 하나여야 합니다.
  - publish가 conflict를 반환한다.
  - publish가 receipt에 명시된 정책 revision 그대로 성공한다.

### 3. native mask 경로가 보호 픽셀 hard check를 우회할 수 있음 (중상)
- **실패 시나리오:** 얼굴만 수정했는데 provider가 mask 밖의 색을 1 LSB 정도 이동시킵니다.
- **충돌하는 계약:**
  - 문서는 "native mask 지원 시 사용"이라고만 씁니다.
  - "원본 bytes는 compositor가 유지"는 조건부 문장이라, native 출력이 compositor를 거치는지 불분명합니다.
  - `candidate_ready` 게이트는 decode, 형식, checksum만 나열합니다. canonical RGBA 보호 영역 대조가 hard 실패인지, 자동 재합성으로 넘어가는지 정해져 있지 않습니다.
- **최소 수정:**
  - 보호가 요구되는 edit은 native 여부와 관계없이 원본 bytes로 최종 합성합니다.
  - provider의 원출력은 별도 후보로 보존하고 `unprotected` 표식을 붙입니다.
  - 보호 영역(mask와 feather 밖) RGBA 일치를 합성 revision의 hard validation으로 명시합니다.
- **수용 검사:** mask 밖을 미세하게 바꾸는 가짜 provider로 시험합니다. 원출력은 보호 검사에 실패하고, 합성본은 정확히 일치해야 합니다.

### 4. 결과 불명 이후의 재사용 규칙: 캐시와 변형 의도, 회수 경로 (중)
- **실패 시나리오 A:** 같은 prompt로 "다른 표정 하나 더"를 요청합니다. input digest를 캐시 기준으로 쓰면 기존 후보를 반환합니다. 반면 prototype은 sim-r3를 새로 만듭니다.
- **실패 시나리오 B:** UI와 MCP가 서로 다른 commandId로 같은 digest를 동시에 요청합니다. commandId 단위 dedupe로는 막히지 않아 두 번 청구됩니다.
- **실패 시나리오 C:** 동기 API 호출 중 worker가 죽었습니다. 이런 응답은 회수할 수 없는데, prototype은 "늦은 결과 도착"을 보여 줍니다.
- **최소 수정:**
  - 입력에 명시적 `variationNonce`를 넣습니다. 캐시 요청이면 null입니다.
  - 진행 중 요청은 `(inputDigest, nonce)` 기준으로 commandId를 넘어 합칩니다.
  - capability에 따라 unknown 해소 경로를 나눕니다.
    - 비동기 operation 조회가 있으면 후보 회수가 가능합니다.
    - 동기 호출이면 사용량 정산만 하고 후보는 없습니다.
- **수용 검사:**
  - 동일 digest 동시 command 두 건이 dispatch 한 번으로 끝나야 합니다.
  - 동기 provider의 unknown 상태에서 "늦은 결과" UI가 나타나지 않아야 합니다.

### 5. 다인물 과거/현재 배역 해석 순서가 미정 (중)
- **실패 시나리오:** project에서 "서윤 / 어린 state = 어린 목소리"를 지정했습니다. 예고편 production에서는 state 없이 "서윤 = X"를 지정했습니다. 예고편의 어린 서윤 출현에는 어느 쪽이 적용되는지 알 수 없습니다.
- **충돌하는 계약:**
  - "같은 specificity 충돌은 unresolved"라고 했지만, scope축과 state축의 우선순위가 정의되지 않았습니다.
  - 상태 키 이름이 세 가지입니다: `temporalStateRef`(Occurrence), `appearanceStateRef`(AssetSlot), portrayal state(Casting). 이들의 대응 관계도 없습니다.
  - prototype은 어린 서윤을 별도 roster 항목으로 둡니다. 문서는 role+state override로 둡니다.
- **최소 수정:**
  - 2차원 우선순위 표를 만들고, 축이 교차하는 경우는 unresolved로 처리합니다.
  - Occurrence에서 casting 키와 asset 키로 가는 명시적 매핑을 정의합니다.
- **수용 검사:** 4가지 조합 매트릭스와 꿈 장면(어린 시점이지만 성인 외형) 사례에서 영향 목록이 결정적으로 나와야 합니다.

### 6. prototype이 계약과 반대되는 모델을 학습시킴 (낮음)
- 실행 취소가 `history.splice`로 이력을 삭제합니다. 문서의 "supersede, audit 유지"와 반대입니다. 화면에 "감사 미구현"이라고 고지는 되어 있습니다.
- 배경 슬롯 id가 `role-narrator:narration-background`입니다. 문서는 배경 subject를 location identity로 정의하는데, 내레이터 배역 ID에 묶여 있습니다.
- **최소 수정:**
  - 실행 취소를 새 항목 추가 방식으로 바꿉니다.
  - 배경을 `loc-platform:rain` 같은 location subject로 바꿉니다.
- **수용 검사:**
  - 실행 취소 두 번 후에도 이력 길이가 증가해야 합니다.
  - 내레이터 배역을 바꿔도 배경 slot에 사용 제안이 생기지 않아야 합니다.

## 개선된 점 (근거 있음)
- **실행:**
  - dispatching 선행 commit과 결과 불명 시 blind 재전송 금지가 들어갔습니다.
  - held_unknown 예산을 TTL로 자동 복원하지 않습니다.
  - exactly-once 과금을 부정합니다.
- **편집 데이터:**
  - canonical decode 기준 RGBA 대조와 stale-base 처리가 들어갔습니다.
  - 생성 요청 범위와 채택 범위를 분리했습니다.
  - 공통 참조 실행 취소는 다른 채택으로 연쇄되지 않습니다.
- **원천과 판정 구분:** 정본, Studio 채택, 후보, semantic/advisory 판정, bytes 검사를 서로 다른 층으로 분리했습니다.
- **prototype 동작 (검증자가 관찰):**
  - 발화별 연기 저장, 재생 중 편집 잠금.
  - 늦은 결과가 원래 target에 고정되고 stale 판정이 동작함.
  - 출현 단위 override가 기본값 변경 후에도 유지됨.
- **다인물 범위:** 8인 이상과 과거/현재가 첫 vertical slice에 포함되어 있고, 2인으로 축소하지 않았습니다.

## 남은 미검증 범위
- 실제 provider 호출, 청구 정산, 한국어 음성 청취, mask 픽셀 보존.
- CAS, outbox, fault injection, 백업/복구, 렌더 동기화.
- 40인 실제 성능.
- 원천 drift 동기화와 Edition publish.
- 스크린리더 실사용.
- 최종 소스 해시의 브라우저 재검증 범위. 검증자는 라벨만 재확인했습니다.