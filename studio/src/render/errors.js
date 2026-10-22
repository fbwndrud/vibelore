import { StudioError } from '../engine/contracts.js';

const CODES = new Set(['INVALID_WAV', 'UNSUPPORTED_WAV', 'OUTPUT_INVALID',
  'RENDER_ENVIRONMENT_CHANGED', 'VIDEO_RUNTIME_UNAVAILABLE', 'RENDER_LIMIT',
  'BLOB_UNAVAILABLE', 'BLOB_CORRUPT', 'MISSING_BLOB']);
const STORAGE = new Set(['ENOSPC', 'EIO', 'EACCES', 'EPERM', 'EROFS']);

// Never retain arbitrary exception codes, messages, commands, stderr or paths.
// Classification diagnoses an observed failure; it does not establish its cause.
export function renderFailure(error, stage) {
  const code = error instanceof StudioError && CODES.has(error.code) ? error.code : 'RENDER_FAILED';
  const causes = []; let current = error;
  for (let depth = 0; current && depth < 4; depth++, current = current.cause)
    causes.push({ code: current.code, text: typeof current.message === 'string' ? current.message : '' });
  let reason = 'unknown';
  if (causes.some(e => e.code === 'ETIMEDOUT' || /timeout|timed? out|delayRender/i.test(e.text))) reason = 'timeout';
  else if (STORAGE.has(error?.code)) reason = 'storage';
  else if (['INVALID_WAV', 'UNSUPPORTED_WAV', 'OUTPUT_INVALID'].includes(code)) reason = 'decode';
  else if (['RENDER_ENVIRONMENT_CHANGED', 'VIDEO_RUNTIME_UNAVAILABLE'].includes(code)) reason = 'runtime';
  else if (causes.some(e => /chrome|chromium|browser|page crashed/i.test(e.text))) reason = 'browser';
  return { errorCode: code, failure: { stage, reason } };
}
