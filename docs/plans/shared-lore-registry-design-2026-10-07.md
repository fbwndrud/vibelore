# SharedLore — AI가 확장하는 정의 등록부

2026-10-07. 사용자의 제안을 반영한 설계 보강이다. [구현 계획](shared-lore-implementation-2026-10-06.md)과 [엣지 케이스 검토](shared-lore-edge-cases-2026-10-06.md)의 고정 필드 목록을, 판본이 있는 정의 등록부와 장르별 시작 묶음으로 바꾼다. 정의 등록·독립 저장·순수 값 해석과 [공유 채택·작품 binding/receipt 연결](../reference/SHARED_LORE_RUNTIME.md)을 구현했다. [등록부 구현 계약](../reference/SHARED_LORE_REGISTRY.md)은 아래 장기 계약의 일부이며 scene 단위 검사와 자산 연결은 아직 남아 있다. 성능 벤치마크는 측정하지 않았다.

## 1. 권고

**창작 용어와 속성·관계 종류는 AI가 필요에 따라 등록한다. 저장·해석의 기본 동작은 작은 공통 계약으로 고정한다.**

키를 전부 사전 열거하는 구조보다 사용자 제안이 지속적인 작품 확장에 적합하다. 다만 키 문자열과 값을 자유롭게 저장하는 것만으로는 성립하지 않는다. 등록하는 것은 정의·타입·소유 원천·적용 범위·제약의 묶음이다.

세 가지 동작을 구별한다:

- 데이터 추가: 이미 등록된 마나 최대량의 값을 어떤 인물에 기록한다.
- 정의 추가: 현재 등록부에 없는 계약 관계를 기존 관계·범위·제약 동작으로 정의한다.
- 엔진 동작 추가: 아직 지원하지 않는 개인 경험 시간축이나 계산 연산을 구현한다.

첫 두 가지는 AI 중심으로 진행할 수 있다. 세 번째는 새 키를 추가했다고 구현 완료가 되지 않는다. AI가 구현할 수도 있지만 코드 변경과 수용 검증을 포함하는 개발 작업이다.

## 2. 고정할 것과 동적으로 열 것

| 영역 | 정책 |
| --- | --- |
| 영구 ID, 판본, 승인 근거, 불변 입력 | 공통 계약 |
| 세계선·시점·관점·출현의 범위 해석 | 지원되는 동작을 명시. 필요한 범위 동작은 엔진 구현 |
| 값 타입·참조·카디널리티·구간 검증 | 공통 해석기 |
| 인물·종족·물품 등 창작 대상 종류 | EntityTypeDefinition으로 확장 |
| 마나·계약·저주·회귀 횟수 등 속성 이름 | FieldDefinition으로 확장 |
| 가족·주종·빙의 등 연결 종류 | RelationDefinition으로 확장 |
| 장르별 권장 항목·추출 질문 | GenrePreset으로 제공 |
| 계산·제약 | 지원되는 선언형 연산의 조합으로 확장 |
| 아직 없는 연산·인과 정책·시간축 | capability 요구를 기록하고 미지원 처리 |

장르는 초기 seed와 자연어 가이드다. 장르 이름에 따라 필드 허용 여부나 사건의 참을 결정하지 않는다. 작품에서 발견한 필요로 등록부를 확장한다.

## 3. 정의와 값의 실제 형태

다음은 제안된 문서 예시다. 짧은 revision ID는 읽기용 표시이며 실제로는 내용 hash다.

```json
{
  "fieldId": "f-mana-capacity",
  "namespace": "universe-u1",
  "key": "mana.capacity",
  "label": "마나 최대량",
  "aliases": ["최대 MP"],
  "definition": "인물이 해당 상태에서 보유할 수 있는 마나의 최대량",
  "subjectTypeIds": ["type-character"],
  "valueType": {"kind": "number", "unitId": "unit-mana-point"},
  "owner": "state",
  "requiredScopes": ["continuity", "worldPoint"],
  "cardinality": "one",
  "constraints": [{"op": "minimum", "value": 0}],
  "missingPolicy": "unknown",
  "requiredCapabilities": ["numeric-value-v1", "state-at-point-v1"]
}
```

마나 현재량은 같은 필드가 아니다. 필요하면 별도 f-mana-current를 정의한다. 둘 사이에 current<=capacity라는 관계를 검사하려면 해당 cross-field 연산을 사용하고 실제 적용 범위를 함께 정한다. 값 하나가 미정이면 부등식을 통과했다고 판단하지 않는다.

```json
{
  "subject": {"kind": "entity", "entityId": "character-a"},
  "fieldDefinitionRevisionId": "field-mana-capacity-r1",
  "value": 120,
  "storyScope": {
    "timelineId": "T1",
    "fromPointId": "awakening",
    "untilPointId": null
  },
  "evidenceIds": ["state-awakened-r1"]
}
```

이는 해당 state의 등록된 필드 값 예시다. 별도 TemporalFact에 같은 값을 중복 소유시키지 않는다. 모든 설명을 시간 fact로 분해하지 않으며 풍부한 profile/state 원문을 유지하는 혼합안 B는 그대로다.

필드의 stable ID와 사람이 읽는 key/label을 구별한다. 표시 이름을 수정해도 fieldId는 유지한다. 정의의 의미·타입·소유 원천을 바꾸면 새 revision과 필요한 이행을 만든다. 값은 자신을 해석한 정확한 definition revision을 참조한다.

RegistryRevision은 EntityType/Field/Relation/Unit/Projection 정의의 불변 revision 참조를 가진다. LoreRevision과 ProductionLock이 사용하는 RegistryRevision을 고정한다. 구형 값을 최신 정의로 자동 재해석하지 않는다.

## 4. 정의가 담당할 계약

각 definition에는 다음이 필요하다:

- stable ID, namespace, canonical key, 별칭, 자연어 의미와 예시.
- 대상 타입, 값 타입 또는 참조 대상 타입.
- profile/state/fact/relation/observer/runtime 중 소유 원천.
- 필요한 범위와 그 범위의 시간축.
- 단일 값/다중 값, 방향성, 역관계 등 해당 타입의 규칙.
- 타입·범위·참조 검사와 선언형 제약.
- unknown 처리, 필수 여부, 지원 capability 요구.
- 변경 근거, 정의 revision, 사용 중인 판본과의 호환성.

소유 원천은 definition이 소유한다. 기존 계획의 OwnershipRulesRevision은 RegistryRevision과 조합 정책을 참조하는 검증 입력으로 만들며 같은 소유 정보를 독립 편집하는 두 번째 원천으로 만들지 않는다.

필드 추가만으로 새로운 상태를 사실로 인정하지 않는다. schema 등록과 인물의 값 채택은 서로 다르다. 형식 제약과 작가의 서사 불변식도 구별한다. 예를 들어 숫자의 타입 검증과 절대로 줄지 않는 능력이라는 서사 규칙은 별개다. 장르 가이드나 AI 추측을 hard invariant로 자동 승격하지 않는다.

## 5. AI의 확장 흐름과 자동화 정책

```text
새 작품/장면에서 필요한 정보를 발견
  → 현재 세계 등록부와 사용 중인 정의를 검색
  → 같은 의미의 정의가 있으면 재사용
  → 없으면 정의와 사용 예시·검사 예시를 제안
  → meta-schema / 참조 / 소유 충돌 / capability / 의미 중복 후보 검사
  → 허용된 추가면 자동 등록, 변경이면 이행 검토
  → 새 RegistryRevision을 고정한 입력으로 값 생성·검사
  → 기존 작품 workflow의 승인·확정 조건으로 채택
```

사용자가 맡긴 범위의 **기존 값에 영향을 주지 않는 새 정의 추가**는 지원 동작과 검증 조건을 충족하면 자동 등록한다. 새 키마다 사람의 승인을 요구하는 인터뷰를 추가하지 않는다. 정의·이유·판본은 변경 기록에 남긴다.

자동 등록 조건은 현재 사용 중인 정의의 의미와 값 해석을 바꾸지 않고, 기존 field를 재소유하지 않으며, 참조·계산·타입 검증이 가능하고, 지원 capability 내에 있어야 한다는 것이다. 중복 의미 검색은 후보 탐지이며 절대적인 증명은 아니다. 비슷한 두 키를 무조건 통합하지 않는다.

기존 정의의 타입/의미/소유 변경, field 병합, hard 서사 규칙 추가는 차이와 영향을 기존 검토 흐름에 보여 준다. 사용자에게 받은 자동화 범위 밖의 결정은 임의로 확정하지 않는다. 미지원 capability는 required_capability로 기록하며 해당 필수 결과를 unknown으로 숨겨 확정하지 않는다.

AI가 작성한 예시·테스트는 등록 검증 자료다. 그것만으로 작가의 의도나 세계의 사실이 증명되는 것은 아니다. 실제 원고·설정 근거와 결정론 검사 결과를 함께 보존한다.

## 6. 판본·동시성·집필 순서

초기 구현은 RegistryRevision을 세계 저장소의 불변 객체로 보관하고 LoreRevision이 이를 참조하게 한다. schema만 추가하는 채택은 기존 세계 사실을 유지한 새 LoreRevision으로 표현할 수 있다. 기존 작품·제작 lock은 이전 판본을 유지한다.

사용자가 위임한 비파괴적 schema 추가가 새 작업에 필요하면 해당 작업의 후보 binding에 새 판본을 명시한다. 이미 발급된 receipt를 조용히 재사용하지 않고 입력을 다시 고정해 검사한다. 일반적인 세계 사실 변경·원고 승인과의 차이를 지키며 기존 lore_write의 순서를 분해하지 않는다.

공유 신규 정의와 그 정의를 사용하는 세계 값을 함께 채택할 때는 하나의 LoreRevision에서 참조 전체를 확정한다. 작품 내에서만 생성된 관찰은 계속 작품이 소유하고 공유 값 채택은 별도 proposal로 진행한다. 등록된 키가 있다는 이유로 모든 작품의 값을 공유하지 않는다.

같은 key에 서로 다른 정의가 동시에 제안되면 CAS와 namespace 충돌 검증으로 조정한다. 서로 다른 fieldId를 새 key 하나에 자동 합치지 않는다. 같은 의미의 두 정의를 병합하는 경우 기존 참조와 제작 lock을 보존하는 alias/migration을 명시한다.

## 7. 선언형 해석과 새 동작의 구별

초기 연산 후보는 숫자 범위·enum·참조 타입·관계 수·동일 scope의 값 충돌·기간 적용·허용된 필드 비교다. 몸 교환의 controlsBody처럼 subject→object 참조를 따라 외형을 읽는 Projection은 엔진이 구현한 scoped lookup/follow 연산으로 선언한다. 선택 결과가 둘 이상이면 임의 최신값을 쓰지 않는다.

AI는 지원 연산으로 projection·제약을 조합할 수 있다. 임의 JavaScript나 자연어 한 줄을 실행 가능한 resolver로 취급하지 않는다. 자연어 규칙은 모델 검토의 advisory로 남길 수 있다. unsupported 계산을 검사 통과로 보고하지 않는다.

회귀 횟수라는 숫자 field는 등록만으로 추가 가능하다. 그러나 세계 시간이 뒤로 가도 미래 기억을 유지하는 동작은 ExperiencePath 해석이 필요하다. 이를 처음 도입하는 것은 capability 구현이다. 이후 해당 동작을 사용하는 장르·세계 용어는 등록부에서 확장한다.

추가 field가 기존 reference/interval 동작으로 표현된다는 것과 모든 인과 정책이 자동 지원된다는 것은 다르다. 이 구별 때문에 공통 해석기의 역할이 유지된다.

## 8. 양과 깊이에 대한 운영 설계

키 개수가 증가하는 것 자체는 새 타입마다 코드를 추가하는 방식보다 감당하기 쉽다. 실제 비용은 값·판본 수, 조회 횟수, 관계 확장, 계산 의존, 전체 정의를 prompt에 넣는 토큰 비용에서 발생한다. 현재 성능 측정 없이 무제한으로 버틴다고 단정하지 않는다.

운영 기준:

- definition은 불변 객체로 재사용하고 registry는 참조를 보관한다.
- 매번 모든 키를 모델에 전달하지 않고 현재 cast·장면·관점에 필요한 정의만 제공한다.
- 정의 검색은 key/별칭/대상 타입/설명으로 수행하고 같은 요청 내 결과를 재사용한다.
- subject + field + 적용 범위의 조회 index와 revision별 컴파일 cache를 재생성 가능한 자료로 둔다.
- 관계는 ID 참조로 저장하고 객체 전체를 재귀로 내장하지 않는다.
- 데이터 관계의 순환은 허용할 수 있지만 조회는 visited/깊이/건수/시간 budget을 적용한다. 순환을 무조건 데이터 오류로 보지 않는다.
- 계산 정의의 순환은 지원하는 명시적 계산 모델이 없으면 등록 때 거부한다. 관계 순환과 계산 순환을 구별한다.
- 조회 budget이 부족하면 결과에 incomplete를 표시한다. 못 읽은 사실을 사실 없음으로 판정하지 않는다.
- 규모가 커지면 registry 참조 map과 사실 목록을 chunk로 나누어 변경 부분만 보존한다. 긴 parent chain 재생 대신 checkpoint를 둔다. 측정 전부터 임의 저장 성능 수치를 제시하지 않는다.

데이터 객체의 중첩 제한과 관계 graph의 탐색 제한은 서로 다른 정책이다. 처음에는 정의 수·값 수·관계 분기·조회 scope를 바꾼 fixture로 읽기/저장 시간과 prompt 크기를 측정한다.

## 9. 구현 순서 변경

1. meta-schema, stable ID, Field/Type/Relation definition, RegistryRevision, capability manifest를 먼저 설계한다.
2. lifeStatus/location/itemOwner 등 기존 필드를 seed definitions로 만들고 기존 형태와 해석 결과를 비교한다.
3. Registry 검색·제안·등록의 AI workflow와 자동 추가 정책을 구현한다.
4. RegistryRevision을 LoreRevision·binding·ProductionLock·검사 receipt에 연결한다.
5. 장르별 시작 묶음은 추천 정의와 질문으로 제공한다.
6. 엣지 케이스를 새 definition만으로 처리할 수 있는 것과 추가 capability가 필요한 것으로 나누고 실제 resolve 결과를 검증한다.

필수 검증은 새 마나 field를 코드 수정 없이 등록하기, 별칭 재사용, 타입 변경 후 옛 값 재현, 두 작품의 같은 key 충돌, 정의 변경에 따른 receipt 재검사, 같은 field 이중 소유 거부, 미지원 시간축 거부, 관계 순환 조회 종료, 불완전 조회에서 false를 만들지 않기다.

이는 필요한 field부터 구조화하는 B의 확장이다. 모든 원문을 전면 fact store로 옮기는 C나, 모든 domain 의미를 AI가 즉석 코드로 구현하는 구조를 선택한 것이 아니다.
