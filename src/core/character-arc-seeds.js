import { asKit } from '../prompts/index.js';

const asArray = (value) => Array.isArray(value) ? value : [];
const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);

function legacyEvidence(state, maxEvidence) {
  const proofs = asArray(state?.changeStatuses).slice(-maxEvidence).map((proof) => ({
    eventId: text(proof.eventId, 160) || null,
    chapter: null,
    anchor: null,
    observation: text(proof.hypothesis || proof.cost),
    proofStatus: text(proof.status, 40) || null,
  }));
  if (proofs.length) return proofs;
  return asArray(state?.interpretations).slice(-maxEvidence).map((interpretation) => ({
    eventId: null, chapter: null, anchor: null, observation: text(interpretation), proofStatus: null,
  }));
}

function evidenceFromState(state, maxEvidence) {
  const influences = asArray(state?.influences).slice(-maxEvidence).map((influence) => ({
    eventId: text(influence.eventId, 160) || null,
    chapter: Number.isFinite(Number(influence.storyTime)) ? Number(influence.storyTime) : null,
    anchor: text(influence.anchor, 200) || null,
    observation: text(influence.interpretation || influence.nextChoiceBias
      || influence.behavioralProof?.hypothesis
      || asArray(influence.relationshipBeliefs)[0]?.belief),
    proofStatus: text(influence.behavioralProof?.status, 40) || null,
  })).filter((item) => item.observation);
  return influences.length ? influences : legacyEvidence(state, maxEvidence);
}

function relationshipResidue(projection, characterId) {
  return Object.values(projection?.relationshipStates ?? {}).flatMap((relationship) => {
    if (relationship?.from !== characterId && relationship?.to !== characterId) return [];
    const claim = asArray(relationship.claims).at(-1);
    if (!claim?.belief) return [];
    return [{
      direction: `${relationship.from}->${relationship.to}`,
      belief: text(claim.belief),
      chapter: Number.isFinite(Number(claim.storyTime)) ? Number(claim.storyTime) : null,
    }];
  }).sort((a, b) => Number(b.chapter ?? -1) - Number(a.chapter ?? -1)).slice(0, 2);
}

/**
 * Compile accepted character history into bounded planning evidence. These are
 * candidates, not mandatory arcs and not prose-facing character biographies.
 */
export function compileCharacterArcSeeds({
  foundation, projection, previousArcPlan, previousArcReview, maxCharacters = 6, maxEvidence = 3,
} = {}) {
  if (!projection) return [];
  const previousArcs = new Map(asArray(previousArcPlan?.characterArcs)
    .map((arc) => [arc.characterId, arc]));
  const outcomes = new Map(asArray(previousArcReview?.characterOutcomes)
    .map((outcome) => [outcome.characterId, outcome]));

  return asArray(foundation?.characters).flatMap((character) => {
    const state = projection.characterStates?.[character.id];
    const agenda = projection.agendas?.[character.id] ?? {};
    const previousArc = previousArcs.get(character.id);
    const outcome = outcomes.get(character.id);
    const evidence = evidenceFromState(state, maxEvidence);
    const hasHistory = evidence.length || state?.nextChoiceBias || previousArc || outcome;
    if (!state || !hasHistory) return [];
    const lastBeat = asArray(previousArc?.beats).at(-1)?.beat ?? null;
    const status = outcome?.status
      ?? (previousArc ? (previousArcPlan?.status === 'completed' ? 'dormant' : 'active') : 'latent');
    const latestChapter = Math.max(-1, ...evidence.map((item) => Number(item.chapter ?? -1)));
    return [{
      characterId: character.id,
      canonicalName: character.canonicalName ?? character.id,
      status,
      unresolvedPressure: outcome
        ? text(outcome.remainingPressure)
        : text(state.nextChoiceBias || evidence.at(-1)?.observation || character.contradiction),
      evidence,
      currentAgenda: {
        goal: text(agenda.goal), nextAction: text(agenda.nextAction), deadline: text(agenda.deadline, 120),
        fallback: text(agenda.fallback),
      },
      relationshipResidue: relationshipResidue(projection, character.id),
      previousArc: previousArc ? {
        promise: text(previousArc.promise), lastBeat, outcomeEvidence: text(outcome?.evidence),
      } : null,
      _rank: (previousArc ? 1_000_000 : 0) + latestChapter,
    }];
  }).sort((a, b) => b._rank - a._rank || a.characterId.localeCompare(b.characterId))
    .slice(0, Math.max(0, maxCharacters))
    .map(({ _rank, ...seed }) => seed);
}

export function renderCharacterArcSeeds(seeds, kitSource) {
  const kit = asKit(kitSource);
  const t = kit.phrases.arc;
  if (!asArray(seeds).length) return t.seedsEmpty;
  return asArray(seeds).map((seed) => {
    const evidence = asArray(seed.evidence).map((item) => {
      const location = [item.chapter ? kit.phrases.common.chapterSuffix(item.chapter) : '', item.anchor].filter(Boolean).join('/');
      return `${location ? `${location}: ` : ''}${item.observation}${item.eventId ? ` [${item.eventId}]` : ''}`;
    });
    return [
      t.seedHeading(seed.characterId, seed.canonicalName, seed.status),
      seed.unresolvedPressure ? t.seedPressure(seed.unresolvedPressure) : '',
      seed.previousArc?.promise ? t.seedPreviousArc(seed.previousArc.promise, seed.previousArc.lastBeat ?? kit.phrases.common.none, seed.previousArc.outcomeEvidence) : '',
      seed.currentAgenda?.goal ? t.seedAgenda(seed.currentAgenda.goal, seed.currentAgenda.nextAction) : '',
      ...evidence.map((item) => t.seedEvidence(item)),
      ...asArray(seed.relationshipResidue).map((item) => t.seedRelationship(item.direction, item.belief)),
    ].filter(Boolean).join('\n');
  }).join('\n').slice(0, 7000);
}
