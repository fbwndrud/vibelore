import { assertText, fail } from "./contracts.js";
import { candidateValue, checkPinnedRequest } from "./asset-slots.js";
import { readValues, requireValue, validateSceneSave } from "./story.js";
export const proposalSchema = {
  type: "object",
  properties: {
    sceneId: { type: "string" },
    utteranceId: { type: "string" },
    speakerOccurrenceId: { type: "string" },
    sourceUnitIds: { type: "array", items: { type: "string" } },
    text: { type: "string" },
  },
  required: [
    "sceneId",
    "utteranceId",
    "speakerOccurrenceId",
    "sourceUnitIds",
    "text",
  ],
  additionalProperties: false,
};
export const sceneProposalSchema = {
  type: "object",
  properties: {
    sceneId: { type: "string" },
    sourceUnitIds: { type: "array", items: { type: "string" } },
    utterances: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          speakerOccurrenceId: { type: "string" },
          sourceUnitIds: { type: "array", items: { type: "string" } },
          text: { type: "string" },
        },
        required: ["id", "speakerOccurrenceId", "sourceUnitIds", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["sceneId", "sourceUnitIds", "utterances"],
  additionalProperties: false,
};
function citations(source, allowed, ids) {
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    new Set(ids).size === ids.length &&
    ids.every(
      (id) => allowed.includes(id) && source.textUnits.some((u) => u.id === id),
    )
  );
}
function sceneProposalValue(store, projectId, request, proposal) {
  const scene = requireValue(store, projectId, "scene", request.sceneId),
    source = request.sourcePackageId
      ? requireValue(store, projectId, "sourcePackage", request.sourcePackageId)
      : null;
  if (
    request.target.kind !== "scene" ||
    !proposal ||
    Object.keys(proposal).length !== 3 ||
    Object.keys(proposal).some(
      (k) => !sceneProposalSchema.required.includes(k),
    ) ||
    proposal.sceneId !== scene.id ||
    !source ||
    !citations(source, request.sourceDependencySpans, proposal.sourceUnitIds) ||
    !Array.isArray(proposal.utterances) ||
    !proposal.utterances.length ||
    proposal.utterances.length > 200
  )
    fail("INVALID_PROPOSAL", "Invalid scene script proposal.");
  const existing = scene.utterances.map((u) => ({
    ...u,
    ...store.aggregate(projectId, { kind: "utterance", id: u.id }).value,
  }));
  const incoming = proposal.utterances.map((u) => {
    if (
      !u ||
      Object.keys(u).length !== 4 ||
      Object.keys(u).some(
        (k) =>
          !["id", "speakerOccurrenceId", "sourceUnitIds", "text"].includes(k),
      ) ||
      typeof u.text !== "string" ||
      u.text.length > 10000 ||
      !citations(source, proposal.sourceUnitIds, u.sourceUnitIds)
    )
      fail("INVALID_PROPOSAL", "Invalid cited utterance.");
    return { ...u, addresseeOccurrenceIds: [], holdMs: 0 };
  });
  if (incoming.some((u) => existing.some((old) => old.id === u.id)))
    fail(
      "INVALID_PROPOSAL",
      "Existing utterances need individual revision proposals.",
    );
  const value = { ...scene, utterances: [...existing, ...incoming] };
  validateSceneSave({
    store,
    envelope: { projectId, payload: value },
    aggregate: store.aggregate(projectId, { kind: "scene", id: scene.id }),
  });
  return value;
}
function validateProposal(store, projectId, request, proposal) {
  if (request.recipe?.operation === "scene_adaptation_proposal")
    return sceneProposalValue(store, projectId, request, proposal);
  if (
    request.recipe?.operation !== "adaptation_proposal" ||
    request.target.kind !== "utterance"
  )
    fail("INVALID_PROPOSAL", "A proposal must target one existing utterance.");
  if (
    !proposal ||
    Array.isArray(proposal) ||
    Object.keys(proposal).length !== 5 ||
    Object.keys(proposal).some((k) => !proposalSchema.required.includes(k))
  )
    fail("INVALID_PROPOSAL", "Unexpected proposal shape.");
  assertText(proposal.text);
  const scene = requireValue(store, projectId, "scene", request.sceneId),
    u = scene.utterances.find((u) => u.id === request.target.id);
  const current = u
    ? {
        ...u,
        ...store.aggregate(projectId, { kind: "utterance", id: u.id }).value,
      }
    : null;
  if (
    !current ||
    proposal.sceneId !== scene.id ||
    proposal.utteranceId !== current.id ||
    proposal.speakerOccurrenceId !== current.speakerOccurrenceId
  )
    fail(
      "INVALID_PROPOSAL",
      "Proposal speaker or utterance is outside the selected scene.",
    );
  const source = request.sourcePackageId
    ? requireValue(store, projectId, "sourcePackage", request.sourcePackageId)
    : null;
  if (
    !source ||
    !Array.isArray(proposal.sourceUnitIds) ||
    !proposal.sourceUnitIds.length ||
    new Set(proposal.sourceUnitIds).size !== proposal.sourceUnitIds.length ||
    proposal.sourceUnitIds.some(
      (id) =>
        !request.sourceDependencySpans.includes(id) ||
        !source.textUnits.some((u) => u.id === id),
    )
  )
    fail(
      "INVALID_PROPOSAL",
      "Proposal source citation is outside the allowed scene.",
    );
  return current;
}
export function proposalValidator(service, projectId) {
  return ({ request, outputs }) =>
    outputs.map((output) => {
      try {
        if (output.mime !== "application/json")
          fail("INVALID_PROPOSAL", "Expected JSON.");
        const proposal = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(output.bytes),
        );
        validateProposal(service.store, projectId, request, proposal);
        return {
          blobId: output.blobId,
          mediaKind: "text",
          mime: "application/json",
          proposal,
          validation: {
            status: "passed",
            validator: "adaptation-v1",
            fidelity: "requires-human-review",
          },
        };
      } catch {
        return {
          blobId: output.blobId,
          mediaKind: "text",
          validation: { status: "quarantined", code: "INVALID_PROPOSAL" },
        };
      }
    });
}
export function registerProposalCommands(service) {
  service.registerCommand("proposal.apply", {
    target: ({ envelope }) =>
      envelope.payload.sceneId
        ? { kind: "scene", id: envelope.payload.sceneId }
        : { kind: "utterance", id: envelope.payload.utteranceId },
    apply({ store, envelope }) {
      const p = envelope.payload;
      assertText(p.actor);
      assertText(p.reason);
      const candidate = candidateValue(
        store,
        envelope.projectId,
        p.candidateId,
      );
      if (
        candidate.mediaKind !== "text" ||
        candidate.validation?.status !== "passed" ||
        (p.sceneId
          ? candidate.proposal?.sceneId !== p.sceneId
          : candidate.proposal?.utteranceId !== p.utteranceId)
      )
        fail(
          "INVALID_PROPOSAL",
          "Expected a validated proposal for this utterance.",
        );
      checkPinnedRequest(store, envelope.projectId, candidate);
      const original = JSON.parse(
        store.get(
          "SELECT data_json FROM generation_attempts WHERE project_id=? AND id=?",
          envelope.projectId,
          candidate.attemptId,
        ).data_json,
      );
      const current = validateProposal(
        store,
        envelope.projectId,
        original.request,
        candidate.proposal,
      );
      if (p.sceneId) {
        if (candidate.recipe.operation !== "scene_adaptation_proposal")
          fail("INVALID_PROPOSAL", "Expected scene proposal.");
        return {
          ...current,
          adaptationDecision: {
            candidateId: candidate.id,
            actor: p.actor,
            reason: p.reason,
          },
        };
      }
      return {
        ...current,
        sceneId: candidate.proposal.sceneId,
        text: candidate.proposal.text,
        adaptationDecision: {
          candidateId: candidate.id,
          actor: p.actor,
          reason: p.reason,
        },
      };
    },
  });
}
