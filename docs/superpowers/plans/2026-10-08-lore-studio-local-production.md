# Lore Studio Local Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 가상 UI를 실제 저장·반입·배역 편집·영역 합성·작업 복구·preview/export가 되는 독립 로컬 Studio로 바꾸고, Google 생성 adapter를 같은 제작 엔진에 연결한다.

**Architecture:** 별도 `studio/` 패키지의 headless engine이 project SQLite, immutable blobs, commands/events/jobs, source packages와 Edition을 소유한다. 로컬 HTTP Studio와 stdio Studio MCP는 같은 command interface를 호출한다. vibelore는 읽기 전용 connector로만 연결하고 현재 소설·웹툰 서버의 수명과 패키지 의존성을 유지한다.

**Tech Stack:** JavaScript ESM, Node.js `^22.13.0 || ^24.0.0 || ^26.0.0`, `node:sqlite`, `node:test`, vanilla browser UI. 이미지 codec/compositor는 `sharp@0.35.5`, 선택 renderer는 `remotion@4.0.534`, `@remotion/bundler@4.0.534`, `@remotion/renderer@4.0.534`, `react@19.3.0`, `react-dom@19.3.0`; lockfile로 고정한다. 원래 vibelore MCP는 zero-dependency를 유지한다. FFmpeg/ffprobe는 render capability preflight에서 검사한다. 버전은 2026-10-08 npm registry로 확인했다.

**Spec:** [다섯 번 검토한 최종 설계](../../research/studio-production-design-2026-10-08.md), [생산 계약·acceptance matrix](../../research/studio-production-contracts-2026-10-08.md), [Google API 계약 조사](../../research/google-media-production-api-review-2026-10-08.md).

## Global Constraints

- `world/`, `characters/`, `chapters/`는 정본이며 `.vibelore/`를 직접 수정하지 않는다. Connector는 기존 store/resolver를 읽기 용도로만 호출한다.
- 현재 `lore_webtoon_scene` 장면 workflow와 deprecated panel 경로의 계약을 변경하지 않는다.
- 첫 구현은 별도 `studio/` 패키지다. 원래 `src/server.js`, `engine/package.json`과 사용자가 수정 중인 showcase 파일을 건드리지 않는다.
- project/production/scene/shot scope, subject+appearance state, identity/occurrence/role/utterance를 구별한다. 배역 수를 2명이나 8명으로 제한하지 않는다.
- 캐시 입력, 실행 의도, attempt, 검토, 채택과 고정 Edition은 서로 다른 식별자를 가진다.
- 쓰기에는 commandId와 aggregate CAS가 필요하다. 진행 event가 무관한 편집 aggregate revision을 올리지 않는다.
- dispatching을 네트워크 전에 영속 기록한다. 재시작한 dispatching은 outcome_unknown이며 자동 재전송하지 않는다.
- 예산 reserve/outbox/command를 같은 transaction으로 기록한다. held_unknown을 TTL로 풀지 않는다.
- 후보와 원출력은 immutable이다. undo는 새 채택 결정이다. 공통 참조 undo가 기존 샷 채택을 연쇄 취소하지 않는다.
- 원천 rebase 영향에는 진행 중 job/attempt가 포함된다. 과거 package 후보를 새 package에 자동 채택하지 않는다.
- 보호 편집은 native mask 여부와 관계없이 최종 composite의 mask+feather 밖 canonical RGBA를 hard 검사한다.
- UI·MCP·renderer에 provider key나 원천 절대경로를 전파하지 않는다. loopback, origin/token 검사와 프로젝트별 blob 접근을 적용한다.
- 실제 생성·청취·렌더가 없는 결과에 성공 배지를 붙이지 않는다. provider 없는 환경에서도 imported assets로 편집/출력할 수 있어야 한다.
- TDD red→green 증거와 task별 검토를 보존한다. 유료 생성·공개 배포는 기본 테스트에서 실행하지 않는다.

## Review Focus

1. 같은 commandId의 다른 payload와 동일 intent의 동시 요청: 전자는 conflict, 후자는 하나의 실행에 합류하고 별도 채택 target을 유지해야 한다. Task 1/3에서 시험한다.
2. 손 수정 중 source rebase, 그리고 늦은 결과: 결과는 원래 target/package에 남고 새 package 사용에는 재사용 결정이 필요하다. Task 2/3에서 시험한다.
3. 실제 다인물과 시점: 어린 시점의 성인 꿈 형상, offscreen/narrator, 같은 voice를 쓰는 다른 배역이 합쳐지면 안 된다. Task 2/6에서 시험한다.
4. 보호 밖 1 LSB 변화·EXIF 회전·색 공간·손상 이미지·파일명 경로 탈출: 원출력 성공과 protected composite 성공을 구별하고 slot 채택을 차단해야 한다. Task 1/4/5에서 시험한다.
5. 렌더 중 편집·승인 중 정책 변경·backup 중 blob GC: 검토 대상 Edition은 고정되고 새 selection에 승인이 승계되지 않아야 한다. Task 7/8에서 시험한다.

## 첫 릴리스 범위와 실행 환경

이번 plan은 **단일 사용자 로컬 Studio의 첫 수직 구현**이다. 순서는 실제 project 생성/보존 → 자료 연결/반입 → 배역/발화/에셋 편집 → 선택 생성 → 실제 preview/export → 고정판 검토/복구다. OAuth SaaS, 팀 협업, remote worker, voice cloning, 생성형 video, 자동 lip-sync, ASR 단어 자막은 포함하지 않는다. 사용자 원고를 자동 집필하거나 정본에 역반영하지 않는다.

Remotion renderer는 선택 패키지이므로 headless core와 MCP를 사용할 때 Chromium/React가 필요하지 않다. 영상 출력이 미설치 상태면 render-unavailable로 표시하고 core 데이터를 계속 편집할 수 있다. 처음부터 preview와 export의 동일 frame function을 사용한다.

현재 PATH의 Node는 v23.11.0으로 원래 저장소의 지원 범위 밖이다. 실행에는 확인한 번들 Node v24.19.0을 사용한다:

```bash
node --version # bundled runtime bin prepended to PATH: v24.19.0
```

2026-10-09 사용자가 “구현 계획 만들어지면 구현시작해”라고 지시했다. 별도 worktree에서 Subagent-driven으로 연속 실행한다. worktree 시작점은 현재 `feat/shared-lore-media`의 HEAD로 하고, 새 브랜치는 `codex/lore-studio-local-production`으로 한다. uncommitted 사용자 변경을 복사하거나 reset하지 않는다. 이 plan과 task-owned 연구 문서만 필요한 근거로 전달한다. native worktree tool로 현재 branch HEAD에서 작업 공간을 만들었으며 단계마다 추가 확인을 요청하지 않는다.

## 공통 interface와 데이터

핵심 interface는 모든 task에서 아래 이름을 사용한다.

```js
// studio/src/engine/index.js
export async function openStudio({ directory, providers = {}, renderer = null }) {}
// 반환 service:
// command(envelope) -> Promise<CommandResult>
// snapshot(projectId) -> Promise<ProjectSnapshot>
// events(projectId, afterCursor = 0) -> Promise<Event[]>
// readBlob(projectId, blobId) -> Promise<Uint8Array>
// close() -> Promise<void>

// envelope:
// { projectId, commandId, aggregate: { kind, id }, expectedRevision, type, payload }
// result:
// { commandId, aggregateRevision, eventCursor, value, replayed }
// errors: { code, message, details }; secrets/prompt bytes are not details.
```

안정 ID는 `/^[A-Za-z0-9_-]{1,120}$/`, blob ID는 SHA-256 lowercase hex 64자리다. amount는 정수 USD micros이며 모든 금액에 estimate/actual 구분이 있다. JSON serialization은 key 순서가 다른 object도 같은 canonical digest를 내야 하며 NaN/Infinity, prototype keys, 비정상 cross-reference를 거부한다.

쓰기 command 목록은 task에서 추가한다. `project.create` payload는 `{ title, language, budgetMicros }`; 같은 project에 두 번째 create는 같은 command replay를 제외하고 conflict다. `production.create`는 `{ id, title, sourcePackageId }`; 빈 source로 시작할 때 sourcePackageId는 null이며 생성에 필요한 내용이 준비되기 전까지 해당 job만 차단한다.

Test helper는 Task 1의 `studio/test/helpers/project.js`가 만든다:

```js
export async function withStudio(t, options = {}) {}
// mkdtemp -> openStudio -> project.create(p1) -> t.after(close+rm)
// 반환 { directory, service, projectId:'p1', command: async(type,payload,overrides={})=>result }
// 기본 aggregate와 expectedRevision은 실제 snapshot에서 읽으며 overrides로 stale CAS를 시험한다.
```

---

### Task 1: 독립 패키지, 실제 프로젝트 저장과 command/blob 기반

**Files:** Create `studio/package.json`, `studio/package-lock.json`, `studio/src/engine/{index,contracts,project-store,blob-store}.js`, `studio/test/helpers/project.js`, `studio/test/project-store.test.js`, `studio/README.md`.

**Interfaces:** `openStudio`와 공통 service 구현. `project.create`, `production.create` command와 `snapshot`의 `{ project, productions, aggregates, eventCursor }`를 제공한다. ProjectStore는 SQL bound parameters와 explicit write transaction을 사용한다. BlobStore는 bytes→hash→temp/fsync/immutable rename→DB 등록을 담당하며 임의 file path를 받지 않는다. 이미지·음원 decode/type 검사는 Task 4의 asset boundary가 맡으며, 그 검사 전에는 asset candidate_ready를 발급하지 않는다.

- [x] **Step 1 — 실제 저장·재시작·CAS·command conflict 테스트를 먼저 작성한다.**

```js
it('reopens the saved production after process restart', async t => {
  const f = await withStudio(t);
  await f.command('production.create', { id:'main', title:'본편', sourcePackageId:null });
  await f.service.close();
  const reopened = await openStudio({ directory:f.directory });
  t.after(() => reopened.close());
  assert.equal((await reopened.snapshot('p1')).productions[0].id, 'main');
});
```

동일 command 재전달·다른 payload 충돌·stale aggregate·다른 aggregate의 독립 쓰기·손상 blob 읽기 차단도 각각 별도 `it`로 작성한다. restart는 가능한 경우 child process를 사용해 in-memory state를 읽는 테스트를 피한다.

- [x] **Step 2 — `node --test studio/test/project-store.test.js`를 실행해 missing feature로 실패한 출력을 기록한다.**
- [x] **Step 3 — schema version, SQLite WAL/busy timeout, projects/aggregates/commands/events/blob registry를 구현한다.**

```js
store.write(() => {
  const previous = store.command(envelope.commandId);
  if (previous) return replayOrConflict(previous, canonicalDigest(envelope));
  assertRevision(store.aggregate(envelope.aggregate), envelope.expectedRevision);
  const value = applyCommand(envelope);
  return store.recordCommandAndEvent(envelope, value);
});
```

위 함수들은 `project-store.js`의 내부 구현이다. 실패하면 transaction 전체를 rollback하고 event cursor를 발급하지 않는다. callback 안에서 외부 network/file generation을 실행하지 않는다. `package.json`은 `private:true`, ESM, 별도 test/start/mcp scripts를 가진다.

- [x] **Step 4 — 모든 Task 1 테스트를 green으로 만들고 bytes write 실패·orphan/missing recovery도 검사한다.**
- [x] **Step 5 — Task 1 파일만 commit하고 reviewer에게 diff와 red/green 출력을 전달한다.**

### Task 2: Source Connector와 다인물·배역·발화의 안정 모델

**Files:** Create `studio/src/source/{source-package,vibelore-connector}.js`, `studio/src/engine/{story,casting,rebase}.js`, `studio/test/{source-package,casting,rebase}.test.js`.

**Consumes:** Task 1 command/snapshot/blob service. Existing `src/core/production-source.js`의 `resolveProductionSource`/`verifyProductionSource`와 `MarkdownStateStore`는 connector에서만 읽는다.

**Produces:** `exportVibeloreSource({store,workId,request}) -> {package,blobs}`, `source.import`, `source.rebase`, `story.save`, `scene.put`, `cast.put`, `casting.set`, `utterance.update`. Scene에는 stable occurrences/utterances/shots가 있으며 `PresentationBinding`은 temporal, knowledge, appearance, casting state를 별도 참조한다. Snapshot에는 `sourcePackages, story, cast, scenes, resolvedBindings, sourceChanges`가 추가된다.

- [x] **Step 1 — 40개 배역, 같은 인물 과거/현재, 꿈 형상, inheritance/override, source bytes 보존 테스트를 먼저 작성한다.**

```js
it('requires an explicit choice for crossing casting scope and state', () => {
  const result = resolveCasting({
    occurrence:{ id:'past1', characterId:'seoyun', castingStateRef:'child' },
    decisions:[
      { scope:'project', characterId:'seoyun', state:'child', voice:'child-v1' },
      { scope:'production', productionId:'trailer', characterId:'seoyun', state:null, voice:'adult-v2' }
    ], productionId:'trailer'
  });
  assert.equal(result.status, 'unresolved');
});
```

`resolveCasting`는 `casting.js`의 공개 pure function이다. 정확한 source bytes와 readable 원문의 hash, export된 경로 없음, unknown/reveal 범위 유지, name 기반 identity auto-merge 없음도 검사한다.

- [x] **Step 2 — 세 test 파일을 실행해 red를 기록한다.**
- [x] **Step 3 — source DTO와 canonical data command를 구현한다.**

```js
const presentation = {
  occurrenceId:'past1', appearanceStateRef:'adult-dream',
  castingStateRef:'child', knowledgeStateRef:'before-letter'
};
```

scene-script 원천은 sealed bytes를 사용한다. novel sourceVersion 1은 원문 실제 bytes를 추가로 보존한 새 Studio package를 만들며 legacy snapshot이 이미 완전 보존이라고 표시하지 않는다. 원작 경로는 connector 설정에만 남고 DTO에는 넣지 않는다. rebase는 pending decisions를 만들고 과거 package를 삭제하지 않는다.

- [x] **Step 4 — green과 connector의 원천 파일 무변경 검사를 확인한다.**
- [x] **Step 5 — Task 2 범위만 commit하고 source/identity/priority 검토를 받는다.**

### Task 3: durable jobs, attempt·예산·unknown 복구

**Files:** Create `studio/src/engine/{jobs,budget,worker}.js`, `studio/test/{jobs,budget,worker-recovery}.test.js`, `studio/test/helpers/child-worker.js`.

**Consumes:** Task 1 transactions/blob registry, Task 2 source binding and target revisions.

**Produces:** `generation.request`, `attempt.retry`, `attempt.reconcile`, `job.cancel`, `job.reuse`, `runWorker({service,providers,signal})`; snapshot에는 `jobs,attempts,reservations,candidates`가 추가된다. Provider interface는 `capabilities()`, `generate(request,{signal})`, optional `inspect(operationId)`다. Result는 `{outputs:[{bytes,mime}],resolvedModel,providerRequestId,usage}`다.

- [x] **Step 1 — child-process kill 지점과 실제 reserve 경합을 먼저 시험한다.**

```js
it('recovers committed dispatch as unknown without a second send', async t => {
  const f = await withStudio(t);
  const job = await f.command('generation.request', validImageRequest());
  await runUntilDispatchCommitAndKill(f.directory, job.value.id);
  const recovered = await openStudio({ directory:f.directory });
  t.after(() => recovered.close());
  const attempt = (await recovered.snapshot('p1')).attempts[0];
  assert.equal(attempt.status, 'outcome_unknown');
  assert.equal(attempt.reservationStatus, 'held_unknown');
});
```

`validImageRequest`/`runUntilDispatchCommitAndKill`는 test helpers에 정의한다. 정상 adapter fake HTTP 서버는 실제 request 수를 외부로 기록한다. provider invocation mock 횟수만 검사하지 않는다. 같은 intent 동시 command 합류, fresh nonce 분리, 10건 예산으로 20건 요청, source rebase-before-dispatch, 늦은 응답 후 원래 target 유지도 포함한다.

- [x] **Step 2 — Task 3 테스트 red와 child-process 종료 증거를 기록한다.**
- [x] **Step 3 — command+outbox+reserve transaction, persisted dispatching, lease/fencing과 restart recovery를 구현한다.**

```js
const attempt = store.write(() => claimAndCommitDispatch(jobId, leaseToken));
try {
  const result = await provider.generate(attempt.request, { signal });
  await registerOutputsAgainstPinnedRequest(attempt, result);
} catch (error) {
  store.write(() => classifyAndRecordAttemptOutcome(attempt.id, error));
}
```

이 내부 함수들을 worker/jobs module에 구현한다. send 전에 발생한 확정 local validation failure와 send 후 ambiguous failure를 구별한다. unknown 상태에서 deadline/TTL이 지난다고 예약을 풀지 않는다. alive worker, queryable operation, 회수 불가능한 synchronous worker crash의 recovery action을 각각 제한한다.

- [x] **Step 4 — red fixtures가 green이고 복구 후 outbound request가 늘지 않는지 확인한다.**
- [x] **Step 5 — commit과 독립 concurrency/recovery 검토를 수행한다.**

### Task 4: 실제 Asset Lab — 반입·보호 편집·계보·범위별 채택

**Files:** Create `studio/src/assets/{decode,image-edit,audio-import}.js`, `studio/src/engine/adoptions.js`, `studio/test/{asset-import,image-edit,adoptions}.test.js`.

**Consumes:** Task 1 blobs, Task 2 subject/state slots, Task 3 candidate registration.

**Produces:** `asset.import`, `asset.derive`, `candidate.adopt`, `adoption.undo`; snapshot에 slots/adoptions/usageProposals/audit가 추가된다. `composeProtectedEdit({base,candidate,mask,geometry}) -> {bytes,validation}`는 canonical oriented RGBA와 feather 밖 exact equality를 검사한다. imported WAV는 실제 sample rate/channels/frame count를 기록한다.

- [x] **Step 1 — 1 LSB drift, EXIF orientation, malformed PNG/WAV, stale-base와 공통 undo 테스트부터 작성한다.**

```js
it('keeps every protected pixel from the decoded base', async () => {
  const result = await composeProtectedEdit({
    base:basePng, candidate:outsideDriftPng, mask:handMaskPng, geometry:identityGeometry
  });
  const pixels = await decodeCanonicalRgba(result.bytes);
  assert.deepEqual(pixelsOutsideMask(pixels,handMask), pixelsOutsideMask(basePixels,handMask));
  assert.equal(result.validation.protectedPixels, 'passed');
});
```

각 helper/fixture는 `studio/test/helpers/images.js`로 만들고 actual encoded bytes를 검사한다. 다른 state의 사용 제안 0개, project undo 후 shot pin 유지, audit append, 후보 immutable, incompatible geometry 채택 차단을 별도 사례로 둔다.

- [x] **Step 2 — red를 기록한다.**
- [x] **Step 3 — sharp decode/orient/convert/raw 합성/encode와 상태별 slot adoption을 구현한다.**

```js
const raw = await sharp(bytes).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject:true });
```

원출력과 protected composite은 별도 revision이다. crop viewport는 ShotTransform이며 새 파일 저장만 derivative이다. decode failure는 quarantine이고 단순 MIME/확장자만 신뢰하지 않는다. Import UI는 실제 bytes를 이 command에 전달한다.

- [x] **Step 4 — protected RGBA/undo/import 테스트 green을 확인한다.**
- [x] **Step 5 — scoped asset implementation을 commit하고 reviewer가 상태/픽셀/계보를 확인한다.**

### Task 5: 로컬 daemon과 독립 Studio MCP

**Files:** Create `studio/src/transport/{http,mcp}.js`, `studio/bin/{studio,studio-mcp}.js`, `studio/test/{http,mcp}.test.js`.

**Consumes:** Task 1–4 service. Adapter가 command validation/approval을 다시 구현하지 않는다.

**Produces:** CLI `node studio/bin/studio.js --project <studio-dir> --port 0`; loopback만 listen한다. HTTP는 `GET /api/snapshot`, `POST /api/commands`, `GET /api/events?after=`, `GET /api/blobs/:blobId`, bounded import body를 제공한다. MCP는 `studio_status`, `studio_command`, `studio_events`를 제공하고 vibelore server를 변경하지 않는다.

- [x] **Step 1 — 실제 HTTP/stdio round-trip·origin/token·path traversal·SSE reconnect 테스트를 작성한다.**

```js
it('rejects a foreign origin before command execution', async t => {
  const app = await startTestServer(t);
  const response = await fetch(`${app.url}/api/commands`, {
    method:'POST', headers:{ origin:'https://foreign.example', 'content-type':'application/json' },
    body:JSON.stringify(app.createCommand)
  });
  assert.equal(response.status, 403);
  assert.equal((await app.service.snapshot('p1')).eventCursor, app.initialCursor);
});
```

동일 command를 UI/MCP 양쪽에서 전달한 replay를 검사한다. upload size cap 128 MiB, request UTF-8 body cap 1 MiB(반입 제외), blob ID 및 project membership 검사도 포함한다. 토큰은 UI bootstrap의 해당 local origin에서만 전달하고 URL/log에 넣지 않는다.

- [x] **Step 2 — transport red를 확인한다.**
- [x] **Step 3 — stdlib HTTP/stdio transport와 no-store/CSP/error redaction을 구현한다.**

```js
const result = await service.command(validatedEnvelope);
replyJson(response, 200, result);
```

내부 검증은 engine에서 수행한다. transport는 content-type/origin/token/size만 담당한다. static 파일 serving은 고정된 `studio/ui/` 아래 whitelist이며 source folder를 serve하지 않는다.

- [x] **Step 4 — 실제 두 client command/CAS/event round-trip green을 확인한다.**
- [x] **Step 5 — daemon/MCP commit과 transport 검토를 수행한다.**

### Task 6: persistent Studio UI와 Google 생성 adapter

**Files:** Create `studio/ui/{index.html,studio.css,app.js,api.js,story.js,cast.js,asset-lab.js,edit.js,production.js}`, `studio/src/providers/{google,credentials,capabilities}.js`, `studio/test/{ui-flows,google-provider}.test.js`, `studio/test/helpers/google-http.js`.

**Consumes:** Task 5 endpoints, Task 3 provider protocol, Task 4 imports/adoptions. 화면의 authoritative state는 HTTP snapshot/events다. optimistic edit는 실제 저장 실패/conflict를 보여준다.

**Produces:** 실제 빈 project 생성, 원고/자료 import, source/각색 대조, 40-role search/filter, occurrence별 voice override, utterance별 acting/hold, source mask, 전후/실제 audio take 비교, candidate/adoption/undo, job recovery UI. Google model config는 API surface/model ID를 명시하고 capability preflight로 사용할 수 없는 모델을 막는다.

- [x] **Step 1 — HTTP fixture를 통한 실제 UI command behavior와 provider request/response contract 테스트를 작성한다.**

```js
it('saves only the selected utterance performance', async t => {
  const f = await withStudio(t);
  await seedManyCastScene(f);
  await f.command('utterance.update', { id:'u2', acting:'확신을 감춘다', holdMs:800 });
  const scene = (await f.service.snapshot('p1')).scenes[0];
  assert.equal(scene.utterances.find(x=>x.id==='u2').acting, '확신을 감춘다');
  assert.equal(scene.utterances.find(x=>x.id==='u1').acting, '원래 지시');
});
```

UI module는 명시한 command를 만들고 서버 결과로 다시 렌더한다. 구현 전 official Google model/Interactions/image/voice 계약을 다시 읽어 fixture를 만들고 text/index metadata를 timecode로 파싱하지 않는 테스트를 둔다. transport fallback이나 retry를 adapter 안에서 숨기지 않는다.

- [x] **Step 2 — backend 연결 전 red를 확인한다.**
- [x] **Step 3 — 5개 작업 공간을 연결하고 Google adapters를 구현한다.**

```js
const receipt = await api.command({
  type:'utterance.update', aggregate:{kind:'utterance',id:selectedId},
  expectedRevision:selectedRevision, commandId:crypto.randomUUID(),
  projectId, payload:{id:selectedId,acting:actingField.value,holdMs:Number(holdField.value)}
});
```

브라우저는 credential을 받지 않는다. credential resolver는 macOS의 명시한 기존 Keychain service 또는 backend 환경 변수에서 읽으며 자동 key 생성/저장·계정 변경을 하지 않는다. API 미설정 상태에서는 imported image/audio로 편집하고 생성 버튼에 실제 unavailable 이유를 표시한다. 화면 mock의 SVG·CSS는 디자인 참조이고 memory simulation event handler를 production 구현으로 복사하지 않는다.

- [x] **Step 4 — provider fake HTTP 테스트 green, CUA 실제 create/import/edit/reload/undo/unknown, 320/768/1024px와 keyboard/console을 확인한다.**
- [x] **Step 5 — UI/provider commit 후 per-task review를 받는다. 실제 유료 호출 성공은 실행한 경우에만 별도 기록한다.**

### Task 7: 실제 음원 길이 기반 timeline과 공통 preview/export renderer

**Files:** Create `studio/src/engine/timeline.js`, `studio/src/render/{edition,renderer,probe}.js`, `studio/render/{composition.jsx,frame.js}`, `studio/ui/player.js`, `studio/test/{timeline,render,edition}.test.js`.

**Consumes:** 실제 imported/generated bytes와 resolved selection, utterance take sample metadata. Renderer는 API provider를 호출하지 않는다.

**Produces:** `timeline.update`, `edition.create`, `edition.render`, `edition.review`, `edition.publish`; Edition closure/manifest와 actual output checks를 저장한다. `frameAt({edition,frame,fps})`는 camera/caption/layer 정보를 결정론적으로 반환하고 player와 export에서 공유한다. Output profile은 16:9/9:16; 사건 순서가 달라지는 예고편은 별도 Production이다.

- [x] **Step 1 — known WAV 길이·anchor·fixed time conflict·working v2와 고정 v1·policy race를 시험한다.**

```js
it('anchors the reply after the actual preceding audio end', () => {
  const plan = resolveTimeline({ fps:30,
    takes:[{utteranceId:'u1',frames:48000,sampleRate:24000}],
    cues:[{id:'reply',anchor:{utteranceId:'u1',edge:'end'},offsetMs:400}]
  });
  assert.equal(plan.cues[0].startFrame,72);
});
```

`resolveTimeline`은 timeline.js의 pure function이다. caption safe area, unknown model metadata, source package closure, missing audio/blob 차단도 검사한다.

- [x] **Step 2 — timeline/edition red를 기록한다.**
- [x] **Step 3 — Remotion optional composition/renderer와 immutable Edition을 구현한다.**

```js
export const frameAt = ({ edition, frame, fps }) => resolveFrame(edition, frame / fps);
```

`resolveFrame`은 frame.js에 구현하고 keyframe interpolation은 미고정 random/현재 시간에 의존하지 않는다. render queue는 고정 closure를 읽는다. review/publish CAS는 DB transaction 안에서 closure/manifest/policy binding을 비교한다. 실제 rendered MP4를 ffprobe로 확인하고 대표 frame/audio mix 검사를 기록한다.

- [x] **Step 4 — 60~90초 fixture의 실제 영상과 audio-only 파일을 출력해 검사한다. preview/export 1-frame 동기 목표를 측정한다.**
- [x] **Step 5 — renderer/edition commit과 playback/publish 검토를 받는다.**

### Task 8: 백업/복구·출시 회귀·사용 방법과 전체 검토

**Files:** Create `studio/src/engine/{backup,recovery}.js`, `studio/test/{backup,production-e2e}.test.js`, `docs/LORE_STUDIO.md`; Update `studio/README.md`와 `studio/package.json`의 test/check scripts만.

**Consumes:** 앞선 전체 service, closed SourcePackage/Edition/blob closure. No private originals/credential이 support bundle 기본 내용에 포함되지 않는다.

**Produces:** `project.backup`, `project.restore`, format/schema version preflight, startup integrity check, pinned blob lease/GC rules, 사용자 실행·import·생성·출력·복구 설명. 원래 root README/showcase를 덮어쓰지 않는다.

- [x] **Step 1 — 보존 bundle에서 원작·provider가 없는 상태의 reopen/render와 backup/GC 경합을 시험한다.**

```js
it('restores adopted bytes without the original source folder or provider', async t => {
  const f = await seededProduction(t);
  const saved = await f.command('project.backup', {});
  const restored = await restoreStudioBackup({ archive:saved.value.archive, directory:f.restoreDirectory });
  t.after(() => restored.close());
  assert.equal((await restored.snapshot('p1')).editions[0].closureDigest, f.edition.closureDigest);
  assert.deepEqual(await restored.readBlob('p1',f.imageBlobId), f.imageBytes);
});
```

test helper `seededProduction`은 실제 fixture 파일로 제작판을 만든다. 다른 schema version·checksum mismatch·active unknown attempt의 참조 blob 보존·support bundle secret redaction도 각각 검사한다.

- [x] **Step 2 — backup/recovery red를 확인한다.**
- [x] **Step 3 — checksum inventory·closed bundle·startup integrity report·read lease를 구현한다.**

```js
await verifyInventory(bundle.manifest, bundle.blobs);
await restoreIntoNewDirectory(bundle, targetDirectory);
```

두 함수는 backup.js에 구현하고 기존 project를 덮어쓰지 않는다. manifest 안의 절대경로·`..`·symlink를 거부한다. 초기 형식은 JSON manifest+blobs의 portable directory이며 외부 shell로 임의 archive를 풀지 않는다.

- [x] **Step 4 — 지원 Node에서 새 Studio suite와 기존 root/engine suites를 실행하고 전체 출력·실패명을 기록한다.**

```bash
node --test "studio/test/**/*.test.js"
node --test "test/**/*.test.js"
(cd engine && node --test "test/**/*.test.js" "test/**/*.test.mjs")
node scripts/check-source.js
```

CUA로 실제 empty project·PNG/WAV import·4인 이상+offscreen/narrator 편집·reload·후보 비교·scope undo·실제 preview/export·unknown recovery를 확인한다. 실제 한국어 audition과 외부 과금은 key와 실행 권한이 있을 때만 별도 기록한다. 미실행 게이트에 pass 표시를 하지 않는다.

- [x] **Step 5 — 전체 diff를 최종 독립 review에 전달하고 중요한 지적을 모아 수정→제한 재검토한다. worktree commit은 task-owned paths만 포함한다. push·merge·공개 배포는 구현 완료 조건에 포함하지 않는다.**

## 완료 조건과 다음 단계

로컬 first slice의 완료 조건은 실제 새 project 저장, source/imported 자료의 다인물 편집, 보호 이미지 수정과 음성 take 선택, 실제 파일 출력, 재시작·늦은 결과·undo·원작 개정 시 기존 선택 보존이다. provider fixture의 성공을 실제 생성 품질과 혼동하지 않는다.

운영 출시 판정은 승인된 설계의 release gates를 별도로 실측한다. 한국어 음성 품질·identity 연속성·실제 provider quota/요금·mask 경계의 자연스러움·screen reader 실사용의 미실측 항목을 최종 보고에 남긴다. 제어·복구 시험과 실제 작품 품질 평가를 구별한다.

## Plan self-review

- Spec coverage: Task 1=store/commands/blobs; 2=source/identity/casting/rebase; 3=execution/budget; 4=Asset Lab/adoption; 5=UI/MCP common engine; 6=5 spaces/provider; 7=performance/timeline/Edition; 8=backup/recovery/regression. cloud·협업·voice clone·generative video·word ASR은 명시적으로 초기 범위 밖이다.
- Interface consistency: `openStudio`/service/envelope/CommandResult는 이 문서의 공통 interface를 사용하고 transport/UI에서 별도 workflow를 만들지 않는다.
- Review Focus 1→Task 1/3; 2→Task 2/3; 3→Task 2/6; 4→Task 1/4/5; 5→Task 7/8의 실제 테스트에 대응한다.
- 2026-10-09 사용자 실행 지시에 따라 native worktree에서 구현을 시작한다.

## 구현 전 기준선 확인

번들 Node v24.19.0에서 기존 root 874개·engine 1,239개 테스트를 실행했고 모두 통과했다. 제작 코드와 운영 설정은 수정하지 않았다. [기준선 영수증](lore-studio-local-production-baseline.json)에 실행 범위를 기록했다.

## 실제 구현·검토 완료 기록 — 2026-10-09

위 40개 task 단계는 구현·TDD·commit·독립 검토/수정 증거에 따라 완료 표시했다.
[구현 영수증](../../research/studio-implementation-evidence-2026-10-09.json)에 8개 task의
초기 검토, 수정, 제한 재검토와 실제 검증 범위를 보존한다. Task8의 실행 그래프 검증
지적은 `04ab70f`에서 수정하고 독립 재검토를 통과했다. 전체 branch `b3200d3..04ab70f`
검토의 3개 Important 지적은 한 번의 수정 `ca451d6`과 한 번의 범위 제한 재검토로
모두 해소했다. 새로운 전체 branch 재검토를 했다는 주장은 아니며 열린 지적은 없다.

최종 영향 범위 10개 파일은 143/143, source check는 774개 경로/exit0이다.
앞선 Studio 279/279 이후 47/47와 1/1, Task8 수정 72/72와 7/7, root 872/874
뒤 문서 수정 5/5, engine 1239/1239는 각각 별도 단계이며 현재 모든 테스트를
한꺼번에 실행했다는 뜻이 아니다. 두 Studio 전체 실행 실패와 root 문서 실패,
RED wrapper의 node 종료 코드 미기록 한계도 원래 영수증에 남겨 두었다.
실제 복원 MP4/WAV 57.833초 출력은 보존되고 최종 수정은 frozen renderer fingerprint와
lockfile을 바꾸지 않아 불필요한 장시간 재렌더를 하지 않았다.

판정은 승인된 단일 사용자 로컬 first slice에 한정한다. 실제 Google 과금·quota,
한국어 연기/발음·identity 연속성·mask 경계·screen reader는 미측정 출시 gate다.
브라우저 다운로드 완료 및 인간의 청취/감상 승인도 검증 완료로 표시하지 않는다.

적용한 Ruling은 정확히 두 개다.

1. Task1은 fsync한 임시 파일을 같은 디렉터리의 exclusive hard link로 게시한 뒤
   임시 이름을 지우고 디렉터리를 fsync한다. 기존 immutable digest 경로의 덮어쓰기를
   막기 위한 결정이며, 틀렸다면 hard link 미지원 파일시스템의 게시 경로를 다시
   구현해야 한다. 실패는 명시적으로 남고 불완전한 bytes를 등록하지 않는다.
2. Task8의 필수 사용자 안내와 sanitized 구현 증거 JSON만 root package의 files
   allowlist에 추가했다. 배포 문서 참조 불변식을 지키기 위한 예외이며 runtime
   dependency/script/bin/server 및 원본 checkout은 바꾸지 않았다. 틀렸다면
   package 용량/문서 배포 범위를 재작업해야 하고, 증거 sanitization이 빠지면
   사적 경로·자료가 노출될 수 있으므로 정확한 파일 범위와 정제를 검사한다.
