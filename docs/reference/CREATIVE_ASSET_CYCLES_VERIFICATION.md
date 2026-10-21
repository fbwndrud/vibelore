# Creative asset cycles — implementation decisions and verification

This note preserves controller decisions and reproducible evidence after temporary
SDD notes are removed. Work was isolated in the managed creative-asset-cycles
worktree. No paid/live providers, installs, uploads, publishing, merges/pushes,
credential changes, real canon or real `.vibelore/` modifications occurred.

## Verification status

Baseline supplied by the controller: 351/351 Studio tests before implementation;
Task 7 final baseline 496/496. Original Task 8 implementation completed before a
model-capacity interruption after final test launch. Recovery inspected existing
processes/logs and finalized documentation/verification without redesigning code.
Fresh task and whole-branch reviews remain controller owned; implementer
self-review is not independent artistic evaluation.

Initial implementation (`6c3a55c3`) full-suite status: complete serial follow-up passed 508/508 (exit 0),
301435.307667 ms. The original default-concurrency run passed 507/508; its
unexplained renderer failure and successful isolated follow-up remain below.

All commands use Node 24:
`/Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`,
with `NODE_NO_WARNINGS=1`, host permission for existing process-incarnation lease
checks and actual installed Chrome/FFmpeg rendering. No lease checks were weakened.

- Transport RED: `--test studio/test/library-transport.test.js`,
  `/tmp/task8-transport-red.log`, 0/3 (missing public configuration/routes).
- Transport first GREEN: same arguments, `/tmp/task8-transport-green4.log`,
  3/3, 2610.920791 ms.
- Native timing/layer and mixed queue RED: `--test --test-name-pattern='resumable mixed|native silent|native two-character' studio/test/ui-flows.test.js studio/test/ui-components.test.js`,
  `/tmp/task8-ui-red.log`, 0/3; GREEN `/tmp/task8-ui-green2.log`, 3/3,
  783.9975 ms.
- Native sound-file/Library DOM: `--test --test-name-pattern='native WAV import|Library DOM' studio/test/ui-components.test.js`,
  RED `/tmp/task8-ui-library-red.log` 0/2 (missing native sound-role control;
  normalization test corrected to actual hash DTO); GREEN
  `/tmp/task8-ui-library-green.log`, 2/2, 629.006709 ms.
- Actual three-cycle acceptance: `--test studio/test/asset-cycle-e2e.test.js`,
  initial `/tmp/task8-cycle-red.log` 0/1 (decoder helper success DTO correction),
  `/tmp/task8-cycle-green1.log` 0/1 (foreign exact refs require explicit observed
  scope), `/tmp/task8-cycle-green2.log` 1/1, 36025.405709 ms. These initial E2E
  failures were fixture/contract corrections, not new renderer defects.
- Expanded focused `/tmp/task8-focused1.log`: 78/78, 40250.086917 ms. Later
  public UI/transport `/tmp/task8-focused-final.log`: 76/76, 12585.501208 ms.
- Destination isolation regression: `--test --test-name-pattern='queue destination identity' studio/test/library-transport.test.js`,
  RED `/tmp/task8-destination-red.log` 0/1 → GREEN
  `/tmp/task8-destination-green.log` 1/1, 1897.616417 ms.
- Silent shotless Edit regression: `--test --test-name-pattern='silent scene without any shot' studio/test/ui-components.test.js`,
  RED `/tmp/task8-silent-editor-red.log` 0/1 → GREEN
  `/tmp/task8-silent-editor-green.log` 1/1, 352.676333 ms.
- Original default-concurrency full command: `--test studio/test/*.test.js`,
  `/tmp/task8-full-studio.log`, 507/508, 147546.227666 ms. One failure:
  `actual short multilayer MP4 decodes exact pose frame, movement and transparent alpha composition`
  at `studio/test/character-layers.test.js:473`; portrait `edition.render`
  returned `status:failed,errorCode:RENDER_FAILED`. Existing error sanitization
  retained no specific underlying cause, so no causal attribution is claimed.
  Three-cycle acceptance passed in the same run (127833.412417 ms).
- Exact failed-render follow-up: `--test --test-name-pattern='actual short multilayer MP4' studio/test/character-layers.test.js`,
  `/tmp/task8-layer-render-isolated.log`, 1/1, 23710.223792 ms. Both landscape
  and portrait actual decode/pose/alpha assertions passed without code changes.
- Final complete serial follow-up: `--test --test-concurrency=1 studio/test/*.test.js`,
  `/tmp/task8-full-studio-serial.log`: 508/508, 301435.307667 ms, exit 0. No separate
  root test or renderer ran concurrently. This rerun follows an actual unresolved
  render failure; the earlier failure is retained rather than hidden by retry.
- Root source/connector log `/tmp/task8-root-source.log`: 34/34, 49889.898208 ms.
  Its original launch text was lost at capacity interruption. The invocation is
  reconstructed from retained suite names as `--test test/publication-unit.test.js test/shared-lore-extension.test.js test/shared-lore-mcp.test.js test/shared-lore.test.js test/working-tree-sync.test.js`;
  this is not claimed as an observed exact command.
- Final `git diff --check`: clean, exit 0.

## Review fix round 1 — layer roles and durable structural drafts

The independent Task 8 review found two editor issues at `6c3a55c3`: retained
reference-only/identity-only images appeared in unsupported baseline/pose choices,
and structural add/remove actions bypassed the form's durable draft hook. The fix
changes only `studio/ui/performance.js`, its actual-DOM component regressions and
this note. No engine, renderer, provider, source adapter or transport changed.

The baseline selector now follows the existing consumer: marked character images
allow identity-reference/pose; marked environments allow environment-reference/
final-scene. Explicit pose switches allow marked pose only. Derived candidates use
their retained `candidate.reuseRole`; no-marker native images retain existing
identity/state/adoption checks. Existing invalid choices remain visibly disabled
with an explanation, unavailable add-layer/add-pose actions are disabled with
reasons, and a new cue chooses a supported image instead of copying an identity-
only baseline. Every add/remove layer, movement or pose action dispatches a
bubbling input event after redraw so the existing form saves its draft and CAS.

All commands below use the Node 24 executable and `NODE_NO_WARNINGS=1` specified
above. These are final scoped checks for this editor-only fix; the earlier 508/508
full-suite and media evidence predate it. The controller explicitly scoped this
round to UI and relevant layer tests, so full rendering/full-suite runs were not
repeated.

- Regression command: `--test --test-name-pattern='layer editor separates|layer editor disables|structural layer' studio/test/ui-components.test.js`.
  Correct RED `/tmp/task8-fix1-red2.log`: 0/3, 1922.224125 ms; failures showed
  style-reference remained selectable, no-pose add action stayed enabled, and
  structural persistence count stayed 0. The first RED attempt
  `/tmp/task8-fix1-red.log` had two native fixture STALE_BASE errors (derivation
  requires an already adopted base); that setup was corrected before production
  edits, and is not claimed as editor-failure evidence. First GREEN attempt
  `/tmp/task8-fix1-green.log` exposed conditional null native-DOM appends; the
  implementation was corrected without relaxing assertions. Final GREEN
  `/tmp/task8-fix1-green2.log`: 3/3, 1775.004209 ms, exit 0.
- Complete UI suites: `--test studio/test/ui-components.test.js studio/test/ui-flows.test.js`,
  `/tmp/task8-fix1-ui.log`: 57/57, 11876.836083 ms, exit 0. Regressions use
  actual import/derive/adopt commands and DOM form submissions, check supported
  baseline/pose roles and disabled invalid selections, and recover all six
  structural edits after rerender while preserving the original scene CAS.
- Relevant layer contracts: `--test --test-name-pattern='scene validates explicit layer|owner exports actually accepted pose|retained image roles|missing acceptance|preview readiness|native role-bound image' studio/test/character-layers.test.js`,
  `/tmp/task8-fix1-layers.log`: 6/6, 9198.333708 ms, exit 0. Exact role retention,
  identity/state/occurrence and acceptance guards remain unchanged.
- Final `git diff --check`: clean, exit 0. No new contract concern was found.
  The initial default-concurrency render failure remains the separately disclosed
  limitation above; no new causal claim or renderer change was made.

## Whole-branch final fixes — repeated text reuse and working preview timing

The final independent review at `aa8249bd` found two Important integration defects:
imported text lost its selected-content designation on reexport, and working layer
preview converted frame-based performance at 30 fps even for other timeline rates.
This combined fix retains the existing source/import/evaluator paths.

New manuscript packages pin `selectedTextBlobId` to exact preserved text-unit
bytes; export emits the existing portable `metadata.selectedContentSha256`.
Existing native and imported packages without that pin remain usable when their
text units identify exactly one distinct preserved blob. Multiple texts never
select the first manifest entry: they need an explicit pin. Invalid pins fail
validation. Reexport also includes the imported text's original bundle records
and links as historical evidence while preserving its original manifest/raw bytes
and source pins. No existing package, native revision or schema is rewritten.

Working preview resolves fps from the owning scene's current production timeline,
uses it for all frame/millisecond conversions and its preview closure, and keeps
30 fps for untimed legacy shots. An unrelated selected production cannot change
that clock. DOM regressions compare actual component draw selection/movement at
500 ms with a real frozen Edition: 60 fps selects the frame-30 pose and x=0.8;
30 fps and untimed legacy controls retain their earlier pose and x=0.525.
This checks the actual evaluator/drawing boundary, not browser pixels or artistic
quality. The covering existing layer tests also render and decode local MP4s.

All commands use the exact Node 24 executable and `NODE_NO_WARNINGS=1` above, with
host permission for unchanged process-incarnation/lease and local renderer guards.

- Regression RED: `--test --test-concurrency=1 --test-name-pattern='native manuscript text survives|native text packages never|working layer preview' studio/test/library-owners.test.js studio/test/ui-components.test.js`,
  `/tmp/creative-asset-cycles-final-fix-red.log`: 2/5 pass, three expected failures,
  4743.566292 ms. Text reexport failed `BUNDLE_INCOMPLETE`, multiple native texts
  chose the first, and the 60-fps DOM preview selected the old pose at 500 ms.
- Regression GREEN: same arguments,
  `/tmp/creative-asset-cycles-final-fix-green2.log`: 5/5, 4235.654625 ms, exit 0.
  The first attempt passed all behavior checks but included an actively used
  nested restore destination's WAL in the source inventory; the restore fixture
  was moved outside the source root. Explicit second-text selection, invalid-pin
  rejection and pre-pin native compatibility are covered in the focused run.
- Focused source-owner/import/GC-backup/UI/layer command:
  `--test --test-concurrency=1 studio/test/source-package.test.js studio/test/library-owners.test.js studio/test/reuse-import.test.js studio/test/ui-components.test.js studio/test/ui-flows.test.js studio/test/character-layers.test.js`,
  `/tmp/creative-asset-cycles-final-fix-focused.log`: 152/152, 65341.208083 ms,
  exit 0. Exact BOM/CRLF bytes, native revision/source pins, two-hop text import,
  legacy package compatibility, preserved raw/manifests after GC/backup restore,
  and actual landscape/portrait layer render/decode passed.
- Final complete Studio command:
  `--test --test-concurrency=1 studio/test/*.test.js`,
  `/tmp/creative-asset-cycles-final-fix-full-studio.log`: 516/516,
  274163.859458 ms, exit 0; no failures/cancellations/skips/todo. It ran alone,
  with no concurrent root suite or other media probes, after all product/test edits.
  Root code was unchanged, so the historical 34/34 root evidence was not rerun.

The earlier unexplained default-concurrency renderer failure remains disclosed;
serial green does not establish its cause or resolution. No paid/live provider,
install, upload, publishing, merge/push, auth change, real canon write or real
`.vibelore/` initialization/migration/recovery was performed. Existing 38 recorded
controller rulings below remain unchanged. Self-review is not independent review.

## Final local media evidence

The earlier Task 8 serial-suite three-cycle run (before the review fixes recorded in this note) wrote `/tmp/task8-three-cycle-evidence.json` (local workflow time 56673.079084 ms, including four actual MP4 renders plus WAV). These scratch artifacts are not committed; the observed hashes/timings are preserved here. All MP4s are 0.5 seconds, 15 H.264 frames at 30 fps, 1280×720, with AAC stereo 48 kHz; video/audio decoding and profile checks passed.

| Artifact under `/tmp/` | Bytes | SHA-256 | Local render ms |
| --- | ---: | --- | ---: |
| `task8-cycle1.mp4` | 9573 | `670fd9546abaa6389e95d71f42ecdb74be11d311e48c52870a70113feb6d9ce3` | 13704.743541 |
| `task8-cycle2.mp4` | 9192 | `74bccfdd84f1a7d83edd93fc6241a3471fa206b9f41e2ea8fb656bbfe7ddd8fe` | 11872.415750 |
| `task8-cycle3.mp4` | 19538 | `44c0fd85df97c415a81ea592b4a810cd1b400d93b08359c9e80155548f7ff80b` | 11159.977584 |
| `task8-restored.mp4` | 19538 | `44c0fd85df97c415a81ea592b4a810cd1b400d93b08359c9e80155548f7ff80b` | 9590.958125 |
| `task8-cycle3.wav` | 96044 | `7af76f45b3057fd7915cd1a63c38e02bacb9a49c77037cdbbd7b5074c694475b` | included above |

Cycle C and the restored render share exact closure digest `c0dea3fbec7b7091f5851df16e1ec99435e7aa80574cbf1e5df52fe4936d90b6` and equal MP4 bytes. The native WAV also passed a real FFmpeg decode. Source fixture canon digest remained `6c26a82084c7db5e1e0c8687291622b23adffef44faf0b6e462555ced47bc783`; original source inventory and prior Edition values were unchanged.

The two project stores and three productions used actual local SQLite, bundle/import/adoption/derivation/Edition/GC/backup code and installed codecs with diagnostic fixture media. The explicitly scoped case retains null scores and unknown rights. Provider invocations and import jobs are both 0; provider charges were not invoked, and artistic quality remains unobserved. Local wall time measures this host run, not provider cost or audience perception.

## Recorded controller rulings

The following decisions retain their original rationale and tradeoffs. They are
architectural decisions, not claims of independent evaluation or current external
service capabilities.

1. Ruling: Bundle outer records are closed schemas, but metadata/sourcePins are inert portable JSON (sourcePins object or array, evidenceRefs OriginRef[]). Reject recursive private locator/path keys and explicit executable/fetch instruction keys; domain executionRefs/commandId and literal text or citation URLs remain data — spec preserves flexible creative context without treating it as execution authority — overly broad key rejection would lose provenance; overly narrow rejection risks private location leakage, covered by Task1 tests.

2. Ruling: source.importBundle selects the sole unambiguous text root and rejects multiple text roots; mixed image roots remain separate asset commands — first payload deliberately has no source selector and must not choose by array order — multiple-text-root transfers need a future explicit selector or separate bundles. Task2 documents shared record metadata/sourcePins convention for Task4 exporters rather than independent incompatible interpretations.

3. Ruling: Interoperable selected-record metadata uses mediaKind, roles[], subjects:SubjectRef[], native audioBinding and portable speechPerformance; selected-content is the sole directly required file with that descriptor role. Purpose stays arbitrary nonempty text; consumed role uses explicit image/audio capability roles (identity-reference/pose/environment-reference/final-scene/style-reference/edit-target; speech-take/audio-reference/music/sfx), unknown requested role unsupported while extra source labels remain data — source and consumer need a shared semantic contract without genre restrictions — first implementation uses exact advertised role matching, no implicit families; exporters may advertise multiple actually supported roles explicitly.

4. Ruling: Compare cross-project speech by mapped subject/state, exact text/language/voice and portable effective performance excluding local linkage IDs; preserve native binding/pins separately. Native performanceDigest includes speaker/addressee/response local IDs, so raw equality is invalid across owners. Shared projection excludes id,sceneId,holdMs,speakerOccurrenceId,addresseeOccurrenceIds,responseTo — permits timing-only reuse while retaining actual acting/text — future richer relational-performance reuse may need explicit relation mapping rather than these inert historical links.

5. Ruling: Keep existing pinned WAV decoder byte-preserving; test normalizationChanged=false for WAV and true for changed image normalization rather than alter decoder to force a test difference — established exact byte behavior is authoritative and spec requires truthful normalization evidence — later decoder versions must make new canonical artifacts explicitly.

6. Ruling: source.importBundle productionId is optional intended-use provenance; if provided, validate existing production again at final commit, but never create/rebind/rebase it — existing source.import/manuscript only create immutable source packages and the new command must preserve ownership of binding decisions — UI must use existing production.create/rebase separately; no hidden side effect from import.

7. Ruling: Mapping requirements follow consumed role: identity/pose uses map the intended subject/state; a final-scene environment slot can map multiple source subjects to distinct real authorized destination scene/shot identities/presentations; unbound style/audio-reference preserves source subject history without asserting equivalence — blanket mapping every subject to one slot identity/null would incorrectly forbid multi-character webtoon reuse and pure references — no source subjects may be erased and no reference may silently become exact speech/identity/render approval. Task2 adds real two-character and reference-use tests.

8. Ruling: Imported candidate retains reuseRole from inspected selection; later exporters and render consumers honor it. Style/audio references are preserved as references, not promoted to rendered scene/music/speech by byte/slot shape — existing resolveShots accepts any adopted image, so without this marker cross-task semantics would be lost — legacy no-marker candidates keep old checks; Task6/7 own consumer guards, Task4 reexport retains roles. Plan/briefs updated before those tasks.

9. Ruling: Exact speech evidence identifies the actual source speaker: native audioBinding.characterId/roleBindingId and castingStateRef stay native; character subjects/stateRefs.recordId must map to actual destination speaker/presentation, not another pictured subject. Characterless source→characterless destination narration uses no fabricated identity, still requires exact text/language/performance/voice; one-sided missing identity cannot claim compatibility — existing narrator roles are first-class — future role-identity conversions need an explicit adaptation.

10. Ruling: Stateful characterless narration uses optional metadata.speakerStateRefs:OriginRef[] belonging to explicit native audioBinding.roleBindingId when characterId===null. Native castingStateRef must match its own speakerStateRefs.recordId and explicit stateMap to destination casting state; missing evidence needs_decision, other depicted subjects cannot supply it. Character speakers always use their own SubjectRef.stateRefs and ignore this extra field — existing cast supports stateful narrator roles without character identity and should not require fabrication — Task4 must export exact native role-state pins; this remains open record metadata, no new roleMap/identity model.

11. Ruling: OwnerAdapter identify():Promise<string> supplies opaque private physical-source fingerprint pinned at successful register; capture/export check before and after, replacement OWNER_REPLACED retains old observations as unverified. Rebind requires nonempty confirmRefs and verifyRefs(refs):Promise<boolean> plus fresh identify before generation increment. Copies always get fresh UUID. Initial offline registration may explicitly fail; established offline owners retain observations — registry must distinguish real source replacement without deriving semantic IDs from path/hash — source fingerprint method is internal and never portable.

12. Ruling: Library uses are destination observations: uses.ref may be external input, usedIn (and receiptRef if supplied) must belong to publishing owner+allowed project. derived/normalized/adapted links anchor local from; used-in/observed-in links may have external from but local consumer/case to. Every claim has authorized local anchor — destination B owns its observed use of A, source A need not be live or know B — rejecting external input refs would erase cross-owner use discovery. Task3 tests ownerB-only projection returning uses(Aref).

13. Ruling: Library registry+projection consistency uses ATTACH with DELETE journals and BEGIN IMMEDIATE across generation/sequence validation, projection replacement and receipt; read transaction spans both DBs. Source adapter IO occurs outside transactions — cross-handle/process stale refresh must not publish after newer refresh/unregister — projection remains rebuildable separate file, not a new asset authority.

14. Ruling: Library ProductionCase projection allows optional classification (accepted-example/matched-comparison/failed-trial/unobserved) and optional local exact ref alongside illustrative spec fields — design §9/Task5 require honest categories and later case navigation needs native revision — Library validates shape/ownership only, Task5 owns semantic evidence validation, no inferred quality score.

15. Ruling: LibraryEntry.subjects may preserve valid external SubjectRef identity context; only entry.ref and usage/case anchoring endpoints require local registered owner+allowed project — canonical/original identity provenance can belong to another owner without granting new source IO — no automatic registration, identity merge or source access from metadata. Task3 adds validator regression; full425/425 before this isolated fix and focused after, final branch full later.

16. Ruling: owner.rebind accepts optional explicit allowedProjects (default current) so later cycles can add/remove project scope while preserving source ownerId, with same CAS/nonempty exact confirmRefs/adapter verification and generation increment — new projects shouldn't require fabricating a new source owner solely to expand user-selected scope — no discovery or implicit scope expansion, prior refs/receipts remain historical.

17. Scope-change refinement: public owner-local find/cases/lineage/uses anchors filter current allowedProjects; excluded local inspect is entry:null/status:unverified, export PROJECT_NOT_ALLOWED. Old snapshots/refs/commands remain private historical records. Rebind generation invalidates current observation until refresh; destinationB's allowed receipt may still reference excluded sourceA as historical context, never source re-access. No global revocation/deletion.

18. Ruling: Every nonempty string-valued locator component is private connection data, and full fingerprint occurrences are private even when embedded. Public project/work/language/source-kind selection must not be encoded as private locator values; built-in Task4 locators use directory/connection location with public native work/project selection from allowedProjects — arbitrary opaque/relative connection strings must not leak just because they lack '/' — accidental public/private value overlap can reject export, so interfaces separate those fields rather than exempt secret values.

19. Ruling: Vibelore adapter locator is one existing work OR world root {directory}; allowedProjects uses exact native workId/universeId, separate registrations for separate roots, no invented IDs/sibling scans. Work exports use adopted/sealed/native approved scopes, never current whole-world snapshot that may contain future/author-only docs; explicit omissions. Work-owned observed world artifacts retain native universe provenance, not an invented external Library UUID — source surfaces have distinct native authority — unsupported/unpublished sources stay truthful, no auto-publication.

20. Ruling: Studio source SQLite uses operation-local bounded stable copy of DB+optional WAL and opens only temp copy readOnly, so source -shm/read marks are untouched. Verify complete-set bytes/identity/size before/after, reject mixed/racing/rollback-journal unsupported state, bounded retry; original physical file dev/ino/birthtime identifies owner. Separate source snapshot byte cap with honest SOURCE_LIMIT_EXCEEDED/SOURCE_BUSY safe error whitelist (narrow registry.js addition allowed) — standard SQLite readOnly may still touch source sidecars — temporary sidecars are local scratch and cleaned, no source recovery/migration.

21. Ruling: Explicit published world root is a published-world-archive with no selected current point. All native visibility=context published state docs/approved assets may be individually discovered/exported with exact state refs; author/unpublished omitted. Never merge every state into current narrative context or auto-select a state; destination reuse still maps actual state. Work/scene exports remain selected-state and omit unselected future/author context — UniverseStore has no universal 'current' and labels child/adult/future docs all context, so timeless-only export would unnecessarily forbid required stateful asset reuse — archive scope must be visible; selected asset export must not bring other-state document text/bytes without runtime dependency.

22. Ruling: Source candidate selected-content is actual native canonical output, with pre-normalization raw retained separately. Preserving source PNG creates no new normalized-from claim; new normalization only when destination changes selected bytes, while existing native/receipt normalization history remains — hash change evidence must describe actual stage — Task4 uses real prior JPEG bundle normalization→derive→reexport test rather than false foreign link.

23. Ruling: Native nested state may have logical OriginRef recordKind state and recordId actual native state ID without inventing a standalone state aggregate. Studio revision is opaque canonical tuple containing actual enclosing kind+ID+native revision/sourceDigest, raw enclosing Ref retained in sourcePins; Vibelore may use exact containing lore content revision within native universe/state scope — same stateID and same numeric revision in distinct source containers must not merge — standalone export is only claimed if that logical view is actually supported. Task4 collision test covers distinct native containers.

24. Ruling: Native vibelore resolvers run on an operation-local bounded mirror of only their declared source closure, copied with shared no-symlink/hash/size readers, privately relocating copied connection metadata only; original files/identity/relevant directory membership rechecked before publication. No global fs monkeypatch or source store opening/recovery — stat preflight followed by unbounded native reads would not bound concurrent file growth or replacement — costs temporary local copying and explicit aggregate limits; false SOURCE_BUSY/limit is preferable to mixed/private export. Historical retained-world ancestor traversal remains required, never HEAD substitution.

25. Ruling: Native lore_webtoon_scene production/image export is required; deprecated cut-based webtoonPlan/webtoonReferences/webtoonRender publication manifests remain explicitly unsupported, without claimed migration/completeness. Exact old scene-script/webtoon refs lacking retained native approving workflow/lock evidence fail SOURCE_MISSING, never HEAD fallback — repository instructions reserve deprecated route for existing work completion and Task4 requires real current scene asset coverage — historical cut-based samples can be recorded as scoped observations, but automatic legacy transfer is unavailable.

26. Ruling: BundleRecord.metadata.selectedContentSha256 is optional exact per-record consumer selection, canonically hashed with record. Inspector validates SHA syntax, direct requiredFileSha256s membership and matching selected-content descriptor; absence retains legacy strict one selected-content rule. Exporters emit it for actual selected root bytes, historical records losing runtime files also lose selector. All preserved raw descriptors/bytes remain, no duplicate hash records/schema-number change — global descriptor role alone cannot express shared preserved/consumed bytes in multi-root bundles — narrow backward-compatible metadata/inspector contract amendment, with malformed/out-of-root and legacy ambiguity regressions plus base+crop actual import tests and fullsuite.

27. Ruling: Cycle/case persistence accepts local exact native refs {projectId,recordKind,recordId,revision} without ownerId; read-only exporter qualifies current registered ownerId. Actual local produced/decision/output/execution refs must resolve an existing exact current-project version. Full external OriginRefs stay explicit observed input/context/previous-cycle metadata, never local execution/production claims or automatic source access — Studio does not own Library registry UUID and must support local records before registration — source adapter must retain local/external distinction and reject misleading claims, no global owner setting. Job/attempt retention proposal pending existing event coverage audit.

28. Ruling: Mutable generation job/attempt rows lack retained full native historical versions. Cycle/case record may resolve exact current row digest or identical previously retained evidence and freeze observation-time nativeEvidence append-only in its event; exporter can project current rows and retained observed versions. No writer instrumentation/new runner/job mutation; unobserved old revisions fail. outcome_unknown remains unknown — actual observed snapshot is honest evidence, unlike retroactively inventing missing native events — full private row may be retained locally, but portable export exposes scoped IDs/status/digests/output refs/explicitly selected literal inputs and declares omitted request/prompt/private data, never claiming complete provider request or proof of payment/completion.

29. Ruling: Independent track startMs is owning-scene-relative for scene/shot-scoped slots, production-global for explicit production/project-scoped slots. Scene ownership must be in selected scenes/production; production scope must match, project scope explicit current-project choice. Scene spans placed sequentially; explicit positive sceneDuration covers speech, scene tracks and declared shots, inferred otherwise from actual content. Global BGM may bridge scenes/extend production tail with total duration covering it. No silent trimming; omitted new fields preserve exact legacy global speech results — existing slot scopes should support both scene effects and production-wide music without arbitrary scene restriction — UI must label time basis, tests cover two scenes/global BGM/wrong scope.

30. Ruling refinement: legacy utterance fixedStartMs/fixedEndMs/anchor/offset remain production-global even with new scene spans; only new track.startMs is scope-relative. Scene spans constrain actual placement, never reinterpret old fields; empty additions preserve exact legacy schedule. Shared ceil frame boundaries for adjacent fractional spans while sample positions remain exact — additive timing must not silently alter existing authored anchors — cross-scene and partial-duration regressions required.

31. Ruling: global audio tail preserves all declared scene-span cuts and only extends final default shot as last-shot hold. Explicit final-shot overrides must themselves cover tail or user extends explicit scene span; no silent redistribution/truncation/gap — longer BGM should not retime earlier shots — costs explicit timing correction for insufficient authored overrides, tested two-scene tail/fractional visual boundaries. Implementation waits currentfull finish before code/focused/finalfull changes.

32. Ruling: Explicit shot.layers is complete visual stack; omitted layers preserves legacy single-image/camera path. Images contain-fit preserving aspect, anchor normalizedimage point aligns same normalizedcanvas anchor at base; transform.x/y are normalized translation offsets (0/0 identity), rotation radians clockwise, scalepositive/opacity[0,1], finite offscreen/anchor values allowed. Contact overrides baseanchor with target transformed image-local contact.anchor plus own x/y offset, DAG order, no inherited target rotation/scale. Frozen layout width/height supplies aspect-correct pure geometry; poses keep anchor stationary across aspect changes. Existing camera applies once to whole composed stack after layer evaluation, preserving authored camera instead of ignoring it — identity defaults and existing shot semantics must remain coherent in generic layered workflow — costs shared outer camera composition/tests on nonsquare canvas, not a new genre/style rule.

33. Ruling: Task7 uses real existing studio/render/frame.js and composition.jsx, not nonexistent planned src/render equivalents; no duplicate shim. Narrow renderer/Edition/probe/HTTP/player integration required for multi-image preview is authorized; Task8 retains actual layer/pose editor and Library UI — repository concrete renderer locations outrank erroneous plan path shorthand — costs broader but necessary preview/fingerprint file surface, covered by shared evaluator/real media tests and review.

34. Ruling: Character baseline layer may consume retained identity-reference or pose with exact local identity/state/occurrence/adoption checks; explicit poseCue requires pose. Background environment-reference/final-scene, style/edit refs stay reference-only through derive. Actual accepted explicit character/pose use may supply pose export role, never resemblance — baseline identity portrait is a valid identity use, blanket pose-only would add unnecessary constraint — consumers distinguish baseline identity vs cue pose.

35. Ruling: Native Studio image role default follows actual resolved subject identity: a character role-binding advertises identity-reference like direct identity; characterless/environment remains environment-reference. Retained reuseRole/imported receipt roles never rewritten. Unconsumed character-role reference is not pose until actual accepted explicit use proves it. Preserve genuine prior/effective roles and native mapping/pins; do not manufacture an observed historical environment role from an old fallback algorithm — code default incorrectly treated all indirect subjects as environment, blocking valid character baseline reuse — narrow source role correction with regression, no image resemblance or broad owner redesign.

36. Ruling: Task8 third cycle may reexport/reuse B actual derived pose/image result in new production; final MP4 remains preserved/reference (video clip consumption future/unsupported). Two projects with three productions/cycles meets spec, no invented thirdparty video renderer — whole result includes reusable production assets as well as final output — limits explicit; actual final clip is still rendered/decoded and localclosure preserved.

37. Ruling: Durable UI queue key binds opaque SHA256 domain-separated destination physical owner identity plus projectId, not origin/project alone; configured CLI supplies bootstrap.destinationKey. Programmatic HTTP injection without supplied key gets ephemeral random isolation — same localhost port/project name can point to a replacement store and must not replay prior unfinished commands — opaque identity must reveal no locator; ephemeral programmatic default loses restart resumability, explicitly documented/tested.

38. Ruling: Explicit destination opening with new Studio CLI performs existing schema1→2 migration; no extra upgrade opt-in flag. Stop old executor and backup first, document old executor refusal of2 and irreversible version transition, never migrate read-only source registration — binding contracts §192 defines explicit opening as upgrade boundary, and Task2 tested this behavior — costs user-visible upgrade on deliberate destination open, mitigated by accurate usage/backup instructions rather than new unplanned authority.

## Completion and independent review

All eight planned implementation tasks completed and passed their independent
spec/quality gates. The whole-branch review raised exactly two Important findings
(text second-hop selection and non-30-fps working preview); both were fixed in
`8eff2946` and accepted by the single scoped final re-review. No open, parked or
declined-to-judge findings remain. The [retained review](../superpowers/reviews/2026-10-21-creative-asset-cycles.md)
preserves the original findings, coverage, verification limits and final verdict.

Final product code: `8eff2946`. Final complete Studio run on this exact code:
`NODE_NO_WARNINGS=1 /Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-concurrency=1 studio/test/*.test.js`,
**516/516 passed**, no failures/skips, 274163.859458 ms,
`/tmp/creative-asset-cycles-final-fix-full-studio.log`. Focused amended-code
checks: **152/152 passed**, 65341.208083 ms,
`/tmp/creative-asset-cycles-final-fix-focused.log`. Root source/connector evidence
remains **34/34**; root code did not change in the final fixes. The earlier
unexplained default-concurrency renderer failure remains a documented limitation.

Only documentation and temporary-plan-record cleanup follow the verified product
commit; no product/test code changes after the final run. The isolated managed
worktree is preserved on detached HEAD for user review and integration choice.
The plan-specific scratch directory is removed only after all 38 decisions above
and the final independent reports have durable tracked copies. Sibling scratch
workspaces and the source checkouts remain untouched.
