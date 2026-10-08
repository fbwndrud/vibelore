import { decodeWav } from "../assets/audio-import.js";
import { fail } from "../engine/contracts.js";
export async function mixTimeline(timeline, readBlob) {
  const rate = timeline.sampleRate,
    frames = Math.ceil((timeline.durationFrames * rate) / timeline.fps);
  if (frames > rate * 3600) fail("RENDER_LIMIT", "Timeline exceeds one hour.");
  const mix = new Float64Array(frames * 2);
  let clippedSamples = 0;
  for (const take of timeline.takes) {
    if (take.mute) continue;
    const { samples, metadata: m } = decodeWav(await readBlob(take.blobId));
    const length = take.endSample - take.startSample;
    for (let i = 0; i < length; i++) {
      const source = take.trimStartSamples + (i * m.sampleRate) / rate,
        lo = Math.floor(source),
        hi = Math.min(lo + 1, m.frameCount - take.trimEndSamples - 1),
        fraction = source - lo;
      const gain =
        take.gain *
        Math.min(
          1,
          take.fadeInMs ? i / ((take.fadeInMs * rate) / 1000) : 1,
          take.fadeOutMs
            ? (length - 1 - i) / ((take.fadeOutMs * rate) / 1000)
            : 1,
        );
      for (let channel = 0; channel < 2; channel++) {
        let value = 0;
        // Preserve stereo; explicitly average multi-channel imports into both channels.
        if (m.channels <= 2) {
          const c = m.channels === 1 ? 0 : channel;
          value =
            samples[lo * m.channels + c] * (1 - fraction) +
            samples[hi * m.channels + c] * fraction;
        } else {
          for (let c = 0; c < m.channels; c++)
            value +=
              (samples[lo * m.channels + c] * (1 - fraction) +
                samples[hi * m.channels + c] * fraction) /
              m.channels;
        }
        mix[(take.startSample + i) * 2 + channel] += value * gain;
      }
    }
  }
  const b = Buffer.alloc(44 + frames * 4);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < mix.length; i++) {
    if (Math.abs(mix[i]) > 1) clippedSamples++;
    b.writeInt16LE(
      Math.round(Math.max(-1, Math.min(1, mix[i])) * 32767),
      44 + i * 2,
    );
  }
  return {
    bytes: b,
    metadata: {
      sampleRate: rate,
      channels: 2,
      frameCount: frames,
      clippedSamples,
      resampling: "linear",
      limiter: "hard-clip",
      rounding: "nearest sample; output padded to video frame",
    },
  };
}
