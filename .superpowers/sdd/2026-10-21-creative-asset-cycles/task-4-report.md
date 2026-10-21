# Task 4 — read-only native owner adapters

Status: DONE. Base: `e2d1c6b8abfecdcd754fb120c6fd64e2a2da116e`. No provider calls, source initialization, migration, recovery, publication, or source writes. Fixtures use temporary directories and existing native/public APIs. The original checkout, oldStudio, ai-content-studio and actual canon were untouched.

## Produced interfaces and locator contract

- `studio/src/source/export-studio-assets.js`: `createStudioOwnerAdapter({locator,ownerId,allowedProjects})`.
- `studio/src/source/export-vibelore-assets.js`: `createVibeloreOwnerAdapter({locator,ownerId,allowedProjects})`.
- Both implement required `identify`, complete-snapshot `capture`, exact `exportExact`, and `verifyRefs`; no initializer is used by constructors or reads.
- **The sole accepted locator shape is `{directory: <absolute existing root>}`.** No project, work, universe, logical ID, labels, or extra connection properties. Every nonempty private locator string remains subject to the Library's recursive reflection ban. Returned DTOs/bundles carry no path or physical fingerprint.
- Studio `allowedProjects` contains exact native `projects.id` values. Every selected project must exist in the captured database. Vibelore registration represents **one existing work root OR one existing world root**; allowlist contains its exact native `workId` or `universeId`. Work and world are separate scopes/registrations, even if linked. There is no sibling scanning or invented prefix/owner ID.
- `identify()` hashes the physical source inode/device/birth-time tuple (`studio.sqlite` or `.vibelore`). It survives rename/move, changes for replacement/copy, is private, and is independent of content revisions. Library registration/rebind continues to own authorization and UUID assignment.
- Owner tokens are opaque canonical digests of observed refs/native heads, used only for equality. Capture returns full DTOs, not deltas. `cases` remains empty until Task 5.

## Source IO and consistency

`owner-io.js` shares `readOwnerBytes({directory,relativePath,expectedSha256?,maxBytes?})`, `safeOwnerPath`, physical identity and operation-local snapshots.

- Regular files only; absolute/parent traversal and source-root/descendant symlinks rejected. Platform ancestor aliases such as `/tmp` remain supported. Reads use `O_NOFOLLOW`, bounded chunks, opened-file/path identity/size/time comparison, and optional hash verification. Default **20 MiB/file**, error `BUNDLE_LIMIT_EXCEEDED`; source files are never mutated.
- Studio: bounded copies of the existing main database plus optional WAL; each has a separate **128 MiB** cap (`SOURCE_LIMIT_EXCEEDED`, at most 256 MiB captured file bytes). Identity, size, nanosecond times, and bytes are compared across the complete DB/WAL capture. Changing sets fail `SOURCE_BUSY`; per-read drift fails safely. A present rollback journal is rejected, never replayed. Partial/unsupported WAL headers/frame lengths are rejected. Only native WAL mode and schema versions 1/2 are accepted. SQLite opens **only the temp copy**, read-only, query-only, inside a transaction. Any private temp shm and other snapshot files are removed in `finally`; no source shm is created by the adapter. Native committed WAL rows are included.
- Vibelore: existing native validators/resolvers have internal `readFile` calls. They run only against a **bounded private mirror** of the adapter's declared native closure. It copies canonical surfaces needed by native drift checks, published heads/objects/registries, adopted script locks/copied assets, and completed scene workflow/image evidence. It does not scan other work roots, proposals, uploads, or arbitrary sibling storage. Each file is capped at 20 MiB; aggregate copied bytes at **128 MiB**, files at **4096**, directories at **512**, each enumerated directory at **4096 entries** (`SOURCE_LIMIT_EXCEEDED` for aggregate/count limits). Directory enumeration itself uses native `readdir`; the count is checked before traversing/copying entries.
- Original captured bytes/hash/physical identity and relevant directory memberships (including absent optional paths) are rechecked before returning. The native resolver cannot subsequently read an original path or grow its intermediate file allocation by reopening live files. Source fingerprint is checked again after the operation. Mirror cleanup occurs on success/failure. No global fs monkeypatch or existing resolver behavior changes were introduced.
- This is an operation-local stable capture with drift rejection, not a filesystem transaction or lock on native writers. A commit after the SQLite snapshot can legitimately coexist with the earlier committed observation. A continuously changing source fails and the caller may retry; no internal busy loop. The approach does not claim resistance to a malicious concurrent process that performs undetectable ABA filesystem swaps. Main/WAL rereads and mirror rechecks bound normal concurrent-writer acceptance; no source recovery or backup API is called.
- `registry.js` narrowly adds `SOURCE_BUSY` and `SOURCE_LIMIT_EXCEEDED` to sanitized adapter errors, as explicitly authorized. Raw native errors/paths are still not exposed by the facade.

## Native refs and exact exports

All refs retain `{ownerId,projectId,recordKind,recordId,revision}`. No `latest`, current-head substitution, hash-based identity merge, or foreign approval inheritance.

| Source | recordKind / recordId | exact revision | Export behavior |
| --- | --- | --- | --- |
| Studio immutable candidate row | `candidate` / native candidate ID | `canonicalDigest(native data_json value)` | Actual required registered blobs; canonical selected-content; raw/decoder/pins retained |
| Studio event SourcePackage | `sourcePackage` / native aggregate ID | native `sourceDigest` | Full portable native pins; original-manuscript selected bytes where present |
| Studio Edition | `edition` / native aggregate ID | native `closureDigest` | Native closure plus all actual required blobs |
| Studio completed Edition output | `editionOutput` / native aggregate ID | native `manifestDigest` | Exact output manifest and output selected bytes; containing closure digest retained as evidence |
| Other retained Studio events | `assetReview`, `editionReview`, `editionPublication`, `reuseImport` / native ID | canonical digest of exact event value | Structured native receipt/decision evidence, not artistic proof |
| Studio schema2 reuse receipt table | `reuseImport` / native receipt UUID | canonical digest of exact native receipt | Preserved manifest/file map, external roots, local candidate mapping |
| Vibelore committed chapter | `chapter` / decimal native chapter number | native publication HEAD | Exact committed readable chapter bytes, publication/scope pins; byte-level drift rejected |
| Vibelore adopted script | `sceneScript` / native scriptId | native scriptRevisionId | Readable adopted script, sealed lock pins |
| Work sealed context doc | `document` / native doc ID | native productionLockId | Only actual selected sealed document text |
| Published world context doc | `document` / native doc ID | native lore content revision ID | Published visibility=context exact bytes, including retained published ancestors when explicitly requested |
| Native asset in world or copied work | `asset` / native assetId | native assetRevisionId | Exact approved/catalogued bytes, native universe/catalog/lore pins, actual states |
| Published world state logical view | `state` / native state ID | native containing lore content revision ID | Structured ID/entity/storyScope evidence; no automatic document payload closure |
| Completed vibelore scene webtoon | `webtoon-scene` / native workflowId | native productionRecordHash | Completed workflow/image/plan/preflight/review/source checks, exact final candidate image |

Studio nested state refs are **logical views, not invented aggregate rows**: `recordKind='state'`, actual native state ID, revision `canonicalJSON({kind: containingKind, id: containingId, revision: nativeRevision})`. Native revision is `String(event aggregate revision)` for story, exact `sourceDigest` for SourcePackage. This distinguishes identical nested state IDs/revisions in different source containers. Original pins remain separately in `sourcePins`/`nativeRecord`. Historical nested state refs are not advertised as independently exportable Studio aggregates.

Candidate subject/state and speech metadata are resolved from their **exact retained event pins**. Missing pinned evidence fails, never consults newer HEAD. `audioBinding`, exact effective `speechPerformance` and characterless `speakerStateRefs` follow the Task 2 inspector contract. No identity, state, voice equivalence, or speaker approval is inferred.

Reexport walks local candidate ancestors and retained imported manifest provenance. Foreign records/links remain historical references; only actual root runtime closure is required. Original normalization receipts/raw/canonical/decoder evidence survives. A canonical PNG already consumed by Studio is selected as PNG on the next export; it does not become a newly normalized-from record merely because an earlier import normalized JPEG. The real regression uses an upstream JPEG bundle, native normalization, directory export/import to another Studio, explicit adoption, local crop derive, then reexport while the original source is offline.

## Disclosure and public capability notes for UI

**Published world archive versus selected production is a required distinction.** An explicitly registered world is `temporalScope='published-world-archive'`: individually selected public docs/states/assets coexist as archival choices, with no selected current point or winner. Two timeline states can coexist. Exporting one state/asset does not include another state's document bytes. Actual state mapping is required before using archive evidence in a current production. World archive records are never concatenated into current narrative context.

Work scripts use `temporalScope='sealed-scene-scope'`; canonical chapters use `committed-chapter`. Only native adopted/sealed selected state scope supplies associated context. `resolveWebtoonSource`'s unrestricted current world/character snapshot is never exported. Author-only, unpublished, unselected future/state documents and unsynced readable edits are omitted/rejected, with omissions in bundle disclosure. Private author bytes needed by native drift validation exist only in the bounded mirror and do not become DTOs.

A work's copied approved world asset is observed under that work owner's UUID and retains native universe/asset provenance. A separate registered world remains a separate owner. When several adopted scripts contain the exact same native asset Ref+bytes, capture emits one asset entry and distinct `uses` to each exact script; export retains all source scope observations/pins. Subject state refs are observed sealed choices (`subjectScope='observed-sealed-scopes'`), never a merged current canonical state. Conflicting bytes/media under the same Ref fail `SOURCE_CORRUPT`. No unrelated scope text/bytes are added to the selected asset's runtime closure.

- Studio available entries advertise discover/preserve/inspect; text/image/audio also derive. Missing/corrupt historical required bytes remain discover-only. No entry advertises render. Video/structured records are preservation/reference evidence, not an implemented video renderer/consumer.
- Vibelore content records advertise discover/preserve/inspect/derive; structured state choices advertise discover/inspect only. These flags do not waive bundle limits, selected-content requirements, role/state mapping or destination inspector decisions. A structured logical view is metadata inspection, not a standalone playable/importable asset.
- **Deprecated cut-based `webtoonPlan` / `webtoonReferences` / `webtoonRender` manifests are explicitly unsupported.** New `lore_webtoon_scene` outputs are supported. This task does not claim legacy panel migration/import.
- Old script/webtoon revisions lacking retained native approving lock/workflow evidence fail `SOURCE_MISSING`; no guessed historical approval or HEAD fallback. Retained published world ancestors and retained Studio immutable events are supported. Chapter export currently requires the current verified native publication/readable bytes; an unavailable older chapter publication is not substituted.
- No arbitrary expression entities, comparative artistic evaluation, case classifications, or external authority are invented. Remaining `cases`/expressions are deliberately empty extension points.

## Task 5 interface inventory and extension seams

Use the existing read-only snapshot boundary. Do not openStudio/recover/migrate source or introduce a second runner. Native rows/events below are real source surfaces; adding case projections must define honest exact revision handling and portable disclosure.

- `generation_candidates(project_id,id,attempt_id,data_json)`: immutable candidate ID, canonical/raw blobs, validation/decoder, pins, target/slotIntent, recipe, audio binding, local/external lineage and preserved manifest. Already projected/exported as above. Candidate presence does not imply adoption or observed quality.
- `generation_jobs(project_id,id,intent_key,data_json)`: mutable job contains native `id`, `intentKey`, `variationNonce`, `generationInputDigest`, request, subscribers, attemptIds/currentAttemptId, status. Not yet projected. Never conflate subscriber/dedup attachment with independently generated trials.
- `generation_attempts(project_id,id,job_id,status,fence,data_json)`: native attempt ID, jobId, immutable request/requestDigest/generationInputDigest at creation, worker/operation/provider IDs, status/outputs, createdAt, retry/duplicate-charge evidence. Mutable status rows are not retained historical revisions by themselves. `generation_outbox` and `budget_reservations` contain dispatch/amount/settlement evidence; `outcome_unknown` remains unknown, not failed/successful. These remain Task 5 extensions, not invented Task 4 record kinds.
- `asset_adoptions(project_id,id,data_json)`: immutable server-issued decision UUID, slotId, action, candidateId, previousCandidateId/previousAdoptionId, undoOf/restoredDecisionId where present, actor/reason/reviewRevision and actual take provenance. Not yet independently projected. `assetSlot` event/aggregate references current candidate/adoption and pins; use historical events for prior revisions, never current slot as historical proof. Adoption is user selection, not independent review/artistic success.
- `assetReview` events: native aggregate ID (candidate ID) and exact value history; already exported under canonical digest. `editionReview`/`editionPublication` native IDs/values similarly available; retained actor/decision/reasons do not establish evaluator independence.
- `reuse_imports(project_id,id,reuse_key,data_json)`: server UUID, commandId, bundleSha256, originRefs, localCandidates `{candidateId,slotId,source}`, localManifestBlobId, fileMap with source/canonical normalization, intentDigest, actor/reason. Already projected as exact receipt and `uses` external input → local candidate with receiptRef. Preserved bytes remain owner blobs; Library does not own them.
- `sourcePackage` / `edition` / `editionOutput`: above native ref/revision contracts are ready for case context/consumer anchors. Full portable native record is retained in `metadata.nativeRecord` and `sourcePins`; do not replace sourceDigest/closureDigest/manifestDigest with a generic revision or mutable title.
- Vibelore work `uses`: native copied asset/sealed doc → actual adopted `sceneScript` exact ref. Each shared asset retains distinct historical scope observations. World archive states have no inferred current-production use. Webtoon visualReview is retained as source observation, never foreign approval inheritance.
- `capture` already returns `{token,entries,links,uses,cases}`. Task 5 can append honest cases/cycle observations using existing native IDs, exact refs, explicit literal input/context/trials/unknowns. Persistent case records, comparison honesty/classification, and any new receipt projections belong to Task 5 rather than fabricated Task 4 placeholders.

## RED/GREEN evidence

All runs from the isolated worktree with host permission and Node 24. No install or weakened lease/incarnation checks. Full command prefix:

```sh
NODE_NO_WARNINGS=1 /Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test studio/test/library-owners.test.js
```

| Evidence log in /tmp | Result | Actual failing behavior / subsequent coverage |
| --- | --- | --- |
| task4-red.log → task4-green-initial.log | 0/5 → 5/5 | Missing adapters/shared safe reader; real schema1/2 sources, scope, identity and read-only tree hashes |
| task4-red-next.log → task4-green-next.log | 5/9 → 9/9 | Rollback journal ignored, selected manuscript absent, canonical native source absent |
| task4-red-domain.log → task4-green-domain.log | 9/12 → 12/12 | World archive, sealed adopted scope/copied assets, completed native scene webtoon absent |
| task4-red-reexport.log → task4-green-reexport.log | 12/15 → 15/15 | Foreign ancestry/audio binding missing; Edition portability failure; actual directory/JPEG/derive workflow |
| task4-red-history.log → task4-green-history.log | 18/19 → 19/19 | Exact retained world ancestor unavailable; concurrent snapshot/facade/symlink regressions included |
| task4-red-bounded.log → task4-green-bounded.log | 19/21 → 21/21 | Missing bounded mirror; oversized native context reached old resolver before read cap |
| task4-red-limits.log → task4-green-limits.log | 21/23 → 23/23 | Partial WAL accepted; Edition output used closure digest instead of output manifest digest |
| task4-focused.log | 24/24 | Added exact nested state container collision regression; 13226.711667 ms |
| task4-full-studio.log | **455/455**, 0 fail/skip | Full Studio command below; 85453.013542 ms |
| task4-red-shared-asset.log | 0/1 | Two actual adopted scripts produced duplicate immutable asset refs (2 !== 1) |
| task4-green-shared-asset.log | 24/24 | Scoped exact-ref/content merge with historical observations |
| task4-red-shared-uses.log | 0/1 | Shared native asset lacked two distinct adopted-script uses |
| task4-final-focused.log | **24/24**, 0 fail/skip | Final scoped shared-use fix plus all owner tests; 12935.653625 ms |

The last two RED commands used `--test --test-name-pattern='sealed script owner' studio/test/library-owners.test.js`. The full-suite result precedes only the final localized shared-native-record/uses fix and public unsupported-route note. Controller explicitly approved final focused verification without a redundant full rerun. Full command:

```sh
NODE_NO_WARNINGS=1 /Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test studio/test/*.test.js > /tmp/task4-full-studio.log 2>&1
```

Meaningful verification includes full original source tree hashes before/after, active committed WAL, concurrent writer/coherent snapshot, in-operation source replacement, symlink escapes, size/hash/schema failures, no-store creation refusal, archive state isolation/author omission, sealed assets after world offline, canonical byte drift, retained old native refs, actual local Edition render, and no calls to actual external providers. Test fixtures invoke native public/core store APIs. Existing installed Prettier was used only on the four new JS files. `git diff --check` passed.

## Self-review, files, and remaining limits

Self-review corrected native Edition output digest, partial WAL handling, exact state container identity, source mirror allocation boundary, and shared native asset observations/uses. Formatting expanded dense safety/disclosure/ref/reexport logic. The main remaining limits are explicit above: bounded source sizes, optimistic drift detection, unavailable historical approving proof, unsupported deprecated panel route, and no Task 5 cases/jobs/adoption projection yet. No known blocker within the agreed Task 4 scope.

Task files: three new `studio/src/source/{owner-io,export-studio-assets,export-vibelore-assets}.js`, new `studio/test/library-owners.test.js`, the two-code whitelist addition in `studio/src/library/registry.js`, and this report. Parent plan edits are excluded from the task commit. Existing source connector/native core/reuse importer were not modified.
