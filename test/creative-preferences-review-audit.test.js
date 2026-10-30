import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReviewAudit } from '../src/core/review-audit.js';

const audit = () => createReviewAudit({ providers: { complete: async () => ({ text: '{"score":80,"reason":"ok"}' }) }, prose: '본문', chapter: 1,
  contractDigest: 'sha256:x', timeoutMs: 1000, disabled: [], saveExchange: async () => 'ex-1' });
const ask = (reviewProvider) => reviewProvider.complete({ step: 'coherence-judge', model: { provider: 'openai', modelId: 'm' }, messages: [{ role: 'user', content: 'x' }] });

test('a coherence answer without preference verdicts leaves the review incomplete', async () => {
  const reviews = audit();
  await reviews.run('coherence-judge', async (reviewProvider) => {
    await ask(reviewProvider);
    return { score: 80, reason: 'ok', creativePreferences: [], creativePreferencesMissing: true };
  }, null);
  assert.equal(reviews.result().status, 'failed');
});

test('a coherence answer with preference verdicts completes the review', async () => {
  const reviews = audit();
  await reviews.run('coherence-judge', async (reviewProvider) => {
    await ask(reviewProvider);
    return { score: 80, reason: 'ok', creativePreferences: [] };
  }, null);
  assert.equal(reviews.result().status, 'completed');
});
