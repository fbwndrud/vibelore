import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createReviewAudit } from '../src/core/review-audit.js';
import { createHostRelay } from '../src/provider/host-relay.js';

const request = { step: 'editorial-quality', model: { provider: 'host', modelId: 'host-agent' }, jsonMode: true, messages: [{ role: 'user', content: '본문' }] };
const run = (review) => review.run('editorial-quality', async (provider) => JSON.parse((await provider.complete(request)).text), { score: null });
const audit = (providers, options = {}) => createReviewAudit({ providers, prose: '본문', chapter: 1, contractDigest: 'contract1', saveExchange: async () => 'exchange', ...options });

it('does not approve a response when review postprocessing throws', async () => {
  const review = audit({ complete: async () => ({ text: '{"score":87,"findings":[]}' }) });
  await review.run('editorial-quality', async (provider) => {
    await provider.complete(request);
    throw new Error('postprocessing failed');
  }, { score: null });
  assert.equal(review.result().status, 'failed');
  assert.equal(review.result().records[0].failure, 'REVIEW_EXECUTION_FAILED');
});

it('does not approve a response when saving its evidence fails', async () => {
  const review = audit({ complete: async () => ({ text: '{"score":87,"findings":[]}' }) }, { saveExchange: async () => { throw new Error('storage unavailable'); } });
  await run(review);
  assert.equal(review.result().status, 'failed');
  assert.equal(review.result().records.length, 1);
});

it('treats timeout as failed review, retaining the request binding', async () => {
  const review = audit({ complete: () => new Promise(() => {}) }, { timeoutMs: 5 });
  assert.equal((await run(review)).score, null);
  assert.equal(review.result().status, 'failed');
  assert.equal(review.result().records[0].failure, 'REVIEW_TIMEOUT');
  assert.ok(review.result().records[0].requestId);
});

it('requires a new relay answer after either prose or contract changes', async () => {
  const original = createHostRelay();
  await run(audit(original));
  const pending = original.pending[0];
  assert.ok(pending);
  const answers = { [pending.id]: '{"score":87,"findings":[]}' };
  const same = audit(createHostRelay(answers));
  assert.equal((await run(same)).score, 87);
  assert.equal(same.result().status, 'completed');
  assert.equal(same.result().records[0].evaluator.contextIsolation, 'unverified');
  for (const changed of [{ prose: '바뀐 본문' }, { contractDigest: 'contract2' }]) {
    const relay = createHostRelay(answers);
    await run(audit(relay, changed));
    assert.equal(relay.pending.length, 1);
    assert.notEqual(relay.pending[0].id, pending.id);
  }
});

for (const text of ['{}', 'null', '[]', '{"score":101,"findings":[]}', '{"score":90,"findings":{}}', '{"score":"90","findings":[]}']) {
  it(`does not accept malformed review ${text}`, async () => {
    const review = audit({ complete: async () => ({ text }) });
    await run(review);
    assert.equal(review.result().status, 'failed');
  });
}

it('a review the user turned off is not requested and is recorded as disabled, not failed', async () => {
  let called = 0;
  const reviews = audit({ async complete() { called += 1; return { text: JSON.stringify({ score: 80, findings: [] }) }; } }, { disabled: ['editorial-quality'] });
  const result = await reviews.run('editorial-quality', async (provider) => { await provider.complete(request); return { score: 80 }; }, { score: null, fallback: true });
  assert.equal(called, 0);
  assert.equal(result.fallback, true);
  await reviews.run('coherence-judge', (provider) => provider.complete({ ...request, step: 'coherence-judge' }).then(() => ({ score: 80 })), { score: null });
  const summary = reviews.result();
  assert.equal(summary.status, 'completed', JSON.stringify(summary.records));
  assert.deepEqual(summary.disabled, ['editorial-quality']);
  assert.equal(summary.records.find((r) => r.step === 'editorial-quality').status, 'disabled_by_user');
});
