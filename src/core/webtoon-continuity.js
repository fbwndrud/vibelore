import { digest, nonempty, planShots, safeId } from './webtoon-contract.js';

// Production blocking is separate from canonical story and approved dialogue.
export function validateContinuity(plan, production) {
  const shots = planShots(plan), order = new Map(shots.map((s, i) => [s.id, i]));
  if (![1, 2].includes(production?.version) || !Array.isArray(production.scenes) || !production.scenes.length || !Array.isArray(production.shots) || !production.shots.length) throw new Error('INVALID_CONTINUITY_PLAN');
  const scenes = new Map();
  for (const scene of production.scenes) {
    if (!safeId(scene.id) || scenes.has(scene.id) || !nonempty(scene.environmentId) || !nonempty(scene.layout) || !nonempty(scene.cameraAxis)) throw new Error('CONTINUITY_SCENE_REQUIRED');
    scenes.set(scene.id, scene);
  }
  const entries = new Map();
  for (const entry of production.shots) {
    const shot = shots[order.get(entry.shotId)], scene = scenes.get(entry.sceneId);
    if (!shot || entries.has(entry.shotId) || !scene || scene.environmentId !== shot.environmentId || !['reset', 'continue', 'cut'].includes(entry.transition)) throw new Error('CONTINUITY_SHOT_INVALID');
    if (entry.background !== undefined && !['establish', 'partial', 'abstract'].includes(entry.background)) throw new Error('CONTINUITY_BACKGROUND_INVALID');
    if (entry.visibleCharacters !== undefined && (!Array.isArray(entry.visibleCharacters) || new Set(entry.visibleCharacters).size !== entry.visibleCharacters.length || entry.visibleCharacters.some(id => !shot.characters?.includes(id)))) throw new Error('CONTINUITY_CAST_INVALID');
    if (!['blocking', 'camera', 'before', 'after', 'change', 'decisiveMoment'].every(key => nonempty(entry[key]))) throw new Error('CONTINUITY_TRANSITION_REQUIRED');
    entries.set(entry.shotId, entry);
  }
  for (const entry of production.shots) {
    const dependencies = [entry.previousShotId, entry.anchorShotId].filter(Boolean);
    if (entry.transition === 'reset' && dependencies.length || ['continue', 'cut'].includes(entry.transition) && !entry.previousShotId) throw new Error('CONTINUITY_RESET_OR_PREVIOUS_REQUIRED');
    for (const id of dependencies) {
      const prior = entries.get(id);
      if (!prior || order.get(id) >= order.get(entry.shotId) || scenes.get(prior.sceneId).environmentId !== scenes.get(entry.sceneId).environmentId) throw new Error('CONTINUITY_FORWARD_OR_CROSS_LOCATION_REFERENCE');
    }
    if (production.version === 2 && entry.transition === 'reset' && order.get(entry.shotId) > 0 && !nonempty(entry.resetReason)) throw new Error('CONTINUITY_RESET_REASON_REQUIRED');
    if (production.version === 2 && entry.transition !== 'reset' && entry.previousShotId !== shots[order.get(entry.shotId) - 1]?.id) throw new Error('CONTINUITY_ADJACENT_PREVIOUS_REQUIRED');
  }
  if (production.version === 2 && shots.some(s => !entries.has(s.id))) throw new Error('CONTINUITY_FULL_COVERAGE_REQUIRED');
  if (production.version === 2 && production.shots.some((s, i) => s.shotId !== shots[i].id)) throw new Error('CONTINUITY_READING_ORDER_REQUIRED');
  if (production.version === 2 && production.scenes.some(s => production.shots.filter(e => e.sceneId === s.id).length > 6)) throw new Error('STORYBOARD_CHUNK_MAX_SIX: 긴 장면은 동선과 previousShotId를 유지하며 최대 6컷 묶음으로 나누세요.');
  if (production.version === 2) {
    const runs = production.shots.filter((s, i) => i === 0 || s.sceneId !== production.shots[i - 1].sceneId).map(s => s.sceneId);
    if (new Set(runs).size !== runs.length) throw new Error('STORYBOARD_CHUNKS_MUST_BE_CONTIGUOUS');
  }
  for (const id of scenes.keys()) if (!production.shots.some(s => s.sceneId === id)) throw new Error('CONTINUITY_EMPTY_SCENE');
  return production;
}

export const continuityEntry = (w, id) => w.continuity?.plan.shots.find(s => s.shotId === id);
export const continuityScene = (w, id) => w.continuity?.plan.scenes.find(s => s.id === id);
export const storyboardMode = w => w.continuity?.plan.version === 2;
export const roughBinding = (w, sceneId) => digest({ plan: storyboardMode(w) ? {
  version: 2, scene: continuityScene(w, sceneId), shots: w.continuity.plan.shots.filter(s => s.sceneId === sceneId),
  incoming: w.continuity.plan.shots.filter(s => s.sceneId === sceneId && s.previousShotId).map(s => continuityEntry(w, s.previousShotId)),
  script: planShots(w.plan).filter(s => w.continuity.plan.shots.some(e => e.sceneId === sceneId && e.shotId === s.id)),
  feedback: w.continuity.feedback?.[sceneId] ?? null,
} : w.continuity.plan, sceneId, source: w.source.hash, policy: w.imagePolicy,
  refs: Object.values(w.references ?? {}).map(r => r.image.hash) });
export const reviewed = (entry, hash) => entry?.hash === hash && entry.inspectedImages === true && entry.passed === true && nonempty(entry.evidence);
export function roughReviewContext(w, sceneId) {
  const scenes = [...new Set([sceneId, ...w.continuity.plan.shots.filter(s => s.sceneId === sceneId && s.previousShotId)
    .map(s => continuityEntry(w, s.previousShotId).sceneId)])];
  if (scenes.some(id => !w.continuity.roughs[id])) return null;
  return digest(scenes.map(id => [id, w.continuity.roughs[id].image.hash, w.continuity.roughs[id].inputHash]));
}
export const roughReviewed = (w, sceneId) => !!w.continuity.roughs[sceneId]
  && reviewed(w.continuity.roughReviews[sceneId], w.continuity.roughs[sceneId].image.hash)
  && (!storyboardMode(w) || !!roughReviewContext(w, sceneId) && w.continuity.roughReviews[sceneId].contextHash === roughReviewContext(w, sceneId));

// Causal order is not a request to copy the previous finished camera angle.
export const visualDependencies = (w, entry) => [...new Set([
  ...(!storyboardMode(w) || entry.transition === 'continue' ? [entry.previousShotId] : []), entry.anchorShotId,
].filter(Boolean))];
export const storyboardSubject = w => ({ planHash: digest(w.continuity.plan), scriptHash: digest(w.plan), sourceHash: w.source.hash,
  contractDigest: w.contract.digest, roughs: w.continuity.plan.scenes.map(s => ({ sceneId: s.id,
    inputHash: roughBinding(w, s.id), hash: w.continuity.roughs[s.id]?.image.hash ?? null })) });
export const storyboardApproved = w => storyboardMode(w) && w.continuity.approval?.hash === digest(storyboardSubject(w));

export function transitionChecks(w) {
  if (!storyboardMode(w)) return [];
  return w.continuity.plan.shots.filter(s => s.previousShotId).map(s => {
    const from = w.images[s.previousShotId], to = w.images[s.shotId];
    const id = s.shotId;
    const hash = digest({ from: [s.previousShotId, from?.hash ?? null], to: [id, to?.hash ?? null],
      before: continuityEntry(w, s.previousShotId), after: s });
    return { id, from: s.previousShotId, to: id, hash,
      ready: !!from && !!to, passed: !!from && !!to && reviewed(w.continuity.transitionReviews?.[id], hash),
      images: [from?.continuityPath, to?.continuityPath].filter(Boolean),
      instruction: '두 실제 그림만 보고 위치·시선·이동·접촉·결과가 연결되는지 확인한다. 원작이나 프롬프트로 빠진 동작을 상상해 통과시키지 않는다.' };
  });
}

export function validateStoryboardReview(w, review) {
  if (!storyboardMode(w)) return;
  if (review.kind === 'shot') {
    if (!['clear', 'unclear', 'contradiction'].includes(review.composition?.verdict) || !nonempty(review.composition?.evidence)
      || review.passed && review.composition.verdict !== 'clear') throw new Error('STORYBOARD_COMPOSITION_REVIEW_REQUIRED');
  } else if (review.kind === 'rough') {
    if (!roughReviewContext(w, review.id) || review.contextHash !== roughReviewContext(w, review.id)) throw new Error('STALE_STORYBOARD_CONTEXT');
    const shots = w.continuity.plan.shots.filter(s => s.sceneId === review.id);
    const checks = (rows, expected, key) => Array.isArray(rows) && rows.length === expected.length
      && new Set(rows.map(key)).size === rows.length && expected.every(id => rows.some(r => key(r) === id))
      && rows.every(r => ['clear', 'unclear', 'contradiction'].includes(r.verdict) && nonempty(r.evidence) && (!review.passed || r.verdict === 'clear'));
    if (!checks(review.observations, shots.map(s => s.shotId), r => r.shotId)
      || !checks(review.transitions, shots.filter(s => s.previousShotId).map(s => `${s.previousShotId}:${s.shotId}`), r => `${r.from}:${r.to}`)) throw new Error('STORYBOARD_ROUGH_EVIDENCE_REQUIRED');
  }
}

export function continuityInput(w, shotId) {
  const entry = continuityEntry(w, shotId);
  if (!entry) return null;
  const rough = w.continuity.roughs[entry.sceneId];
  const dependencies = visualDependencies(w, entry);
  const referenceImages = dependencies.filter(id => w.images[id] && (entry.transition !== 'cut' || id === entry.anchorShotId)).map(id => ({
    referenceId: `continuity-${id}`, role: id === entry.previousShotId ? 'previous-shot' : 'scene-anchor', subjectId: id,
    path: w.images[id].continuityPath, hash: w.images[id].hash,
  }));
  const blocked = [];
  if (storyboardMode(w)) {
    if (!storyboardApproved(w)) blocked.push('storyboard:approval');
    const sceneShots = w.continuity.plan.shots.filter(s => s.sceneId === entry.sceneId);
    if (rough) referenceImages.push({ referenceId: `storyboard-${entry.sceneId}`, role: 'storyboard', subjectId: entry.sceneId,
      shotId, panelIndex: sceneShots.findIndex(s => s.shotId === shotId) + 1, path: rough.path, hash: rough.image.hash,
      purpose: '이 번호의 러프 구도를 유지하여 한 컷만 완성한다. 외형·화풍은 character 참조, 구도·동선은 storyboard 참조.' });
  }
  if (!rough || rough.inputHash !== roughBinding(w, entry.sceneId) || !roughReviewed(w, entry.sceneId)) blocked.push(`rough:${entry.sceneId}`);
  for (const id of dependencies) if (!w.images[id] || !reviewed(w.continuity.shotReviews[id], w.images[id].hash)) blocked.push(`shot:${id}`);
  return { entry, scene: continuityScene(w, entry.sceneId), roughHash: rough?.image.hash ?? null,
    ...(storyboardMode(w) ? { causalPrevious: entry.previousShotId ? continuityEntry(w, entry.previousShotId) : null } : {}),
    referenceImages, blocked, binding: digest({ plan: storyboardMode(w) ? continuityScene(w, entry.sceneId) : w.continuity.plan,
      entry, rough: rough?.image.hash ?? null, ...(storyboardMode(w) ? { causalPrevious: entry.previousShotId ? continuityEntry(w, entry.previousShotId) : null } : {}),
      dependencies: dependencies.map(id => [id, w.images[id]?.hash ?? null]) }) };
}

// Preserve reviewed, byte-identical scenes when only another scene is reblocked.
export function reconfigureContinuity(w, plan) {
  const old = w.continuity;
  const reusable = new Set(plan.scenes.filter(scene => {
    const rough = old?.roughs[scene.id];
    return old?.plan.version === plan.version && rough && rough.inputHash === roughBinding(w, scene.id) && roughReviewed(w, scene.id)
      && (!storyboardMode(w) || roughBinding(w, scene.id) === roughBinding({ ...w, continuity: { plan, feedback: old.feedback } }, scene.id))
      && digest(scene) === digest(old.plan.scenes.find(s => s.id === scene.id))
      && digest(plan.shots.filter(s => s.sceneId === scene.id)) === digest(old.plan.shots.filter(s => s.sceneId === scene.id));
  }).map(s => s.id));
  const affected = continuityDescendants(w, [...(old?.plan.shots ?? []), ...plan.shots].filter(s => !reusable.has(s.sceneId)).map(s => s.shotId));
  const next = { plan, roughs: {}, roughReviews: {}, shotReviews: {}, transitionReviews: {}, ...(plan.version === 2 ? { feedback: old?.feedback ?? {} } : {}) };
  for (const id of reusable) {
    next.roughs[id] = { ...old.roughs[id], inputHash: roughBinding({ ...w, continuity: next }, id) };
    next.roughReviews[id] = old.roughReviews[id];
  }
  for (const s of plan.shots) if (!affected.includes(s.shotId) && old?.shotReviews[s.shotId]) next.shotReviews[s.shotId] = old.shotReviews[s.shotId];
  for (const s of plan.shots) if (!affected.includes(s.shotId) && !affected.includes(s.previousShotId) && old?.transitionReviews?.[s.shotId]) next.transitionReviews[s.shotId] = old.transitionReviews[s.shotId];
  if (old?.approval && digest(old.plan) === digest(plan)) next.approval = old.approval;
  return { affected, next };
}

export function continuityDescendants(w, ids) {
  const affected = new Set(ids);
  let changed;
  do {
    changed = false;
    for (const entry of w.continuity?.plan.shots ?? []) if (!affected.has(entry.shotId) && visualDependencies(w, entry).some(id => affected.has(id))) {
      affected.add(entry.shotId); changed = true;
    }
  } while (changed);
  return [...affected];
}

export function continuityStatus(w) {
  if (!w.continuity) return null;
  return { version: w.continuity.plan.version, planHash: digest(w.continuity.plan), scenes: w.continuity.plan.scenes,
    ...(storyboardMode(w) ? { storyboardApproved: storyboardApproved(w), approval: w.continuity.approval ?? null, transitions: transitionChecks(w) } : {}),
    roughs: Object.entries(w.continuity.roughs).map(([sceneId, r]) => ({ sceneId, path: r.path, hash: r.image.hash, review: w.continuity.roughReviews[sceneId] ?? null })),
    shots: w.continuity.plan.shots.map(s => ({ shotId: s.shotId, sceneId: s.sceneId, transition: s.transition, previousShotId: s.previousShotId,
      imageHash: w.images[s.shotId]?.hash, review: w.continuity.shotReviews[s.shotId] ?? null, blockedBy: continuityInput(w, s.shotId).blocked })),
    reviewProvenance: 'host-reported; not independent verification' };
}
