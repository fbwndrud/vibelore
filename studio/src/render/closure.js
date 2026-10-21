import { readFile } from "node:fs/promises";
import {
  assertId,
  canonicalDigest,
  BLOB_ID,
  fail,
} from "../engine/contracts.js";
import { PERFORMANCE_VERSION, evaluatePerformance } from "./performance.js";
import { requireValue, validateShotLayers } from "../engine/story.js";
import {
  resolveAcceptedSelection,
  adoptionDecision,
} from "../engine/adoptions.js";
import {
  prepareTimeline,
  timelineInputs,
  resolveTimeline,
} from "../engine/timeline.js";
import { decodeMedia } from "../assets/decode.js";
import { prepareFont } from "./font.js";
import { mixTimeline } from "./mix.js";
import { renderCapabilities, renderCodePaths } from "./probe.js";
import { policyValue } from "./policy.js";

export function blobReferences(value, out = new Set()) {
  if (!value || typeof value !== "object") return out;
  for (const [key, v] of Object.entries(value)) {
    if (
      typeof v === "string" &&
      BLOB_ID.test(v) &&
      (/blobId$/i.test(key) || key === "id")
    )
      out.add(v);
    else if (key === "blobIds" && Array.isArray(v)) {
      for (const id of v) if (BLOB_ID.test(id)) out.add(id);
    } else if (typeof v === "object") blobReferences(v, out);
  }
  return out;
}
function profileValue(name, fps) {
  if (!["audio", "landscape", "portrait"].includes(name))
    fail("INVALID_INPUT", "Choose audio, landscape or portrait.");
  return {
    id: name,
    kind: name === "audio" ? "audio" : "video",
    fps,
    width: name === "portrait" ? 720 : 1280,
    height: name === "portrait" ? 1280 : 720,
    colorSpace: "srgb",
    codec: name === "audio" ? "pcm_s16le" : "h264/aac",
    pixelFormat: name === "audio" ? null : "yuv420p",
  };
}
export function assertBlobs(store, projectId, ids) {
  for (const id of ids) {
    const row = store.get(
      "SELECT status FROM blobs WHERE project_id=? AND id=?",
      projectId,
      id,
    );
    if (row?.status !== "available")
      fail("MISSING_BLOB", "Edition requires an available project blob.");
  }
}
export async function verifyBlobs(service, p, ids) {
  for (const id of ids) await service.blobs.read(p, id);
}
function resolveShots(store, projectId, inputs, timeline, intents, profile) {
  if (profile.kind === "audio") return { shots: [], assets: [] };
  const shots = [],
    assets = [];
  for (const scene of inputs.scenes) {
    const takes = timeline.takes.filter((t) => t.sceneId === scene.id);
    const span = timeline.scenes?.find((s) => s.sceneId === scene.id);
    const start = span?.startFrame ?? shots.at(-1)?.endFrame ?? 0,
      end =
        span?.endFrame ??
        Math.max(start, ...takes.map((take) => take.endFrame));
    if (!scene.shots.length) fail("MISSING_IMAGE", "Video scene has no shots.");
    for (const [i, shot] of scene.shots.entries()) {
      const slot =
        shot.layers === undefined && shot.referenceSlotId
          ? requireValue(store, projectId, "assetSlot", shot.referenceSlotId)
          : null;
      if (
        shot.layers === undefined &&
        (!slot?.candidateId || slot.mediaKind !== "image")
      )
        fail(
          "MISSING_IMAGE",
          "Every video shot needs an accepted reference image.",
        );
      const scope = slot?.scope ?? {};
      if (
        (scope.kind === "production" && scope.id !== scene.productionId) ||
        (scope.kind === "scene" && scope.id !== scene.id) ||
        (scope.kind === "shot" && scope.id !== shot.id)
      )
        fail("INVALID_REFERENCE", "Image is outside shot scope.");
      const candidate = slot
        ? resolveAcceptedSelection(store, projectId, slot)
        : null;
      if (candidate) assertImageUse(candidate, slot, "shot");
      const intent = intents.find((x) => x.shotId === shot.id);
      let startFrame = Math.round(
          start + ((end - start) * i) / scene.shots.length,
        ),
        endFrame = Math.round(
          start + ((end - start) * (i + 1)) / scene.shots.length,
        );
      if (intent) {
        const cue = resolveTimeline({
          fps: profile.fps,
          takes: timeline.takes.map((t) => {
            const { anchor, ...take } = t;
            return {
              ...take,
              fixedStartMs: (t.startSample * 1000) / timeline.sampleRate,
            };
          }),
          cues: [{ ...intent, id: shot.id }],
        }).cues[0];
        startFrame = cue.startFrame;
        endFrame = cue.endFrame;
      } else if (
        span &&
        scene === inputs.scenes.at(-1) &&
        i === scene.shots.length - 1
      ) {
        // Preserve scene-local cuts; a selected global audio tail holds only
        // the final default shot. Explicit shot timing is never stretched.
        endFrame = timeline.durationFrames;
      }
      if (endFrame <= startFrame || endFrame > timeline.durationFrames)
        fail("TIMING_CONFLICT", "Shot has an invalid boundary.");
      validateShotLayers(store, projectId, scene, shot, endFrame - startFrame);
      const selection = (slotId, use) => {
        const selectedSlot = requireValue(
          store,
          projectId,
          "assetSlot",
          slotId,
        );
        const selected = resolveAcceptedSelection(
          store,
          projectId,
          selectedSlot,
        );
        assertImageUse(selected, selectedSlot, use);
        assets.push(selected);
        return {
          blobId: selected.canonicalBlobId ?? selected.blobId,
          candidateId: selected.id,
          slotId,
          adoptionId: selectedSlot.adoptionId,
          metadata: selected.metadata,
          candidate: selected,
          slot: selectedSlot,
          adoption: adoptionDecision(store, projectId, selectedSlot.adoptionId),
        };
      };
      const layers = shot.layers?.map((layer) => ({
        ...layer,
        selection: selection(layer.slotId, "layer"),
        poseCues: (layer.poseCues ?? []).map((cue) => ({
          ...cue,
          selection: selection(cue.slotId, "poseCue"),
        })),
      }));
      const frozen = {
        ...shot,
        ...(layers
          ? { layers, layout: { width: profile.width, height: profile.height } }
          : {}),
        sceneId: scene.id,
        startFrame,
        endFrame,
        ...(candidate
          ? {
              blobId: candidate.canonicalBlobId ?? candidate.blobId,
              slotId: slot.id,
              adoptionId: slot.adoptionId,
              candidateId: candidate.id,
            }
          : {}),
      };
      if (layers)
        for (let frame = 0; frame < endFrame - startFrame; frame++)
          evaluatePerformance({ shot: frozen, frame });
      shots.push(frozen);
      if (candidate) assets.push(candidate);
    }
  }
  if (
    intents.some((x) => !shots.some((s) => s.id === x.shotId)) ||
    new Set(intents.map((x) => x.shotId)).size !== intents.length
  )
    fail("INVALID_REFERENCE", "Unknown or duplicate shot timing.");
  shots.sort((a, b) => a.startFrame - b.startFrame);
  let cursor = 0;
  for (const shot of shots) {
    if (shot.startFrame !== cursor)
      fail(
        "TIMING_CONFLICT",
        "Video shots must cover the timeline without gaps or overlaps.",
      );
    cursor = shot.endFrame;
  }
  if (cursor !== timeline.durationFrames)
    fail("TIMING_CONFLICT", "Video shots must cover the full mix.");
  return { shots, assets };
}
export async function prepareEdition(service, context) {
  const { store, envelope: e, aggregate } = context,
    p = e.payload;
  if (aggregate.revision) fail("IMMUTABLE_EDITION", "Edition already exists.");
  assertId(p.id);
  const saved = store.aggregate(e.projectId, {
    kind: "timeline",
    id: p.productionId,
  });
  const intent = saved.value?.intent ?? {};
  const timeline = await prepareTimeline(service, e.projectId, {
    productionId: p.productionId,
    ...intent,
  });
  const inputs = timelineInputs(store, e.projectId, {
    productionId: p.productionId,
    ...timeline.intent,
  });
  const profile = profileValue(p.profile ?? "landscape", timeline.resolved.fps),
    visual = resolveShots(
      store,
      e.projectId,
      inputs,
      timeline.resolved,
      timeline.intent.shots,
      profile,
    );
  const allAssets = [
    ...inputs.takes.map((t) => t.candidate),
    ...(inputs.tracks ?? []).map((t) => t.candidate),
    ...visual.assets,
  ];
  for (const candidate of visual.assets) {
    const decoded = await decodeMedia(
      await service.blobs.read(
        e.projectId,
        candidate.canonicalBlobId ?? candidate.blobId,
      ),
      "image",
    );
    if (
      canonicalDigest(decoded.metadata) !== canonicalDigest(candidate.metadata)
    )
      fail(
        "INVALID_VALIDATION",
        "Image metadata does not match decoded media.",
      );
  }
  const font = await prepareFont(
    service,
    e.projectId,
    timeline.resolved.takes.map((t) => t.text + t.speaker).join("\n"),
  );
  const mixed = await mixTimeline(timeline.resolved, (id) =>
    service.blobs.read(e.projectId, id),
  );
  const mix = {
    ...(await service.blobs.put(e.projectId, mixed.bytes)),
    ...mixed.metadata,
    mime: "audio/wav",
  };
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    lockBlobId: (
      await service.blobs.put(
        e.projectId,
        await readFile(new URL("../../package-lock.json", import.meta.url)),
      )
    ).blobId,
    code: [],
    video: profile.kind === "video" ? (await renderCapabilities()).video : null,
  };
  for (const path of renderCodePaths(profile.kind))
    environment.code.push({
      path,
      blobId: (
        await service.blobs.put(
          e.projectId,
          await readFile(new URL(path, import.meta.url)),
        )
      ).blobId,
    });
  const assets = allAssets.map((c) => ({
    id: c.id,
    blobId: c.canonicalBlobId ?? c.blobId,
    rawBlobId: c.rawBlobId ?? c.blobId,
    metadata: c.metadata,
    mime: c.mime,
    resolvedModel: c.resolvedModel ?? "unknown",
    returnedModel: c.returnedModel ?? "unknown",
    speechVerification: c.speechVerification ?? "not_applicable",
    lineage: c.lineage ?? null,
    reuseProvenance: c.reuseProvenance ?? null,
    reuseRole: c.reuseRole ?? null,
  }));
  const closure = {
    schemaVersion: 1,
    productionId: p.productionId,
    timeline: timeline.resolved,
    timelineIntent: timeline.intent,
    timelineRevision: saved.revision,
    inputDigest: timeline.inputDigest,
    profile,
    shots: visual.shots,
    ...(visual.shots.some((s) => s.layers !== undefined)
      ? { performanceVersion: PERFORMANCE_VERSION }
      : {}),
    assets,
    font,
    mix,
    environment,
    sourcePackage: inputs.sourcePackage,
    scenes: inputs.scenes,
    ...(inputs.tracks
      ? {
          soundSelections: inputs.tracks.map((t) => ({
            trackId: t.id,
            candidate: t.candidate,
            slot: requireValue(store, e.projectId, "assetSlot", t.slotId),
            adoption: adoptionDecision(store, e.projectId, t.adoptionId),
          })),
        }
      : {}),
  };
  closure.blobIds = [...blobReferences(closure)].sort();
  await verifyBlobs(service, e.projectId, closure.blobIds);
  const defaultPolicy = store.aggregate(e.projectId, {
    kind: "policyDefault",
    id: e.projectId,
  });
  const policy = policyValue(
    store,
    e.projectId,
    p.policyId ??
      defaultPolicy.value?.policyId ??
      (profile.kind === "audio" ? "human-audio-v1" : "human-v1"),
  );
  return {
    edition: {
      id: p.id,
      productionId: p.productionId,
      closure,
      closureDigest: canonicalDigest(closure),
      policy,
    },
    defaultPolicyRevision: defaultPolicy.revision,
  };
}

function assertImageUse(candidate, slot, use) {
  const role = candidate.reuseRole;
  const allowed =
    use === "poseCue"
      ? ["pose"]
      : slot.subject.kind === "environment"
      ? ["environment-reference", "final-scene"]
      : use === "layer"
      ? ["identity-reference", "pose"]
      : ["identity-reference", "pose", "final-scene"];
  if (role && !allowed.includes(role))
    fail(
      "INVALID_REFERENCE",
      "Preserved image role does not authorize this rendered selection.",
    );
}
