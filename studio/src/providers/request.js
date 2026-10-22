import {
  canonicalDigest,
  canonicalJSON,
  fail,
  assertText,
} from "../engine/contracts.js";
import { models, voices } from "./capabilities.js";
export function validateGoogleRequest(
  p,
  { binding = null, utterance = null } = {},
) {
  if (!models[p.kind]?.includes(p.input.model))
    fail(
      "CAPABILITY_UNAVAILABLE",
      "Model is unavailable on the configured Google surface.",
    );
  const c = p.input.config ?? {};
  const allowed =
    p.kind === "audio"
      ? ["voice", "acting"]
      : p.kind === "image"
        ? ["aspectRatio", "imageSize"]
        : ["schema"];
  if (Object.keys(c).some((k) => !allowed.includes(k)))
    fail("INVALID_PROVIDER_CONFIG", "Unsupported Google configuration.");
  if (p.kind === "audio") {
    if (
      !voices.includes(c.voice) &&
      !/^voice_[A-Za-z0-9_-]+$/.test(c.voice ?? "")
    )
      fail("INVALID_VOICE", "Select a prebuilt or explicitly stored voice ID.");
    if (
      c.acting !== undefined &&
      typeof c.acting !== "string" &&
      (c.acting === null ||
        typeof c.acting !== "object" ||
        Array.isArray(c.acting))
    )
      fail(
        "INVALID_PROVIDER_CONFIG",
        "Acting must be text or structured directions.",
      );
    const override = p.recipe?.auditionOverride;
    if (override) {
      assertText(override.actor);
      assertText(override.reason);
      if (Object.keys(override).some((k) => !["actor", "reason"].includes(k)))
        fail("INVALID_INPUT", "Unsupported audition authorization.");
    }
    if (binding && !override) {
      if (c.voice !== binding.casting.voice)
        fail(
          "VOICE_INTENT_MISMATCH",
          "Requested voice differs from current casting.",
        );
      if (
        canonicalDigest(c.acting ?? "") !==
        canonicalDigest(utterance?.acting ?? "")
      )
        fail(
          "ACTING_INTENT_MISMATCH",
          "Requested acting differs from this utterance.",
        );
    }
  }
  if (p.kind === "image") {
    if (c.imageSize && !["1K", "2K", "4K"].includes(c.imageSize))
      fail("INVALID_PROVIDER_CONFIG", "Unsupported image size.");
    if (
      c.aspectRatio &&
      ![
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "4:5",
        "5:4",
        "9:16",
        "16:9",
        "21:9",
      ].includes(c.aspectRatio)
    )
      fail("INVALID_PROVIDER_CONFIG", "Unsupported aspect ratio.");
    if (
      (p.input.blobIds ?? p.input.blobs ?? []).length >
      (p.input.model === "gemini-3-pro-image" ? 5 : 14)
    )
      fail(
        "INVALID_PROVIDER_CONFIG",
        "Reference count exceeds conservative adapter limit.",
      );
  }
  if (p.kind === "text" && (!c.schema || typeof c.schema !== "object"))
    fail(
      "INVALID_PROVIDER_CONFIG",
      "A structured proposal schema is required.",
    );
  return {
    configVerification:
      p.kind === "audio" && binding
        ? p.recipe?.auditionOverride
          ? "explicit_audition_override"
          : "request_matches_current_intent"
        : "validated_provider_config",
    surface: "google-developer-interactions-v1beta",
  };
}
export function googleBody(input) {
  const c = input.config ?? {};
  const body = { model: input.model, store: true, stream: false };
  if (input.kind === "audio") {
    const content = { type: "text", text: input.prompt };
    if (c.acting)
      content.annotations = [
        {
          type: "speech_metadata",
          style:
            typeof c.acting === "string" ? c.acting : canonicalJSON(c.acting),
        },
      ];
    return {
      ...body,
      input: [{ type: "user_input", content: [content] }],
      response_format: {
        type: "audio",
        mime_type: "audio/wav",
        sample_rate: 24000,
      },
      generation_config: { speech_config: [{ voice: c.voice }] },
    };
  }
  if (input.kind === "text")
    return {
      ...body,
      input: input.prompt,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: c.schema,
      },
    };
  return {
    ...body,
    input: [
      { type: "text", text: input.prompt },
      ...(input.blobs ?? []).map((b) => ({
        type: "image",
        mime_type: "image/png",
        data: Buffer.from(b.bytes).toString("base64"),
      })),
    ],
    response_format: {
      type: "image",
      ...(c.aspectRatio ? { aspect_ratio: c.aspectRatio } : {}),
      ...(c.imageSize ? { image_size: c.imageSize } : {}),
    },
  };
}
