import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { decodeCanonicalRgba } from '../src/assets/decode.js';
import { composeProtectedEdit, validateProtectedPixels } from '../src/assets/image-edit.js';
import { png, basePixels, driftPixels, maskPixels, identityGeometry } from './helpers/images.js';

test('protected composite repairs one LSB drift outside mask and retains edited pixels', async () => {
  const result = await composeProtectedEdit({
    base: await png(basePixels),
    candidate: await png(driftPixels),
    mask: await png(maskPixels),
    geometry: identityGeometry
  });

  const final = await decodeCanonicalRgba(result.bytes);
  assert.deepEqual([...final.data], [20, 30, 40, 255, 150, 160, 170, 255, 80, 90, 100, 255]);
  assert.equal(result.validation.protectedPixels, 'passed');
  assert.equal(result.validation.protectedPixelCount, 2);
});

test('hard pixel validator catches a one LSB difference in the final image', async () => {
  const base = await decodeCanonicalRgba(await png(basePixels));
  const final = await decodeCanonicalRgba(await png(driftPixels));

  assert.throws(() => validateProtectedPixels({ base, final, support: new Uint8Array([0, 1, 0]) }), { code: 'PROTECTED_PIXELS_CHANGED' });
});

test('feather support blends only its union and protects every other pixel', async () => {
  const feather = await png([128, 128, 128, 255, 0, 0, 0, 255, 0, 0, 0, 255]);

  const result = await composeProtectedEdit({
    base: await png(basePixels),
    candidate: await png([120, 130, 140, 255, 150, 160, 170, 255, 81, 90, 100, 255]),
    mask: await png(maskPixels),
    feather,
    geometry: identityGeometry
  });

  assert.deepEqual(
    [...(await decodeCanonicalRgba(result.bytes)).data],
    [70, 80, 90, 255, 150, 160, 170, 255, 80, 90, 100, 255]
  );

  assert.equal(result.validation.protectedPixelCount, 1);
});

test('EXIF orientation is resolved before explicit geometry mapping', async () => {
  const oriented = await sharp(Buffer.from(basePixels), {
    raw: { width: 3, height: 1, channels: 4 }
  }).withMetadata({ orientation: 6 }).png().toBuffer();

  const decoded = await decodeCanonicalRgba(oriented);
  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 3);
  assert.deepEqual([...decoded.data], basePixels);

  const result = await composeProtectedEdit({
    base: oriented,
    candidate: await png(driftPixels, 1, 3),
    mask: await png(maskPixels, 1, 3),
    geometry: identityGeometry
  });

  assert.deepEqual(
    [...(await decodeCanonicalRgba(result.bytes)).data],
    [20, 30, 40, 255, 150, 160, 170, 255, 80, 90, 100, 255]
  );
});

test('unknown mapping, unequal dimensions, and malformed geometry are rejected', async () => {
  for (const geometry of [undefined, { kind: 'guess' }, { kind: 'identity', scale: 2 }, { kind: 'resize', width: 3, height: 1 }]) {
    await assert.rejects(async () => composeProtectedEdit({ base: await png(basePixels), candidate: await png(driftPixels), mask: await png(maskPixels), geometry }), { code: 'INVALID_GEOMETRY' });
  }

  await assert.rejects(async () => composeProtectedEdit({
    base: await png(basePixels),
    candidate: await png(driftPixels, 1, 3),
    mask: await png(maskPixels),
    geometry: identityGeometry
  }), { code: 'INVALID_GEOMETRY' });
});

test('encoded final proof rejects protected drift and invalid mask geometry', async () => {
  const { verifyProtectedEdit } = await import('../src/assets/image-edit.js');

  await assert.rejects(async () => verifyProtectedEdit({ base: await png(basePixels), final: await png(driftPixels), mask: await png(maskPixels), geometry: identityGeometry }), { code: 'PROTECTED_PIXELS_CHANGED' });

  await assert.rejects(async () => verifyProtectedEdit({
    base: await png(basePixels),
    final: await png(basePixels),
    mask: await png(maskPixels, 1, 3),
    geometry: identityGeometry
  }), { code: 'INVALID_GEOMETRY' });
});

test('protected proof includes exact alpha and hidden RGB channels', async () => {
  const b = await decodeCanonicalRgba(await png([20, 30, 40, 0, 50, 60, 70, 255, 80, 90, 100, 255]));
  const final = await decodeCanonicalRgba(await png([20, 30, 40, 1, 50, 60, 70, 255, 80, 90, 100, 255]));

  assert.throws(() => validateProtectedPixels({ base: b, final, support: new Uint8Array([0, 1, 0]) }), { code: 'PROTECTED_PIXELS_CHANGED' });
});
