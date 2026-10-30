import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profileDecisions, webtoonStyleDecision } from '../src/core/decision-projections.js';

const byTopic = list => Object.fromEntries(list.map(d => [d.topic, d]));

test('an approved profile reports preparation, world scope and approval with their real authority', () => {
  const profile = { status: 'active', revision: 4, approvedAt: '2026-10-28T01:00:00.000Z',
    discovery: { depth: 'deep', focus: ['인물'], authority: 'user', userAnswer: '인물은 깊게 같이 정하자' },
    worldbuilding: { scope: 'starter', focus: [], authority: 'approval', userAnswer: null } };
  const d = byTopic(profileDecisions(profile, 'w'));
  assert.deepEqual(Object.keys(d).sort(), ['preparation-depth', 'story-profile', 'worldbuilding-scope']);
  assert.equal(d['preparation-depth'].authority, 'user');
  assert.equal(d['preparation-depth'].evidence.userAnswer, '인물은 깊게 같이 정하자');
  assert.deepEqual(d['preparation-depth'].value, { depth: 'deep', focus: ['인물'] });
  assert.equal(d['worldbuilding-scope'].authority, 'approval');
  assert.deepEqual(d['worldbuilding-scope'].evidence, {});
  assert.equal(d['story-profile'].authority, 'approval');
  assert.equal(d['story-profile'].decidedAt, '2026-10-28T01:00:00.000Z');
  for (const decision of Object.values(d)) {
    assert.deepEqual(decision.target, { kind: 'story-profile', id: 'w', revision: 4 });
    assert.deepEqual(decision.scope, { level: 'work', ref: { kind: 'work', id: 'w' } });
    assert.equal(decision.lane, 'novel');
  }
});

test('a stored user claim without the answer is reported as legacy, not as a user decision', () => {
  const d = byTopic(profileDecisions({ status: 'active', worldbuilding: { scope: 'story', authority: 'user' } }, 'book'));
  assert.equal(d['worldbuilding-scope'].authority, 'legacy');
  assert.deepEqual(d['worldbuilding-scope'].evidence, {});
  assert.equal(d['worldbuilding-scope'].target.revision, null);
  const unknown = byTopic(profileDecisions({ discovery: { depth: 'quick', authority: 'whoever' } }, 'book'));
  assert.equal(unknown['preparation-depth'].authority, 'legacy');
});

test('auto mode is reported as a delegation and a pending profile has no approval', () => {
  const d = byTopic(profileDecisions({ status: 'pending', revision: 1,
    discovery: { depth: 'quick', focus: [], authority: 'delegated', userAnswer: null },
    worldbuilding: { scope: 'starter', focus: [], authority: 'unconfirmed', userAnswer: null } }, 'w'));
  assert.equal(d['story-profile'], undefined);
  assert.equal(d['preparation-depth'].authority, 'delegated');
  assert.deepEqual(d['preparation-depth'].evidence, { delegationScope: 'auto-mode' });
  assert.equal(d['worldbuilding-scope'].authority, 'unconfirmed');
});

test('missing profiles and owner records produce no decisions', () => {
  assert.deepEqual(profileDecisions(null, 'w'), []);
  assert.deepEqual(profileDecisions({ status: 'pending' }, 'w'), []);
});

const style = adoption => ({ schemaVersion: 1, kind: 'webtoon-style', workId: 'w', proposalId: 'p1',
  revisionId: 'sha256:abc', ...(adoption ? { adoption } : {}) });

test('a user-adopted style reaches future scenes and only the scenes the user named', () => {
  const d = webtoonStyleDecision(style({ feedback: '이 그림으로 해 줘.', authority: 'user', applyTo: 'future-scenes',
    applyToWorkflows: ['scene-2'], adoptedAt: '2026-10-28T02:00:00.000Z' }));
  assert.equal(d.authority, 'user');
  assert.deepEqual(d.evidence, { userAnswer: '이 그림으로 해 줘.' });
  assert.deepEqual(d.scope, { level: 'work', ref: { kind: 'work', id: 'w' }, appliesTo: 'future-scenes', explicitTargets: ['scene-2'] });
  assert.deepEqual(d.target, { kind: 'webtoon-style', id: 'w', revision: 'sha256:abc' });
  assert.equal(d.lane, 'webtoon');
  assert.deepEqual(d.value, { proposalId: 'p1' });
  assert.equal(d.decidedAt, '2026-10-28T02:00:00.000Z');
});

test('a delegated style keeps the delegation scope and the host choice apart from the user answer', () => {
  const d = webtoonStyleDecision(style({ feedback: '알아서 해줘.', authority: 'delegated',
    delegation: { scope: 'style', userAnswer: '알아서 해줘.', apiPolicy: 'existing-only' },
    choice: { inspectedImage: true, imageHash: 'sha256:img', rationale: 'Fits the source mood.' },
    applyTo: 'future-scenes', applyToWorkflows: [] }));
  assert.equal(d.authority, 'delegated');
  assert.deepEqual(d.evidence, {
    delegationScope: 'style', userAnswer: '알아서 해줘.', choiceRationale: 'Fits the source mood.', inspectedImageHash: 'sha256:img',
  });
});

test('style records without adoption evidence are legacy and absent styles have no decision', () => {
  assert.equal(webtoonStyleDecision(style(null)).authority, 'legacy');
  assert.equal(webtoonStyleDecision(style({ authority: 'user', feedback: '' })).authority, 'legacy');
  assert.equal(webtoonStyleDecision(style({ authority: 'delegated', feedback: 'x' })).authority, 'legacy');
  assert.equal(webtoonStyleDecision(null), null);
});

test('unreadable stored timestamps become null instead of failing a status read', () => {
  const [approval] = profileDecisions({ status: 'active', approvedAt: 'not a date' }, 'w');
  assert.equal(approval.decidedAt, null);
  assert.equal(webtoonStyleDecision(style({ authority: 'user', feedback: 'ok', adoptedAt: 'garbage' })).decidedAt, null);
});

test('an approval names the profile revision only when the approval can be tied to it', () => {
  const edited = byTopic(profileDecisions({ status: 'active', revision: 5, approvedAt: '2026-10-28T01:00:00.000Z',
    updatedAt: '2026-10-28T03:00:00.000Z',
    discovery: { depth: 'deep', focus: [], authority: 'user', userAnswer: '더 깊게' } }, 'w'));
  assert.equal(edited['story-profile'].target.revision, null);
  assert.equal(edited['preparation-depth'].target.revision, 5);
  const settled = byTopic(profileDecisions({ status: 'active', revision: 5, approvedAt: '2026-10-28T03:00:00.000Z',
    updatedAt: '2026-10-28T01:00:00.000Z' }, 'w'));
  assert.equal(settled['story-profile'].target.revision, 5);
  const noUpdate = byTopic(profileDecisions({ status: 'active', revision: 5, approvedAt: '2026-10-28T03:00:00.000Z' }, 'w'));
  assert.equal(noUpdate['story-profile'].target.revision, 5);
  const noApproval = byTopic(profileDecisions({ status: 'active', revision: 5 }, 'w'));
  assert.equal(noApproval['story-profile'].target.revision, null);
  const badUpdate = byTopic(profileDecisions({ status: 'active', revision: 5, approvedAt: '2026-10-28T03:00:00.000Z', updatedAt: 'junk' }, 'w'));
  assert.equal(badUpdate['story-profile'].target.revision, null);
});

test('a rejected profile has no approval record', () => {
  assert.equal(byTopic(profileDecisions({ status: 'rejected', revision: 2, approvedAt: '2026-10-28T01:00:00.000Z' }, 'w'))['story-profile'], undefined);
});

test('damaged profile data never makes a status read throw', () => {
  for (const revision of [-1, 1.5, '3', NaN]) {
    const [approval] = profileDecisions({ status: 'active', revision }, 'w');
    assert.equal(approval.target.revision, null);
  }
  for (const workId of [undefined, null, '', '   ', 7, {}, 'x'.repeat(201)]) {
    assert.deepEqual(profileDecisions({ status: 'active', discovery: { depth: 'quick', authority: 'user', userAnswer: 'a' } }, workId), []);
  }
  const d = byTopic(profileDecisions({ discovery: { depth: 'quick', focus: 'not a list', authority: 'user', userAnswer: 'a' },
    worldbuilding: { scope: 'story', focus: { a: 1 }, authority: 'approval' } }, 'w'));
  assert.deepEqual(d['preparation-depth'].value, { depth: 'quick', focus: [] });
  assert.deepEqual(d['worldbuilding-scope'].value, { scope: 'story', focus: [] });
});

test('damaged style data never makes a status read throw', () => {
  const adopted = { feedback: 'ok', authority: 'user' };
  for (const workId of [undefined, null, '', '  ', 7, 'x'.repeat(201)]) {
    assert.equal(webtoonStyleDecision({ ...style(adopted), workId }), null);
  }
  for (const revisionId of [undefined, null, '', '  ', 7, {}, 'x'.repeat(201)]) {
    assert.equal(webtoonStyleDecision({ ...style(adopted), revisionId }).target.revision, null);
  }
  for (const applyTo of [undefined, null, '', '  ', 7, 'x'.repeat(81)]) {
    assert.equal(webtoonStyleDecision(style({ ...adopted, applyTo })).scope.appliesTo, 'future-scenes');
  }
  for (const applyToWorkflows of [undefined, null, 'scene-1', { a: 1 }]) {
    assert.deepEqual(webtoonStyleDecision(style({ ...adopted, applyToWorkflows })).scope.explicitTargets, []);
  }
  const dirty = webtoonStyleDecision(style({ ...adopted, applyToWorkflows: ['a', 'a', '', '  ', 7, null, 'b', 'x'.repeat(201)] }));
  assert.deepEqual(dirty.scope.explicitTargets, ['a', 'b']);
  const many = webtoonStyleDecision(style({ ...adopted, applyToWorkflows: Array.from({ length: 150 }, (_, i) => `s${i}`) }));
  assert.equal(many.scope.explicitTargets.length, 100);
});

test('only a style or production delegation counts as delegating the style choice', () => {
  const delegated = delegation => webtoonStyleDecision(style({ authority: 'delegated', feedback: '알아서', delegation }));
  assert.equal(delegated({ scope: 'style' }).authority, 'delegated');
  assert.equal(delegated({ scope: 'production' }).authority, 'delegated');
  assert.equal(delegated({ scope: 'preview' }).authority, 'legacy');
  assert.equal(delegated(undefined).authority, 'legacy');
  assert.deepEqual(delegated({ scope: 'preview' }).evidence, {});
});

test('a delegated style prefers the delegation answer and omits choice fields when no choice was recorded', () => {
  const d = webtoonStyleDecision(style({ authority: 'delegated', feedback: '피드백', delegation: { scope: 'style', userAnswer: '위임 답' } }));
  assert.deepEqual(d.evidence, { delegationScope: 'style', userAnswer: '위임 답' });
  const fallback = webtoonStyleDecision(style({ authority: 'delegated', feedback: '피드백', delegation: { scope: 'style' } }));
  assert.deepEqual(fallback.evidence, { delegationScope: 'style', userAnswer: '피드백' });
  const bare = webtoonStyleDecision(style({ authority: 'delegated', delegation: { scope: 'production' } }));
  assert.deepEqual(bare.evidence, { delegationScope: 'production' });
  assert.equal('choiceRationale' in bare.evidence, false);
  assert.equal('inspectedImageHash' in bare.evidence, false);
});
