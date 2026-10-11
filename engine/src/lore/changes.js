import { compileLoreRegistry, encodeLore, hashLore, isLoreRevisionId } from './registry.js';
import { createLoreResolver } from './resolve.js';
import { requireLore, validateShape, LORE_ID_SCHEMA } from './schemas.js';

const id = (v, p) => validateShape(LORE_ID_SCHEMA, v, p);
function shape(value, keys, name) {
  requireLore(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), 'INVALID_LORE_DATA', `invalid ${name}`);
}
const unique = (list, name) => { requireLore(Array.isArray(list) && new Set(list).size === list.length && list.every(v => typeof v === 'string'), 'INVALID_LORE_DATA', name); };

/** Rich source documents plus a selectively structured value view; never flatten prose into facts. */
export function validateLoreContent({ registry, content }) {
  shape(content, ['entities', 'states', 'timelines', 'values', 'documents', 'worldDocumentIds'], 'lore content');
  for (const key of Object.keys(content)) requireLore(Array.isArray(content[key]) && content[key].length <= 100000, 'INVALID_LORE_DATA', `${key} must be a bounded array`);
  requireLore(content.documents.length <= 1000, 'INVALID_LORE_DATA', 'too many source documents');
  const definitions = compileLoreRegistry(registry), documents = new Map(), paths = new Set(), entities = new Map(), claimedValues = new Map(), claimedDocuments = new Map();
  for (const doc of content.documents) {
    shape(doc, ['id', 'path', 'text', 'visibility'], 'source document'); id(doc.id, 'document.id');
    requireLore(!documents.has(doc.id) && typeof doc.path === 'string' && !paths.has(doc.path) && typeof doc.text === 'string' && Buffer.byteLength(doc.text) <= 2_000_000 && ['author', 'context'].includes(doc.visibility), 'INVALID_LORE_DATA', 'invalid or duplicate document');
    documents.set(doc.id, doc); paths.add(doc.path);
  }
  const valueById = new Map(content.values.map(value => [value.id, value]));
  function claimDocs(ids, owner) {
    unique(ids, 'documentIds');
    for (const docId of ids) {
      requireLore(documents.has(docId), 'LORE_DOCUMENT_MISSING', docId);
      requireLore(!claimedDocuments.has(docId), 'LORE_OWNERSHIP_CONFLICT', `document ${docId} already owned`);
      claimedDocuments.set(docId, owner);
    }
  }
  function claimValues(ids, owner, entityId, stateScope) {
    unique(ids, 'valueIds');
    for (const valueId of ids) {
      const value = valueById.get(valueId);
      requireLore(value && value.owner === owner && value.subject.entityId === entityId, 'LORE_OWNERSHIP_CONFLICT', valueId);
      requireLore(!claimedValues.has(valueId) && (!stateScope || hashLore(value.storyScope) === hashLore(stateScope)), 'LORE_OWNERSHIP_CONFLICT', `duplicate owner or state scope: ${valueId}`);
      claimedValues.set(valueId, owner);
    }
  }
  claimDocs(content.worldDocumentIds, 'world');
  for (const entity of content.entities) {
    shape(entity, ['id', 'typeDefinitionRevisionId', 'documentIds', 'valueIds'], 'entity profile'); id(entity.id, 'entity.id');
    requireLore(!entities.has(entity.id), 'INVALID_LORE_DATA', `duplicate entity ${entity.id}`); entities.set(entity.id, entity);
    claimDocs(entity.documentIds, entity.id); claimValues(entity.valueIds, 'profile', entity.id);
  }
  const stateIds = new Set();
  for (const state of content.states) {
    shape(state, ['id', 'entityId', 'documentIds', 'valueIds', 'storyScope'], 'state'); id(state.id, 'state.id');
    requireLore(!stateIds.has(state.id) && entities.has(state.entityId), 'INVALID_LORE_DATA', `invalid state ${state.id}`); stateIds.add(state.id);
    shape(state.storyScope, ['continuityId', 'timelineId', 'fromPointId', 'untilPointId'], 'state scope');
    const s = state.storyScope, timeline = content.timelines.find(t => t.id === s.timelineId);
    requireLore(timeline?.continuityId === s.continuityId && timeline.pointIds.includes(s.fromPointId) && (s.untilPointId === null || timeline.pointIds.includes(s.untilPointId) && timeline.pointIds.indexOf(s.fromPointId) < timeline.pointIds.indexOf(s.untilPointId)), 'INVALID_STORY_SCOPE', state.id);
    claimDocs(state.documentIds, state.id); claimValues(state.valueIds, 'state', state.entityId, state.storyScope);
  }
  for (const value of content.values) {
    requireLore(!['state', 'profile'].includes(value.owner) || claimedValues.has(value.id), 'LORE_OWNERSHIP_CONFLICT', `unowned ${value.id}`);
    requireLore(value.evidenceIds?.every(e => documents.has(e)), 'LORE_DOCUMENT_MISSING', `value ${value.id} evidence`);
  }
  const resolver = createLoreResolver({ registry, entities: content.entities.map(({ id, typeDefinitionRevisionId }) => ({ id, typeDefinitionRevisionId })), timelines: content.timelines, values: content.values });
  // Test each interval's start. Any differing overlap must include at least one start.
  const tested = new Set();
  for (const value of content.values) {
    const field = definitions.definitionAt(value.fieldDefinitionRevisionId).definition;
    if (field.cardinality !== 'one') continue;
    const s = value.storyScope;
    const scope = Object.fromEntries(Object.entries(s).filter(([key]) => !['fromPointId', 'untilPointId'].includes(key)));
    if (s.fromPointId) scope.pointId = s.fromPointId;
    const query = { subjectId: value.subject.entityId, fieldId: field.id, scope }, token = hashLore(query);
    if (tested.has(token)) continue; tested.add(token);
    const result = resolver.resolve(query);
    requireLore(!['conflict', 'incomplete'].includes(result.status), 'LORE_VALUE_CONFLICT', `${field.id}/${value.subject.entityId}`, result);
  }
  return { resolver, definitions, documents, entities };
}
export function createLoreRevision({ universeId, parentRevisionId = null, registry, content, reason }) {
  requireLore(registry.universeId === universeId && (parentRevisionId === null || isLoreRevisionId(parentRevisionId)), 'INVALID_LORE_DATA', 'invalid universe or parent');
  requireLore(typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 8000, 'INVALID_LORE_DATA', 'lore change reason required');
  validateLoreContent({ registry, content });
  const payload = JSON.parse(encodeLore({ schemaVersion: 1, universeId, parentRevisionId, registryRevisionId: registry.revisionId, content, change: { reason } }));
  return { revisionId: hashLore(payload), ...payload };
}
export function validateLoreRevision({ registry, revision }) {
  const { revisionId, ...payload } = revision;
  shape(revision, ['revisionId', 'schemaVersion', 'universeId', 'parentRevisionId', 'registryRevisionId', 'content', 'change'], 'LoreRevision');
  requireLore(revision.schemaVersion === 1 && revision.registryRevisionId === registry.revisionId && hashLore(payload) === revisionId, 'LORE_INTEGRITY', 'LoreRevision hash or registry mismatch');
  createLoreRevision({ universeId: revision.universeId, parentRevisionId: revision.parentRevisionId, registry, content: revision.content, reason: revision.change.reason });
  return validateLoreContent({ registry, content: revision.content });
}
export function loreStateApplies(state, scope, timelines) {
  const s = state.storyScope, points = timelines.find(t => t.id === s.timelineId)?.pointIds ?? [];
  const at = points.indexOf(scope.pointId);
  return s.continuityId === scope.continuityId && s.timelineId === scope.timelineId && at >= points.indexOf(s.fromPointId) && (s.untilPointId === null || at < points.indexOf(s.untilPointId));
}
