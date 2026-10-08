import { execFile } from "node:child_process";
import { promisify } from "node:util";
export async function resolveGoogleCredential({
  env = process.env,
  envName = "GEMINI_API_KEY",
  keychainService = null,
  platform = process.platform,
  execute = promisify(execFile),
} = {}) {
  if (keychainService) {
    if (
      platform !== "darwin" ||
      typeof keychainService !== "string" ||
      !keychainService.trim()
    )
      return null;
    try {
      const { stdout } = await execute(
        "/usr/bin/security",
        ["find-generic-password", "-s", keychainService, "-w"],
        { maxBuffer: 16384, timeout: 10000 },
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
  return typeof env[envName] === "string" && env[envName].trim()
    ? env[envName].trim()
    : null;
}
