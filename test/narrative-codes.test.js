import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EPISODE_ROLES, TENSION_ROLES, TWIST_LEVELS, EXPECTATION_HANDLING, HOOK_TYPES, ARC_HOOK_OPS,
  RHYTHM_CADENCE, rhythmModeOf, normalizeEpisodeShape,
} from '../src/core/narrative-codes.js';
import { HOOK_EVENTS } from '../engine/src/continuity/ledger.js';
import * as ko from '../src/prompts/ko.js';
import * as multilingual from '../src/prompts/multilingual.js';

test('tables are deep-frozen and hook ops are ledger events', () => {
  for (const t of [EPISODE_ROLES, TENSION_ROLES, TWIST_LEVELS, EXPECTATION_HANDLING, HOOK_TYPES, ARC_HOOK_OPS, RHYTHM_CADENCE]) assert.ok(Object.isFrozen(t));
  assert.deepEqual(Object.keys(RHYTHM_CADENCE), ['light-webnovel', 'commercial-dramatic', 'deep-world-driven']);
  for (const row of Object.values(RHYTHM_CADENCE)) {
    assert.ok(Object.isFrozen(row));
    for (const n of Object.values(row)) assert.ok(Number.isInteger(n) && n > 0);
    assert.ok(row.unitMin <= row.unitMax);
  }
  assert.deepEqual(RHYTHM_CADENCE['commercial-dramatic'], { unitMin: 3, unitMax: 5, breatherAfterTension: 3 });
  assert.ok(ARC_HOOK_OPS.every((op) => HOOK_EVENTS.includes(op)));
  assert.equal(rhythmModeOf(undefined), 'commercial-dramatic');
  assert.equal(rhythmModeOf('nope'), 'commercial-dramatic');
  assert.equal(rhythmModeOf('deep-world-driven'), 'deep-world-driven');
});

test('normalizeEpisodeShape keeps valid codes and drops everything else', () => {
  assert.deepEqual(normalizeEpisodeShape({}), {});
  assert.deepEqual(normalizeEpisodeShape(undefined), {});
  assert.deepEqual(normalizeEpisodeShape({ role: 'peak', twistLevel: '2', expectationHandling: 'delay', hookType: 'ability', hookOps: [{ op: 'paid', label: ' key ' }] }),
    { role: 'peak', twistLevel: 2, expectationHandling: 'delay', hookType: 'ability', hookOps: [{ op: 'paid', label: 'key' }] });
  assert.equal(normalizeEpisodeShape({ twistLevel: 0 }).twistLevel, 0); // zero is a valid level
  for (const bad of [4, -1, 1.5, '1.5', null, '', true, [], {}, 'x']) assert.equal('twistLevel' in normalizeEpisodeShape({ twistLevel: bad }), false, String(bad));
  assert.deepEqual(normalizeEpisodeShape({ role: 'turn', expectationHandling: 'maybe', hookType: 'cliffhanger', hookOps: 'x' }), {});
  const ops = Array.from({ length: 6 }, (_, i) => ({ op: 'advanced', label: `h${i}` }));
  assert.equal(normalizeEpisodeShape({ hookOps: [{ op: 'plant', label: 'a' }, { op: 'paid', label: '' }, ...ops] }).hookOps.length, 4);
  assert.equal(normalizeEpisodeShape({ hookOps: [{ op: 'paid', label: 'x'.repeat(300) }] }).hookOps[0].label.length, 200);
});

test('pattern-ledger hookType alternatives come from HOOK_TYPES, unchanged in both families', () => {
  for (const user of [ko.steps['pattern-ledger'].user({ prose: 'p' }), multilingual.steps['pattern-ledger'].user({ prose: 'p' })]) {
    assert.ok(user.endsWith(`"hookType":"${HOOK_TYPES.join('|')}"}`) && user.includes('"hookType":"result|reinterpretation|relationship|ability|moral|identity|none"}'));
  }
});
