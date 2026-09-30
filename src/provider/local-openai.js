import { readFile } from 'node:fs/promises';

/** Minimal OpenAI-compatible local model adapter (Ollama, LM Studio, llama.cpp). */
export function createLocalOpenAIProvider({ baseUrl, model, fetchImpl = globalThis.fetch, timeoutMs = 120000 }) {
  if (!baseUrl || !model) throw new Error('local provider requires baseUrl and model');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid local model timeout');
  const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  return {
    provenance: { kind: 'local-openai', model, contextIsolation: 'request-messages-only' },
    register: () => undefined,
    has: () => true,
    get pending() { return []; },
    async complete(req) {
      // A profile entry with provider `local` picks the local model per stage;
      // anything else keeps the configured model.
      const routed = req.model?.provider === 'local' && req.model.modelId ? req.model.modelId : model;
      const reasoningEffort = req.model?.reasoningEffort;
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: routed,
          messages: await withImages(req.messages, req.images),
          stream: false,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      if (!response.ok) throw new Error(`local model failed: HTTP ${response.status}`);
      const body = await response.json();
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('local model returned no message content');
      return { text };
    },
  };
}

/**
 * Image reviews name the files to open; attach them to the last user message as
 * data URLs. Whether the model can see them is the model's and endpoint's call,
 * not the adapter's: a text-only endpoint answers with its own error.
 */
async function withImages(messages = [], images = []) {
  if (!images?.length) return messages;
  const last = messages.findLastIndex((m) => m.role === 'user');
  if (last < 0) return messages;
  const parts = await Promise.all(images.map(async ({ path, mime }) =>
    ({ type: 'image_url', image_url: { url: `data:${mime};base64,${(await readFile(path)).toString('base64')}` } })));
  return messages.map((m, i) => (i === last ? { ...m, content: [{ type: 'text', text: m.content }, ...parts] } : m));
}
