import test from 'node:test';
import assert from 'node:assert/strict';
import { stripPrivateFields, isPrivatePortableKey } from '../src/engine/portable.js';
import { portable } from '../src/library/projection.js';
import { renderFailure } from '../src/render/errors.js';
import { startupFailure } from '../src/transport/common.js';

const privateFields = ['filePath', 'sourceFingerprint', 'apiKey', 'api_key', 'key',
  'cookie', 'token', 'access_token', 'sessionId', 'fetchURI', 'fetch-url', 'locator'];
test('source redaction and Library validation use the same recursive private field policy', () => {
  for (const key of privateFields) {
    assert.equal(isPrivatePortableKey(key), true);
    const input = {items: [{literal: 'keep https://example.test/citation and /private prose', [key]: 'connection-secret'}]};
    const expected = {items: [{literal: input.items[0].literal}]};
    assert.deepEqual(stripPrivateFields(input), expected);
    assert.throws(() => portable(input), {code: 'INVALID_INPUT'});
    assert.deepEqual(portable(expected), expected);
  }
  // Only the projection's root observation cursor may use the token field.
  assert.deepEqual(portable({token: 'observation-cursor'}), {token: 'observation-cursor'});
  assert.throws(() => portable({nested: {token: 'credential'}}), {code: 'INVALID_INPUT'});
  let reads = 0;
  const input = {get filePath() {reads++; return 'private';}};
  assert.throws(() => stripPrivateFields(input), {code: 'INVALID_INPUT'});
  assert.equal(reads, 0);
});
test('render and startup diagnostics never retain arbitrary codes, stderr or nested secrets', () => {
  for (const [error, reason] of [
    [new Error('private', {cause: new Error('delayRender timed out at /private?key=secret')}), 'timeout'],
    [new Error('Chrome page crashed with secret'), 'browser'],
    [Object.assign(new Error('private'), {code: 'ENOSPC'}), 'storage'],
    [Object.assign(new Error('private'), {code: 'private-secret-code'}), 'unknown'],
  ]) {
    const output = renderFailure(error, 'renderer');
    assert.equal(output.failure.reason, reason);
    assert.equal(output.errorCode, 'RENDER_FAILED');
    assert.doesNotMatch(JSON.stringify(output), /private|secret/);
    assert.doesNotMatch(startupFailure(error), /private|secret/);
  }
});
