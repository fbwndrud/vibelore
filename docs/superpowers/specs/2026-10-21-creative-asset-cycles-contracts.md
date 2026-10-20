# 제작 자산 순환 — 식별·반입·상태 계약

2026-10-21. [상세 설계](2026-10-21-creative-asset-cycles-design.md)의 계약 부록이다. 아래 타입·명령·파일은 **제안**이다. 기존 기능으로 가장하지 않는다. 예시는 TypeScript 표기이며 구현 언어는 기존 JavaScript ESM을 유지한다. 상태·오류 코드는 번역하지 않고 사용자 설명을 따로 제공한다.

## 식별과 검색 기록

```ts
type OriginRef = {
  ownerId: string;                 // 등록 시 생성·보존한 UUID
  projectId: string;               // 원래 작품/세계/프로젝트 ID
  recordKind: string;              // 소유자 Adapter의 명시적 종류
  recordId: string;
  revision: string;                // native opaque 값. latest 불가
};
type LibraryEntry = {
  ref: OriginRef;
  title: string;
  mediaKind: 'text'|'image'|'audio'|'video'|'structured';
  roles: string[];                 // identity-reference, final-scene 등 의미 역할
  subjects: SubjectRef[];          // owner/인물/세계선/상태의 원래 참조
  expressionRefs: OriginRef[];
  observed: { token: string; at: string; registrationGeneration: number };
  availability: 'unverified'|'observed-available'|'offline'|'missing'|'corrupt';
  capabilities: ('discover'|'preserve'|'inspect'|'derive'|'render')[];
};
```

`SubjectRef`는 `{ownerId, projectId, identityId, continuityId?, stateRefs: OriginRef[]}`다. 서로 다른 owner의 identity는 명시적 대응 없이 같다고 결정하지 않는다. 파일 hash와 제목으로 병합하지 않는다. native recordKind/ID가 같아도 다른 owner면 다른 기록이다.

등록은 private 설정에 `{ownerId, adapterKind, locator, allowedProjects, generation}`을 보존한다. locator는 사용자 선택 경로/실행 소유자 연결이며 portable DTO에 내보내지 않는다. 같은 경로의 저장소가 교체되면 기존 owner로 조용히 이어붙이지 않는다. 이동은 명시적 재연결과 선택한 원천 기록 확인, 복제는 별도 등록을 기본으로 한다. 기존 owner ID와 연결된 과거 Ref는 보존한다.

owner 관측 token은 같은 owner 안에서만 의미가 있다. Library는 token을 native ordering으로 해석하는 Adapter를 사용하거나 snapshot generation을 비교한다. 다른 owner token의 숫자/문자열을 정렬해 최신을 판정하지 않는다. 원천이 꺼진 `offline`과 원천이 정확한 판본의 부재를 확인한 `missing`을 구분한다.

## 보존 묶음

```ts
type AssetBundle = {
  schemaVersion: 1;
  manifestSha256: string;
  roots: OriginRef[];
  records: PreservedRecord[];
  files: { sha256: string; byteLength: number; mime: string; role: string }[];
  links: { from: OriginRef; relation: Relation; to: OriginRef;
           requirement: 'runtime'|'historical-reference' }[];
  disclosure: { includedScope: string; omittedEvidence: string[] };
  capturedAt: string;
};
type Relation = 'derived-from'|'normalized-from'|'adapted-from'|'used-in'|'observed-in';
```

`PreservedRecord`는 `{ref, recordSha256, metadata, requiredFileSha256s, sourcePins, evidenceRefs}`다. recordSha256는 portable record의 canonical JSON hash이며 원래 revision을 덮어쓰지 않는다. manifestSha256은 그 필드 자신을 제외한 manifest의 canonical JSON hash다. 파일은 raw bytes SHA-256을 별도로 검사한다. 내용 hash는 진위 서명이나 실제 감상 증명이 아니다.

소유자 채택/반려 기록은 원래 scope·actor·판본의 관측 근거로 넣는다. 목적지 채택을 뜻하는 `approved=true`로 축약하지 않는다. `runtime` 링크와 필수 파일은 닫혀 있어야 한다. 조상·과거 실험은 immutable Ref와 필요한 요약만 가진 `historical-reference`로 남길 수 있지만 현재 소비 의존성으로 쓰지 못한다. 필수 자료를 redaction으로 제거하면 실행용 묶음으로 통과시키지 않는다.

첫 전달 형식은 `manifest.json`과 `files/<sha256>` 디렉터리다. manifest에 경로·symlink·실행 코드·네트워크 fetch 지시를 넣지 않는다. 내보내는 도구가 등록한 보관 경로만 읽고, 반입 도구가 검증된 hash 이름으로 쓴다. 첫 범위는 압축파일 입력을 지원하지 않는다.

작성자 제안의 기본 상한: manifest 512 KiB, records 256개, links 1,024개, 파일 하나 20 MiB, 파일 합계 24 MiB, JSON nesting 32. byteLength 합산은 중복 hash를 한 번 세되 실제 읽은 길이도 확인한다. 상한 초과는 명시적 실패이며 조용히 자르지 않는다. 현재 HTTP import 128 MiB와 최대 4배인 JSON byte-array 표현을 고려한 초기 범위다. 장시간 음원/영상은 큰 파일 전달 경로를 별도 구현하기 전까지 반입 미지원으로 표시한다. 이 수치는 서비스의 장르·품질·길이 제한이 아니다.

## 공개 Interface

```ts
openLibrary({directory, adapters}): Promise<{
  command(envelope: LibraryCommand): Promise<LibraryReceipt>;
  query(query: LibraryQuery): Promise<LibraryView>;
  close(): Promise<void>;
}>

// 첫 command: owner.register / owner.rebind / owner.unregister / owner.refresh
// query: find / inspect / lineage / uses / cases
// commandId 재사용 + 다른 payload는 충돌. 등록 변경은 expectedRegistryRevision 필요.

interface OwnerAdapter {
  capture({ownerId, allowedProjects, afterToken?}): Promise<OwnerProjection>;
  exportExact({roots, disclosure}): Promise<{manifest: AssetBundle, files: ByteSource}>;
}

inspectReuse({bundle, destination, intent}): Promise<ReuseInspection>
// read-only. 목적지 현재판본과 소유자의 지원 능력을 읽는다.

studio.command({projectId, commandId, aggregate, expectedRevision,
  type: 'asset.importBundle',
  payload: {bundle, bytes, inspectionDigest, intent, actor, reason}}): Promise<ImportReceipt>
```

위 API는 계획 이름이다. public query와 등록 DTO만 작은 facade로 제공하고 `OwnerAdapter`/ByteSource는 호스트 내부 Interface로 둔다. 처음 두 Adapter는 vibelore와 Studio다. UI/MCP가 raw DB·내부 filesystem·registerCommand를 받지 않는다.

`owner.refresh`는 metadata를 읽는 작업이며 생성·이동·원천 수정 권한이 없다. 원천 `openStudio`를 자동 호출하지 않는다. 이미 실행 중인 소유자의 읽기 Interface 또는 **기존 저장소만 여는 읽기 전용 export Adapter**를 사용한다. 파일 기반 Adapter는 일관된 읽기 snapshot·허용 경로·hash를 확인하고 schema 초기화/GC/recovery/migration을 실행하지 않는다. 읽기 실패는 연결 오류로 반환한다.

원천 text/세계/웹툰은 기존 resolver/공개된 원천 기록을 읽는 Adapter를 사용한다. 작업 트리 drift가 있으면 정본 현재값을 추정하지 않고 기존 sync 경로가 필요하다고 보고한다. 원천이 내보낸 허용 문맥과 author-only/공개 범위를 유지한다.

## 목적지 검사와 출처 영수증

```ts
type DestinationIntent = {
  target: { kind: string; id: string };
  mode: 'reuse-preserved'|'new-import'; // 기본 reuse-preserved
  purpose: string;
  identityMap: { source: SubjectRef; destinationIdentityId: string }[];
  stateMap: { source: OriginRef; destinationStateId: string }[];
  selections: { source: OriginRef; slot: DestinationSlot; role: string }[];
};
type DestinationSlot = {
  id: string;
  scope: { kind: 'project'|'production'|'scene'|'shot'; id: string };
  subject: { kind: 'identity'|'role'|'environment'; id: string };
  appearanceStateRef: string|null;
  castingStateRef?: string|null;
  utteranceId?: string|null;
}; // 기존 slotDeclaration 입력. mediaKind는 선택 root에서 확인해 별도 전달
type ReuseInspection = {
  bundleSha256: string;
  destinationPinsDigest: string;
  intentDigest: string;
  disposition: 'compatible'|'needs_decision'|'needs_derivation'|'unsupported'|'blocked';
  materializations: {sourceSha256: string; canonicalSha256: string;
                     metadataDigest: string; normalizerVersion: string}[];
  findings: { kind: 'contract'|'context'|'advisory'; code: string; evidence: string }[];
  inspectionDigest: string;
};
type ImportReceipt = {
  id: string;
  commandId: string;
  bundleSha256: string;
  originRefs: OriginRef[];
  localCandidates: {candidateId: string; slotId: string; source: OriginRef}[];
  localManifestBlobId: string;
  fileMap: {sourceSha256: string; rawBlobId: string; canonicalBlobId: string;
            normalizerVersion: string; normalizationChanged: boolean}[];
  intentDigest: string;
  actor: string;
  reason: string;
};
```

`compatible`은 해당 용도에 대한 검사 결과이며 독립 감상이나 채택이 아니다. `needs_decision`은 실제 미정인 대응, `needs_derivation`은 원본 자료를 그 용도에 직접 쓸 수 없는 상태다. `unsupported`는 능력 부족, `blocked`는 잘못된 hash·필수 참조 누락 등의 계약 실패다. 사용자 설명은 작품·대화 언어에 맞춘다.

첫 구현의 `selections`는 길이 1이다. 대상은 이미 존재하거나 기존 규약으로 생성 가능한 하나의 slot이다. 후보 ID는 서버가 발급하고 receipt의 실제 ID를 이후 호출자가 사용한다. asset 명령의 target/aggregate는 `{kind:'assetSlot',id:slot.id}`이며 purpose/role은 slot의 mediaKind·subject·scope와 맞아야 한다. castingStateRef/utteranceId는 기존 규약대로 audio에서만 허용한다. 묶음에 여러 roots가 있더라도 한 command가 반입하는 것은 선택 root 하나와 그 필수 의존성이다. 다중 slot에 걸친 일괄 채택은 첫 범위에 넣지 않는다.

目的地 검사에서 원본 role을 실행 지시로 신뢰하지 않는다. 정확한 대사·화자·언어가 다른 take는 `speech-take`로 compatible이 될 수 없고 `audio-reference` 등 다른 용도의 새 검사나 새 제작을 선택한다. 필요 stateMap/identityMap이 없으면 이름으로 채우지 않는다. 현재 대상에 새 인물이 필요하면 기존 cast/story 명령으로 먼저 만들어 그 판본으로 검사한다.

inspectionDigest는 승인 비밀값이 아니다. 최종 반입은 서버가 bundle·intent·현재 pins와 검사 결과를 재계산한다. 새 digest를 클라이언트가 써 주었다는 이유로 필수 검증을 생략하지 않는다. 반입 후 채택도 기존 `candidate.review`/`candidate.adopt` 및 current pins 규약을 따른다. advisory가 있다는 이유만으로 새 필수 gate를 만들지 않는다.

원문 text는 위 asset 명령에 PNG처럼 넣지 않고 기존 `source.manuscript/source.import`의 provenance 확장으로 연결한다. 첫 `asset.importBundle`의 소비 대상은 기존 image/audio다. video/structured는 검색·보존 형식과 실제 소비 지원을 나눠 unsupported를 반환한다. 배경음 파일을 저장할 수 있어도 독립 BGM 트랙이 구현됐다고 보고하지 않는다.

첫 목적지 writer는 Studio다. vibelore는 먼저 정본·세계·웹툰의 원천/검색 Adapter로 연결한다. vibelore 쪽 사용·기준 채택은 기존 `lore_webtoon_scene`의 참조 선택이나 `lore_assets` 검토·채택을 계속 사용한다. Library가 원천 정본에 쓰는 새 writer는 초기 범위 밖이며, 추후 연결하더라도 해당 승인·영수증 경로 안에서만 구현한다.

원문 S1과 이미지 A/W1을 함께 가져오는 화면은 **여러 독립 command의 진행**이다. 먼저 sourcePackage를 반입하고 필요한 목적지 인물/상태를 준비한 뒤 각 asset을 반입한다. 각 성공 receipt는 유지되고 실패한 항목만 남는다. 원문만 성공했다면 ‘원문 보존 완료, 이미지 미완료’로 표시하며 전체 준비/채택 완료라고 하지 않는다. 재개는 각 항목의 고정 commandId와 receipt를 사용한다. 한 항목 실패를 이유로 이미 채택했거나 손으로 편집한 다른 항목을 자동 rollback하지 않는다.

### raw와 실행 bytes의 기준

선택 root의 실제 실행 자료는 manifest가 지정한 `selected-content` 파일 hash다. 원천이 raw와 canonical을 모두 제공하면 둘을 별도 역할로 보존한다. 목적지 `rawBlobId`는 selected-content bytes를 그대로 보존한 hash이며 원천 파일과 byte-identical해야 한다. 이전 원본 raw는 별도 보존 파일로 남는다.

소비 후보는 **목적지의 버전 고정 decoder가 만든 canonical bytes**를 사용한다. inspect가 read-only decode로 예측한 canonical hash·메타데이터·normalizerVersion을 inspectionDigest에 포함하고 최종 import도 이를 재검증한다. selected-content와 canonical hash가 같으면 직접 반입, 다르면 무손실이라고 추정하지 않고 `normalized-from` 기술 파생을 기록한다. 원천 revision을 바꾸지 않으며 normalizationChanged를 사용자/후속 소비자에게 보여준다. 이는 새 모델 생성으로 기록하지 않는다.

음원 길이·표본·이미지의 실제 소비 특성이 달라지면 새 canonical 메타데이터로 타이밍/적합성을 검사한다. 원천 take의 이전 시간·동작 증거가 새 canonical까지 검증했다고 승계하지 않는다. 목적지의 고정 Edition은 이 canonical과 decoder/renderer 판본을 소비하고, 재수출은 새 로컬 Ref와 원천/정규화 계보를 포함한다. decoder를 바꿔 새 자료를 만들 때도 기존 Edition과 보존된 raw/canonical은 유지한다.

## 확정 순서와 재개

1. command replay 확인 → 지원 형식·manifest/범위/한도 검증 → 검사 시점의 목적지 pins 확인.
2. 기존 staging lease 안에서 필수 bytes를 읽고 raw hash·길이·decode 확인, canonical bytes와 원천 manifest를 목적지 blob으로 보존.
3. 최종 단일 목적지 transaction에서 같은 command의 replay·expectedRevision·inspection/intent·현재 pins·필수 참조를 다시 검사.
4. 선택 root 하나의 새 후보·slot 결과·필수 자료·출처 receipt와 command/event를 함께 확정. 이 root의 반입은 전부 확정하거나 후보를 하나도 만들지 않음. 다른 root/source command까지의 전역 원자성은 아님.
5. 정상 반입 뒤 기존 사용 결정·필요한 파생·job으로 진행. Library 갱신은 후속 관측이며 반입 성공과 같은 transaction이 아님.

handler는 다른 command를 중첩 호출하지 않는다. 이미 있는 prepare/decode/slot 검증 함수를 공유한다. 레코드 준비가 CAS 전에 끝났더라도 최종 transaction이 실패하면 수용된 후보나 채택은 없다. 고아 staging bytes는 기존 lease/복구 규약으로 회수한다. 실패한 작업을 새 생성으로 대신하지 않는다.

같은 command ID·같은 요청은 같은 receipt다. 다른 요청은 `COMMAND_CONFLICT`다. 새 command에서도 정확한 중복을 찾는 키는 projectId·bundleSha256·선택 root·대상 slot ID·현재 의미 pins·purpose/대응·normalizerVersion의 digest다. server 후보 ID·commandId·actor/reason·slot의 단순 관측 revision은 그 키에 넣지 않는다. 최종 CAS의 expectedRevision 검사는 키와 별도로 항상 한다.

중복 키가 같고 후보 bytes/메타데이터·현재 용도·최신 review가 유효하면 그 후보 ID를 실제 receipt에 반환한다. 후보 ID를 요청자가 제안할 수 없으므로 ID 예약 충돌은 없다. 반려/손상/미호환 후보는 정상 중복으로 반환하지 않고 실제 문제를 보고한다. 별도 후보가 필요하면 명시적 new-import intent를 검사해 만든다. 같은 bytes를 다른 slot/사용처에 연결하면 새 intent/검사/채택이며 전역 job cache hit로 취급하지 않는다. 다른 출처는 bytes만 중복 제거하고 출처를 각각 유지한다.

외부 hash/Ref는 외부 provenance다. local `parentCandidateIds`에는 목적지에 실제 존재하는 local 후보만 둔다. 출처 manifest 자체는 `localManifestBlobId`로 연결하고 Edition/backup/GC가 반드시 참조한다. 외부 hash를 local `blobId` 필드에 넣어 기존 collector가 목적지 파일로 오해하게 하지 않는다.

## 상태·실패·갱신

| 상황 | 규칙 |
|---|---|
| 검색 결과 뒤 원천 변경 | exact Ref를 export. 선택된 판본이 없으면 실패. 새 HEAD로 몰래 대체하지 않음 |
| 원천 offline, 묶음 있음 | 묶음으로 inspect/import 가능. 현재 원천의 최신 상태는 unknown |
| 목록 장애/삭제 | exact Ref 또는 보존 묶음 경로 유지. 원본·목적지 영수증·파일은 삭제하지 않음 |
| 원천 재연결·새 판본 | 새 관측/선택. 기존 Ref·과거 출력판·기존 채택은 유지 |
| 목적지 반입 확정 후 응답 유실 | 같은 command replay. source 재전송/유료 생성 불필요 |
| 부분 bytes 수령/손상 | `BUNDLE_INCOMPLETE`/`BUNDLE_HASH_MISMATCH`, 수용된 후보 없음 |
| 필수 상태/인물 대응 미정 | `REUSE_MAPPING_REQUIRED`, 질문이 필요한 실제 선택만 표시 |
| destination 변경 | 기존 `REVISION_CONFLICT`/`INPUT_STALE`. 현재판본으로 inspect 다시 수행 |
| 미지원 묶음/자료/상한 | `BUNDLE_SCHEMA_UNSUPPORTED`/`REUSE_MEDIA_UNSUPPORTED`/`BUNDLE_LIMIT_EXCEEDED` |
| 외부 동작 결과 불명 | 기존 job/attempt의 `outcome_unknown` 유지. Library/Bundle이 retry하지 않음 |

registry 변경에는 registry CAS, 투영 교체에는 registration generation과 owner token을 쓴다. 등록 해제 후 도착한 새로고침 결과는 폐기한다. owner snapshot 교체는 해당 owner 투영만 transaction으로 바꾸고 다른 owner의 성공 데이터를 지우지 않는다. 오래된 owner 상태는 관측 시각을 남겨 표시한다.

제안 DB 버전은 목적지 Studio `user_version=2`, Library 자체 schema 1이다. Studio 1→2 migration은 원천/후보/채택/Edition을 보존하고 새 반입 receipt·작업/사례 연결을 추가한다. 기존 코드가 1 초과를 거부하는 성질을 유지해 구버전 실행기가 새 참조를 무시한 채 GC하게 두지 않는다. 업그레이드는 목적지 Studio를 명시적으로 열 때만 수행하고 backup/rollback·재실행 시험을 고정한다. 원천 read-only 등록은 schema 1/2를 읽을 수 있어도 migration을 호출하지 않는다. schema 2 이후 구조는 소유 Adapter가 명시적으로 지원해야 한다.

## 사례와 작업 기록

`ProductionCase`는 `{id, question, contextRefs, literalInputRefs, trials, observations, decision?, unknowns}`로 제안한다. trials는 실제/fixture/계획과 결과 상태를 구분한다. observations는 대상 Ref/hash·관측 범위·관점·실제 평가자 관계를 가진다. 비교군 없는 채택 사례와 같은 과제·예산·조건의 비교 사례는 별개다. unsupported/미관찰은 합격 점수로 채우지 않는다.

`CycleRecord`는 `{id, purpose, previousCycleRefs, inputUses, producedRefs, decisionRefs, outputRefs, executionRefs}`다. 각 참조는 소유자가 발급한 실제 기록을 가리킨다. 새 단계 state machine이나 만능 workflow runner를 만들지 않는다. 계획 중인 출력은 producedRefs가 아니라 별도 planning metadata다.

원문/실제 prompt/근거는 허용 범위만 명시적으로 전달한다. 검색 문자열·사례의 과거 prompt·metadata가 등록/실행/공개 권한을 부여하지 않는다. 새 조건에 맞는 실제 입력으로 선택한 경우에만 사용한다.

## 제안 파일 책임 지도와 검사

아래 경로는 **별도 Studio 구현을 기준으로 새로 만들거나 고칠 후보**다. 현재 checkout에 이미 존재한다는 뜻이 아니다. 실제 작업 파일·함수·테스트는 후속 writing-plans에서 확정한다.

| 위치 | 책임 |
|---|---|
| `studio/src/library/{index,registry,projection,query}.js` | 등록 설정·read facade, owner별 색인 갱신, 검색/계보/사용처 projection |
| `studio/src/source/{export-vibelore-assets,export-studio-assets}.js` | 읽기 전용 Owner Adapter와 허용 범위·native Ref 변환 |
| `studio/src/reuse/{bundle,inspect,import}.js` | 닫힌 manifest·한도/hash 검사, 목적지 대응 검사, 반입 준비/출처 receipt |
| 기존 `studio/src/assets/commands.js`, `engine/asset-slots.js` | import helper 공유, 목적지 새 명령·local pins 유지 |
| 기존 `studio/src/engine/{index,project-store,history}.js` | 새 명령 등록·schema migration·cycle/사례 기록 연결 |
| 기존 `studio/src/render/closure.js`, `engine/{backup,recovery}.js` | 원천 receipt/필수 blob의 Edition·GC·backup 참조 보존 |
| 기존 HTTP/MCP/UI | 동일 명령 Interface, import 크기 적용, 관련 자료·범위·충돌 표시 |
| `studio/test/{reuse,library,asset-cycle}.test.js` | 아래 대표 실패와 세 사이클 수용 테스트 |

핵심 검사군: 같은 hash/다른 인물·owner 충돌; exact old revision; 불완전/손상·경로/한도 초과 묶음; source offline 전후; 목적지 동시 편집; 반입 commit 후 응답 유실; 다른 source/같은 bytes의 계보 유지; 잘못된 대사/상태·style-only role; 등록 해제 후 늦은 투영; 목록 재구성; receipt 포함 GC/backup/restore; 구버전/migration; 두 프로젝트와 독립 원고를 포함한 세 사이클. 실제 생성·감상과 계약 fixture 검사는 별도로 보고한다.
