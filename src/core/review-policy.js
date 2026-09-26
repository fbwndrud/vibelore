/**
 * Per-work switches for the advisory reviews of a chapter. They support the
 * writer; none is required. A review turned off is not requested and is
 * recorded as `disabled_by_user`, which never counts as a failed review.
 * Continuity extraction and checking are not listed: they keep the canon.
 */
export const OPTIONAL_REVIEWS = Object.freeze([
  'story-profile-check', 'coherence-judge', 'editorial-quality',
  'character-fidelity', 'reader-hook', 'pattern-ledger',
]);

export async function loadDisabledReviews(store, workId) {
  const policy = await store.loadReviewPolicy?.(workId);
  return (policy?.disabled ?? []).filter((step) => OPTIONAL_REVIEWS.includes(step));
}

export async function saveDisabledReviews(store, workId, disabled) {
  const unknown = disabled.filter((step) => !OPTIONAL_REVIEWS.includes(step));
  if (unknown.length) {
    throw new Error(`INVALID_REVIEW_NAME: ${unknown.join(', ')} — 끌 수 있는 검토: ${OPTIONAL_REVIEWS.join(', ')}`);
  }
  const unique = [...new Set(disabled)];
  await store.saveReviewPolicy(workId, { disabled: unique, updatedAt: new Date().toISOString() });
  return unique;
}
