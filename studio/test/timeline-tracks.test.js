import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { withGeneration, audioTakeSlot } from "./helpers/project.js";
import { audioFixture, videoFixture, tone } from "./helpers/render-fixture.js";
import {
  assetImport,
  environmentSlot,
  png,
  basePixels,
} from "./helpers/images.js";
import { resolveTimeline } from "../src/engine/timeline.js";
import { mixTimeline } from "../src/render/mix.js";
import { decodeWav } from "../src/assets/audio-import.js";
import { createStudioOwnerAdapter } from "../src/source/export-studio-assets.js";

const update = (f, payload) =>
  f.command(
    "timeline.update",
    { productionId: "main", ...payload },
    { aggregate: { kind: "timeline", id: "main" } },
  );
const create = async (f, id = "sound", profile = "audio") =>
  (
    await f.command(
      "edition.create",
      { id, productionId: "main", profile },
      { aggregate: { kind: "edition", id } },
    )
  ).value;
const soundSlot = (id, kind, scope = { kind: "scene", id: "scene" }) => ({
  ...environmentSlot(id, scope),
  audioRole: kind,
});
async function sound(f, id, kind, scope, bytes = tone({ seconds: 1 })) {
  const slot = soundSlot(id, kind, scope);
  const candidate = (await assetImport(f, id, bytes, slot, "audio")).value
    .candidate;
  await f.command(
    "candidate.adopt",
    {
      slotId: id,
      candidateId: id,
      actor: "creator",
      reason: "Independent sound",
    },
    { aggregate: { kind: "assetSlot", id } },
  );
  return { slot, candidate };
}
function constant(value, seconds = 1) {
  const b = tone({ seconds, rate: 48000 });
  for (let i = 44; i < b.length; i += 2) b.writeInt16LE(value, i);
  return b;
}

test("independent tracks share actual sample rounding, overlap, trim, mute, gain and fades with speech", async () => {
  const speech = constant(4096),
    music = constant(8192),
    sfx = constant(4096);
  const timeline = resolveTimeline({
    takes: [
      { utteranceId: "u", frames: 48000, sampleRate: 48000, blobId: "speech" },
    ],
    tracks: [
      {
        id: "music",
        kind: "music",
        slotId: "music",
        blobId: "music",
        frames: 48000,
        sampleRate: 48000,
        startMs: 0,
        trimStartMs: 250,
        trimEndMs: 250,
        gainDb: -6.020599913279624,
        fadeInMs: 100,
        fadeOutMs: 100,
      },
      {
        id: "sfx",
        kind: "sfx",
        slotId: "sfx",
        blobId: "sfx",
        frames: 48000,
        sampleRate: 48000,
        startMs: 250,
        gainDb: 0,
      },
      {
        id: "muted",
        kind: "sfx",
        slotId: "sfx",
        blobId: "sfx",
        frames: 48000,
        sampleRate: 48000,
        startMs: 0,
        muted: true,
      },
    ],
  });
  assert.equal(timeline.tracks[0].trimStartSamples, 12000);
  assert.equal(timeline.totalDurationFrames, 38);
  const mixed = await mixTimeline(
    timeline,
    (id) => ({ speech, music, sfx }[id]),
  );
  const { samples, metadata } = decodeWav(mixed.bytes);
  const sample = (ms) => samples[Math.round(ms * 48) * 2];
  assert.ok(Math.abs(sample(0) - 0.125) < 0.0001);
  assert.ok(Math.abs(sample(200) - 0.25) < 0.0001);
  assert.ok(Math.abs(sample(300) - 0.375) < 0.0001);
  assert.ok(Math.abs(sample(600) - 0.25) < 0.0001);
  assert.ok(Math.abs(sample(1100) - 0.125) < 0.0001);
  assert.equal(metadata.frameCount, 60800);
});

test("pure music and explicit silence freeze and render actual WAV without utterance jobs", async (t) => {
  const f = await withGeneration(t);
  await sound(f, "music", "music");
  await update(f, {
    tracks: [{ id: "bed", kind: "music", slotId: "music", startMs: 0 }],
    sceneDurations: [{ sceneId: "scene", durationMs: 1500 }],
  });
  const music = await create(f);
  assert.equal(music.closure.timeline.durationFrames, 45);
  assert.equal(music.closure.timeline.takes.length, 0);
  assert.equal(music.closure.assets[0].id, "music");
  const musicOutput = (
    await f.command(
      "edition.render",
      { editionId: "sound", renderId: "music" },
      { aggregate: { kind: "editionOutput", id: "music" } },
    )
  ).value;
  assert.equal(musicOutput.status, "completed");
  const musicAudio = decodeWav(
    await f.service.readBlob("p1", musicOutput.manifest.output.blobId),
  );
  assert.equal(musicAudio.metadata.durationSeconds, 1.5);
  assert.ok(musicAudio.samples.some((x) => Math.abs(x) > 0.1));
  await update(f, {
    tracks: [],
    sceneDurations: [{ sceneId: "scene", durationMs: 500 }],
  });
  const silent = await create(f, "silent");
  const output = (
    await f.command(
      "edition.render",
      { editionId: "silent", renderId: "silent" },
      { aggregate: { kind: "editionOutput", id: "silent" } },
    )
  ).value;
  assert.equal(output.status, "completed");
  const { metadata, samples } = decodeWav(
    await f.service.readBlob("p1", output.manifest.output.blobId),
  );
  assert.equal(metadata.durationSeconds, 0.5);
  assert.ok(samples.every((x) => x === 0));
  assert.equal(silent.closure.timeline.totalDurationFrames, 15);
  assert.equal((await f.service.snapshot("p1")).jobs.length, 0);
  await assert.rejects(update(f, { tracks: [], sceneDurations: [] }), {
    code: "MISSING_AUDIO",
  });
});

test("scene spans schedule two scenes, local tracks and production-global cross-scene music", async (t) => {
  const f = await withGeneration(t);
  await f.command(
    "scene.put",
    {
      id: "scene2",
      productionId: "main",
      occurrences: [],
      presentations: [],
      utterances: [],
      shots: [{ id: "shot3" }, { id: "shot4" }],
    },
    { aggregate: { kind: "scene", id: "scene2" } },
  );
  await sound(
    f,
    "bed",
    "music",
    { kind: "production", id: "main" },
    tone({ seconds: 3 }),
  );
  await sound(f, "hit", "sfx", { kind: "shot", id: "shot3" });
  const r = await update(f, {
    sceneIds: ["scene", "scene2"],
    sceneDurations: [
      { sceneId: "scene", durationMs: 1000 },
      { sceneId: "scene2", durationMs: 1000 },
    ],
    tracks: [
      { id: "bed", kind: "music", slotId: "bed", startMs: 0 },
      { id: "hit", kind: "sfx", slotId: "hit", startMs: 0 },
    ],
  });
  assert.deepEqual(
    r.value.resolved.scenes.map((s) => [s.sceneId, s.startSample, s.endSample]),
    [
      ["scene", 0, 48000],
      ["scene2", 48000, 96000],
    ],
  );
  assert.equal(r.value.resolved.tracks[1].startSample, 48000);
  assert.equal(r.value.resolved.durationFrames, 90);
  const picture = environmentSlot("picture");
  await assetImport(f, "picture", await png(basePixels), picture);
  await f.command(
    "candidate.adopt",
    {
      slotId: picture.id,
      candidateId: "picture",
      actor: "creator",
      reason: "Global-tail image",
    },
    { aggregate: { kind: "assetSlot", id: picture.id } },
  );
  for (const scene of (await f.service.snapshot("p1")).scenes) {
    scene.shots = scene.shots.map((sh) => ({
      ...sh,
      referenceSlotId: picture.id,
    }));
    await f.command("scene.put", scene, {
      aggregate: { kind: "scene", id: scene.id },
    });
  }
  const tail = await create(f, "global-tail", "landscape");
  assert.deepEqual(
    tail.closure.shots.map((sh) => [sh.startFrame, sh.endFrame]),
    [
      [0, 15],
      [15, 30],
      [30, 45],
      [45, 90],
    ],
  );
  await update(f, {
    ...r.value.intent,
    productionId: "main",
    shots: [{ shotId: "shot4", fixedStartMs: 1500, durationMs: 500 }],
  });
  await assert.rejects(create(f, "authored-tail-gap", "landscape"), {
    code: "TIMING_CONFLICT",
  });
  await assert.rejects(
    update(f, {
      sceneIds: ["scene"],
      tracks: [{ id: "hit", kind: "sfx", slotId: "hit", startMs: 0 }],
      sceneDurations: [{ sceneId: "scene", durationMs: 1000 }],
    }),
    { code: "INVALID_REFERENCE" },
  );
  await update(f, {
    sceneIds: ["scene", "scene2"],
    tracks: [],
    sceneDurations: [
      { sceneId: "scene", durationMs: 110 },
      { sceneId: "scene2", durationMs: 110 },
    ],
  });
  const fractional = await create(f, "fractional-visual", "landscape");
  assert.deepEqual(
    fractional.closure.shots.map((sh) => [sh.startFrame, sh.endFrame]),
    [
      [0, 2],
      [2, 4],
      [4, 6],
      [6, 7],
    ],
  );
});

test("track contracts reject duplicate IDs, wrong media/role/scope, unsafe time, overtrim and too-short scenes", async (t) => {
  const f = await audioFixture(t);
  await sound(f, "music", "music");
  const track = { id: "bed", kind: "music", slotId: "music", startMs: 0 };
  for (const tracks of [
    [track, track],
    [{ ...track, startMs: -1 }],
    [{ ...track, startMs: Number.MAX_SAFE_INTEGER }],
    [{ ...track, trimEndMs: 1001 }],
    [{ ...track, kind: "sfx" }],
    [{ ...track, slotId: "take-u1" }],
  ])
    await assert.rejects(update(f, { tracks }));
  await assert.rejects(
    update(f, {
      tracks: [track],
      sceneDurations: [{ sceneId: "scene", durationMs: 1000 }],
    }),
    { code: "TIMING_CONFLICT" },
  );
  for (const durationMs of [-1, 0, Number.MAX_SAFE_INTEGER])
    await assert.rejects(
      update(f, { sceneDurations: [{ sceneId: "scene", durationMs }] }),
      { code: "INVALID_INPUT" },
    );
  assert.throws(
    () =>
      resolveTimeline({
        tracks: [{ ...track, frames: 48000, sampleRate: 48000, startMs: NaN }],
      }),
    { code: "INVALID_INPUT" },
  );
  await f.command(
    "utterance.update",
    { id: "u1", text: "different" },
    { aggregate: { kind: "utterance", id: "u1" } },
  );
  await assert.rejects(update(f, { tracks: [track] }), {
    code: "SLOT_CONFLICT",
  });
});

test("native track use advertises exact music/SFX roles and cross-project import stays explicit and frozen", async (t) => {
  const source = await withGeneration(t);
  await sound(source, "music", "music");
  await sound(source, "hit", "sfx");
  await update(source, {
    tracks: [
      { id: "bed", kind: "music", slotId: "music", startMs: 0 },
      { id: "hit", kind: "sfx", slotId: "hit", startMs: 500 },
    ],
  });
  const adapter = createStudioOwnerAdapter({
    locator: { directory: source.directory },
    ownerId: "native-sound",
    allowedProjects: ["p1"],
  });
  const snapshot = await adapter.capture({
    ownerId: "native-sound",
    allowedProjects: ["p1"],
  });
  const destination = await withGeneration(t);
  for (const [id, kind] of [
    ["music", "music"],
    ["hit", "sfx"],
  ]) {
    const entry = snapshot.entries.find(
      (e) => e.ref.recordKind === "candidate" && e.ref.recordId === id,
    );
    assert.deepEqual(entry.roles, [kind]);
    const data = await adapter.exportExact({ roots: [entry.ref] });
    const slot =
      id === "music"
        ? environmentSlot(id, { kind: "scene", id: "scene" })
        : soundSlot(id, kind);
    const intent = {
      target: { kind: "assetSlot", id },
      mode: "reuse-preserved",
      purpose: "independent soundtrack",
      identityMap: [],
      stateMap: [],
      selections: [{ source: entry.ref, slot, role: kind }],
    };
    const inspection = await destination.service.inspectReuse({
      projectId: "p1",
      ...data,
      intent,
    });
    assert.equal(inspection.disposition, "compatible");
    const result = (
      await destination.command(
        "asset.importBundle",
        {
          ...data,
          intent,
          inspectionDigest: inspection.inspectionDigest,
          actor: "creator",
          reason: "Reuse actual track",
        },
        { aggregate: intent.target },
      )
    ).value;
    await destination.command(
      "candidate.adopt",
      {
        slotId: id,
        candidateId: result.candidate.id,
        actor: "creator",
        reason: "Track selection",
      },
      { aggregate: intent.target },
    );
  }
  await update(destination, {
    tracks: [
      { id: "bed", kind: "music", slotId: "music", startMs: 0 },
      { id: "hit", kind: "sfx", slotId: "hit", startMs: 500 },
    ],
  });
  const old = await create(destination);
  const oldBytes = await destination.service.readBlob(
    "p1",
    old.closure.mix.blobId,
  );
  assert.equal(
    old.closure.assets.every((a) => a.reuseProvenance?.localManifestBlobId),
    true,
  );
  for (const selection of old.closure.soundSelections) {
    assert.ok(selection.candidate.pins.length);
    assert.equal(selection.adoption.candidateId, selection.candidate.id);
    assert.equal(selection.adoption.id, selection.slot.adoptionId);
    assert.equal(
      selection.candidate.reuseRole,
      selection.slot.audioRole ?? selection.candidate.reuseRole,
    );
  }
  await update(destination, {
    tracks: [
      { id: "bed", kind: "music", slotId: "music", startMs: 2000, muted: true },
    ],
    sceneDurations: [{ sceneId: "scene", durationMs: 3500 }],
  });
  const changed = await create(destination, "changed");
  assert.notEqual(changed.closureDigest, old.closureDigest);
  assert.deepEqual(
    await destination.service.readBlob("p1", old.closure.mix.blobId),
    oldBytes,
  );
  const rendered = (
    await destination.command(
      "edition.render",
      { editionId: "sound", renderId: "frozen-after-edit" },
      { aggregate: { kind: "editionOutput", id: "frozen-after-edit" } },
    )
  ).value;
  assert.equal(rendered.status, "completed");
  assert.deepEqual(
    await destination.service.readBlob("p1", rendered.manifest.output.blobId),
    oldBytes,
  );
  await destination.service.collectGarbage("p1", { graceMs: 0 });
  for (const id of old.closure.blobIds)
    assert.ok((await destination.service.readBlob("p1", id)).length);
  const archive = (await destination.command("project.backup", {})).value
    .archive;
  const { restoreStudioBackup } = await import("../src/engine/backup.js");
  const restored = await restoreStudioBackup({
    archive: join(destination.directory, archive),
    directory: join(destination.directory, "restored"),
  });
  t.after(() => restored.close());
  const frozen = (await restored.snapshot("p1")).editions.find(
    (e) => e.id === "sound",
  );
  assert.deepEqual(frozen, old);
  for (const id of old.closure.blobIds)
    assert.ok((await restored.readBlob("p1", id)).length);
  assert.equal((await restored.snapshot("p1")).reuseImports.length, 2);
  assert.equal((await restored.snapshot("p1")).jobs.length, 0);
});

test("explicitly timed fully silent video produces decoded MP4 and no speech captions", async (t) => {
  const f = await withGeneration(t);
  const slot = environmentSlot("picture");
  await assetImport(f, "picture", await png(basePixels), slot);
  await f.command(
    "candidate.adopt",
    {
      slotId: "picture",
      candidateId: "picture",
      actor: "creator",
      reason: "Silent image",
    },
    { aggregate: { kind: "assetSlot", id: "picture" } },
  );
  const scene = (await f.service.snapshot("p1")).scenes[0];
  scene.shots = scene.shots.map((s) => ({ ...s, referenceSlotId: "picture" }));
  await f.command("scene.put", scene, {
    aggregate: { kind: "scene", id: "scene" },
  });
  await update(f, {
    sceneDurations: [{ sceneId: "scene", durationMs: 400 }],
    tracks: [],
  });
  const edition = await create(f, "silent-video", "landscape");
  assert.equal(edition.closure.timeline.takes.length, 0);
  assert.equal(edition.closure.shots.at(-1).endFrame, 12);
  const out = (
    await f.command(
      "edition.render",
      { editionId: edition.id, renderId: "silent-video" },
      { aggregate: { kind: "editionOutput", id: "silent-video" } },
    )
  ).value;
  assert.equal(out.status, "completed", JSON.stringify(out));
  assert.equal(out.manifest.checks.decodedVideo, true);
  assert.equal(out.manifest.streams.find((s) => s.type === "video").frames, 12);
  assert.ok(Math.abs(out.manifest.durationSeconds - 0.4) < 0.04);
  await sound(f, "music", "music", undefined, tone({ seconds: 0.3 }));
  await update(f, {
    sceneDurations: [{ sceneId: "scene", durationMs: 400 }],
    tracks: [{ id: "music", kind: "music", slotId: "music", startMs: 0 }],
  });
  const music = await create(f, "music-video", "landscape");
  assert.ok(
    decodeWav(
      await f.service.readBlob("p1", music.closure.mix.blobId),
    ).samples.some((x) => Math.abs(x) > 0.1),
  );
  const rendered = (
    await f.command(
      "edition.render",
      { editionId: "music-video", renderId: "music-video" },
      { aggregate: { kind: "editionOutput", id: "music-video" } },
    )
  ).value;
  assert.equal(rendered.status, "completed", JSON.stringify(rendered));
  assert.equal(rendered.manifest.checks.decodedAudio, true);
  assert.equal(rendered.manifest.checks.decodedVideo, true);
  assert.equal(
    rendered.manifest.streams.find((s) => s.type === "video").frames,
    12,
  );
});

test("empty sound additions preserve the exact legacy resolver DTO and global speech anchors", () => {
  const input = {
    fps: 30,
    takes: [
      { utteranceId: "a", sceneId: "s1", frames: 48000, sampleRate: 48000 },
      {
        utteranceId: "b",
        sceneId: "s2",
        frames: 48000,
        sampleRate: 48000,
        anchor: { utteranceId: "a", edge: "start" },
        offsetMs: 250,
      },
    ],
    cues: [{ id: "cue", anchor: { utteranceId: "b", edge: "end" } }],
  };
  assert.deepEqual(
    resolveTimeline({
      ...input,
      sceneIds: ["s1", "s2"],
      tracks: [],
      sceneDurations: [],
    }),
    resolveTimeline(input),
  );
});

test("partial scene durations retain production-global fixed speech and cross-scene anchors", async (t) => {
  const f = await audioFixture(t);
  await f.command(
    "scene.put",
    {
      id: "scene2",
      productionId: "main",
      occurrences: [
        {
          id: "n2",
          roleBindingId: "narrator",
          characterId: null,
          presence: "narrator",
        },
      ],
      presentations: [
        {
          occurrenceId: "n2",
          appearanceStateRef: null,
          castingStateRef: null,
          knowledgeStateRef: null,
        },
      ],
      utterances: [
        {
          id: "u3",
          speakerOccurrenceId: "n2",
          addresseeOccurrenceIds: [],
          text: "해설",
        },
      ],
      shots: [{ id: "last" }],
    },
    { aggregate: { kind: "scene", id: "scene2" } },
  );
  const slot = audioTakeSlot("take-u3", "u3", "narrator", null, {
    kind: "scene",
    id: "scene2",
  });
  await assetImport(f, "audio-u3", tone({ seconds: 1 }), slot, "audio");
  await f.command(
    "candidate.adopt",
    {
      slotId: slot.id,
      candidateId: "audio-u3",
      actor: "creator",
      reason: "actual take",
    },
    { aggregate: { kind: "assetSlot", id: slot.id } },
  );
  const result = await update(f, {
    sceneIds: ["scene", "scene2"],
    sceneDurations: [{ sceneId: "scene", durationMs: 6000 }],
    utterances: [
      {
        utteranceId: "u3",
        anchor: { utteranceId: "uN", edge: "end" },
        offsetMs: 1000,
        fixedStartMs: 6000,
        fixedEndMs: 7000,
      },
    ],
  });
  assert.equal(result.value.resolved.takes.at(-1).startSample, 288000);
  assert.equal(result.value.resolved.durationFrames, 210);
  assert.equal(result.value.resolved.scenes[1].explicitDuration, false);
});

test("adjacent fractional scene spans use a shared frame boundary and total timing is bounded", () => {
  const timeline = resolveTimeline({
    sceneIds: ["a", "b"],
    sceneDurations: [
      { sceneId: "a", durationMs: 110 },
      { sceneId: "b", durationMs: 110 },
    ],
  });
  assert.equal(timeline.scenes[0].endFrame, timeline.scenes[1].startFrame);
  assert.equal(timeline.totalDurationFrames, 7);
  assert.throws(
    () =>
      resolveTimeline({
        sceneIds: ["a", "b"],
        sceneDurations: [
          { sceneId: "a", durationMs: 3600000 },
          { sceneId: "b", durationMs: 1 },
        ],
      }),
    { code: "INVALID_INPUT" },
  );
});

test("unconsumed audio bytes advertise reference only and preserved references cannot become speech or tracks", async (t) => {
  const source = await withGeneration(t);
  await sound(source, "reference", "music");
  const adapter = createStudioOwnerAdapter({
    locator: { directory: source.directory },
    ownerId: "reference-owner",
    allowedProjects: ["p1"],
  });
  const snapshot = await adapter.capture({
    ownerId: "reference-owner",
    allowedProjects: ["p1"],
  });
  const entry = snapshot.entries.find(
    (e) => e.ref.recordKind === "candidate" && e.ref.recordId === "reference",
  );
  assert.deepEqual(entry.roles, ["audio-reference"]);
  const data = await adapter.exportExact({ roots: [entry.ref] });
  const f = await audioFixture(t),
    slot = environmentSlot("reference", { kind: "scene", id: "scene" });
  const intent = {
    target: { kind: "assetSlot", id: slot.id },
    mode: "reuse-preserved",
    purpose: "audio inspiration",
    identityMap: [],
    stateMap: [],
    selections: [{ source: entry.ref, slot, role: "audio-reference" }],
  };
  const inspection = await f.service.inspectReuse({
    projectId: "p1",
    ...data,
    intent,
  });
  assert.equal(inspection.disposition, "compatible");
  const candidate = (
    await f.command(
      "asset.importBundle",
      {
        ...data,
        intent,
        inspectionDigest: inspection.inspectionDigest,
        actor: "creator",
        reason: "Retain reference role",
      },
      { aggregate: intent.target },
    )
  ).value.candidate;
  await f.command(
    "candidate.adopt",
    {
      slotId: slot.id,
      candidateId: candidate.id,
      actor: "creator",
      reason: "Reference only",
    },
    { aggregate: intent.target },
  );
  for (const kind of ["music", "sfx"])
    await assert.rejects(
      update(f, { tracks: [{ id: "bad", kind, slotId: slot.id, startMs: 0 }] }),
      { code: "SLOT_CONFLICT" },
    );
  await assert.rejects(
    f.command(
      "candidate.adopt",
      {
        slotId: "new-take",
        slot: audioTakeSlot("new-take", "u1"),
        candidateId: candidate.id,
        actor: "creator",
        reason: "Cannot coerce reference",
      },
      { aggregate: { kind: "assetSlot", id: "new-take" } },
    ),
    (error) => error.code === "SLOT_CONFLICT" && error.message.includes("role"),
  );
  const reexport = createStudioOwnerAdapter({
    locator: { directory: f.directory },
    ownerId: "destination-owner",
    allowedProjects: ["p1"],
  });
  assert.deepEqual(
    (
      await reexport.capture({
        ownerId: "destination-owner",
        allowedProjects: ["p1"],
      })
    ).entries.find(
      (e) =>
        e.ref.recordId === candidate.id && e.ref.recordKind === "candidate",
    ).roles,
    ["audio-reference"],
  );
});

test("sound tracks reject selected image and other-production slots; role audio needs no casting", async (t) => {
  const f = await withGeneration(t);
  await f.command("production.create", {
    id: "other",
    title: "Other",
    sourcePackageId: null,
  });
  await sound(f, "foreign", "music", { kind: "production", id: "other" });
  await sound(f, "local", "music", { kind: "project", id: "p1" });
  const image = environmentSlot("image");
  await assetImport(f, "image", await png(basePixels), image);
  await f.command(
    "candidate.adopt",
    {
      slotId: "image",
      candidateId: "image",
      actor: "creator",
      reason: "image",
    },
    { aggregate: { kind: "assetSlot", id: "image" } },
  );
  for (const slotId of ["foreign", "image"])
    await assert.rejects(
      update(f, { tracks: [{ id: "bad", kind: "music", slotId, startMs: 0 }] }),
      { code: "INVALID_REFERENCE" },
    );
  await f.command(
    "cast.put",
    { id: "sound-role", name: "Sound role", language: "ko", characterId: null },
    { aggregate: { kind: "cast", id: "sound-role" } },
  );
  const slot = {
    ...soundSlot("role-sound", "sfx", { kind: "production", id: "main" }),
    subject: { kind: "role", id: "sound-role" },
  };
  await assetImport(f, "role-sound", tone({ seconds: 0.5 }), slot, "audio");
  await f.command(
    "candidate.adopt",
    {
      slotId: slot.id,
      candidateId: "role-sound",
      actor: "creator",
      reason: "No utterance or voice required",
    },
    { aggregate: { kind: "assetSlot", id: slot.id } },
  );
  const r = await update(f, {
    tracks: [
      { id: "project-track", kind: "music", slotId: "local", startMs: 0 },
      { id: "role-track", kind: "sfx", slotId: slot.id, startMs: 0 },
    ],
    sceneDurations: [{ sceneId: "scene", durationMs: 1000 }],
  });
  assert.equal(
    r.value.resolved.tracks.every((t) => t.timeBasis === "production"),
    true,
  );
  assert.equal(
    (await f.service.snapshot("p1")).aggregates.filter(
      (a) => a.kind === "casting",
    ).length,
    0,
  );
});

test("declared silent spans cover all shot cues and reject malformed timing intent", async (t) => {
  const f = await withGeneration(t);
  await assert.rejects(
    update(f, {
      sceneDurations: [{ sceneId: "scene", durationMs: 100 }],
      shots: [{ shotId: "shot", fixedStartMs: 0, durationMs: 200 }],
    }),
    { code: "TIMING_CONFLICT" },
  );
  for (const sceneDurations of [
    { sceneId: "scene", durationMs: 100 },
    [
      { sceneId: "scene", durationMs: 100 },
      { sceneId: "scene", durationMs: 100 },
    ],
    [{ sceneId: "unknown", durationMs: 100 }],
    [{ sceneId: "scene", durationMs: 0.0000001 }],
  ])
    await assert.rejects(update(f, { sceneDurations }));
  const base = {
    id: "t",
    kind: "music",
    slotId: "s",
    startMs: 0,
    frames: 48000,
    sampleRate: 48000,
  };
  for (const change of [
    { gainDb: Infinity },
    { gainDb: 13 },
    { fadeInMs: -1 },
    { fadeOutMs: 1001 },
    { muted: "yes" },
    { trimStartMs: 1001 },
    { startMs: NaN },
  ])
    assert.throws(() => resolveTimeline({ tracks: [{ ...base, ...change }] }));
});

test("legacy Edition asset inventory keeps its original per-use order and duplicates", async (t) => {
  const f = await videoFixture(t),
    edition = await create(f, "legacy-inventory", "landscape");
  assert.deepEqual(
    edition.closure.assets.map((a) => a.id),
    ["audio-u1", "audio-u2", "audio-uN", "picture1", "picture1"],
  );
});
