import { randomUUID } from 'node:crypto';
import {
  assertId,
  assertInteger,
  assertText,
  canonicalDigest,
  canonicalJSON,
  fail
} from './contracts.js';
import { readValues, requireValue } from './story.js';
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
    CREATE TABLE IF NOT EXISTS generation_candidates(project_id TEXT NOT NULL,id TEXT NOT NULL,attempt_id TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(project_id,id),FOREIGN KEY(project_id,attempt_id) REFERENCES generation_attempts(project_id,id));
  `)
  );
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
function pinCommonTarget(store, projectId, target) {
  const pins = [{ kind: target.kind, id: target.id }];
  let productionId = null,
    sourcePackageId = target.sourcePackageId ?? null;
  if (target.kind === 'project') {
    if (target.id !== projectId)
      fail('INVALID_REFERENCE', 'Project target must match command project.');
    store.requireProject(projectId);
  } else if (target.kind === 'production') {
    const production = requireValue(store, projectId, 'production', target.id);
    productionId = production.id;
    if (sourcePackageId && sourcePackageId !== production.sourcePackageId)
      fail('SOURCE_BINDING_STALE', 'Requested source does not match production.');
    sourcePackageId = production.sourcePackageId;
    pins.push({ kind: 'sourceBinding', id: productionId });
  } else {
    const role = requireValue(store, projectId, 'cast', target.id);
    const definitions = readValues(store, projectId, 'cast').filter(
      (r) => r.identity && r.identity.id === role.characterId
    );
    for (const definition of definitions) pins.push({ kind: 'cast', id: definition.id });
    const origin = definitions[0]?.identity.origin;
    if (origin?.kind === 'source') {
      pins.push({ kind: 'sourcePackage', id: origin.packageId });
      sourcePackageId ??= origin.packageId;
    }
  }
  if (target.stateRef != null) {
    if (target.kind !== 'cast') fail('INVALID_INPUT', 'State references require a cast target.');
    requireValue(store, projectId, 'state', target.stateRef);
    const local = readValues(store, projectId, 'story').find((story) =>
      story.states.some((state) => state.id === target.stateRef)
    );
    if (local) pins.push({ kind: 'story', id: local.id });
    else {
      const declarations = readValues(store, projectId, 'sourcePackage').filter(
        (pkg) =>
          (!sourcePackageId || pkg.id === sourcePackageId) &&
          pkg.sceneScopes.some((scope) =>
            Object.values(scope.stateIds ?? {})
              .flat()
              .includes(target.stateRef)
          )
      );
      if (!declarations.length)
        fail('INVALID_REFERENCE', 'State is outside the selected source scope.');
      for (const pkg of declarations) pins.push({ kind: 'sourcePackage', id: pkg.id });
      sourcePackageId ??= declarations[0].id;
    }
  }
  const source = sourcePackageId
    ? requireValue(store, projectId, 'sourcePackage', sourcePackageId)
    : null;
  if (source) pins.push({ kind: 'sourcePackage', id: source.id });
  const spans = target.sourceUnitIds ?? [];
  if (
    !Array.isArray(spans) ||
    spans.some((id) => !source?.textUnits.some((unit) => unit.id === id))
  )
    fail('INVALID_REFERENCE', 'Source spans must belong to the pinned package.');
  const unique = Array.from(new Map(pins.map((p) => [`${p.kind}:${p.id}`, p])).values()).map(
    (p) => ({ ...p, revision: store.aggregate(projectId, p).revision })
  );
  return {
    target,
    productionId,
    sceneId: null,
    sourcePackageId,
    sourcePackageRevision: source?.sourceRevision ?? null,
    sourceDependencySpans: spans,
    sourceBindingRevision: productionId
      ? store.aggregate(projectId, { kind: 'sourceBinding', id: productionId }).revision
      : null,
    pins: unique,
    castingInventory: null,
    targetStateRef: target.stateRef ?? null
  };
}
export function pinTarget(store, projectId, target) {
  if (
    !target ||
    !['project', 'production', 'cast', 'shot', 'scene', 'utterance'].includes(target.kind)
  )
    fail('INVALID_INPUT', 'Unknown generation target kind.');
  assertId(target.id);
  if (['project', 'production', 'cast'].includes(target.kind))
    return pinCommonTarget(store, projectId, target);
  const scenes = readValues(store, projectId, 'scene');
  const scene = scenes.find((s) =>
    target.kind === 'scene'
      ? s.id === target.id
      : (target.kind === 'shot' ? s.shots : s.utterances).some((x) => x.id === target.id)
  );
  if (!scene) fail('INVALID_REFERENCE', 'Target does not belong to this project.');
  const production = requireValue(store, projectId, 'production', scene.productionId);
  const sourcePackageId = scene.sourcePackageId ?? production.sourcePackageId;
  if (sourcePackageId !== production.sourcePackageId)
    fail('SOURCE_BINDING_STALE', 'Scene must resolve its source binding before generation.');
  const source = sourcePackageId
    ? requireValue(store, projectId, 'sourcePackage', sourcePackageId)
    : null;
  const pins = [
    { kind: 'scene', id: scene.id },
    ...scene.utterances.map((u) => ({ kind: 'utterance', id: u.id })),
    ...scene.occurrences.map((o) => ({ kind: 'cast', id: o.roleBindingId })),
    ...readValues(store, projectId, 'cast')
      .filter(
        (role) => role.identity && scene.occurrences.some((o) => o.characterId === role.identity.id)
      )
      .map((role) => ({ kind: 'cast', id: role.id })),
    ...readValues(store, projectId, 'story').map((story) => ({ kind: 'story', id: story.id })),
    ...readValues(store, projectId, 'casting').map((c) => ({
      kind: 'casting',
      id: c.id
    })),
    { kind: 'sourceBinding', id: scene.productionId }
  ];
  const unique = Array.from(new Map(pins.map((p) => [`${p.kind}:${p.id}`, p])).values()).map(
    (p) => ({ ...p, revision: store.aggregate(projectId, p).revision })
  );
  // The casting inventory also detects a newly added, more-specific binding before send.
  return {
    target,
    productionId: scene.productionId,
    sceneId: scene.id,
    sourcePackageId,
    sourcePackageRevision: source?.sourceRevision ?? null,
    sourceDependencySpans: scene.sourceUnitIds ?? [],
    sourceBindingRevision: store.aggregate(projectId, {
      kind: 'sourceBinding',
      id: scene.productionId
    }).revision,
    pins: unique,
    castingInventory: canonicalDigest(
      readValues(store, projectId, 'casting')
        .map((c) => c.id)
        .sort()
    )
  };
}
export function checkPinnedRequest(store, projectId, request) {
  const current = pinTarget(store, projectId, request.target);
  if (
    current.sourcePackageId !== request.sourcePackageId ||
    current.sourceBindingRevision !== request.sourceBindingRevision
  )
    fail('SOURCE_BINDING_STALE', 'Source binding changed and requires explicit review.');
  if (
    canonicalDigest(current) !==
    canonicalDigest(Object.fromEntries(Object.keys(current).map((k) => [k, request[k]])))
  )
    fail('INPUT_STALE', 'Generation target or source dependencies changed before dispatch.');
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
      pinTarget(store, envelope.projectId, envelope.payload.target);
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
        saveJob(store, projectId, job);
        return job;
      }
      const request = {
        ...pinned,
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
    target: ({ envelope }) => ({
      kind: 'generation',
      id: envelope.payload.subscriberId
    }),
    apply({ envelope }) {
      const p = envelope.payload,
        projectId = envelope.projectId;
      validatePayload(p);
      const job = getJob(store, projectId, p.jobId);
      if (
        job.status !== 'candidate_ready' ||
        !store.get(
          'SELECT id FROM generation_candidates WHERE project_id=? AND attempt_id=?',
          projectId,
          job.currentAttemptId
        )
      )
        fail('CANDIDATE_UNAVAILABLE', 'Reuse requires validated candidates.');
      const pinned = pinTarget(store, projectId, p.target),
        old = { ...job.request },
        semantic = { ...pinned };
      delete semantic.target;
      const previous = Object.fromEntries(Object.keys(semantic).map((k) => [k, old[k]]));
      if (
        p.intent !== 'reuse_or_generate' ||
        p.provider !== old.provider ||
        canonicalDigest(p.context) !== canonicalDigest(old.context) ||
        canonicalDigest({ kind: p.kind, input: p.input }) !== job.generationInputDigest ||
        canonicalDigest(p.recipe) !== canonicalDigest(old.recipe) ||
        canonicalDigest(semantic) !== canonicalDigest(previous)
      )
        fail('INCOMPATIBLE_REUSE', 'Candidate context or source dependencies do not match.');
      if (job.subscribers.some((x) => x.id === p.subscriberId))
        fail('INVALID_STATE', 'Subscriber already exists.');
      job.subscribers.push({
        id: p.subscriberId,
        commandId: envelope.commandId,
        ...pinned,
        recipe: p.recipe,
        status: 'attached'
      });
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
