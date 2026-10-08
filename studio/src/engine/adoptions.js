import { randomUUID } from 'node:crypto';
import { requireValue } from './story.js';
import { assertId, assertText, canonicalDigest, canonicalJSON, fail } from './contracts.js';

import {
  candidateValue,
  slotPins,
  candidateMatchesSlot,
  sameSlot,
  checkPins,
  slotResult,
  slotDeclaration,
  compatibleTimingPins,
} from './asset-slots.js';

import { getJob, getAttempt, checkPinnedRequest, pinTarget } from './jobs.js';
import { decodeMedia } from '../assets/decode.js';
import { verifyProtectedEdit } from '../assets/image-edit.js';

function appendAdoption(store, projectId, slot, p, action, candidateId, undoOf = null, ancestry = {}) {
  const decision = {
    id: randomUUID(),
    slotId: slot.id,
    action,
    candidateId,
    previousCandidateId: slot.candidateId,
    previousAdoptionId: slot.adoptionId,
    undoOf,
    actor: p.actor,
    reason: p.reason,
    reviewRevision: p.reviewRevision ?? 0,

    ...(slot.mediaKind === 'audio' && slot.utteranceId ? { utteranceId: slot.utteranceId, castingStateRef: slot.castingStateRef ?? null, takeId: candidateId } : {}),

    ...ancestry
  };

  store.run(
    'INSERT INTO asset_adoptions(project_id,id,data_json) VALUES(?,?,?)',
    projectId,
    decision.id,
    canonicalJSON(decision)
  );

  return slotResult(slot, { candidateId, adoptionId: decision.id });
}

function takeProvenance(prepared) {
  const binding = prepared?.pinned.audioBinding;

  return binding ? {
    speakerOccurrenceId: binding.speakerOccurrenceId,
    roleBindingId: binding.roleBindingId,
    characterId: binding.characterId,
    desiredVoiceBinding: binding.casting,
    actualAudioInput: prepared.candidate.actualAudioInput ?? null,
    configVerification: prepared.candidate.configVerification ?? 'not_performed',
    voiceVerification: 'not_performed',
    actingVerification: 'not_performed',
    speechVerification: prepared.candidate.speechVerification ?? 'unverified_import',
    transcriptionVerification: 'not_performed',
    textDigest: binding.textDigest,
    desiredPerformanceDigest: binding.performanceDigest
  } : {};
}

function subscriberAuthorization(store, projectId, candidate, subscriberId) {
  if (subscriberId == null)
    return null;

  assertId(subscriberId);

  if (!candidate.jobId || !candidate.attemptId)
    fail('SUBSCRIBER_UNAVAILABLE', 'Only a generated candidate can use subscriber authorization.');

  const job = getJob(store, projectId, candidate.jobId), attempt = getAttempt(store, projectId, candidate.attemptId);

  if (attempt.jobId !== job.id || !job.attemptIds.includes(attempt.id) || candidate.requestDigest !== attempt.requestDigest || candidate.generationInputDigest !== job.generationInputDigest || attempt.status !== 'succeeded')
    fail('SUBSCRIBER_UNAVAILABLE', 'Candidate does not belong to the subscriber job attempt.');

  const subscriber = job.subscribers.find(s => s.id === subscriberId);

  if (!subscriber || subscriber.status !== 'attached')
    fail('SUBSCRIBER_UNAVAILABLE', 'Subscriber is absent or detached.');

  if (canonicalDigest(subscriber.recipe) !== canonicalDigest(candidate.recipe))
    fail('SLOT_CONFLICT', 'Subscriber recipe differs from candidate intent.');

  checkPinnedRequest(store, projectId, subscriber);

  if (subscriber.compatibility) {
    if (candidate.mediaKind !== 'audio' || subscriber.compatibility.kind !== 'timing_only' || subscriber.compatibility.candidateAttemptId !== candidate.attemptId || !compatibleTimingPins(attempt.request, pinTarget(store, projectId, subscriber.target)))
      fail('INPUT_STALE', 'Subscriber has no valid engine timing compatibility proof.');
  }

  return { ...subscriber, jobId: job.id, attemptId: attempt.id };
}

function authorizationContext(candidate, authorization) {
  if (!authorization)
    return candidate;

  return {
    ...candidate,
    ...authorization,

    slotIntent: authorization.slotSubject ? {
      subject: authorization.slotSubject,
      appearanceStateRef: authorization.appearanceStateRef,

      ...(candidate.mediaKind === 'audio' ? { castingStateRef: authorization.castingStateRef ?? null, utteranceId: authorization.utteranceId ?? null } : {})
    } : candidate.slotIntent
  };
}

async function prepareCandidateUse(service, projectId, candidate, slot, subscriberId = null) {
  const { store } = service;

  const pinned = slotPins(store, projectId, slot),
        reviewRevision = store.aggregate(projectId, { kind: 'assetReview', id: candidate.id }).revision;

  if (candidate.recipe?.operation === 'protected_edit' && candidate.lineage?.kind !== 'protected_edit')
    fail('PROTECTED_COMPOSITE_REQUIRED', 'Protected edit raw output requires a verified derived composite.');

  const authorization = subscriberAuthorization(store, projectId, candidate, subscriberId);
  const bytes = await service.blobs.read(projectId, candidate.canonicalBlobId ?? candidate.blobId);
  const decoded = await decodeMedia(bytes, candidate.mediaKind);
  let protectedProof = null;

  if (candidate.lineage?.kind === 'protected_edit') {
    const lineage = candidate.lineage, base = candidateValue(store, projectId, lineage.baseCandidateId);

    protectedProof = await verifyProtectedEdit({
      base: await service.blobs.read(projectId, base.canonicalBlobId ?? base.blobId),
      final: bytes,
      mask: await service.blobs.read(projectId, lineage.maskBlobId),
      feather: lineage.featherBlobId ? await service.blobs.read(projectId, lineage.featherBlobId) : undefined,
      geometry: lineage.geometry
    });
  }

  return { slot, candidate, pinned, metadata: decoded.metadata, reviewRevision, protectedProof, authorization };
}

function validateCandidateUse(store, projectId, slot, p, prepared, restore = false) {
  const c = prepared.candidate;
  assertText(p.actor);
  assertText(p.reason);
  const authorization = subscriberAuthorization(store, projectId, c, p.subscriberId);

  if (!authorization?.compatibility)
    checkPins(store, projectId, c);

  if (c.validation?.status !== 'passed' || canonicalDigest(c.metadata) !== canonicalDigest(prepared.metadata))
    fail('INVALID_VALIDATION', 'Candidate lacks current decoded validation.');

  const current = slotPins(store, projectId, slot);

  if (canonicalDigest(current) !== canonicalDigest(prepared.pinned))
    fail('INPUT_STALE', 'Adoption target changed during decode.');

  if (c.mediaKind !== slot.mediaKind)
    fail('SLOT_CONFLICT', 'Candidate media does not match slot.');

  if (canonicalDigest(authorization) !== canonicalDigest(prepared.authorization))
    fail('INPUT_STALE', 'Subscriber authorization changed during decode.');

  candidateMatchesSlot(store, projectId, authorizationContext(c, authorization), slot, current, restore);

  if (c.lineage?.kind === 'protected_edit' && prepared.protectedProof?.protectedPixels !== 'passed')
    fail('INVALID_VALIDATION', 'Protected final proof is missing.');

  if (!restore && c.lineage?.baseCandidateId && (slot.candidateId !== c.lineage.baseCandidateId || slot.adoptionId !== c.baseAdoptionId))
    fail('STALE_BASE', 'Accepted derivative base has changed.');

  const review = store.aggregate(projectId, { kind: 'assetReview', id: c.id });

  if (review.revision !== prepared.reviewRevision || review.revision !== (p.reviewRevision ?? 0) || review.value?.decision === 'reject')
    fail('STALE_REVIEW', 'Candidate review must match the current accepted review revision.');
}

function adoptionDecision(store, projectId, id) {
  const row = store.get('SELECT data_json FROM asset_adoptions WHERE project_id=? AND id=?', projectId, id);

  if (!row)
    fail('INVALID_REFERENCE', 'Adoption decision is absent.');

  return JSON.parse(row.data_json);
}

// Consumption uses the immutable acceptance receipt, not fresh generation pins:
// timing/shot edits and later subscriber detachment do not revoke accepted media.
// The current destination's semantic checks still run on every resolution.
export function resolveAcceptedSelection(store, projectId, selectedSlot) {
  const slot = requireValue(store, projectId, 'assetSlot', selectedSlot.id);
  if (!sameSlot(slot, selectedSlot) ||
      slot.candidateId !== selectedSlot.candidateId ||
      slot.adoptionId !== selectedSlot.adoptionId)
    fail('INPUT_STALE', 'Accepted selection changed.');

  const decision = adoptionDecision(store, projectId, slot.adoptionId);
  if (decision.slotId !== slot.id || decision.candidateId !== slot.candidateId ||
      !['adopt', 'undo'].includes(decision.action))
    fail('INVALID_REFERENCE', 'Acceptance receipt does not match the selected slot.');

  const candidate = candidateValue(store, projectId, slot.candidateId);
  const authorization = decision.authorization;
  if (decision.subscriberId != null) {
    if (!authorization || authorization.id !== decision.subscriberId ||
        authorization.jobId !== candidate.jobId ||
        authorization.attemptId !== candidate.attemptId || authorization.status !== 'attached')
      fail('SUBSCRIBER_UNAVAILABLE', 'Acceptance receipt lacks its recorded destination authorization.');
    const job = getJob(store, projectId, candidate.jobId), attempt = getAttempt(store, projectId, candidate.attemptId);
    const subscriber = job.subscribers.find(s => s.id === decision.subscriberId);
    // Status is mutable after acceptance; all pinned authorization fields are retained.
    if (!subscriber ||
        canonicalDigest({ ...subscriber, status: 'attached', jobId: job.id, attemptId: attempt.id }) !== canonicalDigest(authorization) ||
        attempt.jobId !== job.id || !job.attemptIds.includes(attempt.id) ||
        attempt.status !== 'succeeded' || candidate.requestDigest !== attempt.requestDigest ||
        candidate.generationInputDigest !== job.generationInputDigest ||
        canonicalDigest(authorization.recipe) !== canonicalDigest(candidate.recipe))
      fail('SUBSCRIBER_UNAVAILABLE', 'Acceptance authorization does not belong to the original candidate attempt.');
  } else if (authorization != null) {
    fail('SUBSCRIBER_UNAVAILABLE', 'Acceptance authorization requires its subscriber identity.');
  }

  const current = slotPins(store, projectId, slot);
  const destination = authorizationContext(candidate, authorization);
  if (destination.productionId &&
      (destination.productionId !== current.productionId ||
        destination.sourcePackageId !== current.sourcePackageId ||
        destination.sourceBindingRevision !== current.sourceBindingRevision))
    fail('SOURCE_BINDING_STALE', 'Accepted destination belongs to an older source binding.');
  if (candidate.mediaKind !== slot.mediaKind || candidate.validation?.status !== 'passed')
    fail('INVALID_VALIDATION', 'Selected candidate lacks matching decoded validation.');
  if (candidate.recipe?.operation === 'protected_edit' && candidate.lineage?.kind !== 'protected_edit')
    fail('PROTECTED_COMPOSITE_REQUIRED', 'Protected edit selection requires its verified composite.');
  if (candidate.lineage?.kind === 'protected_edit' && candidate.validation.protectedPixels !== 'passed')
    fail('INVALID_VALIDATION', 'Selected protected composite lacks its retained pixel proof.');
  candidateMatchesSlot(store, projectId, destination, slot, current, true);
  // Never return the destination overlay as candidate provenance.
  return candidate;
}

function undoAncestry(store, projectId, id) {
  let decision = adoptionDecision(store, projectId, id);

  while (decision.action === 'undo') {
    if (!decision.restoredDecisionId)
      fail('INVALID_STATE', 'There is no earlier adoption to undo.');

    decision = adoptionDecision(store, projectId, decision.restoredDecisionId);
  }

  return decision;
}

export function registerAdoptionCommands(service) {
  const { store } = service;

  service.registerCommand('candidate.review', {
    target: ({ envelope }) => ({ kind: 'assetReview', id: envelope.payload.candidateId }),

    validate({ envelope }) {
      candidateValue(store, envelope.projectId, envelope.payload.candidateId);
      assertText(envelope.payload.actor);
      assertText(envelope.payload.reason);

      if (!['approve', 'reject'].includes(envelope.payload.decision))
        fail('INVALID_INPUT', 'Expected review decision.');
    },

    apply: ({ envelope }) => envelope.payload
  });

  service.registerCommand('candidate.adopt', {
    target: ({ envelope }) => ({ kind: 'assetSlot', id: envelope.payload.slotId }),

    async prepare({ envelope, aggregate }) {
      const p = envelope.payload, candidate = candidateValue(store, envelope.projectId, p.candidateId);
      const declared = p.slot ? slotDeclaration(p.slot, candidate.mediaKind) : null;
      const slot = aggregate.value ?? declared;

      if (!slot || slot.id !== p.slotId)
        fail('INVALID_REFERENCE', 'Expected an existing slot or explicit matching slot declaration.');

      if (declared && aggregate.value && !sameSlot(aggregate.value, declared))
        fail('SLOT_CONFLICT', 'Existing slot declaration cannot change.');

      return prepareCandidateUse(service, envelope.projectId, candidate, slot, p.subscriberId);
    },

    validate({ envelope, aggregate, prepared }) {
      validateCandidateUse(store, envelope.projectId, aggregate.value ?? prepared.slot, envelope.payload, prepared);
    },

    apply({ envelope, aggregate, prepared }) {
      return appendAdoption(
        store,
        envelope.projectId,
        aggregate.value ?? prepared.slot,
        envelope.payload,
        'adopt',
        envelope.payload.candidateId,
        null,
        {
          subscriberId: envelope.payload.subscriberId ?? null,
          authorization: prepared.authorization,
          ...takeProvenance(prepared)
        }
      );
    }
  });

  service.registerCommand('adoption.undo', {
    target: ({ envelope }) => ({ kind: 'assetSlot', id: envelope.payload.slotId }),

    async prepare({ envelope, aggregate }) {
      const p = envelope.payload, slot = aggregate.value;

      if (!slot || slot.adoptionId !== p.adoptionId)
        fail('STALE_ADOPTION', 'Only the current slot decision can be undone.');

      const logical = undoAncestry(store, envelope.projectId, p.adoptionId);
      const previous = logical.previousAdoptionId ? adoptionDecision(store, envelope.projectId, logical.previousAdoptionId) : null;
      const subscriberId = p.subscriberId ?? previous?.subscriberId ?? null;

      const restoration = logical.previousCandidateId ? await prepareCandidateUse(
        service,
        envelope.projectId,
        candidateValue(store, envelope.projectId, logical.previousCandidateId),
        slot,
        subscriberId
      ) : null;

      return { logical, restoration, subscriberId };
    },

    validate({ envelope, aggregate, prepared }) {
      const p = envelope.payload;
      assertText(p.actor);
      assertText(p.reason);

      if (!aggregate.value || aggregate.value.adoptionId !== p.adoptionId)
        fail('STALE_ADOPTION', 'Only the current slot decision can be undone.');

      if (prepared.restoration) validateCandidateUse(store, envelope.projectId, aggregate.value, { ...p, subscriberId: prepared.subscriberId }, prepared.restoration, true);
    },

    apply({ envelope, aggregate, prepared }) {
      const p = envelope.payload, logical = prepared.logical;

      return appendAdoption(store, envelope.projectId, aggregate.value, p, 'undo', logical.previousCandidateId, p.adoptionId, {
        undoneDecisionId: logical.id,
        restoredDecisionId: logical.previousAdoptionId,
        subscriberId: prepared.subscriberId,
        authorization: prepared.restoration?.authorization ?? null,
        ...takeProvenance(prepared.restoration)
      });
    }
  });
}

export function decorateAssetSnapshot(store, snapshot) {
  const projectId = snapshot.project.id;

  snapshot.slots = snapshot.aggregates.filter(a => a.kind === 'assetSlot').map(a => {
    const { candidate, quarantine, ...slot } = a.value;

    return { ...slot, revision: a.revision };
  });

  snapshot.adoptions = store.all('SELECT data_json FROM asset_adoptions WHERE project_id=? ORDER BY rowid', projectId).map(r => JSON.parse(r.data_json));

  snapshot.audit = snapshot.adoptions.map(a => ({ ...a, eventType: a.action === 'undo' ? 'adoption.undo' : 'candidate.adopt' }));

  snapshot.quarantines = store.all('SELECT data_json FROM asset_quarantines WHERE project_id=? ORDER BY rowid', projectId).map(r => JSON.parse(r.data_json));

  snapshot.assetReviews = snapshot.aggregates.filter(a => a.kind === 'assetReview').map(a => ({
    ...a.value,
    revision: a.revision
  }));

  snapshot.usageProposals = [];

  for (const slot of snapshot.slots.filter(s => s.candidateId)) {
    try {
      const c = candidateValue(store, projectId, slot.candidateId), current = slotPins(store, projectId, slot);
      checkPins(store, projectId, c);
      const decision = adoptionDecision(store, projectId, slot.adoptionId);
      const authorization = subscriberAuthorization(store, projectId, c, decision.subscriberId);
      candidateMatchesSlot(store, projectId, authorizationContext(c, authorization), slot, current, true);
    } catch (error) {
      if ([
        'INPUT_STALE',
        'SOURCE_BINDING_STALE',
        'INVALID_REFERENCE',
        'SLOT_CONFLICT',
        'SUBSCRIBER_UNAVAILABLE'
      ].includes(error.code))
        continue;

      throw error;
    }

    for (const scene of snapshot.scenes) {
      if (slot.scope.kind === 'production' && slot.scope.id !== scene.productionId || slot.scope.kind === 'scene' && slot.scope.id !== scene.id)
        continue;

      const shot = slot.scope.kind === 'shot' ? scene.shots.find(s => s.id === slot.scope.id) : null;

      if (slot.scope.kind === 'shot' && !shot)
        continue;

      for (const occurrence of scene.occurrences) {
        if (slot.subject.kind === 'environment' || (slot.subject.kind === 'identity' ? occurrence.characterId : occurrence.roleBindingId) !== slot.subject.id)
          continue;

        if (shot && (shot.occurrenceIds || shot.targetOccurrenceId) && !(shot.occurrenceIds ?? [shot.targetOccurrenceId]).includes(occurrence.id))
          continue;

        const presentation = scene.presentations.find(p => p.occurrenceId === occurrence.id);

        if (slot.mediaKind === 'audio') {
          if ((presentation.castingStateRef ?? null) !== (slot.castingStateRef ?? null))
            continue;

          if (slot.utteranceId && !scene.utterances.some(u => u.id === slot.utteranceId && u.speakerOccurrenceId === occurrence.id))
            continue;
        } else if ((presentation.appearanceStateRef ?? null) !== slot.appearanceStateRef)
          continue;

        snapshot.usageProposals.push({
          slotId: slot.id,
          candidateId: slot.candidateId,
          adoptionId: slot.adoptionId,
          sceneId: scene.id,
          shotId: shot?.id ?? null,
          occurrenceId: occurrence.id,
          appearanceStateRef: slot.appearanceStateRef,

          ...(slot.mediaKind === 'audio' ? { utteranceId: slot.utteranceId ?? null, castingStateRef: slot.castingStateRef ?? null } : {}),

          status: 'proposed'
        });
      }
    }
  }

  return snapshot;
}
