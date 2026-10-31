import { fail } from '../engine/contracts.js';

// Decode the RIFF container and every interleaved sample, never infer timing from labels.
export function decodeWav(input) {
  const b = Buffer.from(input);
  const malformed = () => fail('INVALID_WAV', 'Malformed or truncated WAV container.');

  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE' || b.readUInt32LE(4) + 8 !== b.length)
    malformed();

  let format, data;

  for (let offset = 12; offset < b.length; ) {
    if (offset + 8 > b.length)
      malformed();

    const tag = b.toString('ascii', offset, offset + 4), size = b.readUInt32LE(offset + 4), end = offset + 8 + size;

    if (end > b.length || end + (size % 2) > b.length)
      malformed();

    const chunk = b.subarray(offset + 8, end);

    if (tag === 'fmt ') {
      if (format)
        malformed();

      format = chunk;
    }

    if (tag === 'data') {
      if (data)
        malformed();

      data = chunk;
    }

    offset = end + (size % 2);
  }

  if (!format || format.length < 16 || !data)
    malformed();

  const codec = format.readUInt16LE(0), channels = format.readUInt16LE(2), sampleRate = format.readUInt32LE(4), byteRate = format.readUInt32LE(8), blockAlign = format.readUInt16LE(12), bits = format.readUInt16LE(14);

  if (![1, 3].includes(codec) || (codec === 1 && ![8, 16, 24, 32].includes(bits)) || (codec === 3 && bits !== 32))
    fail('UNSUPPORTED_WAV', 'Unsupported WAV sample encoding.');

  if (!channels || channels > 64 || !sampleRate || sampleRate > 768000 || blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign || !data.length || data.length % blockAlign)
    malformed();

  if (format.length !== 16 && (format.length < 18 || format.readUInt16LE(16) + 18 !== format.length))
    malformed();

  const samples = new Float64Array(data.length / (bits / 8));

  for (let i = 0, offset = 0; i < samples.length; i++, offset += bits / 8) {
    const sample = codec === 3 ? data.readFloatLE(offset) : bits === 8 ? (data[offset] - 128) / 128 : bits === 16 ? data.readInt16LE(offset) / 32768 : bits === 24 ? data.readIntLE(offset, 3) / 8388608 : data.readInt32LE(offset) / 2147483648;

    if (!Number.isFinite(sample))
      malformed();

    samples[i] = sample;
  }

  const frameCount = data.length / blockAlign;

  return {
    samples,

    metadata: {
      sampleRate,
      channels,
      frameCount,
      bitsPerSample: bits,
      codec: codec === 1 ? 'pcm' : 'float',
      durationSeconds: frameCount / sampleRate
    }
  };
}
