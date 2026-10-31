import sharp from 'sharp';
import { fail } from '../engine/contracts.js';
import { decodeWav } from './audio-import.js';

export async function decodeCanonicalRgba(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length)
    fail('INVALID_IMAGE', 'Image bytes are missing.');

  try {
    const input = sharp(Buffer.from(bytes), { failOn: 'warning', limitInputPixels: 100000000 });

    const metadata = await input.metadata();

    if (metadata.pages > 1)
      fail('UNSUPPORTED_IMAGE', 'Animated images require an explicit frame import.');

    const { data, info } = await input.rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    if (info.channels !== 4 || !info.width || !info.height || data.length !== info.width * info.height * 4)
      fail('INVALID_IMAGE', 'Invalid decoded image.');

    return { data, width: info.width, height: info.height, channels: 4 };
  } catch (error) {
    if (error.code === 'UNSUPPORTED_IMAGE')
      throw error;

    fail('INVALID_IMAGE', 'Image decoding failed.');
  }
}

export function encodeCanonicalRgba(image) {
  return sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 }
  }).png().toBuffer();
}

export async function decodeMedia(bytes, mediaKind) {
  if (mediaKind === 'image') {
    const image = await decodeCanonicalRgba(bytes);

    return {
      bytes: await encodeCanonicalRgba(image),
      mime: 'image/png',

      metadata: { width: image.width, height: image.height, channels: 4, colourspace: 'srgb', oriented: true }
    };
  }

  if (mediaKind === 'audio') {
    const decoded = decodeWav(bytes);

    return { bytes: Buffer.from(bytes), mime: 'audio/wav', metadata: decoded.metadata };
  }

  fail('UNSUPPORTED_MEDIA', 'Only image and WAV media are supported.');
}

// The worker supplies retained bytes. Clients cannot supply validation callbacks.
export function mediaValidator(service, projectId) {
  return async ({ kind, outputs }) => Promise.all(outputs.map(async output => {
    try {
      const decoded = await decodeMedia(output.bytes, kind);
      const canonical = await service.blobs.put(projectId, decoded.bytes);

      return {
        blobId: output.blobId,
        rawBlobId: output.blobId,
        canonicalBlobId: canonical.blobId,
        mediaKind: kind,
        mime: decoded.mime,
        metadata: decoded.metadata,

        validation: { status: 'passed', decoder: 'studio-media-v1' }
      };
    } catch (error) {
      if (!['INVALID_IMAGE', 'UNSUPPORTED_IMAGE', 'INVALID_WAV', 'UNSUPPORTED_WAV', 'UNSUPPORTED_MEDIA'].includes(error.code))
        throw error;

      return {
        blobId: output.blobId,
        rawBlobId: output.blobId,
        mediaKind: kind,

        validation: { status: 'quarantined', code: error.code }
      };
    }
  }));
}
