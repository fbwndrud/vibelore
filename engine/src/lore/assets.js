import { createHash } from 'node:crypto';
import { hashLore, encodeLore, isLoreRevisionId } from './registry.js';
import { requireLore, validateShape, LORE_ID_SCHEMA } from './schemas.js';

// Asset identity, file bytes, catalog adoption and expression choices are
// separate records. Expression profiles describe presentation; they never own
// a world field, so a palette cannot overwrite a canonical eye colour.
export const LORE_ASSET_LIMITS = Object.freeze({ maxBytes: 20 * 1024 * 1024, minBytes: 24, maxPixels: 100_000_000, assets: 10000, profiles: 1000 });
export const LORE_ASSET_PURPOSES = Object.freeze(['reference-image']);
export const LORE_ASSET_DERIVATIONS = Object.freeze(['crop', 'edit', 'upscale', 'variant', 'redraw']);
const text = (value, path, max = 8000) => requireLore(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_LORE_DATA', `${path} must be nonempty text`);
const id = (v, p) => validateShape(LORE_ID_SCHEMA, v, p);
const closed = (value, allowed, required, path) => requireLore(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(value, k)), 'INVALID_LORE_DATA', `invalid ${path}`);
export const loreBlobId = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Container sniffing and dimensions from the actual bytes; the file name or a declared MIME is never trusted. */
export function inspectLoreImage(bytes) {
  requireLore(bytes instanceof Uint8Array, 'INVALID_ASSET_FILE', 'bytes required');
  requireLore(bytes.length >= LORE_ASSET_LIMITS.minBytes && bytes.length <= LORE_ASSET_LIMITS.maxBytes, 'INVALID_ASSET_FILE', `size must be ${LORE_ASSET_LIMITS.minBytes}..${LORE_ASSET_LIMITS.maxBytes} bytes`);
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let mime, width, height;
  if (view.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    // Walk the chunk list: IHDR first, at least one IDAT, IEND exactly at the end.
    let offset = 8, data = false, ended = false;
    while (offset + 12 <= view.length) {
      const length = view.readUInt32BE(offset), kind = view.toString('latin1', offset + 4, offset + 8);
      requireLore(offset + length + 12 <= view.length, 'INVALID_ASSET_FILE', 'truncated PNG chunk');
      if (offset === 8) { requireLore(kind === 'IHDR' && length === 13, 'INVALID_ASSET_FILE', 'PNG without IHDR'); width = view.readUInt32BE(16); height = view.readUInt32BE(20); }
      if (kind === 'IDAT') data = true;
      offset += length + 12;
      if (kind === 'IEND') { ended = length === 0 && offset === view.length; break; }
    }
    requireLore(width !== undefined && data && ended, 'INVALID_ASSET_FILE', 'incomplete PNG container');
    mime = 'image/png';
  } else if (view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) {
    mime = 'image/jpeg';
    for (let i = 2; i + 9 < view.length;) {
      if (view[i] !== 0xff) { i++; continue; }
      const marker = view[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = view.readUInt16BE(i + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) { height = view.readUInt16BE(i + 5); width = view.readUInt16BE(i + 7); break; }
      i += 2 + length;
    }
    requireLore(view[view.length - 2] === 0xff && view[view.length - 1] === 0xd9, 'INVALID_ASSET_FILE', 'truncated JPEG');
  } else requireLore(false, 'INVALID_ASSET_FILE', 'only PNG or JPEG images are supported');
  requireLore(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width * height <= LORE_ASSET_LIMITS.maxPixels, 'INVALID_ASSET_FILE', 'image dimensions unreadable or too large');
  return { blobId: loreBlobId(view), mime, size: view.length, width, height };
}

const seal = payload => { const normalized = JSON.parse(encodeLore(payload)); return { revisionId: hashLore(normalized), ...normalized }; };
export function verifyLoreAssetObject(object, kind) {
  const { revisionId, ...payload } = object ?? {};
  requireLore(isLoreRevisionId(revisionId) && hashLore(payload) === revisionId && payload.kind === kind, 'LORE_INTEGRITY', `${kind} object hash mismatch`);
  ({ asset: validateAssetPayload, 'expression-profile': validateProfilePayload, catalog: validateCatalogPayload })[kind](payload);
  return object;
}

function validateAssetPayload(a) {
  const keys = ['schemaVersion', 'kind', 'assetId', 'parentRevisionId', 'blob', 'purpose', 'label', 'notes', 'entityId', 'stateIds', 'expressionProfileId', 'derivedFrom', 'provenance', 'linkedLoreRevisionId'];
  closed(a, keys, keys, 'asset revision');
  requireLore(a.schemaVersion === 1 && a.kind === 'asset', 'INVALID_LORE_DATA', 'unsupported asset schema');
  id(a.assetId, 'assetId'); id(a.entityId, 'entityId'); text(a.label, 'label', 200);
  requireLore(a.notes === null || (typeof a.notes === 'string' && a.notes.length <= 8000), 'INVALID_LORE_DATA', 'notes');
  requireLore(LORE_ASSET_PURPOSES.includes(a.purpose), 'REQUIRED_CAPABILITY', `asset purpose ${a.purpose}`);
  requireLore(a.parentRevisionId === null || isLoreRevisionId(a.parentRevisionId), 'INVALID_LORE_DATA', 'parentRevisionId');
  requireLore(isLoreRevisionId(a.linkedLoreRevisionId), 'INVALID_LORE_DATA', 'linkedLoreRevisionId');
  closed(a.blob, ['blobId', 'mime', 'size', 'width', 'height'], ['blobId', 'mime', 'size', 'width', 'height'], 'asset blob');
  requireLore(isLoreRevisionId(a.blob.blobId) && ['image/png', 'image/jpeg'].includes(a.blob.mime) && [a.blob.size, a.blob.width, a.blob.height].every(n => Number.isSafeInteger(n) && n > 0), 'INVALID_LORE_DATA', 'asset blob metadata');
  requireLore(Array.isArray(a.stateIds) && new Set(a.stateIds).size === a.stateIds.length && a.stateIds.length <= 100, 'INVALID_LORE_DATA', 'stateIds'); a.stateIds.forEach(s => id(s, 'stateId'));
  if (a.expressionProfileId !== null) id(a.expressionProfileId, 'expressionProfileId');
  if (a.derivedFrom !== null) {
    closed(a.derivedFrom, ['assetRevisionId', 'relation'], ['assetRevisionId', 'relation'], 'derivedFrom');
    requireLore(isLoreRevisionId(a.derivedFrom.assetRevisionId) && LORE_ASSET_DERIVATIONS.includes(a.derivedFrom.relation), 'INVALID_LORE_DATA', 'derivedFrom');
  }
  closed(a.provenance, ['kind', 'sourceName', 'note'], ['kind', 'sourceName', 'note'], 'provenance');
  requireLore(['import'].includes(a.provenance.kind) && typeof a.provenance.sourceName === 'string' && a.provenance.sourceName.length <= 300 && (a.provenance.note === null || typeof a.provenance.note === 'string'), 'INVALID_LORE_DATA', 'provenance');
}
// Presentation fields only. Any key that would carry a world value is refused by name.
const PROFILE_KEYS = ['schemaVersion', 'kind', 'profileId', 'parentRevisionId', 'label', 'style', 'palette', 'casting', 'notes'];
const WORLD_KEYS = ['values', 'fields', 'fieldId', 'fieldDefinitionRevisionId', 'overrides', 'facts', 'states', 'storyScope', 'intrinsic'];
function validateProfilePayload(p) {
  const leaked = WORLD_KEYS.filter(key => Object.hasOwn(p ?? {}, key));
  requireLore(!leaked.length, 'EXPRESSION_PROFILE_OWNERSHIP', `expression profiles cannot own world values (${leaked.join(', ')}); adopt world changes with lore_universe`);
  closed(p, PROFILE_KEYS, PROFILE_KEYS, 'expression profile');
  requireLore(p.schemaVersion === 1 && p.kind === 'expression-profile', 'INVALID_LORE_DATA', 'unsupported profile schema');
  id(p.profileId, 'profileId'); text(p.label, 'label', 200); text(p.style, 'style');
  requireLore(p.parentRevisionId === null || isLoreRevisionId(p.parentRevisionId), 'INVALID_LORE_DATA', 'parentRevisionId');
  requireLore(Array.isArray(p.palette) && p.palette.length <= 50 && p.palette.every(c => typeof c === 'string' && c.length <= 200), 'INVALID_LORE_DATA', 'palette');
  requireLore(Array.isArray(p.casting) && p.casting.length <= 1000, 'INVALID_LORE_DATA', 'casting');
  for (const row of p.casting) { closed(row, ['entityId', 'note'], ['entityId', 'note'], 'casting row'); id(row.entityId, 'entityId'); text(row.note, 'casting note'); }
  requireLore(p.notes === null || (typeof p.notes === 'string' && p.notes.length <= 8000), 'INVALID_LORE_DATA', 'notes');
}
function validateCatalogPayload(c) {
  const keys = ['schemaVersion', 'kind', 'universeId', 'parentRevisionId', 'assets', 'profiles', 'change'];
  closed(c, keys, keys, 'asset catalog');
  requireLore(c.schemaVersion === 1 && c.kind === 'catalog' && (c.parentRevisionId === null || isLoreRevisionId(c.parentRevisionId)), 'INVALID_LORE_DATA', 'catalog version');
  id(c.universeId, 'universeId');
  for (const [name, limit] of [['assets', LORE_ASSET_LIMITS.assets], ['profiles', LORE_ASSET_LIMITS.profiles]]) {
    closed(c[name], Object.keys(c[name] ?? {}), [], `catalog ${name}`);
    requireLore(Object.keys(c[name]).length <= limit && Object.entries(c[name]).every(([key, rev]) => { id(key, name); return isLoreRevisionId(rev); }), 'INVALID_LORE_DATA', `catalog ${name}`);
  }
  closed(c.change, ['proposalId', 'reason'], ['proposalId', 'reason'], 'catalog change'); text(c.change.reason, 'reason');
  requireLore(isLoreRevisionId(c.change.proposalId), 'INVALID_LORE_DATA', 'proposalId');
}

export function createLoreAssetRevision(input) {
  const payload = { schemaVersion: 1, kind: 'asset', parentRevisionId: null, notes: null, stateIds: [], expressionProfileId: null, derivedFrom: null, ...input };
  validateAssetPayload(payload);
  return seal(payload);
}
export function createLoreExpressionProfile(input) {
  const payload = { schemaVersion: 1, kind: 'expression-profile', parentRevisionId: null, palette: [], casting: [], notes: null, ...input };
  validateProfilePayload(payload);
  return seal(payload);
}
export function createLoreAssetCatalog({ universeId, parent, assets = [], profiles = [], proposalId, reason }) {
  const next = { assets: { ...(parent?.assets ?? {}) }, profiles: { ...(parent?.profiles ?? {}) } };
  for (const asset of assets) {
    const current = Object.hasOwn(next.assets, asset.assetId) ? next.assets[asset.assetId] : null;
    // Replacement is a child revision of the adopted one; a stale parent cannot overwrite a newer choice.
    requireLore(asset.parentRevisionId === current, 'STALE_ASSET_REVISION', asset.assetId, { expectedParent: current, proposedParent: asset.parentRevisionId });
    next.assets[asset.assetId] = asset.revisionId;
  }
  for (const profile of profiles) {
    const current = Object.hasOwn(next.profiles, profile.profileId) ? next.profiles[profile.profileId] : null;
    requireLore(profile.parentRevisionId === current, 'STALE_ASSET_REVISION', profile.profileId, { expectedParent: current, proposedParent: profile.parentRevisionId });
    next.profiles[profile.profileId] = profile.revisionId;
  }
  const payload = { schemaVersion: 1, kind: 'catalog', universeId, parentRevisionId: parent?.revisionId ?? null, ...next, change: { proposalId, reason } };
  validateCatalogPayload(payload);
  return seal(payload);
}

/** Entity/state links are checked against an exact LoreRevision; no latest-world lookup. */
export function validateLoreAssetLinks({ asset, revision }) {
  const entity = revision.content.entities.find(e => e.id === asset.entityId);
  requireLore(entity, 'ASSET_LINK_MISSING', `entity ${asset.entityId} is not in lore revision`);
  for (const stateId of asset.stateIds) requireLore(revision.content.states.some(s => s.id === stateId && s.entityId === asset.entityId), 'ASSET_LINK_MISSING', `state ${stateId} of ${asset.entityId}`);
}
