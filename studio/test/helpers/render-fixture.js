import { withAudioScene, audioTakeSlot } from "./project.js";
import { assetImport } from "./images.js";
export function tone({ seconds = 2, rate = 24000, frequency = 440 } = {}) {
  const frames = Math.round(seconds * rate),
    b = Buffer.alloc(44 + frames * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    b.writeInt16LE(
      Math.round(5000 * Math.sin((2 * Math.PI * frequency * i) / rate)),
      44 + i * 2,
    );
  return b;
}
export async function audioFixture(t) {
  const f = await withAudioScene(t);
  for (const [i, id] of ["u1", "u2", "uN"].entries()) {
    const slot = audioTakeSlot(
      `take-${id}`,
      id,
      id === "uN" ? "narrator" : "actor",
      id === "uN" ? null : "childvoice",
    );
    await assetImport(
      f,
      `audio-${id}`,
      tone({ seconds: i === 2 ? 1 : 2 }),
      slot,
      "audio",
    );
    await f.command(
      "candidate.adopt",
      {
        slotId: slot.id,
        candidateId: `audio-${id}`,
        actor: "creator",
        reason: "Diagnostic fixture",
      },
      { aggregate: { kind: "assetSlot", id: slot.id } },
    );
  }
  return f;
}

export async function videoFixture(t) {
  const { png, basePixels, environmentSlot } = await import("./images.js");
  const f = await audioFixture(t),
    slot = environmentSlot("picture");
  await assetImport(f, "picture1", await png(basePixels), slot);
  await f.command(
    "candidate.adopt",
    {
      slotId: slot.id,
      candidateId: "picture1",
      actor: "creator",
      reason: "Video fixture",
    },
    { aggregate: { kind: "assetSlot", id: slot.id } },
  );
  const scene = (await f.service.snapshot(f.projectId)).scenes[0];
  scene.shots = scene.shots.map((sh) => ({ ...sh, referenceSlotId: slot.id }));
  await f.command("scene.put", scene, {
    aggregate: { kind: "scene", id: scene.id },
  });
  return f;
}
