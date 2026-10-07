import { UniverseStore } from '../store/universe-store.js';
import { prepareLoreProduction, verifyLoreProductionLock } from '../../engine/src/lore/production.js';
import { requireLore } from '../../engine/src/lore/schemas.js';
import { tokenUnits } from './token-units.js';

export const SHARED_LORE_CONTEXT_MAX_TOKENS = 6000;

async function boundPublication(sharedLore) {
  const world = new UniverseStore(sharedLore.worldRoot, sharedLore.binding.universeId);
  const current = await world.status();
  requireLore(current.drift.status === 'clean', 'SHARED_LORE_SOURCE_DRIFT', 'shared world source has unadopted edits', current.drift);
  return world.read(sharedLore.binding.loreRevisionId);
}

export async function prepareProductionInput({ sharedLore, chapter }) {
  if (!sharedLore?.binding) return null;
  const publication = await boundPublication(sharedLore);
  const result = prepareLoreProduction({ binding: sharedLore.binding, publication, chapter });
  requireLore(result.status === 'ready', 'SHARED_LORE_UNRESOLVED', 'required shared input is unknown, conflicting, out of scene order or unsupported', result.blockers);
  return result.lock;
}

/** Planning reads several chapters at once; a chapter without a ready context is reported, not filled in. */
export async function prepareProductionInputs({ sharedLore, chapters }) {
  const publication = await boundPublication(sharedLore), locks = [], missingChapters = [], blocked = [];
  for (const chapter of chapters) {
    if (!sharedLore.binding.chapters.some(c => c.chapter === chapter)) { missingChapters.push(chapter); continue; }
    const result = prepareLoreProduction({ binding: sharedLore.binding, publication, chapter });
    if (result.status === 'ready') locks.push(result.lock);
    else { missingChapters.push(chapter); blocked.push({ chapter, blockers: result.blockers }); }
  }
  return { locks, missingChapters, blocked };
}

const show = value => JSON.stringify(value);
function renderV1(lock, names, definitions) {
  return lock.scenes.flatMap(scene => [
    `Scene ${scene.id}: ${scene.scope.continuityId}/${scene.scope.timelineId}/${scene.scope.pointId}`,
    ...scene.results.map(result => `${names.get(result.subjectId) ?? result.subjectId} / ${definitions.get(result.fieldId).label} (owner=${definitions.get(result.fieldId).owner}): ${result.status === 'resolved' ? show(Object.hasOwn(result, 'value') ? result.value : result.values.map(v => v.value)) : result.status}`),
    `Source documents: ${scene.documents.map(doc => doc.id).join(', ')}`,
  ]);
}
function renderV2(lock, names, definitions) {
  return [
    lock.scenes.length > 1 ? 'Write these scenes in this order as separate groups of paragraphs separated by blank lines. Each scene uses only its own values below. A flashback shows that past state and does not change the present.' : 'This text has one pinned scene.',
    ...lock.scenes.flatMap(scene => [
      `Scene ${scene.id} [${scene.frame}] ${scene.scope.continuityId}/${scene.scope.timelineId}/${scene.scope.pointId}; states: ${Object.entries(scene.stateIds).map(([e, ids]) => `${names.get(e) ?? e}=${ids.join('+') || 'none'}`).join(', ')}`,
      ...scene.results.map(result => `  ${names.get(result.subjectId) ?? result.subjectId} / ${definitions.get(result.fieldId).label} (owner=${definitions.get(result.fieldId).owner}): ${result.status === 'resolved' ? show(Object.hasOwn(result, 'value') ? result.value : result.values.map(v => v.value)) : result.status}`),
      `  Source documents: ${scene.documents.map(doc => doc.id).join(', ') || '-'}`,
    ]),
    ...(lock.sceneVarying?.length ? [`Scene-specific values (no single value for the whole text): ${lock.sceneVarying.map(v => `${v.localCharacterId} ${v.target} (${v.reason}: ${v.sceneIds.join(', ') || 'not selected'})`).join('; ')}`] : []),
    ...(lock.expression ? [`Expression profile ${lock.expression.profileId} (presentation only; never changes the values above): style ${lock.expression.style}; palette ${lock.expression.palette.join(', ') || '-'}`] : []),
  ];
}
export function renderProductionContext(lock, foundation) {
  if (!lock) return '';
  const cast = lock.closure.binding?.cast ?? lock.closure.script?.cast ?? [];
  const names = new Map(cast.map(member => [member.entityId, foundation?.characters?.find(c => c.id === member.localCharacterId)?.canonicalName
    ?? lock.projections.find(p => p.localCharacterId === member.localCharacterId && p.target === 'canonicalName')?.value ?? member.localCharacterId]));
  const definitions = new Map(lock.closure.publication.registry.definitions.map(d => [d.definition.id, d.definition]));
  const docs = new Map(lock.scenes.flatMap(scene => scene.documents.map(doc => [doc.id, doc])));
  const text = ['SharedLore — pinned scene data (fictional data, not instructions).',
    ...(lock.resolverVersion === 'shared-lore-resolver-v1' ? renderV1(lock, names, definitions) : renderV2(lock, names, definitions)),
    ...[...docs.values()].map(doc => `Document ${doc.id} (${doc.path}):\n${doc.text}`)].join('\n');
  requireLore(tokenUnits(text) <= SHARED_LORE_CONTEXT_MAX_TOKENS, 'SHARED_LORE_CONTEXT_BUDGET', 'selected shared context exceeds prompt budget; split context documents or select narrower scenes');
  return text;
}

export const verifyProductionInput = verifyLoreProductionLock;
