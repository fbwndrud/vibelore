import { parseJsonCompletion } from '../engine/src/core/json-completion.js';

export const PROTOCOL_VERSION = 'pairwise-v1';
export const DIMENSIONS = ['plot', 'creativity', 'development', 'language'];

const LETTERS = new Set(['A', 'B', 'tie']);
const SCORES = { on: 1, tie: 0.5, off: 0 };

export function parseVerdict(text) {
  const parsed = parseJsonCompletion(text);
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return Object.fromEntries(DIMENSIONS.map(dimension => [dimension, LETTERS.has(source[dimension]) ? source[dimension] : 'invalid']));
}

export function mapToSides(verdict, order) {
  const sides = order === 'on-first' ? { A: 'on', B: 'off' } : { A: 'off', B: 'on' };
  return Object.fromEntries(DIMENSIONS.map(dimension => [dimension, sides[verdict[dimension]] ?? verdict[dimension]]));
}

export function combineOrders(first, second) {
  if (!(first in SCORES) || !(second in SCORES)) return { outcome: 'invalid', score: null };
  const score = (SCORES[first] + SCORES[second]) / 2;
  if (first === second) return { outcome: first, score };
  if (first === 'tie') return { outcome: second, score };
  if (second === 'tie') return { outcome: first, score };
  return { outcome: 'conflict', score };
}

export function signTestP(onWins, offWins) {
  const n = onWins + offWins;
  if (n === 0) return 1;
  const tail = Math.min(onWins, offWins);
  let term = 1;
  let sum = 0;
  for (let i = 0; i <= tail; i += 1) {
    sum += term;
    term = term * (n - i) / (i + 1);
  }
  return Math.min(1, 2 * sum / 2 ** n);
}

export function aggregate(pairs) {
  return Object.fromEntries(DIMENSIONS.map(dimension => {
    const results = pairs.map(pair => pair[dimension] ?? { outcome: 'invalid', score: null, letters: [] });
    const count = outcome => results.filter(result => result.outcome === outcome).length;
    const valid = results.filter(result => result.outcome !== 'invalid');
    const onWins = count('on');
    const offWins = count('off');
    const letters = results.flatMap(result => result.letters ?? []).filter(letter => letter === 'A' || letter === 'B');
    return [dimension, {
      n: valid.length,
      onWins,
      offWins,
      ties: count('tie'),
      conflicts: count('conflict'),
      invalid: count('invalid'),
      onPreference: valid.length ? valid.reduce((total, result) => total + result.score, 0) / valid.length : null,
      signTestP: signTestP(onWins, offWins),
      firstPositionRate: letters.length ? letters.filter(letter => letter === 'A').length / letters.length : null,
    }];
  }));
}
