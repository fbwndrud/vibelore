import {
  assertId,
  assertText,
  canonicalDigest,
  fail,
} from "../engine/contracts.js";
import { requireValue } from "../engine/story.js";
export const humanPolicy = Object.freeze({
  id: "human-v1",
  name: "Creator playback review",
  required: ["watched", "listened"],
});
export const humanAudioPolicy = Object.freeze({
  id: "human-audio-v1",
  name: "Creator audio playback review",
  required: ["listened"],
});
export function policyValue(store, projectId, id) {
  return id === "human-audio-v1"
    ? humanAudioPolicy
    : id === "human-v1"
      ? humanPolicy
      : requireValue(store, projectId, "reviewPolicy", id);
}
export function boundPolicy(store, projectId, edition) {
  const binding = store.aggregate(projectId, {
    kind: "editionPolicy",
    id: edition.id,
  });
  return {
    revision: binding.revision,
    policy: binding.value
      ? policyValue(store, projectId, binding.value.policyId)
      : edition.policy,
  };
}
export function checkBinding(
  store,
  projectId,
  edition,
  revision,
  policyDigest,
) {
  const binding = boundPolicy(store, projectId, edition);
  if (
    binding.revision !== revision ||
    (policyDigest && canonicalDigest(binding.policy) !== policyDigest)
  )
    fail("POLICY_CONFLICT", "Edition policy binding changed.");
  return binding;
}
export function registerPolicyCommands(service) {
  service.registerCommand("policy.create", {
    target: ({ envelope: e }) => ({ kind: "reviewPolicy", id: e.payload.id }),
    validate({ aggregate, envelope: e }) {
      if (
        aggregate.revision ||
        ["human-v1", "human-audio-v1"].includes(e.payload.id)
      )
        fail("IMMUTABLE_POLICY", "Policy revision already exists.");
      assertId(e.payload.id);
      assertText(e.payload.name);
      if (
        !Array.isArray(e.payload.required) ||
        new Set(e.payload.required).size !== e.payload.required.length ||
        e.payload.required.some((x) => !["watched", "listened"].includes(x))
      )
        fail("INVALID_INPUT", "Unknown policy requirement.");
    },
    apply: ({ envelope: e }) => e.payload,
  });
  service.registerCommand("policy.default", {
    target: ({ envelope: e }) => ({ kind: "policyDefault", id: e.projectId }),
    validate({ store, envelope: e }) {
      policyValue(store, e.projectId, e.payload.policyId);
    },
    apply: ({ envelope: e }) => ({ policyId: e.payload.policyId }),
  });
  service.registerCommand("edition.bindPolicy", {
    target: ({ envelope: e }) => ({
      kind: "editionPolicy",
      id: e.payload.editionId,
    }),
    validate({ store, envelope: e }) {
      requireValue(store, e.projectId, "edition", e.payload.editionId);
      if (
        store.aggregate(e.projectId, {
          kind: "editionPublication",
          id: e.payload.editionId,
        }).revision
      )
        fail("IMMUTABLE_EDITION", "Published edition policy cannot change.");
      policyValue(store, e.projectId, e.payload.policyId);
      assertText(e.payload.reason);
    },
    apply: ({ envelope: e }) => e.payload,
  });
}
