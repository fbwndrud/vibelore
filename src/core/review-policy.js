import { LEDGER_FEATURES, TRACKING_FEATURES } from '../../engine/src/continuity/ledger.js';

/**
 * Per-work switches for what supports the writer. None is required.
 *
 * Reviews: a review turned off is not requested and is recorded as
 * `disabled_by_user`, which never counts as a failed review. Continuity
 * extraction and checking are not listed: they keep the canon.
 *
 * Draft sections: optional material in the draft request. The plan, setting,
 * current state and recent summary window are not listed: the chapter is
 * written from them.
 */
export const OPTIONAL_REVIEWS = Object.freeze([
  'story-profile-check', 'coherence-judge', 'editorial-quality',
  'character-fidelity', 'reader-hook', 'pattern-ledger',
]);
export const OPTIONAL_DRAFT_SECTIONS = Object.freeze([
  'older-memory', 'previous-tail', 'author-craft', 'style-anchor',
]);

const RULE_TYPES = new Set(['monotonic', 'frozenAfter', 'speakerOnly']);

async function loadPolicy(store, workId) {
  return (await store.loadReviewPolicy?.(workId)) ?? {};
}

/** What the story ledger tracks for this work, and the merges the user approved. */
export async function loadLedgerConfig(store, workId) {
  const policy = await loadPolicy(store, workId);
  return { tracking: policy.tracking ?? {}, customTracking: policy.customTracking ?? [], merges: policy.merges ?? [] };
}

function checked(values, allowed, kind) {
  const unknown = values.filter((value) => !allowed.includes(value));
  if (unknown.length) throw new Error(`INVALID_${kind}_NAME: ${unknown.join(', ')} — 끌 수 있는 항목: ${allowed.join(', ')}`);
  return [...new Set(values)];
}

function checkedTracking(tracking) {
  const unknown = Object.keys(tracking).filter((key) => !TRACKING_FEATURES.includes(key));
  if (unknown.length) throw new Error(`INVALID_TRACKING_FEATURE: ${unknown.join(', ')} — 가능한 항목: ${TRACKING_FEATURES.join(', ')}`);
  return Object.fromEntries(Object.entries(tracking).map(([key, value]) => [key, value !== false]));
}

function checkedCustom(items, previous) {
  const taken = new Map((previous ?? []).map((item) => [item.name, item.id]));
  let next = Math.max(0, ...(previous ?? []).map((item) => Number(/^u(\d+)$/.exec(item.id)?.[1] ?? 0)));
  return items.map((item) => {
    if (typeof item?.name !== 'string' || !item.name.trim() || !LEDGER_FEATURES.includes(item.feature)
      || (item.rules ?? []).some((rule) => !RULE_TYPES.has(rule?.type))) {
      throw new Error(`INVALID_CUSTOM_TRACKING: ${JSON.stringify(item)} — feature는 ${LEDGER_FEATURES.join('|')}, rules.type은 ${[...RULE_TYPES].join('|')}`);
    }
    const id = taken.get(item.name.trim()) ?? `u${++next}`;
    return { id, name: item.name.trim(), feature: item.feature, ...(item.pinned ? { pinned: true } : {}),
      ...(item.rules?.length ? { rules: item.rules } : {}), ...(item.note ? { note: String(item.note) } : {}) };
  });
}

export async function loadDisabledReviews(store, workId) {
  return ((await loadPolicy(store, workId)).disabled ?? []).filter((step) => OPTIONAL_REVIEWS.includes(step));
}

export async function loadDisabledDraftSections(store, workId) {
  return ((await loadPolicy(store, workId)).draftSectionsOff ?? []).filter((name) => OPTIONAL_DRAFT_SECTIONS.includes(name));
}

/** Replaces the given lists; a list left undefined keeps its stored value. */
export async function saveWriterSupportPolicy(store, workId, { disabledReviews, disabledDraftSections, tracking, customTracking, mergeRecords } = {}) {
  const current = await loadPolicy(store, workId);
  const merges = [...(current.merges ?? [])];
  for (const merge of mergeRecords ?? []) {
    if (typeof merge?.from !== 'string' || typeof merge?.into !== 'string') throw new Error('INVALID_MERGE: {from, into} 기록 id가 필요합니다.');
    if (!merges.some((item) => item.from === merge.from && item.into === merge.into)) merges.push({ from: merge.from, into: merge.into });
  }
  const next = {
    disabled: disabledReviews === undefined ? (current.disabled ?? []) : checked(disabledReviews, OPTIONAL_REVIEWS, 'REVIEW'),
    draftSectionsOff: disabledDraftSections === undefined ? (current.draftSectionsOff ?? []) : checked(disabledDraftSections, OPTIONAL_DRAFT_SECTIONS, 'DRAFT_SECTION'),
    tracking: tracking === undefined ? (current.tracking ?? {}) : checkedTracking(tracking),
    customTracking: customTracking === undefined ? (current.customTracking ?? []) : checkedCustom(customTracking, current.customTracking),
    merges,
    updatedAt: new Date().toISOString(),
  };
  await store.saveReviewPolicy(workId, next);
  return next;
}
