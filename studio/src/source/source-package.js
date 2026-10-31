import { validateOriginRef } from '../reuse/bundle.js';
import { requireValue } from '../engine/story.js';
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
// Known internal identifiers are validated separately from source-prefixed provenance.
function collectionIds(items) {
  if (!Array.isArray(items)) fail('INVALID_INPUT', 'Expected source collection.');
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      fail('INVALID_INPUT', 'Expected source entry.');
    assertId(item.id);
    if (ids.has(item.id)) fail('INVALID_INPUT', 'Duplicate source identifier.');
    ids.add(item.id);
  }
  return ids;
}
function referenceIds(items, allowed = null) {
  if (!Array.isArray(items)) fail('INVALID_INPUT', 'Expected source references.');
  const ids = new Set();
  for (const id of items) {
    assertId(id);
    if (ids.has(id)) fail('INVALID_INPUT', 'Duplicate source reference.');
    ids.add(id);
  }
  for (const id of ids)
    if (allowed && !allowed.has(id)) fail('INVALID_REFERENCE', 'Source reference closure is incomplete.');
  return ids;
}
// New packages pin the selected text bytes explicitly. Legacy packages can be
// consumed only when their text units identify one distinct preserved blob.
export function selectedSourceTextBlobId(pkg) {
  const hashes = new Set(
    pkg.textUnits.map((unit) => unit.blobId).filter(
      (hash) => BLOB_ID.test(hash) && pkg.blobManifest.some((file) => file.blobId === hash)
    )
  );
  if (Object.hasOwn(pkg, 'selectedTextBlobId')) {
    if (!BLOB_ID.test(pkg.selectedTextBlobId) || !hashes.has(pkg.selectedTextBlobId))
      fail('INVALID_REFERENCE', 'Selected text must name preserved text-unit bytes.');
    return pkg.selectedTextBlobId;
  }
  return hashes.size === 1 ? [...hashes][0] : undefined;
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
  const collections = {};
  for (const key of ['textUnits', 'sceneScopes', 'sourceIdentityMap', 'blobManifest'])
    collections[key] = collectionIds(pkg[key]);
  const blobs = new Set();
  for (const blob of pkg.blobManifest) {
    if (!BLOB_ID.test(blob.blobId)) fail('INVALID_INPUT', 'Expected source blob hash.');
    assertInteger(blob.byteLength);
    assertText(blob.kind);
    // Different documents may preserve identical bytes, with distinct document IDs.
    blobs.add(blob.blobId);
  }
  for (const unit of pkg.textUnits) {
    assertText(unit.text);
    if (unit.sceneId !== undefined) referenceIds([unit.sceneId], collections.sceneScopes);
    if (unit.blobId !== undefined && (!BLOB_ID.test(unit.blobId) || !blobs.has(unit.blobId)))
      fail('INVALID_REFERENCE', 'Text unit blob is absent.');
  }
  selectedSourceTextBlobId(pkg);
  const stateDefinitions =
    pkg.states?.sourceStateMap === undefined ? null : collectionIds(pkg.states.sourceStateMap);
  if (stateDefinitions) for (const state of pkg.states.sourceStateMap) assertText(state.sourceStateId);
  const scopedStates = new Set();
  for (const scope of pkg.sceneScopes) {
    if (scope.stateIds !== undefined) {
      if (!scope.stateIds || typeof scope.stateIds !== 'object' || Array.isArray(scope.stateIds))
        fail('INVALID_INPUT', 'Expected scoped state references.');
      for (const ids of Object.values(scope.stateIds))
        for (const stateId of referenceIds(ids, stateDefinitions)) scopedStates.add(stateId);
    }
    if (scope.documents !== undefined) collectionIds(scope.documents);
  }
  const assetEntries = pkg.assets === undefined ? [] : pkg.assets;
  const assets = collectionIds(assetEntries);
  for (const scope of pkg.sceneScopes) if (scope.assetIds !== undefined) referenceIds(scope.assetIds, assets);
  for (const asset of assetEntries) {
    assertText(asset.sourceAssetId);
    assertText(asset.mime);
    if (!BLOB_ID.test(asset.blobId) || !blobs.has(asset.blobId))
      fail('INVALID_REFERENCE', 'Source asset bytes are absent.');
    referenceIds(asset.sceneIds, collections.sceneScopes);
    referenceIds(asset.stateIds, stateDefinitions ?? scopedStates);
  }
  if (pkg.importProvenance) {
    if (
      !Array.isArray(pkg.originRefs) ||
      !pkg.originRefs.length ||
      !Array.isArray(pkg.fileMap) ||
      !pkg.fileMap.length ||
      !BLOB_ID.test(pkg.localManifestBlobId) ||
      !blobs.has(pkg.localManifestBlobId)
    )
      fail(
        'INVALID_REFERENCE',
        'Preserved source provenance requires its local manifest and file closure.'
      );
    for (const ref of pkg.originRefs) validateOriginRef(ref);
    for (const file of pkg.fileMap)
      if (
        !BLOB_ID.test(file.sourceSha256) ||
        !blobs.has(file.rawBlobId) ||
        !blobs.has(file.canonicalBlobId) ||
        typeof file.normalizationChanged !== 'boolean' ||
        typeof file.normalizerVersion !== 'string'
      )
        fail('INVALID_REFERENCE', 'Preserved source file map is incomplete.');
    for (const key of ['commandId', 'actor', 'reason'])
      assertText(pkg.importProvenance[key]);
    if (!BLOB_ID.test(pkg.importProvenance.bundleSha256))
      fail('INVALID_INPUT', 'Expected preserved bundle digest.');
  }
  return pkg;
}
const PRESERVATION_KEYS = ['importProvenance', 'originRefs', 'fileMap', 'localManifestBlobId'];
// Both raw import and configured capture stage bytes here, then validate/apply in
// the original command transaction. No nested dispatch or replacement envelope.
// Only source.importBundle derives preservation provenance from a verified bundle;
// other imports may repeat it only as recorded by that bundle import in this project.
function assertRecordedProvenance(store, projectId, pkg) {
  if (!PRESERVATION_KEYS.some((key) => Object.hasOwn(pkg, key))) return;
  const claimed = (value) =>
    canonicalJSON(Object.fromEntries(PRESERVATION_KEYS.map((key) => [key, value[key] ?? null])));
  const event =
    typeof pkg.importProvenance?.commandId === 'string' &&
    store.get(
      "SELECT value_json FROM events WHERE project_id=? AND command_id=? AND type='source.importBundle'",
      projectId,
      pkg.importProvenance.commandId
    );
  if (!event || claimed(JSON.parse(event.value_json)) !== claimed(pkg))
    fail('SOURCE_PROVENANCE_UNVERIFIED', 'Preservation provenance does not match a recorded bundle import.');
}
export async function prepareSourceImport(service, envelope, payload, { preserved = false } = {}) {
  const { package: pkg, blobs = [] } = payload;
  validateSourcePackage(pkg);
  if (!preserved) assertRecordedProvenance(service.store, envelope.projectId, pkg);
  if (!Array.isArray(blobs)) fail('INVALID_INPUT', 'Expected source bytes.');
  const supplied = new Map();
  for (const blob of blobs) {
    if (
      !Array.isArray(blob.bytes) ||
      !blob.bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    )
      fail('INVALID_INPUT', 'Expected byte arrays.');
    const bytes = Uint8Array.from(blob.bytes);
    if (hashBytes(bytes) !== blob.blobId)
      fail(
        'SOURCE_BLOB_MISMATCH',
        'Source bytes differ from the declared hash.'
      );
    if (
      !pkg.blobManifest.some(
        (b) => b.blobId === blob.blobId && b.byteLength === bytes.length
      )
    )
      fail(
        'SOURCE_BLOB_MISMATCH',
        'Source bytes are not declared by this package.'
      );
    supplied.set(blob.blobId, bytes);
  }
  for (const manifest of pkg.blobManifest) {
    if (supplied.has(manifest.blobId))
      await service.blobs.put(
        envelope.projectId,
        supplied.get(manifest.blobId)
      );
    else await service.blobs.read(envelope.projectId, manifest.blobId);
  }
  return pkg;
}
export function validateSourceImport({ store, envelope, aggregate, prepared }) {
  const pkg = validateSourcePackage(prepared);
  if (pkg.importProvenance && pkg.productionId != null)
    requireValue(store, envelope.projectId, 'production', pkg.productionId);
  if (aggregate.revision)
    fail('SOURCE_IMMUTABLE', 'Imported source packages are immutable.');
  for (const blob of pkg.blobManifest) {
    const row = store.get(
      'SELECT byte_length,status FROM blobs WHERE project_id=? AND id=?',
      envelope.projectId,
      blob.blobId
    );
    if (
      !row ||
      row.status !== 'available' ||
      row.byte_length !== blob.byteLength
    )
      fail(
        'INVALID_REFERENCE',
        'Source bytes are unavailable in this project.'
      );
  }
}
export const applySourceImport = ({ prepared }) => prepared;
export function registerSourceCommands(service) {
  service.registerCommand('source.import', {
    target: ({ envelope }) => ({
      kind: 'sourcePackage',
      id: envelope.payload.package.id,
    }),
    prepare: ({ envelope }) =>
      prepareSourceImport(service, envelope, envelope.payload),
    validate: validateSourceImport,
    apply: applySourceImport,
  });
}
export function registerSourceCaptureCommands(service, { capture }) {
  if (typeof capture !== 'function')
    fail('INVALID_INPUT', 'Expected a source capture connector.');
  service.registerCommand('source.capture', {
    target({ envelope }) {
      const { id, workId, request } = envelope.payload;
      assertId(id);
      assertId(workId);
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        Object.keys(envelope.payload).some(
          (key) => !['id', 'workId', 'request'].includes(key)
        )
      )
        fail('INVALID_INPUT', 'Expected an explicit source selection.');
      return { kind: 'sourcePackage', id };
    },
    async prepare({ envelope }) {
      const { id, workId, request } = envelope.payload;
      const exported = await capture({ workId, request });
      return prepareSourceImport(service, envelope, {
        package: { ...exported.package, id },
        blobs: exported.blobs,
      });
    },
    validate: validateSourceImport,
    apply: applySourceImport,
  });
}
