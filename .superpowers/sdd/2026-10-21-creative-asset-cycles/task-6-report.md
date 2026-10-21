# Task 6 — Independent speech, music, effects and silent timing

Status: DONE; final focused/full validation passed. Scoped commit contains only the Task 6 implementation, tests and this report. Base: `81d937d3ab43db56154a59e1f6a064fac2843793`. Only the managed creative-asset-cycles worktree was edited. No installs, paid/live provider calls, uploads, credentials, source initialization, actual canon or real `.vibelore/` changes.

## Produced command/DTO contract for Task 8

Existing speech remains `timeline.update.payload.utterances` and resolved `takes`. The optional additions are:

```js
{
  productionId, fps?, sceneIds?, utterances?, cues?, shots?,
  tracks: [{
    id, kind: 'music' | 'sfx', slotId, startMs,
    trimStartMs?, trimEndMs?, gainDb?, fadeInMs?, fadeOutMs?, muted?
  }],
  sceneDurations: [{sceneId, durationMs}]
}
```

The optional independent slot declaration field is **`audioRole: 'music' | 'sfx'`**. It is accepted by the existing `asset.import` / reuse inspection / `candidate.adopt` slot paths, stored in the actual slot and native candidate `slotIntent`, and included in slot identity comparison. It requires audio media, no utterance binding, and a role/environment subject. Neither an utterance nor resolved casting voice is required for independent sound. There is no new generation runner or synthetic speech job. Existing speech binding/text/performance/language/voice checks are retained.

For a newly imported native sound, declare `audioRole` and explicitly adopt the returned candidate before track selection. For a bundle candidate, the retained `reuseRole` must equal the selected track's kind; an older unbound slot without `audioRole` is supported when the candidate's actual retained role supplies it. A conflicting declared slot role fails. `audio-reference` is never a music/SFX track or speech take. `speech-take` cannot be adopted as unbound sound. Candidate imports/reviews/adoptions continue through the existing commands; import never adopts automatically.

Omitted additions **and explicit empty arrays** retain the exact legacy resolved DTO and global speech schedule. Nonempty additions opt into scene spans. UI should omit both additions or send empty arrays when editing only existing speech. Do not populate silent spans from an invented speech take.

### Time bases and duration display

- A scene-scoped slot's `track.startMs` is relative to that selected scene's start. A shot-scoped slot also uses its owning scene's start, **not** the shot's start. The scene/shot must belong to the selected production and selected scene set.
- A production-scoped track uses production-global `startMs`; its production must match. A project-scoped track uses production-global `startMs` and must explicitly name the current project's slot. No project scan or implicit selection occurs. Such tracks can cross multiple scenes and extend a production tail.
- Existing speech `fixedStartMs`, `fixedEndMs`, `anchor`, and `offsetMs` retain their existing production-global meanings. They are never silently rebased to scene time. A fixed or anchored speech take starting before its newly constrained scene fails `TIMING_CONFLICT`. Default speech remains sequential, now starting after the preceding selected scene span. The cross-scene regression uses an explicitly 6000 ms first scene and a second take anchored at the prior global utterance end +1000 ms, with global fixed bounds 6000–7000 ms.
- Scenes are ordered by `sceneIds` (or existing scene order). `sceneDurations` may be partial. Each explicit duration is the scene's entire positive span and must cover all actual speech, local trimmed tracks, and declared shot cues. Without an explicit duration, actual scene content anchors its end. A silent scene requires positive explicit duration unless actual selected global audio supplies the last scene's duration; multiple empty scenes cannot invent an allocation from BGM alone.
- Global music/SFX is not forced inside explicit scene spans. Total production duration covers the later of the selected scene spans, all tracks and supported cue timing. An explicitly selected global track is itself the explicit production tail. UI should show scene span separately from **production total**, and label `startMs` as scene time or production time according to the actual slot scope.
- Default video cuts remain distributed within each actual scene span. If a selected production/project track extends a tail beyond explicit scene spans, only the final default shot holds through `totalDurationFrames`; earlier scene cuts do not move. An explicitly timed final shot is never stretched: incomplete full-production coverage fails `TIMING_CONFLICT`. Extend the declared final scene/shot timing or remove that override to use the default hold. The two-scene regression verifies cuts `0–15, 15–30, 30–45, 45–90` frames for two explicitly 1-second scenes plus 3-second global BGM; a short explicit final shot is rejected. Fractional 110 ms +110 ms scenes verify gapless visual cuts `0–2, 2–4, 4–6, 6–7` at 30 fps.

All new millisecond values are finite/nonnegative and bounded to one hour; positive scene duration must resolve to at least one 48 kHz sample. New total spans are also bounded to one hour. Duplicate track IDs/duration scene IDs, wrong scope/media/role, unknown scenes, unsafe numbers, full/over-trim and overlong fades are rejected. `gainDb` defaults to 0, must be finite, and converts through `10 ** (gainDb / 20)` with the existing linear maximum gain 4. `muted` is boolean and defaults false. `trimStartMs` and `trimEndMs` are **amounts removed from the beginning/end**, matching existing speech trim semantics, not absolute source endpoints. Both default to 0.

### Resolved and frozen data

With nonempty additions, `resolved` retains existing `fps/sampleRate/takes/cues/durationSamples/durationFrames` and adds:

```js
{
  tracks: [{
    // Original track intent, defaults/effective evaluator fields, exact selected refs
    id, kind, slotId, startMs, sceneId: 'owning scene' | null,
    scope, candidateId, adoptionId, blobId, frames, sampleRate,
    trimStartSamples, trimEndSamples, gain, gainDb, mute, muted,
    fadeInMs, fadeOutMs,
    timeBasis: 'scene' | 'production',
    startSample, endSample, startFrame, endFrame
  }],
  scenes: [{sceneId, startSample, endSample, startFrame, endFrame, explicitDuration}],
  totalDurationFrames // equals the existing durationFrames alias
}
```

Track order remains the caller's order. Times use decoded canonical WAV frame counts/sample rates, not requested length or filenames. Trim amounts round at the actual source sample rate; remaining length and absolute start round to 48 kHz samples. Sound/take starts use nearest video frame and ends ceil. Contiguous **scene boundaries use the same ceil frame boundary**, preventing fractional-duration gaps/overlaps. Output PCM pads to the final video frame, exactly as existing speech output.

Both speech and independent tracks pass through the same take sample evaluator and existing mixer resampling/stereo conversion/gain/fade/limiter logic. Muting changes samples, not the selected track span. The WAV output is actual stereo PCM16 at 48 kHz, and the video path muxes/fully decodes actual H264/AAC MP4. Existing probe behavior suffices; `probe.js` was not changed.

Edition includes independent assets and freezes `closure.soundSelections[] = {trackId, candidate, slot, adoption}`. The complete actual immutable candidate retains native pins, selected/raw bytes, reuseRole/provenance; `adoption` is the actual acceptance receipt, not an inferred success claim. Existing `assets`, timeline references, recursive blob inventory, manifest/file maps, backup and GC retain all sound evidence. Later timeline edits do not change old closure bytes or output; the regression renders the old Edition after editing the working tracks and compares actual PCM output bytes, then backs up/restores and reads every frozen blob and both reuse receipts.

## Native export and reuse honesty

The Studio owner adapter advertises music/SFX only from an actual selected native timeline or frozen Edition track **matching candidate ID, canonical blob ID, slot ID and the real adoption receipt**, or from a candidate's retained `reuseRole`. The query stays inside the adapter's existing operation-local read-only database snapshot. No `openStudio`, initialization, recovery, source writes, live provider calls, filename heuristic or arbitrary-WAV-to-music conversion was added. Even an accepted native slot labelled `audioRole: music` advertises only `audio-reference` until actual selected native track evidence exists.

The regression exports actual native selected music and SFX roots, inspects and imports each into a second real local project, explicitly adopts each, resolves/mixes/freezes them, and verifies retained roles and receipts. Music also exercises the preexisting unbound slot shape without the new field. Separate evidence shows an unconsumed WAV exports `audio-reference`, remains that role after reexport, and fails attempted speech or music/SFX consumption. No provider calls/jobs are used.

## Scope

Core changes: `studio/src/engine/{timeline,asset-slots,adoptions}.js`, `studio/src/render/{mix,closure}.js`, `studio/src/source/export-studio-assets.js`, and new `studio/test/timeline-tracks.test.js`.

Necessary narrow integrations beyond the brief's named files:

- `studio/src/assets/commands.js`: an unbound audio import reports `speechVerification: not_applicable`; bound speech retains `unverified_import`. This preserves truthful native metadata for actual non-speech audio.
- `studio/src/reuse/inspect.js`: an explicitly declared independent slot role must match the requested consumption role. Source advertised roles and exact speech validation remain authoritative.
- `adoptions.js` exposes its existing receipt reader for the complete frozen sound-selection receipt. No second receipt model was created.

No source schema/table version changes, dependency installs, new providers, source opening changes or actual work/canon mutations were needed.

## TDD and validation evidence

Runtime for every test command: `NODE_NO_WARNINGS=1 /Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`, host permission for existing ps-based lease checks/local renderer. Logs are outside the repo. Focused render runs and full runs were never overlapped.

1. Initial RED: `--test studio/test/timeline-tracks.test.js`, `/tmp/task6-red.log`, **0/6 passed**, 2561.723541 ms. PCM tracks were ignored and sound roles/silence unsupported. The first video fixture also tried to remove existing speech through `scene.put`; that fixture was corrected to create a genuinely silent scene via normal public commands before GREEN.
2. First focused GREEN: `--test studio/test/timeline-tracks.test.js studio/test/timeline.test.js studio/test/edition.test.js`, `/tmp/task6-focused-second.log`, **24/24 passed**, 19026.085458 ms; includes actual local silent MP4 decode.
3. Compatibility RED: `--test --test-name-pattern='empty sound|partial scene|fractional scene|unconsumed audio' studio/test/timeline-tracks.test.js`, `/tmp/task6-compat-red.log`, **2 passed / 2 failed**, 2201.794875 ms. Caught unwanted empty-array scene rebasing and round/ceil disagreement at a fractional adjacent scene boundary. Same selection after correction: `/tmp/task6-compat-green.log`, **4/4 passed**, 2191.445958 ms.
4. Legacy retained-role RED: `--test --test-name-pattern='native track use' studio/test/timeline-tracks.test.js`, `/tmp/task6-legacy-role-red.log`, **0/1 passed**, 1002.3985 ms. Caught rejection of a retained music-role candidate using an old unbound slot shape; corrected without authorizing reference-to-track conversion.
5. Expanded focused GREEN: `--test studio/test/timeline-tracks.test.js studio/test/timeline.test.js studio/test/edition.test.js studio/test/reuse-import.test.js studio/test/library-owners.test.js`, `/tmp/task6-focused-green.log`, **82/82 passed**, 37322.994625 ms, zero failures/skips. Actual pure music and silent WAV/MP4 outputs, PCM numerical values, preserved role boundaries, exact speech contracts, real native export/import, frozen output/receipt/blob backup/GC included.
6. First full GREEN before final-tail refinement: `--test studio/test/*.test.js`, `/tmp/task6-full-studio.log`, **482/482 passed**, 103078.943791 ms, zero failures/skips/cancellations. No concurrent focused renderer ran.
7. Final self-review RED: `--test --test-name-pattern='scene spans schedule|legacy Edition asset' studio/test/timeline-tracks.test.js`, `/tmp/task6-tail-red.log`, **0/2 passed**, 3967.790667 ms. Caught unwanted retiming of earlier last-scene cuts across global BGM tail and inadvertent deduplication of the legacy per-use Edition asset inventory. Both were corrected; old inventory order/duplicates remain unchanged, independent track selections are appended before visual uses. The extended scene test also validates actual fractional visual closure coverage and explicit final-shot override rejection.
8. Final focused GREEN after the tail/inventory corrections: same expanded focused command as step 5, `/tmp/task6-final-focused.log`, **83/83 passed**, 43833.92175 ms, zero failures/skips/cancellations. Includes the exact global tail cut assertion, rejected explicit short final shot, fractional visual coverage and preserved legacy per-use asset inventory.
9. Final full GREEN after all final code/coverage corrections: `NODE_NO_WARNINGS=1 /Users/lyoojk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test studio/test/*.test.js`, `/tmp/task6-final-full-studio.log`, **483/483 passed**, **103131.700667 ms**, exit 0, zero failures/cancellations/skips/todo. No overlapping separate focused render run. No code was changed during either full run.
10. `git diff --check` and final staged `git diff --cached --check` passed. Scoped commit message: `feat(studio): support independent sound tracks and silent scenes`.

## Self-review / concerns

The TDD skill audit confirms tests use the pre-agreed public command/resolver/mixer/owner adapter/restore boundaries and actual temporary SQLite/files/decoders, without mocking internal collaborators. Initial Task 6 brief explicitly authorized these seams and the initial multi-test RED. Reviewed exact scope/role authorization, source read-only snapshot boundaries, global vs scene-local time, actual decoded lengths, muted-span semantics, frame padding, frozen candidates/pins/adoption receipts, reuse closure files, and old-payload compatibility. No genre, speech content, voice, provider or style defaults were introduced. The explicit track `kind` is not inferred from arbitrary bytes. Existing exact text/performance/voice/state checks and disabled provider boundary remain unchanged.

The final self-review refinements preserve authored/default cuts within the final declared scene, hold only the final default shot through an explicitly selected global music/SFX tail, and retain the preexisting per-use Edition asset-list order/duplicates. The two-scene closure and fractional visual coverage assertions cover these boundaries. Other deliberate limits: one-hour existing render ceiling; no loop/time-stretch/new codecs/providers; no implicit duration allocation across multiple empty scenes; scene-relative track placement derives from selected slot scope rather than user-supplied scene IDs. No known remaining Task 6 blocker after the final 483-test pass. Fresh independent review is dispatched by the controller after this report; this implementer’s self-review is not an independent evaluation.
