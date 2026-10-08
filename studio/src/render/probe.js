import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWav } from "../assets/audio-import.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { fail } from "../engine/contracts.js";
export const run = promisify(execFile);
export const chromePath =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.env.STUDIO_CHROME_PATH;
export async function renderCapabilities() {
  const result = {
    audio: { available: true, format: "wav" },
    video: { available: false },
  };
  try {
    const ffmpeg = await run("ffmpeg", ["-version"]);
    const ffprobe = await run("ffprobe", ["-version"]);
    if (!chromePath) throw Error();
    await access(chromePath);
    const chrome = await run(chromePath, ["--version"]);
    await import("@remotion/renderer");
    await import("@remotion/bundler");
    result.video = {
      available: true,
      ffmpeg: ffmpeg.stdout.split("\n")[0],
      ffprobe: ffprobe.stdout.split("\n")[0],
      browser: chrome.stdout.trim(),
      remotion: "4.0.534",
    };
  } catch {
    result.video.reason = "VIDEO_RUNTIME_UNAVAILABLE";
  }
  return result;
}
export async function probeOutput(path, profile, expected) {
  let parsed;
  try {
    const { stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      path,
    ]);
    parsed = JSON.parse(stdout);
  } catch {
    fail("OUTPUT_INVALID", "Output could not be decoded.");
  }
  const audio = parsed.streams.find((s) => s.codec_type === "audio"),
    video = parsed.streams.find((s) => s.codec_type === "video");
  const durationSeconds = Number(parsed.format.duration);
  if (
    !audio ||
    Math.abs(durationSeconds - expected) > 1 / profile.fps + 0.01 ||
    (profile.kind === "video" &&
      (!video ||
        video.width !== profile.width ||
        video.height !== profile.height ||
        video.codec_name !== "h264" ||
        video.r_frame_rate !== `${profile.fps}/1`))
  )
    fail("OUTPUT_INVALID", "Actual output does not match frozen profile.");
  // Decode the complete media, rather than trusting header metadata.
  try {
    await run("ffmpeg", ["-v", "error", "-i", path, "-f", "null", "-"], {
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    fail("OUTPUT_INVALID", "Output frame/audio decode failed.");
  }
  return {
    durationSeconds,
    streams: parsed.streams.map((s) => ({
      type: s.codec_type,
      codec: s.codec_name,
      ...(s.codec_type === "video"
        ? {
            width: s.width,
            height: s.height,
            frames: Number(s.nb_frames),
            frameRate: s.r_frame_rate,
          }
        : { sampleRate: Number(s.sample_rate), channels: s.channels }),
    })),
    checks: {
      decodedAudio: true,
      decodedVideo: profile.kind === "video",
      profile: true,
    },
  };
}

export async function checkRenderedBytes(bytes, profile, duration) {
  if (profile.kind === "audio") {
    const { metadata } = decodeWav(bytes);
    if (
      metadata.sampleRate !== 48000 ||
      metadata.channels !== 2 ||
      Math.abs(metadata.durationSeconds - duration) > 1 / 48000
    )
      fail("OUTPUT_INVALID", "Audio output differs from frozen duration.");
    return {
      durationSeconds: metadata.durationSeconds,
      streams: [
        {
          type: "audio",
          codec: "pcm_s16le",
          sampleRate: metadata.sampleRate,
          channels: metadata.channels,
        },
      ],
      checks: { decodedAudio: true, decodedVideo: false, profile: true },
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "studio-probe-"));
  try {
    const path = join(directory, "output.mp4");
    await writeFile(path, bytes);
    return await probeOutput(path, profile, duration);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
