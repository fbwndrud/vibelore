import { png, basePixels } from './helpers/images.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { openStudio } from '../src/engine/index.js';
import { withGeneration, validImageRequest, generationCommand } from './helpers/project.js';

it('atomically joins compatible requests while retaining separate target subscribers', async (t) => {
  const f = await withGeneration(t);
  const second = await openStudio({ directory: f.directory });
  t.after(() => second.close());
  const p = validImageRequest(),
    q = validImageRequest({ target: { kind: 'shot', id: 'shot2' } });
  const [a, b] = await Promise.all([
    generationCommand(f, p),
    second.command({
      projectId: 'p1',
      commandId: 'other',
      aggregate: { kind: 'generation', id: q.subscriberId },
      expectedRevision: 0,
      type: 'generation.request',
      payload: q
    })
  ]);
  assert.equal(a.value.id, b.value.id);
  const s = await f.service.snapshot('p1');
  assert.equal(s.jobs.length, 1);
  assert.equal(s.attempts.length, 1);
  assert.equal(s.reservations.length, 1);
  assert.deepEqual(s.jobs[0].subscribers.map((x) => x.target.id).sort(), ['shot', 'shot2']);
  assert.equal(s.jobs[0].request.pins.find((x) => x.kind === 'scene').revision, 1);
  assert.equal(s.jobs[0].request.sourceBindingRevision, 0);
});
it('fresh engine nonce separates intent without changing actual model input digest or prompt', async (t) => {
  const f = await withGeneration(t);
  for (let i = 0; i < 2; i++)
    await generationCommand(f, validImageRequest({ intent: 'fresh_variation' }));
  const s = await f.service.snapshot('p1');
  assert.equal(s.jobs.length, 2);
  assert.notEqual(s.jobs[0].intentKey, s.jobs[1].intentKey);
  assert.equal(s.jobs[0].generationInputDigest, s.jobs[1].generationInputDigest);
  assert.notEqual(s.jobs[0].variationNonce, s.jobs[1].variationNonce);
  assert.equal(s.attempts[0].request.input.prompt, 'A quiet blue room');
  assert.equal(s.attempts[0].request.input.seed, undefined);
  assert.equal(s.attempts[0].request.input.nonce, undefined);
});
it('never joins across provider account policy authorization or source visibility', async (t) => {
  const f = await withGeneration(t),
    base = validImageRequest();
  await generationCommand(f, base);
  for (const key of Object.keys(base.context))
    await generationCommand(
      f,
      validImageRequest({ context: { ...base.context, [key]: 'different' } })
    );
  assert.equal((await f.service.snapshot('p1')).jobs.length, 5);
});
it('records reserve outbox and command atomically and command replay cannot duplicate work', async (t) => {
  const f = await withGeneration(t),
    p = validImageRequest();
  const a = await generationCommand(f, p, {
    commandId: 'once',
    expectedRevision: 0
  });
  const b = await generationCommand(f, p, {
    commandId: 'once',
    expectedRevision: 0
  });
  assert.equal(b.replayed, true);
  assert.equal(a.value.id, b.value.id);
  const s = await f.service.snapshot('p1');
  assert.equal(s.attempts.length, 1);
  assert.equal(f.service.store.all('SELECT * FROM generation_outbox').length, 1);
  assert.equal(s.budget.reservedEstimateMicros, 100000);
  await assert.rejects(
    generationCommand(
      f,
      { ...p, input: { ...p.input, prompt: 'Different' } },
      { commandId: 'once', expectedRevision: 0 }
    ),
    { code: 'COMMAND_CONFLICT' }
  );
});
it('rejects dangling targets and cancels queued work with a definite release', async (t) => {
  const f = await withGeneration(t);
  await assert.rejects(
    generationCommand(f, validImageRequest({ target: { kind: 'shot', id: 'absent' } })),
    { code: 'INVALID_REFERENCE' }
  );
  const a = await generationCommand(f);
  await f.command(
    'job.cancel',
    { jobId: a.value.id },
    { aggregate: { kind: 'job', id: a.value.id } }
  );
  const s = await f.service.snapshot('p1');
  assert.equal(s.jobs[0].status, 'cancelled_before_dispatch');
  assert.equal(s.reservations[0].status, 'released');
  assert.equal(s.budget.availableMicros, 1000000);
});

it('job reuse requires validated candidates and preserves the separate target subscriber', async (t) => {
  const f = await withGeneration(t),
    a = await generationCommand(f);
  const reuse = validImageRequest({ target: { kind: 'shot', id: 'shot2' } });
  await assert.rejects(
    f.command(
      'job.reuse',
      { jobId: a.value.id, ...reuse },
      { aggregate: { kind: 'generation', id: reuse.subscriberId } }
    ),
    { code: 'CANDIDATE_UNAVAILABLE' }
  );
  const { runWorker, validateAttemptOutputs } = await import('../src/engine/worker.js');
  await runWorker({
    service: f.service,
    providers: {
      fake: {
        capabilities: () => ({ kinds: ['image'], models: ['fake-v1'] }),
        generate: async () => ({
          outputs: [{ bytes: await png(basePixels), mime: 'image/png' }],
          resolvedModel: 'fake-v1'
        })
      }
    },
    drain: true
  });
  const attempt = (await f.service.snapshot('p1')).attempts[0];
  await validateAttemptOutputs({
    service: f.service,
    projectId: 'p1',
    attemptId: attempt.id,
    validate: async ({ outputs }) =>
      outputs.map((o) => ({
        blobId: o.blobId,
        mime: o.mime,
        mediaKind: 'image',
        metadata: { fixtureValidated: true }
      }))
  });
  await f.command(
    'job.reuse',
    { jobId: a.value.id, ...reuse },
    { aggregate: { kind: 'generation', id: reuse.subscriberId } }
  );
  const s = await f.service.snapshot('p1');
  assert.equal(s.jobs[0].subscribers.length, 2);
  assert.equal(s.attempts.length, 1);
  const incompatible = validImageRequest({
    context: { ...reuse.context, authorizationRevision: 'other' }
  });
  await assert.rejects(
    f.command(
      'job.reuse',
      { jobId: a.value.id, ...incompatible },
      { aggregate: { kind: 'generation', id: incompatible.subscriberId } }
    ),
    { code: 'INCOMPATIBLE_REUSE' }
  );
});
it('generation public metadata rejects credential-bearing context and unknown intent fields', async (t) => {
  const f = await withGeneration(t),
    p = validImageRequest();
  await assert.rejects(
    generationCommand(f, {
      ...p,
      context: { ...p.context, apiKey: 'provider-secret' }
    }),
    { code: 'INVALID_INPUT' }
  );
  assert.equal((await f.service.snapshot('p1')).jobs.length, 0);
});
it('cancelling one subscriber leaves compatible subscribers queued and funded', async (t) => {
  const f = await withGeneration(t),
    p = validImageRequest(),
    q = validImageRequest({ target: { kind: 'shot', id: 'shot2' } });
  const j = await generationCommand(f, p);
  await generationCommand(f, q);
  await f.command(
    'job.cancel',
    { jobId: j.value.id, subscriberId: p.subscriberId },
    { aggregate: { kind: 'job', id: j.value.id } }
  );
  const s = await f.service.snapshot('p1');
  assert.equal(s.jobs[0].status, 'queued');
  assert.equal(s.reservations[0].status, 'reserved');
  assert.equal(s.jobs[0].subscribers.find((x) => x.id === q.subscriberId).status, 'attached');
});
it('generation rejects malformed config recipes and undeclared raw provider blob fields before reserving', async (t) => {
  const f = await withGeneration(t),
    base = validImageRequest();
  for (const patch of [
    { recipe: true },
    { input: { ...base.input, config: [] } },
    { input: { ...base.input, blobs: [{ bytes: [1] }] } }
  ]) {
    await assert.rejects(generationCommand(f, { ...base, ...patch }), { code: 'INVALID_INPUT' });
  }
  assert.equal((await f.service.snapshot('p1')).reservations.length, 0);
});
it('common background generation targets project or production before any scene exists', async (t) => {
  const { withStudio } = await import('./helpers/project.js');
  const f = await withStudio(t);
  await f.command('production.create', { id: 'main', title: 'Main', sourcePackageId: null });
  for (const target of [
    { kind: 'project', id: 'p1' },
    { kind: 'production', id: 'main' }
  ])
    await generationCommand(f, validImageRequest({ target }));
  const s = await f.service.snapshot('p1');
  assert.equal(s.jobs.length, 2);
  assert.equal(s.scenes.length, 0);
  assert.equal(s.jobs[0].request.target.kind, 'project');
  assert.ok(!s.jobs[0].request.pins.some((pin) => pin.kind === 'project'));
  assert.equal(s.jobs[1].request.sourcePackageId, null);
  await assert.rejects(
    generationCommand(f, validImageRequest({ target: { kind: 'project', id: 'other' } })),
    { code: 'INVALID_REFERENCE' }
  );
});
it('cast generation before scenes pins its identity definition and declared state while asset-only provenance cannot authorize state', async (t) => {
  const { withStudio } = await import('./helpers/project.js');
  const f = await withStudio(t);
  await f.command(
    'story.save',
    { id: 'story', title: 'Story', text: 'A story', states: [{ id: 'adult' }], revealPolicy: {} },
    { aggregate: { kind: 'story', id: 'story' } }
  );
  await f.command(
    'cast.put',
    {
      id: 'hero',
      name: 'Hero',
      language: 'ko',
      characterId: 'c',
      identity: { id: 'c', origin: { kind: 'studioLocal' } }
    },
    { aggregate: { kind: 'cast', id: 'hero' } }
  );
  await f.command(
    'cast.put',
    { id: 'actor', name: 'Actor', language: 'ko', characterId: 'c' },
    { aggregate: { kind: 'cast', id: 'actor' } }
  );
  await generationCommand(
    f,
    validImageRequest({ target: { kind: 'cast', id: 'actor', stateRef: 'adult' } })
  );
  const s = await f.service.snapshot('p1');
  assert.deepEqual(
    s.jobs[0].request.pins
      .filter((p) => p.kind === 'cast')
      .map((p) => p.id)
      .sort(),
    ['actor', 'hero']
  );
  assert.ok(s.jobs[0].request.pins.some((p) => p.kind === 'story' && p.revision === 1));
  const { makeSourcePackage } = await import('../src/source/source-package.js');
  const pkg = makeSourcePackage({
    sourceKind: 'studio-script',
    sourceRevision: 'v1',
    textUnits: [],
    sceneScopes: [],
    sourceIdentityMap: [],
    sourceStateMap: [{ id: 'child' }],
    revealPolicy: {},
    blobManifest: [],
    preservationStatus: { actualSourceBytes: 'complete' }
  });
  await f.command(
    'source.import',
    { package: pkg, blobs: [] },
    { aggregate: { kind: 'sourcePackage', id: pkg.id } }
  );
  await assert.rejects(
    generationCommand(
      f,
      validImageRequest({
        target: { kind: 'cast', id: 'actor', stateRef: 'child', sourcePackageId: pkg.id }
      })
    ),
    { code: 'INVALID_REFERENCE' }
  );
});
it('cast states keep separate semantic intents even when provider bytes and config match', async (t) => {
  const { withStudio } = await import('./helpers/project.js');
  const f = await withStudio(t);
  await f.command(
    'story.save',
    {
      id: 'story',
      title: 'Story',
      text: 'Text',
      states: [{ id: 'adult' }, { id: 'child' }],
      revealPolicy: {}
    },
    { aggregate: { kind: 'story', id: 'story' } }
  );
  await f.command(
    'cast.put',
    { id: 'role', name: 'Role', language: 'ko', characterId: null },
    { aggregate: { kind: 'cast', id: 'role' } }
  );
  for (const stateRef of ['adult', 'child'])
    await generationCommand(
      f,
      validImageRequest({ target: { kind: 'cast', id: 'role', stateRef } })
    );
  const s = await f.service.snapshot('p1');
  assert.equal(s.jobs.length, 2);
  assert.equal(s.jobs[0].generationInputDigest, s.jobs[1].generationInputDigest);
});

it('administrative project commands do not stale a queued project-scope generation', async (t) => {
  const { withStudio } = await import('./helpers/project.js');
  const { checkPinnedRequest } = await import('../src/engine/asset-slots.js');
  const f = await withStudio(t);
  await generationCommand(f, validImageRequest({ target: { kind: 'project', id: 'p1' } }));
  await f.command('project.budget.set', { budgetMicros: 2000000 });
  await f.command('project.backup', {});
  const job = (await f.service.snapshot('p1')).jobs[0];
  f.service.store.write(() => checkPinnedRequest(f.service.store, 'p1', job.request));
});
