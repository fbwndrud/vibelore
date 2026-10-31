import { withAudioScene } from "./project.js";
import { assetImport, png, environmentSlot } from "./images.js";
export async function layeredFixture(t) {
  const f = await withAudioScene(t);
  const scene = (await f.service.snapshot(f.projectId)).scenes[0];
  scene.id = "layer-scene";
  scene.utterances = [];
  scene.shots = [];
  scene.occurrences = [
    { ...scene.occurrences[0], id: "lead", presence: "onscreen" },
  ];
  scene.presentations = [{ ...scene.presentations[0], occurrenceId: "lead" }];
  scene.occurrences.push({
    id: "second",
    roleBindingId: "actor",
    characterId: "char",
    presence: "onscreen",
  });
  scene.presentations.push({
    occurrenceId: "second",
    appearanceStateRef: "adult",
  });
  await f.command("scene.put", scene, {
    aggregate: { kind: "scene", id: scene.id },
  });
  for (const [id, pixels] of [
    ["red", [255, 0, 0, 128]],
    ["blue", [0, 0, 255, 255]],
    ["green", [0, 255, 0, 128]],
    ["white", [255, 255, 255, 255]],
  ]) {
    const slot =
      id === "white"
        ? environmentSlot(id)
        : {
            id,
            scope: { kind: "project", id: "p1" },
            subject: { kind: "identity", id: "char" },
            appearanceStateRef: "adult",
          };
    await assetImport(f, id, await png(pixels, 1, 1), slot);
    await f.command(
      "candidate.adopt",
      {
        slotId: id,
        candidateId: id,
        actor: "artist",
        reason: "Explicit exact pose selection",
      },
      { aggregate: { kind: "assetSlot", id } },
    );
  }
  scene.shots = [
    {
      id: "layer-shot",
      layers: [
        { id: "background", slotId: "white", z: 0, anchor: { x: 0.5, y: 0.5 } },
        {
          id: "actor",
          slotId: "red",
          occurrenceId: "lead",
          z: 1,
          anchor: { x: 0.5, y: 0.5 },
          transform: { x: -0.25, y: -0.25, scale: 0.25 },
          keyframes: [{ frame: 10, x: 0 }],
          poseCues: [{ frame: 10, slotId: "blue", expression: "surprise" }],
        },
        {
          id: "other",
          slotId: "green",
          occurrenceId: "second",
          z: 2,
          anchor: { x: 0.5, y: 0.5 },
          transform: { x: 0.25, y: -0.25, scale: 0.25 },
          keyframes: [{ frame: 10, x: 0.1 }],
        },
      ],
    },
  ];
  await f.command("scene.put", scene, {
    aggregate: { kind: "scene", id: scene.id },
  });
  // Select no speech: scene is explicitly timed without synthetic speech assets.
  await f.command(
    "timeline.update",
    {
      productionId: "main",
      sceneIds: [scene.id],
      utterances: [],
      sceneDurations: [{ sceneId: scene.id, durationMs: 500 }],
    },
    { aggregate: { kind: "timeline", id: "main" } },
  );
  return { ...f, scene };
}
export const createLayerEdition = (f, id = "layers") =>
  f.command(
    "edition.create",
    { id, productionId: "main", profile: "landscape" },
    { aggregate: { kind: "edition", id } },
  );
