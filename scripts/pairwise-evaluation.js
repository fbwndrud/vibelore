import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJsonCompletion } from '../engine/src/core/json-completion.js';
import { publishedProse } from '../engine/src/core/length-measure.js';
import { parseDocument } from '../src/md/frontmatter.js';

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

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function readChapterSet(dir) {
  let root = null;
  let chapterDir = dir;
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error('not a directory');
    const nested = join(dir, 'chapters');
    if (await stat(nested).then(info => info.isDirectory(), () => false)) {
      root = dir;
      chapterDir = nested;
    }
  } catch {
    throw fail('INPUT_UNREADABLE', `Cannot read chapter input: ${dir}`);
  }
  let names;
  try {
    names = await readdir(chapterDir);
  } catch {
    throw fail('INPUT_UNREADABLE', `Cannot read chapter input: ${chapterDir}`);
  }
  const files = names
    .map(name => ({ name, match: /^(\d+)\.md$/.exec(name) }))
    .filter(item => item.match)
    .map(item => ({ name: item.name, number: Number(item.match[1]) }))
    .sort((left, right) => left.number - right.number);
  if (!files.length) throw fail('INPUT_UNREADABLE', `No chapter files (NNN.md) found in: ${chapterDir}`);
  const chapters = new Map();
  for (const { name, number } of files) {
    const path = join(chapterDir, name);
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      throw fail('INPUT_UNREADABLE', `Cannot read chapter file: ${path}`);
    }
    const prose = publishedProse(parseDocument(text).body);
    if (!prose) throw fail('EMPTY_CHAPTER', `Chapter has no published prose: ${path}`);
    chapters.set(number, { path, prose, sha256: createHash('sha256').update(prose).digest('hex') });
  }
  return { dir, root, kind: root ? 'work' : 'folder', chapters };
}

export function parseChapterRange(spec) {
  if (spec === undefined || spec === null || spec === '') return null;
  const invalid = () => fail('INVALID_CHAPTERS', `Invalid chapter range: ${spec}`);
  const result = new Set();
  for (const part of String(spec).split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) throw invalid();
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || end < start) throw invalid();
    for (let chapter = start; chapter <= end; chapter += 1) result.add(chapter);
  }
  return result;
}

export function schedulePairs({ pairs, chapters }) {
  const exchanges = [];
  const identical = [];
  const unpaired = [];
  pairs.forEach((pair, index) => {
    const replicate = index + 1;
    const numbers = [...new Set([...pair.off.keys(), ...pair.on.keys()])]
      .filter(chapter => !chapters || chapters.has(chapter))
      .sort((left, right) => left - right);
    for (const chapter of numbers) {
      const off = pair.off.get(chapter);
      const on = pair.on.get(chapter);
      if (!off || !on) {
        unpaired.push({ replicate, chapter, side: off ? 'off' : 'on' });
      } else if (off.prose === on.prose) {
        identical.push({ replicate, chapter });
      } else {
        exchanges.push({ replicate, chapter, order: 'off-first', a: off.prose, b: on.prose });
        exchanges.push({ replicate, chapter, order: 'on-first', a: on.prose, b: off.prose });
      }
    }
  });
  return { exchanges, identical, unpaired };
}

function countGraphemes(text) {
  let count = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) count += 1;
  return count;
}

export function lengthMetrics({ pairs, exchanges }) {
  const seen = new Set();
  const perChapter = [];
  for (const { replicate, chapter } of exchanges) {
    const key = `${replicate}:${chapter}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pair = pairs[replicate - 1];
    perChapter.push({
      replicate,
      chapter,
      off: countGraphemes(pair.off.get(chapter).prose),
      on: countGraphemes(pair.on.get(chapter).prose),
    });
  }
  const totals = perChapter.reduce((sum, item) => ({ off: sum.off + item.off, on: sum.on + item.on }), { off: 0, on: 0 });
  const ratio = totals.off > 0 ? totals.on / totals.off : null;
  return { perChapter, totals, ratio, longerTextNote: ratio !== null && (ratio < 0.85 || ratio > 1.15) };
}
