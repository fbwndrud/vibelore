import sharp from 'sharp';

export async function png(pixels, width = 3, height = 1) {
  return sharp(Buffer.from(pixels), {
    raw: { width, height, channels: 4 }
  }).png().toBuffer();
}

export const basePixels = [20, 30, 40, 255, 50, 60, 70, 255, 80, 90, 100, 255];
export const driftPixels = [21, 30, 40, 255, 150, 160, 170, 255, 81, 90, 100, 255];
export const maskPixels = [0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255];

export function wav(
  {
    rate = 24000,
    channels = 2,
    frames = 3
  } = {}
) {
  const data = Buffer.alloc(frames * channels * 2);

  for (let i = 0; i < frames * channels; i++)
    data.writeInt16LE(i * 100 - 200, i * 2);

  const bytes = Buffer.alloc(44 + data.length);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(data.length, 40);
  data.copy(bytes, 44);
  return bytes;
}

export const identityGeometry = { kind: 'identity' };

export const environmentSlot = (
  id = 'background',
  scope = { kind: 'project', id: 'p1' }
) => ({
  id,
  scope,

  subject: { kind: 'environment', id: 'room' },

  appearanceStateRef: null
});

export const assetImport = async (f, id, bytes, slot = environmentSlot(), mediaKind = 'image') => f.command('asset.import', { id, bytes: [...bytes], mediaKind, slot, actor: 'artist' }, {
  aggregate: { kind: 'assetSlot', id: slot.id }
});
