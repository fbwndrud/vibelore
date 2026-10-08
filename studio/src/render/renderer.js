import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  chromePath,
  run,
  probeOutput,
  verifyRenderEnvironment,
} from "./probe.js";
import { decodeWav } from "../assets/audio-import.js";
export async function renderEdition({ edition, readBlob }) {
  const c = edition.closure;
  await verifyRenderEnvironment(c.environment, c.profile.kind);
  const mix = await readBlob(c.mix.blobId);
  if (c.profile.kind === "audio") {
    const decoded = decodeWav(mix);
    return {
      bytes: mix,
      mime: "audio/wav",
      extension: "wav",
      durationSeconds: decoded.metadata.durationSeconds,
      streams: [
        {
          type: "audio",
          codec: "pcm_s16le",
          sampleRate: decoded.metadata.sampleRate,
          channels: decoded.metadata.channels,
        },
      ],
      checks: { decodedAudio: true, decodedVideo: false, profile: true },
      frames: [],
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "studio-render-"));
  let server;
  try {
    const data = new Map();
    for (const id of new Set([...c.shots.map((s) => s.blobId), c.font.blobId]))
      data.set(id, await readBlob(id));
    const token = randomBytes(24).toString("hex");
    server = createServer((req, res) => {
      const id = req.url?.slice(token.length + 2);
      if (
        req.method !== "GET" ||
        !req.url?.startsWith(`/${token}/`) ||
        !data.has(id)
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Content-Type",
        id === c.font.blobId ? "font/ttf" : "image/png",
      );
      res.end(data.get(id));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const urls = Object.fromEntries(
      [...data.keys()].map((id) => [
        id,
        `http://127.0.0.1:${server.address().port}/${token}/${id}`,
      ]),
    );
    const [{ bundle }, { selectComposition, renderMedia }] = await Promise.all([
      import("@remotion/bundler"),
      import("@remotion/renderer"),
    ]);
    const serveUrl = await bundle({
      entryPoint: fileURLToPath(
        new URL("../../render/composition.jsx", import.meta.url),
      ),
      outDir: join(directory, "bundle"),
      webpackOverride: (config) => config,
    });
    const inputProps = { edition, urls },
      composition = await selectComposition({
        serveUrl,
        id: "StudioEdition",
        inputProps,
        browserExecutable: chromePath,
      });
    const silent = join(directory, "silent.mp4"),
      wav = join(directory, "mix.wav"),
      output = join(directory, "edition.mp4");
    await writeFile(wav, mix);
    await renderMedia({
      composition,
      serveUrl,
      inputProps,
      codec: "h264",
      outputLocation: silent,
      browserExecutable: chromePath,
      concurrency: 2,
      crf: 18,
      pixelFormat: "yuv420p",
      logLevel: "error",
    });
    await run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      silent,
      "-i",
      wav,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      "-t",
      String(c.timeline.durationFrames / c.profile.fps),
      output,
    ]);
    const checked = await probeOutput(
      output,
      c.profile,
      c.timeline.durationFrames / c.profile.fps,
    );
    const frames = [];
    for (const frame of [
      ...new Set([
        0,
        Math.floor(c.timeline.durationFrames / 2),
        c.timeline.durationFrames - 1,
      ]),
    ]) {
      const path = join(directory, `frame-${frame}.png`);
      await run("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-i",
        output,
        "-vf",
        `select=eq(n\\,${frame})`,
        "-frames:v",
        "1",
        path,
      ]);
      frames.push({ frame, bytes: await readFile(path) });
    }
    return {
      bytes: await readFile(output),
      mime: "video/mp4",
      extension: "mp4",
      ...checked,
      frames,
    };
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
