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

/**
 * What the story ledger tracks for this work, and the merges the user approved.
 * `history` holds each tracking/author-item change with the chapter it takes
 * effect from, and each merge carries its `atChapter`, so a replay applies the
 * config each chapter was committed under (`ledgerConfigAt`).
 */
export async function loadLedgerConfig(store, workId) {
  const policy = await loadPolicy(store, workId);
  return { tracking: policy.tracking ?? {}, customTracking: policy.customTracking ?? [], merges: policy.merges ?? [], history: policy.trackingHistory ?? [] };
}

/** The chapter a change made now takes effect from: the next one to be committed. */
async function nextChapter(store) {
  const chapters = (await store.listChapters?.()) ?? [];
  return (chapters.at(-1) ?? 0) + 1;
}

/**
 * The tracking history after a change to `tracking` or `customTracking`. The
 * config before the first recorded change was in effect from chapter 1; a
 * second change before the next commit replaces the first.
 */
function nextTrackingHistory(current, next, atChapter) {
  const same = JSON.stringify([current.tracking ?? {}, current.customTracking ?? []]) === JSON.stringify([next.tracking, next.customTracking]);
  const history = current.trackingHistory ?? [];
  if (same) return history;
  const before = history.length ? history : [{ atChapter: 1, tracking: current.tracking ?? {}, customTracking: current.customTracking ?? [] }];
  return [...before.filter((entry) => entry.atChapter < atChapter), { atChapter, tracking: next.tracking, customTracking: next.customTracking }];
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

const RULE_SEVERITIES = new Set(['soft', 'hard']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Names the item and the missing/invalid field, or returns null when the rule is well-formed. */
function ruleFieldError(rule) {
  if (!RULE_TYPES.has(rule?.type)) return `rules.type은 ${[...RULE_TYPES].join('|')} 중 하나여야 합니다`;
  if (rule.severity !== undefined && !RULE_SEVERITIES.has(rule.severity)) return 'severity는 soft|hard여야 합니다';
  if (rule.type === 'monotonic') {
    if (!nonEmptyString(rule.field)) return 'monotonic 규칙에는 field(빈 문자열 아님)가 필요합니다';
    if (rule.direction !== 'up' && rule.direction !== 'down') return 'monotonic 규칙의 direction은 up|down이어야 합니다';
  }
  if (rule.type === 'frozenAfter' && !nonEmptyString(rule.status)) return 'frozenAfter 규칙에는 status(빈 문자열 아님)가 필요합니다';
  if (rule.type === 'speakerOnly') {
    if (!nonEmptyString(rule.alias)) return 'speakerOnly 규칙에는 alias(빈 문자열 아님)가 필요합니다';
    if (!nonEmptyString(rule.by)) return 'speakerOnly 규칙에는 by(빈 문자열 아님)가 필요합니다';
  }
  return null;
}

function maxCustomId(items) {
  return Math.max(0, ...(items ?? []).map((item) => Number(/^u(\d+)$/.exec(item.id)?.[1] ?? 0)));
}

/**
 * Assigns ids stably by name and never reuses one a removed item held: `counterSeed` is the
 * highest id ever issued for this work (persisted separately from the current list, since the
 * current list only holds items still present after a replace).
 */
function checkedCustom(items, previous, counterSeed) {
  const taken = new Map((previous ?? []).map((item) => [item.name, item.id]));
  let next = counterSeed ?? 0;
  const list = items.map((item) => {
    if (typeof item?.name !== 'string' || !item.name.trim() || !LEDGER_FEATURES.includes(item.feature)) {
      throw new Error(`INVALID_CUSTOM_TRACKING: ${JSON.stringify(item)} — feature는 ${LEDGER_FEATURES.join('|')} 중 하나여야 합니다`);
    }
    for (const rule of item.rules ?? []) {
      const error = ruleFieldError(rule);
      if (error) throw new Error(`INVALID_CUSTOM_TRACKING: ${item.name} — ${error} (${JSON.stringify(rule)})`);
    }
    const id = taken.get(item.name.trim()) ?? `u${++next}`;
    return { id, name: item.name.trim(), feature: item.feature, ...(item.pinned ? { pinned: true } : {}),
      ...(item.rules?.length ? { rules: item.rules } : {}), ...(item.note ? { note: String(item.note) } : {}) };
  });
  return { list, counter: next };
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
  const atChapter = await nextChapter(store);
  const merges = [...(current.merges ?? [])];
  for (const merge of mergeRecords ?? []) {
    if (typeof merge?.from !== 'string' || typeof merge?.into !== 'string') throw new Error('INVALID_MERGE: {from, into} 기록 id가 필요합니다.');
    // A merge applies from the next chapter on; the chapters already written keep their records apart.
    if (!merges.some((item) => item.from === merge.from && item.into === merge.into)) merges.push({ from: merge.from, into: merge.into, atChapter });
  }
  const customResult = customTracking === undefined
    ? { list: current.customTracking ?? [], counter: current.customIdCounter ?? maxCustomId(current.customTracking) }
    : checkedCustom(customTracking, current.customTracking, current.customIdCounter ?? maxCustomId(current.customTracking));
  const nextTracking = tracking === undefined ? (current.tracking ?? {}) : checkedTracking(tracking);
  const next = {
    disabled: disabledReviews === undefined ? (current.disabled ?? []) : checked(disabledReviews, OPTIONAL_REVIEWS, 'REVIEW'),
    draftSectionsOff: disabledDraftSections === undefined ? (current.draftSectionsOff ?? []) : checked(disabledDraftSections, OPTIONAL_DRAFT_SECTIONS, 'DRAFT_SECTION'),
    tracking: nextTracking,
    customTracking: customResult.list,
    customIdCounter: customResult.counter,
    trackingHistory: nextTrackingHistory(current, { tracking: nextTracking, customTracking: customResult.list }, atChapter),
    merges,
    updatedAt: new Date().toISOString(),
  };
  await store.saveReviewPolicy(workId, next);
  return next;
}
