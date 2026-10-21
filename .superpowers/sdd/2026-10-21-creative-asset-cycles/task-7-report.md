# Task 7 — Character layers, poses and timed performance

Status: DONE; final focused and full Studio validation passed. Base: `c431e6bfb29392faa7d928ab98a2e92ad3c5864a`. Only `/Users/lyoojk/.codex/worktrees/creative-asset-cycles/vibelore` was edited. No installs, new providers, paid requests, uploads, credentials, source initialization, actual canon or real `.vibelore/` changes occurred. Real local SQLite, PNG, WAV, Chrome/Remotion and FFmpeg fixtures were used.

## Produced UI/command contract for Task 8

Use the existing `scene.put` command and scene aggregate CAS. A shot optionally declares the entire explicit layer stack:

```js
{
  id, // existing shot fields and shot.transform camera remain supported
  layers: [{
    id, slotId, occurrenceId?, z,
    anchor: {x, y},
    transform?: {x?, y?, scale?, rotation?, opacity?},
    keyframes?: [{frame, x?, y?, scale?, rotation?, opacity?}],
    poseCues?: [{frame, slotId, expression?, gaze?}],
    contact?: {targetLayerId, anchor: {x, y}}
  }]
}
```

`layers` omitted keeps the existing single-image `referenceSlotId` shot and its cover fit/camera behavior. Explicit `layers` is a nonempty full stack; the engine does not implicitly add `referenceSlotId` underneath. Layer IDs are unique within the shot; each finite `z` explicitly defines draw order, with equal-z layers retaining declaration order. No character-count, genre or style preset is imposed.

Each actor layer needs an explicit `occurrenceId` belonging to this scene, with `presence: 'onscreen'`. Every baseline and cue slot must be an accepted local image in project/production/scene/shot scope, match the occurrence's exact identity (or role binding) and presentation appearance state, and retain the actual adoption receipt. Environment layers omit `occurrenceId`; an environment image cannot impersonate an occurrence. `scene.put` validates declarations, geometry, local references and contact DAGs. `edition.create` additionally resolves actual accepted candidates, decodes metadata, validates cue/keyframe bounds against the final shot duration, checks composed finite geometry for every shot frame, and rechecks selections/CAS before committing the immutable Edition.

Role boundaries use the existing enum names. A retained character baseline can consume `identity-reference` or `pose`; an explicit pose cue requires retained `pose`. Environment/background layers accept `environment-reference` or `final-scene`. A legacy single-image character shot can consume `identity-reference`, `pose` or `final-scene`; environment shots accept environment/final-scene roles. Retained `style-reference`/`edit-target` cannot satisfy any rendered selection. Legacy candidates without `reuseRole` keep native validation. Import/inspection/adoption remain separate explicit commands.

All coordinates are finite normalized layout units, with offscreen positions and anchors permitted. Omitted transform properties default to `{x:0,y:0,scale:1,rotation:0,opacity:1}`. `scale` must be positive, `opacity` lies in `[0,1]`, and positive radians rotate clockwise. Base image fit is contain with aspect preserved. The image's local fractional `anchor` aligns to the same fractional canvas point; `transform.x/y` add canvas-relative translation offsets. Pose aspect changes keep this anchor fixed. Keyframes are shot-relative nonnegative safe integer video frames, strictly increasing and less than shot duration. Each specified property interpolates linearly from its frame-zero base value independently, then holds its final value. A keyframe at frame zero overrides that base value. Pose cues are discrete and switch exactly at their frame; expression/gaze remain descriptive strings and do not deform or regenerate pixels.

Contact anchors are target-image-local fractions. The target's contained/scaled image geometry and rotation locate that point in canvas pixels; the follower's own image anchor is placed there plus the follower's explicit `transform.x/y` offsets. Contact dependencies resolve in DAG order even when draw order differs. The follower retains its own rotation/scale/opacity; it does not inherit a target rig. Existing shot camera interpolation applies once to the completed stack, after all per-layer evaluation; captions remain in their existing canvas space.

Silent scenes continue to use Task 6's explicit `timeline.update.sceneDurations`/accepted sound timing. No synthetic speech take is created. `previewReadiness` now checks all baseline/cue image slots and retained roles and accepts positive saved resolved silent timing. Its result retains `ready/audio/images/scenes/utterances` and adds boolean `timed`; missing images still identify the owning scene/shot. This remains guidance: `edition.create` is authoritative for adoption, identity/state, media and timing validity. The existing working-shot canvas resolves saved layer/cue candidates and metadata before shared frame evaluation; no new layer-authoring forms were added in Task 7.

## Pure evaluator and frozen/public fields

`studio/src/render/performance.js` exports:

```js
PERFORMANCE_VERSION = 'layers-v1'
evaluatePerformance({shot, frame}) // pure; frame is shot-relative
performanceImageIds(shots)          // unique base + every cue blob ID
```

The evaluator consumes a validated/resolved shot with `layout: {width,height}` and a baseline `layer.selection` plus `poseCue.selection`, each providing `blobId` and decoded `metadata.width/height`. It returns ordered layers:

```js
{
  id, slotId, occurrenceId, z,
  anchor: {x,y},
  transform: {x,y,scale,rotation,opacity}, // evaluated canvas anchor position
  size: {width,height},                  // scaled image size / canvas dimensions
  blobId,
  expression?, gaze?                    // latest explicit pose cue only
}
```

For an omitted layer stack it preserves the legacy result `[{blobId: shot.blobId}]`. It does no I/O, loading, adoption, mutation, semantic rigging, segmentation, image generation, or style inference. Invalid composed finite geometry throws `INVALID_INPUT`.

Frozen layered shots retain authored layer/cue fields, `sceneId/startFrame/endFrame`, exact layout dimensions, and selections shaped as:

```js
{
  blobId, candidateId, slotId, adoptionId, metadata,
  candidate, // complete immutable native candidate, pins and reuse provenance
  slot,      // exact local slot declaration/current adoption reference
  adoption   // actual acceptance receipt
}
```

Layered Editions add `closure.performanceVersion: 'layers-v1'`. Existing `closure.assets` includes each actual baseline/cue use, while recursive `blobIds` retains raw/canonical images, source manifests, normalized/derived assets and parent evidence. `performance.js` is included in the video renderer fingerprint. Both `frameAt` and `drawFrame` use the one pure evaluator; working/frozen browser preview, renderer asset serving and Remotion composition use the same complete `performanceImageIds` inventory. The existing HTTP static allowlist serves that exact module. Edition preparation/CAS and working-change detection cover every baseline/cue adoption.

## Export/import role evidence and provenance

The Studio owner adapter reads its existing operation-local read-only snapshot. Native direct identities and native role-bound images with an actual pinned character identity advertise `identity-reference` before consumption; a native characterless role/environment stays `environment-reference`. Retained imported `reuseRole` remains authoritative, so historical imported role claims are not silently rewritten.

An actual accepted character-layer/pose use in a frozen Edition can advertise `pose` for a native image or retained identity reference. Evidence matches candidate ID, canonical blob ID, slot ID and a real local adoption receipt; no pixel resemblance or foreign approval supplies it. The exported metadata retains exact identity/state SubjectRefs and adds `poseUses: [{editionId,closureDigest,shotId,layerId,occurrenceId,slotId,adoptionId}]` plus `previousRoles: [effective prior role]`. Native record/source pins and imported reuse receipts preserve the original role/provenance. Already retained `pose` remains pose. A merely accepted but unconsumed portrait remains a reference.

Local `asset.derive` retains inherited reuse roles/provenance, with reference-only style/edit markers taking priority across protected-edit parents; derivation cannot erase a reference marker to bypass rendering roles. The cross-project test exports an actually accepted two-pixel pose, inspects/imports it into a second real project with exact identity/state mapping, explicitly adopts it, crops to a distinct one-pixel derived pose through the existing integer-pixel crop API, adopts that derivative, freezes it, runs GC, backs up/restores, and verifies parent/derived/manifest bytes and the whole frozen Edition.

## Validation provenance

The original architecture implementer stopped at a model-capacity error. Its code was already dirty in this isolated worktree; this recovery continued it and did not restart completed stages. The following old log summaries were directly read, but their exact original shell command strings were not available, so they are not reconstructed as if newly executed:

- `/tmp/task7-red1.log` 0/1 → `/tmp/task7-green1.log` 1/1: shared evaluator/frame behavior.
- `/tmp/task7-red2-fixed.log` 1/2 → `/tmp/task7-green2b.log` 2/2: declarations, frozen selections and timing validation (original `red2.log` fixture was corrected).
- `/tmp/task7-red3.log` 0/1 → `/tmp/task7-green3b.log` 1/1: accepted native pose export/import.
- `/tmp/task7-focused2.log`: 69/69, 19293.563667 ms. `/tmp/task7-red4.log`: 0/1, readiness failure left active at interruption.

Recovery-stage exact test commands all used the following prefix, in the isolated worktree, with host permission for the existing `ps` lease-incarnation checks and local render runtime:

```sh
NODE_NO_WARNINGS=1 /Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
```

Executed command arguments and logs:

1. `--test --test-name-pattern='reference-only roles|preview readiness' studio/test/character-layers.test.js > /tmp/task7-recovery-red4-role.log 2>&1`: 0/2, reproducing readiness and baseline role boundary failures. The same arguments to `green4-role.log` yielded 1/2; the remaining failure was a newly extended test reading `manifest` instead of the actual `bundle` DTO.
2. `--test --test-name-pattern='reference-only roles|working shot resolves|drawFrame uses' studio/test/character-layers.test.js studio/test/ui-components.test.js > /tmp/task7-recovery-preview-red.log 2>&1`: 1/3; reproduced raw-layer working-shot crash. Two subsequent fixture fixes supplied explicit null appearance state and used `exported.bundle`. The renamed selection `--test --test-name-pattern='retained image roles|working shot resolves|drawFrame uses|preview readiness' studio/test/character-layers.test.js studio/test/ui-components.test.js > /tmp/task7-recovery-preview-green2.log 2>&1` passed 5/5, 3490.691 ms.
3. `--test --test-name-pattern='native role-bound' studio/test/character-layers.test.js > /tmp/task7-recovery-native-role-red.log 2>&1`: 0/1, native role-bound image incorrectly advertised environment-reference. The subsequent `--test --test-name-pattern='native role-bound|owner exports|retained image roles' studio/test/character-layers.test.js > /tmp/task7-recovery-native-role-green.log 2>&1` had 2/3 passing; the remaining added two-pixel crop fixture used fractional units where the existing crop command requires integer pixels. The final focused run below verifies that corrected fixture.
4. `--test --test-name-pattern='finite inputs' studio/test/character-layers.test.js > /tmp/task7-recovery-geometry-red.log 2>&1`: 0/1; finite individual geometry could overflow after rectangle composition. The evaluator now validates all composed corners; final focused/full runs cover the correction.
5. Focused command: `--test studio/test/character-layers.test.js studio/test/edition.test.js studio/test/render.test.js studio/test/reuse-import.test.js studio/test/ui-components.test.js studio/test/http.test.js`. `/tmp/task7-recovery-focused1.log` had 106/107 and `/tmp/task7-recovery-focused-final.log` 108/109; only aspect-dependent alpha fixture sample expectations failed. Portrait contain geometry legitimately overlaps the blue and half-alpha green actors. Sample positions were checked against the already-decoded local files, and the final assertions separately test alpha over white and the correct cyan overlap.

Final exact commands and results:

```sh
NODE_NO_WARNINGS=1 /Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test studio/test/character-layers.test.js studio/test/edition.test.js studio/test/render.test.js studio/test/reuse-import.test.js studio/test/ui-components.test.js studio/test/http.test.js > /tmp/task7-recovery-focused-final2.log 2>&1
# 109/109 passed; 0 failed/cancelled/skipped/todo; 54924.683292 ms
NODE_NO_WARNINGS=1 /Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test studio/test/*.test.js > /tmp/task7-recovery-full.log 2>&1
# 496/496 passed; 0 failed/cancelled/skipped/todo; 97343.863875 ms
```

No implementation changed between the final focused pass and full pass; no separate focused render process ran concurrently with the full-suite run. `git diff --check` passed. Scoped commit message: `feat(studio): render layered character poses and performance cues`.

Local render evidence is fixture/contract evidence only: actual two transparent PNG actors independently move over a background; the selected blue pose changes exactly at frame 10; a camera translation wraps the stack once. Real H264/AAC landscape (1280×720) and portrait (720×1280) outputs each contain 15 decoded frames and last 0.5 seconds. FFmpeg decodes frames 0, 9 and 10 and numerical RGB assertions check motion, alpha, pose switch and z composition above the caption gradient. Latest local artifacts: `/tmp/task7-layers-{landscape,portrait}.mp4` and frame-10 PNGs. Both frame-10 PNGs were also opened for visual inspection: contain bounds, the camera shift, selected pose, alpha overlap and draw order matched the numeric checks. These are diagnostic solid-color fixtures, not claims of artistic or acting quality.

The already installed Prettier 2 CLI at `/Users/lyoojk/.claude/plugins/cache/mattpocock/mattpocock-skills/1.2.3/node_modules/prettier/bin-prettier.js` formatted new/dense Task7 code with `--trailing-comma all` and the existing file's quote style; unrelated lower player formatting was restored. No formatter/package install occurred.

## Self-review, limits and handoff

Self-review checked actual role enums (`final-scene`, correcting the interrupted draft's nonexistent `whole-scene`), character identity versus explicit pose-cue role, native role-binding pins, state/scope/acceptance boundaries, interpolation and discrete pose timing, aspect-correct contact rotation, composed finite geometry, camera application once, complete image loading, stale selection/CAS coverage, full frozen receipts, and retained import/derived blobs through GC/backup. The old Edition's serialized closure/digest and frame result remain unchanged after layer/keyframe/cue edits; every old closure blob remains readable.

Deliberate limits: contact is explicit geometric docking, not physics; expression/gaze text does not animate a face; movement needs explicit transforms and actual accepted pose assets. No layer authoring UI, automatic rig/segmentation, new renderer/provider, arbitrary content fetch, genre/style preset or hidden pose inference was introduced. Saved working-shot preview has its existing landscape composition canvas; final frozen/exported layouts use their exact selected profile. Positive scale only is supported. Geometry checking evaluates every shot frame, so cost grows with authored duration/layer/cue count; no fixed character count was added. Browser readiness is guidance and final Edition validation remains authoritative. No known remaining Task 7 blocker after the 496-test full pass. This is implementer self-review; fresh independent review is dispatched by the controller.
