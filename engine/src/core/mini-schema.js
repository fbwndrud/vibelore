/**
 * mini-schema — zero-dependency zod stand-in (NEP-S1).
 *
 * `@vibelore/novel-engine` is a build-free Node 22 ESM package with no external
 * npm deps. The ported engine used a tiny slice of the `zod` surface in three
 * files (sentinel-schema, entity-profile, entity-seed). This module reproduces
 * *exactly* that slice with the same success/fail semantics so those files run
 * unchanged against `import { z } from '../core/mini-schema.js'`.
 *
 * Implemented surface (grep-verified against the 3 consumers):
 *   z.object(shape)            .passthrough() .optional() .safeParse() .parse()
 *   z.string()                 .min(n) .max(n) .optional()
 *   z.number()                 .int() .min(n) .max(n) .optional()
 *   z.literal(value)
 *   z.array(schema)            .min(n) .max(n) .default(v) .optional()
 *   z.record(keySchema, valueSchema)   .default(v) .optional()
 *   z.unknown()
 *   z.enum(values)
 *   z.discriminatedUnion(key, [objectSchemas])
 *
 * safeParse(x) -> { success: true, data } | { success: false, error: { issues } }
 * where each issue is { path: (string|number)[], message: string } — matching the
 * `error.issues.map(i => `${i.path.join('.')}:${i.message}`)` consumer in
 * sentinel-schema. parse(x) returns data or throws.
 */

function fail(path, message) {
  return { ok: false, issues: [{ path, message }] };
}

class Schema {
  constructor() {
    this._optional = false;
    this._hasDefault = false;
    this._default = undefined;
  }

  optional() {
    this._optional = true;
    return this;
  }

  default(value) {
    this._hasDefault = true;
    this._default = value;
    return this;
  }

  // Internal: resolve optional/default before delegating to the concrete check.
  // Returns { ok, value, omit? } or { ok: false, issues }.
  _run(value, path) {
    if (value === undefined) {
      if (this._hasDefault) {
        const d = this._default;
        return { ok: true, value: typeof d === 'function' ? d() : d };
      }
      if (this._optional) {
        return { ok: true, value: undefined, omit: true };
      }
    }
    return this._check(value, path);
  }

  // eslint-disable-next-line no-unused-vars
  _check(value, path) {
    return { ok: true, value };
  }

  safeParse(value) {
    const r = this._run(value, []);
    if (r.ok) return { success: true, data: r.value };
    return { success: false, error: { issues: r.issues } };
  }

  parse(value) {
    const r = this._run(value, []);
    if (r.ok) return r.value;
    const err = new Error(
      r.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') || 'validation failed',
    );
    err.issues = r.issues;
    throw err;
  }
}

class StringSchema extends Schema {
  constructor() {
    super();
    this._min = null;
    this._max = null;
  }

  min(n) {
    this._min = n;
    return this;
  }

  max(n) {
    this._max = n;
    return this;
  }

  _check(value, path) {
    if (typeof value !== 'string') return fail(path, 'Expected string');
    if (this._min !== null && value.length < this._min) {
      return fail(path, `String must contain at least ${this._min} character(s)`);
    }
    if (this._max !== null && value.length > this._max) {
      return fail(path, `String must contain at most ${this._max} character(s)`);
    }
    return { ok: true, value };
  }
}

class NumberSchema extends Schema {
  constructor() {
    super();
    this._int = false;
    this._min = null;
    this._max = null;
  }

  int() {
    this._int = true;
    return this;
  }

  min(n) {
    this._min = n;
    return this;
  }

  max(n) {
    this._max = n;
    return this;
  }

  _check(value, path) {
    if (typeof value !== 'number' || Number.isNaN(value)) return fail(path, 'Expected number');
    if (this._int && !Number.isInteger(value)) return fail(path, 'Expected integer');
    if (this._min !== null && value < this._min) return fail(path, `Number must be >= ${this._min}`);
    if (this._max !== null && value > this._max) return fail(path, `Number must be <= ${this._max}`);
    return { ok: true, value };
  }
}

class LiteralSchema extends Schema {
  constructor(expected) {
    super();
    this._expected = expected;
  }

  _check(value, path) {
    if (value !== this._expected) {
      return fail(path, `Invalid literal value, expected ${JSON.stringify(this._expected)}`);
    }
    return { ok: true, value };
  }
}

class EnumSchema extends Schema {
  constructor(values) {
    super();
    this._values = Array.from(values);
  }

  _check(value, path) {
    if (!this._values.includes(value)) {
      return fail(path, `Invalid enum value, expected one of ${this._values.join(' | ')}`);
    }
    return { ok: true, value };
  }
}

class UnknownSchema extends Schema {
  _check(value) {
    return { ok: true, value };
  }
}

class ArraySchema extends Schema {
  constructor(element) {
    super();
    this._element = element;
    this._min = null;
    this._max = null;
  }

  min(n) {
    this._min = n;
    return this;
  }

  max(n) {
    this._max = n;
    return this;
  }

  _check(value, path) {
    if (!Array.isArray(value)) return fail(path, 'Expected array');
    if (this._min !== null && value.length < this._min) {
      return fail(path, `Array must contain at least ${this._min} element(s)`);
    }
    if (this._max !== null && value.length > this._max) {
      return fail(path, `Array must contain at most ${this._max} element(s)`);
    }
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const r = this._element._run(value[i], [...path, i]);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
}

class RecordSchema extends Schema {
  constructor(keySchema, valueSchema) {
    super();
    this._key = keySchema;
    this._value = valueSchema;
  }

  _check(value, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail(path, 'Expected object');
    }
    const out = {};
    for (const k of Object.keys(value)) {
      const kr = this._key._run(k, [...path, k]);
      if (!kr.ok) return kr;
      const vr = this._value._run(value[k], [...path, k]);
      if (!vr.ok) return vr;
      out[k] = vr.value;
    }
    return { ok: true, value: out };
  }
}

class ObjectSchema extends Schema {
  constructor(shape) {
    super();
    this._shape = shape;
    this._passthrough = false;
  }

  passthrough() {
    this._passthrough = true;
    return this;
  }

  _check(value, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail(path, 'Expected object');
    }
    const out = {};
    for (const key of Object.keys(this._shape)) {
      const r = this._shape[key]._run(value[key], [...path, key]);
      if (!r.ok) return r;
      if (!r.omit) out[key] = r.value;
    }
    if (this._passthrough) {
      for (const key of Object.keys(value)) {
        if (!(key in this._shape)) out[key] = value[key];
      }
    }
    return { ok: true, value: out };
  }
}

class DiscriminatedUnionSchema extends Schema {
  constructor(discriminator, options) {
    super();
    this._discriminator = discriminator;
    this._options = options;
  }

  _check(value, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail(path, 'Expected object');
    }
    const discVal = value[this._discriminator];
    for (const option of this._options) {
      const litSchema = option._shape[this._discriminator];
      if (litSchema && litSchema._run(discVal, [...path, this._discriminator]).ok) {
        return option._run(value, path);
      }
    }
    return fail(
      [...path, this._discriminator],
      `Invalid discriminator value ${JSON.stringify(discVal)}`,
    );
  }
}

export const z = {
  object: (shape) => new ObjectSchema(shape),
  string: () => new StringSchema(),
  number: () => new NumberSchema(),
  literal: (value) => new LiteralSchema(value),
  enum: (values) => new EnumSchema(values),
  unknown: () => new UnknownSchema(),
  array: (element) => new ArraySchema(element),
  record: (keySchema, valueSchema) => new RecordSchema(keySchema, valueSchema),
  discriminatedUnion: (discriminator, options) =>
    new DiscriminatedUnionSchema(discriminator, options),
};
