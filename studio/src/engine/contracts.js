import { createHash } from 'node:crypto';

export const STABLE_ID = /^[A-Za-z0-9_-]{1,120}$/;
export const BLOB_ID = /^[a-f0-9]{64}$/;

export class StudioError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioError';
    this.code = code;
    this.details = details;
  }
}
export function fail(code, message, details) { throw new StudioError(code, message, details); }
export function assertId(value) {
  if (typeof value !== 'string' || !STABLE_ID.test(value)) fail('INVALID_INPUT', 'Expected a stable identifier.');
  return value;
}
export function assertText(value) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', 'Expected nonempty text.');
}
export function assertInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_INPUT', 'Expected a nonnegative safe integer.');
}

// Strict JSON, recursively sorted keys. No coercion, getters or prototype payloads.
export function canonicalJSON(value) {
  const seen = new Set();
  function visit(input) {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== 'object' || seen.has(input)) fail('INVALID_INPUT', 'Expected finite, acyclic JSON.');
    const proto = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && proto !== Object.prototype && proto !== null) fail('INVALID_INPUT', 'Expected plain JSON objects.');
    seen.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Object.keys(input);
    for (const key of keys) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || !('value' in descriptors[key])) {
        fail('INVALID_INPUT', 'Unsafe JSON property.');
      }
    }
    let result;
    if (Array.isArray(input)) {
      if (keys.length !== input.length || keys.some((key, index) => key !== String(index))) fail('INVALID_INPUT', 'Expected dense JSON arrays.');
      result = `[${input.map(visit).join(',')}]`;
    } else {
      result = `{${keys.sort().map(key => `${JSON.stringify(key)}:${visit(descriptors[key].value)}`).join(',')}}`;
    }
    seen.delete(input);
    return result;
  }
  return visit(value);
}
export function canonicalDigest(value) { return createHash('sha256').update(canonicalJSON(value)).digest('hex'); }
export function validateEnvelope(envelope) {
  // Canonicalize first so no getter is invoked during field validation.
  const safe = JSON.parse(canonicalJSON(envelope));
  if (!safe || Array.isArray(safe)) fail('INVALID_INPUT', 'Expected a command envelope.');
  assertId(safe.projectId); assertId(safe.commandId);
  if (!safe.aggregate) fail('INVALID_INPUT', 'Expected an aggregate.');
  assertId(safe.aggregate.kind); assertId(safe.aggregate.id); assertInteger(safe.expectedRevision);
  if (typeof safe.type !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(safe.type)) fail('INVALID_INPUT', 'Expected a command type.');
  if (!safe.payload || Array.isArray(safe.payload) || typeof safe.payload !== 'object') fail('INVALID_INPUT', 'Expected a payload object.');
  return safe;
}
export function assertSynchronous(value) {
  if (value && typeof value.then === 'function') {
    // A mistakenly returned rejected promise must not produce an unhandled rejection.
    Promise.resolve(value).catch(() => {});
    fail('ASYNC_HANDLER', 'Transaction callbacks must be synchronous.');
  }
  return value;
}

const FILESYSTEM_REASONS = new Set(['EACCES', 'EEXIST', 'EIO', 'EISDIR', 'EMLINK', 'ENAMETOOLONG', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EROFS', 'EXDEV']);
export function publicError(error, code, filesystem = false) {
  if (error instanceof StudioError) return error;
  const details = filesystem && FILESYSTEM_REASONS.has(error?.code) ? { reason: error.code } : {};
  return new StudioError(code, 'The storage operation could not be completed.', details);
}
