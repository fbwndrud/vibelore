import assert from 'node:assert/strict';
import { it } from 'node:test';
import { openStudio } from '../src/engine/index.js';
import { withGeneration, validImageRequest, generationCommand } from './helpers/project.js';

it('twenty concurrent fresh requests on two connections cannot reserve more than ten estimates', async (t) => {
  const f = await withGeneration(t),
    other = await openStudio({ directory: f.directory });
  t.after(() => other.close());
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) => {
      const p = validImageRequest({ intent: 'fresh_variation' });
      return (i % 2 ? other : f.service).command({
        projectId: 'p1',
        commandId: `request${i}`,
        aggregate: { kind: 'generation', id: p.subscriberId },
        expectedRevision: 0,
        type: 'generation.request',
        payload: p
      });
    })
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 10);
  assert.ok(
    results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'BUDGET_EXCEEDED')
  );
  const s = await f.service.snapshot('p1');
  assert.equal(s.jobs.length, 10);
  assert.equal(s.reservations.length, 10);
  assert.equal(s.budget.availableMicros, 0);
  assert.equal(f.service.store.all('SELECT * FROM generation_outbox').length, 10);
  assert.equal(s.aggregates.filter((a) => a.kind === 'generation').length, 10);
});
it('failed reservation rolls back job command and outbox and permits a corrected command', async (t) => {
  const f = await withGeneration(t),
    p = validImageRequest({ estimateMicros: 1000001 });
  await assert.rejects(generationCommand(f, p, { commandId: 'over', expectedRevision: 0 }), {
    code: 'BUDGET_EXCEEDED'
  });
  let s = await f.service.snapshot('p1');
  assert.equal(s.jobs.length, 0);
  assert.equal(s.reservations.length, 0);
  assert.equal(f.service.store.command('p1', 'over'), undefined);
  await generationCommand(
    f,
    { ...p, estimateMicros: 100000 },
    { commandId: 'over', expectedRevision: 0 }
  );
  s = await f.service.snapshot('p1');
  assert.equal(s.jobs.length, 1);
});

it('unknown holds never expire and billing decisions distinguish verified actual from conservative estimates', async (t) => {
  const f = await withGeneration(t);
  await generationCommand(f);
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
  let s = await f.service.snapshot('p1'),
    a = s.attempts[0];
  f.service.store.write(() => f.service.store.run('UPDATE generation_workers SET lease_until=0'));
  const other = await openStudio({ directory: f.directory });
  t.after(() => other.close());
  assert.equal((await other.snapshot('p1')).budget.availableMicros, 900000);
  await f.command(
    'attempt.reconcile',
    {
      attemptId: a.id,
      action: 'billing',
      evidence: {
        kind: 'conservative_charge',
        amountMicros: 100000,
        reference: 'user-decision',
        actor: 'user'
      }
    },
    { aggregate: { kind: 'attempt', id: a.id } }
  );
  s = await f.service.snapshot('p1');
  assert.equal(s.budget.settledConservativeMicros, 100000);
  assert.equal(s.budget.settledActualMicros, 0);
  assert.equal(s.attempts[0].status, 'outcome_unknown');
  await f.command(
    'attempt.reconcile',
    {
      attemptId: a.id,
      action: 'billing',
      evidence: {
        kind: 'verified_actual',
        amountMicros: 80000,
        reference: 'invoice-line1',
        actor: 'user'
      }
    },
    { aggregate: { kind: 'attempt', id: a.id } }
  );
  s = await f.service.snapshot('p1');
  assert.equal(s.budget.availableMicros, 920000);
  assert.equal(s.budget.settledActualMicros, 80000);
  assert.equal(s.attempts[0].reconciliations.length, 2);
});
it('retry budget failure preserves the original unknown attempt and reservation', async (t) => {
  const f = await withGeneration(t);
  const j = await generationCommand(f, validImageRequest({ estimateMicros: 1000000 }));
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
  await assert.rejects(
    f.command(
      'attempt.retry',
      { attemptId: a.id, acceptDuplicateChargeRisk: true, estimateMicros: 1 },
      { aggregate: { kind: 'job', id: j.value.id } }
    ),
    { code: 'BUDGET_EXCEEDED' }
  );
  const s = await f.service.snapshot('p1');
  assert.equal(s.attempts.length, 1);
  assert.equal(s.reservations.length, 1);
  assert.equal(s.budget.availableMicros, 0);
});

it('reattachment after unsent cancellation rolls back when its new reservation exceeds remaining funds', async (t) => {
  const f = await withGeneration(t),
    first = validImageRequest(),
    j = await generationCommand(f, first);
  await f.command(
    'job.cancel',
    { jobId: j.value.id },
    { aggregate: { kind: 'job', id: j.value.id } }
  );
  const rejected = validImageRequest({ estimateMicros: 1000001 });
  await assert.rejects(generationCommand(f, rejected), { code: 'BUDGET_EXCEEDED' });
  const s = await f.service.snapshot('p1');
  assert.equal(s.jobs[0].status, 'cancelled_before_dispatch');
  assert.equal(s.jobs[0].subscribers.length, 1);
  assert.equal(s.jobs[0].subscribers[0].status, 'detached');
  assert.equal(s.attempts.length, 1);
  assert.equal(s.reservations.length, 1);
  assert.equal(s.reservations[0].status, 'released');
  assert.equal(s.budget.availableMicros, 1000000);
  assert.equal(f.service.store.all('SELECT * FROM generation_outbox').length, 1);
  assert.equal(
    s.aggregates.some((a) => a.kind === 'generation' && a.id === rejected.subscriberId),
    false
  );
});
