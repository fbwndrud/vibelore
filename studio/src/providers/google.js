import { fail } from "../engine/contracts.js";
import { decodeMedia } from "../assets/decode.js";
import { googleCapabilities } from "./capabilities.js";
import { validateGoogleRequest, googleBody } from "./request.js";
function base64(value) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length % 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    fail("INVALID_PROVIDER_RESULT", "Malformed media encoding.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    fail("INVALID_PROVIDER_RESULT", "Noncanonical media encoding.");
  return bytes;
}
function assertPng(bytes, code) {
  if (
    !Buffer.from(bytes)
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    fail(code, "PNG container is required.");
}
async function parseInteraction(resource, kind) {
  if (resource.status !== "completed")
    fail("PROVIDER_OUTCOME_UNKNOWN", "Interaction has no completed result.");
  const outputs = [];
  for (const step of resource.steps ?? []) {
    if (step.type !== "model_output") continue;
    for (const block of step.content ?? []) {
      if (
        !["image", "audio", "text"].includes(block.type) ||
        (kind && block.type !== kind)
      )
        continue;
      if (block.type === "text") {
        if (kind && kind !== "text") continue;
        try {
          JSON.parse(block.text);
        } catch {
          if (kind === "text")
            fail(
              "INVALID_PROVIDER_RESULT",
              "Structured JSON output is malformed.",
            );
          continue;
        }
        outputs.push({
          mime: "application/json",
          bytes: Buffer.from(block.text),
        });
      } else {
        const mime = block.type === "image" ? "image/png" : "audio/wav";
        if (block.mime_type !== mime)
          fail("INVALID_PROVIDER_RESULT", "Unsupported output container.");
        const bytes = base64(block.data);
        if (block.type === "image") assertPng(bytes, "INVALID_PROVIDER_RESULT");
        const decoded = await decodeMedia(bytes, block.type);
        if (decoded.mime !== mime)
          fail("INVALID_PROVIDER_RESULT", "Container does not match MIME.");
        outputs.push({ mime, bytes });
      }
    }
  }
  if (!outputs.length)
    fail("INVALID_PROVIDER_RESULT", "No usable output was returned.");
  const usage = resource.usage
    ? Object.fromEntries(
        [
          ["total_input_tokens", "inputTokens"],
          ["total_output_tokens", "outputTokens"],
          ["total_tokens", "totalTokens"],
        ]
          .filter(
            ([key]) =>
              Number.isFinite(resource.usage[key]) && resource.usage[key] >= 0,
          )
          .map(([key, target]) => [target, resource.usage[key]]),
      )
    : null;
  return {
    outputs,
    providerRequestId: resource.id ?? null,
    returnedModel: resource.model ?? null,
    resolvedModel: null,
    returnedVoice: null,
    usage,
  };
}
export function googleProvider({
  key,
  baseURL = "https://generativelanguage.googleapis.com/v1beta",
  fetchImpl = fetch,
} = {}) {
  async function request(path, body, signal) {
    if (!key) fail("PROVIDER_UNAVAILABLE", "Google API key is not configured.");
    let response;
    try {
      response = await fetchImpl(`${baseURL}${path}`, {
        method: body ? "POST" : "GET",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch {
      fail("PROVIDER_OUTCOME_UNKNOWN", "Provider outcome is unknown.");
    }
    if (!response.ok)
      fail(
        response.status >= 500
          ? "PROVIDER_OUTCOME_UNKNOWN"
          : "PROVIDER_REJECTED",
        "Provider request did not return a usable result.",
      );
    try {
      return await response.json();
    } catch {
      fail("PROVIDER_OUTCOME_UNKNOWN", "Provider response was incomplete.");
    }
  }
  return {
    capabilities: async () => googleCapabilities(Boolean(key)),
    validateRequest(p, context) {
      if (!key)
        fail("PROVIDER_UNAVAILABLE", "Google API key is not configured.");
      return validateGoogleRequest(p, context);
    },
    async generate(input, { signal, onOperation } = {}) {
      if (!key)
        fail("PROVIDER_UNAVAILABLE", "Google API key is not configured.");
      validateGoogleRequest({ kind: input.kind, input, recipe: {} });
      for (const blob of input.blobs ?? []) {
        assertPng(blob.bytes, "INVALID_PROVIDER_INPUT");
        await decodeMedia(blob.bytes, "image");
      }
      const resource = await request(
        "/interactions",
        googleBody(input),
        signal,
      );
      if (
        typeof resource.id === "string" &&
        /^[A-Za-z0-9_-]+$/.test(resource.id)
      )
        await onOperation?.(resource.id);
      return parseInteraction(resource, input.kind);
    },
    async inspect(id, { signal } = {}) {
      if (typeof id !== "string" || !/^[-A-Za-z0-9_]{1,512}$/.test(id))
        fail("RECOVERY_UNAVAILABLE", "A saved Interaction ID is required.");
      const resource = await request(`/interactions/${id}`, null, signal);
      if (["in_progress", "requires_action"].includes(resource.status))
        return { status: "pending" };
      return { status: "succeeded", result: await parseInteraction(resource) };
    },
  };
}
