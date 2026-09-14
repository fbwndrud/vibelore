import './check-source.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const review = JSON.parse(readFileSync('docs/release-review.json', 'utf8'));
assert.equal(review.status, 'approved', `RELEASE_ON_HOLD: ${review.reason}`);
assert.ok(review.approvedBy?.trim(), 'A named release approver is required.');
assert.ok(review.approvedAt?.trim(), 'A release approval date is required.');
console.log('Recorded release approval checked.');
