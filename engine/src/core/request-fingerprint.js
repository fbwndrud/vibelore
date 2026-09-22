import { createHash } from 'node:crypto';

/** Stable identity for one semantic provider request across processes and hosts. */
export function deriveRequestFingerprint(req) {
  const canonical = {
    step: req.step ?? 'unknown',
    provider: req.model.provider,
    modelId: req.model.modelId,
    jsonMode: req.jsonMode ?? false,
    temperature: req.temperature ?? null,
    maxTokens: req.maxTokens ?? null,
    ...(req.model.reasoningEffort ? { reasoningEffort: req.model.reasoningEffort } : {}),
    messages: req.messages.map((message) => ({ role: message.role, content: message.content })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
