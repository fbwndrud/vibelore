# Studio를 실제 제작 도구로 만드는 계약

작성: 2026-10-08. 소설·세계·인물에서 여러 매체를 만드는 별도 Studio의 생산 설계 제안이다. 구현·API 호출·청취·렌더 성능 시험을 완료했다는 보고가 아니다. 기존 [기초 아키텍처](novel-to-media-production-architecture-2026-10-08.md), [Google API 조사](google-media-production-api-review-2026-10-08.md), `src/store/asset-catalog-store.js`의 불변 에셋·승인·복구 구현을 읽고 정리했다. 소설 정본과 `.vibelore/`는 수정하지 않았다.

## 1. 결정: Studio가 제작 상태를 소유하고 MCP는 같은 명령을 호출한다

Studio는 웹툰 도구에 파라미터를 더하는 화면이 아니다. 작품에서 필요한 자료를 가져와, 각색·배역·에셋·타임라인·최종 산출물을 소유하는 별도 로컬 프로젝트다. vibelore는 정본과 승인된 공유 설정의 원천이다. MCP는 Studio의 제작 명령을 채팅에서 호출하는 또 하나의 진입점이다. UI와 MCP가 서로 다른 workflow나 승인을 만들지 않는다.

첫 배치는 하나의 로컬 coordinator, 프로젝트별 저장소, 재시작 가능한 worker, Studio UI다. 로컬에서는 owner 한 명이어도 충분하다. 팀용 인증·원격 저장소·클라우드 worker는 실제 요구 이후에 붙이며 처음부터 배포 인프라 전체를 만들지 않는다. 원천 연결은 vibelore Adapter 외에 봉인된 장면 대본·외부 대본 import도 고려한다. 소설에서 출발한 프로젝트는 원작 provenance를 유지하고, 원작 없는 새 제작은 독립 대본이라는 출처를 명시한다.

서버의 작은 Interface:

```ts
type StudioCommand =
  | { kind: 'revise'; scopeId: string; patch: DomainPatch }
  | { kind: 'produce'; target: TargetRef; policyRevisionId: string }
  | { kind: 'select'; slotId: string; candidateId: string }
  | { kind: 'approve'; subject: RevisionRef; evidenceIds: string[] }
  | { kind: 'cancel'; jobId: string }
  | { kind: 'export'; timelineRevisionId: string; outputProfileId: string };

execute({ projectId, commandId, expectedHeads, command, principal });
subscribe({ projectId, afterSequence });
```

`DomainPatch`는 임의 JSON/path 쓰기가 아니라 대사·배역·샷·마스크·타이밍의 검증된 변경이다. expectedHeads, 변경 영향, 예산, 권한, 후보 채택, 검사 영수증을 Production Module 안에서 함께 처리한다. UI의 버튼과 MCP의 자연어 요청이 같은 Interface를 통과한다. 공급자·저장·렌더 Adapter는 내부 Seam에 둔다.

## 2. 기존 제안에서 먼저 메워야 하는 빈 곳

| 빈 곳 | 실제 실패 | 이번 결정 |
|---|---|---|
| 두 인물 예시에 기대는 배역·화면 | 8인 대화, 40인 작품, 군중과 회상에서 화자가 섞임 | 작품 인물·배역·장면 등장·현재 음성 표현을 분리 |
| durable queue 설명만 있음 | 전송 직후 중단하면 재시도 때 두 번 과금 가능 | dispatch intent와 `outcome_unknown`, reconcile 계약 |
| 승인 대상이 느슨함 | 다른 대본·음성으로 바뀌어도 과거 승인 표시 | 정확한 산출물·의존 closure에 묶인 승인 |
| 이미지 편집이 외부 과정 | 생성·수정·채택·샷 적용이 끊어짐 | 비파괴 에셋 Editor, 마스크·후보·영향·적용 범위 |
| local-first와 협업의 의미 불명확 | 두 탭이 같은 샷을 덮고 이벤트 유실 | aggregate CAS·원자적 command/event·재개 cursor |
| 공통 preview/export를 재현성으로 확대 | 글꼴·외부 URL·codec·실수 시간값이 달라짐 | 입력 고정·고정 시간base·대표 프레임·실음원 검증 |

## 3. 인물 40명, 장면 8명도 같은 계약으로 표현한다

작품 인물은 정체성이고, 화면에 등장하는 인물은 장면 당시 상태의 occurrence다. 배역은 어떤 표현으로 들리는지다. 같은 인물이 어린 시절·성인·변장·내면 음성에서 여러 표현을 가질 수 있고, 하나의 성우/합성 voice를 여러 배역이 공유할 수도 있다. voice ID가 같다는 이유로 인물 ID를 합치지 않는다.

```ts
type CastRole = {
  roleId: string;
  entityId?: string;              // 내레이터·군중 역할에는 없을 수 있음
  roleKind: 'character' | 'narrator' | 'inner-voice' | 'crowd';
  label: string;
};

type VoiceRevision = {
  revisionId: string;
  roleId: string;
  language: string;
  portrayalStateIds: string[];    // 예: 성인·병중. 이번 대사의 감정과 다름
  providerBinding: {
    apiSurface: string; modelId: string; voiceId: string;
    expiresAt?: string; capabilityRevisionId: string;
  };
  approvedAuditionBlobIds: string[];
  pronunciationRevisionId: string;
};

type Occurrence = {
  occurrenceId: string;
  sceneId: string;
  roleId: string;
  entityStateRevisionIds: string[];
  storyTimeRef: string;           // 영상 재생 시간이 아니라 사건 당시
  visibility: 'visible' | 'offscreen' | 'heard-only';
  knowledgeScopeRef: string;
  visualPortrayalRevisionId?: string;
  voiceRevisionId?: string;
};

type Utterance = {
  utteranceId: string;
  speakerOccurrenceId: string;   // 정확히 한 발화 주체
  addressedToOccurrenceIds: string[];
  respondsToBeatIds: string[];
  textDisplay: string;
  textSpoken: string;
  performanceRevisionId: string;
  sourceRefs: SourceRef[];
};
```

8인 장면은 8인의 단일 화자 take와 명시한 overlaps로 조립할 수 있다. 하나의 provider multi-speaker 요청이 8명을 지원한다고 주장하지 않는다. 이전 공식 조사에서 확인한 Developer TTS의 단일 prebuilt 대화 요청은 두 화자 계약이다. [TTS 공식 문서](https://ai.google.dev/gemini-api/docs/speech-generation)

40명 작품에서는 active scene의 인물만 생성 문맥에 넣는다. 시각 요청에는 현재 샷에 필요한 참조와 그 상태만 넣고 공급자 참조 한도를 넘으면 coverage shots·그룹 이미지·로컬 합성·수동 제작 중 하나를 선택한다. 8인 와이드샷 하나에서 완전한 얼굴 일관성을 확보했다는 약속을 하지 않는다. [이미지 계약](https://ai.google.dev/gemini-api/docs/image-generation)

Casting Room은 등장인물 전체를 카드·표·검색으로 관리한다. 역할별 채택 음성, 나이/상태, 언어, 발음, 대표 샘플, 현재 쓰는 장면 수, 유사 목소리 경고를 표시한다. Scene 화면은 활성 인물 track을 펼치고 다른 배역을 접는다. 군중 ad-lib은 무관한 말소리와 서사적 문장으로 구분한다. 후자는 정확한 배역·대본으로 관리한다.

voice 만료나 모델 종료는 기존 음원 재생을 깨뜨리지 않는다. 채택 WAV는 자체 저장소에 남긴다. 새 합성에는 대체 VoiceRevision과 새 audition이 필요하며 이전 장면을 조용히 다시 합성하지 않는다. 40명 모두 서로 다른 고유 음색이라는 품질은 catalog 수나 ID로 보장할 수 없으므로 실제 cast 비교에서 검증한다. provider voice 수명은 자체 인물 정체성 수명과 다르다. [Voice design](https://ai.google.dev/gemini-api/docs/voice-design)

## 4. 비파괴 이미지 Editor: 수정도 새 제작이다

Scene에서 샷을 선택하고 **에셋 수정**을 열면 원본·레이어·마스크·참조·지시·후보를 연결한다. 편집 도구는 붓/지우개 마스크, 보호 영역, crop/reframe, 배경 분리 후보, 표정/의상 수정, 배경 clean plate, 직접 import, 외부 편집본 반입이다. 캔버스에서 보여주는 기능과 공급자가 실제 보장하는 기능은 구별한다.

```ts
type AssetRevision = {
  assetId: string; revisionId: string; parentRevisionIds: string[];
  blobIds: string[];
  kind: 'image' | 'audio' | 'mask' | 'layer-package' | 'video';
  provenance:
    | { kind: 'import'; suppliedName: string; declaredSource?: string }
    | { kind: 'generated'; generationAttemptId: string; inputClosureHash: string }
    | { kind: 'edit'; editRecipeId: string; baseRevisionId: string }
    | { kind: 'composite'; recipeId: string; sourceRevisionIds: string[] };
};

type EditRecipe = {
  recipeId: string;
  baseRevisionId: string;
  operation: 'masked-edit' | 'reframe' | 'remove-background' | 'clean-plate';
  maskBlobId?: string;
  protectBlobId?: string;
  coordinateSpace: { width: number; height: number; orientationApplied: true };
  instruction: string;
  referenceRevisionIds: string[];
  capabilityRevisionId: string;
  enforcement: 'provider-native' | 'local-composite' | 'advisory-only';
};
```

UI 마스크는 우선 편집 의도와 공간적 선택을 기록한다. 실제 endpoint의 native mask가 확인됐을 때만 `provider-native`를 쓴다. native mask가 없으면 모델에 참조·영역 의도를 전달해 후보를 받고, 로컬에서 승인 마스크를 적용해 합성할 수 있다. 이 경우 화면에는 **생성 후 로컬 합성**이라고 표시한다. 무마스크 모델이 마스크 안만 바꾼다는 약속을 하지 않는다.

`candidate/selected/approved/retired`는 revision 객체를 덮어쓰는 필드가 아니라 선택·승인·퇴역 event에서 만든 projection이다. 하나의 이미지 개정이 어떤 샷에서는 선택되고 다른 샷에서는 후보일 수 있으므로 상태에는 scope도 필요하다.

`local-composite`는 마스크 밖 원본 픽셀을 보존하는 코드 계약을 가질 수 있다. 이 계약은 마스크 경계의 자연스러움, 그림자와 조명, 새로운 내용의 원작 적합성을 보장하지 않는다. 알파·마스크를 확대/회전한 좌표 대응, EXIF orientation, premultiplied alpha, 색공간을 확인하고 경계 이음새를 프리뷰로 본다. 보호 영역을 지시문에만 적은 `advisory-only`는 픽셀 보존 보증으로 표시하지 않는다.

배경 제거에서 결과 PNG에 alpha 채널이 있다는 사실과 제대로 분리됐다는 판단도 다르다. 바둑판·밝은 배경·어두운 배경 위에서 머리카락, 반투명 효과, 가장자리 contamination을 확인한다. 마스크 없는 composite 이미지에서 인물 layer가 원래 존재한 것처럼 표시하지 않는다. 분리·빈 배경 복원은 새 에셋 생성이며 원본을 유지한다.

생성본과 import를 같은 provenance로 뭉개지 않는다. 외부에서 만든 이미지는 provider·prompt·mask를 알 수 없을 수 있고 이를 unknown으로 둔다. 외부 편집본은 base hash를 연결할 수 있어도 실제 편집 연산이 검증됐다고 쓰지 않는다. 사용자가 알려준 출처·사용 조건은 선언으로 기록하고 모델이 권리 상태를 추정해 채우지 않는다.

**후보 만들기 → 원본/후보 비교 → 선택 → 적용 범위 선택** 순서다. 선택과 적용은 별개다. “현재 샷”, “이 상태를 쓰는 샷”, “제작물 전체”의 영향 목록을 보여주고 command로 적용한다. 같은 assetId가 전 작품에서 최신 개정으로 바뀌지 않는다. 이미 승인된 샷은 특정 asset revision을 참조하므로 과거 산출물이 보존된다. Undo는 원본 파일 덮어쓰기가 아니라 선택/참조를 되돌리는 새 command다.

## 5. capability는 메뉴와 실행을 함께 제어한다

프로젝트는 공급자 이름보다 정확한 capability revision을 고정한다.

```ts
type CapabilityRevision = {
  revisionId: string; checkedAt: string;
  apiSurface: string; modelId: string;
  operations: {
    imageGenerate: boolean;
    referenceEdit: boolean;
    nativeMask: 'verified' | 'unsupported' | 'unknown';
    transparentOutput: 'verified' | 'unsupported' | 'unknown';
    multiSpeakerMax?: number;
    wordTimecodes: 'verified' | 'unsupported' | 'unknown';
    reconcileOperation: boolean;
    idempotency: 'documented' | 'none' | 'unknown';
  };
  limits: Record<string, number | string>;
  evidenceRefs: string[];
};
```

확인 출처는 문서와 실제 계정 probe를 구별한다. 문서상 기능 존재, 계정 가용성, 품질 시험 통과는 다른 필드다. 기능 미확인 시 적절한 편집 선택지는 import나 로컬 합성으로 남길 수 있다. 숨겨진 자동 provider 전환·모델 강등은 하지 않는다. 변경하려면 정책 개정·예산·새 후보 검토가 필요하다.

## 6. 생성 DAG와 승인 DAG를 분리한다

같은 입력으로 후보가 여러 개 나올 수 있다. 생성된 것, 선택한 것, 승인된 것은 서로 다른 상태다. 두 take 중 하나를 선택했다고 다른 후보 bytes를 삭제하지 않는다. 폐기 후보는 프로젝트 보관 정책에 따라 추후 정리한다.

```text
SourceBundle → AdaptationRevision → PerformanceRevision ─┐
Cast/VoiceRevision → utterance generation → take candidates ├→ 선택 closure
VisualRecipe → image generation/edit → visual candidates ──┘
선택 closure + timing constraints → TimelineRevision
TimelineRevision + render profile → Preview/Export artifacts
actual artifacts + check receipts + review evidence → Approval
```

`generationKey`에는 입력·참조 bytes hash, endpoint/model/capability revision, parameter, prompt/대본, 배역·발음·문맥 revision, 새 후보 nonce를 넣는다. job dedupe와 결과 선택을 구별한다. 새 nonce로 생성 요청을 한 경우 비용 발생 가능성을 분명히 표시한다.

`Approval`은 label에 붙는 영구 badge가 아니다.

```ts
type Approval = {
  approvalId: string;
  subjectRevisionId: string;
  inputClosureHash: string;
  artifactBlobIds: string[];
  checkReceiptIds: string[];
  reviewEvidenceIds: string[];
  scope: 'cast' | 'asset' | 'scene' | 'export';
  principalId: string;
  decidedAt: string;
};
```

대사·take·asset·timeline이 바뀌면 영향 closure의 승인을 새 revision에 승계하지 않는다. 변경하지 않은 다른 장면의 승인까지 일괄 무효화하지 않는다. 원작 최신 HEAD 변경은 pinned SourceBundle을 소급 수정하지 않는다. 이전 판은 역사적 판본으로 재생할 수 있고, 새 원작 채택에는 source map 영향 검토가 필요하다. vibelore working-tree drift가 있으면 원천 Adapter는 sync/validate 전 새 pin이나 집필을 진행하지 않는다.

느리게 도착한 응답의 `inputClosureHash`가 현재 슬롯과 다르면 `stale_candidate`로 보존한다. 자동 선택·새 timeline 편입·승인 재사용은 거부한다. 작가가 일부 결과를 재사용하려면 현재 closure에 새 binding을 만드는 명시적 command를 사용한다.

## 7. durable job: 로컬 중복 완료를 막아도 공급자 중복 과금은 남는다

job은 실행 단위이고 attempt는 외부 호출 단위다. local transaction은 provider 실행과 하나의 원자적 transaction이 될 수 없다. 처음부터 이 간격을 데이터에 표현해야 한다.

```ts
type AttemptState =
  | 'prepared' | 'dispatching' | 'accepted' | 'waiting'
  | 'outcome_unknown' | 'received' | 'verified'
  | 'failed_definite' | 'cancel_requested' | 'cancelled_confirmed';

type Attempt = {
  attemptId: string; jobId: string; inputClosureHash: string;
  generationKey: string;
  state: AttemptState;
  workerFence: number;
  dispatchStartedAt?: string;
  providerRequestId?: string;
  providerOperationId?: string;
  outboundManifestId: string;
  budgetReservationId: string;
  usage: 'unknown' | { measured: number; unit: string; source: string };
  cost: { status: 'reserved' | 'estimated' | 'reported' | 'reconciled'; value?: number };
  responseBlobIds: string[];
};
```

실행 순서:

1. coordinator가 입력 closure, outbound permission, budget을 검증한다. transaction 안에서 attempt·reservation·dispatch intent를 기록한다.
2. worker가 lease와 fence를 받은 뒤 외부 전송한다. 장기 provider operation ID가 있으면 즉시 durable 기록한다.
3. 결과는 임시 파일에 받고 크기·decode·해시를 확인한다. content-addressed blob을 fsync/rename한 뒤 artifact row와 event를 transaction으로 commit한다. DB와 filesystem을 단일 원자적 저장이라고 주장하지 않는다. 고아 blob은 다음 복구 때 찾아 보존 정책으로 정리한다.
4. workerFence·입력 hash·slot head를 검사한 뒤 후보를 등록한다. stale worker는 완료를 publish할 수 없다.
5. receipt는 실제 blobs가 존재하고 무결성 검사를 통과한 뒤 발급한다. incomplete temp file은 결과가 아니다.

```text
prepared → dispatching → accepted/waiting → received → verified
                 └→ outcome_unknown → reconcile → received 또는 failed_definite
                 └→ failed_definite → budget/정책 내 새 attempt
cancel_requested → queued 중단 또는 provider 취소 요청
```

전송 직후 process crash 또는 timeout이면 `outcome_unknown`이다. 실행 여부를 알 수 없는데 자동 retry하지 않는다. provider가 operation 조회를 지원하면 reconcile한다. 지원하지 않으면 “처리·청구 확인 불가”를 표시하고 재호출은 새 attempt와 추가 비용 위험을 승인된 재시도 정책에 따라 결정한다. 자동 정책에 허용되지 않은 불확실 재시도는 대기한다. 존재가 확인되지 않은 idempotency key를 provider에 전달했다는 이유로 exactly-once 과금이라고 쓰지 않는다.

lease 만료는 작업을 다시 claim할 수 있는 조건일 뿐, 이미 dispatch한 요청을 안전하게 재전송할 수 있다는 조건이 아니다. 새 worker는 먼저 attempt를 reconcile한다. fencing은 로컬 publish 충돌을 막으며 이미 나간 provider 호출을 취소하지 못한다.

취소는 즉시 UI를 멈추고 아직 보내지 않은 descendant job을 중단한다. 이미 실행한 요청은 provider 취소 기능을 시도하고, 확인 안 됐으면 `cancel_requested` 상태를 유지한다. 늦은 결과는 보관될 수 있지만 자동 채택하지 않는다. “취소됨”과 “추가 비용 없음”을 같은 문구로 표시하지 않는다.

예산은 actual/estimated/reserved/unknown exposure를 나누어 표시한다. outcome_unknown의 예약을 timeout만으로 돌려주지 않는다. 문서상 엄격한 비용 상한을 산출할 수 없는 작업은 추정 cap과 request cap으로 설명한다. provider 청구보다 먼저 보장된 달러 hard cap을 약속하지 않는다. 계정 측 quota·spend control의 효과도 실제 설정과 계약을 확인한 경우만 표시한다. 이미지·TTS·전사·렌더의 concurrency와 retry cap을 각각 둔다.

## 8. 두 탭과 MCP가 동시에 편집해도 기록이 일치해야 한다

로컬 project database에는 immutable revision, mutable aggregate heads, commands, events, jobs, receipts를 둔다. SQLite는 첫 단일 coordinator의 후보이며 네트워크 파일공유 위에 DB를 놓는 설계는 피한다. 거대한 event-sourcing 프레임워크가 먼저 필요하지는 않다. 명령 결과와 UI event를 같은 transaction에 넣는 것이 핵심이다.

```ts
type CommandEnvelope = {
  commandId: string;
  payloadDigest: string;
  expectedHeads: Record<string, string | null>;
  principalId: string;
  command: StudioCommand;
};

type ProjectEvent = {
  sequence: number;
  eventId: string;
  commandId: string;
  aggregateId: string;
  previousRevisionId: string | null;
  revisionId: string;
  kind: string;
};
```

같은 commandId·같은 digest를 재전송하면 저장된 결과를 반환한다. 같은 ID·다른 payload는 오류다. 같은 샷을 두 탭에서 편집하면 두 번째 expectedHead가 충돌하며 diff와 rebase 선택을 보여준다. 다른 장면은 별도 aggregate head로 독립 진행할 수 있다. 전 작품 final export는 모든 선택 closure를 고정하므로 export 직전 결합 검증이 필요하다.

이벤트는 at-least-once 전달을 허용하며 sequence/eventId로 dedupe한다. reconnect는 `afterSequence` 이후 이벤트를 받고, compaction 범위 이전이면 최신 snapshot+그 이후 cursor를 반환한다. 이벤트 전달은 UI 갱신 수단이지 파일 저장 완료의 유일한 증거가 아니다. 사용자가 닫은 Studio를 다시 열면 coordinator의 durable 상태에서 재구성한다. realtime presence와 공동 커서, 문자 단위 CRDT는 실제 협업 필요 뒤에 도입한다.

## 9. 프로젝트 저장·권한·밖으로 나가는 자료

첫 local-first 프로젝트는 다음으로 나눈다.

```text
project manifest + 사람이 읽을 각색/배역 문서
project database: revision/head/command/event/job/receipt
content-addressed blobs: 입력 원문·이미지·음원·마스크·font·산출물
cache/temp: 재생성 가능한 proxy·render 중간물
credential reference: OS credential store의 식별자만
```

Studio 저장소는 소설 정본 또는 `.vibelore/` 내부 파일을 직접 편집하는 우회 경로가 아니다. vibelore Adapter의 승인된 export/import Interface를 사용한다. Studio의 시각·음성 선택은 매체 제작 판본이며 세계·인물 정본으로 자동 역수입하지 않는다.

로컬 owner에게 edit/produce/approve/export 권한이 있다. 팀 배포 시 viewer는 열람, editor는 대본·샷 수정, producer는 generation·budget 사용, approver는 채택/납품판 승인, owner는 원천 연결·outbound policy·credential을 관리한다. role은 서버 command에서 검사하고 UI 숨김으로만 구현하지 않는다. 로컬에서 owner가 여러 역할을 겸해도 된다. 사용자가 위임한 auto 정책은 반복 승인을 요구하는 체크리스트로 바꾸지 않는다.

`OutboundManifest`는 전송 대상 provider/endpoint·필요 원문 구간·배역 설정·참조 blob·검토 범위를 기록한다. 작품 전체 원문과 비공개 미래 설정을 모든 요청에 넣지 않는다. 프로젝트 정책의 허용 provider·data scope·budget 안이면 반복 승인 없이 실행한다. 새로운 외부 공급자·scope 확대는 실행 전 구체적 영향과 바뀔 자료를 보여준다.

API key는 UI bundle, project.json, event, prompt, trace, export에 저장하지 않는다. worker가 credential reference로 읽고 서버 로그는 비밀과 민감한 전체 요청 body를 기본 숨긴다. 임포트 파일은 project 경로 escape/symlink·크기·decode를 검사한다. media/HTML/문서 메타데이터의 자연어를 지시로 실행하지 않는다. 렌더러는 승인 blob 접근만 허용하고 임의 원격 URL·스크립트 로딩을 막는다. loopback coordinator도 허용 origin과 session token을 검증하며 임의 사이트에서 유료 command를 보낼 수 없게 한다.

클라우드는 다음 셋을 별개 옵션으로 제공한다: 백업/sync, 원격 worker, 협업 project store. sync를 켰다고 원문을 공급자에 보낸다고 해석하지 않는다. cloud worker는 고정된 job closure의 blobs만 받아 결과를 동일한 후보 계약으로 돌려준다. 중앙 project store로 전환하면 writer/coordinator의 소유권과 auth가 달라지므로 SQLite 파일 복사로 live 협업을 흉내 내지 않는다.

프로젝트 export는 db와 referenced blobs의 일관된 closure를 포함하며 secrets·provider 임시 URL을 제외한다. 큰 에셋 GC는 pinned source, selected/approved revision, active job, export가 참조하는 blobs를 보존한다. 실패 후보의 retention과 정리는 사용자 설정을 따르고 Undo에 필요한 파일을 즉시 지우지 않는다.

## 10. 재생과 렌더: 모델 시간 추정 대신 실제 sample과 frame

타임라인은 실제 음원 duration으로 compile한다. wave의 sample 수/sample rate와 영상 fps rational을 유지하고 임의 소수 milliseconds 누적을 피한다. 예를 들어 48,000Hz 오디오와 30fps 프로젝트라면 각 frame은 1,600 samples에 대응하지만, 다른 fps에는 rational 변환과 명시적 rounding 정책이 필요하다. 모든 fps에서 정수 sample/frame 대응이 있다고 가정하지 않는다.

`TimelineRevision`에는 audio trim, placement, gain, fades, overlaps, shot keyframes, subtitle cue, reveal anchors, output aspect/safe area와 선택한 blob IDs를 넣는다. relation/camera 의도 변경은 모델 후보 없이 코드 재compile할 수 있다. 음성 길이 수정은 하위 anchor로 전파하되 이미 확정된 다음 장면 경계와 충돌하면 해당 충돌을 보여준다. 목표 초 수를 맞추려고 무언의 TTS 속도 변형·대사 삭제를 하지 않는다.

`RenderClosure`에는 source/selection/timeline hashes, decoded media properties, color profile, frame rate, resolution, fonts, rendering 코드·dependency lock·browser/FFmpeg build, codec options와 seed를 포함한다. UI와 export가 같은 composition을 써도 브라우저와 실제 codec의 결과가 완전히 동일하다고 보장할 수 없으므로 대표 frame와 실제 출력 audio/cue를 검증한다. content-addressed 입력과 pinned 환경은 재현 가능성을 높이며, 다른 OS/GPU의 MP4 bytes가 항상 같은 hash라는 보장은 별도 실측 없이는 하지 않는다.

재현성을 세 단계로 표시한다: **동일 입력 closure 보존**, **같은 도구 환경에서 다시 렌더 가능**, **실제 검증한 출력 일치 범위**. 생성 API 재호출로 동일 그림·연기를 재현하는 것과 저장 에셋으로 같은 타임라인을 재출력하는 것은 다르다.

preview proxy가 final과 다르면 proxy 배지를 표시한다. 선택 take의 개별 승인과 최종 mix의 청취를 구별한다. export 완료는 decode·duration·대표 frame·자막·실음원 검사가 끝난 뒤 표시한다. 입술 정렬·단어 강조·정확한 화자 diarization은 확보한 실제 evidence가 있을 때만 기능을 켠다. TTS text index를 word timestamp로 해석하지 않는다. [공식 응답 계약](https://ai.google.dev/api/interactions-api)

## 11. 출시 전 통과해야 하는 시험

아래는 제안된 acceptance matrix다. 테스트 계획이며 실행 결과가 아니다. 순수 계약/fixture 시험과 실제 한국어·시각·최종 mix 시험을 함께 둔다.

| 시험 | fixture/실행 | 통과 조건 |
|---|---|---|
| 40인 cast·8인 scene | 내레이터, offscreen, 두 명의 회상 상태, 군중 포함 | 모든 utterance가 정확한 occurrence/voice revision에 연결; scene 이외 미래 지식이 outbound에 없음 |
| 혼합 원천 | 승인 참조·부족한 표정·import 배경·새 clean plate | import/generate/edit provenance 분리, 각각 실제 blob 존재 |
| 두 탭 편집 | 같은 샷 동시 revise, 다른 장면 동시 revise | 같은 head 충돌 감지; 무관 aggregate 진행; command replay 동일 결과 |
| 늦은 응답 | r1 생성 대기 중 r2 대사 수정 | r1이 stale 후보로 보존, r2 슬롯·timeline·승인으로 자동 편입 안 됨 |
| 전송 불확실 | dispatch 직전/직후 crash, timeout | 직전은 안전 재개; 직후는 reconcile/unknown; blind 재전송 없음 |
| lease 충돌 | 느린 worker 뒤 새 worker claim | stale worker publish 거부; 외부 전송 여부 먼저 확인 |
| 취소와 과금 | queued 취소, running 취소, 결과 후 지연 취소 | 미전송 child 중단; 확인 없는 zero-charge 문구 없음; 자동 채택 없음 |
| 예산 | reserve 경합, 429, outcome_unknown | 동시 예약 누락 없음; unknown 노출 유지; 허용 요청/retry 수 이상 미전송 |
| blob 장애 | partial write, DB commit 직전 crash, 손상된 audio | decode/hash 실패를 완료로 표시하지 않음; orphan 복구; 승인 산출물 누락은 차단 |
| 마스크 fallback | native 없는 Adapter, 반전 mask, crop 좌표 | capability 표시 일치; local-composite 바깥 픽셀 보존; 경계 직접 검토 |
| alpha와 layer | 채널은 있으나 배경이 불투명, 머리 edge, 합성본 | alpha 존재만으로 합격 안 됨; 실제 분리 없는 layer를 선택 불가 |
| 원작/음성 상태 | 성인↔어린 시절, narrator↔inner voice | 상태별 승인 binding, 인물 지식/시각 공개 순서 유지 |
| voice 종료 | provider voice 만료/모델 오류 | 기존 audio 재생; 새 합성은 migration 후보; 자동 음색 변경 없음 |
| 수정 재사용 | 발화 1개, 카메라 1개, image region 1개 변경 | dependency 영향과 실제 재호출 목록 일치; 보존 blob 바뀌지 않음 |
| 재접속 | event 유실·중복·retention 밖 cursor | snapshot/resume으로 저장 head에 수렴; 중복 command 실행 안 됨 |
| 실제 한국어 품질 | 고유명사·숫자·겹침·반말/존댓말·숨긴 감정 | 누락/지시문 낭독 후보 검사와 사람 청취; 역할 구분·연기 적합성 기록 |
| 렌더 재현 | 동일 closure 재출력, 9:16/16:9 비교 | input 고정, 측정한 frame/audio 차이 범위와 실제 자막/reveal 검증 |
| 백업·restore | exporter snapshot, 원본 프로젝트 제거한 별도 환경 | 외부 임시 URL 없이 pinned preview/export 열림; secret 없음 |
| 유료 command 권한 | viewer/임의 origin에서 produce | 서버 거절; producer 허용 scope/budget 내 실행 |

**출시 차단 조건:** 원본 덮어쓰기, 결과 없는 완료 표시, stale 후보 자동 채택, 가짜 승인 승계, outcome_unknown의 blind retry, voice/source 상태 혼합, 원작 밖 비공개 자료 전송, secrets export, 부분 재사용 미작동, 최종 mix/영상 미검증이다. 모델 감상 점수·색상 배지·마이크로서비스 개수가 이를 대신하지 않는다.

## 12. 한 번에 만들지 않아도 전체 구조를 증명할 수 있다

첫 구현 검증 slice는 40인 cast 데이터와 8인 장면을 처음부터 포함한다. 실제 유료 음성은 일부 주요 배역으로 시작해 비용을 통제하되 데이터·UI·queue에 두 화자 상한을 박지 않는다. Editor에서 기존 이미지 import → 마스크 수정 후보 → 현재 샷 적용 → 발화 생성 → 타임라인 → 최종 preview/export를 한 번 끝낸다. 이어 늦은 결과, 전송 직후 중단, undo, 다른 탭 충돌, backup restore를 강제한다.

그다음 한국어 작품의 역할 구분과 연기를 실제로 듣고 8인 장면의 완성도를 검증한다. 재생 가능한 제품 구조와 감상 가능한 작품 품질은 두 시험이다. 이 계약이 통과한 뒤 회차 batch, 팀 협업, cloud rendering, lip-sync·관절 리깅·video generation을 필요한 순서로 확장한다.

이 설계의 핵심은 **Studio가 자료를 소비하는 화면에서 끝나지 않고 필요한 자료를 생산·수정·선택·검증하는 제작 공간이 되는 것**이다. 그 자유를 보존하려면 원작, 제작 후보, 채택판, 납품판, 실제 provider 호출을 서로 정확히 연결하고 독립적으로 보존해야 한다.
