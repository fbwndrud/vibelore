import { createHash } from 'node:crypto';
import { tokenUnits } from './token-units.js';

import { asKit } from '../prompts/index.js';

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const list = (value) => Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
// Ceiling for the compiled packet, not a prose length. Generous on purpose: the
// packet only carries this episode's plan, the arc beat and a capped residue, so
// it does not grow with chapter count; the ceiling exists to compress a verbose
// plan, not to cut obligations.
export const WRITER_PACKET_MAX_TOKENS = 4000;
const DEFAULT_MAX_TOKENS = WRITER_PACKET_MAX_TOKENS;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return typeof value === 'string' ? value.normalize('NFC') : value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

/**
 * @param {{ kit?: object|null }} input `kit` 이 없으면 구작의 암묵적 ko 계열이다.
 *   작가에게 주는 의무·자유 문구만 계열을 따르고 계획 값은 작품 언어 그대로 둔다.
 */
export function compileWriterEpisodePacket({ episodePlan, arcEpisode, characterNames = {}, prevState, readabilityContract, budget = {}, kit: kitSource } = {}) {
  const kit = asKit(kitSource);
  const t = kit.phrases.packet;
  if (!episodePlan || episodePlan.status !== 'active') {
    return { ok: false, error: { code: 'EPISODE_PLAN_INACTIVE', message: '승인된 EpisodePlan이 필요합니다.' } };
  }
  const maxTokens = Number.isFinite(budget.maxTokens) ? budget.maxTokens : DEFAULT_MAX_TOKENS;
  if (arcEpisode?.chapter !== undefined && Number(arcEpisode.chapter) !== Number(episodePlan.chapter)) {
    return { ok: false, error: { code: 'ARC_EPISODE_MISMATCH', message: 'EpisodePlan과 Arc episode의 회차가 다릅니다.' } };
  }
  const derivedFields = [];
  const derived = (field, direct, fallback, derivedFrom) => {
    const value = clean(direct) || clean(fallback);
    if (!clean(direct) && value) derivedFields.push({ field, derivedFrom });
    return value;
  };
  const scenes = (episodePlan.scenes ?? []).map((scene, index) => ({
    order: Number(scene.order ?? index + 1),
    situation: clean(scene.situation || scene.objective),
    choice: clean(scene.choice || scene.obstacle),
    change: clean(scene.change || scene.turn || scene.outcome),
  }));
  const firstScene = episodePlan.scenes?.[0] ?? {};
  const lastScene = episodePlan.scenes?.at(-1) ?? {};
  const ownerId = derived('scenePressure.choiceOwner', episodePlan.scenePressure?.choiceOwner, episodePlan.povCharacter || episodePlan.cast?.[0], episodePlan.povCharacter ? 'povCharacter' : 'cast.0');
  const owner = (characterNames[ownerId] ?? ownerId) || t.ownerFallback;
  let goods = list(episodePlan.scenePressure?.incompatibleGoods);
  if (goods.length < 2) {
    goods = [...new Set((episodePlan.scenes ?? []).map((scene) => clean(scene.obstacle || scene.choice)).filter(Boolean))].slice(0, 2);
    if (goods.length) derivedFields.push({ field: 'scenePressure.incompatibleGoods', derivedFrom: 'scenes[].obstacle' });
  }
  const activeQuestion = derived('entryState.activeQuestion', episodePlan.entryState?.activeQuestion, episodePlan.premise, 'premise');
  const immediateWant = derived('entryState.protagonistImmediateWant', episodePlan.entryState?.protagonistImmediateWant, firstScene.objective || firstScene.situation, 'scenes.0.objective');
  const tickingLoss = derived('entryState.tickingLoss', episodePlan.entryState?.tickingLoss, arcEpisode?.conflict || episodePlan.arcBeat?.conflict, arcEpisode?.conflict ? 'arcEpisode.conflict' : 'arcBeat.conflict');
  const payoffPromise = derived('payoff.promisePaid', episodePlan.payoff?.promisePaid, episodePlan.closingState || lastScene.outcome, episodePlan.closingState ? 'closingState' : 'scenes.last.outcome');
  const payoffProof = derived('payoff.proofOnPage', episodePlan.payoff?.proofOnPage, lastScene.outcome || lastScene.change || lastScene.turn, 'scenes.last.outcome');
  const immediateCost = derived('costCreatedByResolution.immediate', episodePlan.costCreatedByResolution?.immediate, episodePlan.arcBeat?.cost || arcEpisode?.cost, episodePlan.arcBeat?.cost ? 'arcBeat.cost' : 'arcEpisode.cost');
  const exitState = derived('exitValue.specificFutureValue', episodePlan.exitValue?.specificFutureValue, episodePlan.closingState || lastScene.outcome, episodePlan.closingState ? 'closingState' : 'scenes.last.outcome');
  const bridgeSituation = immediateWant || activeQuestion;
  const readerBridge = derived('readerBridge', episodePlan.readerBridge,
    [bridgeSituation, tickingLoss ? kit.phrases.packet.bridgeLoss(tickingLoss) : '', kit.phrases.packet.bridgeProof(payoffProof || payoffPromise)].filter(Boolean).join(' / '),
    'entryState+payoff');
  const foreground = new Set(list(episodePlan.foregroundCharacters).length
    ? list(episodePlan.foregroundCharacters)
    : [ownerId].filter(Boolean));
  const relationshipResidue = (prevState?.relationships ?? []).filter((item) => foreground.has(clean(item.to)))
    .slice(-4).map((item) => ({ to: clean(item.to), kind: clean(item.kind), state: clean(item.state) }));
  const arcResidue = Object.entries(prevState?.arcCursor ?? {}).filter(([characterId]) => foreground.has(characterId))
    .slice(-2).map(([characterId, value]) => ({ characterId, beat: clean(value?.beat), note: clean(value?.note) }));
  const includedFields = [
    'premise', 'openingState', 'closingState', 'entryState.activeQuestion', 'entryState.protagonistImmediateWant', 'entryState.tickingLoss',
    'scenePressure.choiceOwner',
    ...scenes.flatMap((_, index) => [`scenes.${index}.situation`, `scenes.${index}.choice`, `scenes.${index}.change`]),
    'payoff.promisePaid', 'payoff.proofOnPage', 'costCreatedByResolution.immediate', 'costCreatedByResolution.deferred',
    'exitValue.closedQuestion', 'exitValue.nextQuestion', 'exitValue.specificFutureValue', 'readerBridge', 'reveals', 'withheld',
    ...(episodePlan.characterArcBeats?.length ? ['characterArcBeats'] : []),
    ...(episodePlan.episodeVoiceTargets?.length ? ['episodeVoiceTargets'] : []),
    ...(relationshipResidue.length || arcResidue.length ? ['prevState.characterResidue'] : []),
  ];
  const obligations = {
    arcCurrent: arcEpisode ? { goal: clean(arcEpisode.goal || arcEpisode.beat), pressure: clean(arcEpisode.conflict || arcEpisode.pressure), cost: clean(arcEpisode.cost), hook: clean(arcEpisode.hook || arcEpisode.carry) } : null,
    entry: { premise: clean(episodePlan.premise), openingState: clean(episodePlan.openingState), activeQuestion, want: immediateWant, tickingLoss },
    pressure: { choiceOwner: ownerId, incompatibleGoods: goods, deadline: clean(episodePlan.scenePressure?.decisionDeadline) },
    causalTurns: scenes,
    payoff: { promise: payoffPromise, proof: payoffProof },
    cost: { immediate: immediateCost, deferred: clean(episodePlan.costCreatedByResolution?.deferred), payer: clean(episodePlan.costCreatedByResolution?.payer) },
    exit: { closedQuestion: clean(episodePlan.exitValue?.closedQuestion), nextQuestion: clean(episodePlan.exitValue?.nextQuestion), state: exitState },
    readerBridge,
    readerLoad: {
      phase: clean(episodePlan.readerLoad?.phase || arcEpisode?.readerLoad?.phase || 'expansion'),
      newConcepts: list(episodePlan.readerLoad?.newConcepts),
      complexityReason: clean(episodePlan.readerLoad?.complexityReason || arcEpisode?.readerLoad?.complexityReason),
      surfaceEase: clean(readabilityContract?.surfaceEase || 'easy'),
      inferenceLoad: clean(readabilityContract?.inferenceLoad || 'explicit'),
    },
    foregroundCharacters: [...foreground],
    characterMemory: { relationships: relationshipResidue, arc: arcResidue },
    knowledgeGuards: { reveal: list(episodePlan.reveals), withhold: list(episodePlan.withheld) },
    characterChanges: (episodePlan.characterArcBeats ?? []).map((item) => ({ characterId: clean(item.characterId), beat: clean(item.beat), note: clean(item.note) })).filter((item) => item.characterId && item.beat),
    voiceTargets: (episodePlan.episodeVoiceTargets ?? []).map((item) => ({
      characterId: clean(item.characterId),
      sceneOrder: Number.isFinite(Number(item.sceneOrder)) ? Number(item.sceneOrder) : null,
      pressure: clean(item.speakingPressure),
      surfaceIntent: clean(item.surfaceIntent),
      hiddenIntent: clean(item.hiddenIntent),
      sampleLine: clean(item.sampleLine),
      narrationFilter: clean(item.narrationFilter),
    })).filter((item) => foreground.has(item.characterId) && (item.sampleLine || item.pressure)),
  };
  const missing = [];
  if (!obligations.entry.premise) missing.push('premise');
  if (scenes.length < 2) missing.push('scenes[2+]');
  scenes.forEach((scene, index) => {
    if (!scene.situation) missing.push(`scenes.${index}.situation`);
    if (!scene.choice) missing.push(`scenes.${index}.choice`);
    if (!scene.change) missing.push(`scenes.${index}.change`);
  });
  if (!obligations.payoff.promise || !obligations.payoff.proof) missing.push('payoff');
  if (!obligations.exit.state) missing.push('exit');
  if (missing.length) {
    return { ok: false, error: { code: 'MANDATORY_EPISODE_FIELD_MISSING', message: 'Writer Episode Packet으로 복원할 수 없는 필수 의무가 있습니다.', missing: [...new Set(missing)] } };
  }
  const mergedFields = [];
  let renderedExitState = obligations.exit.state;
  if (renderedExitState && renderedExitState === obligations.payoff.promise) {
    mergedFields.push({ field: 'exitValue.specificFutureValue', mergedInto: 'payoff.promisePaid' });
    renderedExitState = t.mergedExitState;
  }
  // A plan that answers "what state do we exit in" with the next question
  // verbatim would print the same sentence twice and spend packet budget on it.
  const exitMerged = Boolean(renderedExitState) && renderedExitState === obligations.exit.nextQuestion;
  if (exitMerged) mergedFields.push({ field: 'exitValue.specificFutureValue', mergedInto: 'exitValue.nextQuestion' });
  // Residue from the previous chapter that names the same beat this episode
  // carries is already covered by the character-change line.
  const carriedResidue = arcResidue.filter((item) => !obligations.characterChanges.some((change) => change.characterId === item.characterId && change.beat === item.beat));
  const none = kit.phrases.common.none;
  const protectedTruths = [
    ...(obligations.knowledgeGuards.withhold.length
      ? obligations.knowledgeGuards.withhold.map((item) => t.withheld(item))
      : []),
    obligations.payoff.proof ? t.payoffProof(obligations.payoff.proof) : '',
  ].filter(Boolean);
  const characterCarry = [
    ...obligations.characterChanges
      .filter((item) => foreground.has(item.characterId))
      .map((item) => t.characterChange(characterNames[item.characterId] ?? item.characterId, item.beat, item.note)),
    ...relationshipResidue.map((item) => t.relationshipResidue(characterNames[item.to] ?? item.to, item.kind, item.state)),
    ...carriedResidue.map((item) => t.arcResidue(characterNames[item.characterId] ?? item.characterId, item.beat, item.note)),
  ];
  const discoverySpace = [...t.discoverySpace];
  const hardBeatLines = [];
  if (scenes.length <= 2) {
    hardBeatLines.push(...scenes.map((scene) => t.beat(scene.situation, scene.choice, scene.change)));
  }
  else {
    hardBeatLines.push(t.openingPressure(scenes[0].situation));
    hardBeatLines.push(t.arrivalTurn(lastScene.change || obligations.payoff.promise));
  }
  const writerText = [
    t.readerContractHeading,
    t.readerBridge(obligations.readerBridge),
    t.readerLoad(obligations.readerLoad.surfaceEase, obligations.readerLoad.inferenceLoad, obligations.readerLoad.phase),
    obligations.readerLoad.newConcepts.length ? t.newConcepts(obligations.readerLoad.newConcepts.join(', ')) : t.noNewConcepts,
    t.dialogueRule,
    '', t.episodeCoreHeading,
    t.immediateGoal(owner, obligations.entry.want || obligations.entry.activeQuestion),
    t.obstacle(obligations.entry.tickingLoss || obligations.arcCurrent?.pressure || scenes[0]?.situation),
    goods.length >= 2 ? t.choicePressure(goods[0], goods[1]) : '',
    t.payoff(obligations.payoff.promise),
    obligations.cost.immediate || obligations.cost.deferred ? t.remainingCost(obligations.cost.immediate || obligations.cost.deferred) : '',
    exitMerged ? t.exitStateOnly(renderedExitState) : t.exitState(renderedExitState, obligations.exit.nextQuestion),
    ...(characterCarry.length ? ['', t.characterCarryHeading, ...characterCarry.map((item) => `- ${item}`), t.characterCarryFooter] : []),
    ...(protectedTruths.length ? ['', t.protectedTruthsHeading, ...protectedTruths.map((item) => `- ${item}`)] : []),
    ...(obligations.voiceTargets.length ? [
      '', t.voiceTargetsHeading,
      ...obligations.voiceTargets.map((item) => t.voiceTarget(characterNames[item.characterId] ?? item.characterId, item.sceneOrder, item.pressure || none, item.surfaceIntent || none, item.hiddenIntent || none, item.sampleLine || none, item.narrationFilter || none)),
      t.voiceTargetFooter,
    ] : []),
    '', t.minimalBeatsHeading,
    ...hardBeatLines,
    '', t.writerFreedomHeading,
    ...discoverySpace.map((item) => `- ${item}`),
    t.backgroundFreedom,
    t.writerFreedomFooter,
  ].filter((line) => line !== '').join('\n');
  const usedTokens = tokenUnits(writerText);
  if (usedTokens > maxTokens) {
    return { ok: false, error: { code: 'EPISODE_PACKET_OVERFLOW', message: '필수 EpisodePlan 의무가 Writer Packet 예산을 초과합니다.', requiredTokens: usedTokens, maxTokens, recovery: 'split_episode_or_reduce_plan' } };
  }
  return {
    ok: true,
    value: {
      writerText, obligations, freedoms: discoverySpace,
      trace: { sourcePlanRevision: episodePlan.revision ?? null, sourcePlanHash: digest(episodePlan), includedFields, derivedFields, mergedFields, omittedFields: ['workId', 'status', 'revision', 'createdAt'], obligationHash: digest(obligations) },
      usage: { usedTokens, maxTokens },
    },
  };
}
