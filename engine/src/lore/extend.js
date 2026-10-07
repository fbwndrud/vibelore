import { LORE_CAPABILITIES, compileLoreRegistry, hashLore, loreNameKey, validateLoreDefinition } from './registry.js';
import { LoreError, requireLore } from './schemas.js';

/** Behavior a key name cannot add. Registering a definition never claims these work. */
export const LORE_UNSUPPORTED_CAPABILITIES = Object.freeze({
  'experience-path-v1': 'personal experience order (regression, time loops) separate from world time',
  'person-body-identity-v1': 'person/body separation for body swap, possession or reincarnation',
  'occurrence-participants-v1': 'two occurrences of one entity in one scene',
  'crossover-v1': 'one work reading several universes or continuities',
  'branch-inheritance-v1': 'IF continuity inheriting parent values before a fork point',
  'narrative-frame-v1': 'dream, hallucination or story-within-story frames',
  'partial-order-timeline-v1': 'timelines with unknown or simultaneous ordering',
  'unit-conversion-v1': 'converting values between units',
  'cross-field-constraint-v1': 'constraints that compare two fields',
  'relation-follow-v1': 'projections that follow a relation to another entity',
});
// Structure that decides how stored values are interpreted. Wording and aliases do not.
const structure = d => ({ kind: d.kind, valueType: d.valueType ?? null, owner: d.owner ?? null, cardinality: d.cardinality ?? null, direction: d.direction ?? null,
  symbol: d.symbol ?? null, requiredScopes: [...(d.requiredScopes ?? [])].sort(), subjectTypeIds: [...(d.subjectTypeIds ?? [])].sort(),
  constraints: [...(d.constraints ?? [])].sort((a, b) => a.op.localeCompare(b.op)), missingPolicy: d.missingPolicy ?? null });
const diff = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => hashLore(before[key] ?? null) !== hashLore(after[key] ?? null))
  .map(key => ({ field: key, before: before[key] ?? null, after: after[key] ?? null }));

/**
 * Search → reuse → candidate → validate. Pure planning over one pinned
 * registry: returns which needs reuse an existing definition, which are safe
 * additions, which need a migration review and which ask for unsupported behavior.
 */
export function planLoreDefinitionNeeds(registry, needs) {
  const compiled = compileLoreRegistry(registry);
  requireLore(Array.isArray(needs) && needs.length > 0 && needs.length <= 1000, 'INVALID_LORE_DATA', 'provide 1..1000 definition needs');
  const outcomes = [], additions = new Map(), supported = new Set(LORE_CAPABILITIES);
  for (const [index, need] of needs.entries()) {
    requireLore(need && typeof need === 'object' && need.definition && Object.keys(need).every(k => ['definition', 'why'].includes(k)), 'INVALID_LORE_DATA', `need ${index} must be {definition, why?}`);
    const d = need.definition;
    const missing = (Array.isArray(d.requiredCapabilities) ? d.requiredCapabilities : []).filter(c => !supported.has(c));
    if (missing.length) {
      outcomes.push({ index, outcome: 'unsupported', key: d.key, capabilities: missing.map(c => ({ capability: c, description: LORE_UNSUPPORTED_CAPABILITIES[c] ?? 'unknown capability' })),
        message: 'not registered: the engine does not interpret this behavior; adding a key would not make it work' });
      continue;
    }
    try { validateLoreDefinition(d); }
    catch (error) { if (error instanceof LoreError) { outcomes.push({ index, outcome: 'invalid', key: d.key, code: error.code, message: error.message }); continue; } throw error; }
    const names = [d.key, ...d.aliases].map(loreNameKey);
    const byId = compiled.definition(d.id) ?? additions.get(d.id);
    const byName = byId ? null : [...compiled.search({ query: d.key, namespace: d.namespace, limit: 100 }).results, ...d.aliases.flatMap(a => compiled.search({ query: a, namespace: d.namespace, limit: 100 }).results), ...additions.values()]
      .find(doc => doc.definition.namespace === d.namespace && [doc.definition.key, ...doc.definition.aliases].map(loreNameKey).some(n => names.includes(n)));
    const existing = byId ?? byName;
    if (!existing) { const revisionId = hashLore(d); additions.set(d.id, { revisionId, definition: d }); outcomes.push({ index, outcome: 'registered', key: d.key, definitionId: d.id, revisionId }); continue; }
    if (existing.revisionId === hashLore(d) || hashLore(structure(existing.definition)) === hashLore(structure(d))) {
      outcomes.push({ index, outcome: 'reused', key: d.key, definitionId: existing.definition.id, revisionId: existing.revisionId, matchedBy: byId ? 'id' : 'name',
        ...(existing.definition.id !== d.id ? { proposedId: d.id } : {}), existingDefinition: existing.definition.definition });
      continue;
    }
    outcomes.push({ index, outcome: 'migration_required', key: d.key, definitionId: existing.definition.id, revisionId: existing.revisionId, matchedBy: byId ? 'id' : 'name',
      changes: diff(structure(existing.definition), structure(d)), proposed: d,
      message: 'an existing definition would change meaning, type, owner or scope; review a migration instead of adding a second definition' });
  }
  return { registryRevisionId: compiled.revisionId, outcomes, additions: [...additions.values()].map(a => a.definition) };
}
