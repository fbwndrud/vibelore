# SharedLore 엣지 케이스와 데이터 계약 검토

2026-10-06. [구현 계획](shared-lore-implementation-2026-10-06.md)에 대한 설계 검토다. **아직 SharedLore 구현과 수용 테스트를 수행하지 않았으므로 어떤 항목도 운영에서 지원 완료라고 주장하지 않는다.** 여기서 기본은 현재 제안 타입으로 표현 가능한 사례, 확장은 추가 타입·해석·검사 계약이 필요한 사례, 판단은 작가의 정체성/인과 정책 결정도 필요한 사례다.

2026-10-07 보강: [정의 등록부 설계](shared-lore-registry-design-2026-10-07.md)에 따라 확장을 **지원 동작을 쓰는 정의 추가**와 **아직 없는 엔진 capability 구현**으로 나눈다. 등록부로 표현되는 새 키·관계마다 별도 코드 Module을 만들 필요는 없다. 아래 후보 타입은 해석 의미를 설명하는 자료이며 모두를 미리 하드코딩할 목록이 아니다.

기존 구조에 공간을 마련했다는 것, 데이터를 저장할 수 있다는 것, 올바르게 해석하고 검사한다는 것은 다른 단계다. 임의 JSON 저장이나 free-text 설명만으로 지원 완료라 하지 않는다. 아래는 설계 후보와 수용 조건이며 구현된 제품의 JSON이 아니다. 예시의 P10/R12 같은 짧은 값은 읽기용 식별자다. 실제 revision은 불변 내용 hash를 사용한다.

## 1. 사례별 판정

| 사례 | 판정 | 데이터 형태 | 남은 검증 |
| --- | --- | --- | --- |
| 개명·가명·동명이인 | 기본/확장 | 같은 Entity의 이름 상태, 언어·범위 있는 Alias | 시간이 있는 개명은 name 소유권 이행. 인물 자동 통합 금지 |
| 성장·TS·부상·회복·죽음·부활 | 기본 | StateDefinition/Transition, 생사 TemporalFact | 전후 point와 상태 소유권, 생사와 외형의 이중 소유 방지 |
| 노화+변신+부상+복장이 동시에 적용 | 기본, 조합 규칙 필요 | 필드가 겹치지 않는 상태 facet 또는 승인된 합성 상태 | 무조건 override 금지, unknown 조합 차단 |
| 변신/복장이 외형과 실제 정체를 다르게 보이게 함 | 기본/확장 | 진짜 상태, 위장 상태, 관찰/믿음 | 외형에서 정체를 역추론하지 않음 |
| 거짓말·오해·기억상실·불신 화자 | 확장 | Proposition + EpistemicRecord + 작품 공개 기록 | 말한 내용과 세계의 참인 사실을 분리 |
| 비밀 정체가 뒤늦게 공개됨 | 확장 | private Entity 연결, 가명, observer belief, Disclosure | 모델 prompt·소개집·이미지 metadata의 미래 정체 누출 |
| 결혼·가족·원수·충성·소유권이 변화 | 확장 | 타입 있는 RelationFact와 적용 범위 | 방향성·동시 관계 수·자기 관계 규칙을 predicate별 정의 |
| 몸 교환·빙의·환생 | 확장+판단 | person/body Entity, 점유 관계, IdentityLink | 누구의 기억/외형/호칭인지, 동일 인물 정책 |
| 복제·분신·동일 이름의 다른 존재 | 확장+판단 | 별도 Entity, clonedFrom/derivedFrom | 독립 기억과 소지품, 원본과 자동 통합 금지 |
| 미래의 자신과 과거의 자신이 같은 장면에 등장 | 확장 | Entity + 별도 CharacterOccurrence + 개인 경험 위치 | 같은 Entity의 둘을 cast map에서 하나로 합치지 않음 |
| 단순 회상·비선형 공개 | 기본 | stable sceneId→pointId, 공개 순서 별도 | 공개 순서와 세계 시간 혼합 금지 |
| 회귀·타임루프·차원 이동 | 확장+판단 | iteration/세계선, 개인 ExperiencePath, carried beliefs/state | 과거로 가져가는 정보와 물품을 명시, 복제 여부 결정 |
| 사건의 선후가 미정·동시 사건 | 확장 | 부분 순서 timeline, explicit unknown endpoint | 임의 총순서 생성 금지, 관계 불명 상태 반환 |
| 꿈·환각·전설·극중극 | 확장 | NarrativeFrame + 그 안의 claim/context | 작품 속 묘사를 현실 세계 fact로 승격하지 않음 |
| 같은 인물이 다른 세계와 crossover | 확장+판단 | scope alias별 binding + participant별 scope | 같은 이름의 세계선/인물 충돌, 교차 사건의 귀속 |
| 웹툰에서 삭제/압축·영상에서 인물 합침 | 기본/확장+판단 | source map, omission/condensation, 변경 시 별도 continuity | 표현 변경과 실제 사실 변경 구분 |
| 번역 이름·화풍·성우·실사 캐스팅 | 기본/확장 | Alias, ExpressionProfile, AssetVariant/Revision | 언어별 대사와 이미지 선택, 세계 사실 유지 |
| 능력의 조건부 발동·수량·단위·범위 | 확장 | typed predicate + qualifiers/Measurement | 능력 보유와 그 상황의 발동 가능성 구분 |
| 세계 규칙이 특정 사건 뒤 바뀜 | 확장 | 시간 범위 있는 WorldRuleRevision | 기존 무시점 규칙을 상수처럼 검사하지 않음 |
| 두 작품이 같은 시점에 양립 불가능한 사건을 채택 | 기본 | 명시 proposal 충돌/별도 continuity | 마지막 확정 승리 금지, 판본/CAS와 의미 충돌 모두 검사 |
| 과거 설정 정정·원작 개정·이미지 교체 | 기본 | LoreRevision/AssetRevision + ProductionLock | 과거 제작 입력 보존과 새 판본 영향 비교 |
| 인물 삭제·세계 이동·부족한 과거 자료 | 기본/확장 | tombstone/retired, immutable closure, unknown | 참조 삭제 금지, 자료 부족을 확정 사실로 채우지 않음 |

기본과 확장은 작품 요구가 정해지면 더 명확해진다. 예를 들어 현재 고정 이름을 시간별 개명으로 바꾸는 것은 필드 소유권을 바꾸는 실제 이행이며 자동 지원되지 않는다.

## 2. 공통 기록 원칙

신규 타입이 늘어도 기존 SharedLore/ProductionInput Interface를 통해 읽는다. 승인된 사실·관계·상태의 적용은 LoreRevision.continuities의 membership이 결정한다. observer 정보는 별도 관점 projection이고 게임 실행 상태는 플레이 instance가 소유한다. 이들을 같은 사실의 덮어쓰기 후보로 취급하지 않는다.

범위와 식별의 의미:

```text
Entity ID             어떤 존재인가
Occurrence ID         그 존재의 어느 출현/경험 instance인가
LoreRevision ID       어느 채택 판본인가
Continuity ID         어느 세계선의 사실인가
Timeline/Point ID     그 세계 안의 언제인가
ExperiencePath/Step   그 인물이 어떤 순서로 경험했는가
Observer ID           누구의 믿음/인식인가
WorkRevision/Unit ID  작품에서 어디까지 공개했는가
NarrativeFrame ID     현실 장면/꿈/회상된 이야기 중 어느 문맥인가
```

모든 필드를 모든 record에 강제로 넣지 않는다. 타입별 필수 scope를 정의한다. 승인된 세계 fact에 observer만 붙여 주관적 값으로 바꾸거나, 믿음 record에 world truth 소유권을 주지 않는다. 최초 core는 continuity/point/revision을 고정하며 나머지는 요구가 있는 extension에서 구현한다.

원문은 그대로 보존하고 structuring할 항목을 승인한다. 같은 설정을 base/state/relation/fact에 중복 소유하지 않는다. 기계 검사는 선언된 타입·소유권·범위·제약을 확인하며 사건의 문학적 의미와 인물 정체성의 철학을 자동 결정하지 않는다.

## 3. 사람과 몸 — 몸 교환 예시

기존 character Entity는 보통 사람과 몸을 함께 취급한다. 몸 교환이 필요한 작품에서는 Entity의 kind와 소유권을 확장해 사람의 정체/기억, 몸의 외형/신체 상태를 분리한다. 단순 TS 작품마다 반드시 body 객체를 만들지는 않는다.

```json
{
  "people": ["person-a", "person-b"],
  "bodies": ["body-a", "body-b"],
  "loreRevisionId": "R12",
  "continuityId": "main",
  "acceptedRelations": [
    {
      "subjectId": "person-a",
      "predicate": "controlsBody",
      "objectId": "body-b",
      "storyScope": {"timelineId": "T1", "fromPointId": "swap", "untilPointId": "restore"},
      "evidenceIds": ["event-swap-r1"]
    },
    {
      "subjectId": "person-b",
      "predicate": "controlsBody",
      "objectId": "body-a",
      "storyScope": {"timelineId": "T1", "fromPointId": "swap", "untilPointId": "restore"},
      "evidenceIds": ["event-swap-r1"]
    }
  ]
}
```

위 envelope는 채택 범위의 예시다. 실제로 각 RelationFact에 continuity를 중복 저장하지 않고 view가 승인된 relation revision ID를 참조한다.

Resolver는 person-a의 기억·목표, body-b의 외형·손상, person-a가 선택한 호칭, body-b를 본 상대의 오해를 각각 투영한다. controlsBody의 배타 제약은 작품이 배타적 지배를 채택했을 때 적용한다. 공동 지배나 여러 영혼을 허용하는 세계에 무조건 일대일을 강제하지 않는다.

환생·복제에는 reincarnationOf/cloneOf/mergedFrom 같은 명시 IdentityLink를 사용한다. 새 Entity를 원래 Entity로 자동 통합하지 않는다. 환생을 같은 인물로 볼지, 기억만 이어지는 새 존재로 볼지는 작가가 정한다. 기억의 이전은 별도 데이터로 표현한다.

## 4. 사실·믿음·독자 공개 — 거짓말 예시

Proposition은 내용의 식별이며 참이라는 권위를 갖지 않는다. 세계의 사실은 기존 승인 profile/state/TemporalFact가 소유한다. EpistemicRecord는 관찰자의 인식을 소유한다. 안다고 선언하려면 해당 세계 사실과 근거를 확인하고 믿음만으로 지식으로 승격하지 않는다.

```json
{
  "loreRevisionId": "R12",
  "continuityId": "main",
  "proposition": {"id": "P-alive", "subjectId": "person-b", "predicate": "lifeStatus", "value": "alive"},
  "acceptedWorldFact": {
    "subjectId": "person-b", "predicate": "lifeStatus", "value": "alive",
    "storyScope": {"timelineId": "T1", "fromPointId": "fake-death", "untilPointId": null},
    "evidenceIds": ["author-decision-r1"]
  },
  "observerRecord": {
    "observerId": "person-a", "propositionId": "P-alive", "stance": "believes-false",
    "storyScope": {"timelineId": "T1", "fromPointId": "fake-death", "untilPointId": "reveal"},
    "evidenceIds": ["false-report-r1"]
  },
  "disclosure": {
    "workId": "novel-a", "sourceRevisionId": "chapter-7-r1", "unitId": "scene-reveal",
    "propositionId": "P-alive", "presentation": "revealed"
  }
}
```

세계에서 살아 있다는 사실과 A가 죽었다고 믿는 기록은 양립한다. 망각은 관찰자 인식의 변화이며 세계 사실을 삭제하지 않는다. 독자 공개는 작품 공개 순서로 관리하고 세계 point를 공개 순서로 재사용하지 않는다.

세계 기록과 작품 공개 기록의 동시 발행을 요구하지 않는다. Disclosure는 판본이 고정된 Proposition 내용을 참조하고 그 제시·믿음이 세계 사실과 일치하는지 별도로 검사한다. 독자가 반드시 이해한다는 결과를 데이터로 보장하지 않는다.

## 5. 관계와 시간 범위

RelationFact는 subject/predicate/object/qualifiers/storyScope/evidence를 가지며 view가 채택한다. parentOf는 방향 있는 관계, siblingOf는 대칭 조회 규칙을 갖는다. trusts는 관찰자의 방향 있는 인식 기록으로 분리한다. 감정과 신뢰를 객관적 관계로 혼동하지 않는다.

predicate registry에는 domain/range·관계 수·방향성·역관계·필수 qualifiers·소유 필드를 둔다. 결혼의 동시 관계 수는 작품의 세계 규칙에 따라 검사한다. 관계의 종료와 시작은 반개방 구간으로 기록한다. 대칭 관계를 두 방향의 독립 원천으로 중복 저장하지 않고 조회 시 도출한다.

조건부 능력은 holdsAbility 관계와 상황별 canActivate 판정을 구별한다. 수량은 unit을 포함한다. 단위가 다른 10과 10을 같은 값으로 보지 않고 변환·조건이 미정이면 unknown을 반환한다. 임의 코드를 조건식으로 실행하는 기능은 초기 계약에 넣지 않는다.

## 6. 시간 여행·회귀 — 세계 순서와 경험 순서

단순 회상은 기존 point mapping으로 표현한다. 회귀자가 미래를 기억하며 과거로 돌아왔을 때 기억을 세계 point만으로 필터하면 잘못된다. 개인 ExperiencePath와 step에 기억·지식의 획득을 연결해야 한다.

```json
{
  "entityId": "person-a",
  "experiencePathId": "traveler-a-r1",
  "orderedSteps": [
    {"stepId": "experience-1", "loreRevisionId": "R12", "continuityId": "loop-1", "pointId": "year-20"},
    {"stepId": "experience-2", "loreRevisionId": "R13", "continuityId": "loop-2", "pointId": "year-10"}
  ],
  "transfer": {
    "fromStepId": "experience-1", "toStepId": "experience-2",
    "carriedEpistemicRecordIds": ["knows-secret-r1"],
    "carriedItemIds": []
  }
}
```

개인 경험은 experience-1→2지만 세계 시간은 20→10이다. loop-1의 모든 타인 상태를 loop-2로 복사하지 않는다. 기억만 이전할지 몸·물품도 이전할지 명시한다. transfer는 개인 상태의 원천을 지정하며 새 세계선에 미래 사건이 이미 일어났다고 기록하는 작업이 아니다.

과거와 미래의 자신이 동시에 등장하면 다음 기록을 추가한다:

```json
{
  "sceneId": "meet-myself",
  "participants": [
    {"occurrenceId": "a-young", "entityId": "person-a", "experiencePathId": "a-native", "stepId": "age-15", "stateRevisionIds": ["a-young-r1"]},
    {"occurrenceId": "a-traveler", "entityId": "person-a", "experiencePathId": "a-travel", "stepId": "after-return", "stateRevisionIds": ["a-adult-r1"]}
  ]
}
```

cast를 entityId만으로 합치지 않는다. 화자·행동·소유물·화면 위치는 occurrence를 가리킨다. 복제는 별도 Entity, 시간 여행자의 다른 출현은 작가의 정책에 따라 같은 Entity의 다른 occurrence다. 변경 가능한 과거·고정 역사·루프 중 정책을 선택해야 인과 제약을 검사할 수 있다. 타입의 존재만으로 역설을 자동 해결하지 않는다.

이는 cast에 ID 하나를 추가하는 것으로 끝나지 않는다. 해당 확장에서는 사실·관계의 subject/object가 EntityRef 또는 OccurrenceRef를 받도록 타입을 확장한다. 같은 point에서 a-young과 a-traveler의 위치·상태를 다르게 해석할 때 소유·충돌의 키도 occurrence를 포함한다. 두 위치를 같은 Entity의 상반된 scalar로 저장하면 기존 validator가 정확히 충돌로 거부하므로 그 방식은 쓰지 않는다.

상태 적용의 시간축도 world point인지 experience step인지 명시한다. 미래에서 돌아온 성인 상태를 현재 세계 연도의 나이 구간으로 검사하지 않는다. 몸의 생물학적 나이·인물의 경험 기간·세계 달력의 경과는 필요한 경우 별도 필드다. 같은 원본 물품이 시간 여행으로 두 개 공존하면 물품 occurrence도 구별하고 각 소유 기록이 해당 물품 출현을 가리키도록 한다. 기억을 가진 observer 역시 어느 occurrence/experience step인지 명시한다.

초기의 단일 전순서 timeline은 선후가 미정인 사건을 해석하지 못한다. 확장 PartialTimeline은 before edges와 동시 그룹을 가지고 compare(a,b)가 before/after/same/unknown을 반환한다. unknown을 false로 바꾸지 않는다. 세계 연대기와 개인 경험의 순서를 같은 그래프에 섞지 않는다.

scope endpoint는 open-ended와 unknown을 태그로 구분한다. 현재 untilPointId:null은 종료를 지정하지 않은 열린 구간이고 종료 시점이 불명인 구간을 뜻하지 않는다. 둘을 null 하나로 표현하면 사실의 유효성을 잘못 확정할 수 있다.

## 7. 꿈·다른 세계·crossover·각색

NarrativeFrame은 현실 장면·꿈·환각·극중극의 문맥을 식별한다. 꿈을 꾼 사건은 현실 세계 기록이 될 수 있지만 꿈 속 죽음을 현실 lifeStatus로 접지 않는다. 사실인 회상과 믿을 수 없는 기억도 구분한다.

crossover는 WorkBinding에 universe/continuity별 scope alias를 추가하고 participant가 읽는 scope를 명시한다. 현재 단일 universe/continuity WorkBinding에는 이 계약이 없다. 같은 entityId/pointId도 scope와 함께 식별하고 세계 규칙이 충돌하면 영역별 적용 정책이 필요하다.

압축 각색은 원작 unit과 새 unit의 source map을 기록한다. 장면 생략을 그 사건이 없었다는 사실로 바꾸지 않는다. 인물을 합치거나 사건 결과를 바꾼다면 별도 continuity의 새 Entity/fact와 derivedFrom 관계를 만들고 main은 유지한다.

언어별 이름은 Alias(language/register/scope)로 관리하며 이름에서 성격·능력을 다시 추론하지 않는다. 성우 선택과 이야기 속 목소리 변화는 ExpressionProfile과 인물 상태로 구별한다. 게임 save data는 session/playthrough가 소유하고 한 플레이의 선택을 공유 LoreRevision으로 자동 채택하지 않는다.

## 8. Resolver와 lock의 확장 계약

필요한 확장을 schemaVersion과 record collections에 채택한다. 예를 들어 relationRevisionIds/epistemicRevisionIds/identityLinkRevisionIds를 ContinuityView에 추가하고 predicate registry·해석 정책 판본을 lock한다. reader가 모르는 필수 확장은 무시하지 않고 UNSUPPORTED_SCHEMA/UNSUPPORTED_EXTENSION으로 중단한다. 원문 보존과 실행 해석을 구별한다.

확장 조회에는 필요한 scope를 명시한다:

```ts
SharedLore.resolve({
  revisionId, continuityId,
  sceneContext: {
    pointId, frameId, participantOccurrences,
    perspective: { observerId, experiencePathId, stepId },
    disclosureContext: { workSourceRevisionId, throughUnitId }
  },
  requirementsRevisionId
})
// -> values / relations / perspectives / evidence / unknowns / conflicts
```

위는 확장 구현 시의 후보 Interface이며 초기 v1에서 모든 scope를 요구하는 계약이 아니다. 채택된 typed records로 투영을 만들고 참조 전체와 query dependencies를 ProductionLock에 보존한다. 세계 사실·관찰자 믿음·독자 공개를 하나의 profile로 합치지 않는다.

확장 사이의 같은 필드 이중 소유와 같은 scope의 상반된 scalar는 validate에서 거부한다. 세계에서는 alive지만 관찰자가 dead로 믿는 경우는 적법한 기록으로 유지한다.

## 9. 구현 계획 반영과 검증 순서

단계 0에 전체 시나리오의 초기 필수/후속/작가 판단 분류를 추가한다. B core만으로 전부 대응한다는 완료 조건을 두지 않는다. 필수 확장은 저장 구현 전에 스키마·resolver 계약에 포함한다. 후속 항목은 원문 보존과 unsupported 검출을 제공하며 해석 완료로 보고하지 않는다.

우선순위 제안:

1. core: 성장·TS·IF·동명 충돌·회상·상태 조합·설정 정정·제작 입력 보존.
2. 관점/관계: 오해·거짓말·비밀·관계 변화의 계약은 초기 schema를 확정할 때 우선 검토한다.
3. 정체성/경험: 몸 교환·회귀·과거 자신과의 동시 등장은 초기 대상 작품이 요구하면 먼저 설계한다. 기존 regression-hunter 장르 이름만으로 공유 정본 대응 여부를 판단하지 않는다.
4. 부분 순서·crossover·조건부 규칙: 실제 작품을 fixture로 정해 구현한다.

테스트는 serialize 성공이 아닌 resolve 결과를 검증한다. 거짓말을 실제 죽음으로 기록하지 않기, 몸 B를 쓰는 사람 A에게 사람 B의 기억을 주지 않기, 회귀 후 미래 기억 보존, 둘의 occurrence를 하나로 합치지 않기, 꿈의 죽음을 현실에 반영하지 않기, 미정 scope를 최신값으로 채우지 않기를 확인한다.

인물 정체성과 인과 규칙을 작가가 명시한 뒤 기계로 검사할 조건을 정한다. 정의하지 않은 의미·철학적 사례를 자동 판정한다고 약속하지 않는다.
