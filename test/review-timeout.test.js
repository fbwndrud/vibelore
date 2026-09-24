import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewTimeoutMs } from '../src/core/review-audit.js';

test('review timeout defaults to 45 seconds', () => {
  assert.equal(reviewTimeoutMs({}), 45000);
});

test('VIBELORE_REVIEW_TIMEOUT_MS raises the review timeout for slower API providers', () => {
  assert.equal(reviewTimeoutMs({ VIBELORE_REVIEW_TIMEOUT_MS: '180000' }), 180000);
});

test('an unusable review timeout value keeps the default', () => {
  assert.equal(reviewTimeoutMs({ VIBELORE_REVIEW_TIMEOUT_MS: 'soon' }), 45000);
  assert.equal(reviewTimeoutMs({ VIBELORE_REVIEW_TIMEOUT_MS: '0' }), 45000);
  assert.equal(reviewTimeoutMs({ VIBELORE_REVIEW_TIMEOUT_MS: '-5' }), 45000);
});
