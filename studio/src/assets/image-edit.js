import { decodeCanonicalRgba, encodeCanonicalRgba } from './decode.js';
import { fail } from '../engine/contracts.js';

export function validateProtectedPixels({ base, final, support }) {
  if (base.width !== final.width || base.height !== final.height || support.length !== base.width * base.height)
    fail('INVALID_GEOMETRY', 'Protected image geometry does not match.');

  let protectedPixelCount = 0;

  for (let p = 0; p < support.length; p++) if (!support[p]) {
    protectedPixelCount++;

    for (let c = 0; c < 4; c++) if (base.data[p * 4 + c] !== final.data[p * 4 + c])
      fail('PROTECTED_PIXELS_CHANGED', 'Final composite changed protected pixels.');
  }

  return { protectedPixels: 'passed', protectedPixelCount };
}

function assertSameGeometry(base, image) {
  if (base.width !== image.width || base.height !== image.height)
    fail('INVALID_GEOMETRY', 'Oriented images and masks must share base dimensions.');
}

function maskWeight(image, p) {
  const offset = p * 4;

  if (image.data[offset] !== image.data[offset + 1] || image.data[offset] !== image.data[offset + 2])
    fail('INVALID_MASK', 'Masks require grayscale coverage.');

  return image.data[offset] * image.data[offset + 3] / 65025;
}

export async function verifyProtectedEdit({ base, final, mask, feather, geometry }) {
  if (!geometry || geometry.kind !== 'identity' || Object.keys(geometry).length !== 1)
    fail('INVALID_GEOMETRY', 'An explicit supported candidate-to-base mapping is required.');

  const [b, result, m, f] = await Promise.all([
    decodeCanonicalRgba(base),
    decodeCanonicalRgba(final),
    decodeCanonicalRgba(mask),
    feather ? decodeCanonicalRgba(feather) : null
  ]);

  for (const image of [result, m, f].filter(Boolean))
    assertSameGeometry(b, image);

  const support = Uint8Array.from({ length: b.width * b.height }, (_, p) => Math.max(maskWeight(m, p), f ? maskWeight(f, p) : 0) > 0 ? 1 : 0);

  return validateProtectedPixels({ base: b, final: result, support });
}

export async function composeProtectedEdit({ base, candidate, mask, feather, geometry }) {
  if (!geometry || geometry.kind !== 'identity' || Object.keys(geometry).length !== 1)
    fail('INVALID_GEOMETRY', 'An explicit supported candidate-to-base mapping is required.');

  const [b, c, m, f] = await Promise.all([
    decodeCanonicalRgba(base),
    decodeCanonicalRgba(candidate),
    decodeCanonicalRgba(mask),
    feather ? decodeCanonicalRgba(feather) : null
  ]);

  for (const image of [c, m, f].filter(Boolean))
    assertSameGeometry(b, image);

  const data = Buffer.from(b.data), support = new Uint8Array(b.width * b.height);

  for (let p = 0; p < support.length; p++) {
    const coverage = Math.max(maskWeight(m, p), f ? maskWeight(f, p) : 0);

    if (coverage > 0) {
      support[p] = 1;

      for (let channel = 0; channel < 4; channel++)
        data[p * 4 + channel] = Math.round(b.data[p * 4 + channel] * (1 - coverage) + c.data[p * 4 + channel] * coverage);
    }
  }

  const bytes = await encodeCanonicalRgba({ ...b, data });

  // Verify the actual encoded final bytes, including alpha and a one-LSB difference.
  const final = await decodeCanonicalRgba(bytes);

  return {
    bytes,

    validation: {
      status: 'passed',

      ...validateProtectedPixels({ base: b, final, support }),

      geometry: { ...geometry },

      width: b.width,
      height: b.height
    }
  };
}

export async function deriveCrop({ base, rect }) {
  const decoded = await decodeCanonicalRgba(base);

  if (!rect || Object.keys(rect).some(k => !['left', 'top', 'width', 'height'].includes(k)) || !['left', 'top', 'width', 'height'].every(k => Number.isSafeInteger(rect[k])) || rect.left < 0 || rect.top < 0 || rect.width <= 0 || rect.height <= 0 || rect.left + rect.width > decoded.width || rect.top + rect.height > decoded.height)
    fail('INVALID_GEOMETRY', 'Crop must be an integer rectangle inside the oriented base.');

  const data = Buffer.alloc(rect.width * rect.height * 4);

  for (let y = 0; y < rect.height; y++) decoded.data.copy(
    data,
    y * rect.width * 4,
    ((rect.top + y) * decoded.width + rect.left) * 4,
    ((rect.top + y) * decoded.width + rect.left + rect.width) * 4
  );

  return encodeCanonicalRgba({ data, width: rect.width, height: rect.height });
}
