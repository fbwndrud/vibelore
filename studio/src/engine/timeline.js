import { assertId, assertInteger, canonicalDigest, fail } from "./contracts.js";
import { readValues, effectiveScenes, requireValue } from "./story.js";
import {
  candidateValue,
  candidateMatchesSlot,
  slotPins,
} from "./asset-slots.js";
import { decodeWav } from "../assets/audio-import.js";

const SAMPLE_RATE = 48000;
const number = (n, min = 0) => {
  if (!Number.isFinite(n) || n < min)
    fail("INVALID_INPUT", "Invalid timeline number.");
  return n;
};
function unique(items, key) {
  const ids = new Set();
  for (const x of items) {
    assertId(x[key]);
    if (ids.has(x[key]))
      fail("INVALID_INPUT", "Duplicate timeline identifier.");
    ids.add(x[key]);
  }
}
export function resolveTimeline({ fps = 30, takes = [], cues = [] }) {
  if (!Number.isInteger(fps) || fps < 1 || fps > 120)
    fail("INVALID_INPUT", "Invalid frame rate.");
  unique(takes, "utteranceId");
  unique(cues, "id");
  let cursor = 0;
  const scheduled = [],
    index = new Map();
  const toSample = (ms) =>
    Math.round((number(ms, -86400000) * SAMPLE_RATE) / 1000);
  function anchorSample(anchor) {
    const target = index.get(anchor?.utteranceId);
    if (!target || !["start", "end"].includes(anchor.edge))
      fail(
        "INVALID_REFERENCE",
        "Anchor must name an earlier resolved utterance.",
      );
    return target[`${anchor.edge}Sample`];
  }
  function start(x, fallback) {
    let at = x.anchor
      ? anchorSample(x.anchor) + toSample(x.offsetMs ?? 0)
      : fallback + toSample(x.offsetMs ?? 0);
    if (x.fixedStartMs != null) {
      const fixed = toSample(x.fixedStartMs);
      if (x.anchor && fixed !== at)
        fail("TIMING_CONFLICT", "Fixed start disagrees with anchor.");
      at = fixed;
    }
    if (at < 0) fail("TIMING_CONFLICT", "Timeline begins before zero.");
    return at;
  }
  for (const take of takes) {
    const frames = take.frames ?? take.frameCount;
    assertInteger(frames);
    number(take.sampleRate, 1);
    if (!frames) fail("INVALID_AUDIO", "Empty take.");
    const trimStartSamples = take.trimStartSamples ?? 0,
      trimEndSamples = take.trimEndSamples ?? 0;
    assertInteger(trimStartSamples);
    assertInteger(trimEndSamples);
    if (trimStartSamples + trimEndSamples >= frames)
      fail("TIMING_CONFLICT", "Trim removes the entire take.");
    const startSample = start(take, cursor + toSample(take.holdMs ?? 0));
    const endSample =
      startSample +
      Math.round(
        ((frames - trimStartSamples - trimEndSamples) * SAMPLE_RATE) /
          take.sampleRate,
      );
    if (take.fixedEndMs != null && endSample > toSample(take.fixedEndMs))
      fail("TIMING_CONFLICT", "Actual audio exceeds the fixed end.");
    const gain = number(take.gain ?? 1);
    if (gain > 4) fail("INVALID_INPUT", "Gain exceeds supported range.");
    for (const k of ["fadeInMs", "fadeOutMs"])
      if (toSample(number(take[k] ?? 0)) > endSample - startSample)
        fail("TIMING_CONFLICT", "Fade exceeds take length.");
    if (take.mute != null && typeof take.mute !== "boolean")
      fail("INVALID_INPUT", "Mute must be explicit boolean.");
    const item = {
      ...take,
      frames,
      trimStartSamples,
      trimEndSamples,
      gain,
      mute: take.mute ?? false,
      fadeInMs: take.fadeInMs ?? 0,
      fadeOutMs: take.fadeOutMs ?? 0,
      startSample,
      endSample,
      startFrame: Math.round((startSample * fps) / SAMPLE_RATE),
      endFrame: Math.ceil((endSample * fps) / SAMPLE_RATE),
    };
    scheduled.push(item);
    index.set(take.utteranceId, item);
    cursor = Math.max(cursor, endSample);
  }
  const resolvedCues = cues.map((c) => {
    const startSample = start(c, 0);
    const endSample = c.endAnchor
      ? anchorSample(c.endAnchor) + toSample(c.endOffsetMs ?? 0)
      : startSample + toSample(c.durationMs ?? 0);
    if (
      endSample < startSample ||
      (c.fixedEndMs != null && endSample > toSample(c.fixedEndMs))
    )
      fail("TIMING_CONFLICT", "Cue crosses its fixed boundary.");
    return {
      ...c,
      startSample,
      endSample,
      startFrame: Math.round((startSample * fps) / SAMPLE_RATE),
      endFrame: Math.ceil((endSample * fps) / SAMPLE_RATE),
    };
  });
  const durationSamples = Math.max(
    cursor,
    ...resolvedCues.map((c) => c.endSample),
    1,
  );
  return {
    fps,
    sampleRate: SAMPLE_RATE,
    takes: scheduled,
    cues: resolvedCues,
    durationSamples,
    durationFrames: Math.ceil((durationSamples * fps) / SAMPLE_RATE),
  };
}

export function timelineInputs(store, projectId, p) {
  const production = requireValue(
    store,
    projectId,
    "production",
    p.productionId,
  );
  const sceneValues = readValues(store, projectId, "scene");
  const scenes = effectiveScenes({
    aggregates: [
      ...sceneValues.map((value) => ({ kind: "scene", id: value.id, value })),
      ...readValues(store, projectId, "utterance").map((value) => ({
        kind: "utterance",
        id: value.id,
        value,
      })),
    ],
  }).filter((s) => s.productionId === p.productionId);
  const selected = p.sceneIds ?? scenes.map((s) => s.id);
  if (!selected.length || new Set(selected).size !== selected.length)
    fail("INVALID_REFERENCE", "Choose nonempty unique scenes.");
  const ordered = selected.map((id) => {
    const s = scenes.find((s) => s.id === id);
    if (!s) fail("INVALID_REFERENCE", "Scene is outside production.");
    if (
      (s.sourcePackageId ?? production.sourcePackageId) !==
      production.sourcePackageId
    )
      fail("SOURCE_BINDING_STALE", "Scene source binding requires review.");
    return s;
  });
  const intents = p.utterances ?? [];
  unique(intents, "utteranceId");
  const allU = ordered.flatMap((s) => s.utterances);
  if (intents.some((x) => !allU.some((u) => u.id === x.utteranceId)))
    fail("INVALID_REFERENCE", "Unknown timing utterance.");
  const slots = readValues(store, projectId, "assetSlot");
  const takes = [];
  for (const scene of ordered)
    for (const u of scene.utterances) {
      const intent = intents.find((x) => x.utteranceId === u.id) ?? {};
      if (
        Object.keys(intent).some(
          (k) =>
            ![
              "utteranceId",
              "slotId",
              "anchor",
              "offsetMs",
              "fixedStartMs",
              "fixedEndMs",
              "trimStartSamples",
              "trimEndSamples",
              "gain",
              "mute",
              "fadeInMs",
              "fadeOutMs",
            ].includes(k),
        )
      )
        fail("INVALID_INPUT", "Unsupported audio intent.");
      const possible = slots.filter(
        (s) =>
          s.mediaKind === "audio" && s.utteranceId === u.id && s.candidateId,
      );
      const slot = intent.slotId
        ? possible.find((s) => s.id === intent.slotId)
        : possible.length === 1
          ? possible[0]
          : null;
      if (!slot)
        fail(
          "MISSING_AUDIO",
          "Every utterance requires an unambiguous selected take.",
        );
      const candidate = candidateValue(store, projectId, slot.candidateId),
        pins = slotPins(store, projectId, slot);
      candidateMatchesSlot(store, projectId, candidate, slot, pins, true);
      if (candidate.validation?.status !== "passed")
        fail("INVALID_VALIDATION", "Unvalidated selected take.");
      const occurrence = scene.occurrences.find(
        (o) => o.id === u.speakerOccurrenceId,
      );
      const role = requireValue(
        store,
        projectId,
        "cast",
        occurrence.roleBindingId,
      );
      takes.push({
        ...intent,
        utteranceId: u.id,
        sceneId: scene.id,
        holdMs: u.holdMs ?? 0,
        text: u.text,
        speaker: role.name,
        presence: occurrence.presence,
        slotId: slot.id,
        adoptionId: slot.adoptionId,
        candidateId: candidate.id,
        blobId: candidate.canonicalBlobId ?? candidate.blobId,
        frames: candidate.metadata.frameCount,
        sampleRate: candidate.metadata.sampleRate,
        candidate,
      });
    }
  if (!takes.length)
    fail("MISSING_AUDIO", "Timeline needs selected utterance audio.");
  const sourcePackage = production.sourcePackageId
    ? requireValue(
        store,
        projectId,
        "sourcePackage",
        production.sourcePackageId,
      )
    : null;
  return { production, scenes: ordered, takes, sourcePackage };
}
export function timelineWorkingDigest(store, projectId, p) {
  return canonicalDigest(timelineInputs(store, projectId, p));
}
export async function prepareTimeline(service, projectId, p) {
  const inputs = timelineInputs(service.store, projectId, p),
    inputDigest = canonicalDigest(inputs);
  for (const take of inputs.takes) {
    const decoded = decodeWav(await service.blobs.read(projectId, take.blobId));
    if (
      canonicalDigest(decoded.metadata) !==
      canonicalDigest(take.candidate.metadata)
    )
      fail("INVALID_VALIDATION", "Decoded audio metadata changed.");
  }
  const shots = p.shots ?? [];
  unique(shots, "shotId");
  if (
    shots.some(
      (x) =>
        !inputs.scenes.some((s) => s.shots.some((sh) => sh.id === x.shotId)),
    )
  )
    fail("INVALID_REFERENCE", "Unknown shot timing.");
  resolveTimeline({
    fps: p.fps ?? 30,
    takes: inputs.takes,
    cues: shots.map((x) => ({ ...x, id: x.shotId })),
  });
  return {
    productionId: p.productionId,
    intent: {
      fps: p.fps ?? 30,
      sceneIds: inputs.scenes.map((s) => s.id),
      utterances: p.utterances ?? [],
      cues: p.cues ?? [],
      shots: p.shots ?? [],
    },
    inputDigest,
    resolved: resolveTimeline({
      fps: p.fps ?? 30,
      takes: inputs.takes.map(({ candidate, ...t }) => t),
      cues: p.cues ?? [],
    }),
  };
}
export function registerTimelineCommands(service) {
  service.registerCommand("timeline.update", {
    target: ({ envelope }) => ({
      kind: "timeline",
      id: envelope.payload.productionId,
    }),
    prepare: ({ envelope }) =>
      prepareTimeline(service, envelope.projectId, envelope.payload),
    validate({ envelope, prepared }) {
      if (
        timelineWorkingDigest(
          service.store,
          envelope.projectId,
          envelope.payload,
        ) !== prepared.inputDigest
      )
        fail("INPUT_STALE", "Timeline selection changed during decode.");
    },
    apply: ({ prepared }) => prepared,
  });
}
