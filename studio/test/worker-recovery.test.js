import { png, basePixels } from './helpers/images.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { openStudio } from '../src/engine/index.js';
import { withGeneration, validImageRequest, generationCommand, retainPendingOutput } from './helpers/project.js';

const result = {
  outputs: [{ bytes: [...await png(basePixels)], mime: 'image/png' }],
  resolvedModel: 'fake-v1',
  providerRequestId: 'req1',
  usage: null
};
export async function httpProvider(t, { hold = false } = {}) {
  const requests = [],
    responses = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    responses.push(res);
    if (!hold) res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    responses,
    provider: {
      capabilities: () => ({
        kinds: ['image', 'text'],
        models: ['fake-v1'],
        inspect: false
      }),
      async generate(request, { signal }) {
        const r = await fetch(url, {
          method: 'POST',
          body: JSON.stringify(request),
          signal
        });
        const data = await r.json();
        return {
          ...data,
          outputs: data.outputs.map((o) => ({
            ...o,
            bytes: Uint8Array.from(o.bytes)
          }))
        };
      }
    }
  };
}
async function until(check) {
  for (let n = 0; n < 200; n++) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for fixture');
}
async function spawnWorker(t, f, remote, mode) {
  const child = fork(
    new URL('./helpers/child-worker.js', import.meta.url),
    [f.directory, remote.url, mode],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  let error = '';
  child.stderr.on('data', (s) => (error += s));
  const messages = [];
  child.on('message', (m) => messages.push(m));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  });
  return {
    child,
    messages,
    get error() {
      return error;
    }
  };
}
for (const mode of ['before', 'after-send', 'after-response'])
  it(`real child SIGKILL ${mode} recovers committed dispatch as held unknown with no second HTTP send`, async (t) => {
    const f = await withGeneration(t),
      remote = await httpProvider(t, { hold: mode === 'after-send' });
    await generationCommand(f);
    const { runWorker } = await import('../src/engine/worker.js');
    const w = await spawnWorker(t, f, remote, mode);
    await until(() => {
      if (w.child.exitCode !== null) throw new Error(w.error);
      return mode === 'after-send'
        ? remote.requests.length === 1
        : w.messages.some(
            (m) => m.stage === (mode === 'before' ? 'before-send' : 'after-response')
          );
    });
    assert.equal((await f.service.snapshot('p1')).attempts[0].status, 'dispatching');
    const exited = once(w.child, 'exit');
    w.child.kill('SIGKILL');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
    const recovered = await openStudio({ directory: f.directory });
    t.after(() => recovered.close());
    let s = await recovered.snapshot('p1');
    assert.equal(s.attempts[0].status, 'outcome_unknown');
    assert.equal(s.attempts[0].reservationStatus, 'held_unknown');
    const expected = mode === 'before' ? 0 : 1;
    assert.equal(remote.requests.length, expected);
    await runWorker({
      service: recovered,
      providers: { fake: remote.provider },
      drain: true
    });
    assert.equal(remote.requests.length, expected);
    s = await recovered.snapshot('p1');
    assert.equal(s.candidates.length, 0);
    await generationCommand(f);
    assert.equal((await f.service.snapshot('p1')).attempts.length, 1);
  });
it('opening another connection never steals a live dispatch even after its lease expires', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t, { hold: true });
  await generationCommand(f);
  const { runWorker } = await import('../src/engine/worker.js');
  const w = await spawnWorker(t, f, remote, 'after-send');
  await until(() => remote.requests.length === 1);
  f.service.store.write(() => f.service.store.run('UPDATE generation_workers SET lease_until=0'));
  const other = await openStudio({ directory: f.directory });
  t.after(() => other.close());
  assert.equal((await other.snapshot('p1')).attempts[0].status, 'dispatching');
  await runWorker({
    service: other,
    providers: { fake: remote.provider },
    drain: true
  });
  assert.equal(remote.requests.length, 1);
  remote.responses[0].end(JSON.stringify(result));
  await until(() => w.messages.some((m) => m.stage === 'done'));
  const s = await f.service.snapshot('p1');
  assert.equal(s.jobs[0].status, 'candidate_ready');
  assert.equal(s.candidates.length, 1);
});
it('stores immutable raw bytes and real decoded candidates without advancing scene revision', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t);
  await generationCommand(f);
  const { runWorker } = await import('../src/engine/worker.js');
  await runWorker({
    service: f.service,
    providers: { fake: remote.provider },
    drain: true
  });
  const s = await f.service.snapshot('p1');
  assert.equal(remote.requests.length, 1);
  assert.equal(s.attempts[0].status, 'succeeded');
  assert.equal(s.jobs[0].status, 'candidate_ready');
  assert.equal(s.candidates.length, 1);
  assert.equal(s.aggregates.find((a) => a.kind === 'scene').revision, 1);
  assert.deepEqual(
    [...(await f.service.readBlob('p1', s.attempts[0].outputs[0].blobId))],
    result.outputs[0].bytes
  );
  assert.equal(s.reservations[0].status, 'held_unknown');
});
it('rejects stale scene and independent utterance inputs before any send and releases definite non-dispatch', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t);
  await generationCommand(f);
  const scene = (await f.service.snapshot('p1')).scenes[0];
  await f.command(
    'scene.put',
    { ...scene, title: 'changed' },
    { aggregate: { kind: 'scene', id: 'scene' } }
  );
  const { runWorker } = await import('../src/engine/worker.js');
  await runWorker({
    service: f.service,
    providers: { fake: remote.provider },
    drain: true
  });
  const s = await f.service.snapshot('p1');
  assert.equal(remote.requests.length, 0);
  assert.equal(s.attempts[0].status, 'failed_definite');
  assert.equal(s.reservations[0].status, 'released');
});
it('timeout after dispatch keeps unknown funds and retry requires a separate additional reservation', async (t) => {
  const f = await withGeneration(t);
  const job = await generationCommand(f);
  const { runWorker } = await import('../src/engine/worker.js');
  await runWorker({
    service: f.service,
    providers: {
      fake: {
        capabilities: () => ({ kinds: ['image'], models: ['fake-v1'] }),
        generate: async () => {
          throw new Error('SECRET provider timeout');
        }
      }
    },
    drain: true
  });
  let s = await f.service.snapshot('p1');
  const first = s.attempts[0];
  assert.equal(first.status, 'outcome_unknown');
  assert.equal(s.budget.heldUnknownEstimateMicros, 100000);
  assert.ok(!JSON.stringify(s).includes('SECRET'));
  await assert.rejects(
    f.command(
      'attempt.reconcile',
      { attemptId: first.id, action: 'inspect' },
      { aggregate: { kind: 'attempt', id: first.id } }
    ),
    { code: 'RECOVERY_UNAVAILABLE' }
  );
  await f.command(
    'attempt.retry',
    {
      attemptId: first.id,
      acceptDuplicateChargeRisk: true,
      estimateMicros: 100000
    },
    { aggregate: { kind: 'job', id: job.value.id } }
  );
  s = await f.service.snapshot('p1');
  assert.equal(s.attempts.length, 2);
  assert.equal(s.attempts[0].status, 'outcome_unknown');
  assert.equal(s.budget.availableMicros, 800000);
  assert.notEqual(s.attempts[0].id, s.attempts[1].id);
  assert.equal(s.attempts[0].requestDigest, s.attempts[1].requestDigest);
});
it('a trusted output validator can register a text proposal without another dispatch', async (t) => {
  const f = await withGeneration(t);
  await generationCommand(f, validImageRequest({ kind: 'text' }));
  const { runWorker, validateAttemptOutputs } = await import('../src/engine/worker.js');
  await runWorker({
    service: f.service,
    providers: {
      fake: {
        capabilities: () => ({ kinds: ['text'], models: ['fake-v1'] }),
        generate: async () => ({
          ...result,
          outputs: [
            {
              bytes: Buffer.from('{"title":"Proposal"}'),
              mime: 'application/json'
            }
          ]
        })
      }
    },
    drain: true
  });
  const a = (await f.service.snapshot('p1')).attempts[0];
  await validateAttemptOutputs({
    service: f.service,
    projectId: 'p1',
    attemptId: a.id,
    validate: async ({ outputs }) =>
      outputs.map((o) => ({
        blobId: o.blobId,
        mime: o.mime,
        mediaKind: 'text',
        metadata: JSON.parse(Buffer.from(o.bytes).toString())
      }))
  });
  const s = await f.service.snapshot('p1');
  assert.equal(s.jobs[0].status, 'candidate_ready');
  assert.equal(s.candidates[0].metadata.title, 'Proposal');
  assert.equal(s.attempts.length, 1);
  assert.equal(s.candidates[0].sourcePackageId, null);
  assert.equal(s.candidates[0].target.id, 'shot');
});

it('inspect recovers a persisted queryable operation without another generation and sanitizes usage metadata', async (t) => {
  const provider = {
    capabilities: () => ({
      kinds: ['image'],
      models: ['fake-v1'],
      inspect: true
    }),
    generate: async () => ({ status: 'pending', operationId: 'op1' }),
    inspect: async (id) => {
      assert.equal(id, 'op1');
      return {
        status: 'succeeded',
        result: {
          ...result,
          outputs: [{ bytes: await png(basePixels), mime: 'image/png' }],
          usage: { outputCount: 1, apiKey: 'SECRET' }
        }
      };
    }
  };
  const f = await withGeneration(t, { providers: { fake: provider } });
  await generationCommand(f);
  const { runWorker } = await import('../src/engine/worker.js');
  await runWorker({ service: f.service, drain: true });
  let s = await f.service.snapshot('p1');
  assert.equal(s.attempts[0].status, 'outcome_unknown');
  assert.equal(s.attempts[0].operationId, 'op1');
  await f.command(
    'attempt.reconcile',
    { attemptId: s.attempts[0].id, action: 'inspect' },
    { aggregate: { kind: 'attempt', id: s.attempts[0].id } }
  );
  s = await f.service.snapshot('p1');
  assert.equal(s.attempts.length, 1);
  assert.equal(s.attempts[0].status, 'succeeded');
  assert.equal(s.jobs[0].status, 'candidate_ready');
  assert.deepEqual(s.attempts[0].usage, { outputCount: 1 });
  assert.ok(!JSON.stringify(s).includes('SECRET'));
});
it('source rebase inventories all execution states and late outputs retain original package target and recipe', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t, { hold: true });
  const { makeSourcePackage } = await import('../src/source/source-package.js');
  const pkg = makeSourcePackage({
    sourceKind: 'studio-script',
    sourceRevision: 'v2',
    textUnits: [],
    sceneScopes: [],
    sourceIdentityMap: [],
    revealPolicy: {},
    blobManifest: [],
    preservationStatus: { actualSourceBytes: 'complete' }
  });
  await f.command(
    'source.import',
    { package: pkg, blobs: [] },
    { aggregate: { kind: 'sourcePackage', id: pkg.id } }
  );
  const j = await generationCommand(f);
  await generationCommand(f, validImageRequest({ intent: 'fresh_variation' }));
  const { runWorker, validateAttemptOutputs } = await import('../src/engine/worker.js');
  const running = runWorker({
    service: f.service,
    providers: { fake: remote.provider },
    drain: true
  });
  await until(() => remote.requests.length === 1);
  const decision = await f.command(
    'source.rebase',
    {
      productionId: 'main',
      sourcePackageId: pkg.id,
      actor: 'user',
      reason: 'change'
    },
    { aggregate: { kind: 'sourceBinding', id: 'main' } }
  );
  assert.equal(decision.value.executionImpacts.jobIds.length, 2);
  assert.equal(decision.value.executionImpacts.attemptIds.length, 2);
  await f.command(
    'source.rebase',
    {
      productionId: 'main',
      decisionId: decision.value.id,
      action: 'apply',
      actor: 'user',
      reason: 'approve',
      choices: [{ sceneId: 'scene', action: 'replan' }]
    },
    { aggregate: { kind: 'sourceBinding', id: 'main' } }
  );
  remote.responses[0].end(JSON.stringify(result));
  await running;
  let s = await f.service.snapshot('p1');
  assert.equal(remote.requests.length, 1);
  assert.equal(s.attempts[1].status, 'failed_definite');
  assert.equal(s.attempts[1].outcomeReason, 'source_binding_stale');
  assert.equal(
    s.jobs.find((x) => x.currentAttemptId === s.attempts[1].id).status,
    'blocked_source_review'
  );
  const a = s.attempts[0];
  assert.equal(a.request.sourcePackageId, null);
  assert.equal(a.request.target.id, 'shot');
  assert.deepEqual(a.request.recipe, { operation: 'generate' });
  await validateAttemptOutputs({
    service: f.service,
    projectId: 'p1',
    attemptId: a.id,
    validate: async ({ outputs }) =>
      outputs.map((o) => ({
        blobId: o.blobId,
        mime: o.mime,
        mediaKind: 'image',
        metadata: { decoded: true }
      }))
  });
  s = await f.service.snapshot('p1');
  assert.equal(s.candidates[0].sourcePackageId, null);
  assert.equal(s.candidates[0].sourceBindingRevision, 0);
  assert.equal(s.productions[0].sourcePackageId, pkg.id);
  assert.equal(s.jobs.find((x) => x.id === j.value.id).request.sourcePackageId, null);
});
it('output validation rechecks attempt fence after awaiting the decoder and never creates candidates on stale ownership', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t);
  await generationCommand(f);
  const { runWorker, validateAttemptOutputs } = await import('../src/engine/worker.js');
  const a = await retainPendingOutput(f,await png(basePixels));
  let releaseDecoder, entered;
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (releaseDecoder = r));
  const decoding = validateAttemptOutputs({
    service: f.service,
    projectId: 'p1',
    attemptId: a.id,
    validate: async ({ outputs }) => {
      entered();
      await gate;
      return outputs.map((o) => ({
        blobId: o.blobId,
        mediaKind: 'image',
        mime: o.mime
      }));
    }
  });
  await started;
  f.service.store.write(() => {
    const changed = { ...a, fence: a.fence + 1 };
    delete changed.reservationStatus;
    f.service.store.run(
      'UPDATE generation_attempts SET fence=?,data_json=? WHERE project_id=? AND id=?',
      changed.fence,
      JSON.stringify(changed),
      'p1',
      a.id
    );
  });
  releaseDecoder();
  await assert.rejects(decoding, { code: 'WORKER_FENCED' });
  assert.equal((await f.service.snapshot('p1')).candidates.length, 0);
});
it('independent utterance and casting edits invalidate a queued shot without modifying the scene aggregate', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t);
  await f.command(
    'cast.put',
    { id: 'narrator', name: 'Narrator', language: 'ko', characterId: null },
    { aggregate: { kind: 'cast', id: 'narrator' } }
  );
  const scene = {
    ...(await f.service.snapshot('p1')).scenes[0],
    occurrences: [{ id: 'o', presence: 'narrator', roleBindingId: 'narrator' }],
    presentations: [
      {
        occurrenceId: 'o',
        appearanceStateRef: null,
        castingStateRef: null,
        knowledgeStateRef: null
      }
    ],
    utterances: [
      {
        id: 'u',
        speakerOccurrenceId: 'o',
        addresseeOccurrenceIds: [],
        text: 'Original'
      }
    ]
  };
  await f.command('scene.put', scene, {
    aggregate: { kind: 'scene', id: 'scene' }
  });
  await generationCommand(f);
  await f.command(
    'utterance.update',
    { id: 'u', text: 'Changed' },
    { aggregate: { kind: 'utterance', id: 'u' } }
  );
  const { runWorker } = await import('../src/engine/worker.js');
  await runWorker({
    service: f.service,
    providers: { fake: remote.provider },
    drain: true
  });
  await generationCommand(f, validImageRequest({ intent: 'fresh_variation' }));
  await f.command(
    'casting.set',
    {
      id: 'voice',
      scope: 'project',
      roleId: 'narrator',
      voice: 'v1',
      state: null
    },
    { aggregate: { kind: 'casting', id: 'voice' } }
  );
  await runWorker({
    service: f.service,
    providers: { fake: remote.provider },
    drain: true
  });
  const s = await f.service.snapshot('p1');
  assert.equal(remote.requests.length, 0);
  assert.equal(s.aggregates.find((a) => a.kind === 'scene').revision, 2);
  assert.ok(s.attempts.every((a) => a.status === 'failed_definite'));
});
it('provider receives verified reference bytes without engine target recipe or variation nonce', async (t) => {
  const f = await withGeneration(t),
    blob = await f.service.blobs.put('p1', new Uint8Array([9, 8, 7]));
  const p = validImageRequest({ intent: 'fresh_variation' });
  p.input.blobIds = [blob.blobId];
  await generationCommand(f, p);
  let received;
  const { runWorker } = await import('../src/engine/worker.js');
  await runWorker({
    service: f.service,
    providers: {
      fake: {
        capabilities: () => ({ kinds: ['image'], models: ['fake-v1'] }),
        generate: async (r) => {
          received = r;
          return {
            ...result,
            outputs: [{ bytes: await png(basePixels), mime: 'image/png' }]
          };
        }
      }
    },
    drain: true
  });
  assert.deepEqual([...received.blobs[0].bytes], [9, 8, 7]);
  assert.equal(received.kind, 'image');
  assert.equal(received.target, undefined);
  assert.equal(received.recipe, undefined);
  assert.equal(received.variationNonce, undefined);
});
it('requesting retry records an explicit new execution intent without changing actual provider input', async (t) => {
  const f = await withGeneration(t);
  const j = await generationCommand(f);
  const { runWorker } = await import('../src/engine/worker.js');
  await runWorker({
    service: f.service,
    providers: {
      fake: {
        capabilities: () => ({ kinds: ['image'], models: ['fake-v1'] }),
        generate: async () => {
          throw new Error('timeout');
        }
      }
    },
    drain: true
  });
  const a = (await f.service.snapshot('p1')).attempts[0];
  await f.command(
    'attempt.retry',
    {
      attemptId: a.id,
      acceptDuplicateChargeRisk: true,
      estimateMicros: 100000
    },
    { aggregate: { kind: 'job', id: j.value.id } }
  );
  const s = await f.service.snapshot('p1');
  assert.notEqual(s.attempts[0].executionIntentId, s.attempts[1].executionIntentId);
  assert.equal(s.attempts[1].retryOfAttemptId, a.id);
  assert.equal(s.attempts[1].acceptedDuplicateChargeRisk, true);
  assert.equal(s.attempts[0].generationInputDigest, s.attempts[1].generationInputDigest);
});
it('two live worker connections contending during preflight produce one HTTP request', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t);
  await generationCommand(f);
  const other = await openStudio({ directory: f.directory });
  t.after(() => other.close());
  let count = 0,
    release;
  const gate = new Promise((r) => (release = r));
  const provider = {
    ...remote.provider,
    async capabilities() {
      count++;
      if (count === 2) release();
      await gate;
      return { kinds: ['image'], models: ['fake-v1'] };
    }
  };
  const { runWorker } = await import('../src/engine/worker.js');
  await Promise.all([
    runWorker({
      service: f.service,
      providers: { fake: provider },
      drain: true
    }),
    runWorker({ service: other, providers: { fake: provider }, drain: true })
  ]);
  assert.equal(remote.requests.length, 1);
  const s = await f.service.snapshot('p1');
  assert.equal(s.attempts.length, 1);
  assert.equal(s.attempts[0].status, 'succeeded');
});
it('closing an active worker aborts the network then drains its unknown transition before closing SQLite', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t, { hold: true });
  await generationCommand(f);
  const { runWorker } = await import('../src/engine/worker.js');
  const work = runWorker({
    service: f.service,
    providers: { fake: remote.provider }
  });
  await until(() => remote.requests.length === 1);
  await f.service.close();
  await work;
  const recovered = await openStudio({ directory: f.directory });
  t.after(() => recovered.close());
  const s = await recovered.snapshot('p1');
  assert.equal(s.attempts[0].status, 'outcome_unknown');
  assert.equal(s.reservations[0].status, 'held_unknown');
  assert.equal(remote.requests.length, 1);
});
it('late in-flight success after cancellation retains raw results without reattaching the subscriber', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t, { hold: true });
  const j = await generationCommand(f);
  const { runWorker } = await import('../src/engine/worker.js');
  const work = runWorker({
    service: f.service,
    providers: { fake: remote.provider },
    drain: true
  });
  await until(() => remote.requests.length === 1);
  await f.command(
    'job.cancel',
    { jobId: j.value.id },
    { aggregate: { kind: 'job', id: j.value.id } }
  );
  remote.responses[0].end(JSON.stringify(result));
  await work;
  const s = await f.service.snapshot('p1');
  assert.equal(s.jobs[0].status, 'detached_in_flight');
  assert.equal(s.jobs[0].subscribers[0].status, 'detached');
  assert.equal(s.attempts[0].status, 'succeeded');
  assert.equal(s.attempts[0].outputs.length, 1);
});
it('rebase inventories unknown attempts, raw output and candidates and refreshes pending impacts at apply', async (t) => {
  const f = await withGeneration(t);
  const { runWorker, validateAttemptOutputs } = await import('../src/engine/worker.js');
  await generationCommand(f);
  await runWorker({
    service: f.service,
    providers: {
      fake: {
        capabilities: () => ({ kinds: ['image'], models: ['fake-v1'] }),
        generate: async () => {
          throw new Error('timeout');
        }
      }
    },
    drain: true
  });
  await generationCommand(f, validImageRequest({ intent: 'fresh_variation' }));
  await retainPendingOutput(f,await png(basePixels),'image/png',1);
  let s = await f.service.snapshot('p1');
  const a = s.attempts[1];
  const { makeSourcePackage } = await import('../src/source/source-package.js');
  const pkg = makeSourcePackage({
    sourceKind: 'studio-script',
    sourceRevision: 'v2',
    textUnits: [],
    sceneScopes: [],
    sourceIdentityMap: [],
    revealPolicy: {},
    blobManifest: [],
    preservationStatus: { actualSourceBytes: 'complete' }
  });
  await f.command(
    'source.import',
    { package: pkg, blobs: [] },
    { aggregate: { kind: 'sourcePackage', id: pkg.id } }
  );
  const pending = await f.command(
    'source.rebase',
    {
      productionId: 'main',
      sourcePackageId: pkg.id,
      actor: 'user',
      reason: 'change'
    },
    { aggregate: { kind: 'sourceBinding', id: 'main' } }
  );
  assert.equal(pending.value.executionImpacts.attemptIds.length, 2);
  assert.equal(pending.value.executionImpacts.outputs[0].blobIds[0], a.outputs[0].blobId);
  await validateAttemptOutputs({
    service: f.service,
    projectId: 'p1',
    attemptId: a.id,
    validate: async ({ outputs }) =>
      outputs.map((o) => ({
        blobId: o.blobId,
        mediaKind: 'image',
        mime: o.mime
      }))
  });
  const applied = await f.command(
    'source.rebase',
    {
      productionId: 'main',
      decisionId: pending.value.id,
      action: 'apply',
      actor: 'user',
      reason: 'approve',
      choices: [{ sceneId: 'scene', action: 'replan' }]
    },
    { aggregate: { kind: 'sourceBinding', id: 'main' } }
  );
  s = await f.service.snapshot('p1');
  assert.deepEqual(applied.value.executionImpacts.candidateIds, [s.candidates[0].id]);
  assert.equal(s.attempts[0].status, 'outcome_unknown');
  assert.equal(s.candidates[0].sourcePackageId, null);
});
it('result storage rechecks the dispatch fence after immutable bytes are published', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t);
  await generationCommand(f);
  let entered, resume;
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (resume = r)),
    originalPut = f.service.blobs.put.bind(f.service.blobs);
  f.service.blobs.put = async (...args) => {
    const descriptor = await originalPut(...args);
    entered();
    await gate;
    return descriptor;
  };
  const { runWorker } = await import('../src/engine/worker.js');
  const work = runWorker({ service: f.service, providers: { fake: remote.provider }, drain: true });
  await started;
  const a = (await f.service.snapshot('p1')).attempts[0];
  f.service.store.write(() => {
    const changed = { ...a, status: 'outcome_unknown', fence: a.fence + 1 };
    delete changed.reservationStatus;
    f.service.store.run(
      'UPDATE generation_attempts SET status=?,fence=?,data_json=? WHERE project_id=? AND id=?',
      changed.status,
      changed.fence,
      JSON.stringify(changed),
      'p1',
      a.id
    );
    f.service.store.run(
      "UPDATE budget_reservations SET status='held_unknown' WHERE project_id=? AND attempt_id=?",
      'p1',
      a.id
    );
  });
  resume();
  await work;
  const s = await f.service.snapshot('p1');
  assert.equal(s.attempts[0].status, 'outcome_unknown');
  assert.deepEqual(s.attempts[0].outputs, []);
  assert.equal(s.candidates.length, 0);
});
it('retry cannot dispatch for a job whose subscribers were all detached', async (t) => {
  const f = await withGeneration(t),
    j = await generationCommand(f);
  const { runWorker } = await import('../src/engine/worker.js');
  await runWorker({
    service: f.service,
    providers: {
      fake: {
        capabilities: () => ({ kinds: ['image'], models: ['fake-v1'] }),
        generate: async () => {
          throw new Error('timeout');
        }
      }
    },
    drain: true
  });
  const a = (await f.service.snapshot('p1')).attempts[0];
  await f.command(
    'job.cancel',
    { jobId: j.value.id },
    { aggregate: { kind: 'job', id: j.value.id } }
  );
  await assert.rejects(
    f.command(
      'attempt.retry',
      { attemptId: a.id, acceptDuplicateChargeRisk: true, estimateMicros: 100000 },
      { aggregate: { kind: 'job', id: j.value.id } }
    ),
    { code: 'INVALID_STATE' }
  );
  assert.equal((await f.service.snapshot('p1')).attempts.length, 1);
});
it('queued scene pins shared identity definitions and local state descriptions outside its role entry', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t);
  await f.command(
    'story.save',
    {
      id: 'story',
      title: 'Story',
      text: 'Text',
      states: [{ id: 'adult', description: 'Before' }],
      revealPolicy: {}
    },
    { aggregate: { kind: 'story', id: 'story' } }
  );
  await f.command(
    'cast.put',
    {
      id: 'definition',
      name: 'Identity',
      language: 'ko',
      characterId: 'c',
      identity: { id: 'c', origin: { kind: 'studioLocal' }, description: 'Before' }
    },
    { aggregate: { kind: 'cast', id: 'definition' } }
  );
  await f.command(
    'cast.put',
    { id: 'actor', name: 'Actor', language: 'ko', characterId: 'c' },
    { aggregate: { kind: 'cast', id: 'actor' } }
  );
  const scene = {
    ...(await f.service.snapshot('p1')).scenes[0],
    occurrences: [{ id: 'o', presence: 'onscreen', roleBindingId: 'actor', characterId: 'c' }],
    presentations: [
      {
        occurrenceId: 'o',
        appearanceStateRef: 'adult',
        castingStateRef: null,
        knowledgeStateRef: null
      }
    ]
  };
  await f.command('scene.put', scene, { aggregate: { kind: 'scene', id: 'scene' } });
  await generationCommand(f);
  await f.command(
    'cast.put',
    {
      id: 'definition',
      name: 'Updated identity role',
      language: 'ko',
      characterId: 'c',
      identity: { id: 'c', origin: { kind: 'studioLocal' }, description: 'Before' }
    },
    { aggregate: { kind: 'cast', id: 'definition' } }
  );
  const { runWorker } = await import('../src/engine/worker.js');
  await runWorker({ service: f.service, providers: { fake: remote.provider }, drain: true });
  await generationCommand(f, validImageRequest({ intent: 'fresh_variation' }));
  await f.command(
    'story.save',
    {
      id: 'story',
      title: 'Story',
      text: 'Text',
      states: [{ id: 'adult', description: 'After' }],
      revealPolicy: {}
    },
    { aggregate: { kind: 'story', id: 'story' } }
  );
  await runWorker({ service: f.service, providers: { fake: remote.provider }, drain: true });
  assert.equal(remote.requests.length, 0);
  assert.ok((await f.service.snapshot('p1')).attempts.every((a) => a.status === 'failed_definite'));
});

it('new request after queued cancellation reserves runnable work while preserving cancelled history', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t);
  const first = validImageRequest(),
    j = await generationCommand(f, first);
  const oldAttempt = (await f.service.snapshot('p1')).attempts[0];
  await f.command(
    'job.cancel',
    { jobId: j.value.id },
    { aggregate: { kind: 'job', id: j.value.id } }
  );
  const next = validImageRequest({ target: { kind: 'shot', id: 'shot2' } }),
    joined = await generationCommand(f, next);
  assert.equal(joined.value.status, 'queued');
  let s = await f.service.snapshot('p1');
  assert.equal(s.attempts.length, 2);
  assert.equal(s.attempts[0].id, oldAttempt.id);
  assert.equal(s.attempts[0].status, 'cancelled_before_dispatch');
  assert.deepEqual(s.attempts[0].request, oldAttempt.request);
  assert.equal(s.attempts[1].request.target.id, 'shot2');
  assert.deepEqual(
    s.attempts[1].request.pins,
    joined.value.subscribers.find((sub) => sub.id === next.subscriberId).pins
  );
  assert.deepEqual(s.attempts[1].request.recipe, next.recipe);
  assert.equal(s.reservations[0].status, 'released');
  assert.equal(s.reservations[1].status, 'reserved');
  assert.equal(s.budget.availableMicros, 900000);
  assert.equal(
    s.jobs[0].subscribers.find((sub) => sub.id === first.subscriberId).status,
    'detached'
  );
  assert.equal(
    s.jobs[0].subscribers.find((sub) => sub.id === next.subscriberId).status,
    'attached'
  );
  const { runWorker } = await import('../src/engine/worker.js');
  await runWorker({ service: f.service, providers: { fake: remote.provider }, drain: true });
  s = await f.service.snapshot('p1');
  assert.equal(remote.requests.length, 1);
  assert.equal(s.attempts[0].status, 'cancelled_before_dispatch');
  assert.equal(s.attempts[1].status, 'succeeded');
  assert.equal(s.jobs[0].status, 'candidate_ready');
});

it('reattaching during an in-flight cancellation exposes the eventual validated result without another HTTP send', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t, { hold: true });
  const first = validImageRequest(),
    j = await generationCommand(f, first);
  const { runWorker, validateAttemptOutputs } = await import('../src/engine/worker.js');
  const work = runWorker({ service: f.service, providers: { fake: remote.provider }, drain: true });
  await until(() => remote.requests.length === 1);
  await f.command(
    'job.cancel',
    { jobId: j.value.id },
    { aggregate: { kind: 'job', id: j.value.id } }
  );
  const next = validImageRequest({ target: { kind: 'shot', id: 'shot2' } }),
    joined = await generationCommand(f, next);
  assert.equal(joined.value.status, 'running');
  assert.equal((await f.service.snapshot('p1')).attempts[0].request.target.id, 'shot');
  remote.responses[0].end(JSON.stringify(result));
  await work;
  let s = await f.service.snapshot('p1');
  assert.equal(s.jobs[0].status, 'candidate_ready');
  await validateAttemptOutputs({
    service: f.service,
    projectId: 'p1',
    attemptId: s.attempts[0].id,
    validate: async ({ outputs }) =>
      outputs.map((o) => ({ blobId: o.blobId, mime: o.mime, mediaKind: 'image' }))
  });
  s = await f.service.snapshot('p1');
  assert.equal(s.jobs[0].status, 'candidate_ready');
  assert.equal(s.candidates.length, 1);
  assert.equal(
    s.jobs[0].subscribers.find((sub) => sub.id === first.subscriberId).status,
    'detached'
  );
  assert.equal(
    s.jobs[0].subscribers.find((sub) => sub.id === next.subscriberId).status,
    'attached'
  );
  assert.equal(s.attempts.length, 1);
  assert.equal(s.reservations.length, 1);
  assert.equal(remote.requests.length, 1);
});

it('cancelled candidate-ready work can be explicitly reused without changing candidate or issuing work', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t),
    j = await generationCommand(f);
  const { runWorker, validateAttemptOutputs } = await import('../src/engine/worker.js');
  await runWorker({ service: f.service, providers: { fake: remote.provider }, drain: true });
  let s = await f.service.snapshot('p1');
  await validateAttemptOutputs({
    service: f.service,
    projectId: 'p1',
    attemptId: s.attempts[0].id,
    validate: async ({ outputs }) =>
      outputs.map((o) => ({ blobId: o.blobId, mime: o.mime, mediaKind: 'image' }))
  });
  const candidate = (await f.service.snapshot('p1')).candidates[0];
  await f.command(
    'job.cancel',
    { jobId: j.value.id },
    { aggregate: { kind: 'job', id: j.value.id } }
  );
  const next = validImageRequest({ target: { kind: 'shot', id: 'shot2' } });
  const reused = await f.command(
    'job.reuse',
    { ...next, jobId: j.value.id },
    { aggregate: { kind: 'generation', id: next.subscriberId } }
  );
  assert.equal(reused.value.status, 'candidate_ready');
  await runWorker({ service: f.service, providers: { fake: remote.provider }, drain: true });
  s = await f.service.snapshot('p1');
  assert.deepEqual(s.candidates, [candidate]);
  assert.equal(s.attempts.length, 1);
  assert.equal(s.reservations.length, 1);
  assert.equal(remote.requests.length, 1);
  assert.equal(s.jobs[0].subscribers[0].status, 'detached');
});

it('reattaching a detached unknown intent reports unknown and preserves held funds without another HTTP send', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t, { hold: true }),
    j = await generationCommand(f);
  const { runWorker } = await import('../src/engine/worker.js');
  const stop = new AbortController(),
    work = runWorker({
      service: f.service,
      providers: { fake: remote.provider },
      signal: stop.signal,
      drain: true
    });
  await until(() => remote.requests.length === 1);
  stop.abort();
  await work;
  await f.command(
    'job.cancel',
    { jobId: j.value.id },
    { aggregate: { kind: 'job', id: j.value.id } }
  );
  const joined = await generationCommand(f);
  assert.equal(joined.value.status, 'outcome_unknown');
  await runWorker({ service: f.service, providers: { fake: remote.provider }, drain: true });
  const s = await f.service.snapshot('p1');
  assert.equal(s.attempts.length, 1);
  assert.equal(s.reservations.length, 1);
  assert.equal(s.reservations[0].status, 'held_unknown');
  assert.equal(s.budget.availableMicros, 900000);
  assert.equal(remote.requests.length, 1);
});

it('reattaching after detached success exposes decoded candidates without dispatching again', async (t) => {
  const f = await withGeneration(t),
    remote = await httpProvider(t, { hold: true }),
    j = await generationCommand(f);
  const { runWorker } = await import('../src/engine/worker.js');
  const work = runWorker({ service: f.service, providers: { fake: remote.provider }, drain: true });
  await until(() => remote.requests.length === 1);
  await f.command(
    'job.cancel',
    { jobId: j.value.id },
    { aggregate: { kind: 'job', id: j.value.id } }
  );
  remote.responses[0].end(JSON.stringify(result));
  await work;
  const before = await f.service.snapshot('p1');
  assert.equal(before.jobs[0].status, 'detached_in_flight');
  const joined = await generationCommand(f);
  assert.equal(joined.value.status, 'candidate_ready');
  await runWorker({ service: f.service, providers: { fake: remote.provider }, drain: true });
  const after = await f.service.snapshot('p1');
  assert.deepEqual(after.attempts, before.attempts);
  assert.equal(after.candidates.length, 1);
  assert.equal(remote.requests.length, 1);
});
