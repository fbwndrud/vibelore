/** Validate the subset of JSON Schema declared by this server, without coercion. */
export function validateToolInput(schema, value, path = 'arguments', depth = 0) {
  const invalid = (reason) => { throw new Error(`INVALID_ARGUMENT: ${path} ${reason}`); };
  if (depth > 40) invalid('is too deeply nested');
  if (schema.enum && !schema.enum.includes(value)) invalid('is not an allowed value');
  if (Array.isArray(schema.anyOf)) {
    const accepted = schema.anyOf.some((option) => { try { validateToolInput(option, value, path, depth + 1); return true; } catch { return false; } });
    if (!accepted) invalid('does not match any allowed shape');
    return;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('must be an object');
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) invalid(`requires ${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid('contains a reserved key');
      if (Object.hasOwn(schema.properties ?? {}, key)) validateToolInput(schema.properties[key], child, `${path}.${key}`, depth + 1);
      else if (schema.additionalProperties === false) invalid('contains an unknown property');
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) invalid('must be an array');
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 10000)) invalid('has an invalid length');
    for (let i = 0; i < value.length; i++) validateToolInput(schema.items ?? {}, value[i], `${path}[${i}]`, depth + 1);
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid('must be a finite number');
    if (schema.type === 'integer' && !Number.isSafeInteger(value)) invalid('must be a safe integer');
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) invalid('is outside the allowed range');
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') invalid('must be a string');
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 8_000_000)) invalid('has an invalid length');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) invalid('has an invalid format');
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') invalid('must be a boolean');
}
