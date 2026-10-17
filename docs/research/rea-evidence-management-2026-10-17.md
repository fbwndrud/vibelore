# REA 근거·상태 관리 조사

조사일: 2026-10-17 (Asia/Seoul). 조사 범위는 공식 문서와 소스의 정적 검토다. REA 설치·실행 검증은 하지 않았다. 바이브로의 현재 구현 평가는 별도 통합 보고서에서 다룬다.

## 식별과 기준 버전

사용자가 말한 REA는 **morluto/rea — Reverse Engineer Anything**으로 판단한다. 공식 README가 해당 저장소·rea.tools·rea-agents npm을 공식 배포원으로 명시하며 프로젝트 명칭과 에이전트 기반 역공학이라는 설명이 일치한다. 동일 이름 포크가 검색되지만 이번 조사는 upstream만 기준으로 했다. 사용자가 URL을 주지는 않았으므로 의도한 저장소와의 동일성은 강하게 추정한 것이다. [공식 README](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/README.md)

기준 revision은 `e567033a7137d5eebf49147ed325cad141cff5c2`, 그 revision의 package.json 버전은 `6.5.0`이다. 이는 **조회한 main 소스 버전**이며 npm 최신 배포 버전을 별도로 확인한 주장이 아니다. [package.json](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/package.json)

## 핵심 결론

REA는 근거를 한 줄짜리 신뢰 점수나 단일 단계로만 관리하지 않는다. **근거 레코드, 근거의 성격·출처, 미해결 질문과 개정 이력, 검증 의무와 완료 판정**을 분리해서 연결한다. 바이브로에 가져올 핵심도 상태 enum을 늘리는 것보다 이 분리와 승격 조건이다. 다음 표의 항목은 실제 스키마·평가기 구현으로 확인했다.

| 구분 | 실제 모델 | 의미 |
| --- | --- | --- |
| 개별 근거 | `Evidence` | 어떤 대상에 어떤 작업을 해 어떤 결과를 얻었는지 |
| 근거 성격 | `confidence: observed / derived / inferred` | 직접 관측·유도·추론을 구분 |
| 출처 권위 | `authority` | 배포 산출물·통제 재현·과거 자료·외부 서비스·분석자 추론을 구분 |
| 조사 범위 | `relationship_coverage`, `limitations`, `locations` | 부분 조사와 전체 조사, 조사 위치·한계를 보존 |
| 질문 상태 | `ResidualUnknown` | 미해결·조사 중·차단·반증 있음·해결 |
| 판정 | completion / obligation / coverage ledger | 개별 근거가 요구된 증명을 충족하는지 따로 판단 |

근거: [Evidence 스키마](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/evidence.ts), [ResidualUnknown 스키마](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/residualUnknown.ts), [의무 원장 문서](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/docs/reconstruction-obligation-ledgers.md).

## 실제 구현에서 배울 부분

### 1. 근거에는 결과만 저장하지 않는다

`Evidence`에는 대상 digest·형식·아키텍처, provider와 버전, analysis profile, 작업·인자, 원시/정규화 결과, 근거 성격·출처·환경, 한계·위치·연결 근거 ID가 들어간다. `evidence_id`는 의미 필드의 canonical digest에서 만들어지며 표시용 이름·로컬 경로는 ID에서 제외한다. 내용 변경은 ID 검증에서 감지한다. 다만 digest 일치는 내용 무결성에 관한 검증이지, 관측이 진실이거나 독립적으로 검증되었다는 보증은 아니다. [구현](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/evidence.ts#L126)

엔진은 동일 ID를 재등록하면 중복으로 취급하고 충돌 내용을 거부하며, 보관 근거는 immutable snapshot으로 만든다. 근거 bundle을 전부 검증한 뒤 원자적으로 병합한다. 즉 결과 문장을 계속 덮어쓰는 방식보다 추적성과 재현 가능성을 우선한다. 세션 종료 때 메모리 원장은 비워지므로 장기 보존에는 export한 bundle 등이 필요하다. [원장 구현](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/application/investigation/EvidenceLedger.ts)

### 2. 질문을 별도 객체로 남긴다

`ResidualUnknown`의 상태는 `open`, `investigating`, `blocked`, `contradicted`, `resolved`다. 질문·domain·scope가 안정적 ID의 기준이며, `revision`, 이전 revision digest, 현재 digest로 이력을 잇는다. 지지/반박 근거, 필요한 authority·confidence·환경, 다음 조사, 질문 간 depends-on/related-to/contradicts 관계도 함께 남긴다. `resolved`의 disposition은 `verified`, `withdrawn`, `out-of-scope`로 나뉘므로 해결 처리와 참으로 검증됨도 구분한다. [스키마와 개정 함수](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/residualUnknown.ts#L64)

업데이트는 `expected_revision`을 요구한다. 다른 작성자가 먼저 수정했으면 revision conflict로 거부한다. bundle 검증은 개정 누락·끊어진 digest 연결·없는 근거 참조·의존성 순환도 검사한다. 이것은 여러 에이전트나 여러 작업이 같은 설정을 다룰 때 특히 유용하다. [동시성 처리](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/application/investigation/EvidenceLedger.ts#L294), [이력·참조 검증](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/evidenceBundle.ts#L334)

### 3. “검증됨”에는 별도 자격 조건이 있다

unknown을 verified로 해결하려면 해결 근거가 지지 근거에도 포함되어야 하며, 단순한 unknown 수정 기록 자체를 증거로 재사용할 수 없다. 현재 개정에 반박 근거가 남아 있어도 거부한다. authority·요구 confidence·환경 조건에 맞는 근거가 적어도 하나 필요하다. 과거 개정은 보존되므로 반박 이력을 지워 버리는 구조는 아니다. [자격 판정](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/evidenceBundle.ts#L392)

주의할 차이가 있다. 에이전트 가이드는 “qualifying observed evidence”만 검증할 수 있다고 설명하지만, **일반 unknown 구현은 요구 confidence를 설정할 수 있고 `inferred < derived < observed` 순위로 검사**한다. 따라서 모든 unknown이 무조건 observed를 요구한다고 보고하면 부정확하다. 구체적 reconstruction coverage 평가기는 runtime 계약에 observed를 요구하며 배포 산출물 계약에는 observed 또는 derived를 허용한다. 범용 스키마의 허용 범위와 각 평가기의 엄격한 정책을 구분해야 한다. [가이드](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/.agents/skills/reverse-engineer-anything/references/evidence-workflows.md), [일반 판정 코드](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/evidenceBundle.ts#L489), [coverage 판정 코드](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/reconstructionCoverageEvidence.ts)

unknown 변경은 별도 mutation Evidence를 생성한다. 이것은 `derived` / `analyst-inference`로 기록되며 “분석자의 의도를 기록할 뿐 답의 증명은 아니다”라는 한계를 명시한다. 바이브로에서도 “저장·승인했다”와 “본문에서 확인됐다”를 혼동하지 않는 데 직접 참고할 수 있다. [UnknownEvidence 구현](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/application/investigation/UnknownEvidence.ts)

### 4. 조사 안 됨은 거짓이나 없음이 아니다

관계 coverage는 `complete`, `partial`, `unknown`을 구분한다. partial은 제한 설명, unknown은 이유를 요구한다. 가이드는 페이지를 끝까지 읽었다는 사실과 원본 조사 자체가 완전하다는 사실도 구분한다. 한정된 조사에서 안 나온 것을 전역적 부재로 보고하지 말라는 취지다. [coverage 스키마](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/relationshipCoverage.ts), [운영 가이드](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/.agents/skills/reverse-engineer-anything/references/evidence-workflows.md)

소설에서는 “3화까지 독자에게 드러나지 않음”, “인물이 아직 모름”, “세계에서 존재하지 않음”을 각각 다르게 저장해야 한다는 설계로 옮길 수 있다. 이는 이번 조사에서 도출한 적용 제안이다.

### 5. 완료 판정은 근거 레코드와 별개다

completion ledger는 claim ID마다 `pass`, `fail`, `unsupported`, `truncated`, `unknown`과 근거 ID를 저장한다. 전체 complete는 모든 claim이 pass인 경우다. canonical 정렬·중복 검사·digest 확인은 있지만 **이 작은 원장 자체가 각 주장에 맞는 authority를 판정하는 것은 아니다**. 구체적 검증기와 함께 써야 한다. [completion 구현](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/evidenceCompletionLedger.ts)

reconstruction obligation은 정적 후보를 곧바로 실행 증명으로 승격시키지 않는다. 요구 사례·담당 owner·파서 타입·검증기·의존성·남은 unknown을 따로 추적하며, 근거에 맞는 검증 authority가 필요하다. coverage 쪽도 최신 결과의 근거만 자격 판단에 사용하며, 과거의 강한 결과나 bundle에 우연히 같이 들어 있는 무관한 관측으로 최신 추론을 보강했다고 간주하지 않는다. [obligation 문서](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/docs/reconstruction-obligation-ledgers.md), [coverage 문서](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/docs/reconstruction-coverage.md)

### 6. 9단계 readiness와 제품의 상태 모델을 혼동하면 안 된다

readiness 문서의 단계는 discover-classify → diagnose-environment → acquire-authority → static-analysis → reactive-scenarios → compare-authority-candidate → preserve-contradictions → verify-reconstruction-closure → export-replay다. 문서가 명시하듯 이는 **저장소 소유 conformance fixture를 검사하는 내부 verifier의 단계**이며 public CLI/MCP가 모든 조사마다 이 9단계 상태 기계를 실행한다는 뜻이 아니다. 단계별 required check에 근거가 있어야 하며 unknown·unsupported·truncated·skipped를 pass로 집계하지 않는다. [readiness 문서](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/docs/reconstruction-readiness.md)

## 바이브로 적용 제안 — 실제 바이브로 코드와 대조하기 전의 설계안

아래는 REA의 구현 사실이 아니라 창작 도메인으로의 변환 제안이다.

1. **사실·주장과 근거를 분리한다.** `claim_id`는 인물/세계/사건의 주장이고, Evidence는 본문 인용 위치·원고 digest·사용자 설정 발화·모델 추출 결과·검사 결과다. 모델의 동일 결론 반복은 독립 근거 수 증가로 세지 않는다.
2. **정본 채택과 인식론적 신뢰를 분리한다.** 사용자의 세계 설정 승인은 소설 세계의 사실을 만드는 권한이다. 외부 관측보다 낮은 confidence로 취급하면 창작에 맞지 않는다. `canonStatus`(proposed/adopted/superseded/rejected)와 `basisKind`(author-decision/text-explicit/derived/character-report)를 각각 관리한다.
3. **시간·관점·작품 범위를 분리한다.** 세계의 진실, 인물의 믿음·거짓말, 독자에게 공개된 범위를 같은 상태값에 넣지 않는다. `worldTime`, `chapter/revision`, `perspective`, `scope`가 필요하다. 인물의 “왕이 죽었다” 발언을 세계의 왕 사망 사실로 자동 승격시키지 않는다.
4. **모순은 해결 전까지 양쪽 근거를 보존한다.** 세계 진실의 모순, 인물의 오해, 과거 설정 폐기, 원고 개정으로 무효가 된 근거를 구분한다. REA처럼 현재 head와 전체 개정 이력을 나눈다.
5. **승격은 상태별 자격 정책으로 제한한다.** 자동 추출은 후보, 사용자가 채택한 세계 설정과 커밋한 본문은 정해진 정본 권한을 가진다. critic advisory는 해석·관찰이며 정본 사실을 직접 바꾸지 못한다. hard와 soft의 기존 의미를 바꾸지 않고 provenance를 보강한다.
6. **전체 완료는 필요한 범위에서만 판단한다.** 한 화의 검사 완료는 그 화에 필요한 요구사항에만 적용한다. 세계 전체의 빈틈이 0이어야 집필 가능하다는 조건을 도입하면 안 된다. 선택적 검토·advisory는 별도 결과로 유지한다.
7. **최소 도입부터 시작한다.** 우선 기존 ID에 evidence reference·source revision·basis kind를 덧붙이고 읽기 화면에 표시한다. 그다음 충돌·unknown 원장과 revision guard, 마지막으로 채택/폐기·의존 영향 평가를 도입한다. 범용 그래프나 복잡한 confidence 수치부터 도입할 필요는 없다.

## 검증 범위와 남은 한계

공식 문서·실제 스키마·원장·자격 판정 코드·대응 테스트 정의를 대조했다. 테스트에는 observed 요구에 inference로 답하면 거부, CAS revision 충돌 거부, 변조/이력 분기 거부, 완료 원장의 all-pass 조건 등이 있다. **테스트를 이번 조사에서 실행하지 않았으므로 통과했다고 보고하지 않는다.** [unknown 테스트](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/application/investigation/EvidenceLedger.residualUnknown.test.ts), [completion 테스트](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/evidenceCompletionLedger.test.ts), [coverage 테스트](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/reconstructionCoverage.test.ts)

REA의 모든 provider가 confidence·authority를 정확하게 부여하는지까지 감사하지는 않았다. 기본 createEvidence 값이 observed/shipped-artifact인 만큼 각 producer의 정확성은 별도 점검 대상이다. 근거 해시와 schema는 거짓 분류까지 자동 판별하지 못한다. 또한 범용 unknown 구현은 요구 confidence와 authority를 수정 입력에 포함하므로 정책 변경 권한까지 바이브로에서 그대로 맡기면 승격 조건을 약화할 수 있다. 창작 엔진 적용 시 채택 권한과 정책 변경 권한은 명시적으로 구분하는 편이 좋다. [기본값 구현](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/evidence.ts), [업데이트 입력](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/residualUnknown.ts#L267)
