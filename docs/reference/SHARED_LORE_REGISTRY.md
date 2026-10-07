# SharedLore 정의 등록부 — 구현 계약

2026-10-07. 현재 구현의 지원 범위를 설명한다. 소설·세계 설정 원문·이미지 저장소를 합치는 전체 이행의 완료를 뜻하지 않는다.

## 현재 제공하는 것

`lore_registry`는 소설이 없는 공유 세계 디렉터리에서 사용할 수 있다. 호스트 AI는 검색 결과와 자연어 의미를 읽고 기존 정의를 재사용하거나 새 정의를 작성한다. 도구는 정의를 검증하고, 허용되는 비파괴적 추가를 사람의 키별 승인 없이 등록한다. 도구 자체가 LLM을 호출하거나 원고에서 자동 추출하지는 않는다.

| 영역 | 실제 지원 |
| --- | --- |
| 정의 | entityType, unit, field, directed relation. stable ID, namespace, key, 별칭, 의미, 불변 판본 |
| 값 | text, boolean, finite number, safe integer, enum, typed entity reference |
| 소유 | profile, state, fact, relation, observer. 값의 owner와 정의 owner가 반드시 일치 |
| 범위 | continuity, 명시적 timeline의 순서가 있는 worldPoint, observer ID, occurrence ID |
| 제약 | minimum/maximum, text minLength/maxLength. 문자열 길이는 Unicode code point 수 |
| 조회 | one/many, 근거 추적, unknown/conflict/incomplete, subject+field index |
| 동시성 | 공유 세계 root별 잠금, expectedHead 비교, 불변 객체, atomic HEAD |
| 시작 묶음 | base(인물·장소·물품·생존·위치·소유), fantasy(base+마나). 추천이며 서사 규칙 아님 |

한 타입마다 소스 코드를 추가하지 않는다. 새 필드가 지원 범위 내에 있으면 정의 데이터만 등록한다. `requiredCapabilities`에 아직 없는 동작을 쓰면 `REQUIRED_CAPABILITY` 오류다. 알 수 없는 타입·연산·범위도 거부한다. 단위는 기록과 참조를 지원하며 단위 변환을 수행하지 않는다.

## 호스트 AI의 호출 순서

1. `status`로 universeId, HEAD, capability를 확인한다. `registryRoot`는 작품과 독립된 공유 세계의 절대 경로를 명시한다.
2. `search`로 key·별칭·설명을 검색한다. `exact`는 key/별칭 일치이고 `candidate`는 부분 문자열 일치다. 의미 동등성은 AI가 문서와 근거를 읽어 판단한다. 검색이 자동 병합하거나 의미 동일성을 증명하지 않는다.
3. 기존 의미와 맞으면 반환된 stable ID와 definition revision을 사용한다. 없으면 정의와 사용 이유를 작성한다.
4. `register(expectedHead,reason,definitions)`로 지원되는 새 정의를 추가한다. 신규 대상 타입·단위·필드를 한 묶음에 넣어 함께 검증할 수 있다. 같은 ID의 동일 정의 재등록은 no-op이다.
5. `resolve`에는 반환된 정확한 RegistryRevision과 입력을 고정한다. 원고·공유 사실 채택은 기존 승인 절차의 별도 작업이다.

AI가 집필·대본 중 새 항목이 필요하면 `ensure(needs, reason, operationId)`로 위 1~4를 한 번에 수행한다. 같은 namespace의 key·별칭이 있으면 제안 ID를 버리고 기존 정의를 `reused`로 돌려준다. 새 정의는 검증 뒤 `registered`, 기존 ID의 의미·타입·owner 변경은 `.vibelore/shared-lore/registry/migrations/`에 후보로만 기록하는 `migration_required`, 미지원 capability는 `unsupported`다. 결과의 `registryRevisionId`를 세계 값 채택(`lore_universe propose`)에 고정한다. 정의 등록은 세계 사실 채택이 아니다. `operationId`는 `registry/operations/`에 결과를 남겨 handoff·resume·재시도가 첫 결과를 재생하게 하며, 다른 요청에 재사용하면 `OPERATION_CONFLICT`다. 이미 발급된 lock·영수증은 바뀌지 않으므로 새 값을 쓰려면 세계 채택 → binding 재연결 → 같은 workflow 재검사 순서를 따른다.

`STALE_LORE_HEAD`이면 현재 HEAD를 다시 조회하고 정의 중복을 다시 검색한 후 재시도한다. 같은 key나 별칭을 다른 stable ID로 등록하면 `DEFINITION_CONFLICT`다. 기존 ID의 의미·타입·owner·별칭 변경은 `DEFINITION_MIGRATION_REQUIRED`이며 현재 도구가 이행을 실행하지 않는다. AI가 오류를 우회하려고 새 ID를 만들어 같은 의미의 기존 정의를 대체하지 않는다.

등록부의 판본은 다음 호출로 시작한다. 예시 경로는 사용자가 선택한 실제 공유 세계 경로로 바꾼다.

```json
{
  "action": "register",
  "registryRoot": "/absolute/path/to/shared-world",
  "universeId": "u1",
  "expectedHead": null,
  "preset": "base",
  "reason": "세계의 인물·장소·물품 시작 정의"
}
```

그 후 TS 전후 신체 형태가 필요하면 다음 정의를 `definitions` 배열에 넣는다. `expectedHead`는 앞 호출의 `head`로 바꾼다. key는 안정적인 기계 문자열이고 표시 이름·설명은 작품 언어로 쓸 수 있다.

```json
{
  "schemaVersion": 1,
  "kind": "field",
  "id": "field-body-form",
  "namespace": "u1",
  "key": "body.form",
  "label": "신체 형태",
  "aliases": ["몸 형태"],
  "definition": "해당 시점에서 인물이 가진 신체 형태. 정체성은 같은 인물 ID로 유지한다.",
  "subjectTypeIds": ["type-character"],
  "valueType": {"kind": "enum", "values": ["original", "transformed"]},
  "owner": "state",
  "requiredScopes": ["continuity", "worldPoint"],
  "cardinality": "one",
  "constraints": [],
  "missingPolicy": "unknown",
  "requiredCapabilities": ["state-at-point-v1"]
}
```

모든 정의는 `schemaVersion,kind,id,namespace,key,label,aliases,definition,requiredCapabilities`를 가진다. unit은 `symbol`도 필요하다. field/relation의 추가 필드는 위 예시의 닫힌 schema를 따른다. relation은 `kind=relation`, `owner=relation`, reference valueType, `direction=directed`다. `LORE_DEFINITION_SCHEMA`를 엔진 공개 export로 제공하며 MCP `tools/list`에도 같은 스키마가 들어간다.

namespace 내 key/별칭 충돌은 타입 종류와 무관하게 거부한다. stable ID는 한 universe 전체에서 유일하다. 다른 namespace의 같은 key는 다른 stable ID로 등록할 수 있다. 참조는 stable ID를 사용하고 registry가 실제 채택한 정확한 definition revision으로 해석한다.

## 값과 시점

`resolve`의 `input`은 `entities`, `timelines`, `values`다. 이 도구는 입력 값을 공유 정본에 저장하지 않는다. 아래 revision 표시는 설명용이며 실제로는 검색 결과의 `sha256:` hash를 사용한다.

```json
{
  "entities": [
    {"id": "character-a", "typeDefinitionRevisionId": "<type-character revision>"}
  ],
  "timelines": [
    {"id": "t-main", "continuityId": "main", "pointIds": ["before", "transformed", "recovered"]},
    {"id": "t-if", "continuityId": "if", "pointIds": ["before", "transformed", "recovered"]}
  ],
  "values": [
    {
      "id": "state-before-body",
      "subject": {"kind": "entity", "entityId": "character-a"},
      "fieldDefinitionRevisionId": "<body.form revision>",
      "owner": "state",
      "value": "original",
      "storyScope": {"continuityId": "main", "timelineId": "t-main", "fromPointId": "before", "untilPointId": "transformed"},
      "evidenceIds": ["character-sheet-r1"]
    },
    {
      "id": "state-transformed-body",
      "subject": {"kind": "entity", "entityId": "character-a"},
      "fieldDefinitionRevisionId": "<body.form revision>",
      "owner": "state",
      "value": "transformed",
      "storyScope": {"continuityId": "main", "timelineId": "t-main", "fromPointId": "transformed", "untilPointId": "recovered"},
      "evidenceIds": ["transformation-scene-r1"]
    }
  ]
}
```

구간은 `[fromPointId, untilPointId)`이고, 끝을 정하지 않았으면 `untilPointId=null`이다. point ID의 숫자나 이름에서 시간을 추측하지 않고 timeline.pointIds의 명시적 순서만 사용한다. 같은 person ID가 다른 state 값을 가진다. IF 값은 `if/t-if` 범위에 따로 넣는다. IF에서 main 값을 자동 상속하지 않으며 해당 IF에 값이 없으면 unknown이다.

`storyScope`의 필드는 definition.requiredScopes와 정확히 일치해야 한다. worldPoint는 continuity도 요구하고 state owner는 worldPoint를 요구한다. observer owner는 observer scope가 필수다. observerId는 입력 entities에 있는 실제 인물이어야 한다. occurrenceId는 출현 문맥의 식별자이며 이 단계에는 별도 occurrence 저장소나 시간 여행 인과 정책이 없다.

조회 query 예:

```json
{
  "subjectId": "character-a",
  "fieldId": "field-body-form",
  "scope": {"continuityId": "main", "timelineId": "t-main", "pointId": "transformed"},
  "maxCandidates": 10000
}
```

one 필드에서 같은 범위의 다른 값이 겹치면 conflict다. 같은 값의 근거가 여러 개면 근거를 합친다. many는 적용되는 서로 다른 값과 근거를 반환한다. false·0·빈 문자열은 각각 정상 타입 값이며 미정으로 바꾸지 않는다. 아직 근거가 없으면 unknown이다. 입력 전체를 먼저 검사하므로 미사용 값의 잘못된 타입·참조·소유도 거부한다.

해석 결과에는 `registryRevisionId`, `inputRevisionId`, `fieldDefinitionRevisionId`가 들어간다. 이는 입력의 판본 식별이며 현재 집필 receipt 또는 ProductionLock의 대체물이 아니다. inputRevisionId는 entities/timelines/values와 registryRevisionId의 hash다. evidenceIds는 추적용 외부 근거 ID이며 이 단계는 해당 원문 존재·승인·내용을 검증하지 않는다.

## 저장과 제한

도구가 `.vibelore/shared-lore/registry/`에 definition 객체, 참조로 구성된 registry checkpoint, 독립 HEAD를 쓴다. 사람이 직접 이 폴더를 편집하지 않는다. 객체는 내용 hash로 식별하고 읽을 때 검증한다. 등록은 전체 묶음을 검증한 후 불변 객체를 쓰고 마지막에 HEAD를 원자적으로 바꾼다. HEAD가 바뀌어도 과거 판본은 유지한다. 세계 등록 도구는 작품 rollback을 재개하거나 Foundation을 생성하지 않는다.

초기 구현 한도는 registry 10,000개 정의, 한 등록 1,000개 정의, 검색 반환 100개, 해석 입력 100,000개 값이다. query의 candidate budget은 subject+field에 해당하는 전체 후보 건수에 적용한다. budget 초과 결과는 incomplete이며 value를 발급하지 않는다. 필요한 범위를 더 좁혀 입력을 구성하거나 budget을 늘려야 한다. 이 한도는 처리량 보장이나 규모 벤치마크 결과가 아니다.

관계 값은 `{entityId}` 참조이며 대상 타입과 존재를 검사한다. A→B→A 같은 데이터 관계는 저장할 수 있고 단일 조회가 자동으로 관계를 재귀 탐색하지 않는다. graph follow, projection, cross-field 계산, 역관계 추론, 단위 변환, 개인 경험 시간축, 분기 상속은 아직 지원하지 않는다.

현재 add-only registry는 기존 정의 개정을 제공하지 않는다. [공유 원문·상태 채택과 작품 연결](SHARED_LORE_RUNTIME.md)을 별도 구현했다. LoreRevision, 명시적 binding, 장면 단위 검사, 집필 입력 lock/receipt 연결, 이미지 카탈로그와 원고 없는 대본 웹툰 경로를 제공한다. 기존 소설 엔진의 hard/soft 검사와 집필 승인 순서는 유지한다.
