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

const unsafeContinuityText = (value) => forbiddenControls.test(value) || reservedSyntax.test(value) || metaInstruction.test(value);

/** Why a short host-written text cannot enter the writer prompt, or null. Screens like memory text. */
export function unsafePromptTextReason(value) {
  const text = String(value ?? '');
  if (forbiddenControls.test(text)) return 'control-character';
  if (reservedSyntax.test(text)) return 'reserved-syntax';
  if (metaInstruction.test(text)) return 'instruction-like-content';
  return null;
}

// Summaries arrive newest-first (plain strings too); older memory arrives in
// retrieval rank order. Both are canon material and are rendered as data, so
// every rendered field is screened like a memory claim.
function continuityItems(continuity, excluded) {
  const readable = (item) => typeof item.text === 'string' && clean(item.text);
  const safe = (item, fields, exclusion) => {
    if (!fields.some((value) => unsafeContinuityText(String(value ?? '')))) return true;
    excluded.push({ ...exclusion, reason: 'unsafe-content' });
    return false;
  };
  const summaries = asArray(continuity.recentSummaries)
    .map((item) => (typeof item === 'string' ? { chapter: null, text: item } : { chapter: item?.chapter ?? null, text: item?.text }))
    .filter(readable)
    .filter((item) => safe(item, [item.text], { kind: 'recentSummary', chapter: item.chapter }));
  const olderMemory = asArray(continuity.olderMemory)
    .map((item) => ({ scope: item?.scope, ref: item?.ref, chapter: item?.chapter ?? null, text: item?.text }))
    .filter(readable)
    .filter((item) => safe(item, [item.scope, item.ref, item.text], { kind: 'olderMemory', ref: item.ref ?? null }));
  return { summaries, olderMemory };
}

function renderContinuityContext(genreLine, { summaries, olderMemory }, t) {
  const structured = summaries.some((item) => item.chapter !== null);
  const summaryLines = !summaries.length ? []
    : structured
      ? [t.recentEventsHeading, ...[...summaries].reverse().map((item) => t.recentEvent(item.chapter ?? '?', clean(item.text)))]
      : [t.recentEvents(summaries.map((item) => clean(item.text)).join(' / '))];
  const memoryLines = olderMemory.length
    ? [t.olderMemoryHeading, ...olderMemory.map((item) => t.olderMemoryItem(clean(item.scope), clean(item.ref), item.chapter, clean(item.text)))]
    : [];
  return [t.continuityHeading, clean(genreLine), ...summaryLines, ...memoryLines].filter(Boolean).join('\n');
}

/**
 * Render the continuity window (recent summaries, older memory) as canon data
 * within a token budget. Shared by the draft compiler and the whole-chapter
 * rewrite so both see the same window.
 */
export function renderContinuity({ genreLine, recentSummaries, olderMemory, maxContextTokens: maxTokens, kit: kitSource } = {}) {
  const t = asKit(kitSource).phrases.draftInput;
  const continuityExcluded = [];
  const items = continuityItems({ recentSummaries, olderMemory }, continuityExcluded);
  let text = renderContinuityContext(genreLine, items, t);
  const maxContextTokens = Number.isFinite(maxTokens) ? maxTokens : Number.POSITIVE_INFINITY;
  // Over budget, drop the lowest-ranked older memory first, then the oldest
  // summary, then shorten the newest one, instead of refusing the draft. Only
  // the genre line alone can still exceed the budget.
  while (tokenUnits(text) > maxContextTokens && (items.olderMemory.length || items.summaries.length)) {
    if (items.olderMemory.length) {
      const removed = items.olderMemory.pop();
      continuityExcluded.push({ kind: 'olderMemory', ref: removed.ref ?? null, reason: 'context-token-budget' });
    } else if (items.summaries.length > 1) {
      const removed = items.summaries.pop();
      continuityExcluded.push({ kind: 'recentSummary', chapter: removed.chapter, reason: 'context-token-budget' });
    } else {
      const [last] = items.summaries;
      const shorter = [...clean(last.text)].slice(0, Math.floor([...clean(last.text)].length * 0.8)).join('');
      if (!continuityExcluded.some((item) => item.kind === 'recentSummary' && item.reason === 'truncated')) {
        continuityExcluded.push({ kind: 'recentSummary', chapter: last.chapter, reason: 'truncated' });
      }
      if ([...shorter].length < 20) {
        items.summaries.pop();
        continuityExcluded.at(-1).reason = 'context-token-budget';
      } else {
        last.text = `${shorter}…`;
      }
    }
    text = renderContinuityContext(genreLine, items, t);
  }
  return {
    text,
    trace: {
      recentSummaryChapters: items.summaries.map((item) => item.chapter),
      olderMemoryRefs: items.olderMemory.map((item) => `${item.scope}:${item.ref}`),
      excluded: continuityExcluded,
    },
  };
}

const PREFERENCE_KEYS = new Set(['id', 'level', 'ref', 'statement']);
// One source for the limits; the preference ledger takes its caps from here.
export const MAX_DRAFT_PREFERENCES = 12;
export const MAX_PREFERENCE_STATEMENT_CHARS = 300;
const MAX_PREFERENCE_REF_CHARS = 120;

// Adopted creative preferences arrive already screened by the ledger; a stored
// file that changed by hand is refused here rather than placed in the prompt.
function preferenceInputReason(items) {
  if (!Array.isArray(items) || items.length > MAX_DRAFT_PREFERENCES) return 'bounded-preference-list-required';
  const ids = new Set();
  for (const item of items) {
    if (!plainObject(item) || !hasOnlyKeys(item, PREFERENCE_KEYS) || !['work', 'subject'].includes(item.level)
      || !['id', 'ref', 'statement'].every((key) => typeof item[key] === 'string' && clean(item[key]))
      || [...item.statement].length > MAX_PREFERENCE_STATEMENT_CHARS) return 'invalid-preference-shape';
    // Same id and character-id rules as the ledger: a hand-changed file gets no looser treatment.
    if (!/^dec-\d+$/.test(item.id) || ids.has(item.id)) return 'invalid-preference-shape';
    ids.add(item.id);
    if (item.level === 'subject' && ([...item.ref].length > MAX_PREFERENCE_REF_CHARS || /\s/u.test(item.ref))) return 'invalid-preference-shape';
    const unsafe = unsafePromptTextReason(item.statement) ?? unsafePromptTextReason(item.ref);
    if (unsafe) return unsafe;
  }
  return null;
}

// Work-level items first, then subject-level items grouped by character in first-seen order.
function orderedPreferences(items) {
  const subjects = [...new Set(items.filter((item) => item.level === 'subject').map((item) => item.ref))];
  return [...items.filter((item) => item.level === 'work'),
    ...subjects.flatMap((ref) => items.filter((item) => item.level === 'subject' && item.ref === ref))];
}

function renderPreferences(items, t) {
  if (!items.length) return '';
  const lines = [t.preferencesHeading, t.preferencesRule];
  let group = null;
  for (const item of items) {
    const key = item.level === 'work' ? 'work' : `subject:${item.ref}`;
    if (key !== group) lines.push(item.level === 'work' ? t.preferencesWork : t.preferencesSubject(clean(item.ref)));
    group = key;
    lines.push(`- ${clean(item.statement)}`);
  }
  return lines.join('\n');
}

// A revision sees the same adopted preferences as structured soft style context, grouped by character.
export function revisePreferenceContext(items, kitSource) {
  const reason = preferenceInputReason(items);
  if (reason) throw new Error(`INVALID_DRAFT_INPUT: creativePreferences ${reason}`);
  if (!items.length) return null;
  const ordered = orderedPreferences(items);
  // Character ids such as `constructor` or `__proto__` are plain keys here.
  const subjects = Object.create(null);
  for (const item of ordered.filter((entry) => entry.level === 'subject')) (subjects[clean(item.ref)] ??= []).push(clean(item.statement));
  return {
    rule: asKit(kitSource).phrases.draftInput.preferencesReviseRule,
    work: ordered.filter((item) => item.level === 'work').map((item) => clean(item.statement)),
    subjects,
  };
}

function renderPlan({ episodeText, authorText, preferencesText, memoryText, supplementalText, castIds, locations, previousSceneTail, t }) {
  return [
    t.planHeading,
    t.planRule,
    episodeText,
    ...(memoryText ? ['', memoryText] : []),
    '',
    authorText,
    ...(preferencesText ? ['', preferencesText] : []),
    ...(supplementalText ? [...(preferencesText ? [''] : []), t.supplemental(supplementalText)] : []),
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
  creativePreferences = [],
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
  const preferenceReason = preferenceInputReason(creativePreferences);
  if (preferenceReason) return { ok: false, error: { code: 'INVALID_DRAFT_INPUT', section: 'creativePreferences', reason: preferenceReason } };
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
  const preferences = orderedPreferences(creativePreferences);
  const originalPreferencesText = renderPreferences(preferences, t);
  let preferencesText = originalPreferencesText;
  let memoryText = renderMemoryClaims(includedMemoryClaims, t);
  const render = () => renderPlan({ ...planInput, preferencesText, memoryText, previousSceneTail: includedTail, t });
  let plan = render();
  const maxPlanTokens = Number.isFinite(budget.maxPlanTokens) ? budget.maxPlanTokens : Number.POSITIVE_INFINITY;
  // Soft preferences leave as a whole section before any memory claim or the previous-scene tail.
  if (tokenUnits(plan) > maxPlanTokens && preferencesText) {
    preferencesText = '';
    plan = render();
  }
  while (tokenUnits(plan) > maxPlanTokens && includedMemoryClaims.length) {
    const removed = includedMemoryClaims.pop();
    memoryClaimsExcluded.push({ claimId: removed.claimId, reason: 'plan-token-budget' });
    memoryText = renderMemoryClaims(includedMemoryClaims, t);
    plan = render();
  }
  if (tokenUnits(plan) > maxPlanTokens && includedTail) {
    includedTail = '';
    plan = render();
  }
  const continuityResult = renderContinuity({ ...continuity, maxContextTokens: budget.maxContextTokens, kit: kitSource });
  const slidingWindowRender = continuityResult.text;
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
        continuity: continuityResult.trace,
        outputs: { planHash: digest(plan), slidingWindowHash: digest(slidingWindowRender) },
        sections: {
          episode: { originalTokens: tokenUnits(episode.writerText), includedTokens: tokenUnits(episode.writerText), truncated: false },
          authorCraft: { originalTokens: tokenUnits(authorCraft.writerText), includedTokens: tokenUnits(authorCraft.writerText), truncated: false },
          memory: { originalTokens: memoryClaims.length ? tokenUnits(renderMemoryClaims(memoryClaims, t)) : 0, includedTokens: memoryText ? tokenUnits(memoryText) : 0, truncated: includedMemoryClaims.length !== memoryClaims.length },
          previousTail: { originalTokens: originalTail ? tokenUnits(originalTail) : 0, includedTokens: includedTail ? tokenUnits(includedTail) : 0, truncated: Boolean(originalTail && !includedTail), reason: originalTail && !includedTail ? 'plan-token-budget' : null },
          ...(preferences.length ? { creativePreferences: {
            originalTokens: tokenUnits(originalPreferencesText), includedTokens: preferencesText ? tokenUnits(preferencesText) : 0,
            includedIds: preferencesText ? preferences.map((item) => item.id) : [],
            truncated: !preferencesText, reason: preferencesText ? null : 'plan-token-budget',
          } } : {}),
        },
      },
      usage: {
        planTokens, contextTokens, memoryTokens: memoryText ? tokenUnits(memoryText) : 0,
        maxPlanTokens: budget.maxPlanTokens ?? null, maxContextTokens: budget.maxContextTokens ?? null,
      },
    },
  };
}
