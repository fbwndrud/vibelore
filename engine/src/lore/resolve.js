import { compileLoreRegistry, encodeLore, hashLore } from './registry.js';
import { LORE_ID_SCHEMA, requireLore, validateShape } from './schemas.js';

const id = (value, path) => validateShape(LORE_ID_SCHEMA, value, path);
function closed(value, keys, required, path) {
  requireLore(value && Object.getPrototypeOf(value) === Object.prototype, 'INVALID_LORE_DATA', `${path} must be an object`);
  requireLore(Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key)), 'INVALID_LORE_DATA', `${path} has missing or unsupported fields`);
}
const scopes = { continuity: ['continuityId'], worldPoint: ['timelineId', 'fromPointId', 'untilPointId'], observer: ['observerId'], occurrence: ['occurrenceId'] };
const queryScopes = { continuity: ['continuityId'], worldPoint: ['timelineId', 'pointId'], observer: ['observerId'], occurrence: ['occurrenceId'] };

/** Compile a pinned input once; no filesystem, model calls, latest-wins, or branch inheritance. */
export function createLoreResolver({ registry, entities = [], timelines = [], values = [] }) {
  const compiled = compileLoreRegistry(registry);
  // Validate JSON before cloning, so NaN/undefined cannot be silently converted or dropped.
  const data = JSON.parse(encodeLore({ entities, timelines, values }));
  requireLore([data.entities, data.timelines, data.values].every(Array.isArray) && data.values.length <= 100000, 'INVALID_LORE_DATA', 'invalid resolver input size');
  const entityById = new Map(), timelineById = new Map(), valuesByFieldSubject = new Map(), valueIds = new Set();
  for (const entity of data.entities) {
    closed(entity, ['id', 'typeDefinitionRevisionId'], ['id', 'typeDefinitionRevisionId'], 'entity'); id(entity.id, 'entity.id');
    requireLore(!entityById.has(entity.id), 'INVALID_LORE_DATA', `duplicate entity ${entity.id}`);
    const type = compiled.definitionAt(entity.typeDefinitionRevisionId)?.definition;
    requireLore(type?.kind === 'entityType', 'INVALID_DEFINITION_REFERENCE', entity.typeDefinitionRevisionId);
    entityById.set(entity.id, { ...entity, typeId: type.id });
  }
  for (const timeline of data.timelines) {
    closed(timeline, ['id', 'continuityId', 'pointIds'], ['id', 'continuityId', 'pointIds'], 'timeline');
    id(timeline.id, 'timeline.id'); id(timeline.continuityId, 'timeline.continuityId');
    requireLore(!timelineById.has(timeline.id) && Array.isArray(timeline.pointIds) && timeline.pointIds.length > 0, 'INVALID_LORE_DATA', 'duplicate timeline or empty point ordering');
    timeline.pointIds.forEach(point => id(point, 'pointId'));
    requireLore(new Set(timeline.pointIds).size === timeline.pointIds.length, 'INVALID_LORE_DATA', 'duplicate timeline point');
    timelineById.set(timeline.id, { ...timeline, points: new Map(timeline.pointIds.map((point, i) => [point, i])) });
  }
  function entityType(entityId) {
    const entity = entityById.get(entityId);
    requireLore(entity, 'INVALID_ENTITY_REFERENCE', entityId);
    return entity.typeId;
  }
  function point(timelineId, continuityId, pointId) {
    const timeline = timelineById.get(timelineId);
    requireLore(timeline?.continuityId === continuityId && timeline.points.has(pointId), 'INVALID_STORY_SCOPE', `${timelineId}/${continuityId}/${pointId}`);
    return timeline.points.get(pointId);
  }
  for (const record of data.values) {
    closed(record, ['id', 'subject', 'fieldDefinitionRevisionId', 'owner', 'value', 'storyScope', 'evidenceIds'], ['id', 'subject', 'fieldDefinitionRevisionId', 'owner', 'value', 'storyScope', 'evidenceIds'], 'value record');
    id(record.id, 'value.id');
    requireLore(!valueIds.has(record.id), 'INVALID_LORE_DATA', `duplicate value ${record.id}`); valueIds.add(record.id);
    closed(record.subject, ['kind', 'entityId'], ['kind', 'entityId'], 'subject');
    requireLore(record.subject.kind === 'entity', 'REQUIRED_CAPABILITY', 'only entity subjects are implemented');
    const field = compiled.definitionAt(record.fieldDefinitionRevisionId)?.definition;
    requireLore(['field', 'relation'].includes(field?.kind), 'INVALID_DEFINITION_REFERENCE', record.fieldDefinitionRevisionId);
    requireLore(field.subjectTypeIds.includes(entityType(record.subject.entityId)), 'INVALID_SUBJECT_TYPE', field.id);
    requireLore(record.owner === field.owner, 'LORE_OWNERSHIP_CONFLICT', field.id);
    requireLore(Array.isArray(record.evidenceIds) && record.evidenceIds.length > 0 && record.evidenceIds.length <= 1000 && record.evidenceIds.every(e => typeof e === 'string' && e.trim().length > 0 && e.length <= 8000), 'INVALID_LORE_DATA', 'evidence IDs required');
    const scopeKeys = field.requiredScopes.flatMap(scope => scopes[scope]);
    closed(record.storyScope, scopeKeys, scopeKeys, 'storyScope');
    for (const [key, value] of Object.entries(record.storyScope)) { if (key !== 'untilPointId' || value !== null) id(value, key); }
    if (field.requiredScopes.includes('observer')) entityType(record.storyScope.observerId);
    if (field.requiredScopes.includes('worldPoint')) {
      const s = record.storyScope;
      const from = point(s.timelineId, s.continuityId, s.fromPointId);
      const until = s.untilPointId === null ? Infinity : point(s.timelineId, s.continuityId, s.untilPointId);
      requireLore(from < until, 'INVALID_STORY_SCOPE', 'interval must be nonempty [from, until)');
    }
    const { kind } = field.valueType, value = record.value;
    switch (kind) {
      case 'text': requireLore(typeof value === 'string', 'INVALID_FIELD_VALUE', field.id); break;
      case 'boolean': requireLore(typeof value === 'boolean', 'INVALID_FIELD_VALUE', field.id); break;
      case 'number': case 'integer': requireLore(typeof value === 'number' && Number.isFinite(value) && (kind !== 'integer' || Number.isSafeInteger(value)), 'INVALID_FIELD_VALUE', field.id); break;
      case 'enum': requireLore(field.valueType.values.includes(value), 'INVALID_FIELD_VALUE', field.id); break;
      case 'reference':
        closed(value, ['entityId'], ['entityId'], 'reference');
        requireLore(field.valueType.targetTypeIds.includes(entityType(value.entityId)), 'INVALID_FIELD_VALUE', field.id);
        break;
    }
    for (const constraint of field.constraints) {
      const size = kind === 'text' ? [...value].length : value;
      const lower = ['minimum', 'minLength'].includes(constraint.op);
      requireLore(lower ? size >= constraint.value : size <= constraint.value, 'INVALID_FIELD_VALUE', `${field.id}: ${constraint.op}`);
    }
    const token = `${field.id}\0${record.subject.entityId}`;
    if (!valuesByFieldSubject.has(token)) valuesByFieldSubject.set(token, []);
    valuesByFieldSubject.get(token).push(record);
  }
  const inputRevisionId = hashLore({ registryRevisionId: compiled.revisionId, ...data });
  return Object.freeze({ registryRevisionId: compiled.revisionId, inputRevisionId,
    resolve(query) {
      closed(query, ['subjectId', 'fieldId', 'scope', 'maxCandidates'], ['subjectId', 'fieldId'], 'query');
      const { subjectId, fieldId, scope = {}, maxCandidates = 10000 } = query;
      id(subjectId, 'subjectId'); id(fieldId, 'fieldId');
      requireLore(Number.isSafeInteger(maxCandidates) && maxCandidates > 0 && maxCandidates <= 10000, 'INVALID_LORE_DATA', 'invalid candidate budget');
      const fieldDocument = compiled.definition(fieldId), field = fieldDocument?.definition;
      requireLore(['field', 'relation'].includes(field?.kind), 'INVALID_DEFINITION_REFERENCE', fieldId);
      requireLore(field.subjectTypeIds.includes(entityType(subjectId)), 'INVALID_SUBJECT_TYPE', fieldId);
      closed(scope, ['continuityId', 'timelineId', 'pointId', 'observerId', 'occurrenceId'], field.requiredScopes.flatMap(axis => queryScopes[axis]), 'query.scope');
      for (const [key, value] of Object.entries(scope)) id(value, key);
      const at = scope.pointId === undefined ? undefined : point(scope.timelineId, scope.continuityId, scope.pointId);
      if (scope.observerId !== undefined) entityType(scope.observerId);
      const candidates = valuesByFieldSubject.get(`${fieldId}\0${subjectId}`) ?? [];
      const base = { registryRevisionId: compiled.revisionId, inputRevisionId, fieldDefinitionRevisionId: fieldDocument.revisionId, subjectId, fieldId };
      if (candidates.length > maxCandidates) return { ...base, status: 'incomplete', reason: 'candidate_budget', candidateCount: candidates.length };
      const selected = candidates.filter(record => {
        const s = record.storyScope;
        if (['continuityId', 'observerId', 'occurrenceId'].some(key => s[key] !== undefined && s[key] !== scope[key])) return false;
        if (s.timelineId !== undefined) return s.timelineId === scope.timelineId && at >= point(s.timelineId, s.continuityId, s.fromPointId) && (s.untilPointId === null || at < point(s.timelineId, s.continuityId, s.untilPointId));
        return true;
      });
      if (!selected.length) return { ...base, status: 'unknown', reason: 'no_applicable_value' };
      const groups = new Map();
      for (const record of selected) {
        const token = hashLore(record.value);
        if (!groups.has(token)) groups.set(token, { value: record.value, valueIds: [], evidenceIds: [] });
        groups.get(token).valueIds.push(record.id); groups.get(token).evidenceIds.push(...record.evidenceIds);
      }
      const matches = [...groups.values()].map(group => ({ ...group, valueIds: group.valueIds.sort(), evidenceIds: [...new Set(group.evidenceIds)].sort() })).sort((a, b) => hashLore(a.value).localeCompare(hashLore(b.value)));
      // Copy outputs; mutable caller results cannot change later queries.
      if (field.cardinality === 'one' && matches.length > 1) return JSON.parse(encodeLore({ ...base, status: 'conflict', candidates: matches }));
      return JSON.parse(encodeLore({ ...base, status: 'resolved', ...(field.cardinality === 'one' ? matches[0] : { values: matches }) }));
    },
  });
}
