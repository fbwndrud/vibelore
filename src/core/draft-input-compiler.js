import { createHash } from 'node:crypto';
import { tokenUnits } from './token-units.js';

import { asKit } from '../prompts/index.js';

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const asArray = (value) => Array.isArray(value) ? value : [];
const forbiddenControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const reservedSyntax = /⟦vle:|```|~~~|<\/?(?:system|assistant|developer|memory)\b/iu;
const metaInstruction = /ignore\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions?|(?:시스템|개발자|이전)\s*지시(?:를|사항을)?\s*무시|role\s*:\s*(?:system|assistant|developer)/iu;
const digest = (value) => `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hasOnlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.has(key));

function memoryTextFields(claim) {
  const object = claim?.object ?? {};
  return [
    object.anchor, object.interpretation, object.nextChoiceBias,
    object.behavioralProof?.chosen, object.behavioralProof?.costPaid,
    ...asArray(object.directionalRelationshipEffects).flatMap((item) => [item?.from, item?.to, item?.belief]),
  ].filter((value) => value !== undefined && value !== null).map(String);
}

function unsafeMemoryReason(claim) {
  if (!plainObject(claim) || !hasOnlyKeys(claim, new Set(['claimId', 'claimType', 'subjectId', 'object', 'canonAssertions']))) return 'unknown-claim-field';
  if (claim.claimType !== 'influence-event' || typeof claim.claimId !== 'string' || !claim.claimId || !plainObject(claim.object)) return 'invalid-claim-shape';
  if (!hasOnlyKeys(claim.object, new Set(['chapter', 'characterId', 'anchor', 'interpretation', 'nextChoiceBias', 'behavioralProof', 'directionalRelationshipEffects']))) return 'unknown-object-field';
  if (!Number.isSafeInteger(claim.object.chapter) || claim.object.chapter < 1
    || !['characterId', 'anchor', 'interpretation', 'nextChoiceBias'].every((key) => typeof claim.object[key] === 'string' && clean(claim.object[key]))) return 'invalid-claim-shape';
  if (claim.object.behavioralProof !== undefined && (!plainObject(claim.object.behavioralProof)
    || !hasOnlyKeys(claim.object.behavioralProof, new Set(['chosen', 'costPaid']))
    || Object.values(claim.object.behavioralProof).some((value) => typeof value !== 'string'))) return 'invalid-behavioral-proof';
  if (claim.object.directionalRelationshipEffects !== undefined && (!Array.isArray(claim.object.directionalRelationshipEffects)
    || claim.object.directionalRelationshipEffects.length > 8
    || claim.object.directionalRelationshipEffects.some((item) => !plainObject(item)
      || !hasOnlyKeys(item, new Set(['from', 'to', 'belief']))
      || !['from', 'to', 'belief'].every((key) => typeof item[key] === 'string' && clean(item[key]))))) return 'invalid-relationship-effect';
  if (claim.canonAssertions !== undefined && (!Array.isArray(claim.canonAssertions)
    || claim.canonAssertions.length > 16
    || claim.canonAssertions.some((item) => !plainObject(item)
      || !hasOnlyKeys(item, new Set(['factId', 'valueHash']))
      || typeof item.factId !== 'string' || !item.factId
      || typeof item.valueHash !== 'string' || !item.valueHash))) return 'invalid-canon-assertion';
  const fields = memoryTextFields(claim);
  if (fields.some((value) => forbiddenControls.test(value))) return 'control-character';
  if (fields.some((value) => reservedSyntax.test(value))) return 'reserved-syntax';
  if (fields.some((value) => metaInstruction.test(value))) return 'instruction-like-content';
  if (fields.some((value) => [...value].length > 500)) return 'field-too-long';
  return null;
}

function renderMemoryClaim(claim, t) {
  const object = claim.object;
  const lines = [
    t.memoryClaim(
      clean(object.characterId || claim.subjectId?.replace(/^character:/, '')),
      Number.isSafeInteger(object.chapter) ? object.chapter : '?',
      clean(object.anchor), clean(object.interpretation), clean(object.nextChoiceBias),
    ),
  ];
  if (object.behavioralProof?.chosen || object.behavioralProof?.costPaid) {
    lines.push(t.memoryProof(clean(object.behavioralProof?.chosen), clean(object.behavioralProof?.costPaid)));
  }
  const relationships = asArray(object.directionalRelationshipEffects)
    .filter((item) => item?.from && item?.to && item?.belief)
    .map((item) => `${clean(item.from)} → ${clean(item.to)}: ${clean(item.belief)}`);
  if (relationships.length) lines.push(t.memoryRelationships(relationships.join('; ')));
  return lines.join('\n');
}

function renderMemoryClaims(claims, t) {
  if (!claims.length) return '';
  return [
    t.memoryHeading,
    t.memoryRule,
    ...claims.map((claim) => renderMemoryClaim(claim, t)),
    t.memoryFooter,
  ].join('\n');
}

function renderContinuityContext(continuity, t) {
  return [
    t.continuityHeading,
    clean(continuity.genreLine),
    asArray(continuity.recentSummaries).length
      ? t.recentEvents(continuity.recentSummaries.slice(0, 2).map(clean).join(' / '))
      : '',
  ].filter(Boolean).join('\n');
}

function renderPlan({ episodeText, authorText, memoryText, supplementalText, castIds, locations, previousSceneTail, t }) {
  return [
    t.planHeading,
    t.planRule,
    episodeText,
    ...(memoryText ? ['', memoryText] : []),
    '',
    authorText,
    ...(supplementalText ? [t.supplemental(supplementalText)] : []),
    '',
    t.cast(castIds.join(', ')),
    t.locations(locations.join(', ')),
    ...(previousSceneTail ? [
      '', t.previousTailHeading, previousSceneTail,
      t.previousTailRule,
    ] : []),
  ].join('\n');
}

export function compileDraftInputs({
  identity,
  episode,
  authorCraft,
  memoryClaims = [],
  continuity = {},
  supplementalDirection,
  budget = {},
  kit: kitSource,
} = {}) {
  const t = asKit(kitSource).phrases.draftInput;
  if (!identity || typeof identity.workId !== 'string' || !identity.workId || !Number.isSafeInteger(identity.chapter) || identity.chapter < 1) {
    return { ok: false, error: { code: 'INVALID_DRAFT_IDENTITY', section: 'identity', reason: 'workId-and-chapter-required' } };
  }
  if (identity.invocation === 'workflow' && (typeof identity.workflowId !== 'string' || !identity.workflowId)) {
    return { ok: false, error: { code: 'WORKFLOW_IDENTITY_REQUIRED', section: 'identity', reason: 'workflowId-required-for-workflow-invocation' } };
  }
  if (!plainObject(episode) || typeof episode.writerText !== 'string' || !episode.writerText) {
    return { ok: false, error: { code: 'INVALID_DRAFT_INPUT', section: 'episode', reason: 'compiled-episode-required' } };
  }
  if (!plainObject(authorCraft) || typeof authorCraft.writerText !== 'string') {
    return { ok: false, error: { code: 'INVALID_DRAFT_INPUT', section: 'authorCraft', reason: 'compiled-author-craft-required' } };
  }
  if (!Array.isArray(memoryClaims)) {
    return { ok: false, error: { code: 'INVALID_DRAFT_INPUT', section: 'memoryClaims', reason: 'array-required' } };
  }
  if (!plainObject(continuity) || !plainObject(budget)) {
    return { ok: false, error: { code: 'INVALID_DRAFT_INPUT', section: !plainObject(continuity) ? 'continuity' : 'budget', reason: 'plain-object-required' } };
  }
  const budgetValues = ['maxPlanTokens', 'maxContextTokens', 'maxMemoryTokens']
    .filter((key) => budget[key] !== undefined).map((key) => budget[key]);
  if (budgetValues.some((value) => !Number.isFinite(value) || value < 0)) {
    return { ok: false, error: { code: 'INVALID_DRAFT_INPUT', section: 'budget', reason: 'non-negative-finite-budgets-required' } };
  }
  if (supplementalDirection !== undefined && (!plainObject(supplementalDirection)
    || !['workflow-user', 'direct-user'].includes(supplementalDirection.source)
    || typeof supplementalDirection.text !== 'string'
    || [...supplementalDirection.text].length > 800
    || forbiddenControls.test(supplementalDirection.text))) {
    return { ok: false, error: { code: 'INVALID_DRAFT_INPUT', section: 'supplementalDirection', reason: 'bounded-user-direction-required' } };
  }
  for (const claim of memoryClaims) {
    const reason = unsafeMemoryReason(claim);
    if (reason) {
      return { ok: false, error: { code: 'UNSAFE_MEMORY_CLAIM', section: 'memoryClaims', claimId: claim?.claimId ?? null, reason } };
    }
    const canonById = new Map(asArray(continuity.canonAssertions).map((assertion) => [assertion?.factId, assertion?.valueHash]));
    const conflict = asArray(claim.canonAssertions).find((assertion) => canonById.has(assertion.factId)
      && canonById.get(assertion.factId) !== assertion.valueHash);
    if (conflict) return { ok: false, error: { code: 'CANON_MEMORY_CONFLICT', section: 'memoryClaims', claimId: claim.claimId, factId: conflict.factId } };
  }
  const maxMemoryTokens = Number.isFinite(budget.maxMemoryTokens) && budget.maxMemoryTokens >= 0
    ? budget.maxMemoryTokens
    : Number.POSITIVE_INFINITY;
  const includedMemoryClaims = [];
  const memoryClaimsExcluded = [];
  for (const claim of memoryClaims) {
    const proposed = [...includedMemoryClaims, claim];
    if (tokenUnits(renderMemoryClaims(proposed, t)) > maxMemoryTokens) {
      memoryClaimsExcluded.push({ claimId: claim.claimId, reason: 'memory-token-budget' });
    } else {
      includedMemoryClaims.push(claim);
    }
  }
  const planInput = {
    episodeText: episode.writerText, authorText: authorCraft.writerText,
    supplementalText: supplementalDirection?.text ?? '',
    castIds: asArray(continuity.castIds), locations: asArray(continuity.locations),
  };
  const originalTail = continuity.previousSceneTail ?? '';
  let includedTail = originalTail;
  let memoryText = renderMemoryClaims(includedMemoryClaims, t);
  let plan = renderPlan({ ...planInput, memoryText, previousSceneTail: includedTail, t });
  const maxPlanTokens = Number.isFinite(budget.maxPlanTokens) ? budget.maxPlanTokens : Number.POSITIVE_INFINITY;
  while (tokenUnits(plan) > maxPlanTokens && includedMemoryClaims.length) {
    const removed = includedMemoryClaims.pop();
    memoryClaimsExcluded.push({ claimId: removed.claimId, reason: 'plan-token-budget' });
    memoryText = renderMemoryClaims(includedMemoryClaims, t);
    plan = renderPlan({ ...planInput, memoryText, previousSceneTail: includedTail, t });
  }
  if (tokenUnits(plan) > maxPlanTokens && includedTail) {
    includedTail = '';
    plan = renderPlan({ ...planInput, memoryText, previousSceneTail: includedTail, t });
  }
  const slidingWindowRender = renderContinuityContext(continuity, t);
  const planTokens = tokenUnits(plan);
  const contextTokens = tokenUnits(slidingWindowRender);
  if (Number.isFinite(budget.maxPlanTokens) && planTokens > budget.maxPlanTokens) {
    return { ok: false, error: { code: 'CONTEXT_BUDGET_EXCEEDED', section: 'plan', requiredTokens: planTokens, maxTokens: budget.maxPlanTokens, recovery: 'increase_budget_or_reduce_mandatory_episode' } };
  }
  if (Number.isFinite(budget.maxContextTokens) && contextTokens > budget.maxContextTokens) {
    return { ok: false, error: { code: 'CONTEXT_BUDGET_EXCEEDED', section: 'continuity', requiredTokens: contextTokens, maxTokens: budget.maxContextTokens, recovery: 'increase_budget_or_reduce_hard_continuity' } };
  }
  return {
    ok: true,
    value: {
      plan,
      slidingWindowRender,
      customPromptOverride: undefined,
      trace: {
        identity: structuredClone(identity), memoryClaimsIncluded: includedMemoryClaims.length,
        memoryClaimIds: includedMemoryClaims.map((claim) => claim.claimId).filter(Boolean),
        memoryClaimsExcluded,
        outputs: { planHash: digest(plan), slidingWindowHash: digest(slidingWindowRender) },
        sections: {
          episode: { originalTokens: tokenUnits(episode.writerText), includedTokens: tokenUnits(episode.writerText), truncated: false },
          authorCraft: { originalTokens: tokenUnits(authorCraft.writerText), includedTokens: tokenUnits(authorCraft.writerText), truncated: false },
          memory: { originalTokens: memoryClaims.length ? tokenUnits(renderMemoryClaims(memoryClaims, t)) : 0, includedTokens: memoryText ? tokenUnits(memoryText) : 0, truncated: includedMemoryClaims.length !== memoryClaims.length },
          previousTail: { originalTokens: originalTail ? tokenUnits(originalTail) : 0, includedTokens: includedTail ? tokenUnits(includedTail) : 0, truncated: Boolean(originalTail && !includedTail), reason: originalTail && !includedTail ? 'plan-token-budget' : null },
        },
      },
      usage: {
        planTokens, contextTokens, memoryTokens: memoryText ? tokenUnits(memoryText) : 0,
        maxPlanTokens: budget.maxPlanTokens ?? null, maxContextTokens: budget.maxContextTokens ?? null,
      },
    },
  };
}
