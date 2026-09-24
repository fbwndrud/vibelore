import { gateApprovalActivation } from '../core/approval-language-gate.js';
import { characterArcBeatsForEpisode, episodeForChapter } from './arc.js';
import { renderStoryProfile } from './story-profile.js';
import { renderPatternLedger, renderPilotContract, renderStoryIdentity } from './story-experience.js';
import { createPublicationUnit } from '../core/publication-unit.js';
import { advanceWorkingTreeFingerprint } from '../core/working-tree-sync.js';
import { loadCurrentExperienceLedger, saveExperienceLedgerForHead } from '../core/experience-ledger.js';
import { MCP_CONTRACT_VERSION, runtimeVersion } from '../core/runtime-version.js';
import { validatePlanningContracts } from '../../engine/src/core/narrative-planning.js';
import { WRITER_PACKET_MAX_TOKENS, compileWriterEpisodePacket } from '../core/writer-episode-packet.js';
import { asKit, promptKit } from '../prompts/index.js';
import { resolveWorkLanguage } from '../core/work-language.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const strings = (value, max = 20) => Array.isArray(value)
  ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, max)
  : [];
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const scalarText = (value) => typeof value === 'string' || typeof value === 'number' ? value : '';

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

function normalizeScene(scene, index) {
  const obj = scene && typeof scene === 'object' ? scene : {};
  return {
    order: index + 1, location: text(obj.location, 200), characters: strings(obj.characters, 12),
    situation: text(obj.situation ?? obj.objective), choice: text(obj.choice ?? obj.obstacle), change: text(obj.change ?? obj.turn ?? obj.outcome),
    objective: text(obj.objective ?? obj.situation), obstacle: text(obj.obstacle ?? obj.choice), turn: text(obj.turn ?? obj.change), outcome: text(obj.outcome ?? obj.change),
    sceneDelta: {
      knowledge: strings(obj.sceneDelta?.knowledge, 8), want: strings(obj.sceneDelta?.want, 8),
      power: text(obj.sceneDelta?.power, 400), cost: text(obj.sceneDelta?.cost, 400), readerHypothesis: text(obj.sceneDelta?.readerHypothesis, 400),
    },
  };
}

// 커밋 시점 validateReveals 와 같은 항목. 빈 recontextualizesSceneIds 가 1화 승인 뒤 커밋에서
// REVEAL_CONTRACT_INVALID 로 터졌다(2026-09-15 ja 표본). 장면 id 는 커밋이 chapter-<n>-scene-<k> 로 붙인다.
const REVEAL_TEXT_FIELDS = ['id', 'inducedHypothesis', 'actualCause', 'concealment', 'triggeredByChoice'];
export function revealContractMissingFields(reveal) {
  const missing = REVEAL_TEXT_FIELDS.filter((key) => typeof reveal?.[key] !== 'string' || !reveal[key].trim());
  if (!Array.isArray(reveal?.dualUseClues) || reveal.dualUseClues.length === 0) missing.push('dualUseClues');
  if (!Array.isArray(reveal?.recontextualizesSceneIds) || reveal.recontextualizesSceneIds.length === 0) missing.push('recontextualizesSceneIds');
  if (!Array.isArray(reveal?.changes?.actions) || reveal.changes.actions.length === 0) missing.push('changes.actions');
  if ((reveal?.changes?.relationships?.length ?? 0) + (reveal?.changes?.costs?.length ?? 0) === 0) missing.push('changes.relationships|costs');
  return missing;
}
const AGENDA_REQUIRED_FIELDS = ['goal', 'nextAction', 'deadline', 'resources', 'knowledge', 'misbelief', 'redLine', 'fallback'];

function normalizeAgenda(value) {
  return {
    characterId: text(value?.characterId, 120), goal: text(value?.goal), hiddenPlan: text(value?.hiddenPlan),
    nextAction: text(value?.nextAction), deadline: text(value?.deadline), resources: strings(value?.resources),
    knowledge: strings(value?.knowledge), misbelief: text(value?.misbelief), redLine: text(value?.redLine), fallback: text(value?.fallback),
  };
}

function normalizeCollision(value) {
  return { agendaIds: strings(value?.agendaIds, 8), scarceConstraint: text(value?.scarceConstraint), consequence: text(value?.consequence) };
}

function normalizeVoiceTarget(value) {
  return {
    characterId: text(value?.characterId, 120),
    sceneOrder: Number.isInteger(Number(value?.sceneOrder)) ? Number(value.sceneOrder) : null,
    speakingPressure: text(value?.speakingPressure, 500),
    surfaceIntent: text(value?.surfaceIntent, 400),
    hiddenIntent: text(value?.hiddenIntent, 400),
    sampleLine: text(value?.sampleLine, 500),
    narrationFilter: text(value?.narrationFilter, 500),
  };
}

function readabilityLimits(profile, phase) {
  const contract = profile?.readabilityContract ?? {};
  const conceptLimit = contract.conceptPacing === 'fast' ? 3 : contract.conceptPacing === 'standard' ? 2 : 1;
  const foregroundLimit = contract.surfaceEase === 'dense' && phase !== 'onboarding' ? 4 : phase === 'onboarding' ? 2 : 3;
  return { conceptLimit, foregroundLimit };
}

export function episodePlanningContractViolations(obj, knownCharacterIds = []) {
  const known = new Set(knownCharacterIds);
  const referencedCharacterIds = [
    ...(Array.isArray(obj?.cast) ? obj.cast : []),
    obj?.povCharacter,
    obj?.scenePressure?.choiceOwner,
    ...(Array.isArray(obj?.scenes) ? obj.scenes.flatMap((scene) => Array.isArray(scene?.characters) ? scene.characters : []) : []),
    ...(Array.isArray(obj?.characterAgendas) ? obj.characterAgendas.map((agenda) => agenda?.characterId) : []),
    ...(Array.isArray(obj?.characterCollisions) ? obj.characterCollisions.flatMap((collision) => Array.isArray(collision?.agendaIds) ? collision.agendaIds : []) : []),
    ...(Array.isArray(obj?.episodeVoiceTargets) ? obj.episodeVoiceTargets.map((target) => target?.characterId) : []),
    ...(Array.isArray(obj?.foregroundCharacters) ? obj.foregroundCharacters : []),
  ].filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim());
  const unknown = [...new Set(referencedCharacterIds.filter((id) => !known.has(id)))];
  const violations = unknown.length ? [`등록되지 않은 characterId를 사용할 수 없습니다: ${unknown.join(', ')}`] : [];
  const agendas = (Array.isArray(obj?.characterAgendas) ? obj.characterAgendas : [])
    .map(normalizeAgenda)
    .filter((agenda) => known.has(agenda.characterId));
  const ids = new Set(agendas.map((agenda) => agenda.characterId));
  if (ids.size !== agendas.length) violations.push('characterAgendas의 characterId는 중복될 수 없습니다.');
  // 커밋 시점의 narrative-planning 계약(validateAgendaCollisions)과 같은 필수 항목을 계획 시점에
  // 요구한다. 빈 misbelief 하나가 1화 집필·승인 뒤 커밋에서야 CHARACTER_AGENDA_INVALID 로 터졌다
  // (2026-09-15 ja 표본). 호스트는 이 메시지를 feedback 으로 계획을 다시 만든다.
  for (const agenda of agendas) {
    const missing = AGENDA_REQUIRED_FIELDS.filter((key) => Array.isArray(agenda[key]) ? agenda[key].length === 0 : !agenda[key]);
    if (missing.length) violations.push(`characterAgendas[${agenda.characterId}]의 ${missing.join(', ')}이(가) 비어 있습니다. 모든 항목을 채우거나 그 인물의 agenda를 생략하십시오.`);
  }
  (Array.isArray(obj?.revealContracts) ? obj.revealContracts : []).forEach((reveal, index) => {
    const missing = revealContractMissingFields(reveal);
    if (missing.length) violations.push(`revealContracts[${typeof reveal?.id === 'string' && reveal.id.trim() ? reveal.id : index}]의 ${missing.join(', ')}이(가) 비어 있습니다. recontextualizesSceneIds 에는 chapter-<회차>-scene-<순번> 형식의 앞선 장면 id 를 적고, 뒤집을 앞선 장면이 없으면 그 revealContract 를 생략하십시오.`);
  });
  const invalidCollision = (Array.isArray(obj?.characterCollisions) ? obj.characterCollisions : [])
    .map(normalizeCollision)
    .find((collision) => collision.agendaIds.length < 2
      || !collision.scarceConstraint
      || collision.agendaIds.some((id) => !ids.has(id)));
  if (invalidCollision) violations.push('선택한 characterCollision은 등록된 characterAgenda 두 개 이상을 참조해야 합니다.');
  return violations;
}

function compilePlanningContracts(obj) {
  const characterAgendas = (Array.isArray(obj.characterAgendas) ? obj.characterAgendas : [])
    .map(normalizeAgenda).filter((agenda) => agenda.characterId);
  const agendaIds = new Set(characterAgendas.map((agenda) => agenda.characterId));
  const characterCollisions = (Array.isArray(obj.characterCollisions) ? obj.characterCollisions : [])
    .map(normalizeCollision)
    .map((collision) => ({
      ...collision,
      agendaIds: collision.agendaIds.filter((agendaId) => agendaIds.has(agendaId)),
    }))
    .filter((collision) => collision.agendaIds.length >= 2 && collision.scarceConstraint);
  const revealContracts = Array.isArray(obj.revealContracts) ? obj.revealContracts : [];
  return { characterAgendas, characterCollisions, revealContracts };
}

export function upgradeEpisodePlanningContract(plan, foundation) {
  if (!plan) return null;
  const contracts = compilePlanningContracts(plan);
  return { ...plan, ...contracts, planningContractVersion: 2, migratedFromPlanningContractVersion: plan.planningContractVersion ?? 0 };
}

async function publishApprovedEpisodePlan({ store, workId, chapter, plan }) {
  const unit = createPublicationUnit({ rootDir: store.rootDir });
  const current = await unit.readPublished();
  if (!current.ok) throw new Error(`planning publication 손상: ${current.error.code}`);
  const priorExperience = await loadCurrentExperienceLedger({ store, workId });
  const token = await unit.issueFencingToken();
  const head = current.value?.head ?? null;
  let bootstrapTree = {};
  if (!current.value) {
    const [foundation, storyProfile, storySpine, writerSkill, storyIdentity, pilotContract, patternLedger, arcPlan] = await Promise.all([
      store.loadFoundation(workId), store.loadStoryProfile(workId), store.loadStorySpine(workId), store.loadWriterSkill(workId),
      store.loadStoryIdentity(workId), store.loadPilotContract(workId), store.loadPatternLedger(workId), store.loadArcPlan(workId),
    ]);
    bootstrapTree = { workId, foundation, plans: { storyProfile, storySpine, writerSkill, storyIdentity, pilotContract, patternLedger, arcPlan } };
  }
  const result = await unit.publish({
    context: {
      snapshotId: head ?? 'genesis', expectedHead: head, storyTimeScope: { worldline: 'main', through: Math.max(0, chapter - 1) },
      publicationOrder: Math.max(1, chapter), transactionTime: new Date().toISOString(), policyRevision: 'vibelore-1',
      semanticGeneration: 'vibelore-1', fencingToken: token.value.fencingToken,
    },
    candidate: {
      // Once HEAD exists, only the explicitly approved EpisodePlan is patched.
      // Unaccepted working-tree edits to foundation/arc must not hitchhike.
      tree: { ...bootstrapTree, plans: { ...(bootstrapTree.plans ?? {}), episodePlans: { [chapter]: plan } } },
      projections: current.value?.projections ?? {}, impactClosure: [{ id: `episode-plan:${chapter}`, dependencyKind: 'plan', status: 'satisfied' }],
    },
  });
  if (!result.ok) throw new Error(`planning publication 실패: ${result.error.code}`);
  if (priorExperience.status === 'fresh') {
    await saveExperienceLedgerForHead({
      store, workId, sourceHead: result.value.head,
      entries: priorExperience.entries,
      criticVersion: priorExperience.criticVersion,
    });
  }
  await advanceWorkingTreeFingerprint({ store, previousHead: head, sourceHead: result.value.head });
  return result.value;
}

export async function runEpisodePlan({ store, workId, chapter, mode = 'auto', direction = '', feedback = '', providers, retryValidation = false }) {
  const foundation = await store.loadFoundation(workId);
  if (!foundation) throw new Error('작품이 없습니다.');
  const arcPlan = await store.loadArcPlan(workId);
  const arcBeat = episodeForChapter(arcPlan, chapter);
  if (!arcBeat) throw new Error('승인된 아크의 해당 회차 비트가 없습니다.');
  const storyProfile = await store.loadStoryProfile(workId);
  if (storyProfile && storyProfile.status !== 'active') throw new Error('StoryProfile 승인 후 에피소드를 계획하세요.');
  const prior = await store.loadEpisodePlan(workId, chapter);
  const summaries = await store.loadRecentChapterSummaries(workId, chapter, 5);
  const state = chapter > 1 ? await store.loadStoryState(workId, chapter - 1) : null;
  const identity = await store.loadStoryIdentity(workId);
  const pilotContract = chapter === 1 ? await store.loadPilotContract(workId) : null;
  const patternLedger = await store.loadPatternLedger(workId);
  const workLanguage = await resolveWorkLanguage({ store, workId, foundation });
  const kit = promptKit({ contract: workLanguage.contract });
  const planMessages = kit.messages('episode-plan', {
      profileRender: renderStoryProfile(storyProfile, kit),
      identityRender: renderStoryIdentity(identity, kit),
      pilotRender: renderPilotContract(pilotContract, kit),
      ledgerRender: renderPatternLedger(patternLedger, kit),
      arcTitle: arcPlan.title, arcPromise: arcPlan.promise,
      arcBeatsJson: JSON.stringify(characterArcBeatsForEpisode(arcPlan, arcBeat.index)),
      arcBeatJson: JSON.stringify(arcBeat),
      direction: direction || kit.phrases.common.noneParen,
      feedback: feedback || kit.phrases.common.noneParen,
      priorJson: prior ? JSON.stringify(prior) : kit.phrases.common.noneParen,
      worldFactsJson: JSON.stringify(foundation.worldFacts.map((f) => f.statement)),
      castJson: JSON.stringify(foundation.characters.map((c) => ({ id: c.id, name: c.canonicalName, contradiction: c.contradiction, role: c.intrinsic?.role }))),
      summariesJson: JSON.stringify(summaries.reverse().map((s) => s.summary)),
      stateJson: JSON.stringify(state),
  });
  const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'episode-plan', messages: planMessages });
  if ((providers.pending?.length ?? 0) > 0) return { preview: true };
  const knownCharacterIds = foundation.characters.map((character) => character.id);
  const acceptPlan = (raw) => {
    const parsed = parse(raw);
    if (!parsed || !Array.isArray(parsed.scenes) || parsed.scenes.length < 2 || parsed.scenes.length > 4) throw new Error('episode-plan은 2~4개 scenes가 필요합니다.');
    const inputViolations = episodePlanningContractViolations(parsed, knownCharacterIds);
    // Incomplete agendas or reveal contracts get the same single repair round as
    // the planning-contract validator below instead of failing the whole plan.
    if (inputViolations.length) {
      return { parsed, contracts: null, failure: { error: {
        code: 'EPISODE_PLAN_CONTRACT_INVALID', message: `episode-plan 계획 계약 검증 실패: ${inputViolations.join(' ')}`, details: { violations: inputViolations },
      } } };
    }
    const contracts = compilePlanningContracts(parsed);
    const failure = validatePlanningContracts({
      agendas: contracts.characterAgendas, collisions: contracts.characterCollisions, reveals: contracts.revealContracts,
    });
    return { parsed, contracts, failure };
  };
  // The commit path rejects an incomplete optional module with the same
  // validator. Catching it here costs at most one extra planning answer instead
  // of a full draft, every review and a failed commit.
  let accepted = acceptPlan(response.text);
  if (accepted.failure) {
    const repair = await providers.complete({
      model: MODEL, jsonMode: true, step: 'episode-plan-repair',
      messages: [
        planMessages[0],
        { role: 'user', content: [
          planMessages[1].content, '',
          kit.phrases.episode.episodePlanRepair({ previousText: String(response.text), error: accepted.failure.error }),
        ].join('\n') },
      ],
    });
    if ((providers.pending?.length ?? 0) > 0) return { preview: true };
    accepted = acceptPlan(repair.text);
    if (accepted.failure) {
      throw new Error(`${accepted.failure.error.code}: ${accepted.failure.error.message} ${JSON.stringify(accepted.failure.error.details ?? {})}`);
    }
  }
  const buildPlan = (acceptedPlan) => {
    const obj = acceptedPlan.parsed;
    const planningContracts = acceptedPlan.contracts;
    const onboardingCutoff = Math.max(2, Math.ceil(Number(arcPlan.estimatedEpisodes ?? arcPlan.episodes?.length ?? 3) / 3));
    const requiresOnboarding = (storyProfile?.readabilityContract?.complexityRamp ?? 'onboarding-first') === 'onboarding-first'
      && Number(arcPlan.arcNumber) === 1
      && Number(arcBeat.index) <= onboardingCutoff;
    const readerLoadPhase = requiresOnboarding || arcBeat.readerLoad?.phase === 'onboarding'
      ? 'onboarding'
      : ['onboarding', 'expansion', 'focus'].includes(obj.readerLoad?.phase)
        ? obj.readerLoad.phase
        : arcBeat.readerLoad?.phase ?? 'expansion';
    const limits = readabilityLimits(storyProfile, readerLoadPhase);
    const requestedForeground = strings(obj.foregroundCharacters, limits.foregroundLimit);
    const cast = strings(obj.cast);
    const foregroundCharacters = requestedForeground.length
      ? requestedForeground
      : [...new Set([obj.povCharacter, ...cast].filter(Boolean))].slice(0, limits.foregroundLimit);
    const immediateGoal = text(obj.immediateGoal || obj.entryState?.protagonistImmediateWant || obj.premise);
    const obstacle = text(obj.obstacle || obj.scenePressure?.withheldByOther || obj.scenes[0]?.situation);
    const choice = text(obj.choice || obj.turn?.causedByChoice || obj.scenes.find((scene) => scene.choice)?.choice);
    const outcome = text(obj.outcome || obj.closingState || obj.payoff?.promisePaid || scalarText(obj.payoff));
    const nextQuestion = text(obj.nextQuestion || obj.exitValue?.nextQuestion || arcBeat.exitValue || arcBeat.hook || outcome);
    const requestedConcepts = Array.isArray(obj.readerLoad?.newConcepts)
      ? obj.readerLoad.newConcepts
      : [arcBeat.readerLoad?.newConcept].filter(Boolean);
    const plan = {
      workId, episodePlanSchemaVersion: 2, contractVersion: MCP_CONTRACT_VERSION,
      chapter, arcNumber: arcPlan.arcNumber, arcEpisodeIndex: arcBeat.index,
      arcBeat: {
        title: arcBeat.title, goal: arcBeat.goal, conflict: arcBeat.conflict,
        growth: arcBeat.growth, cost: arcBeat.cost,
        hook: arcBeat.hook || arcBeat.exitValue,
        exitValue: arcBeat.exitValue, readerLoad: arcBeat.readerLoad,
      },
      title: text(obj.title || arcBeat.title, 200), premise: text(obj.premise), readerBridge: text(obj.readerBridge, 500),
      povCharacter: typeof obj.povCharacter === 'string' ? obj.povCharacter : null,
      cast, foregroundCharacters, locations: strings(obj.locations), openingState: text(obj.openingState), closingState: text(obj.closingState || outcome),
      readerLoad: {
        phase: readerLoadPhase,
        newConcepts: strings(requestedConcepts, limits.conceptLimit),
        complexityReason: text(obj.readerLoad?.complexityReason || arcBeat.readerLoad?.complexityReason, 300),
      },
      entryState: { activeQuestion: text(obj.entryState?.activeQuestion || obj.premise), protagonistImmediateWant: immediateGoal, tickingLoss: text(obj.entryState?.tickingLoss) },
      readerExpectation: { likelyOutcome: text(obj.readerExpectation?.likelyOutcome), evidenceOnPage: strings(obj.readerExpectation?.evidenceOnPage, 8), confidenceTarget: text(obj.readerExpectation?.confidenceTarget, 20) },
      scenePressure: { choiceOwner: text(obj.scenePressure?.choiceOwner || obj.povCharacter, 120), incompatibleGoods: strings(obj.scenePressure?.incompatibleGoods, 4), withheldByOther: obstacle, decisionDeadline: text(obj.scenePressure?.decisionDeadline) },
      payoff: { promisePaid: text(obj.payoff?.promisePaid || scalarText(obj.payoff) || outcome), proofOnPage: text(obj.payoff?.proofOnPage || outcome), notJustReported: obj.payoff?.notJustReported !== false },
      turn: { brokenBelief: text(obj.turn?.brokenBelief), causedByChoice: choice, priorClueReinterpreted: text(obj.turn?.priorClueReinterpreted) },
      costCreatedByResolution: { immediate: text(obj.costCreatedByResolution?.immediate), deferred: text(obj.costCreatedByResolution?.deferred), beneficiary: text(obj.costCreatedByResolution?.beneficiary), payer: text(obj.costCreatedByResolution?.payer) },
      exitValue: {
        closedQuestion: text(obj.exitValue?.closedQuestion),
        nextQuestion,
        hookType: text(obj.exitValue?.hookType || 'result', 40),
        specificFutureValue: text(obj.exitValue?.specificFutureValue || nextQuestion),
      },
      metricDramaturgy: Object.fromEntries(Object.entries(obj.metricDramaturgy && typeof obj.metricDramaturgy === 'object' ? obj.metricDramaturgy : {}).map(([key, value]) => [key, text(value, 500)])),
      scenes: obj.scenes.map(normalizeScene), reveals: strings(obj.reveals), withheld: strings(obj.withheld),
      episodeVoiceTargets: (Array.isArray(obj.episodeVoiceTargets) ? obj.episodeVoiceTargets : []).map(normalizeVoiceTarget)
        .filter((item) => foregroundCharacters.includes(item.characterId) && (item.sampleLine || item.speakingPressure)).slice(0, limits.foregroundLimit),
      ...planningContracts, planningContractVersion: 2,
      tension: { ticking: text(obj.tension?.ticking, 500), stake: text(obj.tension?.stake, 500), escalation: text(obj.tension?.escalation, 500) },
      powerChanges: strings(obj.powerChanges), artifacts: strings(obj.artifacts), absurdity: text(obj.absurdity),
      characterArcBeats: characterArcBeatsForEpisode(arcPlan, arcBeat.index),
      ...(pilotContract ? { pilotContract } : {}),
      hooksTouched: strings(obj.hooksTouched), carryForward: strings(obj.carryForward),
      status: mode === 'review' ? 'pending' : 'active', revision: Number(prior?.revision ?? 0) + 1,
      createdAt: new Date().toISOString(),
    };
    return plan;
  };
  let plan = buildPlan(accepted);
  const characterNames = Object.fromEntries(foundation.characters.map((character) => [character.id, character.canonicalName]));
  const packetBudget = (candidate) => compileWriterEpisodePacket({
    episodePlan: { ...candidate, status: 'active' }, arcEpisode: arcBeat, prevState: state,
    readabilityContract: storyProfile?.readabilityContract, characterNames, budget: { maxTokens: WRITER_PACKET_MAX_TOKENS },
  });
  // The draft step compiles this plan into a fixed-budget writer packet. An
  // overflow there used to surface only after the plan was saved, so it is
  // checked here and repaired with one more planning answer instead.
  let packet = packetBudget(plan);
  if (!packet.ok && packet.error.code === 'EPISODE_PACKET_OVERFLOW') {
    const repair = await providers.complete({
      model: MODEL, jsonMode: true, step: 'episode-plan-repair',
      messages: [
        planMessages[0],
        { role: 'user', content: [
          planMessages[1].content, '',
          '이전 응답:', JSON.stringify(accepted.parsed), '',
          `검증 오류: ${JSON.stringify(packet.error)}`,
          '이 계획은 집필 단계의 Writer Packet 예산을 초과한다. 사건·선택·결과·선택 모듈의 내용은 유지하되 readerBridge, closingState, scenes[].situation·choice·change, payoff, costCreatedByResolution, exitValue, episodeVoiceTargets의 문장을 짧고 구체적으로 줄여 전체 계획 JSON을 다시 출력한다. 같은 문장을 두 필드에 반복하지 않는다.',
        ].join('\n') },
      ],
    });
    if ((providers.pending?.length ?? 0) > 0) return { preview: true };
    accepted = acceptPlan(repair.text);
    if (accepted.failure) {
      throw new Error(`${accepted.failure.error.code}: ${accepted.failure.error.message} ${JSON.stringify(accepted.failure.error.details ?? {})}`);
    }
    plan = buildPlan(accepted);
    packet = packetBudget(plan);
    if (!packet.ok && packet.error.code === 'EPISODE_PACKET_OVERFLOW') {
      throw new Error(`EPISODE_PACKET_OVERFLOW: 계획이 Writer Packet 예산을 초과합니다 (${packet.error.requiredTokens}/${packet.error.maxTokens} 토큰).`);
    }
  }
  const approval = await gateApprovalActivation({ store, workId, kind: 'episode', stateKey: `episode-${chapter}`, value: plan, providers, structuralErrors: episodePlanningContractViolations(plan, foundation.characters.map(c => c.id)), retryValidation });
  if (!approval.ok) return { ...approval, candidate: plan };
  await store.saveEpisodePlan(workId, plan);
  if (plan.status === 'active') await publishApprovedEpisodePlan({ store, workId, chapter, plan });
  return {
    plan,
    ...(plan.status === 'pending'
      ? { needsApproval: true, instruction: '에피소드 장면 계획을 사용자에게 보여주고 승인 여부를 물으세요.' }
      : { needsApproval: false }),
  };
}

export async function runEpisodeDecide({ store, workId, chapter, action, providers, retryValidation = false }) {
  const plan = await store.loadEpisodePlan(workId, chapter);
  if (!plan) throw new Error('검토할 EpisodePlan이 없습니다.');
  const status = action === 'approve' ? 'active' : action === 'reject' ? 'rejected' : null;
  if (!status) throw new Error('action은 approve 또는 reject여야 합니다.');
  const next = { ...plan, status, [`${status}At`]: new Date().toISOString() };
  if (status === 'active') {
    const foundation = await store.loadFoundation(workId);
    const approval = await gateApprovalActivation({ store, workId, kind: 'episode', stateKey: `episode-${chapter}`, value: next, providers, consumeOnly: true, structuralErrors: episodePlanningContractViolations(next, foundation.characters.map(c => c.id)), retryValidation });
    if (!approval.ok) return { ...approval, approved: false };
  }
  await store.saveEpisodePlan(workId, next);
  if (status === 'active') await publishApprovedEpisodePlan({ store, workId, chapter, plan: next });
  return { approved: status === 'active', plan: next, ...(status === 'rejected' ? { instruction: '피드백과 함께 lore_episode_plan을 다시 호출하세요.' } : {}) };
}

export async function runEpisodeStatus({ store, workId, chapter }) {
  const plan = await store.loadEpisodePlan(workId, chapter);
  return plan ? { planned: true, plan, runtime: runtimeVersion() } : { planned: false, chapter, runtime: runtimeVersion() };
}

export async function completeEpisodePlan({ store, workId, chapter }) {
  const plan = await store.loadEpisodePlan(workId, chapter);
  if (!plan || plan.status !== 'active') return null;
  const next = { ...plan, status: 'completed', completedAt: new Date().toISOString() };
  await store.saveEpisodePlan(workId, next);
  return { chapter, status: 'completed' };
}

export function renderEpisodePlan(plan, kitSource) {
  if (!plan || plan.status !== 'active') return '';
  const kit = asKit(kitSource);
  const t = kit.phrases.episode;
  const none = kit.phrases.common.none;
  return [
    t.heading(plan.chapter, plan.title), t.premise(plan.premise),
    t.readerBridge(plan.readerBridge || t.readerBridgeFallback),
    t.readerLoad(plan.readerLoad?.phase ?? 'expansion', plan.readerLoad?.newConcepts?.length ? plan.readerLoad.newConcepts.join(', ') : ''),
    t.immediateGoal(plan.entryState?.protagonistImmediateWant || plan.premise),
    t.obstacle(plan.scenePressure?.withheldByOther || plan.scenes?.[0]?.situation || none),
    t.choiceAndResult(plan.turn?.causedByChoice || t.choiceFallback, plan.payoff?.promisePaid || plan.closingState),
    t.nextState(plan.exitValue?.nextQuestion || plan.closingState),
    t.foreground((plan.foregroundCharacters ?? []).join(', ') || plan.povCharacter || kit.phrases.common.undecided),
    t.cast((plan.cast ?? []).join(', ') || none), t.locations((plan.locations ?? []).join(', ') || none),
    t.sceneHeading, ...(plan.scenes ?? []).map((s) => t.scene(s.order, s.location, s.situation ?? s.objective, s.choice ?? s.obstacle, s.change ?? s.turn)),
    plan.costCreatedByResolution?.immediate || plan.costCreatedByResolution?.deferred
      ? t.remainingCost(plan.costCreatedByResolution.immediate || plan.costCreatedByResolution.deferred) : '',
    plan.reveals?.length ? t.reveals(plan.reveals.join('; ')) : '',
    plan.withheld?.length ? t.withheld(plan.withheld.join('; ')) : '',
    plan.characterArcBeats?.length ? t.characterBeats(plan.characterArcBeats.map((b) => t.characterBeat(b.characterId, b.beat, b.note)).join('; ')) : '',
    ...(plan.episodeVoiceTargets?.length ? [
      t.voiceTargetHeading,
      ...plan.episodeVoiceTargets.map((v) => t.voiceTarget(v.characterId || kit.phrases.common.unknown, v.sceneOrder, v.speakingPressure || none, v.surfaceIntent || none, v.hiddenIntent || none, v.sampleLine || none, v.narrationFilter || none)),
    ] : []),
    ...(plan.pilotContract ? [renderPilotContract(plan.pilotContract, kit)] : []),
    t.backgroundFreedom,
    t.sceneFreedom,
  ].filter(Boolean).join('\n');
}
