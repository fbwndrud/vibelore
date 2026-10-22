import test from "node:test";
import assert from "node:assert/strict";
import { frameAt } from "../render/frame.js";

export const performanceShot = () => ({
  id: "shot",
  startFrame: 0,
  endFrame: 30,
  layout: { width: 200, height: 100 },
  layers: [
    {
      id: "front",
      slotId: "a",
      z: 2,
      anchor: { x: 0.5, y: 0.5 },
      transform: { x: -0.25, y: 0, scale: 0.2 },
      selection: { blobId: "red", metadata: { width: 100, height: 100 } },
      keyframes: [{ frame: 10, x: 0, opacity: 0.5 }],
      poseCues: [
        {
          frame: 10,
          slotId: "b",
          expression: "surprise",
          gaze: "left",
          selection: { blobId: "blue", metadata: { width: 100, height: 100 } },
        },
      ],
    },
    {
      id: "back",
      slotId: "c",
      z: 0,
      anchor: { x: 0, y: 0 },
      transform: { x: 0, y: 0 },
      selection: { blobId: "white", metadata: { width: 200, height: 100 } },
    },
    {
      id: "follower",
      slotId: "d",
      z: 1,
      anchor: { x: 0, y: 0 },
      transform: { x: 0.1, y: 0, scale: 0.1 },
      selection: { blobId: "green", metadata: { width: 100, height: 100 } },
      contact: { targetLayerId: "front", anchor: { x: 1, y: 0.5 } },
    },
  ],
});
const edition = (shot) => ({
  closure: {
    profile: { fps: 30, width: 200, height: 100 },
    shots: [shot],
    timeline: { sampleRate: 48000, takes: [] },
  },
});
test("preview selects exact poses and independently evaluates linear movement, z, alpha and contact anchors", async () => {
  const shot = performanceShot();
  const before = JSON.stringify(shot);
  const view = frameAt({ edition: edition(shot), frame: 5 });
  assert.deepEqual(
    view.layers.map((l) => l.blobId),
    ["white", "green", "red"],
  );
  assert.equal(view.layers[2].transform.x, 0.375);
  assert.equal(view.layers[2].transform.opacity, 0.75);
  assert.equal(view.layers[1].transform.x, 0.525);
  const after = frameAt({ edition: edition(shot), frame: 10 });
  assert.equal(after.layers[2].blobId, "blue");
  assert.equal(after.layers[2].expression, "surprise");
  assert.equal(after.layers[2].transform.x, 0.5);
  assert.equal(JSON.stringify(shot), before);
  const { evaluatePerformance } = await import("../src/render/performance.js");
  assert.deepEqual(after.layers, evaluatePerformance({ shot, frame: 10 }));
});

import {
  layeredFixture,
  createLayerEdition,
} from "./helpers/character-layers.js";
test("scene validates explicit layer identities, finite geometry, unique IDs and acyclic contacts", async (t) => {
  const f = await layeredFixture(t);
  const bads = [
    (s) => {
      s.shots[0].layers[1].occurrenceId = "missing";
    },
    (s) => {
      delete s.shots[0].layers[1].occurrenceId;
    },
    (s) => {
      s.shots[0].layers[1].slotId = "white";
    },
    (s) => {
      s.shots[0].layers[1].transform.scale = NaN;
    },
    (s) => {
      s.shots[0].layers[1].id = "background";
    },
    (s) => {
      s.shots[0].layers[1].contact = {
        targetLayerId: "missing",
        anchor: { x: 0, y: 0 },
      };
    },
    (s) => {
      s.shots[0].layers[1].contact = {
        targetLayerId: "other",
        anchor: { x: 0, y: 0 },
      };
      s.shots[0].layers[2].contact = {
        targetLayerId: "actor",
        anchor: { x: 0, y: 0 },
      };
    },
  ];
  for (const change of bads) {
    const scene = structuredClone(f.scene);
    change(scene);
    await assert.rejects(
      f.command("scene.put", scene, {
        aggregate: { kind: "scene", id: scene.id },
      }),
    );
  }
  const e = (await createLayerEdition(f)).value;
  assert.equal(
    e.closure.shots[0].layers[1].poseCues[0].selection.candidateId,
    "blue",
  );
  assert.equal(e.closure.performanceVersion, "layers-v1");
  const scene = structuredClone(f.scene);
  scene.shots[0].layers[1].poseCues[0].frame = 15;
  await f.command("scene.put", scene, {
    aggregate: { kind: "scene", id: scene.id },
  });
  await assert.rejects(createLayerEdition(f, "outside"), {
    code: "TIMING_CONFLICT",
  });
});

import { createStudioOwnerAdapter } from "../src/source/export-studio-assets.js";
test("owner exports actually accepted pose use and maps exact identity/state into a second project", async (t) => {
  const source = await layeredFixture(t);
  const { assetImport, png } = await import("./helpers/images.js");
  const wideSlot = {
    id: "blue",
    scope: { kind: "project", id: "p1" },
    subject: { kind: "identity", id: "char" },
    appearanceStateRef: "adult",
  };
  await assetImport(
    source,
    "blue-wide",
    await png([0, 0, 255, 255, 0, 0, 255, 255], 2, 1),
    wideSlot,
  );
  await source.command(
    "candidate.adopt",
    {
      slotId: "blue",
      candidateId: "blue-wide",
      actor: "artist",
      reason: "Exact selected wide pose",
    },
    { aggregate: { kind: "assetSlot", id: "blue" } },
  );
  await createLayerEdition(source);
  const adapter = createStudioOwnerAdapter({
    locator: { directory: source.directory },
    ownerId: "pose-owner",
    allowedProjects: ["p1"],
  });
  const captured = await adapter.capture();
  const entry = captured.entries.find(
    (e) => e.ref.recordKind === "candidate" && e.ref.recordId === "blue-wide",
  );
  assert.deepEqual(entry.roles, ["pose"]);
  assert.deepEqual(
    captured.entries.find(
      (e) => e.ref.recordKind === "candidate" && e.ref.recordId === "blue",
    ).roles,
    ["identity-reference"],
  );
  const data = await adapter.exportExact({ roots: [entry.ref] });
  const destination = await layeredFixture(t);
  const slot = {
    id: "imported-pose",
    scope: { kind: "project", id: "p1" },
    subject: { kind: "identity", id: "char" },
    appearanceStateRef: "adult",
  };
  const subject = entry.subjects[0];
  assert.equal(subject.identityId, "char");
  assert.equal(subject.stateRefs.length, 1);
  const intent = {
    target: { kind: "assetSlot", id: slot.id },
    purpose: "Exact pose reuse",
    identityMap: [{ source: subject, destinationIdentityId: "char" }],
    stateMap: subject.stateRefs.map((source) => ({
      source,
      destinationStateId: "adult",
    })),
    selections: [{ source: entry.ref, slot, role: "pose" }],
  };
  const inspection = await destination.service.inspectReuse({
    projectId: "p1",
    ...data,
    intent,
  });
  assert.equal(inspection.disposition, "compatible");
  const imported = (
    await destination.command(
      "asset.importBundle",
      {
        ...data,
        intent,
        inspectionDigest: inspection.inspectionDigest,
        actor: "artist",
        reason: "Explicit mapped pose",
      },
      { aggregate: intent.target },
    )
  ).value;
  assert.equal(imported.candidate.reuseRole, "pose");
  await destination.command(
    "candidate.adopt",
    {
      slotId: slot.id,
      candidateId: imported.candidate.id,
      actor: "artist",
      reason: "Accepted exact pose",
    },
    { aggregate: intent.target },
  );
  await destination.command(
    "asset.derive",
    {
      id: "pose-crop",
      slotId: slot.id,
      baseCandidateId: imported.candidate.id,
      operation: "crop",
      rect: { left: 0, top: 0, width: 1, height: 1 },
      actor: "artist",
    },
    { aggregate: intent.target },
  );
  await destination.command(
    "candidate.adopt",
    {
      slotId: slot.id,
      candidateId: "pose-crop",
      actor: "artist",
      reason: "Accepted exact crop",
    },
    { aggregate: intent.target },
  );
  const scene = destination.scene;
  scene.shots[0].layers[1].poseCues[0].slotId = slot.id;
  await destination.command("scene.put", scene, {
    aggregate: { kind: "scene", id: scene.id },
  });
  const frozen = (await createLayerEdition(destination)).value;
  const selected = frozen.closure.shots[0].layers[1].poseCues[0].selection;
  assert.equal(selected.candidate.reuseRole, "pose");
  assert.notEqual(selected.blobId, imported.candidate.canonicalBlobId);
  assert.ok(
    frozen.closure.blobIds.includes(imported.candidate.canonicalBlobId),
  );
  assert.ok(frozen.closure.blobIds.includes(selected.blobId));
  assert.ok(
    frozen.closure.blobIds.includes(
      imported.candidate.reuseProvenance.localManifestBlobId,
    ),
  );
  await destination.service.collectGarbage("p1", { graceMs: 0 });
  const { join } = await import("node:path");
  const { restoreStudioBackup } = await import("../src/engine/backup.js");
  const archive = (await destination.command("project.backup", {})).value
    .archive;
  const restored = await restoreStudioBackup({
    archive: join(destination.directory, archive),
    directory: join(destination.directory, "restored"),
  });
  t.after(() => restored.close());
  assert.deepEqual(
    (await restored.snapshot("p1")).editions.find((e) => e.id === "layers"),
    frozen,
  );
  for (const id of frozen.closure.blobIds)
    assert.ok((await restored.readBlob("p1", id)).length);
});

test("retained image roles survive derivation; accepted identity baselines and scene images never bypass pose-cue roles", async (t) => {
  const { bundleFixture, ref, pngSha256 } = await import(
    "./helpers/bundles.js"
  );
  for (const role of [
    "style-reference",
    "edit-target",
    "identity-reference",
    "final-scene",
  ]) {
    const f = await layeredFixture(t),
      source = ref(),
      state = ref({ recordKind: "state", recordId: "appearance" }),
      subject = {
        ownerId: source.ownerId,
        projectId: source.projectId,
        identityId: "hero",
        stateRefs: [state],
      };
    const data = bundleFixture({
      records: [
        {
          ref: source,
          metadata: {
            mediaKind: "image",
            roles: [role],
            subjects: role === "final-scene" ? [] : [subject],
            selectedContentSha256: pngSha256,
          },
          requiredFileSha256s: [pngSha256],
          sourcePins: {},
          evidenceRefs: [],
        },
      ],
    });
    const slot =
      role === "final-scene"
        ? {
            id: "reference",
            scope: { kind: "project", id: "p1" },
            subject: { kind: "environment", id: "stage" },
            appearanceStateRef: null,
          }
        : {
            id: "reference",
            scope: { kind: "project", id: "p1" },
            subject: { kind: "identity", id: "char" },
            appearanceStateRef: "adult",
          };
    const intent = {
      target: { kind: "assetSlot", id: slot.id },
      purpose: "Preserve reference role",
      identityMap:
        role === "final-scene"
          ? []
          : [{ source: subject, destinationIdentityId: "char" }],
      stateMap:
        role === "final-scene"
          ? []
          : [{ source: state, destinationStateId: "adult" }],
      selections: [{ source, slot, role }],
    };
    const inspection = await f.service.inspectReuse({
      projectId: "p1",
      ...data,
      intent,
    });
    assert.equal(
      inspection.disposition,
      "compatible",
      JSON.stringify({ role, inspection }),
    );
    const imported = (
      await f.command(
        "asset.importBundle",
        {
          ...data,
          intent,
          inspectionDigest: inspection.inspectionDigest,
          actor: "artist",
          reason: "Reference only",
        },
        { aggregate: intent.target },
      )
    ).value.candidate;
    await f.command(
      "candidate.adopt",
      {
        slotId: slot.id,
        candidateId: imported.id,
        actor: "artist",
        reason: "Select reference",
      },
      { aggregate: intent.target },
    );
    const derived = (
      await f.command(
        "asset.derive",
        {
          id: "cropped-reference",
          slotId: slot.id,
          baseCandidateId: imported.id,
          operation: "crop",
          rect: { left: 0, top: 0, width: 1, height: 1 },
          actor: "artist",
        },
        { aggregate: intent.target },
      )
    ).value.candidate;
    assert.equal(derived.reuseRole, role);
    await f.command(
      "candidate.adopt",
      {
        slotId: slot.id,
        candidateId: derived.id,
        actor: "artist",
        reason: "Select derivative",
      },
      { aggregate: intent.target },
    );
    f.scene.shots[0].layers[role === "final-scene" ? 0 : 1].slotId = slot.id;
    await f.command("scene.put", f.scene, {
      aggregate: { kind: "scene", id: f.scene.id },
    });
    if (["identity-reference", "final-scene"].includes(role)) {
      await createLayerEdition(f);
      if (role === "identity-reference") {
        const adapter = createStudioOwnerAdapter({
          locator: { directory: f.directory },
          ownerId: "retained-owner",
          allowedProjects: ["p1"],
        });
        const entry = (await adapter.capture()).entries.find(
          (e) =>
            e.ref.recordKind === "candidate" && e.ref.recordId === derived.id,
        );
        assert.deepEqual(entry.roles, ["pose"]);
        const exported = await adapter.exportExact({ roots: [entry.ref] });
        const record = exported.bundle.records.find(
          (r) => r.ref.recordId === derived.id,
        );
        assert.deepEqual(record.metadata.previousRoles, ["identity-reference"]);
        assert.equal(record.sourcePins.reuseRole, "identity-reference");
        f.scene.shots[0].layers[1].poseCues[0].slotId = slot.id;
        await f.command("scene.put", f.scene, {
          aggregate: { kind: "scene", id: f.scene.id },
        });
        await assert.rejects(createLayerEdition(f, "forbidden-cue"), {
          code: "INVALID_REFERENCE",
        });
      }
    } else
      await assert.rejects(createLayerEdition(f), {
        code: "INVALID_REFERENCE",
      });
    if (!["identity-reference", "final-scene"].includes(role)) {
      f.scene.shots = [{ id: "layer-shot", referenceSlotId: slot.id }];
      await f.command("scene.put", f.scene, {
        aggregate: { kind: "scene", id: f.scene.id },
      });
      await assert.rejects(createLayerEdition(f), {
        code: "INVALID_REFERENCE",
      });
    }
  }
});

test("contact uses rotated non-square pixel geometry; pose aspect changes keep the anchor fixed", async () => {
  const { evaluatePerformance } = await import("../src/render/performance.js");
  const shot = performanceShot();
  shot.layers[0].transform = { x: 0, y: 0, scale: 0.2, rotation: Math.PI / 2 };
  shot.layers[0].keyframes = [];
  shot.layers[0].poseCues[0].selection.metadata = { width: 200, height: 100 };
  const first = evaluatePerformance({ shot, frame: 0 }),
    next = evaluatePerformance({ shot, frame: 10 });
  assert.ok(Math.abs(first[1].transform.x - 0.6) < 1e-10);
  assert.ok(Math.abs(first[1].transform.y - 0.6) < 1e-10);
  assert.equal(next[2].transform.x, 0.5);
  assert.equal(next[2].transform.y, 0.5);
  assert.ok(Math.abs(next[1].transform.y - 0.7) < 1e-10);
});

test("actual short multilayer MP4 decodes exact pose frame, movement and transparent alpha composition", async (t) => {
  const f = await layeredFixture(t);
  f.scene.shots[0].transform = {
    x: 0.05,
    y: 0,
    scale: 1,
    anchor: "center",
    easing: "linear",
    keyframes: [],
    safeArea: { left: 0, top: 0, right: 0, bottom: 0 },
  };
  await f.command("scene.put", f.scene, {
    aggregate: { kind: "scene", id: f.scene.id },
  });
  const { writeFile } = await import("node:fs/promises"),
    { join } = await import("node:path");
  const { run } = await import("../src/render/probe.js");
  for (const profile of ["landscape", "portrait"]) {
    const e = (
      await f.command(
        "edition.create",
        { id: profile, productionId: "main", profile },
        { aggregate: { kind: "edition", id: profile } },
      )
    ).value;
    assert.equal(frameAt({ edition: e, frame: 10 }).camera.x, 0.05);
    const out = (
      await f.command(
        "edition.render",
        { editionId: e.id, renderId: profile },
        { aggregate: { kind: "editionOutput", id: profile } },
      )
    ).value;
    assert.equal(out.status, "completed", JSON.stringify(out));
    assert.equal(out.manifest.checks.decodedVideo, true);
    const video = out.manifest.streams.find((s) => s.type === "video");
    assert.equal(video.frames, 15);
    assert.equal(out.manifest.durationSeconds, 0.5);
    const { width, height } = e.closure.profile;
    assert.equal(video.width, width);
    assert.equal(video.height, height);
    const path = join(f.directory, `layers-${profile}.mp4`);
    const bytes = await f.service.readBlob("p1", out.manifest.output.blobId);
    await writeFile(path, bytes);
    const { stdout } = await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        path,
        "-vf",
        "select='eq(n,0)+eq(n,9)+eq(n,10)'",
        "-vsync",
        "0",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ],
      { encoding: "buffer", maxBuffer: 12 * 1024 * 1024 },
    );
    assert.equal(stdout.length, width * height * 3 * 3);
    const pixel = (frame, x, y) => [
      ...stdout.subarray(
        (frame * width * height + Math.round(y) * width + Math.round(x)) * 3,
        (frame * width * height + Math.round(y) * width + Math.round(x)) * 3 +
          3,
      ),
    ];
    // y=.25 is above the caption gradient. Both actors have real PNG alpha.
    const red = pixel(0, width * 0.3, height * 0.25);
    assert.ok(
      red[0] > 240 &&
        red[1] > 115 &&
        red[1] < 140 &&
        red[2] > 115 &&
        red[2] < 140,
      JSON.stringify(red),
    );
    const old = pixel(1, width * 0.525, height * 0.25);
    assert.ok(old[0] > 240 && old[1] > 115 && old[1] < 140);
    const blue = pixel(
      2,
      width * 0.55 - Math.min(width, height) * 0.08,
      height * 0.25,
    );
    assert.ok(
      blue[0] < 15 && blue[1] < 15 && blue[2] > 240,
      JSON.stringify(blue),
    );
    const green = pixel(
      2,
      width * 0.65 + Math.min(width, height) * 0.1,
      height * 0.25,
    );
    assert.ok(
      green[0] > 115 &&
        green[0] < 140 &&
        green[1] > 240 &&
        green[2] > 115 &&
        green[2] < 140,
      JSON.stringify(green),
    );
    if (profile === "portrait") {
      const overlap = pixel(2, width * 0.65, height * 0.25);
      assert.ok(
        overlap[0] < 15 &&
          overlap[1] > 115 &&
          overlap[1] < 140 &&
          overlap[2] > 115 &&
          overlap[2] < 140,
        JSON.stringify(overlap),
      );
    }
    await run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      path,
      "-vf",
      "select=eq(n\\,10)",
      "-frames:v",
      "1",
      join(f.directory, `layers-${profile}-frame10.png`),
    ]);
  }
});

test("missing acceptance, wrong state/identity and out-of-shot keys fail; genre/style and offscreen coordinates impose no presets", async (t) => {
  const f = await layeredFixture(t);
  const { assetImport, png } = await import("./helpers/images.js");
  await assetImport(f, "waiting", await png([255, 0, 0, 255], 1, 1), {
    id: "waiting",
    scope: { kind: "project", id: "p1" },
    subject: { kind: "identity", id: "char" },
    appearanceStateRef: "adult",
  });
  const scene = structuredClone(f.scene);
  scene.shots[0].layers[1].poseCues[0].slotId = "waiting";
  await f.command("scene.put", scene, {
    aggregate: { kind: "scene", id: scene.id },
  });
  await assert.rejects(createLayerEdition(f));
  for (const mutate of [
    (s) => (s.presentations[0].appearanceStateRef = "childvoice"),
    (s) => (s.shots[0].layers[1].occurrenceId = "speaker"),
  ]) {
    const invalid = structuredClone(f.scene);
    mutate(invalid);
    await assert.rejects(
      f.command("scene.put", invalid, {
        aggregate: { kind: "scene", id: invalid.id },
      }),
      { code: "INVALID_REFERENCE" },
    );
  }
  const valid = structuredClone(f.scene);
  valid.genre = "Any unlisted genre";
  valid.style = "Any unlisted style";
  valid.shots[0].layers[1].transform.x = -2;
  valid.shots[0].layers[1].anchor.x = 1.2;
  await f.command("scene.put", valid, {
    aggregate: { kind: "scene", id: valid.id },
  });
  await createLayerEdition(f, "unrestricted");
  valid.shots[0].layers[1].keyframes = [{ frame: 15, x: 0 }];
  await f.command("scene.put", valid, {
    aggregate: { kind: "scene", id: valid.id },
  });
  await assert.rejects(createLayerEdition(f, "out-key"), {
    code: "TIMING_CONFLICT",
  });
});

test("preview readiness recognizes accepted layer/pose sets and explicit silent timing", async (t) => {
  const { previewReadiness } = await import("../ui/player.js");
  const f = await layeredFixture(t);
  const snapshot = await f.service.snapshot("p1");
  assert.equal(previewReadiness(snapshot, "main", "landscape").ready, true);
  snapshot.slots = snapshot.slots.filter((s) => s.id !== "blue");
  assert.equal(previewReadiness(snapshot, "main", "landscape").ready, false);
});

test("drawFrame uses the same evaluated ordered image set with one camera around the complete stack", async () => {
  const { drawFrame } = await import("../render/frame.js");
  const { performanceImageIds } = await import("../src/render/performance.js");
  const shot = performanceShot();
  shot.transform = { x: 0.1, y: 0, scale: 1.2 };
  const e = edition(shot),
    calls = [],
    stack = [];
  const ctx = {
    globalAlpha: 1,
    save() {
      stack.push(this.globalAlpha);
      calls.push(["save"]);
    },
    restore() {
      this.globalAlpha = stack.pop();
      calls.push(["restore"]);
    },
    clearRect() {},
    fillRect() {},
    translate(...v) {
      calls.push(["translate", ...v]);
    },
    scale(...v) {
      calls.push(["scale", ...v]);
    },
    rotate(...v) {
      calls.push(["rotate", ...v]);
    },
    drawImage(img, ...v) {
      calls.push(["image", img.id, this.globalAlpha, ...v]);
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
  };
  const assets = new Map(
    performanceImageIds([shot]).map((id) => [
      id,
      { id, width: 100, height: 100 },
    ]),
  );
  assert.deepEqual([...assets.keys()], ["red", "blue", "white", "green"]);
  const view = drawFrame(ctx, { edition: e, frame: 10, assets });
  assert.deepEqual(view, frameAt({ edition: e, frame: 10 }));
  assert.deepEqual(
    calls.filter((c) => c[0] === "image").map((c) => c[1]),
    view.layers.map((l) => l.blobId),
  );
  assert.equal(calls.filter((c) => c[0] === "scale").length, 1);
  assert.deepEqual(
    calls.filter((c) => c[0] === "image").map((c) => c[2]),
    [1, 1, 0.5],
  );
  assert.equal(stack.length, 0);
});

test("native role-bound image uses pinned character identity before pose evidence; characterless roles stay environmental", async (t) => {
  const f = await layeredFixture(t);
  const { assetImport, png } = await import("./helpers/images.js");
  for (const [id, role, state] of [
    ["role-portrait", "actor", "adult"],
    ["characterless", "narrator", null],
  ]) {
    const slot = {
      id,
      scope: { kind: "project", id: "p1" },
      subject: { kind: "role", id: role },
      appearanceStateRef: state,
    };
    await assetImport(f, id, await png([255, 0, 0, 128], 1, 1), slot);
    await f.command(
      "candidate.adopt",
      {
        slotId: id,
        candidateId: id,
        actor: "artist",
        reason: "Accepted native role image",
      },
      { aggregate: { kind: "assetSlot", id } },
    );
  }
  const adapter = createStudioOwnerAdapter({
    locator: { directory: f.directory },
    ownerId: "native-role-owner",
    allowedProjects: ["p1"],
  });
  const before = await adapter.capture();
  const find = (entries, id) =>
    entries.find(
      (e) => e.ref.recordKind === "candidate" && e.ref.recordId === id,
    );
  assert.deepEqual(find(before.entries, "role-portrait").roles, [
    "identity-reference",
  ]);
  assert.equal(
    find(before.entries, "role-portrait").subjects[0].identityId,
    "char",
  );
  assert.deepEqual(find(before.entries, "characterless").roles, [
    "environment-reference",
  ]);
  assert.deepEqual(find(before.entries, "characterless").subjects, []);
  f.scene.shots[0].layers[1].slotId = "role-portrait";
  await f.command("scene.put", f.scene, {
    aggregate: { kind: "scene", id: f.scene.id },
  });
  await createLayerEdition(f);
  const after = find((await adapter.capture()).entries, "role-portrait");
  assert.deepEqual(after.roles, ["pose"]);
  const exported = await adapter.exportExact({ roots: [after.ref] });
  const record = exported.bundle.records.find(
    (r) => r.ref.recordId === "role-portrait",
  );
  assert.deepEqual(record.metadata.previousRoles, ["identity-reference"]);
  assert.equal(record.metadata.subjects[0].identityId, "char");
  assert.equal(record.metadata.subjects[0].stateRefs.length, 1);
  assert.ok(record.metadata.poseUses.length);
});

test("finite inputs cannot produce non-finite composed layer corners", async () => {
  const { evaluatePerformance } = await import("../src/render/performance.js");
  const shot = performanceShot();
  shot.layers = [
    {
      ...shot.layers[0],
      keyframes: [],
      poseCues: [],
      transform: {
        x: (Number.MAX_VALUE * 0.75) / shot.layout.width,
        y: 0,
        scale: Number.MAX_VALUE / 100,
      },
    },
  ];
  assert.throws(() => evaluatePerformance({ shot, frame: 0 }), {
    code: "INVALID_INPUT",
  });
});
