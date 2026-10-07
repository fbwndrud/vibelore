// Seeds are suggestions, not narrative invariants. All fields use the same interpreter.
const base = (namespace, kind, id, key, label, definition) => ({ schemaVersion: 1, namespace, kind, id, key, label, definition, aliases: [], requiredCapabilities: [] });
export function lorePresetDefinitions(namespace, preset = 'base') {
  const character = base(namespace, 'entityType', 'type-character', 'character', '인물', '세계에서 정체성을 유지하는 인물');
  const location = base(namespace, 'entityType', 'type-location', 'location', '장소', '세계 안의 장소');
  const item = base(namespace, 'entityType', 'type-item', 'item', '물품', '세계 안의 개별 물품');
  const field = (id, key, label, valueType, owner, subjectTypeIds, requiredScopes) => ({
    ...base(namespace, 'field', id, key, label, `${label}의 명시된 설정값`),
    valueType, owner, subjectTypeIds, requiredScopes, cardinality: 'one', constraints: [], missingPolicy: 'unknown',
  });
  const definitions = [character, location, item,
    field('field-life-status', 'life.status', '생존 상태', { kind: 'enum', values: ['alive', 'dead'] }, 'fact', ['type-character'], ['continuity', 'worldPoint']),
    field('field-location', 'location.current', '현재 장소', { kind: 'reference', targetTypeIds: ['type-location'] }, 'fact', ['type-character', 'type-item'], ['continuity', 'worldPoint']),
    { ...field('relation-item-owner', 'item.owner', '물품 소유자', { kind: 'reference', targetTypeIds: ['type-character'] }, 'relation', ['type-item'], ['continuity', 'worldPoint']), kind: 'relation', direction: 'directed' },
  ];
  if (preset === 'base') return definitions;
  if (preset !== 'fantasy') throw new Error('INVALID_LORE_PRESET: supported presets are base and fantasy');
  return [...definitions, { ...base(namespace, 'unit', 'unit-mana', 'mana.point', '마나 단위', '세계의 마나량을 기록하는 단위'), symbol: 'MP' },
    { ...field('field-mana-capacity', 'mana.capacity', '마나 최대량', { kind: 'number', unitId: 'unit-mana' }, 'state', ['type-character'], ['continuity', 'worldPoint']), aliases: ['최대 MP'], constraints: [{ op: 'minimum', value: 0 }] },
  ];
}
