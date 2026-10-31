import assert from 'node:assert/strict';
import { test } from 'node:test';
import { creativeDecision } from '../src/core/creative-decision.js';

const base = () => ({
  topic: 'preparation-depth', kind: 'policy', lane: 'novel', workId: 'w',
  scope: { level: 'work', ref: { kind: 'work', id: 'w' } },
  target: { kind: 'story-profile', id: 'w', revision: 3 },
  authority: 'user', evidence: { userAnswer: '깊게 같이 정하자' },
  value: { depth: 'deep' }, decidedAt: null,
});
const invalid = { code: 'INVALID_CREATIVE_DECISION' };

test('a user decision keeps its exact target, scope and evidence', () => {
  assert.deepEqual(creativeDecision(base()), { schemaVersion: 1, ...base() });
});

test('the record is a copy, so later edits to the owner object do not change it', () => {
  const input = base();
  const record = creativeDecision(input);
  input.evidence.userAnswer = 'changed';
  input.scope.ref.id = 'other';
  assert.equal(record.evidence.userAnswer, '깊게 같이 정하자');
  assert.equal(record.scope.ref.id, 'w');
});

test('authority never exceeds the stored evidence', () => {
  assert.throws(() => creativeDecision({ ...base(), evidence: {} }), invalid);
  assert.throws(() => creativeDecision({ ...base(), evidence: { userAnswer: '  ' } }), invalid);
  assert.throws(() => creativeDecision({ ...base(), authority: 'delegated', evidence: {} }), invalid);
  for (const authority of ['approval', 'legacy', 'unconfirmed']) {
    assert.equal(creativeDecision({ ...base(), authority, evidence: {} }).authority, authority);
  }
  const delegated = creativeDecision({ ...base(), authority: 'delegated', evidence: { delegationScope: 'auto-mode' } });
  assert.equal(delegated.evidence.delegationScope, 'auto-mode');
});

test('only the user can decide for all of their works', () => {
  const personal = { ...base(), workId: null, scope: { level: 'personal', ref: { kind: 'user', id: 'me' } } };
  assert.equal(creativeDecision(personal).scope.level, 'personal');
  for (const authority of ['delegated', 'approval', 'legacy', 'unconfirmed']) {
    assert.throws(() => creativeDecision({ ...personal, authority, evidence: { delegationScope: 'auto-mode' } }), invalid);
  }
});

test('work-bound decisions need a work and an exact target revision', () => {
  assert.throws(() => creativeDecision({ ...base(), workId: null }), invalid);
  for (const revision of [1.5, -1, undefined, { id: 3 }]) {
    assert.throws(() => creativeDecision({ ...base(), target: { kind: 'story-profile', id: 'w', revision } }), invalid);
  }
  const hashed = creativeDecision({ ...base(), target: { kind: 'webtoon-style', id: 'w', revision: 'sha256:abc' } });
  assert.equal(hashed.target.revision, 'sha256:abc');
  const unversioned = creativeDecision({ ...base(), target: { kind: 'story-profile', id: 'w', revision: null } });
  assert.equal(unversioned.target.revision, null);
});

test('unknown vocabulary and malformed scopes are rejected', () => {
  const patches = [
    { kind: 'mood' }, { lane: 'film' }, { authority: 'host' }, { topic: '' },
    { scope: { level: 'chapter', ref: { kind: 'work', id: 'w' } } },
    { scope: { level: 'work', ref: { kind: 'work' } } },
    { scope: { level: 'work', ref: { kind: 'work', id: 'w' }, explicitTargets: ['a', 'a'] } },
    { scope: { level: 'work', ref: { kind: 'work', id: 'w' }, appliesTo: '' } },
    { evidence: ['quote'] }, { decidedAt: 5 }, { decidedAt: 'yesterday' },
    { workId: 5, scope: { level: 'personal', ref: { kind: 'user', id: 'me' } } },
  ];
  for (const patch of patches) {
    assert.throws(() => creativeDecision({ ...base(), ...patch }), invalid, JSON.stringify(patch));
  }
});

test('explicit targets and appliesTo are kept as named', () => {
  const record = creativeDecision({ ...base(), lane: 'webtoon', kind: 'preference',
    scope: { level: 'work', ref: { kind: 'work', id: 'w' }, appliesTo: 'future-scenes', explicitTargets: ['scene-1'] } });
  assert.deepEqual(record.scope, {
    level: 'work', ref: { kind: 'work', id: 'w' }, appliesTo: 'future-scenes', explicitTargets: ['scene-1'],
  });
});

test('a stored user answer of any length is accepted and preserved', () => {
  const userAnswer = '답'.repeat(9000);
  const record = creativeDecision({ ...base(), evidence: { userAnswer } });
  assert.equal(record.evidence.userAnswer, userAnswer);
});

test('a missing input is rejected as an invalid decision', () => {
  assert.throws(() => creativeDecision(null), invalid);
  assert.throws(() => creativeDecision(undefined), invalid);
});

test('extra keys on scope.ref and target are dropped from the record', () => {
  const record = creativeDecision({ ...base(),
    scope: { level: 'work', ref: { kind: 'work', id: 'w', extra: 1 } },
    target: { kind: 'story-profile', id: 'w', revision: 3, extra: 2 } });
  assert.deepEqual(record.scope.ref, { kind: 'work', id: 'w' });
  assert.deepEqual(record.target, { kind: 'story-profile', id: 'w', revision: 3 });
});
