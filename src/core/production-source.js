import { join } from 'node:path';
import { resolveWebtoonSource } from '../store/webtoon-store.js';
import { digest } from './webtoon-contract.js';
import { requireLore } from '../../engine/src/lore/schemas.js';
import { hashLore } from '../../engine/src/lore/registry.js';
import { loreSceneParagraphs } from '../../engine/src/lore/scene-check.js';
import { loreReadText } from './lore-files.js';
import { readAdoptedScript, sceneScriptFile } from './scene-script.js';
import { readSealedProductionInput } from './input-objects.js';
import { renderProductionContext } from './production-input.js';

/**
 * One production-source contract for media adapters. A novel chapter source
 * keeps the original (sourceVersion 1) snapshot so running workflows verify
 * unchanged; a scene-script source (sourceVersion 2) is read only from the
 * adopted script and the work's sealed input closure.
 */
export async function resolveProductionSource(store, workId, request) {
  if (request.kind === 'novel-chapters') return { kind: 'novel-chapters', ...await resolveWebtoonSource(store, workId, request.chapters) };
  requireLore(request.kind === 'scene-script', 'INVALID_LORE_DATA', `unsupported production source ${request.kind}`);
  return resolveScriptSource(store, workId, request);
}

async function resolveScriptSource(store, workId, { scriptId, scriptRevisionId, productionLockId }) {
  const { script, head } = await readAdoptedScript({ rootDir: store.rootDir, scriptId, revisionId: scriptRevisionId });
  requireLore(head, 'SCENE_SCRIPT_NOT_FOUND', `${scriptId} has no adopted HEAD`);
  requireLore(script.workId === workId, 'WORKFLOW_WORK_MISMATCH', 'script belongs to another work');
  const readable = await loreReadText(store.rootDir, join(store.rootDir, sceneScriptFile(scriptId)));
  requireLore(readable !== null && hashLore(readable) === head.readableDigest, 'SCENE_SCRIPT_DRIFT', `${sceneScriptFile(scriptId)} has unadopted edits; adopt them with lore_scene_script inspect/apply`);
  const lockId = productionLockId ?? (head.revisionId === script.revisionId ? head.productionLockId : requireLore(false, 'PRODUCTION_INPUT_MISSING', 'pin the production lock of an older script revision'));
  const { lock, blobs } = await readSealedProductionInput({ rootDir: store.rootDir, productionLockId: lockId });
  requireLore(lock.sourceKind === 'scene-script' && lock.scriptRevisionId === script.revisionId && lock.workId === workId, 'LORE_INTEGRITY', 'sealed lock does not belong to this script revision');
  const units = lock.scenes.flatMap(scene => loreSceneParagraphs(script.scenes.find(s => s.id === scene.id).text)
    .map((p, i) => ({ id: `${scene.id}-p-${i + 1}`, sceneId: scene.id, text: p.text, hash: digest(p.text) })));
  const documents = [...new Map(lock.scenes.flatMap(scene => scene.documents.map(doc => [doc.id, { id: doc.id, path: doc.path, raw: doc.text, hash: digest(doc.text), temporalScope: 'pinned-scene-state' }]))).values()];
  const names = new Map(lock.projections.filter(p => p.target === 'canonicalName').map(p => [p.localCharacterId, p.value]));
  const snapshot = {
    sourceVersion: 2, kind: 'scene-script', workId, scriptId, scriptRevisionId: script.revisionId, productionLockId: lock.revisionId,
    loreRevisionId: lock.loreRevisionId, assetCatalogRevisionId: lock.assetCatalogRevisionId, title: script.title,
    languageContract: { version: 1, language: script.language, promptFamily: new Intl.Locale(script.language).language === 'ko' ? 'ko' : 'multilingual', resolver: 'scene-script', scriptRevisionId: script.revisionId, allowedLanguageExceptions: [] },
    sourceCanonHead: null, sourceStatus: 'adopted_script', foundation: null, chapters: [],
    cast: script.cast.map(m => ({ id: m.localCharacterId, entityId: m.entityId, name: names.get(m.localCharacterId) ?? m.localCharacterId })),
    documents, sharedLore: { productionLockId: lock.revisionId, contextText: renderProductionContext(lock, null) }, expression: lock.expression,
    assets: lock.assets.map(a => ({ assetId: a.assetId, assetRevisionId: a.assetRevisionId, entityId: a.entityId, stateIds: a.stateIds, sceneIds: a.sceneIds, label: a.label, mime: a.blob.mime, hash: a.blob.blobId, path: blobs.find(b => b.assetId === a.assetId).path })),
    stateNote: 'Each scene is pinned to its own world point and approved state. Documents are only the context documents selected for those states; author-only and future-state documents are excluded.',
    units,
  };
  return { ...snapshot, hash: digest(snapshot) };
}

/** Re-verify a running workflow's source: same bytes, same lock, no unadopted edits. */
export async function verifyProductionSource(store, source, workId) {
  const current = source.kind === 'scene-script'
    ? await resolveScriptSource(store, workId, { scriptId: source.scriptId, scriptRevisionId: source.scriptRevisionId, productionLockId: source.productionLockId })
    : await resolveWebtoonSource(store, workId, source.chapters.map(c => c.chapter));
  if (current.hash !== source.hash) throw new Error('SCENE_SOURCE_CHANGED');
  return current;
}
