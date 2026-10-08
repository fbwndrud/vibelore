import test from "node:test";
import assert from "node:assert/strict";
test("shared frame resolves shot-local millisecond keyframes and safe captions at both profiles", async () => {
  const { frameAt } = await import("../render/frame.js");
  const edition = {
    closure: {
      profile: { width: 1280, height: 720, fps: 30 },
      timeline: {
        sampleRate: 48000,
        takes: [
          {
            utteranceId: "u",
            text: "잠깐만 기다려.",
            speaker: "서윤",
            startSample: 0,
            endSample: 96000,
          },
        ],
      },
      shots: [
        {
          id: "shot",
          startFrame: 0,
          endFrame: 90,
          blobId: "image",
          transform: {
            x: 0,
            y: 0,
            scale: 1,
            anchor: "center",
            easing: "linear",
            safeArea: { left: 0.1, top: 0.05, right: 0.2, bottom: 0.15 },
            keyframes: [
              { timeMs: 0, x: 0, y: 0, scale: 1 },
              { timeMs: 2000, x: 0.2, y: 0.1, scale: 1.2 },
            ],
          },
        },
      ],
    },
  };
  const f = frameAt({ edition, frame: 30, fps: 30 });
  assert.equal(f.camera.x, 0.1);
  assert.equal(f.camera.scale, 1.1);
  assert.equal(f.caption.speaker, "서윤");
  assert.equal(f.safeArea.right, 0.2);
  assert.equal(frameAt({ edition, frame: 60, fps: 30 }).caption, null);
  edition.closure.profile = { width: 720, height: 1280, fps: 30 };
  assert.equal(frameAt({ edition, frame: 30, fps: 30 }).camera.x, 0.1);
});

test("exports real selected PNG and WAV into decoded landscape and portrait MP4 without a provider", async (t) => {
  const { audioFixture } = await import("./helpers/render-fixture.js");
  const { assetImport, png, basePixels, environmentSlot } = await import(
    "./helpers/images.js"
  );
  const { writeFile } = await import("node:fs/promises");
  const f = await audioFixture(t),
    slot = environmentSlot("picture");
  await assetImport(f, "picture1", await png(basePixels), slot);
  await f.command(
    "candidate.adopt",
    {
      slotId: slot.id,
      candidateId: "picture1",
      actor: "creator",
      reason: "Picture fixture",
    },
    { aggregate: { kind: "assetSlot", id: slot.id } },
  );
  const scene = (await f.service.snapshot(f.projectId)).scenes[0];
  scene.shots = scene.shots.map((sh) => ({
    ...sh,
    referenceSlotId: slot.id,
    transform: {
      x: 0,
      y: 0,
      scale: 1,
      safeArea: { left: 0.06, top: 0.06, right: 0.06, bottom: 0.08 },
      anchor: "center",
      easing: "linear",
      keyframes: [],
    },
  }));
  await f.command("scene.put", scene, {
    aggregate: { kind: "scene", id: scene.id },
  });
  for (const profile of ["landscape", "portrait"]) {
    await f.command(
      "edition.create",
      { id: profile, productionId: "main", profile },
      { aggregate: { kind: "edition", id: profile } },
    );
    const out = (
      await f.command(
        "edition.render",
        { editionId: profile, renderId: profile },
        { aggregate: { kind: "editionOutput", id: profile } },
      )
    ).value;
    assert.equal(out.status, "completed", JSON.stringify(out));
    assert.equal(out.manifest.checks.decodedVideo, true);
    const video = out.manifest.streams.find((s) => s.type === "video");
    assert.equal(video.width, profile === "landscape" ? 1280 : 720);
    assert.equal(video.height, profile === "landscape" ? 720 : 1280);
    assert.equal(video.frames, 150);
    assert.equal(out.manifest.frames.length, 3);
    await writeFile(
      `/tmp/task7-first-${profile}.mp4`,
      await f.service.readBlob(f.projectId, out.manifest.output.blobId),
    );
  }
});

test("playback chooses the nearest audio-clock frame to keep RAF sampling within one frame", async () => {
  const { playbackFrame } = await import("../ui/player.js");
  assert.equal(playbackFrame(38.02926, 30, 1980), 1141);
  assert.equal(playbackFrame(66, 30, 1980), 1979);
});

test("a later first camera key interpolates from base transform without jumping before its time", async () => {
  const { frameAt } = await import("../render/frame.js");
  const edition = {
    closure: {
      profile: { fps: 30 },
      timeline: { sampleRate: 48000, takes: [] },
      shots: [
        {
          id: "s",
          blobId: "b",
          startFrame: 0,
          endFrame: 90,
          transform: {
            x: 0,
            y: 0,
            scale: 1,
            keyframes: [{ timeMs: 2000, x: 0.2, y: 0.1, scale: 1.2 }],
          },
        },
      ],
    },
  };
  assert.equal(frameAt({ edition, frame: 15 }).camera.x, 0.05);
  assert.equal(frameAt({ edition, frame: 15 }).camera.scale, 1.05);
});
