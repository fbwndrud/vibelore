import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  withGeneration,
  generationCommand,
  validImageRequest,
} from "./helpers/project.js";
import { googleHttp, interaction } from "./helpers/google-http.js";
import { png } from "./helpers/images.js";

test("unconfigured daemon leaves queue intact; configured daemon owns generation and shuts down", async (t) => {
  const f = await withGeneration(t);
  await generationCommand(
    f,
    validImageRequest({
      provider: "google",
      input: {
        model: "gemini-nano-banana-2.1",
        prompt: "local fixture",
        config: {},
      },
    }),
  );
  const bytes = await png([20, 40, 60, 255], 1, 1);
  const http = await googleHttp(t, () =>
    interaction([
      { type: "image", mime_type: "image/png", data: bytes.toString("base64") },
    ]),
  );
  // Every possible provider request is redirected to this test's local HTTP server.
  // The child never inherits a real Google credential or a provider endpoint.
  const preload = `const originalFetch=globalThis.fetch;globalThis.fetch=(url,init)=>{const u=new URL(url);if(u.origin!=='https://generativelanguage.googleapis.com')throw new Error('Unexpected test endpoint');return originalFetch(${JSON.stringify(new URL(http.baseURL).origin)}+u.pathname,init);};`;
  const start = async (key) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        fileURLToPath(new URL("../bin/studio.js", import.meta.url)),
        "--project",
        f.directory,
        "--port",
        "0",
      ],
      {
        env: { ...process.env, GEMINI_API_KEY: key },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      errors = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (errors += d));
    t.after(() => child.kill());
    for (let i = 0; i < 100 && !output.includes("Studio listening"); i++) {
      if (child.exitCode !== null) throw new Error(`Daemon exited: ${errors}`);
      await delay(20);
    }
    const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(url, "daemon starts");
    const bootstrap = await (
      await fetch(`${url}/api/bootstrap`, { headers: { origin: url } })
    ).json();
    assert.ok(!JSON.stringify(bootstrap).includes("local-dummy-credential"));
    return {
      bootstrap,
      stop: async () => {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
        assert.equal(child.exitCode, 0);
        assert.equal(errors, "");
      },
    };
  };
  const manual = await start("");
  assert.equal(manual.bootstrap.providers[0].available, false);
  await delay(150);
  assert.equal((await f.service.snapshot("p1")).attempts[0].status, "prepared");
  assert.equal(http.calls.length, 0);
  await manual.stop();
  const configured = await start("local-dummy-credential");
  assert.equal(configured.bootstrap.providers[0].available, true);
  for (let i = 0; i < 100; i++) {
    if ((await f.service.snapshot("p1")).candidates.length) break;
    await delay(20);
  }
  assert.equal((await f.service.snapshot("p1")).candidates.length, 1);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].key, "local-dummy-credential");
  await configured.stop();
});
