import { readValues } from './story.js';
import { pinTarget, checkPinnedRequest, compatibleTimingPins } from './asset-slots.js';
export { pinTarget, checkPinnedRequest } from './asset-slots.js';
import { randomUUID } from 'node:crypto';
import {
  assertSynchronous,
  assertId,
  assertInteger,
  assertText,
  canonicalDigest,
  canonicalJSON,
  fail
} from './contracts.js';
import { budgetSnapshot, reservationSnapshot, reserve, release } from './budget.js';

// These tables contain execution state; worker progress never updates edit aggregate revisions.
export function executionSchema(store) {
  store.write(() =>
    store.db.exec(`
    CREATE TABLE IF NOT EXISTS generation_jobs(project_id TEXT NOT NULL REFERENCES projects(id),id TEXT NOT NULL,intent_key TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(project_id,id),UNIQUE(project_id,intent_key));
    CREATE TABLE IF NOT EXISTS generation_attempts(project_id TEXT NOT NULL,id TEXT NOT NULL,job_id TEXT NOT NULL,status TEXT NOT NULL,fence INTEGER NOT NULL DEFAULT 0,data_json TEXT NOT NULL,PRIMARY KEY(project_id,id),FOREIGN KEY(project_id,job_id) REFERENCES generation_jobs(project_id,id));
    CREATE TABLE IF NOT EXISTS generation_outbox(project_id TEXT NOT NULL,attempt_id TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(project_id,attempt_id),FOREIGN KEY(project_id,attempt_id) REFERENCES generation_attempts(project_id,id));
    CREATE TABLE IF NOT EXISTS budget_reservations(project_id TEXT NOT NULL,attempt_id TEXT NOT NULL,status TEXT NOT NULL,estimate_micros INTEGER NOT NULL,settled_micros INTEGER,amount_kind TEXT,evidence_json TEXT,PRIMARY KEY(project_id,attempt_id),FOREIGN KEY(project_id,attempt_id) REFERENCES generation_attempts(project_id,id));
    CREATE TABLE IF NOT EXISTS generation_workers(id TEXT PRIMARY KEY,pid INTEGER NOT NULL,incarnation TEXT NOT NULL,hostname TEXT NOT NULL,lease_until INTEGER NOT NULL,status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS generation_candidates(project_id TEXT NOT NULL,id TEXT NOT NULL,attempt_id TEXT,data_json TEXT NOT NULL,PRIMARY KEY(project_id,id),FOREIGN KEY(project_id,attempt_id) REFERENCES generation_attempts(project_id,id));
  `)
  );
  // Older Studio databases required provider provenance even for local imports.
  if (store.all('PRAGMA table_info(generation_candidates)').find(c => c.name === 'attempt_id')?.notnull) {
    store.write(() => store.db.exec(`
      ALTER TABLE generation_candidates RENAME TO generation_candidates_legacy;
      CREATE TABLE generation_candidates(project_id TEXT NOT NULL,id TEXT NOT NULL,attempt_id TEXT,data_json TEXT NOT NULL,PRIMARY KEY(project_id,id),FOREIGN KEY(project_id,attempt_id) REFERENCES generation_attempts(project_id,id));
      INSERT INTO generation_candidates SELECT * FROM generation_candidates_legacy;
      DROP TABLE generation_candidates_legacy;
    `));
  }
}
export const jobRows = (store, projectId) =>
  store
    .all('SELECT data_json FROM generation_jobs WHERE project_id=? ORDER BY rowid', projectId)
    .map((r) => JSON.parse(r.data_json));
export const attemptRows = (store, projectId) =>
  store
    .all('SELECT data_json FROM generation_attempts WHERE project_id=? ORDER BY rowid', projectId)
    .map((r) => JSON.parse(r.data_json));
export function getJob(store, projectId, id) {
  assertId(id);
  const row = store.get(
    'SELECT data_json FROM generation_jobs WHERE project_id=? AND id=?',
    projectId,
    id
  );
  if (!row) fail('INVALID_REFERENCE', 'Job does not belong to this project.');
  return JSON.parse(row.data_json);
}
export function getAttempt(store, projectId, id) {
  assertId(id);
  const row = store.get(
    'SELECT data_json FROM generation_attempts WHERE project_id=? AND id=?',
    projectId,
    id
  );
  if (!row) fail('INVALID_REFERENCE', 'Attempt does not belong to this project.');
  return JSON.parse(row.data_json);
}
export function saveJob(store, projectId, job) {
  store.run(
    'UPDATE generation_jobs SET data_json=? WHERE project_id=? AND id=?',
    canonicalJSON(job),
    projectId,
    job.id
  );
}
export function saveAttempt(store, projectId, a) {
  store.run(
    'UPDATE generation_attempts SET status=?,fence=?,data_json=? WHERE project_id=? AND id=?',
    a.status,
    a.fence,
    canonicalJSON(a),
    projectId,
    a.id
  );
}
export function progress(store, projectId, attempt, type) {
  store.run(
    'INSERT INTO events(project_id,command_id,aggregate_kind,aggregate_id,aggregate_revision,type,value_json) VALUES(?,?,?,?,?,?,?)',
    projectId,
    attempt.id,
    'attempt',
    attempt.id,
    store.aggregate(projectId, { kind: 'attempt', id: attempt.id }).revision,
    type,
    canonicalJSON({
      attemptId: attempt.id,
      jobId: attempt.jobId,
      status: attempt.status
    })
  );
}
function validatePayload(p) {
  assertId(p.subscriberId);
  assertId(p.provider);
  assertInteger(p.estimateMicros);
  if (
    !['image', 'audio', 'text'].includes(p.kind) ||
    !['reuse_or_generate', 'fresh_variation'].includes(p.intent)
  )
    fail('INVALID_INPUT', 'Unknown generation kind or intent.');
  const contextKeys = ['accountId', 'policyRevision', 'authorizationRevision', 'sourceVisibility'];
  for (const key of contextKeys) assertId(p.context?.[key]);
  if (Object.keys(p.context).some((k) => !contextKeys.includes(k)))
    fail('INVALID_INPUT', 'Provider context contains unsupported fields.');
  assertText(p.input?.model);
  assertText(p.input?.prompt);
  if (
    p.input.config !== undefined &&
    (!p.input.config || typeof p.input.config !== 'object' || Array.isArray(p.input.config))
  )
    fail('INVALID_INPUT', 'Expected model configuration object.');
  if (Object.keys(p.input).some((key) => !['model', 'prompt', 'config', 'blobIds'].includes(key)))
    fail('INVALID_INPUT', 'Unsupported provider input field.');
  if (p.input.blobIds !== undefined && !Array.isArray(p.input.blobIds))
    fail('INVALID_INPUT', 'Expected registered reference blob identifiers.');
  if (!p.recipe || typeof p.recipe !== 'object' || Array.isArray(p.recipe))
    fail('INVALID_INPUT', 'Expected a generation recipe.');
}
function validateAudioInput(payload, pinned) {
  if (payload.kind !== 'audio')
    return;

  const binding = pinned.utteranceBinding ?? pinned.audioBinding;

  if (!binding)
    return;

  if (binding.casting.status !== 'resolved')
    fail('CASTING_UNRESOLVED', 'Audio generation requires a resolved voice selection.');

  if (canonicalDigest(payload.input.prompt) !== binding.textDigest)
    fail('SPEECH_TEXT_MISMATCH', 'Spoken prompt must match the effective utterance text exactly.');
}
// Trusted adapters may synchronously validate domain intent before any budget reservation.
// HTTP/MCP payloads cannot install this callback or choose a different current binding.
export function validateProviderInput(service, projectId, p, pinned) {
  const provider = service.providers[p.provider];
  if (!provider?.validateRequest) return;
  const id = pinned.utteranceId ?? (p.target.kind === 'utterance' ? p.target.id : null);
  const scene = id ? readValues(service.store, projectId, 'scene')
    .find(s => s.utterances.some(u => u.id === id)) : null;
  const utterance = scene ? {
    ...scene.utterances.find(u => u.id === id),
    ...service.store.aggregate(projectId, { kind: 'utterance', id }).value,
  } : null;
  return assertSynchronous(provider.validateRequest(p, {
    binding: pinned.utteranceBinding ?? pinned.audioBinding ?? null,
    utterance,
  }));
}
function newAttempt(store, projectId, job, estimateMicros, decision) {
  const a = {
    id: randomUUID(),
    executionIntentId: randomUUID(),
    commandId: decision.commandId,
    retryOfAttemptId: decision.retryOfAttemptId ?? null,
    acceptedDuplicateChargeRisk: decision.acceptedDuplicateChargeRisk ?? false,
    jobId: job.id,
    status: 'prepared',
    fence: 0,
    request: job.request,
    requestDigest: canonicalDigest(job.request),
    generationInputDigest: job.generationInputDigest,
    workerId: null,
    operationId: null,
    providerRequestId: null,
    outputs: [],
    createdAt: Date.now()
  };
  store.run(
    'INSERT INTO generation_attempts(project_id,id,job_id,status,fence,data_json) VALUES(?,?,?,?,?,?)',
    projectId,
    a.id,
    job.id,
    a.status,
    0,
    canonicalJSON(a)
  );
  reserve(store, projectId, a.id, estimateMicros);
  store.run(
    'INSERT INTO generation_outbox(project_id,attempt_id,status) VALUES(?,?,?)',
    projectId,
    a.id,
    'queued'
  );
  job.attemptIds.push(a.id);
  job.currentAttemptId = a.id;
  job.status = 'queued';
  saveJob(store, projectId, job);
  return a;
}
// Cancellation detaches subscribers; the durable attempt and immutable candidates
// determine what a later explicit subscriber can actually use.
function currentJobStatus(store, projectId, job) {
  const attempt = getAttempt(store, projectId, job.currentAttemptId);
  switch (attempt.status) {
    case 'prepared':
      return 'queued';
    case 'dispatching':
      return 'running';
    case 'succeeded':
      return store.get(
        'SELECT id FROM generation_candidates WHERE project_id=? AND attempt_id=?',
        projectId,
        attempt.id
      )
        ? 'candidate_ready'
        : attempt.validationStatus === 'quarantined' ? 'quarantined' : 'pending_validation';
    case 'failed_definite':
      return attempt.outcomeReason === 'source_binding_stale'
        ? 'blocked_source_review'
        : 'failed_definite';
    default:
      return attempt.status;
  }
}

export function decorateExecutionSnapshot(store, snapshot) {
  const id = snapshot.project.id;
  snapshot.jobs = jobRows(store, id);
  snapshot.reservations = reservationSnapshot(store, id);
  snapshot.attempts = attemptRows(store, id).map((a) => ({
    ...a,
    reservationStatus: snapshot.reservations.find((r) => r.attemptId === a.id)?.status
  }));
  snapshot.candidates = store
    .all('SELECT data_json FROM generation_candidates WHERE project_id=? ORDER BY rowid', id)
    .map((r) => JSON.parse(r.data_json));
  snapshot.budget = budgetSnapshot(store, id);
  return snapshot;
}
export function registerJobCommands(service) {
  const { store } = service;
  executionSchema(store);
  service.registerCommand('generation.request', {
    target: ({ envelope }) => ({
      kind: 'generation',
      id: envelope.payload.subscriberId
    }),
    async prepare({ envelope }) {
      const p = envelope.payload;
      validatePayload(p);
      for (const id of p.input.blobIds ?? []) await service.blobs.read(envelope.projectId, id);
      return {
        generationInputDigest: canonicalDigest({
          kind: p.kind,
          input: p.input
        })
      };
    },
    validate({ envelope }) {
      validatePayload(envelope.payload);
      const pinned=pinTarget(store, envelope.projectId, envelope.payload.target);
      validateAudioInput(envelope.payload,pinned);
      validateProviderInput(service, envelope.projectId, envelope.payload, pinned);
    },
    apply({ envelope, prepared }) {
      const p = envelope.payload,
        projectId = envelope.projectId,
        pinned = pinTarget(store, projectId, p.target);
      const variationNonce = p.intent === 'fresh_variation' ? randomUUID() : null;
      const semantic = { ...pinned };
      delete semantic.target;
      const intentKey = canonicalDigest({
        projectId,
        provider: p.provider,
        context: p.context,
        generationInputDigest: prepared.generationInputDigest,
        semantic,
        recipe: p.recipe,
        variationNonce
      });
      const row = store.get(
        'SELECT data_json FROM generation_jobs WHERE project_id=? AND intent_key=?',
        projectId,
        intentKey
      );
      const subscriber = {
        id: p.subscriberId,
        commandId: envelope.commandId,
        ...pinned,
        recipe: p.recipe,
        status: 'attached'
      };
      if (row) {
        const job = JSON.parse(row.data_json);
        if (job.subscribers.some((s) => s.id === p.subscriberId))
          fail('INVALID_STATE', 'Subscriber already exists.');
        job.subscribers.push(subscriber);
        if (
          getAttempt(store, projectId, job.currentAttemptId).status === 'cancelled_before_dispatch'
        ) {
          // This explicit request authorizes new unsent work. The prior attempt,
          // its original request, released reservation and detached subscribers stay intact.
          job.request = { ...job.request, ...pinned, recipe: p.recipe };
          newAttempt(store, projectId, job, p.estimateMicros, { commandId: envelope.commandId });
        } else {
          job.status = currentJobStatus(store, projectId, job);
          saveJob(store, projectId, job);
        }
        return job;
      }
      const request = {
        ...pinned,
        ...(service.providers[p.provider]?.validateRequest ? {
          inputVerification: validateProviderInput(service, projectId, p, pinned) ?? null,
        } : {}),
        provider: p.provider,
        kind: p.kind,
        context: p.context,
        input: p.input,
        recipe: p.recipe
      };
      const job = {
        id: randomUUID(),
        intentKey,
        variationNonce,
        generationInputDigest: prepared.generationInputDigest,
        request,
        subscribers: [subscriber],
        attemptIds: [],
        status: 'queued'
      };
      store.run(
        'INSERT INTO generation_jobs(project_id,id,intent_key,data_json) VALUES(?,?,?,?)',
        projectId,
        job.id,
        intentKey,
        canonicalJSON(job)
      );
      newAttempt(store, projectId, job, p.estimateMicros, {
        commandId: envelope.commandId
      });
      return job;
    }
  });
  service.registerCommand('job.reuse', {
    target: ({ envelope }) => ({ kind: 'generation', id: envelope.payload.subscriberId }),

    apply({ envelope }) {
      const p = envelope.payload, projectId = envelope.projectId;
      validatePayload(p);
      const job = getJob(store, projectId, p.jobId);

      if (currentJobStatus(store, projectId, job) !== 'candidate_ready')
        fail('CANDIDATE_UNAVAILABLE', 'Reuse requires validated candidates.');

      const pinned = pinTarget(store, projectId, p.target),
            old = {
              ...job.request
            },
            semantic = { ...pinned };

      delete semantic.target;
      const previous = Object.fromEntries(Object.keys(semantic).map(k => [k, old[k]]));

      if (p.allowTimingChanges !== undefined && (typeof p.allowTimingChanges !== 'boolean' || p.kind !== 'audio'))
        fail('INVALID_INPUT', 'Timing compatibility is explicitly available for audio only.');

      if (p.allowTimingChanges === true && !compatibleTimingPins(old, pinned))
        fail('INCOMPATIBLE_REUSE', 'Audio timing reuse requires current engine compatibility proof.');

      validateAudioInput(p, pinned);
      validateProviderInput(service, projectId, p, pinned);

      if (p.intent !== 'reuse_or_generate' || p.provider !== old.provider || canonicalDigest(p.context) !== canonicalDigest(old.context) || canonicalDigest({ kind: p.kind, input: p.input }) !== job.generationInputDigest || canonicalDigest(p.recipe) !== canonicalDigest(old.recipe) || (canonicalDigest(semantic) !== canonicalDigest(previous) && !(p.allowTimingChanges === true && p.kind === 'audio' && job.request.kind === 'audio' && compatibleTimingPins(old, pinned))))
        fail('INCOMPATIBLE_REUSE', 'Candidate context or source dependencies do not match.');

      if (job.subscribers.some(x => x.id === p.subscriberId))
        fail('INVALID_STATE', 'Subscriber already exists.');

      job.subscribers.push({
        id: p.subscriberId,
        commandId: envelope.commandId,
        ...pinned,
        recipe: p.recipe,
        status: 'attached',

        ...(p.allowTimingChanges === true ? {
          compatibility: { kind: 'timing_only', candidateAttemptId: job.currentAttemptId }
        } : {})
      });

      job.status = 'candidate_ready';
      saveJob(store, projectId, job);
      return job;
    }
  });
  service.registerCommand('attempt.retry', {
    target: ({ envelope }) => ({
      kind: 'job',
      id: getAttempt(store, envelope.projectId, envelope.payload.attemptId).jobId
    }),
    apply({ envelope }) {
      const p = envelope.payload,
        a = getAttempt(store, envelope.projectId, p.attemptId),
        job = getJob(store, envelope.projectId, a.jobId);
      if (
        !['outcome_unknown', 'failed_definite'].includes(a.status) ||
        job.currentAttemptId !== a.id ||
        !job.subscribers.some((s) => s.status === 'attached')
      )
        fail('INVALID_STATE', 'Only the latest unsuccessful attempt can be retried.');
      if (a.status === 'outcome_unknown' && p.acceptDuplicateChargeRisk !== true)
        fail(
          'DUPLICATE_CHARGE_RISK',
          'Explicit acceptance of possible duplicate charges is required.'
        );
      checkPinnedRequest(store, envelope.projectId, a.request);
      validateProviderInput(service, envelope.projectId, a.request,
        pinTarget(store, envelope.projectId, a.request.target));
      newAttempt(store, envelope.projectId, job, p.estimateMicros, {
        commandId: envelope.commandId,
        retryOfAttemptId: a.id,
        acceptedDuplicateChargeRisk: p.acceptDuplicateChargeRisk === true
      });
      return job;
    }
  });
  service.registerCommand('job.cancel', {
    target: ({ envelope }) => ({ kind: 'job', id: envelope.payload.jobId }),
    apply({ envelope }) {
      const job = getJob(store, envelope.projectId, envelope.payload.jobId);
      const subscriberId = envelope.payload.subscriberId;
      if (subscriberId && !job.subscribers.some((s) => s.id === subscriberId))
        fail('INVALID_REFERENCE', 'Subscriber does not belong to this job.');
      for (const sub of job.subscribers)
        if (!subscriberId || sub.id === subscriberId) sub.status = 'detached';
      if (job.subscribers.some((s) => s.status === 'attached')) {
        saveJob(store, envelope.projectId, job);
        return job;
      }
      const attempt = getAttempt(store, envelope.projectId, job.currentAttemptId);
      if (attempt.status === 'prepared') {
        attempt.status = 'cancelled_before_dispatch';
        saveAttempt(store, envelope.projectId, attempt);
        release(store, envelope.projectId, attempt.id, 'cancelled_before_dispatch');
        store.run(
          "UPDATE generation_outbox SET status='done' WHERE project_id=? AND attempt_id=?",
          envelope.projectId,
          attempt.id
        );
        job.status = 'cancelled_before_dispatch';
      } else {
        job.status = 'detached_in_flight';
      }
      saveJob(store, envelope.projectId, job);
      return job;
    }
  });
}

export function executionImpacts(store, projectId, productionId) {
  const jobs = jobRows(store, projectId).filter((j) => j.request.productionId === productionId);
  const jobIds = jobs.map((j) => j.id),
    attempts = attemptRows(store, projectId).filter((a) => jobIds.includes(a.jobId));
  const candidates = store
    .all('SELECT data_json FROM generation_candidates WHERE project_id=?', projectId)
    .map((r) => JSON.parse(r.data_json))
    .filter((c) => c.productionId === productionId);
  return {
    jobIds,
    attemptIds: attempts.map((a) => a.id),
    candidateIds: candidates.map((c) => c.id),
    outputs: attempts
      .filter((a) => a.outputs.length)
      .map((a) => ({
        attemptId: a.id,
        blobIds: a.outputs.map((o) => o.blobId)
      })),
    semanticValidity: 'needs_review'
  };
}
