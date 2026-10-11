import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLoreRegistry, addLoreDefinitions, compileLoreRegistry, createLoreResolver, lorePresetDefinitions, planLoreDefinitionNeeds } from '../../src/index.js';

const initial = () => addLoreDefinitions(createLoreRegistry('u1'), { definitions: lorePresetDefinitions('u1', 'fantasy'), reason: '설정의 초기 추천값' }).registry;
const field = overrides => ({ schemaVersion: 1, kind: 'field', id: 'field-regression-count', namespace: 'u1', key: 'regression.count', label: '회귀 횟수', aliases: ['회귀 수'], definition: '인물이 경험한 회귀 횟수', subjectTypeIds: ['type-character'], valueType: { kind: 'integer' }, owner: 'state', requiredScopes: ['continuity', 'worldPoint'], cardinality: 'one', constraints: [{ op: 'minimum', value: 0 }], missingPolicy: 'unknown', requiredCapabilities: ['numeric-value-v1'], ...overrides });
function fixture(registry = initial()) {
  const compiled = compileLoreRegistry(registry);
  const entities = ['a', 'b'].map(id => ({ id, typeDefinitionRevisionId: compiled.definition('type-character').revisionId }));
  const timelines = [
    { id: 't-main', continuityId: 'main', pointIds: ['before', 'transformed', 'recovered'] },
    { id: 't-if', continuityId: 'if', pointIds: ['before', 'transformed', 'recovered'] },
  ];
  const value = (id, amount, fromPointId, untilPointId = null, continuityId = 'main', timelineId = 't-main') => ({
    id, subject: { kind: 'entity', entityId: 'a' }, fieldDefinitionRevisionId: compiled.definition('field-mana-capacity').revisionId,
    owner: 'state', value: amount, storyScope: { continuityId, timelineId, fromPointId, untilPointId }, evidenceIds: [`source-${id}`],
  });
  const values = [value('v-before', 30, 'before', 'transformed'), value('v-after', 120, 'transformed', 'recovered'), value('v-recovered', 60, 'recovered'), value('v-if', 999, 'before', null, 'if', 't-if')];
  const query = (pointId = 'transformed', extra = {}) => ({ subjectId: 'a', fieldId: 'field-mana-capacity', scope: { continuityId: 'main', timelineId: 't-main', pointId }, ...extra });
  return { registry, entities, timelines, values, value, query };
}

describe('SharedLore public library contract', () => {
  it('adds AI vocabulary without engine edits, reuses aliases, and preserves the pinned older registry', () => {
    const previous = initial(), proposal = field();
    const next = addLoreDefinitions(previous, { definitions: [proposal], reason: '새 회귀 작품에 필요' });
    proposal.valueType.kind = 'text';
    assert.equal(compileLoreRegistry(previous).definition('field-regression-count'), null);
    const compiled = compileLoreRegistry(next.registry);
    assert.equal(compiled.definition('field-regression-count').definition.valueType.kind, 'integer');
    assert.equal(compiled.search({ query: ' 회귀 수 ' }).results[0].match, 'exact');
    assert.equal(compiled.search({ query: '회귀' }).results[0].match, 'candidate');
    assert.equal(compiled.search({ limit: 1 }).incomplete, true);
    assert.equal(addLoreDefinitions(next.registry, { definitions: [field()], reason: '동일 제안 재시도' }).registry.revisionId, next.registry.revisionId);
    assert.equal(next.registry.parentRevisionId, previous.revisionId);
    assert.equal(Object.isFrozen(compiled.definition('field-regression-count').definition), true);
  });

  it('rejects meaning, type and owner changes, alias collisions, unknown operators and unsupported capabilities', () => {
    const r = addLoreDefinitions(initial(), { definitions: [field()], reason: '회귀' }).registry;
    for (const patch of [{ owner: 'fact' }, { valueType: { kind: 'text' }, constraints: [] }, { definition: '완전히 다른 뜻' }]) {
      assert.throws(() => addLoreDefinitions(r, { definitions: [field(patch)], reason: '변경' }), { code: 'DEFINITION_MIGRATION_REQUIRED' });
    }
    assert.throws(() => addLoreDefinitions(r, { definitions: [field({ id: 'other-field', key: 'other', aliases: ['회귀 수'] })], reason: '별칭 충돌' }), { code: 'DEFINITION_CONFLICT' });
    assert.throws(() => addLoreDefinitions(r, { definitions: [field({ id: 'other-field', key: 'other', aliases: [], requiredCapabilities: ['experience-path-v1'] })], reason: '미지원 시간축' }), { code: 'REQUIRED_CAPABILITY' });
    assert.throws(() => addLoreDefinitions(r, { definitions: [field({ constraints: [{ op: 'execute', value: 0 }] })], reason: '실행 불가' }), { code: 'INVALID_LORE_DATA' });
    assert.throws(() => addLoreDefinitions(r, { definitions: [field({ requiredScopes: ['experience'] })], reason: '미지원 범위' }), { code: 'INVALID_LORE_DATA' });
    assert.throws(() => addLoreDefinitions(r, { definitions: [field({ subjectTypeIds: ['missing-type'] })], reason: '누락 참조' }), { code: 'DEFINITION_MIGRATION_REQUIRED' });
    assert.throws(() => addLoreDefinitions(initial(), { definitions: [field({ subjectTypeIds: ['missing-type'] })], reason: '누락 참조' }), { code: 'INVALID_DEFINITION_REFERENCE' });
    // The planner agrees with the registry: the same ID with new meaning text is a migration, not a reuse.
    const planned = planLoreDefinitionNeeds(r, [{ definition: field({ definition: '완전히 다른 뜻' }) }]).outcomes[0];
    assert.equal(planned.outcome, 'migration_required'); assert.equal(planned.changes[0].field, 'definition');
    const tampered = JSON.parse(JSON.stringify(r)); tampered.definitions[0].definition.label = '변조';
    assert.throws(() => compileLoreRegistry(tampered), { code: 'LORE_INTEGRITY' });
  });

  it('allows a new namespace while stable IDs remain unique in one universe', () => {
    const r = addLoreDefinitions(initial(), { definitions: [field()], reason: '기본' }).registry;
    const different = field({ id: 'other-field', namespace: 'other-work' });
    const next = addLoreDefinitions(r, { definitions: [different], reason: '다른 namespace' }).registry;
    assert.equal(compileLoreRegistry(next).search({ query: 'regression.count' }).results.length, 2);
    assert.equal(compileLoreRegistry(next).search({ query: 'regression.count', namespace: 'u1' }).results.length, 1);
  });

  it('resolves before/after transformations and IF values at explicit ordered points without changing identity', () => {
    const f = fixture(), resolver = createLoreResolver(f);
    assert.equal(resolver.resolve(f.query('before')).value, 30);
    assert.equal(resolver.resolve(f.query()).value, 120);
    assert.equal(resolver.resolve(f.query('recovered')).value, 60);
    assert.equal(resolver.resolve(f.query('before', { scope: { continuityId: 'if', timelineId: 't-if', pointId: 'before' } })).value, 999);
    assert.equal(resolver.resolve(f.query('before', { subjectId: 'b' })).status, 'unknown');
    f.values[1].value = 1; assert.equal(resolver.resolve(f.query()).value, 120);
    assert.throws(() => resolver.resolve(f.query('nonexistent')), { code: 'INVALID_STORY_SCOPE' });
    assert.throws(() => resolver.resolve(f.query('before', { scope: { continuityId: 'if', timelineId: 't-main', pointId: 'before' } })), { code: 'INVALID_STORY_SCOPE' });
    assert.throws(() => resolver.resolve(f.query('before', { scope: {} })), { code: 'INVALID_LORE_DATA' });
  });

  it('does not choose the latest conflicting value or mistake a budget shortfall for absence', () => {
    const f = fixture(); f.values.push(f.value('v-conflict', 121, 'transformed', 'recovered'));
    const resolver = createLoreResolver(f), conflict = resolver.resolve(f.query());
    assert.equal(conflict.status, 'conflict'); assert.equal(conflict.candidates.length, 2);
    const incomplete = resolver.resolve(f.query('before', { maxCandidates: 1 }));
    assert.equal(incomplete.status, 'incomplete'); assert.ok(!Object.hasOwn(incomplete, 'value'));
    assert.equal(resolver.resolve(f.query()).inputRevisionId, resolver.inputRevisionId);
    const equal = fixture(); equal.values.push(equal.value('v-confirmation', 120, 'transformed', 'recovered'));
    assert.deepEqual(createLoreResolver(equal).resolve(equal.query()).valueIds, ['v-after', 'v-confirmation']);
  });

  it('validates field shape, numeric bounds, ownership, exact scopes and pinned references before queries', () => {
    for (const [patch, code] of [
      [{ value: '120' }, 'INVALID_FIELD_VALUE'], [{ value: -1 }, 'INVALID_FIELD_VALUE'],
      [{ owner: 'fact' }, 'LORE_OWNERSHIP_CONFLICT'], [{ fieldDefinitionRevisionId: 'latest' }, 'INVALID_DEFINITION_REFERENCE'],
      [{ storyScope: { continuityId: 'main', timelineId: 't-main', fromPointId: 'recovered', untilPointId: 'before' } }, 'INVALID_STORY_SCOPE'],
      [{ storyScope: { continuityId: 'main', timelineId: 't-main', fromPointId: 'before', untilPointId: null, hiddenAxis: 'x' } }, 'INVALID_LORE_DATA'],
    ]) {
      const f = fixture(); Object.assign(f.values[0], patch);
      assert.throws(() => createLoreResolver(f), { code });
    }
    const f = fixture(); f.values[0].value = NaN;
    assert.throws(() => createLoreResolver(f), { code: 'INVALID_LORE_DATA' });
  });

  it('keeps boolean false distinct from unknown, and observer/occurrence scopes distinct from world truth', () => {
    const bool = field({ id: 'believes-alive', key: 'belief.alive', valueType: { kind: 'boolean' }, owner: 'observer', requiredScopes: ['continuity', 'observer', 'occurrence'], constraints: [] });
    const registry = addLoreDefinitions(initial(), { definitions: [bool], reason: '관점의 믿음' }).registry;
    const f = fixture(registry), revision = compileLoreRegistry(registry).definition(bool.id).revisionId;
    f.values = [{ id: 'belief', subject: { kind: 'entity', entityId: 'a' }, fieldDefinitionRevisionId: revision, owner: 'observer', value: false, storyScope: { continuityId: 'main', observerId: 'b', occurrenceId: 'future-self' }, evidenceIds: ['scene-a'] }];
    const resolver = createLoreResolver(f), query = { subjectId: 'a', fieldId: bool.id, scope: { continuityId: 'main', observerId: 'b', occurrenceId: 'future-self' } };
    assert.equal(resolver.resolve(query).value, false);
    assert.equal(resolver.resolve({ ...query, scope: { ...query.scope, occurrenceId: 'past-self' } }).status, 'unknown');
  });

  it('supports typed directed relations and multi-values without recursively embedding entities', () => {
    const relation = { ...field({ id: 'friend', key: 'relation.friend', valueType: { kind: 'reference', targetTypeIds: ['type-character'] }, owner: 'relation', requiredScopes: ['continuity'], constraints: [], cardinality: 'many' }), kind: 'relation', direction: 'directed' };
    const registry = addLoreDefinitions(initial(), { definitions: [relation], reason: '친구 관계' }).registry;
    const f = fixture(registry), revision = compileLoreRegistry(registry).definition('friend').revisionId;
    f.values = [['a', 'b'], ['b', 'a']].map(([from, to]) => ({ id: `${from}-${to}`, subject: { kind: 'entity', entityId: from }, fieldDefinitionRevisionId: revision, owner: 'relation', value: { entityId: to }, storyScope: { continuityId: 'main' }, evidenceIds: ['scene'] }));
    const resolver = createLoreResolver(f), query = { subjectId: 'a', fieldId: 'friend', scope: { continuityId: 'main' } };
    const result = resolver.resolve(query); assert.deepEqual(result.values[0].value, { entityId: 'b' });
    result.values[0].value.entityId = 'a'; assert.deepEqual(resolver.resolve(query).values[0].value, { entityId: 'b' });
    f.values[0].value.entityId = 'missing'; assert.throws(() => createLoreResolver(f), { code: 'INVALID_ENTITY_REFERENCE' });
  });
});
