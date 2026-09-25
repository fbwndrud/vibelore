import { gateApprovalActivation } from '../core/approval-language-gate.js';
import { arcPositionFromRatio } from '../../engine/src/core/arc-context.js';
import { CHARACTER_ARC_BEATS } from '../../engine/src/continuity/character-arc.js';
import { compileBriefWithProfile } from './story-profile.js';
import { characterArcBeatCollisions, deterministicArcViolations, runArcQuality } from './arc-quality.js';
import { renderStorySpine } from './story-spine.js';
import { MCP_CONTRACT_VERSION, runtimeVersion } from '../core/runtime-version.js';
import { createPublicationUnit } from '../core/publication-unit.js';
import { openCanonRepository } from '../core/canon-repository.js';
import { compileCharacterArcSeeds, renderCharacterArcSeeds } from '../core/character-arc-seeds.js';
import { asKit, promptKit } from '../prompts/index.js';
import { resolveWorkLanguage } from '../core/work-language.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

function defaultReaderLoadPhase({ index, count, arcNumber, complexityRamp }) {
  if (complexityRamp === 'dense-start') return 'expansion';
  if (complexityRamp === 'steady' || arcNumber > 1) return 'expansion';
  return index < Math.max(2, Math.ceil(count / 3)) ? 'onboarding' : 'expansion';
}

function normalizeEpisode(item, index, startChapter, readerLoadDefaults, kit) {
  const obj = item && typeof item === 'object' ? item : {};
  const beat = String(obj.beat ?? obj.goal ?? '').slice(0, 500);
  const pressure = String(obj.pressure ?? obj.conflict ?? '').slice(0, 500);
  const requestedPhase = String(obj.readerLoad?.phase ?? obj.readabilityPhase ?? '');
  const fallbackPhase = defaultReaderLoadPhase({ index, ...readerLoadDefaults });
  const phase = fallbackPhase === 'onboarding'
    ? 'onboarding'
    : ['onboarding', 'expansion', 'focus'].includes(requestedPhase)
    && (requestedPhase !== 'focus' || String(obj.readerLoad?.complexityReason ?? '').trim())
    ? requestedPhase
    : fallbackPhase;
  return {
    index: index + 1,
    chapter: startChapter + index,
    title: String(obj.title ?? kit.phrases.arc.episodeTitleFallback(index + 1)).slice(0, 120),
    beat, pressure, turn: String(obj.turn ?? '').slice(0, 500), carry: String(obj.carry ?? '').slice(0, 500),
    readerExpectation: String(obj.readerExpectation ?? '').slice(0, 500),
    payoff: String(obj.payoff ?? '').slice(0, 500),
    costCreatedByResolution: String(obj.costCreatedByResolution ?? obj.cost ?? '').slice(0, 500),
    exitValue: String(obj.exitValue ?? obj.hook ?? obj.carry ?? '').slice(0, 500),
    // Legacy aliases remain readable while callers migrate to the thinner beat.
    goal: beat,
    conflict: pressure,
    growth: String(obj.growth ?? '').slice(0, 500),
    cost: String(obj.cost ?? '').slice(0, 500),
    hook: String(obj.hook ?? '').slice(0, 500),
    readerLoad: {
      phase,
      newConcept: String(obj.readerLoad?.newConcept ?? '').trim().slice(0, 200),
      complexityReason: String(obj.readerLoad?.complexityReason ?? '').trim().slice(0, 300),
    },
    status: 'pending',
  };
}

const short = (value, max = 800) => String(value ?? '').trim().slice(0, max);
const shortList = (value, max = 12) => Array.isArray(value)
  ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, 500)).slice(0, max)
  : [];

function normalizeCommercialArc(obj, foundation) {
  const known = new Set(foundation.characters.map((c) => c.id));
  return {
    commercialPromise: {
      fantasy: short(obj.commercialPromise?.fantasy || obj.promise),
      humanComplication: short(obj.commercialPromise?.humanComplication),
      repeatableProof: short(obj.commercialPromise?.repeatableProof),
    },
    readerContract: {
      openingQuestion: short(obj.readerContract?.openingQuestion),
      expectedPath: short(obj.readerContract?.expectedPath),
      promisedPayoffBy: Number(obj.readerContract?.promisedPayoffBy) || null,
      minimumPayoff: short(obj.readerContract?.minimumPayoff || obj.promise),
    },
    characterPressureMatrix: (Array.isArray(obj.characterPressureMatrix) ? obj.characterPressureMatrix : []).flatMap((row) => {
      const characterId = short(row?.characterId, 120);
      return known.has(characterId) ? [{ characterId, visibleWant: short(row.visibleWant), privateNeed: short(row.privateNeed), protectedSecret: short(row.protectedSecret), lineTheyWillNotCross: short(row.lineTheyWillNotCross), pressureThatMayBreakIt: short(row.pressureThatMayBreakIt) }] : [];
    }).slice(0, 8),
    misconceptionStack: (Array.isArray(obj.misconceptionStack) ? obj.misconceptionStack : []).map((item, index) => ({
      id: short(item?.id || `misconception_${index + 1}`, 120), readerBelief: short(item?.readerBelief), characterBelief: short(item?.characterBelief),
      hiddenCausality: short(item?.hiddenCausality), evidenceToPlant: shortList(item?.evidenceToPlant, 6), revealPolicy: short(item?.revealPolicy),
    })).slice(0, 6),
    escalatingCosts: shortList(obj.escalatingCosts),
    oppositionAgency: {
      actor: short(obj.oppositionAgency?.actor), independentGoal: short(obj.oppositionAgency?.independentGoal),
      knowledge: short(obj.oppositionAgency?.knowledge), adaptationTrigger: short(obj.oppositionAgency?.adaptationTrigger),
    },
    openOutcomeSpace: {
      mustResolve: shortList(obj.openOutcomeSpace?.mustResolve), mayResolve: shortList(obj.openOutcomeSpace?.mayResolve),
      mustRemainCostly: shortList(obj.openOutcomeSpace?.mustRemainCostly),
    },
  };
}

function normalizeArcVoiceShifts(value, foundation) {
  const known = new Set(foundation.characters.map((c) => c.id));
  return (Array.isArray(value) ? value : []).flatMap((raw) => {
    const characterId = short(raw?.characterId, 120);
    if (!known.has(characterId)) return [];
    return [{
      characterId,
      startingVoice: short(raw.startingVoice),
      pressureVoice: short(raw.pressureVoice),
      changedVoice: short(raw.changedVoice),
      sampleBefore: short(raw.sampleBefore, 500),
      sampleAfter: short(raw.sampleAfter, 500),
    }];
  }).slice(0, 8);
}

function normalizeCharacterArcs(value, foundation, count, seeds = []) {
  const known = new Set(foundation.characters.map((c) => c.id));
  const seedByCharacter = new Map(seeds.map((seed) => [seed.characterId, seed]));
  return (Array.isArray(value) ? value : []).slice(0, 2).flatMap((raw) => {
    const characterId = String(raw?.characterId ?? '');
    if (!known.has(characterId)) return [];
    const requested = (Array.isArray(raw?.beats) ? raw.beats : []).flatMap((item) => {
      const episodeIndex = Number(item?.episodeIndex);
      const beat = String(item?.beat ?? '');
      if (!Number.isInteger(episodeIndex) || episodeIndex < 1 || episodeIndex > count || !CHARACTER_ARC_BEATS.includes(beat)) return [];
      return [{ episodeIndex, beat, note: String(item?.note ?? '').slice(0, 500) }];
    }).sort((a, b) => a.episodeIndex - b.episodeIndex);
    const beats = requested.filter((item, index) => index === 0 || item.episodeIndex > requested[index - 1].episodeIndex);
    const seed = seedByCharacter.get(characterId);
    return [{
      characterId, promise: String(raw?.promise ?? '').slice(0, 600), beats,
      ...(seed ? {
        inheritedState: {
          status: seed.status,
          unresolvedPressure: seed.unresolvedPressure,
          previousPromise: seed.previousArc?.promise ?? '',
          previousBeat: seed.previousArc?.lastBeat ?? null,
        },
        sourceEvidence: seed.evidence,
      } : {}),
    }];
  });
}

async function loadCharacterDynamics(store, workId) {
  if (typeof store.loadCharacterDynamics === 'function') return store.loadCharacterDynamics(workId);
  if (!store.rootDir) return null;
  const canonical = await openCanonRepository({
    store, publicationUnit: createPublicationUnit({ rootDir: store.rootDir }),
  });
  return typeof canonical.loadCharacterDynamics === 'function'
    ? canonical.loadCharacterDynamics(workId)
    : null;
}

export function characterArcBeatsForEpisode(plan, episodeIndex) {
  return (plan?.characterArcs ?? []).flatMap((arc) => arc.beats
    .filter((beat) => beat.episodeIndex === episodeIndex)
    .map((beat) => ({ characterId: arc.characterId, promise: arc.promise, beat: beat.beat, note: beat.note })));
}

export function episodeForChapter(plan, chapter) {
  if (!plan || plan.status !== 'active') return null;
  return plan.episodes.find((episode) => episode.chapter === chapter) ?? null;
}

export async function runArcPlan({ store, workId, mode = 'review', episodes = 8, direction = '', feedback = '', providers, retryValidation = false }) {
  const foundation = await store.loadFoundation(workId);
  if (!foundation) throw new Error('작품이 없습니다.');
  const chapters = await store.listChapters();
  const startChapter = (chapters.at(-1) ?? 0) + 1;
  const previous = await store.loadArcPlan(workId);
  const arcNumber = Number(previous?.arcNumber ?? 0) + (previous?.status === 'pending' ? 0 : 1);
  const previousFinalChapter = previous?.episodes?.at(-1)?.chapter;
  const previousArcReview = previous?.status === 'completed' && previousFinalChapter
    ? await store.loadArcReview(workId, previous.arcNumber, previousFinalChapter)
    : null;
  const count = Math.max(3, Math.min(Number(episodes) || 8, 20));
  const summaries = await store.loadRecentChapterSummaries(workId, startChapter, 10);
  const storyProfile = await store.loadStoryProfile(workId);
  if (storyProfile && storyProfile.status !== 'active') throw new Error('StoryProfile 승인 후 아크를 계획하세요.');
  const storySpine = await store.loadStorySpine(workId);
  if (!storySpine || storySpine.status !== 'active') throw new Error('승인된 StorySpine을 먼저 만들고 승인하세요.');
  const writerSkill = await store.loadWriterSkill(workId);
  if (!writerSkill || writerSkill.status !== 'active') throw new Error('승인된 WriterSkill을 먼저 만들고 승인하세요.');
  const workLanguage = await resolveWorkLanguage({ store, workId, foundation });
  const kit = promptKit({ contract: workLanguage.contract });
  const profileDirection = compileBriefWithProfile(direction || foundation.brief || '', storyProfile, 'arc', kit);
  const characterArcSeeds = compileCharacterArcSeeds({
    foundation,
    projection: await loadCharacterDynamics(store, workId),
    previousArcPlan: previous,
    previousArcReview,
  });
  const response = await providers.complete({
    model: MODEL, jsonMode: true, step: 'arc-plan',
    messages: kit.messages('arc-plan', {
      title: foundation.title ?? workId, genre: foundation.genre, arcNumber, startChapter, count,
      direction: profileDirection || kit.phrases.common.autonomous,
      spineRender: renderStorySpine(storySpine, kit),
      feedback: feedback || kit.phrases.common.noneParen,
      worldFacts: foundation.worldFacts.map((f) => f.statement),
      characters: foundation.characters.map((c) => `${c.id}/${c.canonicalName}: ${c.contradiction ?? ''}`),
      seedsRender: renderCharacterArcSeeds(characterArcSeeds, kit),
      summaries: summaries.reverse().map((s) => s.summary),
      previousArcReviewJson: previousArcReview ? JSON.stringify({
        dimensions: previousArcReview.dimensions,
        findings: previousArcReview.findings?.map(({ dimension, code, message }) => ({ dimension, code, message })),
      }) : kit.phrases.common.noneParen,
    }),
  });
  if ((providers.pending?.length ?? 0) > 0) return { preview: true };
  const obj = parse(response.text);
  if (!obj || !Array.isArray(obj.episodes) || obj.episodes.length !== count) throw new Error(`arc-plan 응답은 정확히 ${count}개 episodes여야 합니다.`);
  const plan = {
    workId, arcPlanSchemaVersion: 2, characterArcSeedVersion: 1, contractVersion: MCP_CONTRACT_VERSION,
    arcNumber, title: String(obj.title ?? '').slice(0, 200), promise: String(obj.promise ?? '').slice(0, 600),
    type: ['small', 'standard', 'volume'].includes(obj.type) ? obj.type : 'standard',
    storySpineNodes: shortList(obj.storySpineNodes, 8).length
      ? shortList(obj.storySpineNodes, 8)
      : storySpine.causalChain.slice(Math.max(0, arcNumber - 1), Math.max(1, arcNumber)),
    startChapter, estimatedEpisodes: count, status: mode === 'auto' ? 'active' : 'pending',
    episodes: obj.episodes.map((item, index) => normalizeEpisode(item, index, startChapter, {
      count,
      arcNumber,
      complexityRamp: storyProfile?.readabilityContract?.complexityRamp ?? 'onboarding-first',
    }, kit)),
    characterArcs: normalizeCharacterArcs(obj.characterArcs, foundation, count, characterArcSeeds),
    arcVoiceShifts: normalizeArcVoiceShifts(obj.arcVoiceShifts, foundation),
    ...normalizeCommercialArc(obj, foundation),
  };
  if (!plan.title || !plan.promise) throw new Error('arc-plan에 title과 promise가 필요합니다.');
  if (!plan.storySpineNodes.length) throw new Error('아크는 전진시킬 StorySpine 노드를 최소 하나 참조해야 합니다.');
  const structuralViolations = [...characterArcBeatCollisions(obj.characterArcs, count), ...deterministicArcViolations(plan)];
  if (structuralViolations.length) throw new Error(`아크 품질 검증 실패: ${structuralViolations.map((item) => item.message).join(' ')}`);
  const quality = await runArcQuality({ foundation, plan, providers, kit });
  if ((providers.pending?.length ?? 0) > 0) return { preview: true, operation: 'arc-quality' };
  if (quality.verdict !== 'passed') throw new Error(`아크 품질 검증 실패: ${quality.findings.map((item) => item.message).join(' ') || `총점 ${quality.score}, 취약 차원 ${quality.weakDimensions.join(', ')}`}`);
  plan.quality = quality;
  plan.createdAt = new Date().toISOString();
  const approval = await gateApprovalActivation({ store, workId, kind: 'arc', value: plan, providers, resolution: workLanguage, structuralErrors: deterministicArcViolations(plan), retryValidation });
  if (!approval.ok) return { ...approval, candidate: plan };
  await store.saveArcPlan(workId, plan);
  return {
    plan,
    ...(plan.status === 'pending'
      ? { needsApproval: true, instruction: '이 계획을 사용자에게 보여주고 마음에 드는지 물으세요. 승인 전에는 집필하지 마세요.' }
      : { needsApproval: false, instruction: '자동 승인되었습니다. 첫 회차부터 집필할 수 있습니다.' }),
  };
}

export async function runArcDecide({ store, workId, action, providers, retryValidation = false }) {
  const plan = await store.loadArcPlan(workId);
  if (!plan) throw new Error('검토할 아크 계획이 없습니다.');
  if (action === 'approve') {
    const active = { ...plan, status: 'active', approvedAt: new Date().toISOString() };
    const approval = await gateApprovalActivation({ store, workId, kind: 'arc', value: active, providers, consumeOnly: true, structuralErrors: deterministicArcViolations(active), retryValidation });
    if (!approval.ok) return { ...approval, approved: false };
    await store.saveArcPlan(workId, active);
    return { approved: true, plan: active };
  }
  if (action === 'reject') {
    const rejected = { ...plan, status: 'rejected', rejectedAt: new Date().toISOString() };
    await store.saveArcPlan(workId, rejected);
    return { approved: false, plan: rejected, instruction: '피드백과 함께 lore_arc_plan을 다시 호출하세요.' };
  }
  throw new Error('action은 approve 또는 reject여야 합니다.');
}

export async function runArcStatus({ store, workId }) {
  const plan = await store.loadArcPlan(workId);
  if (!plan) return { planned: false, runtime: runtimeVersion() };
  const chapters = await store.listChapters();
  const nextChapter = (chapters.at(-1) ?? 0) + 1;
  return { planned: true, plan, nextChapter, currentEpisode: episodeForChapter(plan, nextChapter), runtime: runtimeVersion() };
}

export async function advanceArcAfterCommit({ store, workId, chapter }) {
  const plan = await store.loadArcPlan(workId);
  if (!plan || plan.status !== 'active') return null;
  const episodes = plan.episodes.map((episode) => episode.chapter === chapter ? { ...episode, status: 'completed' } : episode);
  const completed = episodes.every((episode) => episode.status === 'completed');
  const next = { ...plan, episodes, status: completed ? 'completed' : 'active', ...(completed ? { completedAt: new Date().toISOString() } : {}) };
  await store.saveArcPlan(workId, next);
  return { arcNumber: next.arcNumber, status: next.status, completedEpisode: chapter, nextEpisode: episodeForChapter(next, chapter + 1) };
}

export function renderArcEpisode(plan, episode, kitSource) {
  const t = asKit(kitSource).phrases.arc;
  const position = arcPositionFromRatio(episode.index, plan.estimatedEpisodes);
  return [
    t.heading(plan.arcNumber, plan.title),
    t.promise(plan.promise), t.progress(episode.index, plan.estimatedEpisodes, position),
    t.episodeTitle(episode.title), t.coreEvent(episode.beat ?? episode.goal),
    t.readerLoad(episode.readerLoad?.phase ?? 'expansion', episode.readerLoad?.newConcept),
    episode.pressure || episode.conflict ? t.pressure(episode.pressure ?? episode.conflict) : '',
    episode.turn ? t.turn(episode.turn) : '', episode.carry ? t.carry(episode.carry) : '',
    episode.growth ? t.growth(episode.growth) : '', episode.cost ? t.cost(episode.cost) : '',
    episode.hook ? t.hook(episode.hook) : '',
    t.beatConstraint,
  ].filter(Boolean).join('\n');
}

/** Complete causal map for the writer; current-beat-only context cannot seed later payoffs. */
export function renderArcMap(plan, currentChapter, kitSource) {
  if (!plan || plan.status !== 'active') return '';
  const t = asKit(kitSource).phrases.arc;
  return [
    t.mapHeading(plan.arcNumber, plan.title),
    t.promise(plan.promise),
    plan.commercialPromise?.fantasy ? t.repeatPleasure(plan.commercialPromise.fantasy, plan.commercialPromise.humanComplication) : '',
    plan.readerContract?.openingQuestion ? t.readerContract(plan.readerContract.openingQuestion, plan.readerContract.minimumPayoff) : '',
    plan.oppositionAgency?.actor ? t.opposition(plan.oppositionAgency.actor, plan.oppositionAgency.independentGoal, plan.oppositionAgency.adaptationTrigger) : '',
    plan.escalatingCosts?.length ? t.escalatingCosts(plan.escalatingCosts.join(' → ')) : '',
    ...plan.episodes.map((episode) => [
      t.mapEpisode(episode.chapter === currentChapter ? '▶' : ' ', episode.index, plan.estimatedEpisodes, episode.title),
      t.mapEvent(episode.beat ?? episode.goal ?? ''),
      episode.pressure || episode.conflict ? t.mapPressure(episode.pressure ?? episode.conflict) : '',
      episode.turn ? t.mapTurn(episode.turn) : '',
      episode.readerExpectation ? t.mapReaderExpectation(episode.readerExpectation) : '',
      episode.payoff ? t.mapPayoff(episode.payoff) : '',
      episode.costCreatedByResolution ? t.mapResolutionCost(episode.costCreatedByResolution) : '',
      episode.carry || episode.hook ? t.mapCarry(episode.carry ?? episode.hook) : '',
      episode.exitValue ? t.mapExitValue(episode.exitValue) : '',
    ].filter(Boolean).join(' / ')),
    ...(plan.characterArcs?.length ? [
      t.characterCurveHeading,
      ...plan.characterArcs.map((arc) => t.characterCurve(arc.characterId, arc.promise, arc.beats.map((b) => t.characterCurveBeat(b.episodeIndex, b.beat, b.note)).join(' → '))),
    ] : []),
    ...(plan.arcVoiceShifts?.length ? [
      t.voiceShiftHeading,
      ...plan.arcVoiceShifts.map((row) => t.voiceShift(row.characterId, row.startingVoice, row.pressureVoice, row.changedVoice, [row.sampleBefore, row.sampleAfter].filter(Boolean).join(' / '))),
    ] : []),
    t.mapFooter,
  ].filter(Boolean).join('\n');
}
