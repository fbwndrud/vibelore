import test from "node:test";
import assert from "node:assert/strict";
import { audioFixture } from "./helpers/render-fixture.js";
const update = (f) =>
  f.command(
    "timeline.update",
    {
      productionId: "main",
      fps: 30,
      cues: [
        {
          id: "reply",
          anchor: { utteranceId: "u1", edge: "end" },
          offsetMs: 400,
        },
      ],
    },
    { aggregate: { kind: "timeline", id: "main" } },
  );
test("timeline command derives end anchors from real selected WAV samples", async (t) => {
  const f = await audioFixture(t);
  const r = await update(f);
  assert.equal(r.value.resolved.cues[0].startFrame, 72);
  assert.equal(r.value.resolved.takes[1].startSample, 96000);
  assert.equal(r.value.resolved.durationFrames, 150);
});
test("hold-only editing preserves accepted takes and moves actual sample schedule", async (t) => {
  const f = await audioFixture(t);
  await update(f);
  await f.command(
    "utterance.update",
    { id: "u2", holdMs: 400 },
    { aggregate: { kind: "utterance", id: "u2" } },
  );
  const r = await update(f);
  assert.equal(r.value.resolved.takes[1].startSample, 115200);
  assert.equal(r.value.resolved.durationFrames, 162);
});
test("changed spoken text blocks the stale accepted take", async (t) => {
  const f = await audioFixture(t);
  await f.command(
    "utterance.update",
    { id: "u2", text: "변경된 대사" },
    { aggregate: { kind: "utterance", id: "u2" } },
  );
  await assert.rejects(update(f), { code: "SLOT_CONFLICT" });
});
test("fixed boundaries cannot silently cut actual audio or an anchored cue", async (t) => {
  const f = await audioFixture(t);
  await assert.rejects(
    f.command(
      "timeline.update",
      {
        productionId: "main",
        fps: 30,
        utterances: [{ utteranceId: "u1", fixedEndMs: 1000 }],
      },
      { aggregate: { kind: "timeline", id: "main" } },
    ),
    { code: "TIMING_CONFLICT" },
  );
});

test("shot anchors and fixed boundaries are checked by timeline.update before edition creation", async (t) => {
  const f = await audioFixture(t);
  await assert.rejects(
    f.command(
      "timeline.update",
      {
        productionId: "main",
        fps: 30,
        shots: [
          {
            shotId: "shot",
            anchor: { utteranceId: "u1", edge: "end" },
            durationMs: 1000,
            fixedEndMs: 2500,
          },
        ],
      },
      { aggregate: { kind: "timeline", id: "main" } },
    ),
    { code: "TIMING_CONFLICT" },
  );
});
test("negative fades cannot invert an actual take", async () => {
  const { resolveTimeline } = await import("../src/engine/timeline.js");
  assert.throws(
    () =>
      resolveTimeline({
        takes: [
          {
            utteranceId: "u",
            frames: 24000,
            sampleRate: 24000,
            fadeInMs: -100,
          },
        ],
      }),
    { code: "INVALID_INPUT" },
  );
});
