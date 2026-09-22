/**
 * CharacterDynamics is a deterministic projection module. It folds accepted
 * observation artifacts; it does not infer observations from prose or persist
 * them. Callers can therefore replay the same canon through this one seam.
 */

const REQUIRED_CONTEXT = [
  'snapshotId', 'expectedHead', 'storyTimeScope', 'transactionTime',
  'policyRevision', 'semanticGeneration', 'fencingToken',
];

const fail = (code, details = {}) => ({ ok: false, error: { code, ...details } });
const clone = (value) => structuredClone(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function validateContext(context) {
  const missing = REQUIRED_CONTEXT.filter((key) => !Object.hasOwn(context ?? {}, key)
    || (key !== 'expectedHead' && context?.[key] === null));
  return missing.length ? fail('invalid_execution_context', { missing }) : null;
}

function visibleAt(context, event) {
  const scope = context.storyTimeScope;
  const worldline = event.worldline ?? 'main';
  const acceptedWorldlines = scope.worldlines ?? [scope.worldline ?? 'main'];
  if (!acceptedWorldlines.includes(worldline)) return false;
  if (scope.from !== undefined && event.storyTime < scope.from) return false;
  if (scope.through !== undefined && event.storyTime > scope.through) return false;
  return event.transactionTime <= context.transactionTime;
}

function stableIdentity(event) {
  if (!event?.eventId || !event?.sourceHash || !event?.anchor) return null;
  return `${event.eventId}\u0000${event.sourceHash}\u0000${event.anchor}`;
}

function initialState(models, agendas) {
  const characterStates = {};
  for (const model of models) {
    if (!model?.characterId) continue;
    characterStates[model.characterId] = {
      characterId: model.characterId,
      model: clone(model),
      dimensions: clone(object(model.dimensionBaselines)),
      interpretations: [], nextChoiceBias: null, changeStatuses: [], provenance: [], influences: [],
    };
  }
  return {
    characterStates,
    agendas: Object.fromEntries(agendas.filter((agenda) => agenda?.characterId).map((agenda) => [agenda.characterId, clone(agenda)])),
    relationshipStates: {}, appliedEventIds: [], eventIdentities: {},
  };
}

function proofStatus(proof) {
  if (!proof) return null;
  const alternatives = Array.isArray(proof.alternativesAvailable) && proof.alternativesAvailable.length >= 2;
  const costly = typeof proof.costPaid === 'string' && proof.costPaid.trim().length > 0;
  const observableChoice = typeof proof.chosen === 'string' && proof.chosen.trim().length > 0;
  const established = proof.voluntary === true && proof.alternativesKnown === true && alternatives && costly && observableChoice;
  if (!established) return 'proposed';
  return Array.isArray(proof.competingHypotheses) && proof.competingHypotheses.length > 0
    ? 'tested-contested'
    : 'tested';
}

function applyEvent(state, event, identity) {
  const character = state.characterStates[event.characterId];
  if (!character) return fail('unknown_character', { characterId: event.characterId, eventId: event.eventId });

  for (const [dimension, delta] of Object.entries(object(event.dimensionChanges))) {
    if (!Number.isFinite(Number(delta))) return fail('invalid_dimension_delta', { eventId: event.eventId, dimension });
    character.dimensions[dimension] = Number(character.dimensions[dimension] ?? 0) + Number(delta);
  }
  if (event.interpretation) character.interpretations.push(String(event.interpretation));
  if (event.nextChoiceBias) character.nextChoiceBias = String(event.nextChoiceBias);
  character.provenance.push(event.eventId);

  const status = proofStatus(event.behavioralProof);
  if (status) {
    character.changeStatuses.push({
      eventId: event.eventId, hypothesis: String(event.behavioralProof.hypothesis ?? ''), status,
      cost: String(event.behavioralProof.costPaid ?? ''),
      competingHypotheses: clone(event.behavioralProof.competingHypotheses ?? []),
    });
  }

  const relationshipBeliefs = (Array.isArray(event.relationshipClaims) ? event.relationshipClaims : [])
    .filter((claim) => claim?.from && claim?.to && claim?.belief)
    .map((claim) => ({ from: claim.from, to: claim.to, belief: String(claim.belief) }))
    .slice(0, 3);
  if (event.interpretation || event.nextChoiceBias || status || relationshipBeliefs.length) {
    character.influences ??= [];
    character.influences.push({
      eventId: event.eventId, anchor: event.anchor, storyTime: event.storyTime,
      interpretation: String(event.interpretation ?? ''), nextChoiceBias: String(event.nextChoiceBias ?? ''),
      ...(status ? {
        behavioralProof: {
          hypothesis: String(event.behavioralProof?.hypothesis ?? ''), status,
          cost: String(event.behavioralProof?.costPaid ?? ''),
        },
      } : {}),
      ...(relationshipBeliefs.length ? { relationshipBeliefs } : {}),
    });
    character.influences = character.influences.slice(-12);
  }

  if (event.agendaUpdate) {
    state.agendas[event.characterId] = { ...object(state.agendas[event.characterId]), ...clone(object(event.agendaUpdate)) };
  }

  for (const claim of Array.isArray(event.relationshipClaims) ? event.relationshipClaims : []) {
    if (!claim?.from || !claim?.to) continue;
    const key = `${claim.from}->${claim.to}`;
    const relationship = state.relationshipStates[key] ?? { from: claim.from, to: claim.to, dimensions: {}, claims: [] };
    for (const [dimension, delta] of Object.entries(object(claim.dimensions))) {
      if (!Number.isFinite(Number(delta))) return fail('invalid_relationship_delta', { eventId: event.eventId, relationship: key, dimension });
      relationship.dimensions[dimension] = Number(relationship.dimensions[dimension] ?? 0) + Number(delta);
    }
    relationship.claims.push({ eventId: event.eventId, belief: String(claim.belief ?? ''), storyTime: event.storyTime, transactionTime: event.transactionTime, worldline: event.worldline ?? 'main' });
    state.relationshipStates[key] = relationship;
  }

  state.appliedEventIds.push(event.eventId);
  state.eventIdentities[event.eventId] = identity;
  return null;
}

/**
 * Fold accepted InfluenceEvents into Character State, CharacterAgenda and
 * directional Relationship Perspectives.
 *
 * Incremental calls pass `previous`; a full rebuild omits it. The result is a
 * pure value and is canonically equivalent for the same visible event set.
 */
export function foldCharacterDynamics(context, input = {}) {
  const contextFailure = validateContext(context);
  if (contextFailure) return contextFailure;
  const models = Array.isArray(input.models) ? input.models : [];
  const agendas = Array.isArray(input.agendas) ? input.agendas : [];
  const state = input.previous ? clone(input.previous) : initialState(models, agendas);
  state.characterStates ??= {};
  state.agendas ??= {};
  state.relationshipStates ??= {};
  state.appliedEventIds ??= [];
  state.eventIdentities ??= {};
  for (const character of Object.values(state.characterStates)) character.influences ??= [];

  const incoming = Array.isArray(input.events) ? input.events : [];
  const identities = new Map();
  for (const event of incoming) {
    const identity = stableIdentity(event);
    if (!identity) return fail('unstable_event_identity', { eventId: event?.eventId ?? null });
    const existing = identities.get(event.eventId) ?? state.eventIdentities[event.eventId];
    if (existing && existing !== identity) return fail('event_identity_conflict', { eventId: event.eventId });
    identities.set(event.eventId, identity);
  }

  const ordered = incoming.filter((event) => visibleAt(context, event)).sort((a, b) =>
    Number(a.storyTime) - Number(b.storyTime)
    || Number(a.transactionTime) - Number(b.transactionTime)
    || String(a.eventId).localeCompare(String(b.eventId)));
  const applied = new Set(state.appliedEventIds);
  for (const event of ordered) {
    if (applied.has(event.eventId)) continue;
    const failure = applyEvent(state, event, identities.get(event.eventId));
    if (failure) return failure;
    applied.add(event.eventId);
  }
  return { ok: true, value: state };
}
