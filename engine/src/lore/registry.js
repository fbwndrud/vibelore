import { createHash } from 'node:crypto';
import { LORE_DEFINITION_SCHEMA, LORE_ID_SCHEMA, requireLore, validateShape } from './schemas.js';

export const LORE_CAPABILITIES = Object.freeze([
  'text-value-v1', 'boolean-value-v1', 'numeric-value-v1', 'enum-value-v1', 'reference-value-v1',
  'numeric-bounds-v1', 'text-length-v1', 'single-value-v1', 'multi-value-v1',
  'continuity-scope-v1', 'state-at-point-v1', 'observer-scope-v1', 'occurrence-scope-v1', 'directed-relation-v1',
]);
const capabilitySet = new Set(LORE_CAPABILITIES);
export const loreNameKey = value => value.normalize('NFC').trim().toLowerCase().replace(/\s+/gu, ' ');

function canonical(value, depth = 0) {
  requireLore(depth <= 32, 'INVALID_LORE_DATA', 'JSON nesting limit exceeded');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') { requireLore(Number.isFinite(value), 'INVALID_LORE_DATA', 'non-finite number'); return value; }
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  requireLore(value && Object.getPrototypeOf(value) === Object.prototype, 'INVALID_LORE_DATA', 'plain JSON required');
  return Object.fromEntries(Object.keys(value).sort().map(key => {
    requireLore(!['__proto__', 'prototype', 'constructor'].includes(key), 'INVALID_LORE_DATA', 'reserved JSON key');
    return [key, canonical(value[key], depth + 1)];
  }));
}
export const encodeLore = value => `${JSON.stringify(canonical(value), null, 2)}\n`;
export const hashLore = value => `sha256:${createHash('sha256').update(encodeLore(value)).digest('hex')}`;
export const isLoreRevisionId = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export function validateLoreDefinition(definition) {
  validateShape(LORE_DEFINITION_SCHEMA, definition);
  for (const key of ['label', 'definition']) requireLore(definition[key].trim().length > 0, 'INVALID_LORE_DATA', `empty ${key}`);
  for (const key of ['aliases', 'requiredCapabilities', 'subjectTypeIds', 'requiredScopes']) {
    const list = definition[key] ?? [];
    requireLore(new Set(list.map(loreNameKey)).size === list.length, 'INVALID_LORE_DATA', `duplicate ${key}`);
  }
  for (const capability of definition.requiredCapabilities) requireLore(capabilitySet.has(capability), 'REQUIRED_CAPABILITY', capability);
  if (!['field', 'relation'].includes(definition.kind)) return;
  const { valueType, constraints, requiredScopes, owner } = definition;
  requireLore(!requiredScopes.includes('worldPoint') || requiredScopes.includes('continuity'), 'INVALID_LORE_DATA', 'worldPoint requires continuity');
  requireLore(owner !== 'state' || requiredScopes.includes('worldPoint'), 'INVALID_LORE_DATA', 'state requires worldPoint');
  requireLore(owner !== 'observer' || requiredScopes.includes('observer'), 'INVALID_LORE_DATA', 'observer owner requires observer scope');
  if (valueType.kind === 'enum') requireLore(new Set(valueType.values).size === valueType.values.length, 'INVALID_LORE_DATA', 'duplicate enum values');
  if (valueType.kind === 'reference') requireLore(new Set(valueType.targetTypeIds).size === valueType.targetTypeIds.length, 'INVALID_LORE_DATA', 'duplicate reference types');
  requireLore(new Set(constraints.map(c => c.op)).size === constraints.length, 'INVALID_LORE_DATA', 'duplicate constraints');
  for (const c of constraints) requireLore(['minimum', 'maximum'].includes(c.op) ? ['number', 'integer'].includes(valueType.kind) : valueType.kind === 'text', 'INVALID_LORE_DATA', `constraint ${c.op} does not apply to ${valueType.kind}`);
  for (const [lower, upper] of [['minimum', 'maximum'], ['minLength', 'maxLength']]) {
    const min = constraints.find(c => c.op === lower)?.value;
    const max = constraints.find(c => c.op === upper)?.value;
    requireLore(min === undefined || max === undefined || min <= max, 'INVALID_LORE_DATA', 'empty constraint range');
  }
}

function seal(payload) { return freeze({ revisionId: hashLore(payload), ...payload }); }
export function createLoreRegistry(universeId) {
  validateShape(LORE_ID_SCHEMA, universeId, 'universeId');
  return seal({ schemaVersion: 1, universeId, parentRevisionId: null, definitions: [], change: { reason: 'Initialize definition registry', addedRevisionIds: [] } });
}
const payloadOf = ({ revisionId, ...payload }) => payload;
export function compileLoreRegistry(registry) {
  validateShape(LORE_ID_SCHEMA, registry?.universeId, 'universeId');
  requireLore(registry.schemaVersion === 1 && (registry.parentRevisionId === null || isLoreRevisionId(registry.parentRevisionId)), 'INVALID_LORE_DATA', 'invalid registry version or parent');
  requireLore(Array.isArray(registry.definitions) && registry.definitions.length <= 10000, 'INVALID_LORE_DATA', 'invalid registry definitions');
  requireLore(isLoreRevisionId(registry.revisionId) && hashLore(payloadOf(registry)) === registry.revisionId, 'LORE_INTEGRITY', 'registry hash mismatch');
  const byId = new Map(), byName = new Map();
  for (const document of registry.definitions) {
    validateLoreDefinition(document.definition);
    requireLore(hashLore(document.definition) === document.revisionId, 'LORE_INTEGRITY', 'definition hash mismatch');
    const definition = document.definition;
    requireLore(!byId.has(definition.id), 'DEFINITION_CONFLICT', `duplicate stable ID ${definition.id}`);
    byId.set(definition.id, document);
    for (const name of [definition.key, ...definition.aliases]) {
      const token = `${definition.namespace}\0${loreNameKey(name)}`;
      requireLore(loreNameKey(name).length > 0 && (!byName.has(token) || byName.get(token) === definition.id), 'DEFINITION_CONFLICT', `key/alias collision: ${name}`);
      byName.set(token, definition.id);
    }
  }
  for (const { definition: d } of byId.values()) {
    for (const typeId of [...(d.subjectTypeIds ?? []), ...(d.valueType?.targetTypeIds ?? [])]) requireLore(byId.get(typeId)?.definition.kind === 'entityType', 'INVALID_DEFINITION_REFERENCE', typeId);
    if (d.valueType?.unitId) requireLore(byId.get(d.valueType.unitId)?.definition.kind === 'unit', 'INVALID_DEFINITION_REFERENCE', d.valueType.unitId);
  }
  // Own a frozen copy; callers cannot mutate a resolver's interpretation after compilation.
  const owned = freeze(JSON.parse(encodeLore(registry)));
  const documents = new Map(owned.definitions.map(d => [d.definition.id, d]));
  const revisions = new Map(owned.definitions.map(d => [d.revisionId, d]));
  return Object.freeze({ revisionId: owned.revisionId, universeId: owned.universeId,
    definition: id => documents.get(id) ?? null,
    definitionAt: revisionId => revisions.get(revisionId) ?? null,
    search({ query = '', namespace, subjectTypeId, limit = 20 } = {}) {
      requireLore(typeof query === 'string' && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'INVALID_LORE_DATA', 'invalid search query or limit');
      const needle = loreNameKey(query);
      const candidates = [...documents.values()].filter(({ definition: d }) => (!namespace || d.namespace === namespace) && (!subjectTypeId || d.subjectTypeIds?.includes(subjectTypeId))).map(document => {
        const d = document.definition, names = [d.key, ...d.aliases].map(loreNameKey);
        const match = needle && names.includes(needle) ? 'exact' : 'candidate';
        const matches = !needle || match === 'exact' || loreNameKey([d.key, d.label, d.definition, ...d.aliases].join(' ')).includes(needle);
        return { ...document, match, matches };
      }).filter(d => d.matches).sort((a, b) => (a.match === 'exact' ? 0 : 1) - (b.match === 'exact' ? 0 : 1) || a.definition.id.localeCompare(b.definition.id));
      return { registryRevisionId: owned.revisionId, incomplete: candidates.length > limit,
        results: candidates.slice(0, limit).map(({ matches, ...document }) => document) };
    },
  });
}

/** Add-only transaction. Existing meaning/owner/type changes require a separate migration. */
export function addLoreDefinitions(registry, { definitions, reason }) {
  const current = compileLoreRegistry(registry);
  requireLore(Array.isArray(definitions) && definitions.length > 0 && definitions.length <= 1000, 'INVALID_LORE_DATA', 'provide 1..1000 definitions');
  requireLore(typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 8000, 'INVALID_LORE_DATA', 'registration reason required');
  const additions = new Map(), reusedRevisionIds = [];
  for (const definition of definitions) {
    validateLoreDefinition(definition);
    const revisionId = hashLore(definition), existing = current.definition(definition.id) ?? additions.get(definition.id);
    requireLore(!existing || existing.revisionId === revisionId, 'DEFINITION_MIGRATION_REQUIRED', definition.id, { existingRevisionId: existing?.revisionId, proposedRevisionId: revisionId });
    if (existing) reusedRevisionIds.push(revisionId);
    else additions.set(definition.id, { revisionId, definition });
  }
  if (!additions.size) return { registry: freeze(JSON.parse(encodeLore(registry))), addedRevisionIds: [], reusedRevisionIds };
  const addedRevisionIds = [...additions.values()].map(d => d.revisionId).sort();
  const next = seal({ schemaVersion: 1, universeId: registry.universeId, parentRevisionId: registry.revisionId,
    definitions: JSON.parse(encodeLore([...registry.definitions, ...additions.values()].sort((a, b) => a.definition.id.localeCompare(b.definition.id)))),
    change: { reason, addedRevisionIds } });
  compileLoreRegistry(next);
  return { registry: next, addedRevisionIds, reusedRevisionIds };
}
