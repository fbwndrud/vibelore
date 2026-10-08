import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProductionSource, verifyProductionSource } from '../../../src/core/production-source.js';
import { readAdoptedScript, sceneScriptFile } from '../../../src/core/scene-script.js';
import { readSealedProductionInput } from '../../../src/core/input-objects.js';
import { makeSourcePackage, hashBytes } from './source-package.js';
import { fail, STABLE_ID } from '../engine/contracts.js';

// External Lore IDs may contain dots/colons; Studio IDs never relax their contract.
const studioId = (sourceId) =>
  STABLE_ID.test(sourceId) ? sourceId : `src_${hashBytes(Buffer.from(sourceId, 'utf8'))}`;
const portable = (value) =>
  Array.isArray(value)
    ? value.map(portable)
    : value && typeof value === 'object'
    ? Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key]) =>
              !['path', 'rootDir', 'sourcePath', 'worldRoot', 'directory', 'absolutePath'].includes(key)
          )
          .map(([key, item]) => [key, portable(item)])
      )
    : value;
/** Read-only capture. Locations remain solely in the caller's connector configuration. */
export async function exportVibeloreSource({ store, workId, request }) {
  try {
    const source = await resolveProductionSource(store, workId, request);
    const blobs = [],
      blobManifest = [],
      captures = [];
    async function capture(id, kind, path, expectedText = null, expectedBlob = null) {
      const bytes = await readFile(path);
      const blobId = hashBytes(bytes);
      if (expectedText !== null && bytes.toString('utf8') !== expectedText)
        fail('SOURCE_CAPTURE_CHANGED', 'Original source changed during capture.');
      if (expectedBlob && expectedBlob.replace(/^sha256:/, '') !== blobId)
        fail('SOURCE_CAPTURE_CHANGED', 'Sealed source bytes failed verification.');
      blobs.push({ blobId, bytes: [...bytes] });
      blobManifest.push({
        id: studioId(id),
        sourceObjectId: id,
        kind,
        blobId,
        byteLength: bytes.length,
        ...(expectedText !== null ? { readableHash: hashBytes(Buffer.from(expectedText, 'utf8')) } : {}),
      });
      captures.push({ path, blobId });
      return blobId;
    }
    let sceneScopes = [],
      states = {},
      textUnits = source.units.map((unit) => ({
        ...portable(unit),
        id: studioId(unit.id),
        sourceUnitId: unit.id,
        ...(unit.sceneId ? { sceneId: studioId(unit.sceneId), sourceSceneId: unit.sceneId } : {}),
      }));
    if (source.kind === 'novel-chapters') {
      for (const chapter of source.chapters) {
        const blobId = await capture(
          `chapter-${chapter.chapter}`,
          'chapter',
          store.chapterPath(chapter.chapter),
          chapter.raw
        );
        for (const unit of textUnits.filter((u) => u.chapter === chapter.chapter)) unit.blobId = blobId;
        sceneScopes.push({
          id: `chapter-${chapter.chapter}`,
          chapter: chapter.chapter,
          beforeState: portable(chapter.beforeState),
          afterState: portable(chapter.afterState),
          stateNote: source.stateNote,
        });
      }
      for (const [i, doc] of source.documents.entries())
        await capture(`document-${i + 1}`, 'document', join(store.rootDir, doc.path), doc.raw);
      states = { foundation: portable(source.foundation), storyProfile: portable(source.storyProfile) };
    } else {
      const { script } = await readAdoptedScript({
        rootDir: store.rootDir,
        scriptId: source.scriptId,
        revisionId: source.scriptRevisionId,
      });
      const { lock } = await readSealedProductionInput({
        rootDir: store.rootDir,
        productionLockId: source.productionLockId,
      });
      await capture(
        'script-readable',
        'script-readable',
        join(store.rootDir, sceneScriptFile(source.scriptId)),
        await readFile(join(store.rootDir, sceneScriptFile(source.scriptId)), 'utf8')
      );
      // Do not export lock.closure: its publication contains author-only/future documents.
      // Scene-selected text comes from the verified sealed lock, never current world files.
      const selectedDocuments = [
        ...new Map(lock.scenes.flatMap((scene) => scene.documents.map((doc) => [doc.id, doc]))).values(),
      ];
      for (const document of selectedDocuments) {
        const bytes = Buffer.from(document.text, 'utf8'),
          blobId = hashBytes(bytes);
        blobs.push({ blobId, bytes: [...bytes] });
        blobManifest.push({
          id: studioId(document.id),
          sourceDocumentId: document.id,
          kind: 'sealed-document',
          blobId,
          byteLength: bytes.length,
          readableHash: blobId,
        });
      }
      // The adopted script JSON itself is immutable; its exact bytes are part of closure.
      await capture(
        'adopted-script',
        'adopted-script',
        join(store.rootDir, '.vibelore', 'scene-scripts', 'objects', `${script.revisionId.slice(7)}.json`)
      );
      for (const asset of source.assets)
        await capture(asset.assetId, 'asset', join(store.rootDir, asset.path), null, asset.hash);
      sceneScopes = lock.scenes.map((scene) => ({
        ...portable(scene),
        id: studioId(scene.id),
        sourceSceneId: scene.id,
        assetIds: scene.assetIds.map(studioId),
        stateIds: Object.fromEntries(
          Object.entries(scene.stateIds).map(([entityId, ids]) => [entityId, ids.map(studioId)])
        ),
        documents: scene.documents.map((doc) => ({
          ...portable(doc),
          id: studioId(doc.id),
          sourceDocumentId: doc.id,
        })),
      }));
      states = {
        script: portable(script),
        productionLockId: lock.revisionId,
        sourceStateMap: [
          ...new Set(lock.scenes.flatMap((scene) => Object.values(scene.stateIds).flat())),
        ].map((sourceStateId) => ({ id: studioId(sourceStateId), sourceStateId })),
        projections: portable(lock.projections),
        expression: portable(lock.expression),
      };
    }
    await verifyProductionSource(store, source, workId);
    for (const captured of captures)
      if (hashBytes(await readFile(captured.path)) !== captured.blobId)
        fail('SOURCE_CAPTURE_CHANGED', 'Original source changed during capture.');
    const sourceIdentityMap = (source.cast ?? source.foundation?.characters ?? []).map((character) => ({
      id: studioId(character.id),
      sourceCharacterId: character.id,
      canonId: character.entityId ?? character.id,
      name: character.name ?? character.canonicalName,
    }));
    return {
      package: makeSourcePackage({
        sourceKind: source.kind,
        sourceRevision: source.hash,
        textUnits,
        sceneScopes,
        sourceIdentityMap,
        assets: (source.assets ?? []).map((asset) => ({
          id: studioId(asset.assetId),
          sourceAssetId: asset.assetId,
          sourceAssetRevisionId: asset.assetRevisionId,
          entityId: asset.entityId,
          stateIds: asset.stateIds.map(studioId),
          sceneIds: asset.sceneIds.map(studioId),
          sourceStateIds: asset.stateIds,
          sourceSceneIds: asset.sceneIds,
          label: asset.label,
          mime: asset.mime,
          blobId: asset.hash.replace(/^sha256:/, ''),
        })),
        revealPolicy: {
          mode: source.kind === 'scene-script' ? 'sealed-scene-scope' : 'scene-state-required',
          stateNote: source.stateNote,
        },
        blobManifest,
        states,
        preservationStatus: {
          actualSourceBytes: source.kind === 'scene-script' ? 'complete-for-selected-scope' : 'complete',
          legacySnapshotComplete: false,
          legacySourceVersion: source.kind === 'scene-script' ? 2 : 1,
        },
      }),
      blobs,
    };
  } catch (error) {
    if (error?.code === 'SOURCE_CAPTURE_CHANGED') throw error;
    fail('SOURCE_CAPTURE_CHANGED', 'Source could not be captured and verified.');
  }
}
