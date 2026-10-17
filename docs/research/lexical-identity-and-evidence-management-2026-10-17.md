# 동일 표기 식별과 근거·상태 관리 조사

조사일: 2026-10-17, Asia/Seoul. 대상: vibelore 현재 작업 트리와 REA 공식 소스.

vibelore 기준 HEAD는 `b3200d39050ccd627e67015a1b0619cea31b0d72`다. 작업 트리에 이미 수정된 파일이 있으므로 HEAD 소스만의 감사가 아니라 **조사 당시 작업 트리**의 감사다. 기존 수정은 보존했다. 이 문서는 조사·설계 제안이며 엔진 변경이나 정본 이행의 실행 기록이 아니다. 개별 사용자 작품의 실제 오염 건수는 조사하지 않았다.

## 판단 요약

1. 현재 엔진은 ‘하나의 단어 아래 여러 뜻을 관리하는 사전’으로 통일되어 있지 않다. 설정 정의 등록부, 이야기 장부, 검사 어휘가 서로 다른 방식으로 이름을 다룬다.
2. 동음이의어·동명이 대상의 위험이 실제 코드 경로에서 재현됐다. 설정 `ensure`는 **이름+구조**로 기존 정의를 재사용할 수 있고, 이야기 장부는 **같은 feature+이름**을 같은 대상으로 처리한다. 이름 기반 장면 문맥 선택은 동명 항목 중 마지막 항목을 선택한다.
3. 반대로 SharedLore의 stable ID·시점 범위·채택·판본 고정·영수증은 이미 유용한 기반이다. 이 기반 위에 이름과 의미를 분리하고 근거를 더 정확하게 연결하는 편이 적절하다.
4. REA에서 가져올 핵심은 일렬의 상태 단계보다 **근거의 직접성, 출처 권위, 조사 범위, 미해결 질문을 독립해서 기록하는 방식**이다. 소설에는 여기에 작가의 채택 권한, 인물의 믿음, 독자의 공개 범위를 더해야 한다.

## 1. 동일 단어가 현재 어떻게 저장되는가

### 1.1 설정 정의 등록부: 정의 하나에 의미문 하나, 이름은 namespace 안에서 유일

`engine/src/lore/schemas.js`의 정의에는 stable `id`, `namespace`, 기계 `key`, 표시 `label`, `aliases[]`, 단일 `definition` 문자열이 있다. `senses[]` 같은 다의어 모델은 없다. `key`는 ASCII 식별자 형식이며 한국어 같은 자연어 표기는 label/alias로 들어간다.

등록부는 key/alias를 NFC·공백 정리·소문자로 정규화한 뒤 **namespace+표기**로 유일성을 검사한다. 서로 다른 정의 종류나 대상 타입이라고 자동 분리하지 않는다. 같은 namespace에서 한 정의의 key/alias와 다른 정의의 key/alias가 겹치면 직접 등록은 `DEFINITION_CONFLICT`다. 표시 label은 이 충돌 키에 포함되지 않는다. 따라서 같은 label에 서로 다른 key/ID를 두는 것은 가능하고, namespace가 다르면 같은 key/alias도 가능하다.

근거: [정의 스키마](../../engine/src/lore/schemas.js), [정규화·충돌 검사·검색·추가](../../engine/src/lore/registry.js:10).

`lore_registry ensure`에는 주의할 차이가 있다.

| 입력 | 현재 결과 |
| --- | --- |
| 같은 ID, 같은 정의 | 재사용 |
| 같은 ID, 의미문 변경 | `migration_required` |
| 새 ID, 같은 namespace의 key/alias 일치, 구조 동일, 의미문은 다름 | 기존 ID를 `reused`, 새 의미문은 채택하지 않음 |
| 새 ID, 이름 일치, 타입·owner·범위 등 구조 다름 | `migration_required` |
| 다른 namespace, 별도 ID | 별개 정의 가능 |
| 같은 label, 별도 key/alias/ID | 별개 정의 가능 |

여기서 구조는 kind, valueType, owner, cardinality, direction, symbol, requiredScopes, subjectTypeIds, constraints, missingPolicy다. 새 ID가 이름으로 매치되면 `definition` 문장의 의미 동등성을 검사하지 않는다. `existingDefinition`을 반환하므로 호스트가 차이를 볼 수는 있지만, 도구가 의미 동일성을 증명한 것은 아니다. 새 의미를 기존 설명에 덧붙이는 것이 아니라 **새 설명을 버리고 기존 설명을 사용**한다.

직접 재현: 기존 `rank = 전투 실력 등급`에 새 ID의 `rank = 귀족 신분 등급`을 제안했다. 두 필드의 구조는 동일하게 했다. 직접 추가는 `DEFINITION_CONFLICT`, `ensure` 계획은 `reused / combat-rank / matchedBy:name / existingDefinition:전투 실력 등급`였다. 같은 ID로 의미만 바꾸면 `migration_required`였다.

근거: [ensure의 구조 비교와 의미문 분기](../../engine/src/lore/extend.js:17), [기존 확장 테스트](../../test/shared-lore-extension.test.js:31), [현재 등록부 계약](../reference/SHARED_LORE_REGISTRY.md).

### 1.2 이야기 추적 장부: 같은 feature와 이름이면 기존 항목을 갱신

장부는 ID, feature(`objects/knowledge/scheduled`), 자유 분류 label, name, aliases, status, fields와 이력을 저장한다. `findRecord`는 ID/merged ID를 먼저 보고, 없으면 정규화한 이름·별칭으로 첫 항목을 고른다. 문자열 비교에는 alias의 `by` 조건이 포함되지 않는다. `by/since`는 보존되지만 이 조회가 발화자 범위로 후보를 구분하는 것은 아니다.

`register`는 새로 주어진 ID나 label보다 먼저 `feature+name`으로 기존 항목을 찾는다. 일치하면 등록을 해당 항목의 `mentioned/changed/status` 이벤트로 바꾼다. 지명·무기처럼 label이 달라도 같은 objects feature이면 합쳐진다. fields의 같은 키는 후속 set 값으로 바뀌고 다른 키는 남는다.

직접 재현:

```text
1화: objects / 지명 / 백야 / {region: 북부}
2화: objects / 무기 / 백야 / {owner: hero} / 별도 id 제안

결과: 항목 1개, 기존 o1과 label 지명 유지
fields: {region: 북부, owner: hero}
2화 이벤트: changed
violations: []
```

비슷하지만 완전히 같지는 않은 이름은 새 항목을 만들고 `possibleDuplicateOf`와 soft `LEDGER_POSSIBLE_DUPLICATE`로 남긴다. 이 후보의 명시적 병합은 승인 경로가 있다. **그 보호가 정확히 같은 이름의 신규 등록에는 적용되지 않는다.** 레거시 이행에도 이름으로 기존 fields를 갱신하거나 동명 snapshot 추가를 생략하는 경로가 있다.

근거: [장부 정규화·조회](../../engine/src/continuity/ledger.js:48), [register 처리](../../engine/src/continuity/ledger.js:278), [레거시 이행](../../engine/src/continuity/ledger.js:151), [승인 병합](../../engine/src/continuity/ledger.js:442), [워크플로 병합 후보 안내](../../src/tools/workflow.js:147).

### 1.3 ID가 별개여도 이름 기반 조회가 다시 모호함을 만들 수 있음

`resolveEntityContext`는 ID 조회와 별개로 `Map(canonicalName → snapshot)`을 만든다. 같은 canonicalName은 마지막 값으로 덮인다. 이름으로 장면 대상을 요청하면 마지막 항목 하나를 선택한다. 반대로 `scanEntityMentions`는 각 snapshot을 순회하므로 같은 이름을 가진 모든 ID를 언급 후보로 활성화한다. 어느 대상이 맞는지 결정하는 의미 해소는 아니다.

직접 재현: location ID `north`와 item ID `sword`를 모두 ‘백야’로 두었다. `settings:['백야']`는 `sword`만 주입했고, ‘백야가 보였다’의 언급 스캔은 두 ID를 모두 반환했다. settings라는 슬롯만으로 kind를 제한하지도 않는다. 명시 ID로 요청하면 해당 ID를 선택할 수 있다.

인물 ID 보정에도 이름·별칭을 단일 Map으로 만드는 경로가 있다. 동일 표기의 다른 인물을 안전하게 표현하려면 저장소에서 ID를 분리하는 것과 함께 이런 이름 fallback을 함께 바꿔야 한다.

근거: [장면 문맥 선택](../../engine/src/core/entity-context.js:55), [언급 스캔](../../engine/src/core/mention-scan.js:59), [인물 ID 해석](../../engine/src/continuity/continuity-check.js:927), [서사 관측 인물 보정](../../src/tools/workflow.js:87).

공유 세계의 모든 경로가 이름을 합치는 것은 아니다. 작품을 공유 세계에 연결할 때의 이행 보고서는 동명 인물을 `sameNameCandidates / not_merged`로 표시한다. 이 원칙을 장부·조회 경로에도 일관되게 적용할 가치가 있다.

근거: [공유 세계 이행 보고](../../src/core/work-migration.js).

### 1.4 검사 어휘: 일부는 같은 표기 추가 시 뒤 항목이 앞 항목을 덮음

감정 동사, 의성·의태어, 민감어 사전은 각각 verb/word/term을 Map 키로 쓴다. 같은 표기를 두 번 seed에 넣으면 lookup/all은 마지막 항목만 남는다. 감정·카테고리별 배열에는 앞뒤 항목이 모두 남을 수 있어 조회 API별 결과도 달라진다. 문체 사전은 장르별 배열, 직유 사전은 배열 기반이므로 동일한 덮어쓰기 규칙이 아니다. 이들은 작품 본문에서 새 단어가 나올 때 자동으로 어의를 학습하는 사전도 아니다.

조사 당시 기본 seed는 민감어 89개, 감정 동사 107개, 의성·의태어 298개, 직유 표지 32개였고 **각자의 표기 키 중복은 0건**이었다. 따라서 현재 기본 seed가 중복으로 유실됐다는 뜻은 아니다. 사용자 seed나 향후 추가에 대한 구조적 취약점이다.

다의어 해소는 별개 문제다. 민감어는 substring과 일부 `notFollowedBy` 예외를 쓴다. ‘조정의 정사를 논하는 자리였다’의 ‘정사’도 youth 모드에서 sexual-explicit hard가 됐다. 이 현행 오탐은 기존 테스트에도 명시적으로 기록돼 있다. 사전 신호의 의미가 문맥 검증을 거친 결론인지 구분할 필요가 있다.

근거: [민감어 저장·검사](../../engine/src/continuity/sensitive-lexicon.js:11), [감정 동사 저장](../../engine/src/continuity/emotion-verb-lexicon.js:9), [의성·의태어 저장](../../engine/src/continuity/onomatopoeia-lexicon.js:7), [직유 저장](../../engine/src/continuity/simile-marker-lexicon.js:8), [동음이의 잔여 오탐 테스트](../../engine/test/continuity/lexicon-precision-259.test.js:76), [언어별 사전 연결](../../src/tools/lexicons.js).

## 2. 앞으로의 단어·정체성 관리 제안

### 2.1 표기·어의·대상·상태를 분리

| 층 | 예 | 식별 원칙 |
| --- | --- | --- |
| 표기 | ‘백야’, ‘등급’ | 언어·정규화 표기 → 후보 여러 개 |
| 어의/설정 정의 | 전투 등급, 귀족 신분 | definitionId별 명확한 단일 의미 |
| 작품의 대상 | 북부 도시 백야, 검 백야 | entityId로 분리, 동명 허용 |
| 대상의 시점별 상태 | 소유자·위치·생존 여부 | entityId 유지, 범위와 value 판본으로 변경 |

같은 뜻의 다른 표현은 하나의 정의/대상에 alias로 연결한다. 같은 표기의 다른 뜻은 별도 정의 ID를, 같은 이름의 다른 인물·사물은 별도 entity ID를 쓴다. 한 인물의 성장·변신이나 한 물건의 소유권 변경은 새 대상을 만들지 않고 scoped state/value로 관리한다. `cardinality:many`는 한 속성의 복수 값이지 한 단어의 여러 뜻을 위한 장치가 아니다.

이는 현재 프로젝트의 [인물 정체성·인물 상태 용어](../../CONTEXT.md)와도 일치한다. 해당 문서는 기획 용어이므로 모든 항목이 구현됐다고 해석하지 않는다.

### 2.2 지금 가능한 운영법과 엔진 개선을 구별

**현재 도구로 가능한 운영법:** 정의 key를 `combat.rank`, `nobility.rank`처럼 의미별로 두고 label ‘등급’은 공유한다. 같은 namespace 안에서 두 정의 모두 alias ‘등급’을 붙이는 것은 현재 불가하므로, 일단 충돌 없는 설명형 별칭을 쓴다. namespace는 실제 정의 적용 영역이 다를 때 쓴다. 뜻이 조금 다르다는 이유마다 namespace를 늘리는 우회는 권하지 않는다. 장면과 이벤트에는 표시 이름 대신 정확한 ID를 넘긴다. 현재 장부에서 같은 feature의 동명 대상 신규 등록은 안전한 표현 경로가 부족하므로 구별되는 명칭을 쓰는 임시 대책이 필요하다.

**엔진 개선안:**

1. 이름은 `name → [candidateIds]` 인덱스로 바꾸고 언어·kind·대상 타입·세계 범위·화자·장면으로 후보를 좁힌다. 후보가 여러 개면 `ambiguous`와 후보·근거를 반환한다. 문맥 슬롯이 필수인 곳에서는 정확한 ID가 정해질 때까지 적용하지 않는다. 탐색용 언급 활성화는 여러 후보를 반환하되 확정 식별과 구분한다.
2. `ensure`에서 이름만 매치한 재사용은 의미 동등성 판단을 요구한다. 동일 정의 판본/ID의 완전 일치는 빠르게 재사용하되, 새 ID의 의미문이 다른 경우는 `needs_disambiguation` 같은 별도 결과로 남긴다. LLM 점수 하나가 의미 동일성이나 재사용 권한을 대신하지 않는다.
3. 장부의 `register`와 기존 ID `event`를 명시적으로 구분한다. 기존 이름을 재사용하고 싶다는 의도가 확인되지 않으면 신규 동명 등록을 기존 항목 변경으로 바꾸지 않는다. 멱등 재시도는 이름이 아니라 operation ID로 해결한다.
4. 안정적인 기계 key의 유일성과 자연어 alias의 다대다 관계를 분리한다. alias에는 언어, 표기 종류, 선택적 화자/기간/범위와 연결 근거를 둔다. label은 표시용으로 유지한다.
5. 검사 어휘는 동일 표기의 복수 entry/sense를 지원하거나 중복 삽입을 명시적으로 거부한다. 단순 substring 검출과 문맥에 따른 의미 판정을 분리한다. 민감도 정책 변경은 별도 결정으로 다룬다.

기존 데이터는 자동 재병합하지 않는다. 이름 충돌·이질적 fields·name fallback을 읽기 전용으로 보고한 뒤 원고 근거를 대조해 합침 유지/분리를 결정한다. 이미 합쳐진 장부는 현행 snapshot만으로 정확히 분리할 수 없으므로 화별 delta와 원고를 재검토해야 한다. 이름·ID 해석을 바꾸는 resolver는 판본을 올려 과거 lock의 해석을 보존한다.

## 3. vibelore에 이미 있는 근거·상태 기반

| 영역 | 확인된 구현 | 실무상 의미와 한계 |
| --- | --- | --- |
| 공유 값 | entity/field/owner/storyScope/evidenceIds, 타입·참조·범위 검사 | 누가 언제 어떤 값을 가지는지 구별. 근거는 문서 단위이며 의미적 함의를 자동 증명하지 않음 |
| 조회 상태 | resolved / unknown / conflict / incomplete | 적용 값 없음·상충·후보 예산 초과를 구별. 확신도 등급이나 승인 상태가 아님 |
| 세계 채택 | propose → approve/reject → immutable publication | 생성·추출과 작가 채택을 분리 |
| 제작 입력 | 고정한 registry/lore/binding/resolver와 원문 lock | 이후 세계 변경이 기존 입력을 조용히 바꾸지 않음 |
| 검사·검토 | 원고·계약 hash, request/response 식별, evaluator provenance, 영수증 | 변경 후 이전 통과 결과 재사용 차단. completed는 독립 독자 검증을 뜻하지 않음 |
| 인물 해석 | accepted observation, anchor, interpretation, behavioralProof, competingHypotheses | 일부 영역은 이미 관측·해석·경합 가설을 구별 |
| 인물 변화 증명 | proposed / tested / tested-contested | 선택·대안·비용 등 입력 구조로 판단. 본문 의미를 독립적으로 입증한 보편적 증거 등급은 아님 |
| 기억 선별 | source hashes, evidence anchors, candidate universe hash, 선택/예산 경계 lineage | 어떤 기억이 왜 문맥에 들어갔는지 추적하는 기존 기반 |

근거: [공유 값과 근거 검증](../../engine/src/lore/changes.js:12), [resolver](../../engine/src/lore/resolve.js:13), [세계 채택 저장소](../../src/store/universe-store.js:44), [binding 적용](../../src/core/work-binding.js:30), [현재 실행 계약](../reference/SHARED_LORE_RUNTIME.md), [review audit](../../src/core/review-audit.js:33), [인물 변화 판정](../../src/core/character-dynamics.js:55), [수용 관측 adapter](../../src/core/character-dynamics-adapter.js:78), [기억 선택 lineage](../../src/core/memory-compiler.js:64).

특히 `validateLoreContent`는 evidenceIds가 실제 content.documents에 있는지 검사한다. 저수준 `createLoreResolver`만 사용하면 evidenceIds 문자열의 형태만 검사한다. 두 수준의 보장을 혼동하면 안 된다. 어느 쪽도 ‘참조 문서의 어느 문장이 이 값을 뒷받침하는가’를 범용적으로 검증하지 않는다. 복선 회수처럼 원고 인용의 존재를 검사하는 한정된 기능은 별도로 있다.

근거: [저수준 근거 ID 검사](../../engine/src/lore/resolve.js:54), [문서 존재 검사](../../engine/src/lore/changes.js:55), [장부 근거 점검 테스트](../../engine/test/continuity/ledger.test.js).

한편 화 커밋의 관측 artifact는 현재 artifact 수준에서 `truthAssertions:established`, `readerAssertions:revealed`, `evidenceIds:[]`를 만들고, relationship claim의 believer confidence를 `1`로 기록한다. 이는 각 주장별 근거를 계측한 confidence나 독자·인물 지식의 정밀 추출 결과로 읽어서는 안 된다. 세부 주장 단위 evidence를 추가할 때 이 포괄 메타데이터와 충돌하지 않도록 의미를 명확히 하거나 이행해야 한다.

근거: [커밋 관측 artifact 구성](../../src/tools/commit.js:199). 이 항목은 저장되는 기본값에 대한 관찰이며 그 자체로 모든 정본 사실이 잘못됐다는 판정은 아니다.

## 4. REA와의 비교

REA의 정확한 공식 명칭은 **Reverse Engineer Anything**이며 upstream은 [morluto/rea](https://github.com/morluto/rea)다. 조사한 판본과 소스별 상세는 [REA 근거 관리 조사](rea-evidence-management-2026-10-17.md)에 기록한다.

조사 기준 소스는 `e567033a7137d5eebf49147ed325cad141cff5c2`다. 해당 소스의 package 버전은 6.5.0이며 최신 npm 배포를 확인했다는 뜻은 아니다. REA는 설치·실행하지 않고 공식 코드·문서·테스트 정의를 대조했다.

| REA의 구분 | 확인한 동작 | vibelore에 옮길 점 |
| --- | --- | --- |
| Evidence | 결과와 provider·작업·인자·위치·한계·연결 근거를 보존 | 추출된 값 옆에 원고 판본과 정확한 근거 위치 연결 |
| confidence | observed / derived / inferred | 직접 서술·규칙 도출·모델 해석의 구별. 작가 채택과 독립 |
| authority | shipped-artifact / controlled-replay / historical-reference / external-service / analyst-inference | 창작에서는 작가 결정·정본 원문·인물 발언·모델 해석 등으로 도메인에 맞게 변경 |
| ResidualUnknown | 질문·범위·지지/반박·요구 근거·다음 조사·개정 이력 | 아직 정하지 않은 설정과 해결해야 할 충돌을 명시적으로 남김 |
| 해결 disposition | verified / withdrawn / out-of-scope | 답을 확인한 것과 질문을 철회하거나 범위 밖으로 둔 것 구별 |
| coverage | complete / partial / unknown | 살펴보지 않은 원고·검색에서 빠진 결과를 부재로 오인하지 않음 |
| 완료 판정 | 개별 claim의 결과와 별도 완료 ledger | 필요한 장면의 필수 의무만 완료 판단, 세계 전체 완벽성을 요구하지 않음 |

근거: [Evidence 실제 스키마](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/evidence.ts#L108), [ResidualUnknown](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/residualUnknown.ts#L64), [coverage](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/relationshipCoverage.ts), [완료 원장](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/evidenceCompletionLedger.ts).

REA의 confidence는 시간이 지나면 inferred→derived→observed로 자동 승격하는 workflow가 아니다. 질문에 요구된 authority·confidence·환경을 만족하는 근거인지 별도 검사한다. 일반 unknown은 요구 confidence가 입력으로 설정되며, 구체적 runtime coverage는 observed를 요구하는 등 정책별 차이가 있다. 현재 개정의 반박 근거가 남아 있거나, 단지 질문 상태를 수정했다는 기록만으로는 verified가 되지 않는다.

근거: [verified 자격과 confidence 판정](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/evidenceBundle.ts#L392), [runtime coverage 근거 정책](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/reconstructionCoverageEvidence.ts), [상태 수정 기록의 한계](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/application/investigation/UnknownEvidence.ts).

문서의 9단계 readiness는 저장소 소유 conformance fixture를 검사하는 내부 verifier의 단계다. 모든 사용자 조사가 따르는 공통 제품 상태 기계로 그대로 복제할 대상은 아니다. 또한 해시와 엄격한 schema는 기록 변조를 검출하지만 잘못 부여된 observed/authority까지 진실로 만들어 주지는 않는다.

근거: [readiness 적용 범위](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/docs/reconstruction-readiness.md), [Evidence 생성·무결성 코드](https://github.com/morluto/rea/blob/e567033a7137d5eebf49147ed325cad141cff5c2/src/domain/evidence.ts).

## 5. 소설·세계관에 맞는 근거와 상태 설계

### 5.1 하나의 status에 모든 의미를 넣지 않기

| 독립 축 | 예시 값·내용 — 신규 설계 제안 | 주의점 |
| --- | --- | --- |
| 식별 | definitionId/entityId/valueId/claimId | 표기와 ID를 구별 |
| 근거 방식 | author-decision / text-explicit / rule-derived / model-inferred | 직접 인용도 발화 내용이 세계의 참이라는 뜻은 아님 |
| 채택 | proposed / adopted / rejected / superseded | 실제 사용자 결정 또는 허용된 auto 정책과 영수증에 결합 |
| 인식 주체 | world / character:<id> | 인물의 믿음을 세계 진실로 올리지 않음 |
| 공개 범위 | 작품·독자 공개 지점, concealment 의도 | 실제 세계 사실과 별개. author visibility와 공개 계약도 구별 |
| 적용 범위 | 세계선·timeline·world point·작품/장면 | 이야기 속 시간과 제작·원고 개정 시간을 구별 |
| 근거 유효성 | current / superseded-source / needs-recheck | 원고 hash·범위·도출 의존성을 추적 |
| 작업/질문 | open / investigating / blocked / resolved와 처분 이유 | 의도적 미정과 필수 입력 누락을 구별 |

이 값들은 새로운 enum 제안이다. 기존 API가 받는 필드나 확정된 프로젝트 용어가 아니다. 기존 도메인 개념과 API의 최종 이름을 정할 때는 별도 설계 검토가 필요하다.

### 5.2 세 가지 대표 예

**세계관 선결정:** 작가가 ‘왕은 8화 사건 이전에 죽어 있었다’를 채택했다면 아직 본문에 한 번도 나오지 않았어도 해당 세계 범위의 정본이다. 근거는 author-decision과 승인된 설정 판본이다. 본문 관측이 없다는 이유로 낮은 단계에 묶거나 외부 검증을 요구하지 않는다. 독자에게는 비공개일 수 있다.

**인물의 발언:** 3화에서 신하가 ‘왕은 죽었다’고 말한 것은 발언 발생의 직접 근거다. 왕 사망에 대한 세계 사실은 별도 claim이며, 신하의 실제 믿음과 거짓말 의도도 추가 근거 없이는 확정할 수 없다. 저장할 수 있는 최소 주장은 ‘신하가 이렇게 말했다’다. 이를 곧바로 world의 생사 status로 fold하지 않는다.

**성격 해석:** 주인공이 도망친 장면에서 모델이 ‘겁쟁이다’라고 해석했다면 model-inferred 해석이다. 부상·전략적 후퇴 같은 경합 가설도 남긴다. 한 장면의 행동이나 critic 반복이 영구 성격 불변식을 만들지 않는다. 기존 CharacterDynamics의 행동 근거·경합 가설과 연결하되 `tested`라는 구조상 라벨을 인물 본질의 확정으로 읽지 않는다.

### 5.3 최소 근거 객체와 연결

모든 소설 문장을 즉시 구조화할 필요는 없다. 생사·위치·소유·신원·중요 능력 규칙·복선 회수 등 이미 추적 중인 항목부터 적용한다. 풍부한 원문은 그대로 원문으로 유지한다.

논리적으로 필요한 연결은 다음 정도다.

```text
원문/작가 결정의 고정 판본 + 위치/인용
                    ↓
                  Evidence
                    ↓ supports / contradicts / derived-from
                  Claim  ←→  미해결 질문
                    ↓ 기존 채택 절차와 범위 선택
           채택된 value / 관측·해석 기록
                    ↓ 기존 resolver / fold
           장면 상태 / 계획 입력 / 제작 lock
                    ↓ 기존 검사·검토·영수증
                  화 커밋
```

Evidence는 sourceRevision/hash, 문서 ID, 문단/범위, 짧은 인용, basisKind, 수집한 요청·모델 provenance, 한계와 의존 evidence ID를 보존한다. Claim은 대상 ID, 주장 내용/field, 적용 범위, 관점, 지지/반박 evidence, 채택 결정 참조를 갖는다. 명시적 작가 결정은 원고 인용이 없는 유효한 근거 종류다. 모델 재요약·여러 critic의 같은 결론은 원출처가 같으면 독립 근거 수로 세지 않는다.

현재 value/definition은 닫힌 schema이므로 임의 필드를 덧붙이는 방식으로 도입하면 거부된다. 첫 구현은 **판본을 가진 근거 보조 객체를 기존 발행 manifest·value/관측 ID에 연결**하거나 schema를 명시적으로 개정하는 방식이 적절하다. 보조 객체를 두 번째 정본 원천으로 만들지 않고, 새 근거를 쓰는 lock/영수증은 해당 근거 판본까지 고정해야 한다.

### 5.4 조회와 승격 정책

조회는 ‘백야의 소유자?’처럼 이름만 던져 바로 값을 덮어쓰지 않고 다음 순서로 진행한다.

1. 표기의 후보를 구한다. ‘도시 백야’와 ‘검 백야’가 있으면 종류·장면 또는 명시 ID로 해소한다.
2. 세계선·시점·관점에 적용되는 채택값을 기존 resolver로 고른다.
3. 값과 함께 출처 판본·근거·미해결 충돌을 반환한다. 복수 후보, 모르는 값, 조사 범위 부족은 각각 구별한다.

채택·검증의 자격은 엔진 정책과 기존 승인 경계가 소유한다. 모델이 자신의 confidence나 ‘필요 근거 수준’을 바꿔 스스로 채택 자격을 낮추게 하지 않는다. author-decision, 명시적 본문 관측, 규칙 도출, 모델 해석은 서로 다른 자격 경로를 가진다.

이야기 속 상태 변경, 기존 기록 정정, IF 분기, 인물의 오해, 원고 수정으로 인한 근거 교체는 별개 이유로 기록한다. 예를 들어 왕이 8화에 실제로 죽으면 생존 기간의 경계가 바뀌지만, 2화 오기 정정은 세계 시간이 흘러 생긴 변화가 아니다.

원문을 개정해도 과거 고정 판본의 근거와 lock은 보존한다. 현재 판본에 대한 해석만 의존성에 따라 재검사한다. 미래에는 근거→value/해석→장면/계획→lock의 연결로 영향 후보를 계산하되, 자동 계획 재작성이나 과거 lock의 변경으로 이어지지 않게 한다.

hard/soft/critic의 의미와 집필 workflow는 유지한다. soft와 critic advisory는 근거·관찰로 기록하며 자동 수정·정본 승격 이유로 삼지 않는다. unknown도 그 장면의 필수 요구값일 때만 진행을 막는다. 의도적으로 남겨둔 세계관의 빈칸과 장기 복선은 집필 차단 사유가 아니다. 사용자가 끈 검토는 `disabled_by_user`로 남기며 실패로 계산하지 않는다.

## 6. 권장 실행 순서와 검증 기준

| 순서 | 범위 | 끝났다고 볼 기준 |
| --- | --- | --- |
| P0 | 동명 자동 합침과 name fallback 보호 | 다른 대상 ‘백야’ 두 개가 별도 ID/fields로 유지. 이름만 조회하면 후보 반환. 기존 ID 조회는 동일 결과 |
| P0 | ensure 의미 불일치 재사용 보호 | 전투 rank와 귀족 rank가 새 ID+같은 구조라는 이유로 재사용되지 않음. 동일 판본 재시도는 멱등 |
| P1 | 근거 판본·위치·basisKind 연결 | 핵심 추적 값에서 원고/설정의 정확한 근거로 이동 가능. 기존 세계값의 의미는 바뀌지 않음 |
| P1 | 관측·해석·정본 채택·관점 분리 | 인물의 사망 발언이 자동 world 사망이 되지 않음. 본문 없는 작가 채택도 유효 |
| P2 | unknown·충돌·영향 연결 | 지지/반박과 처분 이력 보존. 원고 개정 때 현재 의존 주장만 재검사 대상으로 표시 |
| P2 | 범위별 완료·감사 조회 | 필수 값 미정만 차단. advisory·의도적 미정·사용자 비활성 검토를 실패로 취급하지 않음 |

각 단계에 과거 판본 replay, 명시 ID의 기존 동작, 승인/auto 경계, stale receipt 차단을 회귀 조건으로 둔다. 새 문법을 넣기 전에 레거시 이름 참조의 읽기 전용 진단과 이행 계획이 필요하다. 범용 그래프 DB나 단일 거대 세계 상태 기계의 도입은 첫 단계의 필수 조건이 아니다.

## 7. 조사 검증과 한계

- 런타임 파일, 정본 원문, `.vibelore/`를 수정하지 않았다. 조사 보고서 2개만 추가했다.
- 순수 함수의 메모리 입력으로 registry 직접 등록/ensure, 장부 동명 등록, 동명 장면 선택·언급 활성화, 민감어 중복 삽입·다의어 검출을 재현했다. 사용자 작품을 입력으로 사용하지 않았다.
- 기본 seed 중복 수는 민감어 term, 감정 동사 verb, 의성·의태어 word, 직유 marker를 각각 올바른 키로 집계했다. 모든 seed의 키 중복은 0이었다.
- 아래 관련 기존 테스트를 실행해 **116개 통과, 실패 0개**를 확인했다. 테스트 통과는 현행 동작의 회귀 확인이며 다의어·동명 대상 안전성의 완성을 뜻하지 않는다.
- REA는 공식 코드·문서의 정적 조사다. 설치·실행·전체 provider 정확성·성능을 검증하지 않았다.
- 개선안은 아직 구현·성능 측정·실제 작품 이행을 하지 않았다. 개별 작품에 이미 혼합된 항목이 있는지, 수동 분리가 얼마나 필요한지는 별도 읽기 전용 데이터 감사가 필요하다.

실행한 테스트의 고유 파일 목록:

```sh
node --test \
  test/lore-registry.test.js \
  test/shared-lore-extension.test.js \
  test/shared-lore.test.js \
  test/review-audit.test.js \
  engine/test/continuity/ledger.test.js \
  engine/test/continuity/lexicon-precision-259.test.js \
  engine/test/core/entity-context.test.js
```

실행 환경은 로컬 Node v23.11.0이다. package.json의 공식 지원 범위는 Node 22/24/26 계열이므로 이 결과를 지원 버전 전체의 CI 결과로 확대하지 않는다.
