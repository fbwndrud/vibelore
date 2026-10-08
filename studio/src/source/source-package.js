import { createHash, randomUUID } from 'node:crypto';
import {
  assertId,
  assertInteger,
  assertText,
  BLOB_ID,
  canonicalDigest,
  canonicalJSON,
  fail,
} from '../engine/contracts.js';
export const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Only connector-private data can contain filesystem locations.
export function assertPortable(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertPortable(item);
  } else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (/^(path|rootDir|sourcePath|worldRoot|directory|absolutePath)$/i.test(key))
        fail('INVALID_INPUT', 'Source DTO must not contain filesystem paths.');
      assertPortable(item);
    }
}
export function makeSourcePackage(input) {
  const { id = randomUUID(), sourceDigest: ignored, ...body } = JSON.parse(canonicalJSON(input));
  const value = { schemaVersion: 1, ...body };
  const pkg = { id, ...value, sourceDigest: canonicalDigest(value) };
  validateSourcePackage(pkg);
  return pkg;
}
export function validateSourcePackage(pkg) {
  canonicalJSON(pkg);
  assertPortable(pkg);
  assertId(pkg.id);
  if (
    pkg.schemaVersion !== 1 ||
    !['novel-chapters', 'scene-script', 'studio-script'].includes(pkg.sourceKind)
  )
    fail('INVALID_INPUT', 'Unsupported source package.');
  assertText(pkg.sourceRevision);
  for (const key of ['textUnits', 'sceneScopes', 'sourceIdentityMap', 'blobManifest'])
    if (!Array.isArray(pkg[key])) fail('INVALID_INPUT', 'Expected source collections.');
  if (!pkg.revealPolicy || !pkg.preservationStatus)
    fail('INVALID_INPUT', 'Expected source preservation and reveal policy.');
  const { id, sourceDigest, ...body } = pkg;
  if (canonicalDigest(body) !== sourceDigest)
    fail('SOURCE_DIGEST_MISMATCH', 'Source package digest does not match its content.');
  for (const key of ['textUnits', 'sceneScopes', 'sourceIdentityMap']) {
    const ids = new Set();
    for (const entry of pkg[key]) {
      assertId(entry.id);
      if (ids.has(entry.id)) fail('INVALID_INPUT', 'Duplicate source identifier.');
      ids.add(entry.id);
    }
  }
  for (const unit of pkg.textUnits) assertText(unit.text);
  const blobs = new Set();
  for (const blob of pkg.blobManifest) {
    if (!BLOB_ID.test(blob.blobId)) fail('INVALID_INPUT', 'Expected source blob hash.');
    assertInteger(blob.byteLength);
    assertId(blob.id);
    assertText(blob.kind);
    // The same exact bytes may be used by several source documents.
    blobs.add(blob.blobId);
  }
  for (const unit of pkg.textUnits)
    if (unit.blobId && !blobs.has(unit.blobId)) fail('INVALID_REFERENCE', 'Text unit blob is absent.');
  if (pkg.assets !== undefined) {
    if (!Array.isArray(pkg.assets)) fail('INVALID_INPUT', 'Expected source assets.');
    const sceneIds = new Set(pkg.sceneScopes.map((s) => s.id));
    for (const asset of pkg.assets) {
      assertId(asset.id);
      assertText(asset.sourceAssetId);
      assertText(asset.mime);
      if (
        !blobs.has(asset.blobId) ||
        !Array.isArray(asset.sceneIds) ||
        asset.sceneIds.some((id) => !sceneIds.has(id))
      )
        fail('INVALID_REFERENCE', 'Source asset closure is incomplete.');
    }
  }
  return pkg;
}
export function registerSourceCommands(service) {
  service.registerCommand('source.import', {
    target: ({ envelope }) => ({ kind: 'sourcePackage', id: envelope.payload.package.id }),
    async prepare({ envelope }) {
      const { package: pkg, blobs = [] } = envelope.payload;
      validateSourcePackage(pkg);
      if (!Array.isArray(blobs)) fail('INVALID_INPUT', 'Expected source bytes.');
      const supplied = new Map();
      for (const blob of blobs) {
        if (!Array.isArray(blob.bytes) || !blob.bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
          fail('INVALID_INPUT', 'Expected byte arrays.');
        const bytes = Uint8Array.from(blob.bytes);
        if (hashBytes(bytes) !== blob.blobId)
          fail('SOURCE_BLOB_MISMATCH', 'Source bytes differ from the declared hash.');
        if (!pkg.blobManifest.some((b) => b.blobId === blob.blobId && b.byteLength === bytes.length))
          fail('SOURCE_BLOB_MISMATCH', 'Source bytes are not declared by this package.');
        supplied.set(blob.blobId, bytes);
      }
      for (const manifest of pkg.blobManifest) {
        if (supplied.has(manifest.blobId))
          await service.blobs.put(envelope.projectId, supplied.get(manifest.blobId));
        else await service.blobs.read(envelope.projectId, manifest.blobId);
      }
    },
    validate({ store, envelope, aggregate }) {
      const pkg = validateSourcePackage(envelope.payload.package);
      if (aggregate.revision) fail('SOURCE_IMMUTABLE', 'Imported source packages are immutable.');
      for (const blob of pkg.blobManifest) {
        const row = store.get(
          'SELECT byte_length,status FROM blobs WHERE project_id=? AND id=?',
          envelope.projectId,
          blob.blobId
        );
        if (!row || row.status !== 'available' || row.byte_length !== blob.byteLength)
          fail('INVALID_REFERENCE', 'Source bytes are unavailable in this project.');
      }
    },
    apply: ({ envelope }) => envelope.payload.package,
  });
}
