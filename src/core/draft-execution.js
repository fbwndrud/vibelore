import { createHash } from 'node:crypto';

import { runDraft } from '../../engine/src/generators/text/steps/draft.js';
import { compileDraftInputs } from './draft-input-compiler.js';

/** Object-key order only. String contents stay exact so NFD/NFC drafts do not collide. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;

/**
 * Shared production/pilot seam. It owns draft-input compilation and the exact
 * engine provider request; callers provide already pinned, resolved inputs.
 */
export async function executePinnedDraft({ resolvedInputs, memoryClaims = [] } = {}, { provider } = {}) {
  if (!resolvedInputs?.compiler || !resolvedInputs?.engine || typeof provider?.complete !== 'function') {
    return { ok: false, error: { code: 'INVALID_DRAFT_EXECUTION', reason: 'resolved-inputs-and-provider-required' } };
  }
  const compiled = compileDraftInputs({ ...resolvedInputs.compiler, memoryClaims });
  if (!compiled.ok) return compiled;
  let providerRequest = null;
  const providers = {
    async complete(request) {
      providerRequest = canonical(request);
      return provider.complete(request);
    },
  };
  const result = await runDraft({
    ...resolvedInputs.engine,
    plan: compiled.value.plan,
    slidingWindowRender: compiled.value.slidingWindowRender,
    customPromptOverride: compiled.value.customPromptOverride,
    providers,
  });
  if (!providerRequest) return { ok: false, error: { code: 'DRAFT_PROVIDER_NOT_CALLED' } };
  const comparableRequest = {
    model: providerRequest.model ?? null,
    step: providerRequest.step ?? null,
    jsonMode: providerRequest.jsonMode ?? null,
    messages: providerRequest.messages ?? [],
  };
  return {
    ok: true,
    value: {
      raw: result.raw,
      compiled: compiled.value,
      providerRequest,
      providerRequestHash: digest(comparableRequest),
    },
  };
}
