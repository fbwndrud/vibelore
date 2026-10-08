import { proposalValidator } from './proposals.js';
import { validateProviderInput } from './jobs.js';
import { mediaValidator } from '../assets/decode.js';
import { insertQuarantine, pinTarget } from './asset-slots.js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { StudioError, assertId, assertText, canonicalDigest, canonicalJSON, fail } from './contracts.js';
import { getJob, getAttempt, saveJob, saveAttempt, checkPinnedRequest, progress } from './jobs.js';
import { holdUnknown, release, reconcileBudget } from './budget.js';

const liveWorkers = new Set();
const host = hostname();
// A PID alone can be recycled. Start incarnation plus random worker identity is retained.
function incarnation(pid) {
  try {
    return (
      execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim() || null
    );
  } catch {
    return null;
  }
}
function workerAlive(worker) {
  if (!worker || worker.status !== 'active') return false;
  if (worker.hostname !== host) return true; // Local storage is not a distributed lease authority.
  if (worker.pid === process.pid) return liveWorkers.has(worker.id);
  try {
    process.kill(worker.pid, 0);
  } catch (error) {
    return error.code !== 'ESRCH';
  }
  const start = incarnation(worker.pid);
  return start === null || start === worker.incarnation;
}
export function recoverWorkers(service) {
  const { store } = service;
  // Process inspection is outside the transaction; final ownership is rechecked below.
  const dead = store
    .all("SELECT * FROM generation_workers WHERE status='active'")
    .filter((w) => !workerAlive(w));
  store.write(() => {
    for (const w of dead) {
      const current = store.get('SELECT * FROM generation_workers WHERE id=?', w.id);
      if (current.status !== 'active' || current.incarnation !== w.incarnation) continue;
      store.run("UPDATE generation_workers SET status='abandoned' WHERE id=?", w.id);
    }
    for (const row of store.all(
      "SELECT project_id,data_json FROM generation_attempts WHERE status='dispatching'"
    )) {
      const a = JSON.parse(row.data_json),
        w = store.get('SELECT * FROM generation_workers WHERE id=?', a.workerId);
      if (!w || w.status !== 'active')
        markUnknown(store, row.project_id, a, 'worker_abandoned', true);
    }
  });
}
function markUnknown(store, projectId, a, reason, revoke = false) {
  a.status = 'outcome_unknown';
  a.outcomeReason = reason;
  if (revoke) a.fence++;
  saveAttempt(store, projectId, a);
  holdUnknown(store, projectId, a.id);
  store.run(
    "UPDATE generation_outbox SET status='done' WHERE project_id=? AND attempt_id=?",
    projectId,
    a.id
  );
  const job = getJob(store, projectId, a.jobId);
  if (
    job.currentAttemptId === a.id &&
    job.subscribers.some((subscriber) => subscriber.status === 'attached')
  ) {
    job.status = 'outcome_unknown';
    saveJob(store, projectId, job);
  }
  progress(store, projectId, a, 'attempt.outcome_unknown');
}
function fenced(store, projectId, original) {
  const a = getAttempt(store, projectId, original.id);
  if (
    a.fence !== original.fence ||
    a.workerId !== original.workerId ||
    a.requestDigest !== original.requestDigest ||
    a.status !== 'dispatching'
  )
    fail('WORKER_FENCED', 'Execution ownership changed.');
  const w = store.get('SELECT status FROM generation_workers WHERE id=?', a.workerId);
  if (w?.status !== 'active') fail('WORKER_FENCED', 'Worker is no longer active.');
  return a;
}
function definiteFailure(store, projectId, a, reason) {
  a.status = 'failed_definite';
  a.outcomeReason = reason;
  saveAttempt(store, projectId, a);
  release(store, projectId, a.id, reason);
  store.run(
    "UPDATE generation_outbox SET status='done' WHERE project_id=? AND attempt_id=?",
    projectId,
    a.id
  );
  const job = getJob(store, projectId, a.jobId);
  job.status = reason === 'source_binding_stale' ? 'blocked_source_review' : 'failed_definite';
  job.outcomeReason = reason;
  saveJob(store, projectId, job);
  progress(store, projectId, a, 'attempt.failed_definite');
}
async function prepareResult(service, projectId, result) {
  if (!result || !Array.isArray(result.outputs) || !result.outputs.length)
    fail('INVALID_PROVIDER_RESULT', 'Provider output is missing.');
  const outputs = [];
  for (const output of result.outputs) {
    if (
      !(output.bytes instanceof Uint8Array) ||
      output.bytes.length === 0 ||
      typeof output.mime !== 'string' ||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(output.mime)
    )
      fail('INVALID_PROVIDER_RESULT', 'Invalid provider output bytes or media type.');
    outputs.push({
      ...(await service.blobs.put(projectId, output.bytes)),
      mime: output.mime
    });
  }
  if (result.resolvedModel != null) assertText(result.resolvedModel);
  if (result.providerRequestId != null) assertText(result.providerRequestId);
  const usage =
    result.usage == null
      ? null
      : Object.fromEntries(
          ['inputTokens', 'outputTokens', 'totalTokens', 'outputCount', 'audioSeconds']
            .filter(
              (k) =>
                typeof result.usage[k] === 'number' &&
                Number.isFinite(result.usage[k]) &&
                result.usage[k] >= 0
            )
            .map((k) => [k, result.usage[k]])
        );
  return {
    outputs,
    resolvedModel: result.resolvedModel ?? null,
    returnedModel: typeof result.returnedModel === 'string' ? result.returnedModel : null,
    returnedVoice: typeof result.returnedVoice === 'string' ? result.returnedVoice : null,
    providerRequestId: result.providerRequestId ?? null,
    usage
  };
}
function completeResult(store, projectId, a, prepared) {
  Object.assign(a, prepared, { status: 'succeeded' });
  saveAttempt(store, projectId, a);
  // Successful bytes do not prove the provider invoice. Keep the estimate until explicit verified reconciliation.
  holdUnknown(store, projectId, a.id);
  store.run(
    "UPDATE generation_outbox SET status='done' WHERE project_id=? AND attempt_id=?",
    projectId,
    a.id
  );
  const job = getJob(store, projectId, a.jobId);
  if (
    job.currentAttemptId === a.id &&
    job.subscribers.some((subscriber) => subscriber.status === 'attached')
  ) {
    job.status = 'pending_validation';
    saveJob(store, projectId, job);
  }
  progress(store, projectId, a, 'attempt.succeeded');
}
export async function runWorker({ service, providers = service.providers, signal, drain = false, projectId: selectedProjectId, attemptId: selectedAttemptId }) {
  if (selectedProjectId !== undefined) assertId(selectedProjectId);
  if (selectedAttemptId !== undefined) {
    assertId(selectedAttemptId);
    if (selectedProjectId === undefined) fail('INVALID_INPUT', 'Attempt scope requires its project.');
  }
  return service.runBackground(async (closeSignal) => {
    const stop = signal ? AbortSignal.any([signal, closeSignal]) : closeSignal;
    const { store } = service;
    recoverWorkers(service);
    const id = randomUUID(),
      start = incarnation(process.pid);
    if (!start) fail('WORKER_IDENTITY_UNAVAILABLE', 'Cannot establish local process incarnation.');
    liveWorkers.add(id);
    store.write(() =>
      store.run(
        'INSERT INTO generation_workers(id,pid,incarnation,hostname,lease_until,status) VALUES(?,?,?,?,?,?)',
        id,
        process.pid,
        start,
        host,
        Date.now() + 30000,
        'active'
      )
    );
    const heartbeat = setInterval(() => {
      if (!store.closed)
        store.write(() =>
          store.run(
            "UPDATE generation_workers SET lease_until=? WHERE id=? AND status='active'",
            Date.now() + 30000,
            id
          )
        );
    }, 10000);
    heartbeat.unref();
    try {
      while (!stop.aborted) {
        const row = store.get(
          "SELECT a.project_id,a.data_json FROM generation_outbox o JOIN generation_attempts a ON a.project_id=o.project_id AND a.id=o.attempt_id WHERE o.status='queued' AND a.status='prepared' AND (? IS NULL OR a.project_id=?) AND (? IS NULL OR a.id=?) ORDER BY o.rowid LIMIT 1",
          selectedProjectId ?? null, selectedProjectId ?? null, selectedAttemptId ?? null, selectedAttemptId ?? null
        );
        if (!row) {
          if (drain) break;
          await delay(50, null, { signal: stop }).catch(() => {});
          continue;
        }
        const projectId = row.project_id,
          original = JSON.parse(row.data_json),
          provider = providers[original.request.provider];
        let preflightError = null,
          capabilities,
          providerInput;
        try {
          if (!provider || typeof provider.generate !== 'function')
            fail('PROVIDER_UNAVAILABLE', 'Generation provider is unavailable.');
          validateProviderInput(service, projectId, original.request,
            pinTarget(store, projectId, original.request.target));
          capabilities = await provider.capabilities();
          if (
            !capabilities.kinds?.includes(original.request.kind) ||
            !capabilities.models?.includes(original.request.input.model)
          )
            fail('CAPABILITY_UNAVAILABLE', 'Provider does not support this request.');
          providerInput = {
            kind: original.request.kind,
            ...structuredClone(original.request.input)
          };
          if (providerInput.blobIds) {
            providerInput.blobs = await Promise.all(
              providerInput.blobIds.map(async (blobId) => ({
                blobId,
                bytes: await service.blobs.read(projectId, blobId)
              }))
            );
            delete providerInput.blobIds;
          }
        } catch {
          preflightError = 'local_preflight_failed';
        }
        const claimed = store.write(() => {
          const a = getAttempt(store, projectId, original.id);
          if (a.status !== 'prepared') return null;
          if (preflightError || stop.aborted) {
            definiteFailure(store, projectId, a, preflightError ?? 'cancelled_before_dispatch');
            return null;
          }
          try {
            const job = getJob(store, projectId, a.jobId);
            checkPinnedRequest(store, projectId, a.request);
            for (const sub of job.subscribers.filter((s) => s.status === 'attached'))
              checkPinnedRequest(store, projectId, sub);
          } catch (error) {
            definiteFailure(
              store,
              projectId,
              a,
              error.code === 'SOURCE_BINDING_STALE' ? 'source_binding_stale' : 'input_stale'
            );
            return null;
          }
          a.status = 'dispatching';
          a.workerId = id;
          a.fence++;
          a.dispatchedAt = Date.now();
          a.inspectSupported = capabilities.inspect === true;
          saveAttempt(store, projectId, a);
          store.run(
            "UPDATE generation_outbox SET status='dispatched' WHERE project_id=? AND attempt_id=?",
            projectId,
            a.id
          );
          const job = getJob(store, projectId, a.jobId);
          job.status = 'running';
          saveJob(store, projectId, job);
          progress(store, projectId, a, 'attempt.dispatching');
          return a;
        });
        if (!claimed) continue;
        try {
          // This call occurs only after the dispatch transaction COMMIT above.
          const result = await provider.generate(providerInput, {
            signal: stop,
            onOperation(operationId) {
              assertText(operationId);
              store.write(() => {
                const a = fenced(store, projectId, claimed);
                a.operationId = operationId;
                saveAttempt(store, projectId, a);
              });
            }
          });
          if (result?.status === 'pending' && result.operationId) {
            assertText(result.operationId);
            store.write(() => {
              const a = fenced(store, projectId, claimed);
              a.operationId = result.operationId;
              markUnknown(store, projectId, a, 'operation_pending');
            });
          } else {
            const prepared = await prepareResult(service, projectId, result);
            store.write(() =>
              completeResult(store, projectId, fenced(store, projectId, claimed), prepared)
            );
            await validateAttemptOutputs({service,projectId,attemptId:claimed.id});
          }
        } catch (error) {
          store.write(() => {
            const a = getAttempt(store, projectId, claimed.id);
            if (a.status === 'dispatching' && a.fence === claimed.fence && a.workerId === id) {
              if (error instanceof StudioError && ['PROVIDER_REJECTED', 'PROVIDER_OUTCOME_UNKNOWN', 'INVALID_PROVIDER_RESULT'].includes(error.code)) {
                a.providerFailure = { code: error.code };
                if (Number.isInteger(error.details.httpStatus) && error.details.httpStatus >= 400 && error.details.httpStatus <= 599)
                  a.providerFailure.httpStatus = error.details.httpStatus;
              }
              markUnknown(store, projectId, a, 'ambiguous_provider_outcome');
            }
          });
        }
      }
    } finally {
      clearInterval(heartbeat);
      liveWorkers.delete(id);
      store.write(() => {
        store.run("UPDATE generation_workers SET status='stopped' WHERE id=?", id);
        for (const row of store.all(
          "SELECT project_id,data_json FROM generation_attempts WHERE status='dispatching'"
        )) {
          const a = JSON.parse(row.data_json);
          if (a.workerId === id) markUnknown(store, row.project_id, a, 'worker_stopped', true);
        }
      });
    }
  });
}

/** Trusted engine decoder boundary. It receives stored bytes, never authorizes a provider resend or adoption. */
export async function validateAttemptOutputs({ service, projectId, attemptId, validate }) {
  return service.runBackground(async () => {
    const { store } = service,
      original = getAttempt(store, projectId, attemptId);
    if (original.status !== 'succeeded')
      fail('INVALID_STATE', 'Only completed raw outputs can be validated.');
    const outputs = await Promise.all(
      original.outputs.map(async (o) => ({
        ...o,
        bytes: await service.blobs.read(projectId, o.blobId)
      }))
    );
    if (!validate && original.request.kind === 'text' && !['adaptation_proposal','scene_adaptation_proposal'].includes(original.request.recipe?.operation)) return [];
    if (!validate && original.request.kind === 'text') validate=proposalValidator(service,projectId);
    const validated = await (validate ?? mediaValidator(service,projectId))({
      kind: original.request.kind,
      request: structuredClone(original.request),
      outputs
    });
    if (!Array.isArray(validated) || validated.length !== outputs.length)
      fail('INVALID_VALIDATION', 'Every raw output needs a validation result.');
    canonicalJSON(validated);
    for (let i = 0; i < validated.length; i++)
      if (
        validated[i].blobId !== outputs[i].blobId ||
        validated[i].mediaKind !== original.request.kind
      )
        fail(
          'INVALID_VALIDATION',
          'Validator must identify the original output and declared media kind.'
        );
    return store.write(() => finalizeValidatedOutputs(store,projectId,original,validated));
  });
}
function finalizeValidatedOutputs(store, projectId, original, validated) {
  const a = getAttempt(store, projectId, original.id);

  if (a.status !== 'succeeded' || a.fence !== original.fence || a.requestDigest !== original.requestDigest || canonicalDigest(a.outputs) !== canonicalDigest(original.outputs))
    fail('WORKER_FENCED', 'Output ownership changed while validating.');

  const existing = store.all(
    'SELECT data_json FROM generation_candidates WHERE project_id=? AND attempt_id=?',
    projectId,
    original.id
  );

  if (existing.length)
    return existing.map(r => JSON.parse(r.data_json));

  if (a.validationStatus === 'quarantined')
    return [];

  if (validated.some(output => output.validation?.status === 'quarantined')) {
    for (let i = 0; i < validated.length; i++) if (validated[i].validation?.status === 'quarantined') insertQuarantine(store, projectId, {
      id: randomUUID(),
      attemptId: a.id,
      outputIndex: i,
      rawBlobId: validated[i].blobId,
      mediaKind: a.request.kind,
      status: 'quarantined',
      code: validated[i].validation.code
    });

    a.validationStatus = 'quarantined';
    saveAttempt(store, projectId, a);
    const job = getJob(store, projectId, a.jobId);

    if (job.currentAttemptId === a.id && job.subscribers.some(s => s.status === 'attached')) {
      job.status = 'quarantined';
      saveJob(store, projectId, job);
    }

    progress(store, projectId, a, 'attempt.quarantined');
    return [];
  }

  const candidates = validated.map((output, i) => ({
    id: randomUUID(),
    attemptId: original.id,
    jobId: a.jobId,
    outputIndex: i,
    ...output,
    blobId: output.canonicalBlobId ?? output.blobId,
    rawBlobId: output.rawBlobId ?? output.blobId,
    target: a.request.target,
    productionId: a.request.productionId,
    sceneId: a.request.sceneId,
    castingInventory: a.request.castingInventory,

    ...(a.request.utterancePerformance ? { utterancePerformance: a.request.utterancePerformance } : {}),

    ...(a.request.utteranceBinding ? { utteranceBinding: a.request.utteranceBinding } : {}),

    ...(a.request.audioBinding ? { audioBinding: a.request.audioBinding } : {}),

    sourcePackageId: a.request.sourcePackageId,
    sourcePackageRevision: a.request.sourcePackageRevision,
    sourceBindingRevision: a.request.sourceBindingRevision,
    sourceDependencySpans: a.request.sourceDependencySpans,
    pins: a.request.pins,
    recipe: a.request.recipe,

    ...(a.request.kind === 'audio' ? {
      actualAudioInput: a.request.input,
      configVerification: a.request.inputVerification?.configVerification ?? 'not_performed',
      voiceVerification: 'not_performed',
      actingVerification: 'not_performed',
      transcriptionVerification: 'not_performed',

      ...(a.request.utteranceBinding || a.request.audioBinding ? { speechTextDigest: canonicalDigest(a.request.input.prompt), speechVerification: 'request_matches_utterance' } : { speechVerification: 'unverified_request' })
    } : {}),

    requestDigest: a.requestDigest,
    generationInputDigest: a.generationInputDigest,

    lineage: { kind: 'provider', parentCandidateIds: [] },
    providerProvenance: {
      provider: a.request.provider,
      surface: a.request.inputVerification?.surface ?? null,
      requestedModel: a.request.input.model,
      returnedModel: a.returnedModel ?? null,
      resolvedVersion: a.resolvedModel ?? null,
      returnedVoice: a.returnedVoice ?? null,
    },

    ...(a.request.assetSlotId ? {
      slotId: a.request.assetSlotId,

      slotIntent: {
        subject: a.request.slotSubject,
        appearanceStateRef: a.request.appearanceStateRef,

        ...(a.request.kind === 'audio' ? { castingStateRef: a.request.castingStateRef ?? null, utteranceId: a.request.utteranceId ?? null } : {})
      },

      baseAdoptionId: a.request.baseAdoptionId,
      baseCandidateId: a.request.baseCandidateId
    } : {})
  }));
  for (const c of candidates) store.run(
    'INSERT INTO generation_candidates(project_id,id,attempt_id,data_json) VALUES(?,?,?,?)',
    projectId,
    c.id,
    original.id,
    canonicalJSON(c)
  );

  const job = getJob(store, projectId, a.jobId);

  if (job.currentAttemptId === a.id && job.subscribers.some(subscriber => subscriber.status === 'attached')) {
    job.status = 'candidate_ready';
    saveJob(store, projectId, job);
  }

  a.validationStatus = 'passed';
  saveAttempt(store, projectId, a);
  progress(store, projectId, a, 'attempt.validated');
  return candidates;
}

export function registerRecoveryCommands(service) {
  const { store } = service;

  service.registerCommand('attempt.reconcile', {
    target: ({ envelope }) => ({ kind: 'attempt', id: envelope.payload.attemptId }),

    async prepare({ envelope }) {
      const p = envelope.payload, a = getAttempt(store, envelope.projectId, p.attemptId);

      if (p.action !== 'inspect') return { original: a };

      const provider = service.providers[a.request.provider];

      if (a.status !== 'outcome_unknown' || !a.operationId || !a.inspectSupported || typeof provider?.inspect !== 'function')
        fail('RECOVERY_UNAVAILABLE', 'No retrievable provider operation is recorded.');

      const capabilities = await provider.capabilities();

      if (!capabilities.inspect)
        fail('RECOVERY_UNAVAILABLE', 'Provider inspection is unavailable.');

      const inspection = await provider.inspect(a.operationId);
      const output = inspection.status === 'succeeded' ? await prepareResult(service, envelope.projectId, inspection.result) : null;

      const validator=a.request.kind==='text' ? (['adaptation_proposal','scene_adaptation_proposal'].includes(a.request.recipe?.operation) ? proposalValidator(service,envelope.projectId) : null) : mediaValidator(service,envelope.projectId);
      const validation = output && validator ? await validator({
        request: a.request,
        kind: a.request.kind,

        outputs: await Promise.all(output.outputs.map(async o => ({ ...o, bytes: await service.blobs.read(envelope.projectId, o.blobId) })))
      }) : null;

      return { original: a, inspection, output, validation };
    },

    apply({ envelope, prepared }) {
      const p = envelope.payload, a = getAttempt(store, envelope.projectId, p.attemptId), old = prepared.original;

      if (a.fence !== old.fence || a.status !== old.status || a.requestDigest !== old.requestDigest || a.operationId !== old.operationId)
        fail('WORKER_FENCED', 'Attempt changed during reconciliation.');

      if (p.action === 'inspect') {
        if (prepared.output) {
          completeResult(store, envelope.projectId, a, prepared.output);

          if (prepared.validation)
            finalizeValidatedOutputs(store, envelope.projectId, a, prepared.validation);
        } else if (prepared.inspection.status !== 'pending')
          fail('INVALID_PROVIDER_RESULT', 'Inspection must provide pending or a completed result.');
      } else if (p.action === 'billing') {
        if (!['outcome_unknown', 'succeeded'].includes(a.status))
          fail('INVALID_STATE', 'Billing reconciliation requires a dispatched outcome.');

        reconcileBudget(store, envelope.projectId, a.id, p.evidence);
        a.reconciliations = [...(a.reconciliations ?? []), p.evidence];
        saveAttempt(store, envelope.projectId, a);
      } else
        fail('INVALID_INPUT', 'Unknown reconciliation action.');

      return a;
    }
  });
}

export async function revalidatePendingOutputs(service) {
  for (const row of service.store.all('SELECT project_id,data_json FROM generation_attempts WHERE status=\'succeeded\'')) {
    const a = JSON.parse(row.data_json);

    if ((a.request.kind === 'text' && !['adaptation_proposal','scene_adaptation_proposal'].includes(a.request.recipe?.operation)) || a.validationStatus || service.store.get('SELECT id FROM generation_candidates WHERE project_id=? AND attempt_id=?', row.project_id, a.id))
      continue;

    try {
      await validateAttemptOutputs({ service, projectId: row.project_id, attemptId: a.id });
    } catch (error) {
      // Retain raw history and held liability; startup integrity exposes damaged
      // bytes for repair. A corrupt pending result must never authorize a resend.
      if (!['BLOB_CORRUPT', 'BLOB_MISSING'].includes(error.code)) throw error;
    }
  }
}
