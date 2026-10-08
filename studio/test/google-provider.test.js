import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { googleHttp, interaction } from "./helpers/google-http.js";
import { png, wav } from "./helpers/images.js";
import {
  withAudioScene,
  generationCommand,
  validImageRequest,
} from "./helpers/project.js";
import { runWorker } from "../src/engine/worker.js";
async function provider(options = {}) {
  assert.ok(
    existsSync(new URL("../src/providers/google.js", import.meta.url)),
    "Google adapter must exist",
  );
  const { googleProvider } = await import("../src/providers/google.js");
  return googleProvider({
    key: "test-private-key",
    ...(!options.baseURL && !options.fetchImpl
      ? {
          fetchImpl: async () => {
            throw new Error("Test transport is not configured");
          },
        }
      : {}),
    ...options,
  });
}
test("Google sends Interactions snake_case and retains every real PNG output with unknown billing/model version", async (t) => {
  const bytes = await png([1, 2, 3, 255], 1, 1);
  const http = await googleHttp(t, () =>
    interaction(
      [1, 2].map(() => ({
        type: "image",
        mime_type: "image/png",
        data: bytes.toString("base64"),
      })),
    ),
  );
  const p = await provider(http);
  const ids = [];
  const r = await p.generate(
    {
      kind: "image",
      model: "gemini-nano-banana-2.1",
      prompt: "coat blue",
      config: { aspectRatio: "16:9", imageSize: "2K" },
      blobs: [{ bytes }],
    },
    { onOperation: (id) => ids.push(id) },
  );
  assert.equal(http.calls[0].url, "/v1beta/interactions");
  assert.equal(http.calls[0].key, "test-private-key");
  assert.equal(http.calls[0].body.response_format.image_size, "2K");
  assert.equal(http.calls[0].body.input[1].mime_type, "image/png");
  assert.deepEqual(ids, ["v1_fixture"]);
  assert.equal(r.outputs.length, 2);
  assert.deepEqual(r.outputs[0].bytes, bytes);
  assert.equal(r.usage, null);
  assert.equal(r.resolvedModel, null);
  assert.equal(r.returnedModel, "gemini-nano-banana-2.1");
});
test("Google unary audio preserves WAV bytes and speech style; indices never become alignment", async (t) => {
  const bytes = wav();
  const http = await googleHttp(t, () =>
    interaction(
      [
        {
          type: "audio",
          mime_type: "audio/wav",
          data: bytes.toString("base64"),
          annotations: [{ start_index: 0, end_index: 8 }],
        },
      ],
      { model: "gemini-3.8-flash-tts" },
    ),
  );
  const p = await provider(http);
  const r = await p.generate({
    kind: "audio",
    model: "gemini-3.8-flash-tts",
    prompt: "여기서 기다릴게.",
    config: { voice: "Kore", acting: "quiet" },
  });
  assert.equal(http.calls[0].body.input[0].content[0].text, "여기서 기다릴게.");
  assert.equal(
    http.calls[0].body.input[0].content[0].annotations[0].style,
    "quiet",
  );
  assert.deepEqual(http.calls[0].body.generation_config.speech_config, [
    { voice: "Kore" },
  ]);
  assert.deepEqual(r.outputs[0].bytes, bytes);
  assert.equal(r.outputs[0].alignment, undefined);
  assert.equal(r.returnedVoice, null);
});
test("Google rejects malformed base64, MIME mismatch and no-media completions without retry", async (t) => {
  for (const content of [
    [{ type: "image", mime_type: "image/png", data: "%%%" }],
    [{ type: "image", mime_type: "image/png", data: wav().toString("base64") }],
    [],
  ]) {
    const http = await googleHttp(t, () => interaction(content));
    const p = await provider(http);
    await assert.rejects(
      p.generate({
        kind: "image",
        model: "gemini-nano-banana-2.1",
        prompt: "x",
        config: {},
      }),
    );
    assert.equal(http.calls.length, 1);
  }
});
test("Google ambiguous 5xx and network loss remain unknown; durable ID enables only explicit lookup", async (t) => {
  const http = await googleHttp(t, (call) =>
    call.method === "GET"
      ? interaction(
          [
            {
              type: "audio",
              mime_type: "audio/wav",
              data: wav().toString("base64"),
            },
          ],
          { model: "gemini-3.8-flash-tts" },
        )
      : { status: 503, body: { error: "private provider message" } },
  );
  const p = await provider(http);
  await assert.rejects(
    p.generate({
      kind: "audio",
      model: "gemini-3.8-flash-tts",
      prompt: "x",
      config: { voice: "Kore" },
    }),
    (e) =>
      e.code === "PROVIDER_OUTCOME_UNKNOWN" && !e.message.includes("private"),
  );
  assert.equal(http.calls.length, 1);
  const inspected = await p.inspect("v1_fixture");
  assert.equal(inspected.status, "succeeded");
  assert.equal(http.calls[1].url, "/v1beta/interactions/v1_fixture");
  await assert.rejects(p.inspect("../evil"));
  const lost = await googleHttp(t, () => null);
  await assert.rejects(
    (await provider(lost)).generate({
      kind: "image",
      model: "gemini-nano-banana-2.1",
      prompt: "x",
      config: {},
    }),
    { code: "PROVIDER_OUTCOME_UNKNOWN" },
  );
  assert.equal(lost.calls.length, 1);
});
test("direct engine Google voice and acting mismatches fail before reservation; audition override is explicit", async (t) => {
  const f = await withAudioScene(t);
  const p = await provider();
  f.service.providers.google = p;
  await f.command(
    "casting.set",
    {
      id: "childcast",
      scope: "project",
      roleId: "actor",
      state: "childvoice",
      voice: "Kore",
    },
    { aggregate: { kind: "casting", id: "childcast" } },
  );
  const payload = (config) =>
    validImageRequest({
      provider: "google",
      kind: "audio",
      target: { kind: "utterance", id: "u1" },
      input: { model: "gemini-3.8-flash-tts", prompt: "같은 대사", config },
    });
  await assert.rejects(
    generationCommand(
      f,
      payload({ voice: "Charon", acting: { tone: "quiet" } }),
    ),
    { code: "VOICE_INTENT_MISMATCH" },
  );
  await assert.rejects(
    generationCommand(f, payload({ voice: "Kore", acting: "loud" })),
    { code: "ACTING_INTENT_MISMATCH" },
  );
  assert.equal((await f.service.snapshot("p1")).reservations.length, 0);
  await generationCommand(f, {
    ...payload({ voice: "Charon", acting: "loud" }),
    recipe: {
      auditionOverride: { actor: "creator", reason: "alternative performance" },
    },
  });
  const s = await f.service.snapshot("p1");
  assert.equal(s.attempts[0].request.input.config.voice, "Charon");
  assert.equal(s.attempts[0].request.utteranceBinding.casting.voice, "Kore");
});
test("configured Google capability rejects wrong surface/model and missing key without paid request", async () => {
  const p = await provider({ key: null });
  assert.equal((await p.capabilities()).available, false);
  await assert.rejects(
    p.generate({ kind: "image", model: "gemini-nano-banana-2.1", prompt: "x" }),
    { code: "PROVIDER_UNAVAILABLE" },
  );
  const q = await provider();
  await assert.rejects(
    q.generate({ kind: "audio", model: "gemini-2.5-flash-tts", prompt: "x" }),
    { code: "CAPABILITY_UNAVAILABLE" },
  );
});
test("worker persists returned interaction ID before a malformed output and preserves unknown reservation", async (t) => {
  const http = await googleHttp(t, () =>
    interaction([{ type: "audio", mime_type: "audio/wav", data: "%%%" }], {
      model: "gemini-3.8-flash-tts",
    }),
  );
  const f = await withAudioScene(t);
  f.service.providers.google = await provider(http);
  await f.command(
    "casting.set",
    {
      id: "childcast",
      scope: "project",
      roleId: "actor",
      state: "childvoice",
      voice: "Kore",
    },
    { aggregate: { kind: "casting", id: "childcast" } },
  );
  await generationCommand(
    f,
    validImageRequest({
      provider: "google",
      kind: "audio",
      target: { kind: "utterance", id: "u1" },
      input: {
        model: "gemini-3.8-flash-tts",
        prompt: "같은 대사",
        config: { voice: "Kore", acting: { tone: "quiet" } },
      },
    }),
  );
  await runWorker({ service: f.service, drain: true });
  const s = await f.service.snapshot("p1");
  assert.equal(s.attempts[0].operationId, "v1_fixture");
  assert.equal(s.attempts[0].status, "outcome_unknown");
  assert.equal(s.reservations[0].status, "held_unknown");
  assert.equal(http.calls.length, 1);
});
test("credentials use backend env or explicitly named existing Keychain only", async () => {
  assert.ok(
    existsSync(new URL("../src/providers/credentials.js", import.meta.url)),
    "Backend credential resolver must exist",
  );
  const { resolveGoogleCredential } = await import(
    "../src/providers/credentials.js"
  );
  let calls = [];
  const execute = async (...args) => {
    calls.push(args);
    return { stdout: "stored-test-secret\n" };
  };
  assert.equal(
    await resolveGoogleCredential({
      env: { GEMINI_API_KEY: "env-test-secret" },
      execute,
    }),
    "env-test-secret",
  );
  assert.equal(calls.length, 0);
  assert.equal(await resolveGoogleCredential({ env: {}, execute }), null);
  assert.equal(calls.length, 0);
  assert.equal(
    await resolveGoogleCredential({
      env: {},
      keychainService: "explicit-existing",
      platform: "darwin",
      execute,
    }),
    "stored-test-secret",
  );
  assert.deepEqual(calls[0][1], [
    "find-generic-password",
    "-s",
    "explicit-existing",
    "-w",
  ]);
});
test("MCP uses the same pre-reservation Google voice guard and never discloses the backend key", async (t) => {
  const { Readable, Writable } = await import("node:stream");
  const { serveStudioMcp } = await import("../src/transport/mcp.js");
  const f = await withAudioScene(t);
  f.service.providers.google = await provider();
  await f.command(
    "casting.set",
    {
      id: "childcast",
      scope: "project",
      roleId: "actor",
      state: "childvoice",
      voice: "Kore",
    },
    { aggregate: { kind: "casting", id: "childcast" } },
  );
  const payload = validImageRequest({
    subscriberId: "mcp-voice",
    provider: "google",
    kind: "audio",
    target: { kind: "utterance", id: "u1" },
    input: {
      model: "gemini-3.8-flash-tts",
      prompt: "같은 대사",
      config: { voice: "Charon", acting: { tone: "quiet" } },
    },
  });
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        clientInfo: { name: "test", version: "1" },
        capabilities: {},
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "studio_command",
        arguments: {
          envelope: {
            projectId: "p1",
            commandId: "mcp-mismatch",
            aggregate: { kind: "generation", id: "mcp-voice" },
            expectedRevision: 0,
            type: "generation.request",
            payload,
          },
        },
      },
    },
  ];
  let output = "";
  await serveStudioMcp({
    service: f.service,
    input: Readable.from(
      messages.map((x) => Buffer.from(JSON.stringify(x) + "\n")),
    ),
    output: new Writable({
      write(chunk, encoding, callback) {
        output += chunk;
        callback();
      },
    }),
  });
  assert.match(output, /VOICE_INTENT_MISMATCH/);
  assert.ok(!output.includes("test-private-key"));
  assert.equal((await f.service.snapshot("p1")).reservations.length, 0);
});
test("successful take retains desired/requested config proof separately from unknown emitted voice and model version", async (t) => {
  const http = await googleHttp(t, () =>
    interaction(
      [
        {
          type: "audio",
          mime_type: "audio/wav",
          data: wav().toString("base64"),
        },
      ],
      {
        model: "gemini-3.8-flash-tts",
        usage: {
          total_input_tokens: 12,
          total_output_tokens: 25,
          total_tokens: 37,
        },
      },
    ),
  );
  const f = await withAudioScene(t);
  f.service.providers.google = await provider(http);
  await f.command(
    "casting.set",
    {
      id: "childcast",
      scope: "project",
      roleId: "actor",
      state: "childvoice",
      voice: "Kore",
    },
    { aggregate: { kind: "casting", id: "childcast" } },
  );
  await generationCommand(
    f,
    validImageRequest({
      provider: "google",
      kind: "audio",
      target: { kind: "utterance", id: "u1" },
      input: {
        model: "gemini-3.8-flash-tts",
        prompt: "같은 대사",
        config: { voice: "Kore", acting: { tone: "quiet" } },
      },
    }),
  );
  await runWorker({ service: f.service, drain: true });
  const s = await f.service.snapshot("p1");
  const candidate = s.candidates[0];
  assert.equal(candidate.configVerification, "request_matches_current_intent");
  assert.equal(candidate.voiceVerification, "not_performed");
  assert.equal(candidate.providerProvenance.returnedVoice, null);
  assert.equal(candidate.providerProvenance.resolvedVersion, null);
  assert.equal(
    candidate.providerProvenance.returnedModel,
    "gemini-3.8-flash-tts",
  );
  assert.equal(candidate.actualAudioInput.config.voice, "Kore");
  assert.equal(s.attempts[0].usage.totalTokens, 37);
  assert.equal(s.reservations[0].status, "held_unknown");
});

test("Google rejects JPEG bytes mislabeled as PNG before dispatch and in returned image blocks", async (t) => {
  const { default: sharp } = await import("sharp");
  const jpeg = await sharp(await png([2, 3, 4, 255], 1, 1))
    .jpeg()
    .toBuffer();
  const http = await googleHttp(t, () =>
    interaction([
      { type: "image", mime_type: "image/png", data: jpeg.toString("base64") },
    ]),
  );
  const p = await provider(http);
  const input = {
    kind: "image",
    model: "gemini-nano-banana-2.1",
    prompt: "x",
    config: {},
  };
  await assert.rejects(p.generate({ ...input, blobs: [{ bytes: jpeg }] }), {
    code: "INVALID_PROVIDER_INPUT",
  });
  assert.equal(http.calls.length, 0);
  await assert.rejects(p.generate(input), { code: "INVALID_PROVIDER_RESULT" });
  assert.equal(http.calls.length, 1);
});

test("worker and retry recheck restored queued voice input before any HTTP dispatch", async (t) => {
  const f = await withAudioScene(t);
  await f.command(
    "casting.set",
    {
      id: "childcast",
      scope: "project",
      roleId: "actor",
      state: "childvoice",
      voice: "Kore",
    },
    { aggregate: { kind: "casting", id: "childcast" } },
  );
  f.service.providers.google = {
    capabilities: async () => ({
      kinds: ["audio"],
      models: ["gemini-3.8-flash-tts"],
    }),
  };
  await generationCommand(
    f,
    validImageRequest({
      provider: "google",
      kind: "audio",
      target: { kind: "utterance", id: "u1" },
      input: {
        model: "gemini-3.8-flash-tts",
        prompt: "같은 대사",
        config: { voice: "Charon", acting: { tone: "quiet" } },
      },
    }),
  );
  const http = await googleHttp(t, () => interaction([]));
  f.service.providers.google = await provider(http);
  await runWorker({ service: f.service, drain: true });
  const s = await f.service.snapshot("p1");
  assert.equal(http.calls.length, 0);
  assert.equal(s.attempts[0].status, "failed_definite");
  assert.equal(s.reservations[0].status, "released");
  await assert.rejects(
    f.command(
      "attempt.retry",
      { attemptId: s.attempts[0].id, estimateMicros: 1000 },
      { aggregate: { kind: "job", id: s.jobs[0].id } },
    ),
    { code: "VOICE_INTENT_MISMATCH" },
  );
  assert.equal((await f.service.snapshot("p1")).attempts.length, 1);
});
