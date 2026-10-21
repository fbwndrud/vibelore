import { physicalOwnerIdentity } from "../source/owner-io.js";
import { openLibrary } from "../library/index.js";
import { createStudioOwnerAdapter } from "../source/export-studio-assets.js";
import { createVibeloreOwnerAdapter } from "../source/export-vibelore-assets.js";
import { resolveGoogleCredential } from "../providers/credentials.js";
import { googleProvider } from "../providers/google.js";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { openStudio } from "../engine/index.js";
import { assertId, canonicalDigest } from "../engine/contracts.js";
import { TransportError } from "./common.js";
export function parseOptions(args) {
  const options = { port: 0, projectId: "p1" };
  const seen = new Set();
  const allowed = new Set([
    "--project",
    "--library",
    "--port",
    "--vibelore-root",
    "--project-id",
    "--google-key-env",
    "--google-keychain-service",
  ]);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1];
    if (
      !allowed.has(flag) ||
      !value ||
      value.startsWith("--") ||
      seen.has(flag)
    )
      throw new TransportError("INVALID_CONFIGURATION");
    seen.add(flag);
    if (flag === "--port") {
      if (!/^\d+$/.test(value) || Number(value) > 65535)
        throw new TransportError("INVALID_CONFIGURATION");
      options.port = Number(value);
    } else if (
      flag === "--google-key-env" ||
      flag === "--google-keychain-service"
    ) {
      if (
        flag === "--google-key-env" &&
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
      )
        throw new TransportError("INVALID_CONFIGURATION");
      options[flag.slice(2).replaceAll("-", "_")] = value;
    } else if (flag === "--project-id") options.projectId = assertId(value);
    else options[flag.slice(2).replaceAll("-", "_")] = resolve(value);
  }
  if (!options.project) throw new TransportError("INVALID_CONFIGURATION");
  return options;
}
export async function configuredStudio(options) {
  let capture = null;
  if (options.vibelore_root) {
    if (!(await stat(options.vibelore_root)).isDirectory())
      throw new TransportError("INVALID_CONFIGURATION");
    const [{ MarkdownStateStore }, { exportVibeloreSource }] =
      await Promise.all([
        import("../../../src/store/markdown-store.js"),
        import("../source/vibelore-connector.js"),
      ]);
    // Constructor assigns locations only. Never initialize, migrate, or save source data.
    const store = new MarkdownStateStore(options.vibelore_root);
    capture = ({ workId, request }) =>
      exportVibeloreSource({ store, workId, request });
  }
  const key = await resolveGoogleCredential({
    envName: options.google_key_env ?? "GEMINI_API_KEY",
    keychainService: options.google_keychain_service,
  });
  const google = googleProvider({ key });
  const service = await openStudio({
    directory: options.project,
    providers: { google },
  });
  let library;
  try {
    if (options.library)
      library = await openLibrary({
        directory: options.library,
        adapters: {
          studio: createStudioOwnerAdapter,
          vibelore: createVibeloreOwnerAdapter,
        },
      });
    if (capture) {
      const { registerSourceCaptureCommands } = await import(
        "../source/source-package.js"
      );
      registerSourceCaptureCommands(service, { capture });
    }
    return {
      service,
      library,
      destinationKey: canonicalDigest({
        purpose: "studio-preservation-v1",
        physical: await physicalOwnerIdentity(options.project, "studio.sqlite"),
      }),
      generationConfigured: Boolean(key),
      providerCapabilities: [await google.capabilities()],
      sourceCapture: Boolean(capture),
      projectId: options.projectId ?? "p1",
    };
  } catch (error) {
    await Promise.allSettled([library?.close(), service.close()]);
    throw error;
  }
}
