import './check-source.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const review = JSON.parse(readFileSync('docs/release-review.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(review.status, 'approved', `RELEASE_ON_HOLD: ${review.reason}`);
assert.equal(review.version, pkg.version, 'Release approval must match the package version.');
for (const path of ['engine/package.json', '.codex-plugin/plugin.json']) {
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, pkg.version, `${path}: release version mismatch`);
}
assert.ok(review.approvedBy?.trim(), 'A named release approver is required.');
assert.ok(review.approvedAt?.trim(), 'A release approval date is required.');
console.log('Recorded release approval checked.');
