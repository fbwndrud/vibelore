import { assertText, canonicalDigest, fail } from "../engine/contracts.js";
import { readValues, requireValue } from "../engine/story.js";
import { timelineWorkingDigest } from "../engine/timeline.js";
import { checkRenderedBytes } from "./probe.js";
import { registerPolicyCommands, boundPolicy, checkBinding } from "./policy.js";
import {
  blobReferences,
  assertBlobs,
  verifyBlobs,
  prepareEdition,
} from "./closure.js";
const target =
  (kind, key) =>
  ({ envelope: e }) => ({ kind, id: e.payload[key] });
function checkNew(aggregate, code) {
  if (aggregate.revision)
    fail(code, "This immutable identifier already exists.");
}
function editionValue(store, p, id) {
  const e = requireValue(store, p, "edition", id);
  if (canonicalDigest(e.closure) !== e.closureDigest)
    fail("CLOSURE_CONFLICT", "Edition closure failed its digest.");
  return e;
}
function outputValue(store, p, id, e) {
  const output = requireValue(store, p, "editionOutput", id);
  if (
    output.status !== "completed" ||
    output.editionId !== e.id ||
    output.closureDigest !== e.closureDigest ||
    canonicalDigest(output.manifest) !== output.manifestDigest
  )
    fail("OUTPUT_CONFLICT", "Output manifest does not belong to this closure.");
  return output;
}
export function registerEditionCommands(service) {
  const { store } = service;
  registerPolicyCommands(service);
  service.registerCommand("edition.create", {
    target: target("edition", "id"),
    prepare: (ctx) => prepareEdition(service, ctx),
    validate({ envelope: e, aggregate, prepared }) {
      checkNew(aggregate, "IMMUTABLE_EDITION");
      const c = prepared.edition.closure;
      if (
        timelineWorkingDigest(store, e.projectId, {
          productionId: e.payload.productionId,
          ...c.timelineIntent,
        }) !== c.inputDigest ||
        store.aggregate(e.projectId, {
          kind: "timeline",
          id: e.payload.productionId,
        }).revision !== c.timelineRevision
      )
        fail(
          "INPUT_STALE",
          "Selection or timing changed during edition preparation.",
        );
      if (
        !e.payload.policyId &&
        store.aggregate(e.projectId, { kind: "policyDefault", id: e.projectId })
          .revision !== prepared.defaultPolicyRevision
      )
        fail("POLICY_CONFLICT", "Default policy changed during preparation.");
      for (const shot of c.shots.flatMap((s) =>
        s.layers === undefined
          ? [s]
          : s.layers.flatMap((l) => [
              l.selection,
              ...l.poseCues.map((c) => c.selection),
            ]),
      )) {
        const slot = requireValue(store, e.projectId, "assetSlot", shot.slotId);
        if (
          slot.adoptionId !== shot.adoptionId ||
          slot.candidateId !== shot.candidateId
        )
          fail("INPUT_STALE", "Shot selection changed during preparation.");
      }
      assertBlobs(store, e.projectId, c.blobIds);
    },
    apply: ({ prepared }) => prepared.edition,
  });
  service.registerCommand("edition.render", {
    target: target("editionOutput", "renderId"),
    async prepare({ envelope: e, aggregate }) {
      checkNew(aggregate, "IMMUTABLE_OUTPUT");
      const edition = editionValue(store, e.projectId, e.payload.editionId);
      await verifyBlobs(service, e.projectId, edition.closure.blobIds);
      try {
        const renderer =
          service.renderer ?? (await import("./renderer.js")).renderEdition;
        const result = await renderer({
          edition,
          readBlob: (id) => service.blobs.read(e.projectId, id),
        });
        const checked = await checkRenderedBytes(
          result.bytes,
          edition.closure.profile,
          edition.closure.timeline.durationFrames / edition.closure.profile.fps,
        );
        const output = await service.blobs.put(e.projectId, result.bytes);
        const frames = [];
        for (const frame of result.frames ?? [])
          frames.push({
            frame: frame.frame,
            ...(await service.blobs.put(e.projectId, frame.bytes)),
          });
        const manifest = {
          closureDigest: edition.closureDigest,
          output: {
            ...output,
            mime:
              edition.closure.profile.kind === "audio"
                ? "audio/wav"
                : "video/mp4",
            extension: edition.closure.profile.kind === "audio" ? "wav" : "mp4",
          },
          ...checked,
          frames,
        };
        return {
          id: e.payload.renderId,
          editionId: edition.id,
          closureDigest: edition.closureDigest,
          status: "completed",
          manifest,
          manifestDigest: canonicalDigest(manifest),
        };
      } catch (error) {
        return {
          id: e.payload.renderId,
          editionId: edition.id,
          closureDigest: edition.closureDigest,
          status: "failed",
          errorCode: error.code ?? "RENDER_FAILED",
        };
      }
    },
    validate({ envelope: e, aggregate, prepared }) {
      checkNew(aggregate, "IMMUTABLE_OUTPUT");
      const edition = editionValue(store, e.projectId, e.payload.editionId);
      if (edition.closureDigest !== prepared.closureDigest)
        fail("CLOSURE_CONFLICT", "Closure changed during render.");
      assertBlobs(store, e.projectId, [
        ...edition.closure.blobIds,
        ...blobReferences(prepared),
      ]);
    },
    apply: ({ prepared }) => prepared,
  });
  service.registerCommand("edition.review", {
    target: target("editionReview", "id"),
    async prepare({ envelope: e }) {
      const edition = editionValue(store, e.projectId, e.payload.editionId),
        out = outputValue(store, e.projectId, e.payload.renderId, edition);
      await verifyBlobs(service, e.projectId, [
        ...edition.closure.blobIds,
        ...blobReferences(out),
      ]);
      return { manifestDigest: out.manifestDigest };
    },
    validate({ envelope: e, aggregate, prepared }) {
      checkNew(aggregate, "IMMUTABLE_REVIEW");
      const p = e.payload,
        edition = editionValue(store, e.projectId, p.editionId),
        out = outputValue(store, e.projectId, p.renderId, edition);
      if (
        p.closureDigest !== edition.closureDigest ||
        p.outputManifestDigest !== out.manifestDigest ||
        prepared.manifestDigest !== out.manifestDigest
      )
        fail(
          "CLOSURE_CONFLICT",
          "Review must name the exact output and closure.",
        );
      const binding = checkBinding(
        store,
        e.projectId,
        edition,
        p.policyBindingRevision,
      );
      assertText(p.actor);
      if (
        !p.checks ||
        binding.policy.required.some((k) => p.checks[k] !== true)
      )
        fail("REVIEW_REQUIRED", "Policy requires actual playback review.");
      if (
        !out.manifest.checks.decodedAudio ||
        !out.manifest.checks.profile ||
        (edition.closure.profile.kind === "video" &&
          !out.manifest.checks.decodedVideo)
      )
        fail("OUTPUT_INVALID", "Actual output checks are incomplete.");
      assertBlobs(store, e.projectId, [
        ...edition.closure.blobIds,
        ...blobReferences(out),
      ]);
    },
    apply({ envelope: e }) {
      const p = e.payload,
        edition = editionValue(store, e.projectId, p.editionId),
        binding = boundPolicy(store, e.projectId, edition);
      return {
        ...p,
        policy: binding.policy,
        policyDigest: canonicalDigest(binding.policy),
        perceptualVerification: binding.policy.required.length
          ? "creator_attested"
          : "not_performed",
      };
    },
  });
  service.registerCommand("edition.publish", {
    target: target("editionPublication", "editionId"),
    async prepare({ envelope: e }) {
      const edition = editionValue(store, e.projectId, e.payload.editionId),
        review = requireValue(
          store,
          e.projectId,
          "editionReview",
          e.payload.reviewId,
        ),
        out = outputValue(store, e.projectId, review.renderId, edition);
      await verifyBlobs(service, e.projectId, [
        ...edition.closure.blobIds,
        ...blobReferences(out),
      ]);
      return {
        reviewDigest: canonicalDigest(review),
        manifestDigest: out.manifestDigest,
      };
    },
    validate({ envelope: e, aggregate, prepared }) {
      checkNew(aggregate, "IMMUTABLE_PUBLICATION");
      const p = e.payload,
        edition = editionValue(store, e.projectId, p.editionId),
        review = requireValue(store, e.projectId, "editionReview", p.reviewId),
        out = outputValue(store, e.projectId, review.renderId, edition);
      checkBinding(
        store,
        e.projectId,
        edition,
        p.policyBindingRevision,
        review.policyDigest,
      );
      if (
        review.editionId !== edition.id ||
        review.policyBindingRevision !== p.policyBindingRevision ||
        p.closureDigest !== edition.closureDigest ||
        review.closureDigest !== edition.closureDigest ||
        p.outputManifestDigest !== out.manifestDigest ||
        review.outputManifestDigest !== out.manifestDigest ||
        prepared.manifestDigest !== out.manifestDigest ||
        prepared.reviewDigest !== canonicalDigest(review)
      )
        fail(
          "CLOSURE_CONFLICT",
          "Publication receipt no longer matches the exact edition.",
        );
      assertBlobs(store, e.projectId, [
        ...edition.closure.blobIds,
        ...blobReferences(out),
      ]);
    },
    apply: ({ envelope: e }) => ({ ...e.payload, status: "published" }),
  });
}
export function decorateEditionSnapshot(store, snapshot) {
  for (const [key, kind] of [
    ["editions", "edition"],
    ["editionOutputs", "editionOutput"],
    ["editionReviews", "editionReview"],
    ["editionPublications", "editionPublication"],
    ["timelines", "timeline"],
    ["reviewPolicies", "reviewPolicy"],
    ["editionPolicies", "editionPolicy"],
  ])
    snapshot[key] = readValues(store, snapshot.project.id, kind);
  snapshot.editionStates = snapshot.editions.map((e) => {
    let workingChanged = true;
    try {
      workingChanged =
        timelineWorkingDigest(store, snapshot.project.id, {
          productionId: e.productionId,
          ...e.closure.timelineIntent,
        }) !== e.closure.inputDigest ||
        store.aggregate(snapshot.project.id, {
          kind: "timeline",
          id: e.productionId,
        }).revision !== e.closure.timelineRevision ||
        e.closure.shots
          .flatMap((s) =>
            s.layers === undefined
              ? [s]
              : s.layers.flatMap((l) => [
                  l.selection,
                  ...l.poseCues.map((c) => c.selection),
                ]),
          )
          .some((sh) => {
            const slot = store.aggregate(snapshot.project.id, {
              kind: "assetSlot",
              id: sh.slotId,
            }).value;
            return slot?.adoptionId !== sh.adoptionId;
          });
    } catch {}
    return { id: e.id, workingChanged };
  });
  return snapshot;
}
