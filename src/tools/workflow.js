import { createHash, randomUUID } from 'node:crypto';

import { DefaultOutputSanitizer } from '../../engine/src/core/output-sanitizer.js';
import { runCoherenceJudge } from '../../engine/src/generators/text/steps/coherence-judge.js';
import { runChapterSummary } from '../../engine/src/generators/text/steps/chapter-summary.js';
import { runDraftTool, runReviseTool } from './generate.js';
import { runCheck } from './check.js';
import { runCommit } from './commit.js';
import { episodeForChapter, renderArcMap } from './arc.js';
import { renderEpisodePlan, runEpisodePlan } from './episode-plan.js';
import { applyNarrativeBoundary, runNarrativeBoundary } from './narrative-boundary.js';
import { editorialQualityAdvisories, runEditorialQuality } from './editorial-quality.js';
import { buildContext } from './context.js';
import { ensurePilotContract, ensureStoryIdentity, patternViolations, runPatternAnalysis, runReaderHook } from './story-experience.js';
import { assertProseIntegrity } from './prose-integrity.js';
import { chooseBestRevision, makeRevisionCandidate, publicRevisionCandidate } from './revision-selection.js';
import { createChapterSnapshot } from './snapshots.js';
import { characterFidelityAdvisories, characterFidelityViolations, runCharacterFidelity } from './character-fidelity.js';
import { arcReviewAdvisories, arcReviewViolations, runArcReview } from './arc-review.js';
import { assessContractLength, assessChapterLength, chapterDensityViolations } from './chapter-density.js';
import { autoCommitDecision, dedupeQualityViolations, qualityDecision } from '../core/quality-policy.js';
import { createPublicationUnit } from '../core/publication-unit.js';
import { detectWorkingTreeDrift } from '../core/working-tree-sync.js';
import { loadCurrentExperienceLedger, saveExperienceLedgerForHead } from '../core/experience-ledger.js';
import { findLatestRun } from '../runs.js';
import { normalizeWebnovelLayout } from './webnovel-format.js';
import { evaluateChapterStyle, evaluateRevisionPreservation } from '../core/style-continuity.js';
import { createReviewAudit, reviewFindingAdvisories, reviewTimeoutMs } from '../core/review-audit.js';
import { compileDraftContract } from '../core/narrative-contract.js';
import { assertCurrentChapterReceipt, currentValidationContext, sameIdentity, exceptionOnlyRebind, loadValidationSession, invalidateValidationSession } from '../core/validation-context.js';
import { buildApprovalBinding, validateApprovalBinding } from '../../engine/src/core/validation-contract.js';
import { promptKit } from '../prompts/index.js';
import { resolveWorkLanguage, executionFoundationSnapshot } from '../core/work-language.js';
import { getRuntimeIdentity } from '../core/runtime-identity.js';
import { normalizeModelProfile, withModelProfile } from '../core/model-profile.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const MAX_ATTEMPTS = 3;
const MIN_COHERENCE = 60;
const MIN_PROSODY = 55;
const MIN_EDITORIAL = 65;
const MIN_DRAMATIC_DIMENSION = 60;
const MIN_READER_HOOK = 65;
const sanitizer = new DefaultOutputSanitizer();

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
export const proseHash = (prose) => `sha256:${createHash('sha256').update(String(prose)).digest('hex')}`;

async function transition(store, workflow, stage, detail = {}) {
  const changed = workflow.stage !== stage || workflow.operation !== detail.operation;
  Object.assign(workflow, detail, { stage, updatedAt: now() });
  await store.saveWorkflow(workflow.workId, workflow);
  if (changed) {
    await store.appendWorkflowEvent(workflow.workId, workflow.workflowId, {
      at: workflow.updatedAt, event: stage, chapter: workflow.chapter,
      ...(detail.operation ? { operation: detail.operation } : {}),
      ...(detail.attempt ? { attempt: detail.attempt } : {}),
    });
  }
  return workflow;
}

function pending(providers) { return (providers.pending?.length ?? 0) > 0; }

/**
 * A resumed workflow replays every completed stage from the top, so a stage
 * event would be appended once per host round trip. Record it once per key.
 */
async function logOnce(store, workflow, key, event) {
  if ((workflow.loggedEventKeys ?? []).includes(key)) return;
  workflow.loggedEventKeys = [...(workflow.loggedEventKeys ?? []), key];
  await store.saveWorkflow(workflow.workId, workflow);
  await store.appendWorkflowEvent(workflow.workId, workflow.workflowId, event);
}

function parseInfluenceObservation(raw, foundation) {
  let parsed;
  try { parsed = JSON.parse(String(raw ?? '').replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
  const idByReference = new Map();
  for (const character of foundation.characters ?? []) {
    idByReference.set(character.id, character.id);
    idByReference.set(character.canonicalName, character.id);
    for (const alias of character.aliases ?? []) idByReference.set(alias, character.id);
  }
  const events = (Array.isArray(parsed?.influenceEvents) ? parsed.influenceEvents : []).flatMap((event) => {
    const characterId = idByReference.get(event?.characterId);
    const anchor = typeof event?.anchor === 'string' ? event.anchor.trim() : '';
    if (!characterId || !anchor) return [];
    const dimensionChanges = Object.fromEntries(Object.entries(event.dimensionChanges ?? {})
      .filter(([, value]) => typeof value === 'number' && Number.isFinite(value)));
    const relationshipClaims = (Array.isArray(event.relationshipClaims) ? event.relationshipClaims : []).flatMap((claim) => {
      const from = idByReference.get(claim?.from);
      const to = idByReference.get(claim?.to);
      return from && to ? [{ ...claim, from, to }] : [];
    });
    return [{
      characterId, anchor,
      interpretation: String(event.interpretation ?? '').trim(),
      dimensionChanges,
      nextChoiceBias: String(event.nextChoiceBias ?? '').trim(),
      behavioralProof: event.behavioralProof && typeof event.behavioralProof === 'object' ? event.behavioralProof : null,
      relationshipClaims,
    }];
  });
  const noInfluenceReason = typeof parsed?.noInfluenceReason === 'string' ? parsed.noInfluenceReason.trim() : '';
  return events.length || noInfluenceReason ? { influenceEvents: events, noInfluenceReason } : null;
}

export async function repairMissingInfluenceObservation({ providers, foundation, prose, chapter, episodePlan, delta }) {
  if ((delta.influenceEvents?.length ?? 0) > 0 || String(delta.noInfluenceReason ?? '').trim()) return delta;
  const schema = '{"influenceEvents":[{"characterId":"등장인물의 정확한 id","anchor":"본문의 관찰 가능한 근거","interpretation":"인물의 해석","dimensionChanges":{"작품별_dimension_id":-1},"nextChoiceBias":"다음 선택 편향","behavioralProof":{"hypothesis":"성격 가설","voluntary":true,"alternativesKnown":true,"alternativesAvailable":["대안"],"chosen":"실제 선택","costPaid":"비용","competingHypotheses":[]},"relationshipClaims":[{"from":"id","to":"id","dimensions":{"trust":1},"belief":"관계 인식"}]}],"noInfluenceReason":"변화가 정말 없을 때만 구체적 이유"}';
  const request = async (step, prior = '') => providers.complete({
    model: MODEL, jsonMode: true, step,
    messages: [
      { role: 'system', content: '검사 완료된 한국어 웹소설 원고에서 인물의 자발적 선택과 지불한 비용이 다음 선택 또는 관계 인식에 남긴 변화만 추출한다. 원고에 없는 사실은 만들지 않는다. 순수 JSON만 출력한다.' },
      { role: 'user', content: `회차: ${chapter}\n등장인물: ${JSON.stringify((foundation.characters ?? []).map(({ id, canonicalName }) => ({ id, canonicalName })))}\n계획된 인물 비트: ${JSON.stringify(episodePlan?.characterArcBeats ?? [])}\n\n본문:\n${prose}\n\n출력 스키마:\n${schema}${prior ? `\n\n이전 응답은 스키마를 충족하지 못했다. 같은 형식을 반복하지 말고 위 스키마만 채워라.\n이전 응답:\n${prior}` : ''}` },
    ],
  });
  const first = await request('influence-observation-repair');
  const firstParsed = parseInfluenceObservation(first.text, foundation);
  if (firstParsed) return { ...delta, ...firstParsed };
  if (pending(providers)) return delta;
  const second = await request('influence-observation-repair-retry', first.text);
  const secondParsed = parseInfluenceObservation(second.text, foundation);
  if (secondParsed) return { ...delta, ...secondParsed };
  if (pending(providers)) return delta;
  throw new Error('INFLUENCE_OBSERVATION_REQUIRED: 전용 복구 응답에도 유효한 influenceEvents 또는 noInfluenceReason이 없습니다.');
}

function manifestFrom(raw) {
  const block = sanitizer.extractBlock(raw, 'cast-manifest');
  const cleaned = sanitizer.sanitize(raw);
  if (cleaned.leaked) throw new Error('초고에 제거되지 않은 내부 sentinel이 남았습니다.');
  assertProseIntegrity(cleaned.clean);
  return { prose: cleaned.clean.trim(), castManifestRaw: block?.body ?? '{"cast":[]}' };
}

const DRAMATIC_DIMENSIONS = {
  powerShift: '장면 안의 힘의 관계가 바뀌지 않는다.',
  subtext: '대사와 행동이 욕망을 직접 설명해 서브텍스트가 약하다.',
  consequenceResidue: '충돌의 대가가 다음 장면에 남지 않는다.',
  surpriseIntegrity: '전환이 지나치게 예고되거나 근거 없이 발생한다.',
};

export function dramaticQualityViolations(editorial, chapter) {
  return Object.entries(DRAMATIC_DIMENSIONS).flatMap(([dimension, fallback]) => {
    const score = Number(editorial?.dimensions?.[dimension]);
    if (!Number.isFinite(score) || score >= MIN_DRAMATIC_DIMENSION) return [];
    const finding = editorial.findings?.find((item) => item.dimension === dimension);
    return [{ severity: 'soft', code: finding?.code ?? `DRAMATIC_${dimension.toUpperCase()}`, chapterNumber: chapter,
      message: finding?.message ?? `${fallback} (${score}점)` }];
  });
}

// A kept draft (clean_fail, or parked for guided approval / commit) must not
// become a dead end after its validation identity went stale. When only canon,
// plans or the contract changed (an arc/episode plan edit, STALE_WORK_CONTRACT,
// or a hand edit published through lore_sync), the prose is still the writer's
// answer to the same instruction: a superseding workflow inherits it and runs
// validation again under the live contract, with a new receipt and budget.
// A pending user revision request travels with the prose, and a draft that
// was waiting for the user's decision stays guided. Only a new instruction,
// or a kept draft that no longer exists, drafts anew. The old workflow stays
// on disk as clean_fail with its events for the audit.
const STALE_FAILURE_CODES = new Set(['STALE_WORK_CONTRACT', 'WORKING_TREE_DRIFT']);
const PARKED_STAGES = new Set(['clean_fail', 'awaiting_draft_approval', 'ready_to_commit']);
const REVISION_STAGES = new Set(['revision_requested', 'awaiting_model']);

function pendingUserRevision(workflow) {
  if (workflow.operation !== 'user_revision' || !String(workflow.revisionFeedback ?? '').trim() || !workflow.draftProse) return false;
  return REVISION_STAGES.has(workflow.stage) || (workflow.stage === 'clean_fail' && REVISION_STAGES.has(workflow.failure?.fromStage));
}

function awaitingUserDecision(workflow) {
  return workflow.stage === 'awaiting_draft_approval' || workflow.failure?.fromStage === 'awaiting_draft_approval' || pendingUserRevision(workflow);
}

async function keptDraftSupersession({ store, workId, workflow, chapter, instruction, retryValidation }) {
  if (!workflow || workflow.chapter !== chapter) return null;
  if (!PARKED_STAGES.has(workflow.stage) && !pendingUserRevision(workflow)) return null;
  const nextInstruction = String(instruction ?? '').trim();
  const newInstruction = !retryValidation && Boolean(nextInstruction) && nextInstruction !== String(workflow.instruction ?? '').trim();
  const session = await loadValidationSession(store, workId, `workflow-${workflow.workflowId}`);
  let live = null;
  if (session?.identity) {
    try { live = await currentValidationContext({ store, workId, chapter }); }
    catch { /* an unreadable live contract is reported by the normal path */ }
  }
  // An approved exception-only profile revision is rebound to the same epoch
  // by retryValidation itself; that path stays in the current workflow.
  if (retryValidation && live && exceptionOnlyRebind(session, live)) return null;
  let reason = workflow.stage === 'clean_fail' && STALE_FAILURE_CODES.has(workflow.failure?.code) ? workflow.failure.code : null;
  if (!reason && live && !sameIdentity(session.identity, live.identity)) reason = 'STALE_WORK_CONTRACT';
  if (newInstruction && (workflow.stage === 'clean_fail' || reason)) return { mode: 'redraft', reason: 'new_instruction' };
  if (!reason) return null;
  if (!workflow.draftProse) return { mode: 'redraft', reason };
  return { mode: pendingUserRevision(workflow) ? 'revise' : 'revalidate', reason };
}

async function supersede(store, workId, current, supersession, successorId) {
  const scope = `workflow-${current.workflowId}`;
  const validation = await loadValidationSession(store, workId, scope);
  if (validation && !validation.stale) await invalidateValidationSession(store, workId, scope, validation, supersession.reason === 'new_instruction' ? 'SUPERSEDED' : supersession.reason);
  if (current.stage !== 'clean_fail') {
    await transition(store, current, 'clean_fail', { failure: { code: supersession.reason === 'new_instruction' ? 'SUPERSEDED' : supersession.reason } });
  }
  current.supersededBy = successorId;
  await store.saveWorkflow(workId, current);
  await store.appendWorkflowEvent(workId, current.workflowId, {
    at: now(), event: 'workflow_superseded', chapter: current.chapter, by: successorId,
    reason: supersession.reason, mode: supersession.mode,
  });
}

async function ensureWorkflow(store, workId, chapter, autonomy, instruction, modelProfile = null, supersession = null) {
  const current = await store.loadWorkflow(workId);
  if (current && current.chapter === chapter && !['completed', 'rejected'].includes(current.stage) && !supersession) {
    if (modelProfile && JSON.stringify(current.modelProfile ?? null) !== JSON.stringify(modelProfile)) {
      current.modelProfile = modelProfile;
      await store.saveWorkflow(workId, current);
      await store.appendWorkflowEvent(workId, current.workflowId, { at: now(), event: 'model_profile_updated', chapter, modelProfile });
    }
    return current;
  }
  const revalidate = ['revalidate', 'revise'].includes(supersession?.mode);
  const revise = supersession?.mode === 'revise';
  const inheritedDraft = revalidate ? { workflowId: current.workflowId, proseHash: proseHash(current.draftProse) } : null;
  const profile = modelProfile ?? (supersession ? current.modelProfile ?? null : null);
  // A draft that was waiting for the user's decision is never auto-committed
  // because a later call asked for auto: the fresh receipt goes to lore_decide.
  // The lock is inherited: a locked successor superseded again (a second plan
  // edit mid-check, a later clean_fail, a revise successor after its revision
  // was applied) still owes the user a decision. It is released only by
  // lore_decide, a redraft on a new instruction, or a later chapter.
  const lockGuided = revalidate && (current.autonomyLock === 'guided' || awaitingUserDecision(current));
  const effectiveAutonomy = lockGuided ? 'guided' : autonomy;
  const workflow = {
    workflowId: id('wf'), workId, chapter, stage: revise ? 'revision_requested' : 'started', operation: revise ? 'user_revision' : null,
    autonomy: effectiveAutonomy, instruction: revalidate ? String(current.instruction ?? '') : String(instruction ?? ''), attempt: 0,
    auditLevel: 'standard', createdAt: now(), updatedAt: now(),
    ...(profile ? { modelProfile: profile } : {}),
    ...(supersession ? { supersedes: current.workflowId } : {}),
    ...(revalidate ? { inheritedDraft, draftProse: current.draftProse, castManifestRaw: current.castManifestRaw } : {}),
    ...(revise ? { revisionFeedback: current.revisionFeedback } : {}),
    ...(lockGuided ? { autonomyLock: 'guided' } : {}),
  };
  // The superseded workflow is saved first: saveWorkflow also moves `current`.
  if (supersession) await supersede(store, workId, current, supersession, workflow.workflowId);
  await store.saveWorkflow(workId, workflow);
  await store.appendWorkflowEvent(workId, workflow.workflowId, {
    at: workflow.createdAt, event: 'workflow_started', chapter, autonomy: effectiveAutonomy, ...(profile ? { modelProfile: profile } : {}),
    ...(supersession ? { supersedes: current.workflowId, reason: supersession.reason, mode: supersession.mode } : {}),
    ...(inheritedDraft ? { inheritedDraft } : {}),
    ...(revise ? { revisionFeedback: workflow.revisionFeedback } : {}),
    ...(effectiveAutonomy !== autonomy ? { requestedAutonomy: autonomy } : {}),
  });
  return workflow;
}

function prerequisites({ foundation, profile, storySpine, writerSkill, arcPlan, arcEpisode }) {
  if (!foundation) return { code: 'FOUNDATION_MISSING', nextAction: 'lore_create 또는 lore_init으로 작품을 먼저 만드세요.' };
  if (!profile || profile.status !== 'active') return { code: 'PROFILE_NOT_ACTIVE', nextAction: 'lore_profile로 StoryProfile을 만들고 승인하세요.' };
  if (!storySpine || storySpine.status !== 'active') return { code: 'STORY_SPINE_NOT_ACTIVE', nextAction: 'lore_story_plan으로 StorySpine을 만들고 승인하세요.' };
  if (!writerSkill || writerSkill.status !== 'active') return { code: 'WRITER_SKILL_NOT_ACTIVE', nextAction: 'lore_writer_skill로 작품별 WriterSkill을 만들고 승인하세요.' };
  if (!arcPlan || arcPlan.status !== 'active' || !arcEpisode) return { code: 'ARC_NOT_ACTIVE', nextAction: 'lore_arc_plan으로 현재 아크를 만들고 승인하세요.' };
  return null;
}

/**
 * Deep chapter-writing module. Callers supply intent and autonomy; ordering,
 * retries, receipts and commit safety stay inside this implementation.
 */
export async function runWriteWorkflow({ store, workId, instruction = '', autonomy = 'guided', providers: baseProviders, modelProfile: requestedProfile = null, language, retryValidation: requestedRetry = false }) {
  let retryValidation = requestedRetry;
  const requestedModelProfile = normalizeModelProfile(requestedProfile);
  let providers = baseProviders;
  const publication = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
  if (!publication.ok) throw new Error(`CORRUPT_PUBLICATION: ${publication.error.code}`);
  if (publication.value) {
    const drift = await detectWorkingTreeDrift({ store, sourceHead: publication.value.head });
    if (drift.status !== 'clean') {
      const existing = await store.loadWorkflow(workId);
      if (existing && !['completed', 'rejected', 'clean_fail'].includes(existing.stage)) {
        const scope = `workflow-${existing.workflowId}`;
        const validation = await loadValidationSession(store, workId, scope);
        if (validation) await invalidateValidationSession(store, workId, scope, validation, 'WORKING_TREE_DRIFT');
        await transition(store, existing, 'clean_fail', { failure: { code: 'WORKING_TREE_DRIFT', fromStage: existing.stage } });
      }
      return {
        status: 'needs_sync', code: 'WORKING_TREE_DRIFT', changed: drift.changed,
        sourceHead: publication.value.head, nextAction: '손수정 내용을 검사·발행한 뒤 집필을 재개하세요.',
      };
    }
  }
  const chapters = await store.listChapters();
  const chapter = (chapters.at(-1) ?? 0) + 1;
  let foundation = await store.loadFoundation(workId);
  const profile = await store.loadStoryProfile(workId);
  const storySpine = await store.loadStorySpine(workId);
  const writerSkill = await store.loadWriterSkill(workId);
  const styleAnchor = await store.loadStyleAnchor?.(workId);
  const arcPlan = await store.loadArcPlan(workId);
  const arcEpisode = episodeForChapter(arcPlan, chapter);
  let episodePlan = await store.loadEpisodePlan(workId, chapter);
  const blocked = prerequisites({ foundation, profile, storySpine, writerSkill, arcPlan, arcEpisode });
  if (blocked) return { status: 'needs_setup', chapter, ...blocked };

  const supersession = await keptDraftSupersession({ store, workId, workflow: await store.loadWorkflow(workId), chapter, instruction, retryValidation });
  const workflow = await ensureWorkflow(store, workId, chapter, autonomy, instruction, requestedModelProfile, supersession);
  // A superseding workflow already starts a fresh validation scope and epoch.
  if (supersession) retryValidation = false;
  providers = withModelProfile(baseProviders, workflow.modelProfile ?? null);
  const resolution = await resolveWorkLanguage({ store, workId, requested: language });
  const workContract = resolution.contract;
  const kit = promptKit({ contract: workContract });
  foundation = executionFoundationSnapshot(foundation, workContract);
  if (workflow.stage === 'clean_fail' && !retryValidation) return { status: 'clean_fail', workflowId: workflow.workflowId, chapter, prose: workflow.draftProse, failure: workflow.failure, nextAction: 'retryValidation=true re-validates this preserved draft in a new epoch; lore_write with a new instruction drafts the chapter anew. After a plan, contract or lore_sync change, lore_write re-validates this draft under the current contract.' };
  if (retryValidation) {
    // A retry of a failed draft is a new user round with the full quality
    // revise budget. Only a retry that starts from clean_fail resets it: a
    // relayed host resumes with the same retryValidation argument after every
    // round trip, and those resumes must not refill the budget.
    if (workflow.stage === 'clean_fail') delete workflow.qualityRevisions;
    delete workflow.userApproval;
    delete workflow.approvalId;
    delete workflow.checkId;
    await transition(store, workflow, 'validating', { operation: 'retry_validation' });
  }
  if (workflow.checkId) {
    const checked = await store.loadCheckReceipt(workId, workflow.checkId);
    await assertCurrentChapterReceipt({ store, workId, chapter, receipt: checked, artifact: checked?.artifact });
  }
  const priorValidation = await loadValidationSession(store, workId, `workflow-${workflow.workflowId}`);
  if (priorValidation) {
    const live = await currentValidationContext({ store, workId, chapter });
    if (!sameIdentity(priorValidation.identity, live.identity) && !(retryValidation && exceptionOnlyRebind(priorValidation, live))) {
      await invalidateValidationSession(store, workId, `workflow-${workflow.workflowId}`, priorValidation);
      await transition(store, workflow, 'clean_fail', { failure: { code: 'STALE_WORK_CONTRACT', fromStage: workflow.stage } });
      return { status: 'clean_fail', code: 'STALE_WORK_CONTRACT', workflowId: workflow.workflowId, prose: workflow.draftProse,
        nextAction: 'The preserved draft was checked under older plans or contract. Call lore_write again (with or without retryValidation) to re-validate the same prose under the current contract, or with a new instruction to draft the chapter anew.' };
    }
  }
  const runtime = await getRuntimeIdentity();
  if (workflow.runtime?.sourceTreeHash !== runtime.sourceTreeHash) {
    workflow.runtime = runtime;
    await store.saveWorkflow(workId, workflow);
    await store.appendWorkflowEvent(workId, workflow.workflowId, { at: now(), event: 'runtime_identified', chapter, runtime });
  }
  if (workflow.stage === 'awaiting_draft_approval') {
    return {
      status: 'awaiting_approval', stage: workflow.stage, workflowId: workflow.workflowId,
      approvalId: workflow.approvalId, chapter, prose: workflow.draftProse,
      quality: workflow.quality, nextAction: 'lore_decide로 승인하거나 피드백과 함께 거절하세요.',
      ...(workflow.degraded ? { degraded: workflow.degraded } : {}),
    };
  }

  if (workflow.stage === 'on_hold') {
    return {
      status: 'on_hold', workflowId: workflow.workflowId, chapter,
      nextAction: 'lore_decide로 승인, 수정 요청 또는 거절하세요.',
    };
  }

  // A prior auto-commit can fail after every model and quality stage has
  // completed. Reuse its receipt and prose instead of drafting the chapter a
  // second time when the caller retries lore_write.
  if (workflow.stage === 'ready_to_commit') {
    return commitPassedWorkflow({ store, workflow, providers });
  }

  const identity = await ensureStoryIdentity({ store, workId, profile, foundation, providers });
  if (pending(providers)) {
    await transition(store, workflow, 'awaiting_model', { operation: 'story_identity' });
    return { preview: true, workflowId: workflow.workflowId, chapter, operation: 'story_identity' };
  }
  const pilotContract = chapter === 1
    ? await ensurePilotContract({ store, workId, identity, foundation, arcPlan, providers })
    : null;
  if (pending(providers)) {
    await transition(store, workflow, 'awaiting_model', { operation: 'pilot_contract' });
    return { preview: true, workflowId: workflow.workflowId, chapter, operation: 'pilot_contract' };
  }

  // Per-chapter planning is an internal stage, not a caller checklist item.
  if (!episodePlan || episodePlan.status !== 'active') {
    const planned = await runEpisodePlan({ store, workId, chapter, mode: 'auto', direction: instruction, providers });
    if (pending(providers)) {
      await transition(store, workflow, 'awaiting_model', { operation: 'chapter_plan' });
      return { preview: true, workflowId: workflow.workflowId, chapter, operation: 'chapter_plan' };
    }
    if (!planned.plan) {
      // The plan gate refused activation. Drafting on would only fail later with a
      // misleading "no approved EpisodePlan"; hand the gate result back so the host
      // can regenerate the plan from its evidence (2026-09-15 en sample).
      return { status: planned.status ?? 'clean_fail', code: planned.code ?? 'EPISODE_PLAN_NOT_ACTIVE', workflowId: workflow.workflowId, chapter,
        operation: 'chapter_plan', details: planned.details ?? planned.validation?.failureDetails ?? null, candidate: planned.candidate ?? null };
    }
    episodePlan = planned.plan;
  }

  const userRevision = ['revision_requested', 'awaiting_model'].includes(workflow.stage)
    && workflow.operation === 'user_revision' && workflow.draftProse;
  let raw;
  if (userRevision) {
    // The draft's manifest travels with the prose: without it the copy-editor
    // sees an empty cast and invents its own entry shape (2026-09-15 en sample).
    const revised = await runReviseTool({
      store, workId, chapter, prose: workflow.draftProse, castManifestRaw: workflow.castManifestRaw,
      violations: [{ severity: 'advisory', code: 'USER_REVISION_REQUEST', chapterNumber: chapter, message: workflow.revisionFeedback }],
      providers,
    });
    raw = revised.prose;
    if (pending(providers)) {
      await transition(store, workflow, 'awaiting_model', { operation: 'user_revision', attempt: 1 });
      return { preview: true, workflowId: workflow.workflowId, chapter, operation: 'user_revision' };
    }
  } else if (workflow.draftProse) {
    raw = workflow.draftProse;
  } else {
    const drafted = await runDraftTool({
      store, workId, chapter, plan: workflow.instruction,
      targetChars: profile.format?.chapterChars, providers, workflowId: workflow.workflowId,
    });
    raw = drafted.prose;
    if (pending(providers)) {
      const operation = drafted.operation ?? 'draft';
      await transition(store, workflow, 'awaiting_model', { operation, attempt: 1 });
      return { preview: true, workflowId: workflow.workflowId, chapter, operation };
    }
    if (!workflow.contextAudit) {
      workflow.contextAudit = drafted.contextAudit;
      await store.saveWorkflow(workId, workflow);
      await store.appendWorkflowEvent(workId, workflow.workflowId, {
        at: now(), event: 'draft_context_supplied', chapter, ...drafted.contextAudit,
      });
    }
  }

  let current = manifestFrom(raw);
  if (workflow.draftProse === raw) current.castManifestRaw = workflow.castManifestRaw ?? current.castManifestRaw;
  workflow.draftProse = current.prose; workflow.castManifestRaw = current.castManifestRaw;
  await store.saveWorkflow(workId, workflow);
  let check;
  let coherence;
  let editorial;
  let characterFidelity;
  let readerHook;
  let patternEntry;
  let arcReview;
  let lengthAssessment;
  let surfacedAdvisories = [];
  let reviewAudit;
  let styleReport = null;
  let revisionPreservation = workflow.revisionPreservation ?? null;
  const revisionCandidates = await store.loadRevisionCandidates(workId, workflow.workflowId) ?? [];
  const requireInfluenceObservation = storySpine?.status === 'active' && (foundation.characters?.length ?? 0) >= 2;
  const judgeBoundary = (prose, relay = providers) => runNarrativeBoundary({
    arcPlan, episodePlan, chapter, prose, providers: relay, kit, workContract, language: workContract.language,
  });
  // The repair of a judged failure: the revise answer replaces the draft. The
  // failed judgment already spent its attempt, so a resume must not judge the
  // unchanged draft again (2026-09-25 ar, zh-Hant and th samples: that
  // re-judgment spent an attempt, and when it passed the revision was thrown
  // away and the unrevised draft was committed).
  async function applyMandatoryRepair() {
    const { violations } = workflow.pendingRepair;
    const revised = await runReviseTool({ store, workId, chapter, prose: current.prose, castManifestRaw: current.castManifestRaw, violations, providers });
    if (pending(providers)) {
      await transition(store, workflow, 'awaiting_model', { operation: 'mandatory_repair' });
      return false;
    }
    const sourceProse = current.prose;
    current = manifestFrom(revised.prose);
    revisionPreservation = evaluateRevisionPreservation({ sourceProse, candidateProse: current.prose, violations });
    workflow.revisionPreservation = revisionPreservation;
    workflow.draftProse = current.prose; workflow.castManifestRaw = current.castManifestRaw;
    delete workflow.pendingRepair;
    await store.saveWorkflow(workId, workflow);
    return true;
  }
  if (workflow.pendingRepair) {
    const session = await loadValidationSession(store, workId, `workflow-${workflow.workflowId}`);
    const resumable = workflow.operation === 'mandatory_repair' && !retryValidation
      && workflow.pendingRepair.proseHash === proseHash(current.prose)
      && session?.status === 'validation_incomplete' && session.epoch === workflow.pendingRepair.validationEpoch;
    if (!resumable) { delete workflow.pendingRepair; await store.saveWorkflow(workId, workflow); }
    else {
      providers.shareContext?.({ id: 'chapter-prose', label: kit.phrases.common.chapterProseLabel(chapter), text: current.prose });
      if (!await applyMandatoryRepair()) return { preview: true, workflowId: workflow.workflowId, chapter };
    }
  }
  let attempt = 1;
  for (; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const normalizedProse = normalizeWebnovelLayout(
      current.prose,
      workContract.formatPolicy.dialogueBreakMode,
    );
    if (normalizedProse !== current.prose) {
      current = { ...current, prose: normalizedProse };
      await logOnce(store, workflow, `layout:${attempt}`, {
        at: now(), event: 'webnovel_layout_normalized', chapter, attempt,
        transform: 'normalize_dialogue_boundaries',
      });
    }
    // Extraction, profile check and reviews all carry this prose verbatim; the
    // relay presents it as one shared prompt prefix for the whole batch.
    providers.shareContext?.({ id: 'chapter-prose', label: kit.phrases.common.chapterProseLabel(chapter), text: current.prose });
    const checkedProse = current.prose;
    check = await runCheck({
      store, workId, chapter, prose: current.prose,
      castManifestRaw: current.castManifestRaw, providers,
      dialogueBreakMode: workContract.formatPolicy.dialogueBreakMode,
      includeSemanticContinuity: true,
      includeProfileCheck: true,
      requireInfluenceObservation, forceContract: true, issueReceipt: true, workflowId: workflow.workflowId, retryValidation: retryValidation && attempt === 1,
      // The boundary judge reads the same checked prose as the title and
      // summary, so it rides in their round trip instead of a pass of its own.
      metadataCompanion: (relay) => judgeBoundary(checkedProse, relay),
    });

    // While the mandatory check is still collecting host answers, the reviews
    // below are queued in the same round trip. Their results are only used
    // once the check has completed; a failed check discards them.
    const checkPending = pending(providers) || check.preview === true;
    if (!checkPending && !check.validationComplete) {
      workflow.draftProse = current.prose; workflow.castManifestRaw = current.castManifestRaw;
      if (check.status === 'clean_fail') {
        await transition(store, workflow, 'clean_fail', { operation: 'mandatory_validation', failure: check });
        return { ...check, workflowId: workflow.workflowId, chapter, prose: current.prose };
      }
      if (check.status === 'provider_error') {
        // The model transport failed; nothing was judged and no budget was spent.
        // Keep the draft and the validation session so the next lore_write resumes them.
        await store.saveWorkflow(workId, workflow);
        await transition(store, workflow, 'validating', { operation: 'mandatory_validation', failure: { code: check.code, providerError: check.providerError } });
        return { ...check, workflowId: workflow.workflowId, chapter, prose: current.prose,
          nextAction: 'The model provider failed during validation. Run lore_write again to resume this draft; the validation budget was not spent.' };
      }
      if (!revisionCandidates.some(candidate => candidate.prose === current.prose && candidate.validationEpoch === check.validationEpoch)) {
        revisionCandidates.push({ ...makeRevisionCandidate({ attempt, prose: current.prose, castManifestRaw: current.castManifestRaw, check,
          lengthFailed: check.lengthAssessment?.actual < check.lengthAssessment?.min, mustRevise: true }), validationEpoch: check.validationEpoch });
        await store.saveRevisionCandidates(workId, workflow.workflowId, revisionCandidates);
      }
      const repairable = (check.violations ?? []).filter(v => v.severity === 'hard');
      if (repairable.length) {
        workflow.pendingRepair = { proseHash: proseHash(current.prose), validationEpoch: check.validationEpoch, violations: repairable };
        if (!await applyMandatoryRepair()) return { preview: true, workflowId: workflow.workflowId, chapter };
      }
      // One persistent validation budget covers every actual failed judge response.
      // Pending host requests never consume it; the same prepared draft is resumed.
      if (attempt < MAX_ATTEMPTS) continue;
      await transition(store, workflow, 'validating', { operation: 'mandatory_validation', failure: check });
      return { ...check, workflowId: workflow.workflowId, chapter, prose: current.prose };
    }

    const experienceLedger = await loadCurrentExperienceLedger({ store, workId });
    const patternLedger = experienceLedger.entries;
    const contract = compileDraftContract({ profile, identity, writerSkill, episodePlan, chapter, kit,
      characterNames: Object.fromEntries((foundation?.characters ?? []).map((character) => [character.id, character.canonicalName])) });
    const reviews = createReviewAudit({ providers, prose: current.prose, chapter, contractDigest: contract.trace.digest, timeoutMs: reviewTimeoutMs(),
      saveExchange: (exchange) => store.saveModelExchange(workId, exchange) });
    coherence = await reviews.run('coherence-judge', (reviewProvider) => runCoherenceJudge({
      prose: current.prose, chapterNumber: chapter,
      plan: renderEpisodePlan(episodePlan, kit), writerModel: MODEL, providers: reviewProvider, kit, workContract, language: workContract.language, foundation,
    }), { score: null, reason: null });

    const { context: characterContext } = await buildContext({ store, workId, chapter });
    const priorSummaries = await store.loadRecentChapterSummaries(workId, chapter, 2);
    const editorialContext = priorSummaries.map((item) => item.summary).join('\n');
    editorial = await reviews.run('editorial-quality', (reviewProvider) => runEditorialQuality({ prose: current.prose, context: editorialContext, providers: reviewProvider, kit, workContract, language: workContract.language }), { score: null, dimensions: {}, findings: [] });

    characterFidelity = await reviews.run('character-fidelity', (reviewProvider) => runCharacterFidelity({ prose: current.prose, chapter, foundation, context: characterContext, providers: reviewProvider, kit, workContract, language: workContract.language }), { score: null, dimensions: {}, findings: [], flexibilityScore: null });

    readerHook = await reviews.run('reader-hook', (reviewProvider) => runReaderHook({ chapter, prose: current.prose, identity, pilotContract, episodePlan, contract: contract.writerText, recentHookTypes: patternLedger.slice(-2).map((entry) => entry.hookType).filter(Boolean), providers: reviewProvider, kit, workContract, language: workContract.language }), { score: null, dimensions: {}, findings: [] });
    patternEntry = await reviews.run('pattern-ledger', (reviewProvider) => runPatternAnalysis({ chapter, prose: current.prose, providers: reviewProvider, kit, workContract, language: workContract.language }), { chapter, solutionPattern: '', supportingAgency: {} });
    // Independent reviews above are collected into one host round trip. The
    // semantic continuity check (needs the extracted delta) and the arc review
    // (needs the pattern entry) wait for the answers they depend on.
    arcReview = pending(providers) ? null : await reviews.run('arc-review', (reviewProvider) => runArcReview({ store, workId, arcPlan, chapter, prose: current.prose, patternEntry, providers: reviewProvider, kit, workContract, language: workContract.language }), null);
    if (pending(providers)) {
      await transition(store, workflow, 'awaiting_model', {
        operation: 'check_and_reviews', attempt, requestedSteps: providers.pending.map((request) => request.step),
      });
      return { preview: true, workflowId: workflow.workflowId, chapter };
    }

    reviewAudit = reviews.result();
    const reviewKey = proseHash(JSON.stringify(reviewAudit));
    if (!(workflow.reviewAuditKeys ?? []).includes(reviewKey)) {
      await store.appendWorkflowEvent(workId, workflow.workflowId, { at: now(), event: 'reviews_completed', chapter, attempt, review: reviewAudit });
      workflow.reviewAuditKeys = [...(workflow.reviewAuditKeys ?? []), reviewKey];
      await store.saveWorkflow(workId, workflow);
    }

    styleReport = evaluateChapterStyle({ prose: current.prose, anchor: styleAnchor, chapterNumber: chapter });
    let violations = [
      ...(check.violations ?? []),
      ...styleReport.advisories,
      ...(revisionPreservation?.violations ?? []),
      ...reviewFindingAdvisories(reviewAudit, chapter),
    ];
    if (coherence.score !== null && coherence.score < MIN_COHERENCE) {
      violations.push({ severity: 'soft', code: 'QUALITY_GATE_COHERENCE', chapterNumber: chapter, message: coherence.reason ?? `논리 점수 ${coherence.score}` });
    }
    if (editorial.score !== null && editorial.score < MIN_EDITORIAL) {
      const findings = editorial.findings.length ? editorial.findings : [{ code: 'QUALITY_GATE_EDITORIAL', message: `편집 품질 점수 ${editorial.score}` }];
      violations.push(...findings.map((finding) => ({ ...finding, severity: 'soft', advisoryOnly: true, chapterNumber: chapter })));
    }
    const dramaticViolations = dramaticQualityViolations(editorial, chapter);
    violations.push(...dramaticViolations);
    const fidelityViolations = characterFidelityViolations(characterFidelity, chapter);
    violations.push(...fidelityViolations);
    const independentAdvisories = [
      ...editorialQualityAdvisories(editorial, chapter),
      ...characterFidelityAdvisories(characterFidelity, chapter),
      ...arcReviewAdvisories(arcReview, chapter),
    ];
    violations.push(...independentAdvisories);
    if (readerHook.score !== null && readerHook.score < MIN_READER_HOOK) {
      violations.push(...(readerHook.findings.length ? readerHook.findings : [{ code: 'QUALITY_GATE_READER_HOOK', message: `독자 견인 점수 ${readerHook.score}` }]).map((finding) => ({ ...finding, severity: 'soft', advisoryOnly: true, chapterNumber: chapter })));
    }
    const experienceViolations = patternViolations(patternLedger, patternEntry).map((violation) => ({ ...violation, chapterNumber: chapter }));
    const checkpointViolations = arcReviewViolations(arcReview, chapter);
    violations.push(...experienceViolations, ...checkpointViolations);
    const lengthFailed = check.lengthAssessment.actual < check.lengthAssessment.min;
    lengthAssessment = assessContractLength({ measurement: check.lengthAssessment, editorial });
    violations.push(...chapterDensityViolations(lengthAssessment, chapter));
    violations = dedupeQualityViolations(violations);
    const policy = qualityDecision({ violations });
    surfacedAdvisories = policy.advisory;
    const shouldRevise = policy.shouldRevise;
    await logOnce(store, workflow, `policy:${attempt}:${proseHash(current.prose)}`, {
      at: now(), event: 'quality_policy_evaluated', chapter, attempt,
      blocking: [...new Set(policy.blocking.map((item) => item.code))],
      advisory: [...new Set(policy.advisory.map((item) => item.code))],
    });
    const candidate = makeRevisionCandidate({
      attempt, prose: current.prose, castManifestRaw: current.castManifestRaw,
      check, coherence, editorial, characterFidelity, readerHook, lengthFailed,
      mustRevise: policy.blocking.length > 0, experienceFailed: false,
      preservation: revisionPreservation,
    });
    revisionCandidates.push(candidate);
    await store.saveRevisionCandidates(workId, workflow.workflowId, revisionCandidates);
    if (revisionPreservation?.passed === false) {
      const best = chooseBestRevision(revisionCandidates);
      await transition(store, workflow, 'clean_fail', {
        operation: 'revision_preservation', attempt,
        failure: {
          code: 'REVISION_PRESERVATION_FAILED',
          violations: revisionPreservation.violations,
          preservation: revisionPreservation.metrics,
          bestCandidate: publicRevisionCandidate(best),
        },
      });
      return {
        status: 'clean_fail', code: 'REVISION_PRESERVATION_FAILED',
        workflowId: workflow.workflowId, chapter, attempts: attempt,
        violations: revisionPreservation.violations,
        preservation: revisionPreservation.metrics,
        bestCandidate: publicRevisionCandidate(best),
      };
    }
    if (!shouldRevise) break;
    // `attempt` restarts at 1 on every resume, and a relayed host resumes after
    // each round trip with the latest revision as the draft. The applied
    // quality revisions are counted on the workflow so the cap holds across
    // resumes (otherwise a gate that keeps blocking revises without limit).
    const qualityAttempt = Math.max(attempt, (workflow.qualityRevisions ?? 0) + 1);
    if (qualityAttempt >= MAX_ATTEMPTS) {
      const best = chooseBestRevision(revisionCandidates);
      await transition(store, workflow, 'clean_fail', { operation: 'quality_gate', attempt: qualityAttempt, failure: { violations, coherence, editorial, bestCandidate: publicRevisionCandidate(best) } });
      return { status: 'clean_fail', workflowId: workflow.workflowId, chapter, attempts: qualityAttempt, violations, coherence, editorial, characterFidelity, bestCandidate: publicRevisionCandidate(best) };
    }
    const best = chooseBestRevision(revisionCandidates);
    const revisionBase = best ?? candidate;
    if (revisionBase !== candidate) await store.appendWorkflowEvent(workId, workflow.workflowId, { at: now(), event: 'revision_candidate_restored', chapter, rejectedAttempt: candidate.attempt, restoredAttempt: revisionBase.attempt, scoreDelta: revisionBase.score - candidate.score });
    const revisionViolations = policy.blocking;
    const revised = await runReviseTool({
      store, workId, chapter, prose: revisionBase.prose,
      castManifestRaw: revisionBase.castManifestRaw,
      violations: revisionViolations,
      providers,
    });
    if (pending(providers)) {
      await transition(store, workflow, 'awaiting_model', { operation: 'revise', attempt });
      return { preview: true, workflowId: workflow.workflowId, chapter };
    }
    current = manifestFrom(revised.prose);
    workflow.draftProse = current.prose; workflow.castManifestRaw = current.castManifestRaw;
    // Saved with the new draft: a resume replays from this draft, so the
    // cached revise answer that produced it is never counted twice.
    workflow.qualityRevisions = (workflow.qualityRevisions ?? 0) + 1;
    await store.saveWorkflow(workId, workflow);
    revisionPreservation = evaluateRevisionPreservation({
      sourceProse: revisionBase.prose,
      candidateProse: current.prose,
      violations: revisionViolations,
    });
  }

  // The check already queued this request beside the title and summary of the
  // same final prose, so on the normal path it is answered here without a
  // round trip of its own.
  providers.shareContext?.({ id: 'chapter-prose', label: kit.phrases.common.chapterProseLabel(chapter), text: current.prose });
  const boundary = await judgeBoundary(current.prose);
  if (pending(providers)) {
    await transition(store, workflow, 'awaiting_model', { operation: 'narrative_boundary', attempt });
    return { preview: true, workflowId: workflow.workflowId, chapter };
  }

  const checkedReceipt = await store.loadCheckReceipt(workId, check.checkId);
  await assertCurrentChapterReceipt({ store, workId, chapter, receipt: checkedReceipt, artifact: checkedReceipt.artifact });
  const receipt = {
    ...checkedReceipt,
    hardViolations: check.counts.hard, prosody: check.prosody.score,
    coherence: coherence.score, editorial: editorial.score, readerHook: readerHook.score, chars: current.prose.length,
    characterFidelity: characterFidelity.score, characterFlexibility: characterFidelity.flexibilityScore,
    qualityPolicy: { styleAnchorRevision: styleAnchor?.revision ?? null },
    review: reviewAudit,
    lengthAssessment, arcReview, advisories: surfacedAdvisories,
    styleContinuity: {
      anchorRevision: styleAnchor?.revision ?? null,
      sourceChapters: styleAnchor?.sourceChapters ?? [],
      drifted: styleReport?.drifted ?? false,
      fingerprint: styleReport?.fingerprint ?? null,
    },
    revisionSelection: { candidates: revisionCandidates.map(publicRevisionCandidate), selected: publicRevisionCandidate(chooseBestRevision(revisionCandidates)) }, checkedAt: now(), consumedAt: null,
  };
  await store.saveCheckReceipt(workId, receipt);
  await store.appendWorkflowEvent(workId, workflow.workflowId, {
    at: receipt.checkedAt, event: 'quality_passed', chapter, attempt,
    checkId: receipt.checkId, proseHash: receipt.proseHash,
    hard: receipt.hardViolations, prosody: receipt.prosody, coherence: receipt.coherence, editorial: receipt.editorial, chars: receipt.chars,
  });

  Object.assign(workflow, {
    attempt, draftProse: current.prose, castManifestRaw: current.castManifestRaw,
    checkId: receipt.checkId, summary: receipt.artifact.summary, title: receipt.artifact.title,
    boundary,
    patternEntry, arcReview, quality: { prosody: receipt.prosody, coherence: receipt.coherence, editorial: receipt.editorial, characterFidelity: receipt.characterFidelity, characterFlexibility: receipt.characterFlexibility, readerHook: readerHook.score, chars: receipt.chars, lengthBand: lengthAssessment.band, arcReview: arcReview?.score ?? null, advisories: surfacedAdvisories, styleContinuity: receipt.styleContinuity, hard: 0, attempts: attempt },
  });
  workflow.quality.review = reviewAudit;
  delete workflow.degraded;

  const styleReviewRequired = styleReport?.drifted === true;
  const autoCommit = autoCommitDecision({
    // A superseded draft that was waiting for the user stays guided on every
    // later call, whatever autonomy that call asks for.
    autonomy: workflow.autonomyLock ?? autonomy,
    styleDrift: styleReviewRequired,
    reviewStatus: reviewAudit.status,
  });
  if (!autoCommit.allowed) {
    if ((workflow.autonomyLock ?? autonomy) === 'auto') workflow.degraded = { code: autoCommit.code, autoCommitSuppressed: true };
    workflow.approvalId = id('approval');
    await transition(store, workflow, 'awaiting_draft_approval', { operation: null, attempt });
    return {
      status: 'awaiting_approval', stage: workflow.stage, workflowId: workflow.workflowId,
      approvalId: workflow.approvalId, chapter, prose: current.prose, quality: workflow.quality,
      ...(workflow.degraded ? { degraded: workflow.degraded } : {}),
      nextAction: 'lore_decide로 승인하거나 피드백과 함께 수정 요청·보류·거절하세요.',
    };
  }
  await transition(store, workflow, 'ready_to_commit', { operation: null, attempt });
  return commitPassedWorkflow({ store, workflow, providers });
}

async function commitPassedWorkflow({ store, workflow, providers }) {
  const receipt = await store.loadCheckReceipt(workflow.workId, workflow.checkId);
  if (!receipt || receipt.verdict !== 'passed' || receipt.consumedAt) throw new Error('유효한 미사용 검사 영수증이 없습니다.');
  if (receipt.chapter !== workflow.chapter || receipt.proseHash !== proseHash(workflow.draftProse)) {
    throw new Error('검사받은 본문과 커밋할 본문이 다릅니다. 다시 검사하세요.');
  }
  await assertCurrentChapterReceipt({ store, workId: workflow.workId, chapter: workflow.chapter, receipt, artifact: { ...receipt.artifact, prose: workflow.draftProse, title: workflow.title ?? receipt.artifact.title, summary: workflow.summary ?? receipt.artifact.summary, castManifestRaw: workflow.castManifestRaw ?? receipt.artifact.castManifestRaw } });
  const reviewed = receipt.review?.status === 'completed' && receipt.review.proseHash === receipt.proseHash;
  let approved = false;
  if (workflow.userApproval) { validateApprovalBinding({ approval: workflow.userApproval, receipt: receipt.validationReceipt }); approved = true; }
  if (!reviewed && !approved) {
    workflow.approvalId = id('approval');
    workflow.degraded = { code: 'CRITIC_INCOMPLETE', autoCommitSuppressed: true };
    await transition(store, workflow, 'awaiting_draft_approval', { operation: null });
    return { status: 'awaiting_approval', workflowId: workflow.workflowId, chapter: workflow.chapter,
      approvalId: workflow.approvalId, prose: workflow.draftProse, quality: workflow.quality, degraded: workflow.degraded,
      nextAction: '필수 검토가 완료되지 않았습니다. 원고와 검사 결과를 보고 lore_decide로 판단하세요.' };
  }
  const priorExperience = workflow.patternEntry
    ? await loadCurrentExperienceLedger({ store, workId: workflow.workId })
    : null;
  const result = await runCommit({
    store, workId: workflow.workId, chapter: workflow.chapter,
    prose: workflow.draftProse, title: workflow.title, summary: workflow.summary,
    castManifestRaw: workflow.castManifestRaw, providers, delta: receipt.delta, checkId: receipt.checkId,
  });
  const appliedBoundary = await applyNarrativeBoundary({ store, workId: workflow.workId, chapter: workflow.chapter, boundary: workflow.boundary });
  if (workflow.patternEntry) {
    await saveExperienceLedgerForHead({
      store, workId: workflow.workId, sourceHead: result.publication.head,
      entries: [...priorExperience.entries.filter((entry) => entry.chapter !== workflow.chapter), workflow.patternEntry],
      criticVersion: workflow.patternEntry.criticVersion ?? null,
    });
  }
  if (workflow.arcReview) await store.saveArcReview(workflow.workId, { ...workflow.arcReview, sourceHead: result.publication.head });
  receipt.consumedAt = now();
  await store.saveCheckReceipt(workflow.workId, receipt);
  const hash = receipt.proseHash;
  delete workflow.draftProse;
  delete workflow.castManifestRaw;
  await transition(store, workflow, 'completed', { operation: null, committedAt: receipt.consumedAt, proseHash: hash });
  await store.appendWorkflowEvent(workflow.workId, workflow.workflowId, {
    at: receipt.consumedAt, event: 'chapter_committed', chapter: workflow.chapter, checkId: receipt.checkId, proseHash: hash,
  });
  await store.appendWorkflowEvent(workflow.workId, workflow.workflowId, {
    at: receipt.consumedAt, event: 'narrative_boundary', chapter: workflow.chapter,
    decision: workflow.boundary?.decision ?? 'advance_episode', reason: workflow.boundary?.reason ?? '',
    arcExtended: Boolean(appliedBoundary),
  });
  try { result.snapshot = await createChapterSnapshot({ store, workId: workflow.workId, chapter: workflow.chapter }); }
  catch (error) { result.snapshot = { created: false, error: error.message }; }
  return { status: 'completed', workflowId: workflow.workflowId, chapter: workflow.chapter, quality: workflow.quality, boundary: workflow.boundary, commit: result };
}

export async function runWorkflowDecide({ store, workId, approvalId, action, feedback = '', providers: baseProviders }) {
  const workflow = await store.loadWorkflow(workId);
  const providers = withModelProfile(baseProviders, workflow?.modelProfile ?? null);
  if (!workflow || workflow.stage !== 'awaiting_draft_approval' || workflow.approvalId !== approvalId) {
    throw new Error('현재 승인 대기 중인 원고와 approvalId가 일치하지 않습니다.');
  }
  if (action === 'approve') {
    const receipt = await store.loadCheckReceipt(workId, workflow.checkId);
    await assertCurrentChapterReceipt({ store, workId, chapter: workflow.chapter, receipt, artifact: receipt?.artifact });
    workflow.userApproval = buildApprovalBinding(receipt.validationReceipt, { approvedBy: approvalId });
    await store.saveWorkflow(workId, workflow);
    await store.appendWorkflowEvent(workId, workflow.workflowId, { at: now(), event: 'user_approved', chapter: workflow.chapter, approvalId });
    return commitPassedWorkflow({ store, workflow, providers });
  }
  if (action === 'request_revision') {
    if (!String(feedback).trim()) throw new Error('수정 요청에는 feedback이 필요합니다.');
    delete workflow.checkId; delete workflow.userApproval; delete workflow.approvalId;
    // The user's feedback opens a new revision round with the full quality
    // revise budget (lore_decide is a separate call, never a relay resume).
    delete workflow.qualityRevisions;
    await transition(store, workflow, 'revision_requested', {
      operation: 'user_revision', revisionFeedback: String(feedback).trim(),
    });
    await store.appendWorkflowEvent(workId, workflow.workflowId, {
      at: now(), event: 'user_revision_requested', chapter: workflow.chapter, approvalId,
      feedback: String(feedback).trim(),
    });
    return {
      status: 'revision_requested', workflowId: workflow.workflowId, chapter: workflow.chapter,
      nextAction: 'lore_write를 다시 호출하면 같은 원고와 workflow에서 수정·재검사를 이어갑니다.',
    };
  }
  if (action === 'hold') {
    await store.appendWorkflowEvent(workId, workflow.workflowId, {
      at: now(), event: 'user_held', chapter: workflow.chapter, approvalId,
    });
    return { status: 'on_hold', workflowId: workflow.workflowId, chapter: workflow.chapter };
  }
  if (action === 'reject') {
    await transition(store, workflow, 'rejected', { operation: null, feedback: String(feedback) });
    await store.appendWorkflowEvent(workId, workflow.workflowId, { at: now(), event: 'user_rejected', chapter: workflow.chapter, approvalId, feedback: String(feedback) });
    return { status: 'rejected', workflowId: workflow.workflowId, chapter: workflow.chapter, nextAction: '피드백을 instruction으로 넘겨 lore_write를 다시 호출하세요.' };
  }
  throw new Error('action은 approve, request_revision, hold 또는 reject여야 합니다.');
}

export async function runWorkflowStatus({ store, workId }) {
  const workflow = await store.loadWorkflow(workId);
  if (!workflow) return { active: false };
  const { draftProse, castManifestRaw, ...safe } = workflow;
  const active = !['completed', 'rejected', 'clean_fail'].includes(workflow.stage);
  if (active && workflow.stage === 'awaiting_model' && !safe.pendingRunId) {
    const run = await findLatestRun(store.rootDir, {
      tool: 'lore_write', workId, createdAfter: workflow.createdAt,
    });
    if (run) safe.pendingRunId = run.id;
  }
  return {
    active,
    workflow: safe,
    ...(safe.pendingRunId ? {
      resume: {
        runId: safe.pendingRunId,
        nextAction: `lore_resume에 runId \"${safe.pendingRunId}\"와 모델 answers를 전달하세요.`,
      },
    } : {}),
  };
}

export async function runWorkflowHistory({ store, workId, workflowId, limit = 100, includeModelExchanges = false }) {
  const workflow = await store.loadWorkflow(workId, workflowId ?? 'current');
  if (!workflow) return { found: false, events: [] };
  const events = await store.loadWorkflowEvents(workId, workflow.workflowId, limit);
  const ids = [...new Set(events.flatMap((event) => [event.exchangeId, ...(event.review?.records ?? []).map((record) => record.exchangeId)]).filter(Boolean))];
  const modelExchanges = includeModelExchanges ? await Promise.all(ids.map(async (exchangeId) => ({ exchangeId, exchange: await store.loadModelExchange(workId, exchangeId) }))) : undefined;
  return { found: true, workflowId: workflow.workflowId, events, ...(includeModelExchanges ? { modelExchanges } : {}) };
}

export async function runWorkflowInspect({ store, workId, workflowId, detail = 'summary' }) {
  const workflow = await store.loadWorkflow(workId, workflowId ?? 'current');
  if (!workflow) return { found: false };
  const receipt = workflow.checkId ? await store.loadCheckReceipt(workId, workflow.checkId) : null;
  const { draftProse, castManifestRaw, ...safe } = workflow;
  if (workflow.stage === 'awaiting_model' && !safe.pendingRunId) {
    const run = await findLatestRun(store.rootDir, {
      tool: 'lore_write', workId, createdAfter: workflow.createdAt,
    });
    if (run) safe.pendingRunId = run.id;
  }
  // The kept or parked draft is what the user decides on; detail="full" shows it.
  return { found: true, workflow: safe, receipt, ...(detail === 'full' && draftProse ? { draftProse } : {}) };
}
