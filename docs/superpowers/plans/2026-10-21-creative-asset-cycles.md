# Creative Asset Cycles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 여러 창작 사이클에서 정확한 원문·이미지·음원을 보존하고 찾아 재사용하며, 새 표현·소리·결과와 선택 근거를 다음 사이클에 남긴다.

**Architecture:** 명시적으로 등록한 vibelore/Studio 소유자의 읽기 전용 metadata를 Library에서 함께 찾는다. 닫힌 AssetBundle을 기존 Studio command/CAS/lease 안에서 새 후보와 출처 영수증으로 원자 반입하고, 기존 채택·파생·Edition을 사용한다. 독립 오디오와 인물 layer를 같은 고정 Edition/preview/export에 연결한다.

**Tech Stack:** ESM JavaScript, Node.js 24.19.0 (`/Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`), node:sqlite, existing sharp/Remotion/React, node:test, ffmpeg/ffprobe/existing Chrome.

**Spec:** [Design](../specs/2026-10-21-creative-asset-cycles-design.md), [Contracts](../specs/2026-10-21-creative-asset-cycles-contracts.md). These are binding together.

## Global Constraints

- Work only in `/Users/lyoojk/.codex/worktrees/creative-asset-cycles/vibelore`, based on Studio `26b0bca3` plus approved design `dfa99dee`. Original checkout, old Studio worktree, ai-content-studio, canon and `.vibelore/` remain untouched.
- User explicitly requested proceeding from plan directly to implementation. Execute sequential SDD without another plan approval pause. Fresh task reviewer and final whole-branch reviewer; implementers never spawn subagents.
- Local single user, explicit owners/projects. Library has no blob/job/canon authority. Source opening never initializes/migrates/recovers. Existing source disclosure and drift checks apply.
- Genre/style/count are unrestricted. Paper/cutout/reading are optional examples, never engine defaults. No new provider, paid request, upload, publishing, credentials, or browser download.
- OriginRef is `{ownerId,projectId,recordKind,recordId,revision}`; revision is exact native opaque string (never `latest`). Content hash is not semantic identity or evaluation proof.
- Bundle schemaVersion 1; manifest <=512 KiB; records <=256; links <=1024; file <=20 MiB; unique files total <=24 MiB; JSON depth <=32. Directory format `manifest.json` + `files/<sha256>`, no archives/symlinks/network instructions.
- Studio schema 2, Library schema 1. Explicit Studio 1→2 upgrade preserves old source/candidates/adoptions/Edition. Old executors must refuse schema 2. Backup, recovery, GC, replay stay valid.
- First consuming writers: Studio text/source, image/audio. Video/structured discovery/reference is distinct from unsupported import/render. AI clip renderer/new providers/host service execution are future capabilities; existing job/attempt/outcome_unknown is their seam, no second runner.
- Asset import has one selected root/slot per command. Candidate IDs server-issued. Local parentCandidateIds contain only real local candidates; external refs remain provenance. Import never implies adoption or generation.
- Raw selected-content bytes stay byte-identical; pinned destination normalization produces consumed canonical. Record normalized-from on change, preserve manifest/required blobs through Edition/backup/GC.
- Tests use actual SQLite/files/decoders with fake providers. Run RED before implementation, focused GREEN then `NODE_NO_WARNINGS=1 <NODE24> --test studio/test/*.test.js` per task (log outside repo). Host permission is required for existing ps-based lease incarnation checks/local renderer. Do not weaken lease checks.
- Baseline: 351/351 existing Studio tests passed under Node 24 with host permission. Existing dependency symlink is ignored locally; do not install or commit node_modules.

## Review Focus

- An old exact Ref after source changes or disappears must never silently become HEAD; preserved destination remains usable (Tasks 2/4/8).
- Mixed successful source import and failed image import must preserve receipts and resume only failed items (Tasks 2/8).
- A hostile but correctly rehashed bundle must not bypass semantic mapping, depth/path/size limits, actual decode, or speech text/language pins (Tasks 1/2).
- Refresh/unregister/rebind races and source schema errors must not revive data or mutate source stores (Tasks 3/4).
- Music/silent scenes, transparent overlapping actors and later edits must render the frozen Edition identically in preview and export (Tasks 6/7/8).

---

### Task 1: Closed bundle codec and portable references

**Files:** Create `studio/src/reuse/bundle.js`, `studio/test/reuse-bundle.test.js`, `studio/test/helpers/bundles.js`.

**Interfaces:**
- Consumes existing `canonicalJSON/canonicalDigest/fail` in `engine/contracts.js`.
- Produces `originKey(ref): string`, `validateOriginRef(ref): OriginRef`, `sealBundle(manifestWithoutDigest): AssetBundle`, `validateBundle(bundle, bytesBySha256?): AssetBundle`, `readBundleDirectory(directory): Promise<{bundle,bytes}>`, `writeBundleDirectory(directory,{bundle,bytes}): Promise<void>`.
- `bytes` is a plain JSON object mapping SHA-256 to integer byte arrays. Validation returns a defensive portable clone, never executes metadata. `sealBundle` computes recordSha256 excluding itself and manifestSha256 excluding itself. Missing bytes may be skipped only when argument omitted for metadata inspection; import always passes them.

- [ ] **Step 1: Write failing behavioral tests.** Build two identical PNG fixtures with different subject/owner refs; assert distinct origin keys. Roundtrip sealed manifest and bundle directory preserves exact bytes. Tampering byte/record/manifest fails hash checks; missing runtime records/files fails BUNDLE_INCOMPLETE; historical refs may be absent. Assert unsupported schema, `latest`, path/locator keys, symlink ancestor/leaf, prototype/accessors, duplicate refs/hash descriptors, depth 33 and each exact size/count boundary fail explicitly. A hash in metadata never becomes a filesystem path. Helpers export `bundleFixture({roots?,records?,files?,links?})` returning `{bundle,bytes}` and `ref(overrides={})`.
- [ ] **Step 2: RED.** `NODE_NO_WARNINGS=1 <NODE24> --test studio/test/reuse-bundle.test.js`; expected missing exports/module or behavior assertion failures.
- [ ] **Step 3: Implement the interfaces.** Use fixed safe paths, O_NOFOLLOW plus ancestor checks, bounded JSON/file reads, canonical hashes and closed runtime graph; unique byte total counted once. Unknown executable/path-bearing fields fail; inert literal text/prompt is data. Do not invent rights/evaluation claims. Directory writes are exclusive into a new directory, atomic publication or cleaned partial directory on failure.
- [ ] **Step 4: GREEN.** Focused tests and full Studio suite pass. Self-review trust boundaries and exact limit errors.
- [ ] **Step 5: Commit** `feat(studio): add closed reusable asset bundles` (only task files).

### Task 2: Destination inspection, atomic provenance import and schema migration

**Files:** Create `studio/src/reuse/inspect.js`, `studio/src/reuse/import.js`, `studio/test/reuse-import.test.js`, `studio/test/reuse-migration.test.js`. Modify `studio/src/assets/commands.js`, `studio/src/engine/{index,project-store,recovery,backup}.js`, `studio/src/source/{manuscript,source-package}.js`, `studio/src/render/closure.js`.

**Interfaces:**
- Consumes Task 1 bundle validation and existing slotDeclaration/slotPins/candidateMatchesSlot, asset decoders and staging leases.
- Produces `inspectReuse({bundle,bytes,destination,intent}): Promise<ReuseInspection>` where destination is internal `{service,projectId}`; add `service.inspectReuse({projectId,bundle,bytes,intent})` facade. DTOs exact spec contracts.
- Produces `registerReuseCommands(service)` registering `asset.importBundle` payload `{bundle,bytes,inspectionDigest,intent,actor,reason}`. Command uses existing command-result wrapper; result.value includes `importReceipt` and slot/candidate information. Receipt is the spec ImportReceipt.
- Produces `source.importBundle` (aggregate sourcePackage, root text only) payload `{bundle,bytes,sourcePackageId,productionId,title,language,actor,reason}`; share existing source import preparation, preserve originRefs/localManifestBlobId/fileMap as source package provenance. No image-as-text coercion.
- Persist asset receipts in `reuse_imports(project_id,id,reuse_key,data_json)`, with project foreign key; source provenance stays in source aggregate. Schema version 2. Backup/recovery table lists and validation include receipts. `snapshot.reuseImports` exposes receipts. No client candidateId. New imported candidates retain `reuseRole` from the inspected selection; exporters/consumers must not promote reference roles to render roles.

- [ ] **Step 1: Write failing tests.** Import image/audio exact source into second project; inspect pins/digest then command creates one candidate and receipt, zero jobs/adoptions. Source raw and predicted canonical hash match actual. JPEG/WAV normalization differences recorded. Same command replay returns same receipt; changed payload COMMAND_CONFLICT; new command reuse-preserved returns actual existing candidate ID, new-import creates new candidate. Rejected/corrupt existing candidate is never reused. Different external owners/same bytes keep separate provenance and no external local parent IDs.
- [ ] **Step 2: Add failure tests.** Wrong identity/state mapping → needs_decision/REUSE_MAPPING_REQUIRED; style-only as identity, mismatched utterance text/language/voice/performance, bad target/role or extra selections cannot import. Tampered inspection digest, partial file, stale CAS or concurrent semantic pin changes creates no candidate/receipt/adoption. Video/structured → unsupported, not fabricated decode success. Import exact text then fail image retains source receipt; retry image doesn't repeat source. After import delete original source, GC and backup/restore retain local manifest/raw/canonical/Edition references. Schema1 upgrade/reopen/replay preserves IDs, old Edition and rejected candidates; failed migration rollback; future schema rejected.
- [ ] **Step 3: RED.** Run the two new test files; verify behavioral failure before implementation.
- [ ] **Step 4: Implement preparation/final transaction.** Share existing asset prepare helpers (no nested command). Single root/slot plus required files only; current semantic pins and inspection recalculated before acceptance. Persist all required blobs including historical source raw if supplied. Semantic reuse key includes project/bundle/root/slot/current meaning/purpose/mapping/normalizer; excludes actor/reason, issued IDs, observational slot revision. CAS remains independent. Return actionable contract/context/advisory findings; compatible means technical fit, never subjective approval. Source import provenance and asset import use same manifest closure; GC sees actual local blob IDs only. Transaction includes receipt/candidate/slot/event; failed CAS leaves only lease-recoverable staging.
- [ ] **Step 5: GREEN.** New tests + full suite. Inspect SQL migration/backup/rollback and byte equality evidence; commit `feat(studio): preserve cross-project reuse provenance atomically`.

### Task 3: Federated local metadata Library

**Files:** Create `studio/src/library/{index,registry,projection,query}.js`, `studio/test/library.test.js`.

**Interfaces:**
- Consumes OriginRef/originKey from Task 1. Adapters are explicitly injected `{[adapterKind]: factory({locator,ownerId,allowedProjects}) -> OwnerAdapter}`; private locators never enter public projection/bundle.
- Produces `openLibrary({directory,adapters}): Promise<{command,query,exportExact,close}>`.
- Commands envelope `{commandId,expectedRegistryRevision,type,payload}` types owner.register/rebind/unregister/refresh. Register payload `{adapterKind,locator,allowedProjects}`; ownerId random UUID returned. Rebind `{ownerId,locator,confirmRefs,allowedProjects?}` requires adapter verifies refs against explicit new scope (default current). Scope changes preserve private history but public local anchors obey current allowed projects; excluded inspect is unverified/null and export PROJECT_NOT_ALLOWED. Refresh/unregister `{ownerId}`. Replay exact; payload conflict explicit. Registry mutations use CAS; refresh checks generation/token before projection replacement.
- Queries `{type:'find',text?,mediaKind?,ownerId?,projectId?,role?,subject?,limit?}`, `{type:'inspect'|'lineage'|'uses',ref}`, `{type:'cases',ownerId?,projectId?}`. Returns portable owner-scoped observations. `exportExact({ownerId,roots,disclosure})` dispatches registered owner after project checks, returns validated `{bundle,bytes}`.
- OwnerAdapter `capture({ownerId,allowedProjects,afterToken?}) -> {token,entries,links,uses,cases}` and `exportExact({roots,disclosure})`; required `identify():Promise<string>` for a private physical-source fingerprint and `verifyRefs(refs):Promise<boolean>` for rebind. Pin source identity at successful registration; capture/export verify it before and after IO, replacement returns OWNER_REPLACED with prior entries unverified. Rebind requires nonempty confirmRefs. Capture entries exact LibraryEntry excluding observed (Library adds token/at/generation), opaque snapshot token is equality-only; per-owner refresh sequencing prevents stale overwrite.

- [ ] **Step 1: Write failing tests.** Two fake owners share names/bytes but remain distinct; filtering and exact inspect/lineage/uses/cases work. Registration persists across reopen; rebuild removed projection from explicit owners, no filesystem scan. Offline preserves timestamp and marks offline; missing exact Ref differs from offline. Interleave two refreshes and unregister/rebind: late old result discarded; one owner failure never erases another owner's entries. Replayed commands identical; CAS/payload conflicts explicit; locators absent from returned DTO and exports; non-allowed project roots blocked.
- [ ] **Step 2: RED.** `NODE_NO_WARNINGS=1 <NODE24> --test studio/test/library.test.js`.
- [ ] **Step 3: Implement interfaces.** Registry schema1 local SQLite in supplied directory, config durable separate from rebuildable projection. Source adapter calls outside final write transaction; final write checks registry generation + request sequence. Close waits in-flight operations safely. Never compare tokens across owners or silently rebind a replaced repository. No blob ownership or generation APIs.
- [ ] **Step 4: GREEN.** Focused and full suite; commit `feat(studio): add explicit federated asset library`.

### Task 4: Read-only Studio and vibelore owner exporters

**Files:** Create `studio/src/source/{export-studio-assets,export-vibelore-assets}.js`, `studio/test/library-owners.test.js`. Modify `studio/src/source/vibelore-connector.js` only to share existing safe disclosure/resolver helpers; modify reuse import exports only if required to preserve reexport lineage.

**Interfaces:**
- Consumes Tasks 1/2/3. Produces `createStudioOwnerAdapter({locator,ownerId,allowedProjects})` and `createVibeloreOwnerAdapter({locator,ownerId,allowedProjects})`, conforming Task3 OwnerAdapter; `locator` is owner-specific private config with directory and explicitly selected source roots/project mapping.
- Studio exact candidate ref recordKind candidate, recordId local candidate ID, revision native immutable metadata digest. SourcePackage/Edition refs retain exact native IDs/digests. Use immutable events/preserved records to export old refs where available; unavailable old ref fails, no HEAD fallback. Capture can include source, candidates, Edition, receipts, cycle/case (Task5 will extend).
- Vibelore resolves existing canonical source and asset catalog/webtoon references read-only, native revision preserved. Only explicitly allowed committed/public context; author-only, future or unsynced drift is not silently exported. Missing root/store fails without creating files.

- [ ] **Step 1: Write failing tests.** Real schema1 and schema2 Studio sources are read without schema/recovery/file changes; nonexistent or future schema source fails without creating storage. Registered projects only; retained exact old candidate exports after newer candidate; directory bundle import into second owner then derive and reexport has new local Ref plus external/normalized ancestry, closed runtime files. Read source offline fails export, destination still works.
- [ ] **Step 2: Add vibelore tests.** Small real source fixture with canonical chapter, world/character public asset and webtoon asset; exact bytes/revision/source disclosure retained, author-only/future omitted and disclosure lists omissions. Working-tree drift reports sync-required rather than guessing. Symlink escape and out-of-allowlist source paths blocked. Capture/export never calls openStudio or migration/GC. Hash original source tree before/after to prove read-only.
- [ ] **Step 3: RED.** Run `studio/test/library-owners.test.js`.
- [ ] **Step 4: Implement adapters.** Existing storage opened read-only with consistent DB snapshot; safe bounded content reads/hash verification before returning. Verify physical source fingerprint for replaced-path detection; rebind requires explicit confirmRefs, copies register distinct UUIDs. Capabilities reflect supported text/image/audio vs discovered video/structured; avoid claiming incomplete historical blobs are runtime-ready. Reexport preserves source observations as observations, no foreign approval inheritance.
- [ ] **Step 5: GREEN.** Focused+full suite; commit `feat(studio): export exact assets from registered read-only owners`.

### Task 5: Recorded cycles, reuse decisions and honest production cases

**Files:** Create `studio/src/engine/asset-cycles.js`, `studio/test/asset-cycles.test.js`. Modify `studio/src/engine/{index,history}.js`, `studio/src/source/export-studio-assets.js`, `studio/src/library/query.js` as needed.

**Interfaces:**
- Produces `registerCycleCommands(service)` for `cycle.record` targeting `{kind:'cycle',id}` and `case.record` targeting `{kind:'productionCase',id}`. Payload `{record,actor,reason}`; record fields per spec CycleRecord/ProductionCase. Revisions append actual observations/events; source exact refs remain portable. `snapshot.cycles` and `snapshot.productionCases` derive aggregates, no extra workflow orchestrator/table required.
- Local refs use registered ownerId through exporter; recording resolves local IDs and immutable native revisions in actual receipt/job/adoption/Edition records. External refs explicitly observed metadata, never invented local executions. Case trials distinguish actual/fixture/planned; classification one of accepted-example/matched-comparison/failed-trial/unobserved.

- [ ] **Step 1: Write failing tests.** Record first use/import, local derivation and adopted output, then next-cycle references; validates all actual produced/decision/output/execution refs exist at exact version. Plans cannot populate producedRefs or pretend paid execution. Unknown scores/rights remain null/unknown. One accepted example cannot be classified matched-comparison without matched trials/conditions; self-review cannot be labeled independent. Actor/reason and prior case observations preserved by events; stale CAS/replay behave normally. Library lineage/uses/cases discover records and external input links without auto adoption or canon write.
- [ ] **Step 2: RED.** Run `studio/test/asset-cycles.test.js`.
- [ ] **Step 3: Implement interfaces.** Validate reference meaning and record scope, not genre or taste. Cases store literal selected inputs/omissions and scoped observations as inert data. No rankings, global best model, generated fake perceptions or new approval gate. Existing budget/job unknown states stay authoritative; cycle record cannot change execution state. Extend read-only owner capture/export for cases/cycles.
- [ ] **Step 4: GREEN.** Focused/full suite; commit `feat(studio): record reusable production cycles and scoped cases`.

### Task 6: Independent speech, music, effects and silent timing

**Files:** Modify `studio/src/engine/{timeline,asset-slots,adoptions}.js`, `studio/src/render/{mix,closure,probe}.js`; create `studio/test/timeline-tracks.test.js`, extend `studio/test/{timeline,edition,render}.test.js` only for direct shared regressions.

**Interfaces:**
- Extends `timeline.update` payload optional `tracks` array `{id,kind:'music'|'sfx',slotId,startMs,trimStartMs?,trimEndMs?,gainDb?,fadeInMs?,fadeOutMs?,muted?}`, `sceneDurations` array `{sceneId,durationMs}`. Existing takes remain speech representation and old payloads/results valid. Bundle candidates with `reuseRole` audio-reference are reference-only; music/sfx track consumption requires the corresponding role and speech requires speech-take. Legacy candidates without reuseRole retain existing validation. `audio` profile supports silent duration.
- Non-speech audio slot uses subject role/environment and no utterance/casting requirement; explicit semantic role `music`/`sfx`. Speech validation unchanged. Reuse intent role differentiates these roles (extend Task2 inspection).
- Resolved timeline carries `tracks` with canonical frame/sample mapping and totalDurationFrames; Edition freezes selected candidate receipts/pins/bytes for all tracks. Mixed PCM uses same shared evaluator/rounding. Silent video/audio uses explicit positive duration, never invents speech.

- [ ] **Step 1: Write failing tests.** Speech + music + SFX independent selection/mute/trim/fade overlap mixes correct PCM sample values and duration; speech text mismatch still fails. Pure music scene and fully silent explicitly timed scene produce Edition and decoded WAV/MP4 of expected duration, no MISSING_AUDIO. Reject negative/NaN/unsafe duration, trim beyond actual decoded file, track referencing wrong media or scene, duplicate track IDs. Old timelines remain identical. Edit track after Edition: old bytes/closure output unchanged; backup/GC retains all receipts and tracks. Audio reused as reference never becomes speech automatically.
- [ ] **Step 2: RED.** Run `studio/test/timeline-tracks.test.js` and relevant new assertions.
- [ ] **Step 3: Implement extension.** Reuse existing audio decoder and gain/fade semantics; canonical actual durations anchor tracks. Retain old timeline behavior when additions omitted. Scene duration must cover selected content and all declared shots; intentional tails explicitly represented. Independent track assets imported/reviewed/adopted through existing commands; no synthetic TTS jobs to satisfy silence.
- [ ] **Step 4: GREEN.** Focused/full suite including actual local decode/render; commit `feat(studio): support independent sound tracks and silent scenes`.

### Task 7: Character layers, poses and timed performance

**Files:** Modify `studio/src/engine/story.js`, `studio/src/render/{closure,frame,composition,probe}.js`; create `studio/src/render/performance.js`, `studio/test/character-layers.test.js`; extend `studio/test/edition.test.js` for freeze retention.

**Interfaces:**
- Shot optional `layers` array `{id,slotId,occurrenceId?,z,anchor:{x,y},transform:{x,y,scale,rotation,opacity},keyframes?:[{frame,x?,y?,scale?,rotation?,opacity?}],poseCues?:[{frame,slotId,expression?,gaze?}],contact?:{targetLayerId,anchor:{x,y}}}`. All coordinates finite normalized layout units; frame integer relative to shot; z is explicit drawing order. Frame0 transform defaults identity/opacity1; omitted layers preserves existing one-image shot.
- Produces pure `evaluatePerformance({shot,frame}): evaluatedLayers` for layer ordering/pose selection/anchor/keyframes/contact offset; frameAt and shared drawFrame consume it. No semantic auto-rig, auto-segmentation or default style. Pose changes choose separate accepted exact image assets, which may be transparent; expression/gaze are descriptive explicit cues, only selected pose/transform is rendered.
- Closure resolves/validates all layer/pose candidate slots against occurrence identity/state and freezes assets, timeline and evaluator version. Add performance.js to renderer fingerprint. A candidate reuseRole style-reference/edit-target cannot directly satisfy rendered shot/layer selection; image consumption role must match actual scene/identity/pose use. Legacy candidates without reuseRole retain existing validation.

- [ ] **Step 1: Write failing tests.** Two independently moving transparent actors over background; pose swap and reaction transform at exact frame; z/opacity/anchor/contact positions deterministic. Different genres/styles metadata yield same technical acceptance. Reject missing/foreign occurrence, incompatible identity/state, unaccepted pose, non-finite transform, duplicate layer IDs, contact cycles/missing target and out-of-shot cue time. Preview frameAt/drawFrame and Remotion composition consume same evaluator/image set. Layer edits after Edition do not mutate old frame/hash; GC/backup retain every pose, imported manifest and derived asset.
- [ ] **Step 2: RED.** Run `studio/test/character-layers.test.js` and new Edition assertions.
- [ ] **Step 3: Implement interfaces.** Keep pure frame evaluation separate from loading/renderer. Resolve direct contact anchors in DAG order with explicit offsets; no physical animation claim. No fixed character count or named genre presets. Still-image fallback backward compatible. Multiple poses require actual accepted assets; prompts/metadata alone cannot create movement.
- [ ] **Step 4: GREEN.** Focused/full suite; locally render representative short multilayer scene and assert decoded frames/alpha composition and duration (contract/fixture evidence only). Commit `feat(studio): render layered character poses and performance cues`.

### Task 8: Public transports, usable library workflow and three-cycle acceptance

**Files:** Modify `studio/src/transport/{common,http,mcp,config}.js`, `studio/bin/{studio,studio-mcp}.js`, existing `studio/ui/*` modules/static allowlist as needed; create `studio/ui/library.js`, `studio/test/{library-transport,asset-cycle-e2e}.test.js`; modify `studio/test/{ui-components,ui-flows}.test.js` and `studio/README.md`; create `docs/reference/CREATIVE_ASSET_CYCLES.md`.

**Interfaces:**
- CLI configuration accepts explicit `--library <directory>`; configuredStudio injects openLibrary with the two built-in adapter factories and both bins close it safely. No option means Library unavailable with an actionable setup message, no automatic folder scan/registration. HTTP/MCP share same Library/Reuse facades, never expose raw store/DB/registerCommand. Library injection explicit when starting transport; public routes/tools support library commands/queries/export and reuse inspection with existing bearer/origin/host defenses. New import commands receive IMPORT_LIMIT128MiB, not normal JSON1MiB. Private locators accepted only at explicit local registration, never leaked in query/log/errors.
- UI Library panel: explicit owner/project connection, find/filter, exact-ref details including timestamp/availability/capabilities/provenance/evidence, inspect mapping+purpose, preserve import, candidate existing adoption action, per-item receipt/progress/resume. Source and asset commands retain fixed command IDs separately; partial failures preserve successful work. Add independent track and layer/pose fields to existing editors without requiring a technical JSON authoring step for common use.
- README/reference describe launch, explicit schema upgrade, bundle roundtrip, capability boundaries, three-cycle example and actual-vs-fixture evidence. Record final verification results and exhaustive SDD rulings there or in final tracked implementation note before deleting scratch workspace.

- [ ] **Step 1: Write failing transport/UI tests.** Unauthorized host/origin/token and oversized/unsupported bundle blocked; no secrets/private locator returns. Library register→refresh→find→export→inspect→import uses same receipts as direct facade. UI shows offline vs missing, normalized bytes change, mapping decisions, unsupported format; importing never auto-adopts or auto-generates. Mixed text success/image failure keeps success and retry only unfinished with same command IDs. Simple music/silent timing and two-character pose edit can be saved through UI flow.
- [ ] **Step 2: Write three-cycle E2E.** Cycle1 explicit vibelore source/public image plus independent manuscript into Studio A, adopt/select actual fixture media and record decisions/Edition. Cycle2 use Library exact old refs to Studio B with one new purpose/pose/audio derivation, record scoped fixture case (scores null, no actual-model claims). Cycle3 reexport B's result and use in a new production with new motion/music/silence choice. Remove original owner and rebuild/delete Library projection; already preserved Edition still renders from local bytes after GC and backup/restore. Assert original canon unchanged, jobs/provider invocation count zero for imports, no fixed style/genre, origin/normalization/local derivation graph correct and old outputs stable. Actual local rendered WAV/MP4 decode succeeds; costs/time reported as local test measurements, quality unobserved.
- [ ] **Step 3: RED.** Run the new transport/E2E/UI tests before adding routes/editor actions.
- [ ] **Step 4: Implement public workflow and docs.** Existing source/asset/adoption endpoints remain compatible. Every output/case links exact refs, unsupported actions disabled with reason, advisory does not create approval gate. Multi-command UI progress is persisted/recoverable per destination receipts; never global rollback of other edits. No live generation services or public publishing.
- [ ] **Step 5: GREEN.** New suites, full Studio suite, repository's existing targeted source/connector tests appropriate to files changed; `git diff --check`. Final reviewer receives whole branch from pre-implementation base. One combined fix dispatch and scoped re-review if needed. Commit `feat(studio): expose reusable creative asset cycles end to end`.

## Verification and completion

All task commits remain in the managed isolated worktree for review; no merge/push requested. Baseline and final commands/log paths, fixture-vs-real-media evidence, schema migration/backup results and remaining unsupported providers/video clip consumption are reported honestly. No claim of independently perceived artistic quality. Preserve source user changes. Final whole-branch review must cover exact-ref trust, schema/GC/backup closure, stale pins, transport security and preview/export consistency across new audio/layer inputs.
