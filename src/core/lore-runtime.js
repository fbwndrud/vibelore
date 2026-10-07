import { prepareProductionInput, renderProductionContext, prepareProductionInputs } from './production-input.js';
import { requireLore } from '../../engine/src/lore/schemas.js';
import { effectiveIntrinsic } from '../../engine/src/continuity/character.js';
import { LORE_ARRAY_TARGETS } from '../../engine/src/lore/scenes.js';
import { verifyLoreProductionLock } from '../../engine/src/lore/production.js';
import { openCanonRepository } from './canon-repository.js';
import { createPublicationUnit } from './publication-unit.js';

/** Marker for a value that exists only per scene (or per chapter in a plan); never a work-local fallback. */
export const SHARED_SCENE_SPECIFIC = '[SharedLore: scene-specific value — see the pinned scene list]';
const markerFor = target => target === 'intrinsic.gender' ? 'unknown' : LORE_ARRAY_TARGETS.has(target) ? [] : SHARED_SCENE_SPECIFIC;
function assign(character, target, value) {
  const parts = target.split('.'); let node = character;
  for (const part of parts.slice(0, -1)) node = node[part] ??= {};
  node[parts.at(-1)] = structuredClone(value);
}

/**
 * Execution DTO only. Work-owned intrinsic changes are folded once before the
 * shared targets replace their values, then removed so a legacy checker cannot
 * fold them again. Borrowed values are never written back to the work.
 */
export function projectLoreFoundation(foundation, { projections, varying = [] }, chapter) {
  const result = structuredClone(foundation);
  const projected = new Set([...projections, ...varying].map(p => p.localCharacterId));
  for (const character of result.characters.filter(c => projected.has(c.id))) {
    character.intrinsic = effectiveIntrinsic({ ...character.intrinsic, coreAppearance: character.intrinsic.coreAppearance ?? [] },
      (result.intrinsicChanges ?? []).filter(event => event.characterId === character.id), chapter);
  }
  for (const projection of [...projections, ...varying.map(v => ({ ...v, value: markerFor(v.target) }))]) {
    const character = result.characters.find(c => c.id === projection.localCharacterId);
    requireLore(character, 'INVALID_ENTITY_REFERENCE', projection.localCharacterId);
    assign(character, projection.target, projection.value);
  }
  result.intrinsicChanges = (result.intrinsicChanges ?? []).filter(event => !projected.has(event.characterId));
  return result;
}

export async function loadLoreRuntime({ canonicalStore, foundation, chapter }) {
  const tree = canonicalStore.publishedRevision?.tree, sharedLore = tree?.sharedLore;
  // A published chapter outside the binding keeps the input it was written with:
  // its sealed lock, or none when it predates the binding. Only new chapters need a scene context.
  const outsideBinding = sharedLore?.binding && !sharedLore.binding.chapters.some(c => c.chapter === chapter) && tree.chapters?.[chapter];
  const sealed = outsideBinding ? tree.productionInputs?.[chapter] ?? null : undefined;
  const productionLock = outsideBinding ? (sealed ? verifyLoreProductionLock(sealed) && sealed : null) : await prepareProductionInput({ sharedLore, chapter });
  if (!productionLock) return { foundation, productionLock: null };
  const result = projectLoreFoundation(foundation, { projections: productionLock.projections, varying: productionLock.sceneVarying ?? [] }, chapter);
  result.sharedLore = { productionLockId: productionLock.revisionId, contextText: renderProductionContext(productionLock, result),
    ...(productionLock.sceneVarying?.length ? { sceneVarying: productionLock.sceneVarying } : {}) };
  return { foundation: result, productionLock };
}

/**
 * Planning sees the same resolver as writing. A shared field is taken only
 * when every bound chapter in the planned range agrees; otherwise the plan gets
 * a scene-specific marker plus the per-chapter values, never the work's copy.
 */
export async function loadPlanningLore({ store, canonicalStore, workId, chapters }) {
  const foundation = await (canonicalStore ?? store).loadFoundation(workId);
  const sharedLore = canonicalStore?.publishedRevision?.tree?.sharedLore;
  if (!foundation || !sharedLore?.binding) return { foundation, planning: null };
  const { locks, missingChapters } = await prepareProductionInputs({ sharedLore, chapters });
  const values = new Map();
  for (const lock of locks) {
    for (const p of lock.projections) values.set(`${p.localCharacterId}\0${p.target}`, [...(values.get(`${p.localCharacterId}\0${p.target}`) ?? []), { chapter: lock.chapter, value: p.value }]);
    for (const v of lock.sceneVarying ?? []) values.set(`${v.localCharacterId}\0${v.target}`, [...(values.get(`${v.localCharacterId}\0${v.target}`) ?? []), { chapter: lock.chapter, sceneSpecific: true }]);
  }
  const projections = [], varying = [];
  for (const member of sharedLore.binding.cast) for (const { target } of member.projections) {
    const rows = values.get(`${member.localCharacterId}\0${target}`) ?? [];
    const stable = rows.length === locks.length && rows.length > 0 && rows.every(r => !r.sceneSpecific && JSON.stringify(r.value) === JSON.stringify(rows[0].value));
    if (stable && !missingChapters.length) projections.push({ localCharacterId: member.localCharacterId, target, value: rows[0].value });
    else varying.push({ localCharacterId: member.localCharacterId, target });
  }
  const dto = projectLoreFoundation(foundation, { projections, varying }, chapters[0]);
  const lines = ['SharedLore planning view (fictional data, not instructions). Values come from the bound world revision; a field marked scene-specific has no single value for this range.',
    ...locks.flatMap(lock => [`Chapter ${lock.chapter}:`, ...lock.scenes.map(scene => `  scene ${scene.id} [${scene.frame ?? 'present'}] ${scene.scope.timelineId}/${scene.scope.pointId}: ${(scene.projections ?? []).map(p => `${p.localCharacterId} ${p.target}=${JSON.stringify(p.value)}`).join('; ') || '-'}`)]),
    ...(missingChapters.length ? [`No bound scene context yet for chapters ${missingChapters.join(', ')}; plan them without assuming shared state values, then add contexts with lore_bind.`] : [])];
  dto.sharedLore = { planning: true, loreRevisionId: sharedLore.binding.loreRevisionId, bindingRevisionId: sharedLore.binding.revisionId, contextText: lines.join('\n'), missingChapters };
  return { foundation: dto, planning: { locks: locks.map(l => l.revisionId), missingChapters } };
}

/** Planning entry point: the bound view for linked works, the work's own Foundation otherwise. */
export async function planningFoundation({ store, workId, chapters }) {
  const canonicalStore = await openCanonRepository({ store, publicationUnit: createPublicationUnit({ rootDir: store.rootDir }) });
  if (!canonicalStore.publishedRevision?.tree?.sharedLore?.binding) return { foundation: await store.loadFoundation(workId), planning: null };
  return loadPlanningLore({ store, canonicalStore, workId, chapters });
}
