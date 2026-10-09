import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  withStudio,
  withAudioScene,
  generationCommand,
  validImageRequest,
} from "./helpers/project.js";
import { startStudioHttp } from "../src/transport/http.js";
import { runWorker } from "../src/engine/worker.js";
async function ui() {
  assert.ok(
    existsSync(new URL("../ui/api.js", import.meta.url)),
    "UI command client must exist",
  );
  return import("../ui/api.js");
}
test("manuscript import stores exact BOM/CRLF bytes in immutable source package", async (t) => {
  const f = await withStudio(t);
  const bytes = Buffer.from("\ufeff첫 줄\r\n두 번째 줄\r\n");
  const r = await f.command(
    "source.manuscript",
    { id: "source1", title: "원문", language: "ko", bytes: [...bytes] },
    { aggregate: { kind: "sourcePackage", id: "source1" } },
  );
  assert.equal(r.value.sourceKind, "studio-script");
  assert.deepEqual(
    Buffer.from(await f.service.readBlob("p1", r.value.blobManifest[0].blobId)),
    bytes,
  );
  assert.equal(r.value.textUnits[0].text, "첫 줄\r\n두 번째 줄\r\n");
  await assert.rejects(
    f.command(
      "source.manuscript",
      { id: "source1", title: "other", language: "ko", bytes: [65] },
      { aggregate: { kind: "sourcePackage", id: "source1" } },
    ),
    { code: "SOURCE_IMMUTABLE" },
  );
});
test("UI client updates only selected utterance through HTTP, retains drafts on progress and conflict", async (t) => {
  const { StudioAPI, Drafts, utteranceCommand } = await ui();
  const f = await withAudioScene(t);
  const server = await startStudioHttp({ service: f.service });
  t.after(server.close);
  const api = new StudioAPI({
    baseURL: server.url,
    fetchImpl: (url, init = {}) =>
      fetch(url, { ...init, headers: { ...init.headers, Origin: server.url } }),
  });
  await api.connect();
  const snapshot = await api.snapshot();
  const drafts = new Drafts();
  drafts.set("u2", { acting: "감춘다", holdMs: 800 }, 0);
  const payload = utteranceCommand(snapshot, "u2", drafts.get("u2").value);
  assert.equal(payload.aggregate.id, "u2");
  await api.command(payload);
  const s = await api.snapshot();
  assert.equal(s.scenes[0].utterances[1].acting, "감춘다");
  assert.deepEqual(s.scenes[0].utterances[0].acting, { tone: "quiet" });
  assert.equal(drafts.get("u2").value.holdMs, 800);
  await assert.rejects(
    api.command({ ...payload, commandId: crypto.randomUUID() }),
    { code: "REVISION_CONFLICT" },
  );
  assert.equal(drafts.get("u2").value.acting, "감춘다");
});
test("text proposal stays immutable and only explicit apply updates selected utterance", async (t) => {
  const f = await withAudioScene(t);
  await f.command(
    "source.manuscript",
    {
      id: "source1",
      title: "원문",
      language: "ko",
      bytes: [...Buffer.from("같은 대사")],
    },
    { aggregate: { kind: "sourcePackage", id: "source1" } },
  );
  await f.command(
    "source.rebase",
    {
      productionId: "main",
      sourcePackageId: "source1",
      actor: "creator",
      reason: "bind",
    },
    { aggregate: { kind: "sourceBinding", id: "main" } },
  );
  let s = await f.service.snapshot("p1");
  await f.command(
    "source.rebase",
    {
      productionId: "main",
      action: "apply",
      decisionId: s.sourceChanges[0].id,
      choices: [{ sceneId: "scene", action: "keep_override" }],
      actor: "creator",
      reason: "reviewed",
    },
    { aggregate: { kind: "sourceBinding", id: "main" } },
  );
  const scene = (await f.service.snapshot("p1")).scenes[0];
  scene.sourcePackageId = "source1";
  scene.sourceUnitIds = ["manuscript"];
  await f.command("scene.put", scene, {
    aggregate: { kind: "scene", id: "scene" },
  });
  const proposal = {
    sceneId: "scene",
    utteranceId: "u1",
    speakerOccurrenceId: "speaker",
    sourceUnitIds: ["manuscript"],
    text: "기다릴게.",
  };
  f.service.providers.text = {
    capabilities: async () => ({ kinds: ["text"], models: ["text-model"] }),
    generate: async () => ({
      outputs: [
        {
          mime: "application/json",
          bytes: Buffer.from(JSON.stringify(proposal)),
        },
      ],
    }),
  };
  await generationCommand(
    f,
    validImageRequest({
      provider: "text",
      kind: "text",
      target: { kind: "utterance", id: "u1" },
      input: { model: "text-model", prompt: "Selected source only" },
      recipe: { operation: "adaptation_proposal" },
    }),
  );
  await runWorker({ service: f.service, drain: true });
  s = await f.service.snapshot("p1");
  assert.equal(s.scenes[0].utterances[0].text, "같은 대사");
  assert.equal(s.candidates.length, 1);
  assert.deepEqual(s.candidates[0].proposal, proposal);
  await f.command(
    "proposal.apply",
    {
      candidateId: s.candidates[0].id,
      utteranceId: "u1",
      actor: "creator",
      reason: "검토 완료",
    },
    { aggregate: { kind: "utterance", id: "u1" } },
  );
  const after = await f.service.snapshot("p1");
  assert.equal(after.scenes[0].utterances[0].text, "기다릴게.");
  assert.equal(after.scenes[0].utterances[1].text, "같은 대사");
  assert.deepEqual(after.candidates, s.candidates);
});
test("Cast and Edit builders preserve 40 role identities and distinct occurrence states through real commands", async (t) => {
  assert.ok(
    existsSync(new URL("../ui/cast.js", import.meta.url)),
    "Cast workspace must exist",
  );
  const { filterCast, occurrenceCommand } = await import("../ui/cast.js");
  const { shotCommand } = await import("../ui/edit.js");
  const f = await withAudioScene(t);
  for (let i = 0; i < 40; i++)
    await f.command(
      "cast.put",
      {
        id: `r${i}`,
        name: `배역 ${i}`,
        language: "ko",
        characterId: `person${i}`,
        identity: { id: `person${i}`, origin: { kind: "studioLocal" } },
      },
      { aggregate: { kind: "cast", id: `r${i}` } },
    );
  let s = await f.service.snapshot("p1");
  assert.equal(filterCast(s, "배역", "all").length, 40);
  assert.equal(filterCast(s, "배역 39", "all")[0].id, "r39");
  const env = occurrenceCommand(s, "scene", {
    roleId: "r39",
    presence: "inner",
    temporalStateRef: "eventtime",
    appearanceStateRef: "adult",
    castingStateRef: "childvoice",
    knowledgeStateRef: "knowledge",
  });
  await f.service.command(env);
  s = await f.service.snapshot("p1");
  const o = s.scenes[0].occurrences.at(-1);
  assert.equal(o.characterId, "person39");
  assert.equal(o.presence, "inner");
  assert.equal(s.scenes[0].presentations.at(-1).castingStateRef, "childvoice");
  await f.service.command(
    shotCommand(s, "scene", "shot", {
      intent: "reaction",
      targetOccurrenceId: null,
      referenceSlotId: null,
      transform: {
        x: 0,
        y: 0,
        scale: 1,
        anchor: "center",
        easing: "linear",
        safeArea: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 },
        keyframes: [],
      },
    }),
  );
  assert.equal(
    (await f.service.snapshot("p1")).scenes[0].shots[0].intent,
    "reaction",
  );
  assert.equal((await f.service.snapshot("p1")).attempts.length, 0);
});
test("Asset Lab builder imports actual bytes, adopts and appends undo without deleting candidates", async (t) => {
  assert.ok(
    existsSync(new URL("../ui/asset-lab.js", import.meta.url)),
    "Asset Lab must exist",
  );
  const { importCommand, adoptCommand, undoCommand, sourcePoint } =
    await import("../ui/asset-lab.js");
  const { png } = await import("./helpers/images.js");
  const f = await withStudio(t);
  const server = await startStudioHttp({ service: f.service });
  t.after(server.close);
  const { StudioAPI } = await ui();
  const api = new StudioAPI({
    baseURL: server.url,
    fetchImpl: (url, init = {}) =>
      fetch(url, { ...init, headers: { ...init.headers, Origin: server.url } }),
  });
  await api.connect();
  let s = await api.snapshot();
  const slot = {
    id: "image-slot",
    scope: { kind: "project", id: "p1" },
    subject: { kind: "environment", id: "room" },
    appearanceStateRef: null,
  };
  await api.command(
    importCommand(
      s,
      slot,
      "image",
      new Uint8Array(await png([20, 30, 40, 255], 1, 1)),
    ),
  );
  s = await api.snapshot();
  await api.command(adoptCommand(s, s.slots[0], s.candidates[0]));
  s = await api.snapshot();
  assert.equal(s.slots[0].candidateId, s.candidates[0].id);
  await api.command(undoCommand(s, s.slots[0]));
  s = await api.snapshot();
  assert.equal(s.slots[0].candidateId, null);
  assert.equal(s.candidates.length, 1);
  assert.equal(s.adoptions.length, 2);
  assert.deepEqual(
    sourcePoint(
      { left: 10, top: 20, width: 200, height: 100 },
      110,
      70,
      1000,
      500,
    ),
    { x: 500, y: 250 },
  );
});
test("cited multi-speaker script fills an empty scene only after explicit proposal apply and rejects unknown speakers", async (t) => {
  const f = await withAudioScene(t);
  await f.command(
    "source.manuscript",
    {
      id: "source1",
      title: "원문",
      language: "ko",
      bytes: [...Buffer.from("밤이 깊었다. 여기서 기다릴게.")],
    },
    { aggregate: { kind: "sourcePackage", id: "source1" } },
  );
  await f.command("production.create", {
    id: "adaptation",
    title: "각색",
    sourcePackageId: "source1",
  });
  const original = (await f.service.snapshot("p1")).scenes[0];
  const scene = {
    ...original,
    id: "blank",
    productionId: "adaptation",
    sourcePackageId: "source1",
    sourceUnitIds: ["manuscript"],
    occurrences: original.occurrences.map((o) => ({ ...o, id: `new-${o.id}` })),
    presentations: original.presentations.map((p) => ({
      ...p,
      occurrenceId: `new-${p.occurrenceId}`,
    })),
    utterances: [],
    shots: [],
  };
  await f.command("scene.put", scene, {
    aggregate: { kind: "scene", id: "blank" },
  });
  const proposal = {
    sceneId: "blank",
    sourceUnitIds: ["manuscript"],
    utterances: [
      {
        id: "line1",
        speakerOccurrenceId: "new-narration",
        text: "밤이 깊었다.",
        sourceUnitIds: ["manuscript"],
      },
      {
        id: "line2",
        speakerOccurrenceId: "new-speaker",
        text: "여기서 기다릴게.",
        sourceUnitIds: ["manuscript"],
      },
    ],
  };
  let output = proposal;
  f.service.providers.text = {
    capabilities: async () => ({ kinds: ["text"], models: ["text-model"] }),
    generate: async () => ({
      outputs: [
        {
          mime: "application/json",
          bytes: Buffer.from(JSON.stringify(output)),
        },
      ],
    }),
  };
  const payload = () =>
    validImageRequest({
      provider: "text",
      kind: "text",
      target: { kind: "scene", id: "blank" },
      input: { model: "text-model", prompt: "Allowed selected manuscript" },
      recipe: { operation: "scene_adaptation_proposal" },
    });
  await generationCommand(f, payload());
  await runWorker({ service: f.service, drain: true });
  let s = await f.service.snapshot("p1");
  assert.equal(s.scenes.find((x) => x.id === "blank").utterances.length, 0);
  assert.equal(s.candidates.length, 1);
  await f.command(
    "proposal.apply",
    {
      candidateId: s.candidates[0].id,
      sceneId: "blank",
      actor: "creator",
      reason: "전문 검토",
    },
    { aggregate: { kind: "scene", id: "blank" } },
  );
  s = await f.service.snapshot("p1");
  assert.deepEqual(
    s.scenes.find((x) => x.id === "blank").utterances.map((u) => u.text),
    ["밤이 깊었다.", "여기서 기다릴게."],
  );
  assert.equal(s.candidates[0].proposal.utterances.length, 2);
  const { proposalApplied } = await import("../ui/story.js");
  assert.equal(proposalApplied(s, s.candidates[0]), true);
  output = {
    ...proposal,
    utterances: [
      {
        ...proposal.utterances[0],
        id: "line3",
        speakerOccurrenceId: "invented-person",
      },
    ],
  };
  await generationCommand(f, { ...payload(), intent: "fresh_variation" });
  await runWorker({ service: f.service, drain: true });
  s = await f.service.snapshot("p1");
  assert.equal(s.candidates.length, 1);
  assert.equal(s.attempts.at(-1).validationStatus, "quarantined");
});
test("shot intent rejects invalid transform units and unavailable reference scope through engine", async (t) => {
  const f = await withAudioScene(t);
  const s = await f.service.snapshot("p1");
  const scene = s.scenes[0];
  await assert.rejects(
    f.command(
      "scene.put",
      {
        ...scene,
        shots: [
          {
            id: "shot",
            transform: {
              x: 0,
              y: 0,
              scale: -1,
              safeArea: { left: 0, top: 0, right: 0, bottom: 0 },
              anchor: "center",
              easing: "linear",
              keyframes: [],
            },
          },
        ],
      },
      { aggregate: { kind: "scene", id: "scene" } },
    ),
    { code: "INVALID_SHOT_TRANSFORM" },
  );
  await assert.rejects(
    f.command(
      "scene.put",
      { ...scene, shots: [{ id: "shot", referenceSlotId: "missing" }] },
      { aggregate: { kind: "scene", id: "scene" } },
    ),
    { code: "INVALID_REFERENCE" },
  );
});
test("audio slot candidate picker excludes same-scene images and displays only actual audio takes", async () => {
  const { slotCandidates } = await import("../ui/asset-lab.js");
  assert.equal(typeof slotCandidates, "function");
  const candidates = [
    { id: "image", mediaKind: "image", target: { kind: "scene", id: "scene" } },
    {
      id: "audio",
      mediaKind: "audio",
      slotId: "audio-slot",
      target: { kind: "scene", id: "scene" },
    },
  ];
  assert.deepEqual(
    slotCandidates(candidates, {
      id: "audio-slot",
      mediaKind: "audio",
      scope: { kind: "scene", id: "scene" },
      utteranceId: "u1",
    }).map((c) => c.id),
    ["audio"],
  );
});
test("scene adaptation builder sends only selected source, known speakers, and a schema-bound durable request", async (t) => {
  const { sceneAdaptationRequest } = await import("../ui/story.js");
  const f = await withAudioScene(t);
  let s = await f.service.snapshot("p1");
  const scene = {
    ...s.scenes[0],
    sourcePackageId: "pkg",
    sourceUnitIds: ["allowed"],
  };
  s = {
    ...s,
    sourcePackages: [
      {
        id: "pkg",
        textUnits: [
          { id: "allowed", text: "visible source" },
          { id: "future", text: "SECRET FUTURE" },
        ],
      },
    ],
  };
  const r = sceneAdaptationRequest(s, scene, {
    model: "gemini-3.8-flash",
    estimateMicros: 1000,
    direction: "quiet",
  });
  assert.equal(r.payload.target.kind, "scene");
  assert.equal(r.payload.recipe.operation, "scene_adaptation_proposal");
  assert.match(r.payload.input.prompt, /visible source/);
  assert.ok(!r.payload.input.prompt.includes("SECRET FUTURE"));
  assert.deepEqual(
    r.payload.input.config.schema.properties.utterances.items.properties
      .speakerOccurrenceId.enum,
    ["speaker", "narration"],
  );
});

test('production progress does not report a WAV export as a completed landscape video', async t => {
  const { audioFixture } = await import('./helpers/render-fixture.js');
  const { productionProgress } = await import('../ui/workflow.js');
  const f = await audioFixture(t);
  await f.command('edition.create',{id:'audio-only',productionId:'main',profile:'audio'},{aggregate:{kind:'edition',id:'audio-only'}});
  const rendered = await f.command('edition.render',{editionId:'audio-only',renderId:'audio-output'},{aggregate:{kind:'editionOutput',id:'audio-output'}});
  assert.equal(rendered.value.status,'completed');
  const s = await f.service.snapshot('p1');
  assert.equal(productionProgress(s,'main','landscape').currentOutputs.length,0);
  assert.equal(productionProgress(s,'main','audio').currentOutputs.length,1);
});
