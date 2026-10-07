import { hashLore, encodeLore, isLoreRevisionId } from './registry.js';
import { requireLore, validateShape, LORE_ID_SCHEMA } from './schemas.js';
import { validateLoreCast, validateLoreScenes, validateLoreProjections, resolveLoreScenes, checkLorePublication, lorePublicationClosure } from './scenes.js';
import { verifyLoreAssetObject, validateLoreAssetLinks } from './assets.js';

// A standalone scene script is a production source of its own. It never
// creates a novel Foundation, a chapter, or a story-state fold.
export const LORE_SCRIPT_RESOLVER_VERSION = 'shared-lore-resolver-v2';
export const LORE_SCRIPT_LIMITS = Object.freeze({ scenes: 50, sceneChars: 20000 });
const id = (v, p) => validateShape(LORE_ID_SCHEMA, v, p);
const closed = (value, allowed, required, path) => requireLore(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(value, k)), 'INVALID_LORE_DATA', `invalid ${path}`);
const KEYS = ['schemaVersion', 'workId', 'scriptId', 'title', 'language', 'universeId', 'loreRevisionId', 'registryRevisionId', 'continuityId', 'assetCatalogRevisionId', 'expressionProfileId', 'cast', 'scenes'];

export function createLoreScript(input) {
  closed(input, KEYS, KEYS, 'scene script');
  requireLore(input.schemaVersion === 1, 'UNSUPPORTED_SCHEMA', `scene script schemaVersion ${input.schemaVersion}`);
  for (const key of ['workId', 'scriptId', 'universeId', 'continuityId']) id(input[key], key);
  requireLore(typeof input.title === 'string' && input.title.trim() && input.title.length <= 200, 'INVALID_LORE_DATA', 'title');
  let language;
  try { language = Intl.getCanonicalLocales(input.language)[0]; } catch { language = null; }
  requireLore(language && language === input.language, 'INVALID_LORE_DATA', 'language must be a canonical BCP 47 tag');
  requireLore(isLoreRevisionId(input.loreRevisionId) && isLoreRevisionId(input.registryRevisionId), 'INVALID_LORE_DATA', 'pin loreRevisionId and registryRevisionId');
  requireLore(input.assetCatalogRevisionId === null || isLoreRevisionId(input.assetCatalogRevisionId), 'INVALID_LORE_DATA', 'assetCatalogRevisionId');
  requireLore(input.expressionProfileId === null || (input.assetCatalogRevisionId !== null && (id(input.expressionProfileId, 'expressionProfileId'), true)), 'INVALID_LORE_DATA', 'an expression profile needs a pinned asset catalog');
  requireLore(Array.isArray(input.cast) && input.cast.length > 0, 'INVALID_LORE_DATA', 'cast required');
  validateLoreCast(input.cast.map(({ assetIds, ...member }) => member));
  for (const member of input.cast) {
    requireLore(Array.isArray(member.assetIds) && new Set(member.assetIds).size === member.assetIds.length && member.assetIds.length <= 16, 'INVALID_LORE_DATA', 'assetIds');
    member.assetIds.forEach(a => id(a, 'assetId'));
    requireLore(!member.assetIds.length || input.assetCatalogRevisionId, 'INVALID_LORE_DATA', 'selected assets need a pinned asset catalog');
  }
  requireLore(Array.isArray(input.scenes) && input.scenes.length <= LORE_SCRIPT_LIMITS.scenes, 'INVALID_LORE_DATA', 'scenes');
  validateLoreScenes(input.scenes.map(({ text, ...scene }) => scene), { continuityId: input.continuityId, limit: LORE_SCRIPT_LIMITS.scenes });
  for (const scene of input.scenes) {
    requireLore(typeof scene.text === 'string' && scene.text.trim() && [...scene.text].length <= LORE_SCRIPT_LIMITS.sceneChars, 'INVALID_LORE_DATA', `scene ${scene.id} needs the exact script text`);
    requireLore(scene.entityIds.every(e => input.cast.some(c => c.entityId === e)), 'INVALID_ENTITY_REFERENCE', `scene ${scene.id} selects a character outside the cast`);
  }
  const payload = JSON.parse(encodeLore(input));
  return { revisionId: hashLore(payload), ...payload };
}
export function validateLoreScript(script) {
  const { revisionId, ...payload } = script ?? {};
  const normalized = createLoreScript(payload);
  requireLore(normalized.revisionId === revisionId, 'LORE_INTEGRITY', 'scene script hash mismatch');
  return normalized;
}

/**
 * Resolve every scene and pin the exact catalog, asset revisions and blob IDs.
 * The caller preserves the bytes; this pure function only binds their hashes.
 */
export function prepareLoreScriptProduction({ script, publication, catalog = null }) {
  validateLoreScript(script);
  const { resolver, documents, entities, definitions } = checkLorePublication(publication, script);
  validateLoreProjections({ cast: script.cast, definitions, entities });
  const scenes = script.scenes.map(({ text, ...scene }) => scene);
  const resolved = resolveLoreScenes({ revision: publication.revision, resolver, documents, entities, definitions, cast: script.cast, scenes });
  const blockers = [...resolved.blockers];
  let expression = null; const assets = [];
  if (script.assetCatalogRevisionId) {
    requireLore(catalog?.revision?.revisionId === script.assetCatalogRevisionId, 'LORE_INTEGRITY', 'asset catalog revision does not match the script');
    verifyLoreAssetObject(catalog.revision, 'catalog');
    requireLore(catalog.revision.universeId === script.universeId, 'LORE_UNIVERSE_MISMATCH', 'asset catalog universe');
    const byRevision = new Map((catalog.assetRevisions ?? []).map(a => [a.revisionId, verifyLoreAssetObject(a, 'asset')]));
    if (script.expressionProfileId) {
      const profileRevisionId = catalog.revision.profiles[script.expressionProfileId];
      requireLore(profileRevisionId && catalog.profileRevision?.revisionId === profileRevisionId, 'ASSET_NOT_APPROVED', `expression profile ${script.expressionProfileId}`);
      expression = verifyLoreAssetObject(catalog.profileRevision, 'expression-profile');
    } else requireLore(!catalog.profileRevision, 'LORE_INTEGRITY', 'unexpected expression profile in closure');
    for (const member of script.cast) for (const assetId of member.assetIds) {
      const revisionId = catalog.revision.assets[assetId];
      requireLore(revisionId && byRevision.has(revisionId), 'ASSET_NOT_APPROVED', assetId);
      const asset = byRevision.get(revisionId);
      requireLore(asset.entityId === member.entityId, 'ASSET_ENTITY_MISMATCH', `${assetId} depicts ${asset.entityId}, not ${member.entityId}`);
      validateLoreAssetLinks({ asset, revision: publication.revision });
      const sceneIds = resolved.scenes.filter(s => s.entityIds.includes(member.entityId) && (!asset.stateIds.length || asset.stateIds.some(st => s.stateIds[member.entityId].includes(st)))).map(s => s.id);
      if (!sceneIds.length) blockers.push({ status: 'asset_state_mismatch', code: 'ASSET_STATE_MISMATCH', assetId, entityId: member.entityId, stateIds: asset.stateIds, message: 'the selected asset depicts a state that applies to no scene of this character' });
      assets.push({ assetId, assetRevisionId: revisionId, localCharacterId: member.localCharacterId, entityId: member.entityId, stateIds: asset.stateIds, sceneIds, label: asset.label, blob: asset.blob });
    }
    requireLore(byRevision.size === assets.length, 'LORE_INTEGRITY', 'closure carries unselected asset revisions');
  } else requireLore(!catalog, 'LORE_INTEGRITY', 'asset catalog supplied without a pinned revision');
  if (blockers.length) return { status: 'unresolved', blockers };
  const texts = new Map(script.scenes.map(s => [s.id, s.text]));
  const payload = JSON.parse(encodeLore({ schemaVersion: 2, resolverVersion: LORE_SCRIPT_RESOLVER_VERSION, sourceKind: 'scene-script', workId: script.workId,
    scriptId: script.scriptId, scriptRevisionId: script.revisionId, language: script.language,
    loreRevisionId: publication.publicationId, registryRevisionId: publication.registry.revisionId, assetCatalogRevisionId: script.assetCatalogRevisionId,
    scenes: resolved.scenes.map(scene => ({ ...scene, textHash: hashLore(texts.get(scene.id)), assetIds: assets.filter(a => a.sceneIds.includes(scene.id)).map(a => a.assetId) })),
    projections: resolved.projections, sceneVarying: resolved.sceneVarying,
    expression: expression ? { profileId: expression.profileId, profileRevisionId: expression.revisionId, label: expression.label, style: expression.style, palette: expression.palette, casting: expression.casting, notes: expression.notes } : null,
    assets, closure: { script, publication: lorePublicationClosure(publication), catalog: catalog ? { revision: catalog.revision, assetRevisions: catalog.assetRevisions, profileRevision: catalog.profileRevision ?? null } : null } }));
  return { status: 'ready', lock: { revisionId: hashLore(payload), ...payload } };
}
export function verifyLoreScriptLock(lock) {
  const { revisionId, ...payload } = lock;
  requireLore(hashLore(payload) === revisionId && lock.resolverVersion === LORE_SCRIPT_RESOLVER_VERSION, 'LORE_INTEGRITY', 'script lock hash/version mismatch');
  const computed = prepareLoreScriptProduction(lock.closure);
  requireLore(computed.status === 'ready' && computed.lock.revisionId === revisionId, 'LORE_INTEGRITY', 'script lock cannot be reproduced');
  return computed.lock;
}
