import { hashLore } from './registry.js';
import { requireLore, LoreError } from './schemas.js';

// A scene map ties manuscript paragraphs to the lock's scenes. It is bound to
// the exact prose hash and production lock, so an edited draft or a rebinding
// can never reuse an old map.
export const LORE_SCENE_MAP_VERSION = 'shared-scene-map-v1';
export const LORE_SCENE_RECORD_VERSION = 'shared-scene-record-v1';

export function loreSceneParagraphs(prose) {
  const paragraphs = [], pattern = /\S[\s\S]*?(?=\r?\n[ \t]*\r?\n|\s*$)/g;
  for (const match of String(prose).matchAll(pattern)) paragraphs.push({ index: paragraphs.length, start: match.index, end: match.index + match[0].length, text: match[0] });
  return paragraphs;
}
export const loreProseHash = prose => hashLore(String(prose));
/** A lock whose chapter has several scenes needs a model-supplied boundary map. */
export const loreSceneMapRequired = lock => lock?.resolverVersion === 'shared-lore-resolver-v2' && lock.scenes.length > 1;

export function loreSceneMapRequest({ lock, prose, names = {} }) {
  return {
    proseHash: loreProseHash(prose), productionLockId: lock.revisionId,
    scenes: lock.scenes.map(scene => ({ sceneId: scene.id, frame: scene.frame, point: `${scene.scope.timelineId}/${scene.scope.pointId}`,
      characters: scene.entityIds.map(entityId => names[entityId] ?? entityId),
      state: scene.projections.map(p => `${names[p.entityId] ?? p.entityId} ${p.target}=${JSON.stringify(p.value)}`) })),
    paragraphs: loreSceneParagraphs(prose).map(({ index, text }) => ({ index, text })),
  };
}

/**
 * Validate the boundary answer. Every paragraph belongs to exactly one scene,
 * scenes appear once each, in the lock's order, as contiguous ranges.
 * An explicit `unresolved` answer is a structured result, never a pass.
 */
export function validateLoreSceneMap({ lock, prose, answer }) {
  const proseHash = loreProseHash(prose), paragraphs = loreSceneParagraphs(prose);
  if (!loreSceneMapRequired(lock)) {
    const segment = { sceneId: lock.scenes[0].id, fromParagraph: 0, toParagraph: Math.max(0, paragraphs.length - 1), start: 0, end: String(prose).length };
    const map = { version: LORE_SCENE_MAP_VERSION, proseHash, productionLockId: lock.revisionId, source: 'single-scene', segments: [segment] };
    return { status: 'mapped', map: { revisionId: hashLore(map), ...map } };
  }
  requireLore(answer && typeof answer === 'object', 'SCENE_MAP_INVALID', 'scene map answer must be an object');
  requireLore(answer.proseHash === proseHash && answer.productionLockId === lock.revisionId, 'STALE_SCENE_MAP', 'scene map answers a different manuscript or production lock', { proseHash, productionLockId: lock.revisionId });
  if (answer.unresolved !== undefined) {
    requireLore(typeof answer.unresolved?.reason === 'string' && answer.unresolved.reason.trim(), 'SCENE_MAP_INVALID', 'unresolved needs a reason');
    return { status: 'unresolved', proseHash, productionLockId: lock.revisionId, reason: answer.unresolved.reason, sceneIds: Array.isArray(answer.unresolved.sceneIds) ? answer.unresolved.sceneIds.filter(id => typeof id === 'string') : [] };
  }
  const segments = answer.segments, problems = [];
  requireLore(Array.isArray(segments), 'SCENE_MAP_INVALID', 'segments required');
  const order = lock.scenes.map(s => s.id), seen = new Set();
  let next = 0;
  for (const [i, segment] of segments.entries()) {
    if (!segment || !order.includes(segment.sceneId)) { problems.push({ code: 'unknown_scene', segment: i }); continue; }
    if (seen.has(segment.sceneId)) problems.push({ code: 'duplicate_scene', sceneId: segment.sceneId });
    seen.add(segment.sceneId);
    if (!Number.isSafeInteger(segment.fromParagraph) || !Number.isSafeInteger(segment.toParagraph) || segment.fromParagraph > segment.toParagraph || segment.toParagraph >= paragraphs.length) { problems.push({ code: 'invalid_range', sceneId: segment.sceneId }); continue; }
    if (segment.fromParagraph < next) problems.push({ code: 'overlap', sceneId: segment.sceneId, paragraph: segment.fromParagraph });
    if (segment.fromParagraph > next) problems.push({ code: 'gap', sceneId: segment.sceneId, paragraphs: [next, segment.fromParagraph - 1] });
    next = Math.max(next, segment.toParagraph + 1);
  }
  const listed = segments.map(s => s?.sceneId).filter(id => order.includes(id));
  if (listed.join('\0') !== order.filter(id => listed.includes(id)).join('\0')) problems.push({ code: 'order', expected: order, actual: listed });
  for (const sceneId of order) if (!seen.has(sceneId)) problems.push({ code: 'missing_scene', sceneId });
  if (next < paragraphs.length) problems.push({ code: 'gap', paragraphs: [next, paragraphs.length - 1] });
  if (problems.length) throw new LoreError('SCENE_MAP_INVALID', 'scene boundaries are missing, overlapping, out of order or incomplete', { problems });
  const normalized = segments.map(s => ({ sceneId: s.sceneId, fromParagraph: s.fromParagraph, toParagraph: s.toParagraph, start: paragraphs[s.fromParagraph].start, end: paragraphs[s.toParagraph].end }));
  const map = { version: LORE_SCENE_MAP_VERSION, proseHash, productionLockId: lock.revisionId, source: 'model', segments: normalized };
  return { status: 'mapped', map: { revisionId: hashLore(map), ...map } };
}
export function verifyLoreSceneMap({ lock, prose, map }) {
  const { revisionId, ...payload } = map ?? {};
  requireLore(hashLore(payload) === revisionId && payload.version === LORE_SCENE_MAP_VERSION, 'LORE_INTEGRITY', 'scene map hash mismatch');
  requireLore(payload.proseHash === loreProseHash(prose) && payload.productionLockId === lock.revisionId, 'STALE_SCENE_MAP', 'scene map belongs to another manuscript or lock');
  const again = validateLoreSceneMap({ lock, prose, answer: payload.source === 'model' ? { proseHash: payload.proseHash, productionLockId: payload.productionLockId, segments: payload.segments } : undefined });
  requireLore(again.map.revisionId === revisionId, 'LORE_INTEGRITY', 'scene map cannot be reproduced');
  return again.map;
}

/**
 * Record which pinned scene state applies to which part of the manuscript.
 * vibelore keeps this record; it does not match words or judge the prose.
 * Whether the text fits each scene's state is the AI review's call, using the
 * per-scene states and source documents in the scene context.
 */
export function recordLoreScenes({ lock, prose, map }) {
  const verified = verifyLoreSceneMap({ lock, prose, map });
  const scenes = verified.segments.map(segment => {
    const scene = lock.scenes.find(s => s.id === segment.sceneId);
    return { sceneId: scene.id, frame: scene.frame, scope: scene.scope, start: segment.start, end: segment.end, paragraphs: [segment.fromParagraph, segment.toParagraph],
      stateIds: scene.stateIds, projections: scene.projections.map(({ localCharacterId, target, value, fieldDefinitionRevisionId, valueIds, evidenceIds }) => ({ localCharacterId, target, value, fieldDefinitionRevisionId, valueIds, evidenceIds })) };
  });
  const result = { version: LORE_SCENE_RECORD_VERSION, productionLockId: lock.revisionId, sceneMapRevisionId: verified.revisionId, proseHash: verified.proseHash, status: 'recorded', scenes };
  return { revisionId: hashLore(result), ...result };
}
