import { createHash } from 'node:crypto';

import { foldCharacterDynamics } from './character-dynamics.js';
import { asKit } from '../prompts/index.js';

const asArray = (value) => Array.isArray(value) ? value : [];
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const stableId = (...parts) => `influence:${createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex')}`;

function modelsFromFoundation(foundation) {
  return asArray(foundation?.characters).map((character) => ({
    characterId: character.id,
    valueOrder: asArray(character.dramaticModel?.valueOrder ?? character.valueOrder),
    behaviorTraits: asArray(character.dramaticModel?.behaviorTraits ?? character.behaviorTraits),
    dimensionBaselines: asObject(character.dramaticModel?.dimensionBaselines ?? character.dimensionBaselines),
    contradiction: character.contradiction ?? '', canonicalName: character.canonicalName ?? character.id,
  }));
}

function agendasFromFoundation(foundation, episodePlan) {
  return asArray(foundation?.characters).map((character) => {
    const saved = asObject(character.agenda);
    const ownsChoice = episodePlan?.scenePressure?.choiceOwner === character.id;
    return {
      characterId: character.id,
      goal: saved.goal ?? (ownsChoice ? episodePlan?.entryState?.protagonistImmediateWant ?? '' : ''),
      hiddenPlan: saved.hiddenPlan ?? '', nextAction: saved.nextAction ?? '', deadline: saved.deadline ?? episodePlan?.scenePressure?.decisionDeadline ?? '',
      resources: asArray(saved.resources), deficits: asArray(saved.deficits), knowledge: asArray(saved.knowledge),
      misbeliefs: asArray(saved.misbeliefs), lineNotCrossed: saved.lineNotCrossed ?? '', fallback: saved.fallback ?? '',
    };
  });
}

function baseEvent({ acceptedObservation, delta, index, kind, characterId, anchor }) {
  const storyTime = delta.chapterNumber;
  const transactionTime = acceptedObservation.acceptedAt;
  const worldline = acceptedObservation.worldline ?? 'main';
  return {
    eventId: stableId(acceptedObservation.observationId, kind, index, characterId, anchor),
    sourceHash: acceptedObservation.sourceHash, anchor, characterId, storyTime, transactionTime, worldline,
  };
}

function adaptEvents({ acceptedObservation, delta, episodePlan }) {
  const events = [];
  asArray(acceptedObservation.influenceEvents).forEach((raw, index) => {
    const anchor = raw.anchor ?? `accepted-influence:${index}`;
    events.push({
      ...baseEvent({ acceptedObservation, delta, index, kind: 'accepted', characterId: raw.characterId, anchor }),
      interpretation: raw.interpretation ?? '', dimensionChanges: asObject(raw.dimensionChanges),
      nextChoiceBias: raw.nextChoiceBias ?? '', agendaUpdate: asObject(raw.agendaUpdate),
      behavioralProof: raw.behavioralProof ?? null, relationshipClaims: asArray(raw.relationshipClaims),
    });
  });
  asArray(delta.mutableChanges).forEach((change, index) => {
    const facts = asArray(change.knownFactsAdded);
    const anchor = `legacy-delta:mutableChanges:${index}`;
    events.push({
      ...baseEvent({ acceptedObservation, delta, index, kind: 'mutable', characterId: change.characterId, anchor }),
      interpretation: facts.length ? `새로 알게 된 사실: ${facts.join('; ')}` : `상태 변화: ${[change.location, change.status].filter(Boolean).join('; ')}`,
      dimensionChanges: {}, nextChoiceBias: '', agendaUpdate: {}, behavioralProof: null, relationshipClaims: [],
    });
  });
  asArray(delta.relationshipOps).forEach((change, index) => {
    const from = change.from ?? episodePlan?.povCharacter ?? episodePlan?.scenePressure?.choiceOwner;
    if (!from || !change.to) return;
    const anchor = `legacy-delta:relationshipOps:${index}`;
    events.push({
      ...baseEvent({ acceptedObservation, delta, index, kind: 'relationship', characterId: from, anchor }),
      interpretation: `${change.to}와의 ${change.kind ?? '관계'}를 ${change.state ?? '변화'}로 인식했다`,
      dimensionChanges: {}, nextChoiceBias: '', agendaUpdate: {}, behavioralProof: null,
      relationshipClaims: [{ from, to: change.to, dimensions: {}, belief: `${change.kind ?? '관계'}: ${change.state ?? '변화'}` }],
    });
  });
  return events;
}

/** Adapter used by commit/refold: only editorially accepted observations fold. */
export function foldLegacyChapterCharacterDynamics(context, input = {}) {
  const observation = input.acceptedObservation;
  if (!observation || observation.status !== 'accepted') {
    return { ok: false, error: { code: 'observation_not_accepted', observationId: observation?.observationId ?? null } };
  }
  if (!observation.observationId || !observation.sourceHash || observation.acceptedAt === undefined) {
    return { ok: false, error: { code: 'invalid_observation_provenance', observationId: observation.observationId ?? null } };
  }
  const delta = input.delta ?? {};
  const result = foldCharacterDynamics(context, {
    models: modelsFromFoundation(input.foundation),
    agendas: agendasFromFoundation(input.foundation, input.episodePlan),
    previous: input.previous,
    events: adaptEvents({ acceptedObservation: observation, delta, episodePlan: input.episodePlan }),
  });
  if (!result.ok) return result;
  result.value.observationProvenance ??= {};
  result.value.observationProvenance[observation.observationId] = {
    sourceHash: observation.sourceHash, acceptedAt: observation.acceptedAt,
    policyRevision: observation.policyRevision ?? context.policyRevision,
    worldline: observation.worldline ?? 'main', chapter: delta.chapterNumber,
  };
  return result;
}

/** Bounded prose-facing projection used by context compilation. */
export function renderSceneCharacterPacket({ projection, cast = [], pressure = '', maxInfluences = 3, kit: kitSource }) {
  if (!projection || !cast.length) return '';
  const t = asKit(kitSource).phrases.context;
  const lines = [t.scenePacketHeading, pressure ? t.scenePressure(pressure) : ''];
  for (const characterId of cast) {
    const state = projection.characterStates?.[characterId];
    if (!state) continue;
    const agenda = projection.agendas?.[characterId] ?? {};
    lines.push(t.sceneCharacter(state.model?.canonicalName ?? characterId, characterId));
    if (agenda.goal) lines.push(t.sceneGoal(agenda.goal));
    if (agenda.nextAction) lines.push(t.sceneNextAction(agenda.nextAction, agenda.deadline));
    if (agenda.fallback) lines.push(t.sceneFallback(agenda.fallback));
    if (state.nextChoiceBias) lines.push(t.sceneBias(state.nextChoiceBias));
    const recent = asArray(state.interpretations).slice(-Math.max(0, maxInfluences));
    if (recent.length) lines.push(t.sceneInfluences(recent.join(' / ')));
    const relationships = Object.values(projection.relationshipStates ?? {}).filter((claim) => claim.from === characterId && cast.includes(claim.to));
    for (const relationship of relationships) {
      const belief = relationship.claims?.at(-1)?.belief;
      lines.push(t.sceneRelationship(relationship.to, belief || JSON.stringify(relationship.dimensions)));
    }
  }
  return lines.filter(Boolean).join('\n').slice(0, 4000);
}
