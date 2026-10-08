# Studio 개선 루프 — 2026-10-08

사용자 요청: 정확히 5회. 각 회차는 현재 산출물에 대한 별도 비평 → 수정 → 확인으로 구성한다. 중간 조사나 실패한 모델 호출은 회차로 세지 않는다. 이전 보고서는 기초 자료이며 이번 결과는 독립 Studio 제품 설계와 작동하는 화면 예시다. 운영 backend·유료 생성·실제 렌더를 구현 완료했다고 보고하지 않는다.

## 승격한 규칙

- 인물 수를 코드의 A/B 슬롯으로 제한하지 않는다. 작품 인물·장면 출현·음성 배역을 구별해야 회상, 다인물, 화면 밖 발화가 올바르게 연결된다.
- 생성·검토·사용자 채택을 별도 상태로 둔다. 생성된 이미지가 공통 외형이나 소설 정본을 자동 변경하면 다른 제작물의 입력이 훼손된다.
- API 전송 뒤 결과 불명은 자동 재전송하지 않는다. provider가 idempotency를 보장하지 않으면 중복 청구가 생길 수 있다.
- UI의 로컬 시뮬레이션을 실제 API 실행·음성 청취·출력 성공으로 표시하지 않는다. 제품 설계 검증과 운영 증거의 범위가 다르다.
- subject+state 없는 수정 범위는 사용하지 않는다. 어린 인물·성인 인물의 asset slot과 배역을 구별해야 전역 변경이 잘못 전파되지 않는다.
- Project와 Production을 구별한다. 예고편의 채택을 본편에 자동 전파하면 매체별 각색 선택이 훼손된다.
- source에서 파생한 Studio asset도 rebase 영향에 포함한다. 파생본은 원본 HEAD만 비교하면 놓치기 쉽다.
- network 전에 dispatching을 영속 기록한다. send와 상태 기록 사이의 crash를 prepared 재시도로 처리하면 이중 청구가 발생한다.
- CAS는 편집 aggregate 단위, export approval은 고정 Edition closure 단위다. 진행 event로 무관 편집을 막거나 새 편집본에 과거 승인을 승계하면 안 된다.
- import/생성/편집 모두 bytes 검사와 계보를 갖는다. viewport crop과 실제 asset 파생을 구별해야 공유 참조가 의도 없이 바뀌지 않는다.

## 확인 방법

- 각 회차 input/critic/receipt를 보존하고 실제 모델 반환 식별자를 기록한다.
- 디자인 문서의 상대 링크·fence·상태 계약을 확인한다.
- 화면에서 8인 cast, 장면별 배역 선택, 발화별 speaker, 이미지 수정 범위·후보·채택·되돌리기, 작업 불명 상태를 확인한다.
- 좁은/중간/넓은 화면과 키보드·console을 확인한다. 실제 수행한 범위만 결과로 기록한다.

## 실측

- 시작 시 Claude Code 2.1.280 실행 파일과 로그인 상태를 확인했다. 모델 실행 성공은 회차별 receipt가 근거다.
- 기존 저장소는 다수 사용자 변경이 있다. 이번 작업은 새 docs/research/studio-*와 task-owned 화면 파일만 작성한다.
- Opus 비평은 각 회차 fresh process에서 제공된 문서·화면 소스·명시한 browser evidence만 읽는다. Opus가 직접 한국어 음원을 듣거나 backend/UI를 실행했다고 보고하지 않는다. 화면 실제 실행은 별도 확인 기록이 근거다.
- 1회차의 “import 권리 필드 없으면 모두 차단”과 “인용 존재가 곧 hard 의미 충돌” 제안은 그대로 채택하지 않았다. 원천/provenance와 실제 provider 계약을 기록하되 근거 없는 범용 승인 절차를 추가하지 않으며, 인용 존재만으로 의미를 확정하지 않는다.

## 회차 기록

| 회차 | 비평 근거 | 주요 수정 | 확인 |
|---|---|---|---|
| 1 | 실제 claude-opus-5-5, 성공 77.4초 | 독립 Studio·Occurrence·Asset Lab·Candidate/Adoption·결과 불명·정확한 문맥 캐시 계약 추가 | 문서·receipt 보존. 실제 backend 미구현 |
| 2 | 실제 claude-opus-5-5, 성공 76.4초 | subject/state slot·CastingDecision·IdentityLink·파생 source 계보·Production override·import byte 검증 추가 | 구체적 rebase/casting/예고편 시나리오를 계약으로 반영. backend 시험은 미실행 |
| 3 | 실제 claude-opus-5-5, 성공 81.1초 | dispatching 선행 commit·command dedupe·budget ledger·aggregate CAS·Edition atomic publish·정규 좌표·stale-base·voice stack·GC 보호 | kill 지점·잔액 경합·출력 closure·병렬 편집 시나리오를 명세화. fault injection은 출시 게이트 |
| 4 | 실제 claude-opus-5-5, 성공 93.7초; UI 소스 비평 | 원래 target recipe·subject/state·발화 ID별 저장·채택 no-op·범위별 undo·다인물 필터·keyboard 수정. 실제 새 프로젝트 생성은 설명 경로로 정직하게 제한 | 독립 CUA 15개 핵심 경로 확인, 320/1024px 넘침 없음, console error 0. [관찰 기록](browser-verification.md) |
| 5 | 실제 claude-opus-5-5, 성공 101.2초; 문서·UI·독립 browser evidence | 진행 중 source rebase·정책 호환 receipt/CAS·native mask 보호 hard check·reuse/fresh 및 동시 합류·배역 2축/PresentationBinding 명시. UI undo audit·location subject 보강 | Opus는 설계/prototype에 한정해 서명. 최종 UI 작성자 재검증: audit 4개 보존·내레이터 변경과 location slot 독립·회수 조건 표시·console 0. 운영 backend/API 시험 미실행 |

## 5회차 반영 판단

- 완료된 다섯 번 모두 fresh Claude Opus 5.5 호출이며 round-1~5-receipt.json의 실제 반환 modelUsage로 확인한다. 실패 호출을 회차로 치환하거나 여섯 번째 비평을 추가하지 않았다.
- 원천 rebase는 cached bytes 유효성과 새 원천에서의 semantic 적합성을 구별한다. 입력이 같아도 source-binding 검토 없이는 새 package에서 auto-adoption하지 않는다.
- advisory 정책 완화는 이전 receipt를 변경하지 않고 근거를 참조하는 호환 receipt를 새로 발급한다. 강화는 새 검사를 요구한다. 둘 모두 transaction 안에서 policy binding CAS를 수행한다.
- native mask도 보호 영역 hard validation을 건너뛰지 않는다. 원출력과 protected composite revision을 구별한다.
- critic의 variationNonce 제안은 engine 실행 의도로 채택했다. 지원하지 않는 provider parameter를 보내거나 nonce를 대사/prompt에 임의 삽입하지 않는다.
- “동기 API면 늦은 결과는 항상 불가능”은 범위가 지나치게 넓어 그대로 채택하지 않았다. UI만 끊겼고 worker가 살아 있는 경우와 동기 worker가 죽어 bytes를 회수할 수 없는 경우를 구별한다. recovery UI는 실제 capability/생존 상태에 따른다.
- 실제 새/빈 프로젝트와 성공 import UI는 이번 prototype에서 구현하지 않았다. 시작 버튼은 흐름 설명으로 표시하며 기존 가상 자료를 보존한다. 제품 구현 요구는 통합 설계의 출시 단계에 남긴다.

## 최종 확인

- 총 5회 모두 실제 반환 모델 `claude-opus-5-5`, exit 0, is_error=false다. 비평 원문과 당시 입력/소스 snapshot을 보존했다.
- 독립 브라우저 영수증은 4회차 최종 소스 `808542…`의 15개 핵심 경로를 다룬다. 5회차 뒤 undo audit/location subject/recovery 설명 변경은 UI 작성자가 Chrome에서 별도 재검증했다. 이를 독립 모델이나 독립 browser가 최종 전체 소스를 새로 검사했다고 확대하지 않는다.
- 최종 화면 SHA256: `d7dbfee05e57b79d52d4907f2ab2b6355d9173ff09b0b16dca484850530f15c9`. 자세한 실제 확인/미실행 범위는 [ui-evidence.json](ui-evidence.json).
- 보고서의 상대 파일 링크와 코드 fence를 확인했다. source resolver와 기존 웹툰 경로는 읽기만 했고 사용자 운영 코드·정본·기존 변경은 수정하지 않았다.
