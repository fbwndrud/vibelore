import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { run } from "../src/render/probe.js";
const directory = fileURLToPath(new URL("../local-demo/", import.meta.url));
const measurements = {
  method:
    "FFmpeg decoded mono f32le at 48kHz. Container/decoder applies AAC priming. First 1ms RMS window above .015 in ±100ms around independent fixture onset; DFT confirms each diagnostic frequency.",
  frameToleranceMs: 1000 / 30,
  profiles: [],
};
for (const profile of ["landscape", "portrait", "audio"]) {
  const filename = join(
    directory,
    `night-stop-${profile}.${profile === "audio" ? "wav" : "mp4"}`,
  );
  const { stdout } = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      filename,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  const samples = new Float32Array(
      stdout.buffer,
      stdout.byteOffset,
      stdout.length / 4,
    ),
    onsets = [];
  for (let i = 0; i < 12; i++) {
    const expectedSeconds = 1 + i * 5.5,
      frequency = 330 + i * 55;
    let detected = null;
    for (
      let at = Math.round((expectedSeconds - 0.1) * 48000);
      at < Math.round((expectedSeconds + 0.1) * 48000);
      at += 48
    ) {
      let sum = 0;
      for (let n = 0; n < 48; n++) sum += samples[at + n] ** 2;
      if (Math.sqrt(sum / 48) > 0.015) {
        detected = (at + 24) / 48000;
        break;
      }
    }
    if (detected === null) throw Error("Missing onset " + i);
    let re = 0,
      im = 0;
    const start = Math.round((expectedSeconds + 0.2) * 48000),
      length = 4800;
    for (let j = 0; j < length; j++) {
      const phase = (2 * Math.PI * frequency * j) / 48000;
      re += samples[start + j] * Math.cos(phase);
      im -= samples[start + j] * Math.sin(phase);
    }
    const amplitude = (2 * Math.hypot(re, im)) / length;
    const errorMs = (detected - expectedSeconds) * 1000;
    if (Math.abs(errorMs) > 1000 / 30 || amplitude < 0.05)
      throw Error("Onset/frequency mismatch " + profile + " " + i);
    onsets.push({
      utteranceId: `u${i}`,
      presence:
        i === 0 || i === 11
          ? "narrator"
          : i === 6 || i === 8
            ? "offscreen"
            : "onscreen",
      frequency,
      expectedSeconds,
      detectedSeconds: detected,
      errorMs,
      decodedAmplitude: amplitude,
    });
  }
  measurements.profiles.push({
    profile,
    decodedSampleCount: samples.length,
    decodedDuration: samples.length / 48000,
    maxOnsetErrorMs: Math.max(...onsets.map((x) => Math.abs(x.errorMs))),
    onsets,
  });
  if (profile !== "audio")
    for (const frame of [30, 195, 525, 1020, 1845])
      await run("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-i",
        filename,
        "-vf",
        `select=eq(n\\,${frame})`,
        "-frames:v",
        "1",
        join(directory, `${profile}-cue-${frame}.png`),
      ]);
}
await writeFile(
  join(directory, "audio-measurements.json"),
  JSON.stringify(measurements, null, 2),
);
console.log(
  JSON.stringify(
    measurements.profiles.map(
      ({ profile, maxOnsetErrorMs, decodedDuration }) => ({
        profile,
        maxOnsetErrorMs,
        decodedDuration,
      }),
    ),
    null,
    2,
  ),
);
