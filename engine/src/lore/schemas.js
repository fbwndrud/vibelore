// Creative vocabulary is data. These shapes describe only implemented behavior.
const text = { type: 'string', minLength: 1, maxLength: 8000 };
const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' };
const strings = (items = text, minItems = 0) => ({ type: 'array', items, minItems, maxItems: 1000 });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const choice = values => ({ type: 'string', enum: values });
const common = {
  schemaVersion: { type: 'integer', enum: [1] }, kind: choice(['entityType', 'unit', 'field', 'relation']),
  id, namespace: id, key: { ...id, maxLength: 120 }, label: text, aliases: strings(), definition: text,
  requiredCapabilities: strings(id),
};
const valueType = { anyOf: [
  object({ kind: choice(['text', 'boolean']) }),
  object({ kind: choice(['number', 'integer']), unitId: id }, ['kind']),
  object({ kind: choice(['enum']), values: strings(text, 1) }),
  object({ kind: choice(['reference']), targetTypeIds: strings(id, 1) }),
] };
const constraint = { anyOf: [
  object({ op: choice(['minimum', 'maximum']), value: { type: 'number' } }),
  object({ op: choice(['minLength', 'maxLength']), value: { type: 'integer', minimum: 0 } }),
] };
const fields = {
  subjectTypeIds: strings(id, 1), valueType,
  owner: choice(['profile', 'state', 'fact', 'relation', 'observer']),
  requiredScopes: strings(choice(['continuity', 'worldPoint', 'observer', 'occurrence'])),
  cardinality: choice(['one', 'many']), constraints: { type: 'array', items: constraint, maxItems: 20 },
  missingPolicy: choice(['unknown']),
};
export const LORE_DEFINITION_SCHEMA = { anyOf: [
  object({ ...common, kind: choice(['entityType']) }),
  object({ ...common, kind: choice(['unit']), symbol: text }),
  object({ ...common, ...fields, kind: choice(['field']) }),
  object({ ...common, ...fields, kind: choice(['relation']), owner: choice(['relation']),
    valueType: object({ kind: choice(['reference']), targetTypeIds: strings(id, 1) }), direction: choice(['directed']) }),
] };

export class LoreError extends Error {
  constructor(code, message, details = {}) { super(`${code}: ${message}`); this.name = 'LoreError'; this.code = code; this.details = details; }
}
export function requireLore(condition, code, message, details) {
  if (!condition) throw new LoreError(code, message, details);
}

/** Deliberately small validator for our closed meta-schema, never user executable code. */
export function validateShape(schema, value, path = 'definition', depth = 0) {
  const fail = message => { throw new LoreError('INVALID_LORE_DATA', `${path} ${message}`); };
  if (depth > 32) fail('exceeds nesting limit');
  if (schema.anyOf) {
    if (!schema.anyOf.some(part => { try { validateShape(part, value, path, depth + 1); return true; } catch { return false; } })) fail('does not match a supported shape');
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) fail('has an unsupported value');
  switch (schema.type) {
    case 'object':
      if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('must be a plain object');
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`requires ${key}`);
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('contains a reserved key');
        if (!Object.hasOwn(schema.properties, key)) { if (schema.additionalProperties === false) fail(`contains unknown property ${key}`); }
        else validateShape(schema.properties[key], child, `${path}.${key}`, depth + 1);
      }
      break;
    case 'array':
      if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 10000)) fail('has an invalid array length');
      value.forEach((child, i) => validateShape(schema.items, child, `${path}[${i}]`, depth + 1));
      break;
    case 'string':
      if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 8000) || (schema.pattern && !new RegExp(schema.pattern).test(value))) fail('has an invalid string');
      break;
    case 'number': case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value)) || value < (schema.minimum ?? -Infinity)) fail('has an invalid number');
      break;
    case 'boolean': if (typeof value !== 'boolean') fail('must be boolean'); break;
  }
}

export const LORE_ID_SCHEMA = id;
