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

async function loadPolicy(store, workId) {
  return (await store.loadReviewPolicy?.(workId)) ?? {};
}

function checked(values, allowed, kind) {
  const unknown = values.filter((value) => !allowed.includes(value));
  if (unknown.length) throw new Error(`INVALID_${kind}_NAME: ${unknown.join(', ')} — 끌 수 있는 항목: ${allowed.join(', ')}`);
  return [...new Set(values)];
}

export async function loadDisabledReviews(store, workId) {
  return ((await loadPolicy(store, workId)).disabled ?? []).filter((step) => OPTIONAL_REVIEWS.includes(step));
}

export async function loadDisabledDraftSections(store, workId) {
  return ((await loadPolicy(store, workId)).draftSectionsOff ?? []).filter((name) => OPTIONAL_DRAFT_SECTIONS.includes(name));
}

/** Replaces the given lists; a list left undefined keeps its stored value. */
export async function saveWriterSupportPolicy(store, workId, { disabledReviews, disabledDraftSections } = {}) {
  const current = await loadPolicy(store, workId);
  const next = {
    disabled: disabledReviews === undefined ? (current.disabled ?? []) : checked(disabledReviews, OPTIONAL_REVIEWS, 'REVIEW'),
    draftSectionsOff: disabledDraftSections === undefined ? (current.draftSectionsOff ?? []) : checked(disabledDraftSections, OPTIONAL_DRAFT_SECTIONS, 'DRAFT_SECTION'),
    updatedAt: new Date().toISOString(),
  };
  await store.saveReviewPolicy(workId, next);
  return next;
}
