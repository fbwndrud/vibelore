# Creative asset cycles — final independent review

Final status: accepted after both Important findings were fixed in `8eff2946`
and the single scoped re-review confirmed them addressed with no new breakage.
All eight implementation tasks passed separate spec/quality gates. No open,
parked or declined-to-judge findings remain.

The whole-branch reviewer used `gpt-6.1-sol` at xhigh reasoning after the
most-capable requested model (`gpt-6-astra`) repeatedly hit capacity during
implementation and task review. The scoped final reviewer used `gpt-6.1-sol`
at high reasoning. These are independent code reviews, not artistic evaluation.

The initial report below is retained as historical evidence; its requested
fixes are superseded by the accepted re-review that follows it.

## Initial whole-branch report

# Whole-branch independent review — creative asset cycles

Base `3a381171680859a5b1ab05e21b4cb88fda3fc58a`, head `aa8249bd`.

**Ready to merge? With fixes — two Important findings.**

## Strengths

- Library ownership remains narrow: registration generations, request sequencing, physical source identity and attached-DB transactions fence stale refresh/rebind/unregister work. Native adapters use bounded private read snapshots instead of opening sources through migration/recovery.
- Bundle identity is distinct from byte equality. Destination import reevaluates decoder output, mapped semantic pins and final CAS, then records candidate/receipt/event atomically. Replay precedes new work; import creates no adoption/provider job; manifest/raw/canonical provenance participates in GC and backup closure.
- Sound/silent durations and layers use existing timeline, acceptance, Edition and renderer paths. Exact selections and evaluator fingerprints freeze into Editions; retained roles survive derivation. The final UI role/draft fixes match the frozen consumer guards.
- Verification honestly separates actual local codec/render evidence from fixture artistic quality and unknown rights/costs. The earlier unexplained parallel renderer failure remains disclosed.

## Issues

### Critical

None found.

### Important

1. **Imported text cannot be consumed in the following reuse cycle.**

   Locations: `studio/src/source/manuscript.js:164`, `studio/src/source/export-studio-assets.js:609`.

   `source.importBundle` replaces the manuscript's `blobManifest` with incoming file roles (`selected-content` plus `preserved-bundle-manifest`). Studio export chooses a source package's selected bytes only through `kind === "original-manuscript"`. Reexport of the successfully imported text therefore has no selected-content file or selector; the next `selectedClosure` / `source.importBundle` fails `BUNDLE_INCOMPLETE`. The requested repeated text reuse breaks despite its bytes remaining available. The three-cycle acceptance reuses images after the initial text import, so it misses this interaction.

   An actual temporary SQLite/Studio probe at this head confirmed `source.manuscript` (BOM/CRLF bytes) → owner export → `source.importBundle` → reexport. Import succeeded; imported manifest kinds were `["selected-content","preserved-bundle-manifest"]`; second-export file roles were `["preserved-evidence","preserved-evidence"]`, selectedContentSha256 absent; `selectedClosure` returned `BUNDLE_INCOMPLETE: Selected root requires exactly one selected-content file.`

   Fix: preserve an explicit unambiguous selected-text designation through source import and resolve it on export, retaining exact original bytes and the full provenance closure. Cover native and imported package shapes; never select an arbitrary first unit when a native package has several texts. Add an export/import/export/import regression with exact byte and native revision assertions.

2. **Working layer preview retimes frame-based performance for non-30-fps timelines.**

   Location: `studio/ui/player.js:223` (also `:243`, `:252`, `:258`).

   `renderWorkingShot` converts pose/keyframe frames to milliseconds and scrub time back to frames using hardcoded 30, and constructs a 30-fps preview closure. The engine supports other timeline rates; frozen Edition/export uses the actual rate. A frame-30 pose/movement key in a 60-fps production is reached at 0.5 s in frozen output, while working preview shows the old pose and halfway movement until 1 s. Calling the same evaluator cannot compensate for this different clock.

   A pure read-only `frameAt` probe with a frame-30 pose/key confirmed the consequence at 0.5 s: the actual 60-fps closure selected `new` with x=0.8; the working path's 30-fps conversion selected `old` with x=0.65. This verifies the shared evaluator and statically established clock conversion, not an actual browser/media render. The existing working-shot regression checks image resolution/camera input at the default rate only.

   Fix: take fps from the owning production's current timeline, with 30 as the fallback for an untimed legacy shot, and use it in every conversion and the working closure. Add a non-30-fps working-preview regression comparing pose and movement at the same elapsed time against the frozen evaluator.

### Minor

None found.

## Coverage and alignment

Read the supplied package in bounded passes across every production area: assets/derivation/roles, slots/adoptions, exact cycle/case evidence, schema/backup/GC/recovery, Library registry/projection/query, bundle/inspection/atomic import, manuscript/source provenance, both owner adapters and bounded IO, timeline/mix/closure, geometry/composition/evaluator/fingerprints, HTTP/MCP/CLI, and durable queue/editor/working/frozen UI. The diff was not regenerated; hunk cuts were reread only for truncated output, necessary context or verified line numbers.

Read representative meaningful tests for hostile bundles/limits; native old refs, source immutability and scene webtoon exports; Library concurrency/privacy/scope; mapped identity/state/speech; final CAS/latest review; GC/raw provenance/restore; migration/rollback; truthful cases/output bindings; PCM mixing/legacy timing; actual landscape/portrait pose and alpha; transport security/destination isolation; UI role/draft persistence; and the complete three-cycle acceptance body. Focused unchanged context was checked only for selected-text package construction, native review semantics and native scene-source identity context.

The approved architecture and retained amendments are followed, including explicit unsupported video/structured consumption, required native scene webtoon export, destination-open upgrade, role retention and generic sound/layer geometry. No genre/style/paper gate was added. Both findings concern supported interactions, not new capabilities.

## Verification boundaries

- Reviewer checked the retained footer of the controller's exact-head serial run: `/tmp/creative-asset-cycles-final-studio.log`, **511/511 passed**, no failures/skips, 282570.608541 ms. No duplicate full suite or new media render was run. Green existing tests do not cover the two findings above.
- Root retained footer checked: `/tmp/task8-root-source.log`, **34/34 passed**, 49889.898208 ms. Its original invocation was lost and reconstructed, as documented; this is not claimed as an observed launch command.
- Earlier serial 508/508 and scoped UI 57/57/layer 6/6 are historical evidence. Original default-concurrency 507/508 portrait RENDER_FAILED and successful isolated follow-up remain disclosed. The underlying cause was unproven; current serial green does not establish that it was resolved.
- The text probe initially hit unchanged process-incarnation protection (`LEASE_IDENTITY_UNAVAILABLE`) in sandbox; the same isolated non-media probe succeeded with host permission and unchanged guards. Successful temporary probe stores were cleaned. The frame probe used memory only.
- No paid/live provider, install, upload, publish, merge/push, canon write, checkout/index/HEAD mutation or subagent was used. Only this report was written in the checkout. Fixture quality, external rights, provider prices and independent artistic perception are not inferred.

## Recommendations

Address both findings in the single combined fix wave. Keep existing source packages compatible and the preview on the existing timeline/evaluator path. Run source-owner/import and non-30-fps UI/layer regressions plus directly affected compatibility checks; no architecture redesign is needed.

## Declined to judge

[] — no considered behavior was set aside as outside the plan/spec. Approved unsupported features were judged as explicit boundaries; verification limits are stated above.

## Assessment

**Ready to merge? With fixes.** Ownership, preservation and execution boundaries are strong and the exact head's existing suite is green, but text reuse fails on its second hop and non-30-fps working layer timing disagrees with frozen output. Both are localized integration defects with concrete regression targets.


## Accepted scoped re-review

- **I1 — Imported text cannot be consumed in the following reuse cycle — ADDRESSED.** `studio/src/source/manuscript.js:66` pins the original byte hash as `selectedTextBlobId`; the existing import path retains this pin while replacing manifest descriptors. `studio/src/source/source-package.js:52` resolves and validates the pin against preserved text-unit blobs, falling back only to one distinct legacy text blob. `studio/src/source/export-studio-assets.js:610` uses that selector, and `:652` includes imported source-package manifest ancestry. Exact BOM/CRLF selected bytes, raw bytes, manifests, original source pins/native revisions, pre-pin native/imported compatibility, explicit second-text choice, invalid-pin rejection and ambiguous multi-text rejection are covered by the added owner regressions (`studio/test/library-owners.test.js:234`). The next import succeeds through the existing selected closure; no arbitrary first text is chosen.
- **I2 — Working layer preview retimes frame-based performance for non-30-fps timelines — ADDRESSED.** `studio/ui/player.js:218` resolves the owning scene production's timeline fps, retaining 30 only as the legacy fallback. The duration conversion, closure profile, end frame and scrub-time frame all use the resolved fps (`:229`, `:247`, `:256`, `:262`). Added DOM regressions (`studio/test/ui-components.test.js:903`) compare actual working draw selection and movement against a real frozen Edition at the same 500 ms for 60 fps, 30 fps and untimed legacy shots; an unrelated selected production is explicitly present and ignored.
- **New breakage in the fix diff:** None found. The seven-file fix remains confined to selection/provenance, working preview timing, covering regressions and verification evidence.
- **Out-of-Scope Observations:** None.
- **Checks:** Read the supplied `review-aa8249bd..8eff2946.diff` once; no regenerated diff or git mutation. Targeted context checked only the selected-text import handoff and retained ancestry hunk needed to verify I1.
- **Checks:** The fix report names the exact covering commands and outputs. Independently read retained log footers: `/tmp/creative-asset-cycles-final-fix-focused.log` reports 152/152 passed, zero failures/cancellations/skips/todo, 65341.208083 ms; `/tmp/creative-asset-cycles-final-fix-full-studio.log` reports 516/516 passed, zero failures/cancellations/skips/todo, 274163.859458 ms. Their covering tests match the changed behavior. No test rerun was needed or performed.
- **Checks:** Historical root 34/34 remains unchanged evidence; the earlier default-concurrency renderer failure remains unexplained and is not claimed resolved by this fix.
- **Checks:** Read-only review of checkout/index/HEAD; only this scratch report written. No subagents, provider calls, installs, source/canon writes, publishing or git-state changes.
- **Fix round:** All findings addressed, no new Critical/Important breakage. Open findings: none.
