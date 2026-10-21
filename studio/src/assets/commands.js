import { assertText, canonicalDigest, fail } from '../engine/contracts.js';

import {
  assetSchema,
  candidateValue,
  insertCandidate,
  insertQuarantine,
  slotPins,
  candidateMatchesSlot,
  sameSlot,
  checkPins,
  ensureCandidateNew,
  slotResult,
  slotDeclaration,
} from '../engine/asset-slots.js';

import { decodeMedia } from './decode.js';
import { composeProtectedEdit, deriveCrop } from './image-edit.js';

function bytesFromJSON(bytes) {
  if (!Array.isArray(bytes) || !bytes.length || !bytes.every(v => Number.isInteger(v) && v >= 0 && v <= 255))
    fail('INVALID_INPUT', 'Expected a nonempty byte array.');

  return Uint8Array.from(bytes);
}

// Both legacy import and bundle import share decoder/materialization and candidate shape.
export async function prepareAssetMaterialization(
  service,
  { projectId, id, slot, pinned, bytes, actor, decoded, materialized }
) {
  decoded ??= await decodeMedia(bytes, slot.mediaKind);
  const raw = materialized?.raw ?? (await service.blobs.put(projectId, bytes));
  const canonical =
    materialized?.canonical ??
    (await service.blobs.put(projectId, decoded.bytes));
  return {
    id,
    attemptId: null,
    jobId: null,
    ...pinned,
    slotId: slot.id,
    slotIntent: slot,
    blobId: canonical.blobId,
    canonicalBlobId: canonical.blobId,
    rawBlobId: raw.blobId,
    byteLength: canonical.byteLength,
    mediaKind: slot.mediaKind,

    ...(slot.mediaKind === 'audio'
      ? {
          speechVerification: pinned.audioBinding ? 'unverified_import' : 'not_applicable',
          transcriptionVerification: 'not_performed',
          ...(pinned.audioBinding ? { audioBinding: pinned.audioBinding } : {}),
        }
      : {}),

    mime: decoded.mime,
    metadata: decoded.metadata,

    validation: { status: 'passed', decoder: 'studio-media-v1' },

    lineage: { kind: 'import', actor, parentCandidateIds: [] },
  };
}
async function prepareImport(service, context) {
  const { store, envelope, aggregate } = context,
        p = envelope.payload,
        projectId = envelope.projectId;

  ensureCandidateNew(store, projectId, p.id);
  assertText(p.actor);

  if (!['image', 'audio'].includes(p.mediaKind))
    fail('UNSUPPORTED_MEDIA', 'Expected image or audio import.');

  const slot = slotDeclaration(p.slot, p.mediaKind);

  if (aggregate.value && !sameSlot(aggregate.value, slot))
    fail('SLOT_CONFLICT', 'An existing slot cannot change its scope, subject or appearance state.');

  const pinned = slotPins(store, projectId, slot), bytes = bytesFromJSON(p.bytes), raw = await service.blobs.put(projectId, bytes);

  try {
    const decoded = await decodeMedia(bytes, p.mediaKind), canonical = await service.blobs.put(projectId, decoded.bytes);

    return {
      slot,
      pinned,

      candidate: await prepareAssetMaterialization(service, {
        projectId,
        id: p.id,
        slot,
        pinned,
        bytes,
        actor: p.actor,
        decoded,
        materialized: { raw, canonical }
      })
    };
  } catch (error) {
    if (!['INVALID_IMAGE', 'UNSUPPORTED_IMAGE', 'INVALID_WAV', 'UNSUPPORTED_WAV'].includes(error.code))
      throw error;

    return {
      slot,
      pinned,

      quarantine: { id: p.id, rawBlobId: raw.blobId, mediaKind: p.mediaKind, status: 'quarantined', code: error.code }
    };
  }
}

export function registerAssetCommands(service) {
  const { store } = service;

  assetSchema(store);

  service.registerCommand('asset.import', {
    target: ({ envelope }) => ({ kind: 'assetSlot', id: envelope.payload.slot?.id }),

    prepare: context => prepareImport(service, context),

    validate({ envelope, aggregate, prepared }) {
      ensureCandidateNew(store, envelope.projectId, envelope.payload.id);
      const current = slotPins(store, envelope.projectId, prepared.slot);

      if (canonicalDigest(current) !== canonicalDigest(prepared.pinned))
        fail('INPUT_STALE', 'Asset import target changed during decode.');

      if (aggregate.value && !sameSlot(aggregate.value, prepared.slot))
        fail('SLOT_CONFLICT', 'Asset slot changed.');
    },

    apply({ envelope, aggregate, prepared }) {
      if (prepared.candidate)
        insertCandidate(store, envelope.projectId, prepared.candidate);
      else
        insertQuarantine(store, envelope.projectId, prepared.quarantine);

      return {
        ...slotResult(aggregate.value ?? prepared.slot),
        candidate: prepared.candidate ?? null,
        quarantine: prepared.quarantine ?? null
      };
    }
  });

  service.registerCommand('asset.derive', {
    target: ({ envelope }) => ({ kind: 'assetSlot', id: envelope.payload.slotId }),

    async prepare({ envelope, aggregate }) {
      const p = envelope.payload, projectId = envelope.projectId, slot = aggregate.value;
      ensureCandidateNew(store, projectId, p.id);
      assertText(p.actor);

      if (!slot || slot.mediaKind !== 'image')
        fail('INVALID_REFERENCE', 'Image derivative needs an existing image slot.');

      const pinned = slotPins(store, projectId, slot), base = candidateValue(store, projectId, p.baseCandidateId);
      checkPins(store, projectId, base);

      if (slot.candidateId !== base.id)
        fail('STALE_BASE', 'Derivative base must be the accepted slot revision.');

      const baseBytes = await service.blobs.read(projectId, base.canonicalBlobId ?? base.blobId);
      let bytes, validation, lineage;

      if (p.operation === 'protected_edit') {
        const raw = candidateValue(store, projectId, p.candidateId);
        checkPins(store, projectId, raw);

        if (raw.mediaKind !== 'image')
          fail('INVALID_REFERENCE', 'Protected edit candidate must be an image.');

        candidateMatchesSlot(store, projectId, raw, slot, pinned);
        const mask = await service.blobs.put(projectId, bytesFromJSON(p.maskBytes)), feather = p.featherBytes ? await service.blobs.put(projectId, bytesFromJSON(p.featherBytes)) : null;

        const result = await composeProtectedEdit({
          base: baseBytes,
          candidate: await service.blobs.read(projectId, raw.canonicalBlobId ?? raw.blobId),
          mask: await service.blobs.read(projectId, mask.blobId),
          feather: feather ? await service.blobs.read(projectId, feather.blobId) : undefined,
          geometry: p.geometry
        });

        bytes = result.bytes;
        validation = result.validation;

        lineage = {
          kind: 'protected_edit',
          parentCandidateIds: [base.id, raw.id],
          baseCandidateId: base.id,
          rawCandidateId: raw.id,
          rawBlobId: raw.rawBlobId,
          maskBlobId: mask.blobId,
          featherBlobId: feather?.blobId ?? null,
          geometry: p.geometry
        };
      } else if (p.operation === 'crop') {
        bytes = await deriveCrop({ base: baseBytes, rect: p.rect });

        validation = {
          status: 'passed',

          geometry: { kind: 'crop', rect: p.rect }
        };

        lineage = { kind: 'crop', parentCandidateIds: [base.id], baseCandidateId: base.id, rawBlobId: base.rawBlobId, rect: p.rect };
      } else
        fail('INVALID_INPUT', 'Expected an explicit protected_edit or crop derivative.');

      lineage.actor = p.actor;
      const decoded = await decodeMedia(bytes, 'image'), blob = await service.blobs.put(projectId, decoded.bytes);

      return {
        pinned,
        baseAdoptionId: slot.adoptionId,

        candidate: {
          id: p.id,
          attemptId: null,
          jobId: null,
          ...pinned,
          slotId: slot.id,

          slotIntent: {
            id: slot.id,
            scope: slot.scope,
            subject: slot.subject,
            appearanceStateRef: slot.appearanceStateRef,
            mediaKind: slot.mediaKind
          },

          blobId: blob.blobId,
          canonicalBlobId: blob.blobId,
          rawBlobId: lineage.rawBlobId,
          mediaKind: 'image',
          mime: 'image/png',
          metadata: decoded.metadata,
          validation,
          lineage,
          baseAdoptionId: slot.adoptionId
        }
      };
    },

    validate({ envelope, aggregate, prepared }) {
      ensureCandidateNew(store, envelope.projectId, envelope.payload.id);

      if (aggregate.value.candidateId !== envelope.payload.baseCandidateId || aggregate.value.adoptionId !== prepared.baseAdoptionId)
        fail('STALE_BASE', 'Accepted base changed during composition.');

      if (canonicalDigest(slotPins(store, envelope.projectId, aggregate.value)) !== canonicalDigest(prepared.pinned))
        fail('INPUT_STALE', 'Derivative inputs changed during composition.');

      for (const id of prepared.candidate.lineage.parentCandidateIds)
        checkPins(store, envelope.projectId, candidateValue(store, envelope.projectId, id));
    },

    apply({ envelope, aggregate, prepared }) {
      insertCandidate(store, envelope.projectId, prepared.candidate);

      return {
        ...slotResult(aggregate.value),
        candidate: prepared.candidate
      };
    }
  });
}
