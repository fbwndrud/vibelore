// Optional companion to the diagnostic fixture. Uses already installed macOS
// voices only; no provider adapter, API key, network request or voice download.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStudio } from "../src/engine/index.js";
import { run } from "../src/render/probe.js";
const directory = fileURLToPath(new URL("../local-demo/", import.meta.url)),
  projectId = "night-stop";
const service = await openStudio({
  directory: join(directory, "project"),
  providers: {},
});
async function cmd(type, kind, id, payload) {
  return (
    await service.command({
      projectId,
      commandId: randomUUID(),
      aggregate: { kind, id },
      expectedRevision: service.store.aggregate(projectId, { kind, id })
        .revision,
      type,
      payload,
    })
  ).value;
}
try {
  const base = JSON.parse(
    await readFile(join(directory, "landscape-closure.json"), "utf8"),
  ).closure;
  const origin = base.scenes[0];
  const voices = {
    seoyun: "Yuna",
    minjae: "Eddy (한국어(대한민국))",
    eunseo: "Flo (한국어(대한민국))",
    doyun: "Reed (한국어(대한민국))",
    narrator: "Yuna",
    driver: "Grandpa (한국어(대한민국))",
  };
  const installed = (await run("/usr/bin/say", ["-v", "?"])).stdout;
  for (const voice of Object.values(voices))
    if (!installed.includes(voice))
      throw Error("Required local voice is not installed.");
  if (
    !service.store.aggregate(projectId, { kind: "production", id: "spoken" })
      .revision
  ) {
    await cmd("production.create", "production", "spoken", {
      id: "spoken",
      title: "밤의 정류장 · macOS 로컬 TTS 가져오기 데모",
      sourcePackageId: base.sourcePackage.id,
    });
    for (const [roleId, voice] of Object.entries(voices))
      await cmd("casting.set", "casting", `spoken-${roleId}`, {
        id: `spoken-${roleId}`,
        scope: "production",
        productionId: "spoken",
        roleId,
        state: null,
        voice: `macOS ${voice}`,
      });
    const scene = {
      ...origin,
      id: "spoken-scene",
      productionId: "spoken",
      title: "함께 돌아오는 표 · 로컬 TTS",
      occurrences: origin.occurrences.map((o) => ({
        ...o,
        id: `spoken-${o.id}`,
      })),
      presentations: origin.presentations.map((p) => ({
        ...p,
        occurrenceId: `spoken-${p.occurrenceId}`,
      })),
      utterances: origin.utterances.map((u) => ({
        ...u,
        id: `spoken-${u.id}`,
        speakerOccurrenceId: `spoken-${u.speakerOccurrenceId}`,
        holdMs: 650,
        acting: {
          note: "macOS local TTS imported demonstration; performance unverified",
        },
      })),
      shots: origin.shots.map((sh) => ({
        ...sh,
        id: `spoken-${sh.id}`,
        referenceSlotId: null,
      })),
    };
    await cmd("scene.put", "scene", scene.id, scene);
    for (let i = 0; i < 6; i++) {
      const slot = {
        id: `spoken-image${i}`,
        scope: { kind: "scene", id: scene.id },
        subject: { kind: "environment", id: "night-stop" },
        appearanceStateRef: null,
      };
      const bytes = await readFile(join(directory, `art-${i}.png`));
      await cmd("asset.import", "assetSlot", slot.id, {
        id: `spoken-picture${i}`,
        slot,
        mediaKind: "image",
        bytes: [...bytes],
        actor: "local-demo",
      });
      await cmd("candidate.adopt", "assetSlot", slot.id, {
        slotId: slot.id,
        candidateId: `spoken-picture${i}`,
        actor: "local-demo",
        reason: "Same original illustration, independently scoped",
      });
    }
    scene.shots = scene.shots.map((sh, i) => ({
      ...sh,
      referenceSlotId: `spoken-${origin.shots[i].referenceSlotId}`,
    }));
    await cmd("scene.put", "scene", scene.id, scene);
    for (const [i, u] of scene.utterances.entries()) {
      const roleId = scene.occurrences.find(
          (o) => o.id === u.speakerOccurrenceId,
        ).roleBindingId,
        voice = voices[roleId];
      const aiff = join(directory, `spoken-take${i}.aiff`),
        wav = join(directory, `spoken-take${i}.wav`);
      await run(
        "/usr/bin/say",
        ["-v", voice, "-r", "165", "-o", aiff, u.text],
        { timeout: 30000 },
      );
      await run("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-i",
        aiff,
        "-ar",
        "24000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wav,
      ]);
      const slot = {
        id: `spoken-audio${i}`,
        scope: { kind: "scene", id: scene.id },
        subject: { kind: "role", id: roleId },
        appearanceStateRef: null,
        castingStateRef: null,
        utteranceId: u.id,
      };
      await cmd("asset.import", "assetSlot", slot.id, {
        id: `spoken-take${i}`,
        slot,
        mediaKind: "audio",
        bytes: [...(await readFile(wav))],
        actor: "macOS-local-TTS-import",
      });
      await cmd("candidate.adopt", "assetSlot", slot.id, {
        slotId: slot.id,
        candidateId: `spoken-take${i}`,
        actor: "local-demo",
        reason: `Local say voice selection ${voice}; no acting-quality approval`,
      });
      console.log("Imported local take", i, voice);
    }
    await cmd("timeline.update", "timeline", "spoken", {
      productionId: "spoken",
      fps: 30,
    });
  }
  const id = "spoken-landscape";
  let e = service.store.aggregate(projectId, { kind: "edition", id }).value;
  if (!e)
    e = await cmd("edition.create", "edition", id, {
      id,
      productionId: "spoken",
      profile: "landscape",
    });
  await writeFile(
    join(directory, "spoken-closure.json"),
    JSON.stringify(e, null, 2),
  );
  let output = service.store.aggregate(projectId, {
    kind: "editionOutput",
    id,
  }).value;
  if (!output) {
    console.log(
      "Rendering spoken companion",
      e.closure.timeline.durationFrames / 30,
    );
    output = await cmd("edition.render", "editionOutput", id, {
      editionId: id,
      renderId: id,
    });
  }
  if (output.status !== "completed") throw Error(JSON.stringify(output));
  await writeFile(
    join(directory, "night-stop-local-tts.mp4"),
    await service.readBlob(projectId, output.manifest.output.blobId),
  );
  await writeFile(
    join(directory, "night-stop-local-tts.wav"),
    await service.readBlob(projectId, e.closure.mix.blobId),
  );
  await writeFile(
    join(directory, "spoken-manifest.json"),
    JSON.stringify(output, null, 2),
  );
  console.log(
    "Local TTS companion checked; no human review receipt.",
    output.manifest.durationSeconds,
  );
} finally {
  await service.close();
}
