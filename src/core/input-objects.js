import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { encodeLore, hashLore, isLoreRevisionId } from '../../engine/src/lore/registry.js';
import { requireLore } from '../../engine/src/lore/schemas.js';
import { loreBlobId } from '../../engine/src/lore/assets.js';
import { verifyLoreProductionLock } from '../../engine/src/lore/production.js';
import { loreReadText, loreWriteText, loreWriteBytes, safeLorePath } from './lore-files.js';

// The work keeps a full, immutable copy of every production input it used:
// the lock (which embeds its world/registry/catalog closure) and the exact
// asset bytes. These are preserved inputs, not a second editable source.
const base = rootDir => join(rootDir, '.vibelore', 'input-objects');
const extension = mime => mime === 'image/png' ? 'png' : 'jpg';
export const sealedBlobPath = (rootDir, blob) => join(base(rootDir), 'blobs', `${blob.blobId.slice(7)}.${extension(blob.mime)}`);
const local = (rootDir, path) => relative(rootDir, path).split(sep).join('/');

/** Copy first, publish after: callers write their HEAD only once this resolves. */
export async function sealProductionInput({ rootDir, lock, readBlob }) {
  verifyLoreProductionLock(lock);
  const blobs = [];
  for (const asset of lock.assets ?? []) {
    const bytes = await readBlob(asset.blob.blobId);
    requireLore(loreBlobId(bytes) === asset.blob.blobId, 'LORE_INTEGRITY', `asset ${asset.assetId} bytes changed`);
    const path = sealedBlobPath(rootDir, asset.blob);
    await loreWriteBytes(rootDir, path, bytes);
    blobs.push({ assetId: asset.assetId, blobId: asset.blob.blobId, path: local(rootDir, path) });
  }
  await loreWriteText(rootDir, join(base(rootDir), 'locks', `${lock.revisionId.slice(7)}.json`), encodeLore(lock), { immutable: true });
  return { productionLockId: lock.revisionId, blobs };
}

/** Verifies from the work alone; the world directory may have moved or been deleted. */
export async function readSealedProductionInput({ rootDir, productionLockId }) {
  requireLore(isLoreRevisionId(productionLockId), 'INVALID_LORE_DATA', 'productionLockId');
  const text = await loreReadText(rootDir, join(base(rootDir), 'locks', `${productionLockId.slice(7)}.json`));
  requireLore(text !== null, 'PRODUCTION_INPUT_MISSING', `sealed lock ${productionLockId}`);
  let lock;
  try { lock = JSON.parse(text); } catch { requireLore(false, 'LORE_INTEGRITY', `sealed lock ${productionLockId} is not valid JSON`); }
  requireLore(lock.revisionId === productionLockId && hashLore(Object.fromEntries(Object.entries(lock).filter(([k]) => k !== 'revisionId'))) === productionLockId, 'LORE_INTEGRITY', 'sealed lock hash mismatch');
  verifyLoreProductionLock(lock);
  const blobs = [];
  for (const asset of lock.assets ?? []) {
    const path = sealedBlobPath(rootDir, asset.blob);
    await safeLorePath(rootDir, path);
    let bytes;
    try { bytes = await readFile(path); } catch (error) { if (error.code === 'ENOENT') requireLore(false, 'PRODUCTION_INPUT_MISSING', `sealed asset ${asset.assetId}`); throw error; }
    requireLore(loreBlobId(bytes) === asset.blob.blobId, 'LORE_INTEGRITY', `sealed asset ${asset.assetId} bytes changed`);
    blobs.push({ assetId: asset.assetId, blobId: asset.blob.blobId, mime: asset.blob.mime, path: local(rootDir, path) });
  }
  return { lock, blobs };
}
