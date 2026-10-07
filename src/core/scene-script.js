import { join, isAbsolute, resolve } from 'node:path';
import { unlink, readdir } from 'node:fs/promises';
import { createLoreScript, validateLoreScript, prepareLoreScriptProduction } from '../../engine/src/lore/script.js';
import { hashLore, isLoreRevisionId } from '../../engine/src/lore/registry.js';
import { requireLore, validateShape, LORE_ID_SCHEMA } from '../../engine/src/lore/schemas.js';
import { UniverseStore } from '../store/universe-store.js';
import { AssetCatalogStore } from '../store/asset-catalog-store.js';
import { loreReadText, loreReadJson, loreWriteText, loreWriteJson } from './lore-files.js';
import { renderProductionContext } from './production-input.js';
import { sealProductionInput, readSealedProductionInput } from './input-objects.js';

// A standalone scene script is the source of a work that has no novel. The
// adopted revision is immutable; scenes/<scriptId>.md is its readable copy.
// Nothing here creates a Foundation, a chapter or a story-state fold.
const base = rootDir => join(rootDir, '.vibelore', 'scene-scripts');
const objectPath = (rootDir, id) => join(base(rootDir), 'objects', `${id.slice(7)}.json`);
const headPath = (rootDir, scriptId) => join(base(rootDir), 'heads', `${scriptId}.json`);
const proposalPath = (rootDir, id) => join(base(rootDir), 'proposals', `${id.slice(7)}.json`);
const pendingPath = rootDir => join(base(rootDir), 'pending.json');
export const sceneScriptFile = scriptId => `scenes/${scriptId}.md`;

export function renderSceneScript(script) {
  return [`# ${script.title}`, '', `<!-- vibelore scene-script ${script.scriptId} ${script.revisionId}. Edit through lore_scene_script inspect/apply; direct edits are drafts. -->`, '',
    ...script.scenes.flatMap(scene => [`## ${scene.id} (${scene.frame}, ${scene.scope.timelineId}/${scene.scope.pointId})`, '', scene.text.trim(), '']), ''].join('\n');
}

async function pinnedInputs({ worldRoot, script }) {
  requireLore(isAbsolute(worldRoot ?? ''), 'INVALID_LORE_DATA', 'worldRoot must be an explicit absolute world directory');
  const world = new UniverseStore(worldRoot, script.universeId), status = await world.status();
  requireLore(status.drift.status === 'clean', 'SHARED_LORE_SOURCE_DRIFT', 'adopt world edits before pinning a script', status.drift);
  const publication = await world.read(script.loreRevisionId);
  const assets = new AssetCatalogStore(worldRoot, script.universeId);
  const catalog = script.assetCatalogRevisionId ? await assets.closure({ catalogRevisionId: script.assetCatalogRevisionId,
    assetIds: script.cast.flatMap(m => m.assetIds), expressionProfileId: script.expressionProfileId }) : null;
  return { publication, catalog, assets };
}

export async function readAdoptedScript({ rootDir, scriptId, revisionId }) {
  validateShape(LORE_ID_SCHEMA, scriptId, 'scriptId');
  const head = await loreReadJson(rootDir, headPath(rootDir, scriptId));
  const target = revisionId ?? head?.revisionId;
  requireLore(target && isLoreRevisionId(target), 'SCENE_SCRIPT_NOT_FOUND', scriptId);
  const script = validateLoreScript(await loreReadJson(rootDir, objectPath(rootDir, target)) ?? requireLore(false, 'SCENE_SCRIPT_NOT_FOUND', target));
  requireLore(script.scriptId === scriptId, 'LORE_INTEGRITY', 'script ID mismatch');
  return { script, head };
}

/** Validate, resolve and preview. Unresolved inputs return blockers and no proposal. */
export async function inspectSceneScript({ store, workId, worldRoot, script: input }) {
  requireLore(resolve(worldRoot ?? '') !== resolve(store.rootDir), 'INVALID_LORE_DATA', 'use a separate world directory');
  const script = createLoreScript(input);
  requireLore(script.workId === workId, 'INVALID_LORE_DATA', 'script workId mismatch');
  const { publication, catalog } = await pinnedInputs({ worldRoot, script });
  const prepared = prepareLoreScriptProduction({ script, publication, catalog });
  if (prepared.status !== 'ready') return { status: 'unresolved', blockers: prepared.blockers, next: 'Adopt the missing values with lore_universe, select scenes/assets that apply, or mark a past scene frame="flashback".' };
  const lock = prepared.lock, contextText = renderProductionContext(lock, null);
  const head = await loreReadJson(store.rootDir, headPath(store.rootDir, script.scriptId));
  const before = await loreReadText(store.rootDir, join(store.rootDir, sceneScriptFile(script.scriptId)));
  const proposal = { schemaVersion: 1, workId, scriptId: script.scriptId, expectedHead: head?.revisionId ?? null, worldRoot, script, productionLockId: lock.revisionId, before, after: renderSceneScript(script) };
  const proposalId = hashLore(proposal);
  await loreWriteJson(store.rootDir, proposalPath(store.rootDir, proposalId), proposal, { immutable: true });
  return { status: 'awaiting_approval', proposalId, expectedHead: proposal.expectedHead, scriptRevisionId: script.revisionId, productionLockId: lock.revisionId,
    language: script.language, scenes: lock.scenes.map(s => ({ id: s.id, frame: s.frame, scope: s.scope, stateIds: s.stateIds, projections: s.projections.map(({ localCharacterId, target, value }) => ({ localCharacterId, target, value })), assetIds: s.assetIds })),
    sceneVarying: lock.sceneVarying, assets: lock.assets.map(({ assetId, assetRevisionId, entityId, stateIds, sceneIds, blob }) => ({ assetId, assetRevisionId, entityId, stateIds, sceneIds, blob })),
    expression: lock.expression, contextText, readableFile: { path: sceneScriptFile(script.scriptId), before, after: proposal.after },
    note: 'Approve the exact script text, scene order, world points, state selection and assets. Adoption pins them for production; it does not change the shared world or any novel.' };
}

export async function applySceneScript({ store, workId, proposalId, expectedHead }) {
  requireLore(isLoreRevisionId(proposalId), 'INVALID_LORE_DATA', 'proposalId');
  const proposal = await loreReadJson(store.rootDir, proposalPath(store.rootDir, proposalId));
  requireLore(proposal && hashLore(proposal) === proposalId && proposal.workId === workId, 'LORE_INTEGRITY', 'scene script proposal mismatch');
  const head = await loreReadJson(store.rootDir, headPath(store.rootDir, proposal.scriptId));
  if (head?.proposalId === proposalId) return { status: 'adopted', scriptId: proposal.scriptId, scriptRevisionId: head.revisionId, productionLockId: head.productionLockId, replayed: true };
  requireLore(expectedHead === proposal.expectedHead && (head?.revisionId ?? null) === expectedHead, 'STALE_SCENE_SCRIPT', 'script HEAD changed after review');
  requireLore(await loreReadText(store.rootDir, join(store.rootDir, sceneScriptFile(proposal.scriptId))) === proposal.before, 'SCENE_SCRIPT_DRIFT', 'the readable script file changed after review');
  const script = validateLoreScript(proposal.script);
  const { publication, catalog, assets } = await pinnedInputs({ worldRoot: proposal.worldRoot, script });
  const prepared = prepareLoreScriptProduction({ script, publication, catalog });
  requireLore(prepared.status === 'ready' && prepared.lock.revisionId === proposal.productionLockId, 'STALE_SCENE_SCRIPT', 'pinned inputs no longer reproduce the reviewed lock');
  // Preserve the complete input closure before the HEAD can name it.
  const sealed = await sealProductionInput({ rootDir: store.rootDir, lock: prepared.lock, readBlob: id => assets.readBlob(id) });
  await loreWriteJson(store.rootDir, objectPath(store.rootDir, script.revisionId), script, { immutable: true });
  await loreWriteJson(store.rootDir, pendingPath(store.rootDir), { proposalId });
  await loreWriteJson(store.rootDir, headPath(store.rootDir, script.scriptId), { scriptId: script.scriptId, revisionId: script.revisionId, productionLockId: prepared.lock.revisionId, proposalId, readableDigest: hashLore(proposal.after) });
  await resumePendingSceneScript({ store });
  return { status: 'adopted', scriptId: script.scriptId, scriptRevisionId: script.revisionId, productionLockId: prepared.lock.revisionId, sealedAssets: sealed.blobs, path: sceneScriptFile(script.scriptId) };
}

/** Finish an interrupted adoption: write only the approved readable bytes, never over new human edits. */
export async function resumePendingSceneScript({ store }) {
  const journal = await loreReadJson(store.rootDir, pendingPath(store.rootDir));
  if (!journal) return null;
  const proposal = await loreReadJson(store.rootDir, proposalPath(store.rootDir, journal.proposalId));
  requireLore(proposal && hashLore(proposal) === journal.proposalId, 'LORE_INTEGRITY', 'scene script recovery proposal mismatch');
  const head = await loreReadJson(store.rootDir, headPath(store.rootDir, proposal.scriptId));
  if (head?.proposalId === journal.proposalId) {
    const path = join(store.rootDir, sceneScriptFile(proposal.scriptId)), current = await loreReadText(store.rootDir, path);
    requireLore(current === proposal.before || current === proposal.after, 'SCENE_SCRIPT_DRIFT', 'the readable script has new human edits; preserve them before recovery');
    await loreWriteText(store.rootDir, path, proposal.after);
  }
  await unlink(pendingPath(store.rootDir));
  return { status: head?.proposalId === journal.proposalId ? 'recovered' : 'not_published' };
}

export async function sceneScriptStatus({ store, scriptId }) {
  const heads = scriptId ? [scriptId] : (await readdir(join(base(store.rootDir), 'heads')).catch(() => [])).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5));
  const scripts = [];
  for (const id of heads.sort()) {
    const { script, head } = await readAdoptedScript({ rootDir: store.rootDir, scriptId: id });
    const readable = await loreReadText(store.rootDir, join(store.rootDir, sceneScriptFile(id)));
    let sealed = 'verified';
    try { await readSealedProductionInput({ rootDir: store.rootDir, productionLockId: head.productionLockId }); } catch (error) { sealed = error.code ?? 'invalid'; }
    scripts.push({ scriptId: id, scriptRevisionId: script.revisionId, productionLockId: head.productionLockId, title: script.title, language: script.language,
      scenes: script.scenes.map(s => s.id), readable: readable === null ? 'missing' : hashLore(readable) === head.readableDigest ? 'clean' : 'modified', sealedInputs: sealed });
  }
  return { status: 'ok', scripts };
}
