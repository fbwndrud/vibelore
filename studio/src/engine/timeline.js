import { assertId, assertInteger, canonicalDigest, fail } from "./contracts.js";
import { readValues, effectiveScenes, requireValue } from "./story.js";
import { resolveAcceptedSelection } from "./adoptions.js";
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
    if (!x || typeof x !== "object")
      fail("INVALID_INPUT", "Expected timeline item.");
    assertId(x[key]);
    if (ids.has(x[key]))
      fail("INVALID_INPUT", "Duplicate timeline identifier.");
    ids.add(x[key]);
  }
}
// Additions are opt-in: the legacy speech-only DTO and scheduling remain unchanged.
// Independent tracks use the exact same sample evaluator as takes.
const MAX_MS = 3600000;
const hasSoundAdditions = (p) =>
  (Array.isArray(p.tracks) && p.tracks.length > 0) ||
  (Array.isArray(p.sceneDurations) && p.sceneDurations.length > 0);
function soundMs(value, positive = false) {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_MS ||
    (positive && Math.round((value * SAMPLE_RATE) / 1000) === 0) ||
    !Number.isSafeInteger(Math.round((value * SAMPLE_RATE) / 1000))
  )
    fail(
      "INVALID_INPUT",
      "Sound timing must be finite, safe and within one hour.",
    );
  return value;
}
export function resolveTimeline({
  fps = 30,
  takes = [],
  cues = [],
  tracks,
  sceneDurations,
  sceneIds = [],
  shotCues = [],
}) {
  if (!Number.isInteger(fps) || fps < 1 || fps > 120)
    fail("INVALID_INPUT", "Invalid frame rate.");
  const extended = hasSoundAdditions({ tracks, sceneDurations });
  if (
    (tracks !== undefined && !Array.isArray(tracks)) ||
    (sceneDurations !== undefined && !Array.isArray(sceneDurations))
  )
    fail("INVALID_INPUT", "Sound tracks and scene durations must be arrays.");
  unique(takes, "utteranceId");
  unique(cues, "id");
  unique(tracks ?? [], "id");
  unique(sceneDurations ?? [], "sceneId");
  for (const d of sceneDurations ?? []) {
    if (Object.keys(d).some((k) => !["sceneId", "durationMs"].includes(k)))
      fail("INVALID_INPUT", "Unsupported scene duration intent.");
    soundMs(d.durationMs, true);
    if (!sceneIds.includes(d.sceneId))
      fail("INVALID_REFERENCE", "Unknown timed scene.");
  }
  let cursor = 0;
  const scheduled = [],
    index = new Map(),
    resolvedTracks = [],
    resolvedScenes = [];
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
  function schedule(take) {
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
    return {
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
  }
  function speech(take, sceneStart = 0) {
    const item = schedule(take);
    if (item.startSample < sceneStart)
      fail("TIMING_CONFLICT", "Speech starts before its scene.");
    scheduled.push(item);
    index.set(take.utteranceId, item);
    cursor = Math.max(cursor, item.endSample);
  }
  function track(input, sceneStart = 0) {
    if (!["music", "sfx"].includes(input.kind))
      fail("INVALID_INPUT", "Unknown sound role.");
    assertId(input.slotId);
    const gainDb = input.gainDb ?? 0;
    if (!Number.isFinite(gainDb) || gainDb > 20 * Math.log10(4))
      fail(
        "INVALID_INPUT",
        "Track gain must be finite and no greater than linear gain 4.",
      );
    if (input.muted != null && typeof input.muted !== "boolean")
      fail("INVALID_INPUT", "Muted must be explicit boolean.");
    soundMs(input.startMs);
    for (const key of ["trimStartMs", "trimEndMs", "fadeInMs", "fadeOutMs"])
      soundMs(input[key] ?? 0);
    const item = schedule({
      ...input,
      fixedStartMs: 0,
      trimStartSamples: Math.round(
        ((input.trimStartMs ?? 0) * input.sampleRate) / 1000,
      ),
      trimEndSamples: Math.round(
        ((input.trimEndMs ?? 0) * input.sampleRate) / 1000,
      ),
      gain: Math.pow(10, gainDb / 20),
      mute: input.muted ?? false,
    });
    const startSample = sceneStart + toSample(input.startMs),
      endSample = startSample + item.endSample;
    if (endSample > SAMPLE_RATE * 3600)
      fail("INVALID_INPUT", "Track exceeds one hour.");
    const { fixedStartMs, ...resolved } = item;
    resolvedTracks.push({
      ...resolved,
      gainDb,
      muted: item.mute,
      timeBasis: input.sceneId ? "scene" : "production",
      startSample,
      endSample,
      startFrame: Math.round((startSample * fps) / SAMPLE_RATE),
      endFrame: Math.ceil((endSample * fps) / SAMPLE_RATE),
    });
  }
  function cue(c) {
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
  }
  if (extended && sceneIds.length) {
    for (const sceneId of sceneIds) {
      const startSample = cursor;
      for (const take of takes.filter((t) => t.sceneId === sceneId))
        speech(take, startSample);
      for (const t of (tracks ?? []).filter((t) => t.sceneId === sceneId))
        track(t, startSample);
      const localShots = shotCues.filter((s) => s.sceneId === sceneId).map(cue);
      if (localShots.some((s) => s.startSample < startSample))
        fail("TIMING_CONFLICT", "Shot starts before its scene.");
      const contentEnd = Math.max(
        cursor,
        ...resolvedTracks
          .filter((t) => t.sceneId === sceneId)
          .map((t) => t.endSample),
        ...localShots.map((s) => s.endSample),
      );
      const declared = sceneDurations?.find((d) => d.sceneId === sceneId);
      const endSample = declared
        ? startSample + toSample(declared.durationMs)
        : contentEnd;
      if (endSample > SAMPLE_RATE * 3600)
        fail("INVALID_INPUT", "Scene spans exceed one hour.");
      if (contentEnd > endSample)
        fail(
          "TIMING_CONFLICT",
          "Declared scene duration does not cover its content.",
        );
      cursor = endSample;
      resolvedScenes.push({
        sceneId,
        startSample,
        endSample,
        startFrame: Math.ceil((startSample * fps) / SAMPLE_RATE),
        endFrame: Math.ceil((endSample * fps) / SAMPLE_RATE),
        explicitDuration: !!declared,
      });
    }
    if (
      takes.some((t) => !sceneIds.includes(t.sceneId)) ||
      (tracks ?? []).some((t) => t.sceneId && !sceneIds.includes(t.sceneId))
    )
      fail("INVALID_REFERENCE", "Sound is outside selected scenes.");
    for (const t of (tracks ?? []).filter((t) => !t.sceneId)) track(t);
  } else {
    for (const take of takes) speech(take);
    for (const t of tracks ?? []) track(t);
  }
  // Keep caller order stable even when scene/global evaluation is grouped.
  resolvedTracks.sort(
    (a, b) =>
      tracks.findIndex((t) => t.id === a.id) -
      tracks.findIndex((t) => t.id === b.id),
  );
  const resolvedCues = cues.map(cue);
  const durationSamples = Math.max(
    cursor,
    ...resolvedCues.map((c) => c.endSample),
    ...resolvedTracks.map((t) => t.endSample),
    1,
  );
  if (extended && resolvedScenes.length) {
    const last = resolvedScenes.at(-1);
    // Explicit global tracks represent a production tail; global cues must not
    // silently enlarge an explicitly timed scene.
    if (
      last.explicitDuration &&
      resolvedCues.some((c) => c.endSample > last.endSample)
    )
      fail("TIMING_CONFLICT", "Cue exceeds the declared scene spans.");
    if (!last.explicitDuration && durationSamples > last.endSample) {
      last.endSample = durationSamples;
      last.endFrame = Math.ceil((durationSamples * fps) / SAMPLE_RATE);
    }
    if (resolvedScenes.some((s) => s.startSample === s.endSample))
      fail(
        "MISSING_AUDIO",
        "A silent scene requires an explicit positive duration.",
      );
  }
  if (extended && durationSamples > SAMPLE_RATE * 3600)
    fail("INVALID_INPUT", "Sound timeline exceeds one hour.");
  const durationFrames = Math.ceil((durationSamples * fps) / SAMPLE_RATE);
  return {
    fps,
    sampleRate: SAMPLE_RATE,
    takes: scheduled,
    cues: resolvedCues,
    durationSamples,
    durationFrames,
    ...(extended
      ? {
          tracks: resolvedTracks,
          scenes: resolvedScenes,
          totalDurationFrames: durationFrames,
        }
      : {}),
  };
}

export function timelineInputs(store, projectId, p) {
  if (p.sceneDurations !== undefined && !Array.isArray(p.sceneDurations))
    fail("INVALID_INPUT", "Scene durations must be an array.");
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
      const candidate = resolveAcceptedSelection(store, projectId, slot);
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
  const tracks = [];
  if (p.tracks !== undefined && !Array.isArray(p.tracks))
    fail("INVALID_INPUT", "Tracks must be an array.");
  unique(p.tracks ?? [], "id");
  for (const intent of p.tracks ?? []) {
    if (
      Object.keys(intent).some(
        (k) =>
          ![
            "id",
            "kind",
            "slotId",
            "startMs",
            "trimStartMs",
            "trimEndMs",
            "gainDb",
            "fadeInMs",
            "fadeOutMs",
            "muted",
          ].includes(k),
      )
    )
      fail("INVALID_INPUT", "Unsupported independent track intent.");
    if (!["music", "sfx"].includes(intent.kind))
      fail("INVALID_INPUT", "Unknown track kind.");
    const slot = slots.find((s) => s.id === intent.slotId);
    if (
      !slot ||
      slot.mediaKind !== "audio" ||
      slot.utteranceId ||
      !slot.candidateId
    )
      fail(
        "INVALID_REFERENCE",
        "Track requires a selected independent audio slot.",
      );
    const scene = ["scene", "shot"].includes(slot.scope.kind)
      ? ordered.find((s) =>
          slot.scope.kind === "scene"
            ? s.id === slot.scope.id
            : s.shots.some((sh) => sh.id === slot.scope.id),
        )
      : null;
    if (
      (["scene", "shot"].includes(slot.scope.kind) && !scene) ||
      (slot.scope.kind === "production" && slot.scope.id !== p.productionId) ||
      (slot.scope.kind === "project" && slot.scope.id !== projectId)
    )
      fail(
        "INVALID_REFERENCE",
        "Track slot is outside the selected production/scenes.",
      );
    const candidate = resolveAcceptedSelection(store, projectId, slot);
    if (
      (candidate.reuseRole && candidate.reuseRole !== intent.kind) ||
      (slot.audioRole && slot.audioRole !== intent.kind) ||
      (!candidate.reuseRole && slot.audioRole !== intent.kind)
    )
      fail(
        "SLOT_CONFLICT",
        "Audio role does not authorize the requested track.",
      );
    tracks.push({
      ...intent,
      sceneId: scene?.id ?? null,
      scope: slot.scope,
      adoptionId: slot.adoptionId,
      candidateId: candidate.id,
      blobId: candidate.canonicalBlobId ?? candidate.blobId,
      frames: candidate.metadata.frameCount,
      sampleRate: candidate.metadata.sampleRate,
      candidate,
    });
  }
  if (!takes.length && !tracks.length && !p.sceneDurations?.length)
    fail(
      "MISSING_AUDIO",
      "Timeline needs selected audio or an explicit silent duration.",
    );
  const sourcePackage = production.sourcePackageId
    ? requireValue(
        store,
        projectId,
        "sourcePackage",
        production.sourcePackageId,
      )
    : null;
  return {
    production,
    scenes: ordered,
    takes,
    sourcePackage,
    ...(hasSoundAdditions(p) ? { tracks } : {}),
  };
}
export function timelineWorkingDigest(store, projectId, p) {
  return canonicalDigest(timelineInputs(store, projectId, p));
}
export async function prepareTimeline(service, projectId, p) {
  const inputs = timelineInputs(service.store, projectId, p),
    inputDigest = canonicalDigest(inputs);
  for (const take of [...inputs.takes, ...(inputs.tracks ?? [])]) {
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
  const additions = hasSoundAdditions(p)
    ? {
        tracks: (inputs.tracks ?? []).map(({ candidate, ...track }) => track),
        sceneDurations: p.sceneDurations ?? [],
        sceneIds: inputs.scenes.map((s) => s.id),
        shotCues: shots.map((x) => ({
          ...x,
          id: x.shotId,
          sceneId: inputs.scenes.find((s) =>
            s.shots.some((sh) => sh.id === x.shotId),
          ).id,
        })),
      }
    : {};
  // Validate shots even for audio profiles; legacy shot timing remains global.
  resolveTimeline({
    fps: p.fps ?? 30,
    takes: inputs.takes,
    cues: shots.map((x) => ({ ...x, id: x.shotId })),
    ...additions,
  });
  return {
    productionId: p.productionId,
    intent: {
      fps: p.fps ?? 30,
      sceneIds: inputs.scenes.map((s) => s.id),
      utterances: p.utterances ?? [],
      cues: p.cues ?? [],
      shots: p.shots ?? [],
      ...(hasSoundAdditions(p)
        ? {
            tracks: p.tracks ?? [],
            sceneDurations: p.sceneDurations ?? [],
          }
        : {}),
    },
    inputDigest,
    resolved: resolveTimeline({
      fps: p.fps ?? 30,
      takes: inputs.takes.map(({ candidate, ...take }) => take),
      cues: p.cues ?? [],
      ...additions,
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
