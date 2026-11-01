import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DIMENSIONS, PROTOCOL_VERSION, aggregate, combineOrders, mapToSides, parseVerdict, signTestP,
} from '../scripts/pairwise-evaluation.js';

test('constants name the protocol and the four dimensions', () => {
  assert.equal(PROTOCOL_VERSION, 'pairwise-v1');
  assert.deepEqual(DIMENSIONS, ['plot', 'creativity', 'development', 'language']);
});

test('parseVerdict reads a fenced reply and marks bad dimensions invalid', () => {
  const fenced = '```json\n{"plot":"A","creativity":"B","development":"tie","language":"A"}\n```';
  assert.deepEqual(parseVerdict(fenced), { plot: 'A', creativity: 'B', development: 'tie', language: 'A' });
  assert.deepEqual(parseVerdict('{"plot":"A","creativity":"B","development":"tie"}'),
    { plot: 'A', creativity: 'B', development: 'tie', language: 'invalid' });
  assert.equal(parseVerdict('{"plot":"C","creativity":"B","development":"B","language":"A"}').plot, 'invalid');
  assert.equal(parseVerdict('{"plot":"a","creativity":"B","development":"B","language":"A"}').plot, 'invalid');
  assert.deepEqual(parseVerdict('not json at all'),
    { plot: 'invalid', creativity: 'invalid', development: 'invalid', language: 'invalid' });
});

test('mapToSides translates letters by presentation order', () => {
  const verdict = { plot: 'A', creativity: 'B', development: 'tie', language: 'invalid' };
  assert.equal(mapToSides(verdict, 'off-first').plot, 'off');
  assert.equal(mapToSides(verdict, 'on-first').plot, 'on');
  assert.equal(mapToSides(verdict, 'off-first').creativity, 'on');
  assert.equal(mapToSides(verdict, 'on-first').creativity, 'off');
  assert.equal(mapToSides(verdict, 'off-first').development, 'tie');
  assert.equal(mapToSides(verdict, 'on-first').language, 'invalid');
});

test('combineOrders merges the two presentation orders', () => {
  const table = [
    ['on', 'on', 'on'], ['on', 'tie', 'on'], ['tie', 'on', 'on'], ['tie', 'tie', 'tie'],
    ['tie', 'off', 'off'], ['off', 'tie', 'off'], ['off', 'off', 'off'],
    ['on', 'off', 'conflict'], ['off', 'on', 'conflict'],
  ];
  for (const [v1, v2, outcome] of table) assert.equal(combineOrders(v1, v2).outcome, outcome, `${v1},${v2}`);
  assert.deepEqual(combineOrders('on', 'invalid'), { outcome: 'invalid', score: null });
  assert.equal(combineOrders('on', 'tie').score, 0.75);
  assert.equal(combineOrders('on', 'off').score, 0.5);
});

test('signTestP is a two-sided exact binomial test', () => {
  assert.equal(signTestP(5, 0), 0.0625);
  assert.equal(signTestP(0, 0), 1);
  assert.equal(signTestP(3, 3), 1);
  assert.equal(signTestP(4, 1), 0.375);
});

test('aggregate counts outcomes and position bias per dimension', () => {
  const pairs = [
    { plot: { outcome: 'on', score: 1, letters: ['A', 'B'] } },
    { plot: { outcome: 'off', score: 0, letters: ['B', 'B'] } },
    { plot: { outcome: 'tie', score: 0.5, letters: ['tie', 'tie'] } },
    { plot: { outcome: 'conflict', score: 0.5, letters: ['A', 'A'] } },
    { plot: { outcome: 'invalid', score: null, letters: ['invalid', 'invalid'] } },
  ];
  assert.deepEqual(aggregate(pairs).plot, {
    n: 4, onWins: 1, offWins: 1, ties: 1, conflicts: 1, invalid: 1,
    onPreference: 0.5, signTestP: 1, firstPositionRate: 0.5,
  });
  const ties = aggregate([
    { plot: { outcome: 'tie', score: 0.5, letters: ['tie', 'tie'] } },
    { plot: { outcome: 'tie', score: 0.5, letters: ['tie', 'tie'] } },
  ]).plot;
  assert.equal(ties.signTestP, 1);
  assert.equal(ties.firstPositionRate, null);
  const empty = aggregate([{ plot: { outcome: 'invalid', score: null, letters: ['invalid', 'invalid'] } }]).plot;
  assert.equal(empty.onPreference, null);
});
