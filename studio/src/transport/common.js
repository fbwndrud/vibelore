import { StudioError, assertId, assertInteger } from '../engine/contracts.js';
export const JSON_LIMIT = 1024 * 1024;
export const IMPORT_LIMIT = 128 * 1024 * 1024;
export const importTypes = new Set([
  'source.import',
  'source.manuscript',
  'asset.import',
  'asset.derive',
  'source.importBundle',
  'asset.importBundle',
]);
export class TransportError extends Error {
  constructor(code, status = 400) {
    super('Studio request failed.');
    this.code = code;
    this.status = status;
  }
}
export function publicFailure(error) {
  const trusted =
    error instanceof StudioError || error instanceof TransportError;
  const code = trusted ? error.code : 'INTERNAL_ERROR';
  const status =
    error instanceof TransportError
      ? error.status
      : /CONFLICT|EXISTS|IMMUTABLE/.test(code)
      ? 409
      : /NOT_FOUND|MISSING|PROJECT_NOT_FOUND/.test(code)
      ? 404
      : trusted
      ? 400
      : 500;
  return { status, error: { code, message: 'Studio request failed.' } };
}
export function queryProject(url) {
  return assertId(url.searchParams.get('projectId'));
}
export function queryCursor(value = '0') {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new TransportError('INVALID_CURSOR');
  const cursor = Number(value);
  assertInteger(cursor);
  return cursor;
}
export function parseJSON(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new TransportError('INVALID_JSON');
  }
}
export async function readJSON(request, limit) {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers['content-type'] ?? '',
    )
  )
    throw new TransportError('UNSUPPORTED_MEDIA_TYPE', 415);
  const declared = request.headers['content-length'];
  if (
    declared !== undefined &&
    (!/^\d+$/.test(declared) || Number(declared) > limit)
  )
    throw new TransportError('BODY_TOO_LARGE', 413);
  const bytes = await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      request.off('data', data);
      request.off('end', end);
      request.off('error', error);
      request.off('aborted', aborted);
    };
    const error = () => {
      cleanup();
      reject(new TransportError('INVALID_BODY'));
    };
    const aborted = error;
    const data = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        request.resume();
        reject(new TransportError('BODY_TOO_LARGE', 413));
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    request.on('data', data);
    request.once('end', end);
    request.once('error', error);
    request.once('aborted', aborted);
  });
  return parseJSON(bytes);
}
export const capabilities = (sourceCapture, library) => ({
  sourceCapture: { available: Boolean(sourceCapture) },
  library: {
    available: Boolean(library),
    ...(!library
      ? {
          setup:
            'Start Studio with --library <directory>, then explicitly connect owners and projects.',
        }
      : {}),
  },
});

export function requireLibrary(library) {
  if (!library) throw new TransportError('LIBRARY_UNAVAILABLE', 503);
  return library;
}
