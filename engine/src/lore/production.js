import { validateLoreRevision, loreStateApplies } from './changes.js';
import { hashLore, encodeLore, isLoreRevisionId } from './registry.js';
import { requireLore, validateShape, LORE_ID_SCHEMA } from './schemas.js';
import { LORE_PROJECTION_TARGETS, LORE_ARRAY_TARGETS, validateLoreCast, validateLoreScenes, validateLoreProjections, resolveLoreScenes, checkLorePublication, lorePublicationClosure } from './scenes.js';
import { verifyLoreScriptLock } from './script.js';

// v1 is frozen: published locks and in-progress receipts keep their exact
// identity. Binding schemaVersion 2 opts into the scene resolver (v2).
export const LORE_RESOLVER_VERSION = 'shared-lore-resolver-v1';
export const LORE_RESOLVER_VERSION_V2 = 'shared-lore-resolver-v2';
export const LORE_RESOLVER_VERSIONS = Object.freeze([LORE_RESOLVER_VERSION, LORE_RESOLVER_VERSION_V2]);
export { LORE_PROJECTION_TARGETS };
const arrayTargets = LORE_ARRAY_TARGETS;
const id = (v, p) => validateShape(LORE_ID_SCHEMA, v, p);
const closed = (value, allowed, required, path) => requireLore(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(value, k)), 'INVALID_LORE_DATA', `invalid ${path}`);
export function createWorkBinding(input) {
  if (input?.schemaVersion === 2) return createWorkBindingV2(input);
  closed(input, ['schemaVersion', 'workId', 'universeId', 'loreRevisionId', 'registryRevisionId', 'continuityId', 'cast', 'chapters'], ['schemaVersion', 'workId', 'universeId', 'loreRevisionId', 'registryRevisionId', 'continuityId', 'cast', 'chapters'], 'binding');
  requireLore(input.schemaVersion === 1 && isLoreRevisionId(input.loreRevisionId) && isLoreRevisionId(input.registryRevisionId), 'INVALID_LORE_DATA', 'invalid binding versions');
  for (const key of ['workId', 'universeId', 'continuityId']) id(input[key], key);
  requireLore(Array.isArray(input.cast) && Array.isArray(input.chapters) && input.cast.length <= 1000 && input.chapters.length > 0 && input.chapters.length <= 20000, 'INVALID_LORE_DATA', 'invalid binding cast/chapters');
  const localIds = new Set(), entityIds = new Set(), chapters = new Set(), sceneIds = new Set();
  for (const member of input.cast) {
    closed(member, ['localCharacterId', 'entityId', 'projections'], ['localCharacterId', 'entityId', 'projections'], 'binding cast');
    id(member.localCharacterId, 'localCharacterId'); id(member.entityId, 'entityId');
    requireLore(!localIds.has(member.localCharacterId) && !entityIds.has(member.entityId) && Array.isArray(member.projections), 'INVALID_LORE_DATA', 'duplicate binding cast');
    localIds.add(member.localCharacterId); entityIds.add(member.entityId);
    const targets = new Set();
    for (const projection of member.projections) {
      closed(projection, ['target', 'fieldId'], ['target', 'fieldId'], 'projection'); id(projection.fieldId, 'fieldId');
      requireLore(LORE_PROJECTION_TARGETS.includes(projection.target) && !targets.has(projection.target), 'REQUIRED_CAPABILITY', `unsupported or duplicate projection ${projection.target}`); targets.add(projection.target);
    }
  }
  for (const chapter of input.chapters) {
    closed(chapter, ['chapter', 'scenes'], ['chapter', 'scenes'], 'chapter contexts');
    requireLore(Number.isSafeInteger(chapter.chapter) && chapter.chapter > 0 && !chapters.has(chapter.chapter) && Array.isArray(chapter.scenes) && chapter.scenes.length > 0 && chapter.scenes.length <= 200, 'INVALID_LORE_DATA', 'invalid or duplicate chapter'); chapters.add(chapter.chapter);
    for (const scene of chapter.scenes) {
      closed(scene, ['id', 'scope', 'entityIds', 'requirements'], ['id', 'scope', 'entityIds', 'requirements'], 'scene'); id(scene.id, 'sceneId');
      requireLore(!sceneIds.has(scene.id) && Array.isArray(scene.entityIds) && new Set(scene.entityIds).size === scene.entityIds.length && Array.isArray(scene.requirements), 'INVALID_LORE_DATA', 'invalid scene selection'); sceneIds.add(scene.id);
      scene.entityIds.forEach(entityId => id(entityId, 'entityId'));
      closed(scene.scope, ['continuityId', 'timelineId', 'pointId', 'observerId', 'occurrenceId'], ['continuityId', 'timelineId', 'pointId'], 'scene scope');
      requireLore(scene.scope.continuityId === input.continuityId, 'INVALID_STORY_SCOPE', scene.id);
      Object.values(scene.scope).forEach(value => id(value, 'scope ID'));
      const requirements = new Set();
      for (const r of scene.requirements) {
        closed(r, ['entityId', 'fieldId', 'required'], ['entityId', 'fieldId', 'required'], 'scene requirement');
        id(r.fieldId, 'fieldId');
        requireLore(scene.entityIds.includes(r.entityId) && typeof r.required === 'boolean' && !requirements.has(`${r.entityId}\0${r.fieldId}`), 'INVALID_LORE_DATA', 'invalid or duplicate requirement'); requirements.add(`${r.entityId}\0${r.fieldId}`);
      }
    }
  }
  const payload = JSON.parse(encodeLore(input));
  return { revisionId: hashLore(payload), ...payload };
}
function createWorkBindingV2(input) {
  const keys = ['schemaVersion', 'workId', 'universeId', 'loreRevisionId', 'registryRevisionId', 'continuityId', 'cast', 'chapters'];
  closed(input, keys, keys, 'binding');
  requireLore(isLoreRevisionId(input.loreRevisionId) && isLoreRevisionId(input.registryRevisionId), 'INVALID_LORE_DATA', 'invalid binding versions');
  for (const key of ['workId', 'universeId', 'continuityId']) id(input[key], key);
  validateLoreCast(input.cast);
  requireLore(Array.isArray(input.chapters) && input.chapters.length > 0 && input.chapters.length <= 20000, 'INVALID_LORE_DATA', 'invalid binding chapters');
  const chapters = new Set(), sceneIds = new Set();
  for (const chapter of input.chapters) {
    closed(chapter, ['chapter', 'scenes'], ['chapter', 'scenes'], 'chapter contexts');
    requireLore(Number.isSafeInteger(chapter.chapter) && chapter.chapter > 0 && !chapters.has(chapter.chapter), 'INVALID_LORE_DATA', 'invalid or duplicate chapter'); chapters.add(chapter.chapter);
    validateLoreScenes(chapter.scenes, { continuityId: input.continuityId, sceneIds });
  }
  const payload = JSON.parse(encodeLore(input));
  return { revisionId: hashLore(payload), ...payload };
}
export function validateWorkBinding(binding) {
  const { revisionId, ...payload } = binding;
  const normalized = createWorkBinding(payload);
  requireLore(normalized.revisionId === revisionId, 'LORE_INTEGRITY', 'binding hash mismatch');
  return normalized;
}


/** Creates a self-contained lock, so old inputs survive world edits or relocation. */
export function prepareLoreProduction({ binding, publication, chapter }) {
  if (binding?.schemaVersion === 2) return prepareLoreProductionV2({ binding, publication, chapter });
  validateWorkBinding(binding);
  const { registry, revision, publicationId } = publication;
  requireLore(publication.manifest && hashLore(publication.manifest) === publicationId && hashLore(publication.manifest.revision) === hashLore(revision), 'LORE_INTEGRITY', 'lore publication manifest mismatch');
  requireLore(binding.loreRevisionId === publicationId && binding.registryRevisionId === registry.revisionId && binding.universeId === revision.universeId, 'LORE_INTEGRITY', 'binding does not match lore publication');
  const { resolver, documents, entities, definitions } = validateLoreRevision({ registry, revision });
  const context = binding.chapters.find(c => c.chapter === chapter);
  requireLore(context, 'SHARED_SCENE_CONTEXT_MISSING', `chapter ${chapter}`);
  for (const member of binding.cast) {
    requireLore(entities.has(member.entityId), 'INVALID_ENTITY_REFERENCE', member.entityId);
    for (const p of member.projections) {
      const definition = definitions.definition(p.fieldId)?.definition;
      requireLore(definition?.kind === 'field' && definition.subjectTypeIds.includes(definitions.definitionAt(entities.get(member.entityId).typeDefinitionRevisionId).definition.id)
        && (arrayTargets.has(p.target) ? definition.valueType.kind === 'text' && definition.cardinality === 'many' : ['text', 'enum'].includes(definition.valueType.kind) && definition.cardinality === 'one'), 'INVALID_LORE_PROJECTION', p.target);
    }
  }
  const blockers = [], projected = new Map(), scenes = [];
  for (const scene of context.scenes) {
    const timeline = revision.content.timelines.find(t => t.id === scene.scope.timelineId);
    requireLore(timeline?.continuityId === binding.continuityId && timeline.pointIds.includes(scene.scope.pointId), 'INVALID_STORY_SCOPE', scene.id);
    const selectedDocs = new Map(), results = new Map();
    const include = ids => ids.forEach(docId => { const doc = documents.get(docId); if (doc.visibility === 'context') selectedDocs.set(docId, doc); });
    include(revision.content.worldDocumentIds);
    for (const entityId of scene.entityIds) {
      requireLore(entities.has(entityId), 'INVALID_ENTITY_REFERENCE', entityId);
      include(entities.get(entityId).documentIds);
      for (const state of revision.content.states.filter(state => state.entityId === entityId && loreStateApplies(state, scene.scope, revision.content.timelines))) include(state.documentIds);
    }
    const requests = [...scene.requirements, ...binding.cast.filter(c => scene.entityIds.includes(c.entityId)).flatMap(c => c.projections.map(p => ({ entityId: c.entityId, fieldId: p.fieldId, required: true })))];
    for (const r of requests) {
      const token = `${r.entityId}\0${r.fieldId}`;
      if (!results.has(token)) results.set(token, resolver.resolve({ subjectId: r.entityId, fieldId: r.fieldId, scope: scene.scope }));
      const result = results.get(token);
      if (result.status !== 'resolved' && (r.required || ['conflict', 'incomplete'].includes(result.status))) blockers.push({ sceneId: scene.id, ...r, status: result.status });
    }
    for (const member of binding.cast.filter(c => scene.entityIds.includes(c.entityId))) {
      for (const p of member.projections) {
        const result = results.get(`${member.entityId}\0${p.fieldId}`);
        if (result.status !== 'resolved') continue;
        const value = arrayTargets.has(p.target) ? result.values.map(v => v.value) : result.value;
        const token = `${member.localCharacterId}\0${p.target}`;
        requireLore(p.target !== 'canonicalName' || value.trim().length > 0, 'INVALID_LORE_PROJECTION', 'empty canonical name');
        if (projected.has(token) && hashLore(projected.get(token).value) !== hashLore(value)) blockers.push({ sceneId: scene.id, status: 'requires_scene_checker', localCharacterId: member.localCharacterId, target: p.target });
        projected.set(token, { localCharacterId: member.localCharacterId, target: p.target, value });
      }
    }
    scenes.push({ id: scene.id, scope: scene.scope, entityIds: scene.entityIds, results: [...results.values()], documents: [...selectedDocs.values()] });
  }
  if (blockers.length) return { status: 'unresolved', blockers };
  const payload = JSON.parse(encodeLore({ schemaVersion: 1, resolverVersion: LORE_RESOLVER_VERSION, workId: binding.workId, chapter,
    bindingRevisionId: binding.revisionId, loreRevisionId: publicationId, registryRevisionId: registry.revisionId,
    scenes, projections: [...projected.values()], closure: { binding, publication: { publicationId, registry, revision, manifest: publication.manifest } } }));
  return { status: 'ready', lock: { revisionId: hashLore(payload), ...payload } };
}
function prepareLoreProductionV2({ binding, publication, chapter }) {
  validateWorkBinding(binding);
  const { resolver, documents, entities, definitions } = checkLorePublication(publication, binding);
  const context = binding.chapters.find(c => c.chapter === chapter);
  requireLore(context, 'SHARED_SCENE_CONTEXT_MISSING', `chapter ${chapter}`);
  validateLoreProjections({ cast: binding.cast, definitions, entities });
  const resolved = resolveLoreScenes({ revision: publication.revision, resolver, documents, entities, definitions, cast: binding.cast, scenes: context.scenes });
  if (resolved.blockers.length) return { status: 'unresolved', blockers: resolved.blockers };
  const payload = JSON.parse(encodeLore({ schemaVersion: 2, resolverVersion: LORE_RESOLVER_VERSION_V2, sourceKind: 'novel-chapter', workId: binding.workId, chapter,
    bindingRevisionId: binding.revisionId, loreRevisionId: publication.publicationId, registryRevisionId: publication.registry.revisionId,
    scenes: resolved.scenes, projections: resolved.projections, sceneVarying: resolved.sceneVarying,
    closure: { binding, publication: lorePublicationClosure(publication) } }));
  return { status: 'ready', lock: { revisionId: hashLore(payload), ...payload } };
}

export function verifyLoreProductionLock(lock) {
  const { revisionId, ...payload } = lock;
  requireLore(hashLore(payload) === revisionId && LORE_RESOLVER_VERSIONS.includes(lock.resolverVersion), 'LORE_INTEGRITY', 'production lock hash/version mismatch');
  if (lock.sourceKind === 'scene-script') return verifyLoreScriptLock(lock);
  requireLore((lock.resolverVersion === LORE_RESOLVER_VERSION) === (lock.closure?.binding?.schemaVersion === 1), 'LORE_INTEGRITY', 'resolver version does not match binding schema');
  const computed = prepareLoreProduction({ ...lock.closure, chapter: lock.chapter });
  requireLore(computed.status === 'ready' && computed.lock.revisionId === revisionId, 'LORE_INTEGRITY', 'production lock cannot be reproduced');
  return computed.lock;
}
