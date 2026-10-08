import test from "node:test";
import assert from "node:assert/strict";
import { audioFixture } from "./helpers/render-fixture.js";
const create = (f, id = "v1", profile = "audio") =>
  f.command(
    "edition.create",
    { id, productionId: "main", profile },
    { aggregate: { kind: "edition", id } },
  );
test("freezes real source, media, font, license and timing closure independently of working v2", async (t) => {
  const f = await audioFixture(t);
  const e = (await create(f)).value;
  assert.equal(e.closure.timeline.durationFrames, 150);
  assert.equal(e.closure.profile.kind, "audio");
  for (const id of e.closure.blobIds)
    assert.ok((await f.service.readBlob(f.projectId, id)).length);
  assert.ok(e.closure.font.licenseBlobId);
  assert.ok(e.closure.environment.lockBlobId);
  assert.equal(e.closure.assets[0].resolvedModel, "unknown");
  await f.command(
    "utterance.update",
    { id: "u2", holdMs: 1000 },
    { aggregate: { kind: "utterance", id: "u2" } },
  );
  const e2 = (await create(f, "v2")).value;
  assert.equal(e2.closure.timeline.durationFrames, 180);
  assert.notEqual(e2.closureDigest, e.closureDigest);
  assert.deepEqual(
    (await f.service.snapshot(f.projectId)).editions.find((x) => x.id === "v1"),
    e,
  );
  await assert.rejects(create(f), { code: "IMMUTABLE_EDITION" });
});
test("audio-only edition does not require selected pictures; video edition does", async (t) => {
  const f = await audioFixture(t);
  await create(f);
  await assert.rejects(create(f, "video", "landscape"), {
    code: "MISSING_IMAGE",
  });
});
test("unsupported glyph is rejected instead of rendering tofu", async (t) => {
  const f = await audioFixture(t);
  const scene = (await f.service.snapshot(f.projectId)).scenes[0];
  await f.command(
    "cast.put",
    {
      ...(await f.service.snapshot(f.projectId)).cast.find(
        (x) => x.id === "actor",
      ),
      name: "🪼",
    },
    { aggregate: { kind: "cast", id: "actor" } },
  );
  await assert.rejects(create(f), { code: "UNSUPPORTED_GLYPH" });
});
test("actual audio export can be reviewed under explicit diagnostic policy and published after working edits", async (t) => {
  const f = await audioFixture(t);
  await f.command(
    "policy.create",
    { id: "diagnostic", name: "Synthetic tone checks only", required: [] },
    { aggregate: { kind: "reviewPolicy", id: "diagnostic" } },
  );
  const e = (
    await f.command(
      "edition.create",
      {
        id: "v1",
        productionId: "main",
        profile: "audio",
        policyId: "diagnostic",
      },
      { aggregate: { kind: "edition", id: "v1" } },
    )
  ).value;
  const out = (
    await f.command(
      "edition.render",
      { editionId: "v1", renderId: "render1" },
      { aggregate: { kind: "editionOutput", id: "render1" } },
    )
  ).value;
  assert.equal(out.status, "completed");
  assert.equal(out.manifest.checks.decodedAudio, true);
  assert.equal(out.manifest.durationSeconds, 5);
  assert.equal(
    Buffer.from(
      await f.service.readBlob(f.projectId, out.manifest.output.blobId),
    ).toString("ascii", 0, 4),
    "RIFF",
  );
  const review = (
    await f.command(
      "edition.review",
      {
        id: "review1",
        editionId: "v1",
        renderId: "render1",
        actor: "fixture-policy",
        closureDigest: e.closureDigest,
        outputManifestDigest: out.manifestDigest,
        policyBindingRevision: 0,
        checks: {},
      },
      { aggregate: { kind: "editionReview", id: "review1" } },
    )
  ).value;
  assert.equal(review.perceptualVerification, "not_performed");
  await f.command(
    "utterance.update",
    { id: "u2", holdMs: 1000 },
    { aggregate: { kind: "utterance", id: "u2" } },
  );
  const pub = await f.command(
    "edition.publish",
    {
      editionId: "v1",
      reviewId: "review1",
      closureDigest: e.closureDigest,
      outputManifestDigest: out.manifestDigest,
      policyBindingRevision: 0,
    },
    { aggregate: { kind: "editionPublication", id: "v1" } },
  );
  assert.equal(pub.value.status, "published");
});
test("changing policy binding prevents old receipt publication; project default does not change frozen policy", async (t) => {
  const f = await audioFixture(t);
  await f.command(
    "policy.create",
    { id: "diagnostic", name: "Fixture only", required: [] },
    { aggregate: { kind: "reviewPolicy", id: "diagnostic" } },
  );
  const e = (await create(f)).value;
  await f.command(
    "policy.default",
    { policyId: "diagnostic" },
    { aggregate: { kind: "policyDefault", id: f.projectId } },
  );
  assert.equal(e.policy.id, "human-audio-v1");
  const out = (
    await f.command(
      "edition.render",
      { editionId: "v1", renderId: "r" },
      { aggregate: { kind: "editionOutput", id: "r" } },
    )
  ).value;
  const payload = {
    id: "review1",
    editionId: "v1",
    renderId: "r",
    actor: "creator",
    closureDigest: e.closureDigest,
    outputManifestDigest: out.manifestDigest,
    policyBindingRevision: 0,
    checks: { watched: true, listened: true },
  };
  await f.command("edition.review", payload, {
    aggregate: { kind: "editionReview", id: "review1" },
  });
  await f.command(
    "edition.bindPolicy",
    {
      editionId: "v1",
      policyId: "diagnostic",
      reason: "Explicit fixture policy",
    },
    { aggregate: { kind: "editionPolicy", id: "v1" } },
  );
  await assert.rejects(
    f.command(
      "edition.publish",
      { ...payload, reviewId: "review1" },
      { aggregate: { kind: "editionPublication", id: "v1" } },
    ),
    { code: "POLICY_CONFLICT" },
  );
});
test("publish final transaction catches a policy change while blob verification is in flight", async (t) => {
  const f = await audioFixture(t);
  await f.command(
    "policy.create",
    { id: "diagnostic", name: "Fixture only", required: [] },
    { aggregate: { kind: "reviewPolicy", id: "diagnostic" } },
  );
  const e = (
    await f.command(
      "edition.create",
      {
        id: "v1",
        productionId: "main",
        profile: "audio",
        policyId: "diagnostic",
      },
      { aggregate: { kind: "edition", id: "v1" } },
    )
  ).value;
  const out = (
    await f.command(
      "edition.render",
      { editionId: "v1", renderId: "r" },
      { aggregate: { kind: "editionOutput", id: "r" } },
    )
  ).value;
  const p = {
    id: "review1",
    editionId: "v1",
    renderId: "r",
    actor: "fixture",
    closureDigest: e.closureDigest,
    outputManifestDigest: out.manifestDigest,
    policyBindingRevision: 0,
    checks: {},
  };
  await f.command("edition.review", p, {
    aggregate: { kind: "editionReview", id: "review1" },
  });
  const original = f.service.blobs.read.bind(f.service.blobs);
  let release, started;
  const begun = new Promise((r) => (started = r)),
    barrier = new Promise((r) => (release = r));
  let first = true;
  f.service.blobs.read = async (...args) => {
    const bytes = await original(...args);
    if (first) {
      first = false;
      started();
      await barrier;
    }
    return bytes;
  };
  const pending = f.command(
    "edition.publish",
    { ...p, reviewId: "review1" },
    { aggregate: { kind: "editionPublication", id: "v1" } },
  );
  await begun;
  await f.command(
    "edition.bindPolicy",
    {
      editionId: "v1",
      policyId: "human-v1",
      reason: "Actual human review now required",
    },
    { aggregate: { kind: "editionPolicy", id: "v1" } },
  );
  release();
  await assert.rejects(pending, { code: "POLICY_CONFLICT" });
});
test("a renderer returning bogus bytes cannot mark an output checked or publishable", async (t) => {
  const f = await audioFixture(t);
  await create(f);
  f.service.renderer = async () => ({
    bytes: Buffer.from("bogus"),
    mime: "audio/wav",
    extension: "wav",
    durationSeconds: 5,
    streams: [],
    checks: { decodedAudio: true, profile: true },
  });
  const out = (
    await f.command(
      "edition.render",
      { editionId: "v1", renderId: "r" },
      { aggregate: { kind: "editionOutput", id: "r" } },
    )
  ).value;
  assert.equal(out.status, "failed");
  assert.equal(out.errorCode, "INVALID_WAV");
});

test("first hold remains silent and video covers it instead of rejecting a leading gap", async (t) => {
  const { assetImport, png, basePixels, environmentSlot } = await import(
    "./helpers/images.js"
  );
  const f = await audioFixture(t);
  const slot = environmentSlot("picture");
  await assetImport(f, "picture1", await png(basePixels), slot);
  await f.command(
    "candidate.adopt",
    {
      slotId: "picture",
      candidateId: "picture1",
      actor: "creator",
      reason: "fixture",
    },
    { aggregate: { kind: "assetSlot", id: "picture" } },
  );
  const scene = (await f.service.snapshot("p1")).scenes[0];
  scene.shots = scene.shots.map((sh) => ({
    ...sh,
    referenceSlotId: "picture",
  }));
  await f.command("scene.put", scene, {
    aggregate: { kind: "scene", id: scene.id },
  });
  await f.command(
    "utterance.update",
    { id: "u1", holdMs: 1000 },
    { aggregate: { kind: "utterance", id: "u1" } },
  );
  const e = (await create(f, "film", "landscape")).value;
  assert.equal(e.closure.shots[0].startFrame, 0);
  assert.equal(e.closure.timeline.takes[0].startSample, 48000);
  const { decodeWav } = await import("../src/assets/audio-import.js");
  const { samples } = decodeWav(
    await f.service.readBlob("p1", e.closure.mix.blobId),
  );
  assert.ok(samples.subarray(0, 96000).every((x) => x === 0));
  assert.ok(samples.subarray(96000, 97000).some((x) => Math.abs(x) > 0.1));
});

test("audio-only default review requires listening without asking for a nonexistent video", async (t) => {
  const f = await audioFixture(t),
    e = (await create(f)).value;
  const out = (
    await f.command(
      "edition.render",
      { editionId: e.id, renderId: "r" },
      { aggregate: { kind: "editionOutput", id: "r" } },
    )
  ).value;
  const r = await f.command(
    "edition.review",
    {
      id: "listened",
      editionId: e.id,
      renderId: "r",
      actor: "creator",
      closureDigest: e.closureDigest,
      outputManifestDigest: out.manifestDigest,
      policyBindingRevision: 0,
      checks: { listened: true },
    },
    { aggregate: { kind: "editionReview", id: "listened" } },
  );
  assert.equal(r.value.perceptualVerification, "creator_attested");
});
test("missing retained font license blocks render instead of returning a success receipt", async (t) => {
  const { unlink } = await import("node:fs/promises");
  const f = await audioFixture(t),
    e = (await create(f)).value;
  await unlink(f.service.blobs.path("p1", e.closure.font.licenseBlobId));
  await assert.rejects(
    f.command(
      "edition.render",
      { editionId: e.id, renderId: "r" },
      { aggregate: { kind: "editionOutput", id: "r" } },
    ),
    { code: "BLOB_MISSING" },
  );
  assert.equal((await f.service.snapshot("p1")).editionOutputs.length, 0);
});
test("explicit mute trim gain fade and overlap affect PCM while hold silence and nonvisual speech remain", async (t) => {
  const f = await audioFixture(t);
  await f.command(
    "timeline.update",
    {
      productionId: "main",
      fps: 30,
      utterances: [
        { utteranceId: "u1", mute: true },
        {
          utteranceId: "u2",
          fixedStartMs: 1000,
          trimStartSamples: 12000,
          trimEndSamples: 12000,
          gain: 0.5,
          fadeInMs: 100,
        },
      ],
    },
    { aggregate: { kind: "timeline", id: "main" } },
  );
  const e = (await create(f)).value;
  const { decodeWav } = await import("../src/assets/audio-import.js");
  const { samples, metadata } = decodeWav(
    await f.service.readBlob("p1", e.closure.mix.blobId),
  );
  assert.equal(metadata.durationSeconds, 3);
  assert.ok(samples.subarray(0, 96000).every((x) => x === 0));
  const peak = (start, end) =>
    Math.max(...samples.subarray(start * 96000, end * 96000).map(Math.abs));
  assert.ok(peak(1.2, 1.3) > 0.07 && peak(1.2, 1.3) < 0.08);
  assert.ok(peak(1, 1.01) < 0.01);
  assert.ok(peak(2.2, 2.3) > 0.15);
});

test("default video shots cover the latest actual overlapping take, including a shorter final narrator", async (t) => {
  const { videoFixture } = await import("./helpers/render-fixture.js");
  const f = await videoFixture(t);
  await f.command(
    "timeline.update",
    {
      productionId: "main",
      utterances: ["u1", "u2", "uN"].map((utteranceId) => ({
        utteranceId,
        fixedStartMs: 0,
      })),
    },
    { aggregate: { kind: "timeline", id: "main" } },
  );
  const e = (await create(f, "overlap", "landscape")).value;
  assert.deepEqual(
    e.closure.timeline.takes.map((x) => [x.startFrame, x.endFrame]),
    [
      [0, 60],
      [0, 60],
      [0, 30],
    ],
  );
  assert.equal(e.closure.timeline.durationFrames, 60);
  assert.equal(e.closure.shots[0].startFrame, 0);
  assert.equal(e.closure.shots.at(-1).endFrame, 60);
  const { frameAt } = await import("../render/frame.js");
  assert.ok(frameAt({ edition: e, frame: 59 }).shotId);
});
