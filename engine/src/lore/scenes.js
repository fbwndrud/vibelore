import { loreStateApplies, validateLoreRevision } from './changes.js';
import { hashLore } from './registry.js';
import { requireLore, validateShape, LORE_ID_SCHEMA } from './schemas.js';

// Scene contexts shared by novel chapters (binding v2) and standalone scripts.
// A scene resolves only its explicit world point; nothing is inherited from a
// neighbouring scene, chapter, parent continuity or the latest world HEAD.
export const LORE_SCENE_FRAMES = Object.freeze(['present', 'flashback']);
export const LORE_PROJECTION_TARGETS = Object.freeze(['canonicalName', 'intrinsic.gender', 'intrinsic.genderLabel', 'intrinsic.ageBand', 'intrinsic.birthOrder', 'intrinsic.species', 'intrinsic.form', 'intrinsic.coreAppearance', 'intrinsic.addressing.acceptedPronouns', 'intrinsic.addressing.acceptedGenderedTerms', 'intrinsic.addressing.forbiddenGenderedTerms']);
export const LORE_ARRAY_TARGETS = new Set(LORE_PROJECTION_TARGETS.filter(t => t === 'intrinsic.coreAppearance' || t.startsWith('intrinsic.addressing.')));
/** Requested behavior that this engine does not interpret. Callers get REQUIRED_CAPABILITY, never a silent fallback. */
export const LORE_UNSUPPORTED_SCENE_KEYS = Object.freeze({
  experiencePathId: 'experience-path-v1', experienceStepId: 'experience-path-v1', participants: 'occurrence-participants-v1',
  universeScopes: 'crossover-v1', inheritFrom: 'branch-inheritance-v1', bodyEntityId: 'person-body-identity-v1', frameId: 'narrative-frame-v1',
});
const id = (v, p) => validateShape(LORE_ID_SCHEMA, v, p);

/** The pinned universe/lore/registry IDs must name exactly the sealed publication supplied. */
export function checkLorePublication(publication, pinned) {
  const { registry, revision, publicationId } = publication ?? {};
  requireLore(publication?.manifest && hashLore(publication.manifest) === publicationId && hashLore(publication.manifest.revision) === hashLore(revision), 'LORE_INTEGRITY', 'lore publication manifest mismatch');
  requireLore(pinned.loreRevisionId === publicationId && pinned.registryRevisionId === registry.revisionId && pinned.universeId === revision.universeId, 'LORE_INTEGRITY', 'pinned input does not match lore publication');
  return validateLoreRevision({ registry, revision });
}
export const lorePublicationClosure = ({ publicationId, registry, revision, manifest }) => ({ publicationId, registry, revision, manifest });
const closed = (value, allowed, required, path) => requireLore(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(value, k)), 'INVALID_LORE_DATA', `invalid ${path}`);

export function validateLoreCast(cast) {
  requireLore(Array.isArray(cast) && cast.length <= 1000, 'INVALID_LORE_DATA', 'invalid cast');
  const localIds = new Set(), entityIds = new Set();
  for (const member of cast) {
    closed(member, ['localCharacterId', 'entityId', 'projections'], ['localCharacterId', 'entityId', 'projections'], 'cast member');
    id(member.localCharacterId, 'localCharacterId'); id(member.entityId, 'entityId');
    // One shared entity per local character: occurrence-level duplication is a separate capability.
    requireLore(!localIds.has(member.localCharacterId) && !entityIds.has(member.entityId) && Array.isArray(member.projections), 'INVALID_LORE_DATA', 'duplicate cast member');
    localIds.add(member.localCharacterId); entityIds.add(member.entityId);
    const targets = new Set();
    for (const projection of member.projections) {
      closed(projection, ['target', 'fieldId'], ['target', 'fieldId'], 'projection'); id(projection.fieldId, 'fieldId');
      requireLore(LORE_PROJECTION_TARGETS.includes(projection.target) && !targets.has(projection.target), 'REQUIRED_CAPABILITY', `unsupported or duplicate projection ${projection.target}`); targets.add(projection.target);
    }
  }
}

/** Shape of one scene list; `sceneIds` is shared across chapters so a stable scene ID is never reused. */
export function validateLoreScenes(scenes, { continuityId, sceneIds = new Set(), limit = 200 }) {
  requireLore(Array.isArray(scenes) && scenes.length > 0 && scenes.length <= limit, 'INVALID_LORE_DATA', 'scene list must be nonempty');
  for (const scene of scenes) {
    requireLore(scene && typeof scene === 'object', 'INVALID_LORE_DATA', 'invalid scene');
    for (const [key, capability] of Object.entries(LORE_UNSUPPORTED_SCENE_KEYS)) requireLore(!Object.hasOwn(scene, key) && !Object.hasOwn(scene.scope ?? {}, key), 'REQUIRED_CAPABILITY', `${capability} is not implemented (${key})`, { capability });
    closed(scene, ['id', 'frame', 'scope', 'entityIds', 'requirements', 'worldDocumentIds'], ['id', 'frame', 'scope', 'entityIds', 'requirements'], 'scene'); id(scene.id, 'sceneId');
    if (scene.worldDocumentIds !== undefined) {
      requireLore(Array.isArray(scene.worldDocumentIds) && scene.worldDocumentIds.length <= 1000 && new Set(scene.worldDocumentIds).size === scene.worldDocumentIds.length, 'INVALID_LORE_DATA', 'worldDocumentIds must be unique');
      scene.worldDocumentIds.forEach(docId => id(docId, 'worldDocumentIds'));
    }
    requireLore(LORE_SCENE_FRAMES.includes(scene.frame), 'INVALID_LORE_DATA', `scene ${scene.id} frame must be present or flashback`);
    requireLore(!sceneIds.has(scene.id) && Array.isArray(scene.entityIds) && new Set(scene.entityIds).size === scene.entityIds.length && Array.isArray(scene.requirements), 'INVALID_LORE_DATA', 'invalid scene selection'); sceneIds.add(scene.id);
    scene.entityIds.forEach(entityId => id(entityId, 'entityId'));
    closed(scene.scope, ['continuityId', 'timelineId', 'pointId', 'observerId', 'occurrenceId'], ['continuityId', 'timelineId', 'pointId'], 'scene scope');
    requireLore(scene.scope.continuityId === continuityId, 'INVALID_STORY_SCOPE', scene.id);
    Object.values(scene.scope).forEach(value => id(value, 'scope ID'));
    const requirements = new Set();
    for (const r of scene.requirements) {
      closed(r, ['entityId', 'fieldId', 'required'], ['entityId', 'fieldId', 'required'], 'scene requirement'); id(r.fieldId, 'fieldId');
      requireLore(scene.entityIds.includes(r.entityId) && typeof r.required === 'boolean' && !requirements.has(`${r.entityId}\0${r.fieldId}`), 'INVALID_LORE_DATA', 'invalid or duplicate requirement'); requirements.add(`${r.entityId}\0${r.fieldId}`);
    }
  }
}

export function validateLoreProjections({ cast, definitions, entities }) {
  for (const member of cast) {
    requireLore(entities.has(member.entityId), 'INVALID_ENTITY_REFERENCE', member.entityId);
    const typeId = definitions.definitionAt(entities.get(member.entityId).typeDefinitionRevisionId).definition.id;
    for (const p of member.projections) {
      const definition = definitions.definition(p.fieldId)?.definition;
      requireLore(!definition || !definition.requiredScopes.some(scope => ['observer', 'occurrence'].includes(scope)), 'REQUIRED_CAPABILITY', `${p.target}: observer/occurrence-scoped projection is not implemented`);
      // A name that changes over story time needs a name-ownership migration first.
      requireLore(p.target !== 'canonicalName' || !definition?.requiredScopes.includes('worldPoint'), 'INVALID_LORE_PROJECTION', 'canonicalName must use a profile field without worldPoint scope');
      requireLore(definition?.kind === 'field' && definition.subjectTypeIds.includes(typeId)
        && (LORE_ARRAY_TARGETS.has(p.target) ? definition.valueType.kind === 'text' && definition.cardinality === 'many' : ['text', 'enum'].includes(definition.valueType.kind) && definition.cardinality === 'one'), 'INVALID_LORE_PROJECTION', p.target);
    }
  }
}

const projectedValue = (target, result) => LORE_ARRAY_TARGETS.has(target) ? result.values.map(v => v.value) : result.value;
const evidenceOf = result => result.status !== 'resolved' ? { valueIds: [], evidenceIds: [] } : Object.hasOwn(result, 'value')
  ? { valueIds: result.valueIds, evidenceIds: result.evidenceIds }
  : { valueIds: result.values.flatMap(v => v.valueIds).sort(), evidenceIds: [...new Set(result.values.flatMap(v => v.evidenceIds))].sort() };

/**
 * Resolve each scene independently. Present scenes on one timeline must not go
 * backwards; a return to an earlier point is a flashback and never becomes the
 * chapter's present state.
 */
export function resolveLoreScenes({ revision, resolver, documents, entities, definitions, cast, scenes }) {
  const blockers = [], resolved = [], lastPresent = new Map();
  for (const scene of scenes) {
    const timeline = revision.content.timelines.find(t => t.id === scene.scope.timelineId);
    requireLore(timeline?.continuityId === scene.scope.continuityId && timeline.pointIds.includes(scene.scope.pointId), 'INVALID_STORY_SCOPE', scene.id);
    if (scene.frame === 'present') {
      const at = timeline.pointIds.indexOf(scene.scope.pointId), prior = lastPresent.get(timeline.id);
      if (prior && prior.at > at) blockers.push({ sceneId: scene.id, status: 'invalid_order', code: 'SCENE_ORDER_REQUIRES_FRAME', previousSceneId: prior.sceneId, message: 'a present scene moves to an earlier world point; mark it frame="flashback" or reorder the scenes' });
      lastPresent.set(timeline.id, { at, sceneId: scene.id });
    }
    const selectedDocs = new Map(), results = new Map(), stateIds = {};
    const include = ids => ids.forEach(docId => { const doc = documents.get(docId); if (doc.visibility === 'context') selectedDocs.set(docId, doc); });
    if (scene.worldDocumentIds !== undefined) requireLore(scene.worldDocumentIds.every(id => revision.content.worldDocumentIds.includes(id)), 'LORE_DOCUMENT_MISSING', 'scene worldDocumentIds must select adopted world documents');
    include(scene.worldDocumentIds ?? revision.content.worldDocumentIds);
    for (const entityId of scene.entityIds) {
      requireLore(entities.has(entityId), 'INVALID_ENTITY_REFERENCE', entityId);
      include(entities.get(entityId).documentIds);
      const states = revision.content.states.filter(state => state.entityId === entityId && loreStateApplies(state, scene.scope, revision.content.timelines));
      states.forEach(state => include(state.documentIds));
      stateIds[entityId] = states.map(state => state.id).sort();
    }
    const members = cast.filter(c => scene.entityIds.includes(c.entityId));
    const requests = [...scene.requirements, ...members.flatMap(c => c.projections.map(p => ({ entityId: c.entityId, fieldId: p.fieldId, required: true })))];
    for (const r of requests) {
      const token = `${r.entityId}\0${r.fieldId}`;
      if (!results.has(token)) results.set(token, resolver.resolve({ subjectId: r.entityId, fieldId: r.fieldId, scope: scene.scope }));
      const result = results.get(token);
      // Opt-in selection keeps old locks byte-identical. Requested value
      // evidence remains context even when its world document was not selected.
      if (scene.worldDocumentIds !== undefined) {
        const evidenceIds = evidenceOf(result).evidenceIds;
        for (const docId of evidenceIds) {
          const futureState = revision.content.states.find(s => s.documentIds.includes(docId) && !loreStateApplies(s, scene.scope, revision.content.timelines));
          requireLore(!futureState, 'SHARED_LORE_EVIDENCE_SCOPE', `evidence ${docId} is outside scene ${scene.id}`);
        }
        include(evidenceIds);
      }
      if (result.status !== 'resolved' && (r.required || ['conflict', 'incomplete'].includes(result.status)) && !blockers.some(b => b.sceneId === scene.id && b.entityId === r.entityId && b.fieldId === r.fieldId)) blockers.push({ sceneId: scene.id, ...r, status: result.status });
    }
    const projections = [];
    for (const member of members) for (const p of member.projections) {
      const result = results.get(`${member.entityId}\0${p.fieldId}`);
      if (result.status !== 'resolved') continue;
      const value = projectedValue(p.target, result);
      requireLore(p.target !== 'canonicalName' || value.trim().length > 0, 'INVALID_LORE_PROJECTION', 'empty canonical name');
      projections.push({ localCharacterId: member.localCharacterId, entityId: member.entityId, target: p.target, fieldId: p.fieldId,
        fieldDefinitionRevisionId: result.fieldDefinitionRevisionId, value, ...evidenceOf(result) });
    }
    resolved.push({ id: scene.id, frame: scene.frame, scope: scene.scope, entityIds: scene.entityIds, stateIds, results: [...results.values()], projections, documents: [...selectedDocs.values()] });
  }
  // The chapter-level DTO carries scope-free values and point values every
  // present scene agrees on. Anything else is scene-only, never a stale copy.
  const chapter = new Map(), sceneVarying = [];
  for (const member of cast) for (const p of member.projections) {
    const def = definitions.definition(p.fieldId).definition, appearsIn = resolved.filter(s => s.entityIds.includes(member.entityId)).map(s => s.id);
    // Addressing lists are checked per manuscript scene; a chapter-wide checker
    // would apply one state to a flashback or another scene.
    if (p.target.startsWith('intrinsic.addressing.')) { sceneVarying.push({ localCharacterId: member.localCharacterId, target: p.target, reason: 'scene_checked', sceneIds: appearsIn }); continue; }
    if (!def.requiredScopes.includes('worldPoint')) {
      const result = resolver.resolve({ subjectId: member.entityId, fieldId: p.fieldId, scope: def.requiredScopes.includes('continuity') ? { continuityId: scenes[0].scope.continuityId } : {} });
      if (result.status !== 'resolved') { blockers.push({ localCharacterId: member.localCharacterId, entityId: member.entityId, fieldId: p.fieldId, required: true, status: result.status }); continue; }
      chapter.set(`${member.localCharacterId}\0${p.target}`, { localCharacterId: member.localCharacterId, target: p.target, value: projectedValue(p.target, result), sceneIds: appearsIn });
      continue;
    }
    const present = resolved.filter(s => s.frame === 'present' && s.entityIds.includes(member.entityId));
    const valueIn = s => s.projections.find(x => x.localCharacterId === member.localCharacterId && x.target === p.target);
    const values = present.map(valueIn).filter(Boolean);
    // A flashback with another value would be read under the present value by chapter-wide checks, so the field stays scene-only.
    const flashbackDiffers = values.length > 0 && resolved.some(s => s.frame === 'flashback' && s.entityIds.includes(member.entityId) && hashLore(valueIn(s)?.value ?? null) !== hashLore(values[0].value));
    if (values.length && values.length === present.length && new Set(values.map(v => hashLore(v.value))).size === 1 && !flashbackDiffers) {
      chapter.set(`${member.localCharacterId}\0${p.target}`, { localCharacterId: member.localCharacterId, target: p.target, value: values[0].value, sceneIds: present.map(s => s.id) });
      continue;
    }
    sceneVarying.push({ localCharacterId: member.localCharacterId, target: p.target, reason: !appearsIn.length ? 'not_selected' : !present.length ? 'flashback_only' : flashbackDiffers ? 'flashback_differs' : 'differs', sceneIds: appearsIn });
  }
  return { blockers, scenes: resolved, projections: [...chapter.values()], sceneVarying };
}
