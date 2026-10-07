import { hashLore } from './registry.js';
import { requireLore, LoreError } from './schemas.js';

// A scene map ties manuscript paragraphs to the lock's scenes. It is bound to
// the exact prose hash and production lock, so an edited draft or a rebinding
// can never reuse an old map.
export const LORE_SCENE_MAP_VERSION = 'shared-scene-map-v1';
export const LORE_SCENE_CHECK_VERSION = 'shared-scene-check-v1';

export function loreSceneParagraphs(prose) {
  const paragraphs = [], pattern = /\S[\s\S]*?(?=\n[ \t]*\n|\s*$)/g;
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

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A term starts at a word boundary. Korean/Japanese/Chinese particles attach
// directly (도련님이라), so a term ending in those scripts may be followed by letters.
const ATTACHING = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;
const occurrences = (text, term) => [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}${ATTACHING.test(term) ? '' : '(?![\\p{L}\\p{N}])'}`, 'gu'))].map(m => m.index);
const projection = (scene, localCharacterId, target) => scene.projections.find(p => p.localCharacterId === localCharacterId && p.target === target);

/**
 * Deterministic per-scene checks over explicitly projected addressing data.
 * Body form or gender is never turned into an expected honorific, pronoun or
 * self-identity; only the author's forbidden/accepted term lists are compared.
 */
export function checkLoreScenes({ lock, prose, map, chapter = null }) {
  const verified = verifyLoreSceneMap({ lock, prose, map });
  const violations = [], scenes = [];
  for (const segment of verified.segments) {
    const scene = lock.scenes.find(s => s.id === segment.sceneId), text = String(prose).slice(segment.start, segment.end), found = [];
    const members = [...new Set(scene.projections.map(p => p.localCharacterId))];
    for (const localCharacterId of members) {
      const forbidden = projection(scene, localCharacterId, 'intrinsic.addressing.forbiddenGenderedTerms');
      if (!forbidden) continue;
      for (const term of forbidden.value) {
        for (const at of occurrences(text, term)) {
          const acceptedBy = members.filter(other => other !== localCharacterId && projection(scene, other, 'intrinsic.addressing.acceptedGenderedTerms')?.value.includes(term));
          const violation = { severity: acceptedBy.length ? 'soft' : 'hard', code: acceptedBy.length ? 'SHARED_SCENE_TERM_AMBIGUOUS' : 'SHARED_SCENE_FORBIDDEN_TERM',
            ...(chapter !== null ? { chapterNumber: chapter } : {}), sceneId: scene.id, frame: scene.frame, scope: scene.scope,
            characterId: localCharacterId, entityId: forbidden.entityId, term, span: { start: segment.start + at, end: segment.start + at + term.length },
            fieldId: forbidden.fieldId, fieldDefinitionRevisionId: forbidden.fieldDefinitionRevisionId, valueIds: forbidden.valueIds, evidenceIds: forbidden.evidenceIds,
            stateIds: scene.stateIds[forbidden.entityId] ?? [],
            message: acceptedBy.length
              ? `장면 ${scene.id}: '${term}'은 ${localCharacterId}에게 금지, ${acceptedBy.join(', ')}에게 허용된 호칭이라 대상이 모호합니다.`
              : `장면 ${scene.id}(${scene.scope.timelineId}/${scene.scope.pointId}): ${localCharacterId}의 이 시점 상태는 '${term}'을 금지합니다 (state ${(scene.stateIds[forbidden.entityId] ?? []).join(', ') || '-'}, evidence ${forbidden.evidenceIds.join(', ')}).` };
          found.push(violation);
        }
      }
    }
    violations.push(...found);
    scenes.push({ sceneId: scene.id, frame: scene.frame, scope: scene.scope, start: segment.start, end: segment.end, paragraphs: [segment.fromParagraph, segment.toParagraph],
      stateIds: scene.stateIds, projections: scene.projections.map(({ localCharacterId, target, value, fieldDefinitionRevisionId, valueIds, evidenceIds }) => ({ localCharacterId, target, value, fieldDefinitionRevisionId, valueIds, evidenceIds })),
      status: found.some(v => v.severity === 'hard') ? 'failed' : 'passed' });
  }
  const result = { version: LORE_SCENE_CHECK_VERSION, productionLockId: lock.revisionId, sceneMapRevisionId: verified.revisionId, proseHash: verified.proseHash,
    status: violations.some(v => v.severity === 'hard') ? 'failed' : 'passed', scenes, violations };
  return { revisionId: hashLore(result), ...result };
}
