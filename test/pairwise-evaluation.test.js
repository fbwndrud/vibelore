import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DIMENSIONS, PROTOCOL_VERSION, aggregate, combineOrders, lengthMetrics, mapToSides, parseChapterRange,
  parseVerdict, readChapterSet, schedulePairs, signTestP,
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

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'pairwise-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function chapterMap(entries) {
  return new Map(entries.map(([number, prose]) => [number, { path: `${number}.md`, prose, sha256: `sha-${prose}` }]));
}

test('readChapterSet reads a work root and drops frontmatter and stray files', async () => {
  await withTempDir(async dir => {
    await mkdir(join(dir, 'chapters'));
    await writeFile(join(dir, 'chapters', '001.md'), '---\ntitle: One\n---\n\nFirst chapter prose.\n');
    await writeFile(join(dir, 'chapters', 'draft.md'), 'not a chapter');
    await writeFile(join(dir, 'notes.txt'), 'stray');
    const set = await readChapterSet(dir);
    assert.equal(set.kind, 'work');
    assert.equal(set.root, dir);
    assert.deepEqual([...set.chapters.keys()], [1]);
    assert.equal(set.chapters.get(1).prose, 'First chapter prose.');
    assert.match(set.chapters.get(1).sha256, /^[0-9a-f]{64}$/);
    assert.equal(set.chapters.get(1).path, join(dir, 'chapters', '001.md'));
  });
});

test('readChapterSet reads a flat folder', async () => {
  await withTempDir(async dir => {
    await writeFile(join(dir, '006.md'), 'Six.');
    await writeFile(join(dir, '005.md'), 'Five.');
    const set = await readChapterSet(dir);
    assert.equal(set.kind, 'folder');
    assert.equal(set.root, null);
    assert.deepEqual([...set.chapters.keys()], [5, 6]);
  });
});

test('readChapterSet rejects unreadable input and empty chapters', async () => {
  await withTempDir(async dir => {
    const missing = join(dir, 'missing');
    await assert.rejects(readChapterSet(missing), error => error.code === 'INPUT_UNREADABLE' && error.message.includes(missing));
    await writeFile(join(dir, 'notes.txt'), 'x');
    await assert.rejects(readChapterSet(dir), error => error.code === 'INPUT_UNREADABLE' && error.message.includes(dir));
    await writeFile(join(dir, '003.md'), '---\ntitle: T\n---\n \n\t\n');
    await assert.rejects(readChapterSet(dir), error => error.code === 'EMPTY_CHAPTER' && error.message.includes('003.md'));
  });
});

test('parseChapterRange parses lists and ranges', () => {
  assert.equal(parseChapterRange(undefined), null);
  assert.equal(parseChapterRange(''), null);
  assert.deepEqual(parseChapterRange('5-7,9'), new Set([5, 6, 7, 9]));
  assert.deepEqual(parseChapterRange('3'), new Set([3]));
  for (const bad of ['12-5', 'abc', '0', '1,,2', '1-', '-3']) {
    assert.throws(() => parseChapterRange(bad), error => error.code === 'INVALID_CHAPTERS', bad);
  }
});

test('schedulePairs orders both presentations and reports identical and unpaired chapters', () => {
  const pair = {
    off: chapterMap([[1, 'o1'], [2, 'same'], [3, 'off three']]),
    on: chapterMap([[2, 'same'], [3, 'on three'], [4, 'o4']]),
  };
  const plan = schedulePairs({ pairs: [pair], chapters: null });
  assert.deepEqual(plan.identical, [{ replicate: 1, chapter: 2 }]);
  assert.deepEqual(plan.unpaired, [
    { replicate: 1, chapter: 1, side: 'off' },
    { replicate: 1, chapter: 4, side: 'on' },
  ]);
  assert.deepEqual(plan.exchanges, [
    { replicate: 1, chapter: 3, order: 'off-first', a: 'off three', b: 'on three' },
    { replicate: 1, chapter: 3, order: 'on-first', a: 'on three', b: 'off three' },
  ]);
  assert.deepEqual(schedulePairs({ pairs: [pair], chapters: null }), plan);
  const filtered = schedulePairs({ pairs: [pair], chapters: new Set([3]) });
  assert.equal(filtered.exchanges.length, 2);
  assert.deepEqual(filtered.identical, []);
  assert.deepEqual(filtered.unpaired, []);
});

test('schedulePairs numbers replicates by pair position', () => {
  const pair = { off: chapterMap([[1, 'a'], [2, 'b']]), on: chapterMap([[1, 'c'], [2, 'd']]) };
  const plan = schedulePairs({ pairs: [pair, pair], chapters: null });
  assert.deepEqual(plan.exchanges.map(item => [item.replicate, item.chapter, item.order]), [
    [1, 1, 'off-first'], [1, 1, 'on-first'], [1, 2, 'off-first'], [1, 2, 'on-first'],
    [2, 1, 'off-first'], [2, 1, 'on-first'], [2, 2, 'off-first'], [2, 2, 'on-first'],
  ]);
});

test('lengthMetrics counts graphemes of judged chapters and flags a large gap', () => {
  const run = (offText, onText) => {
    const pairs = [{ off: chapterMap([[1, offText], [2, 'same']]), on: chapterMap([[1, onText], [2, 'same']]) }];
    return lengthMetrics({ pairs, exchanges: schedulePairs({ pairs, chapters: null }).exchanges });
  };
  const longer = run('a'.repeat(100), 'b'.repeat(120));
  assert.deepEqual(longer.perChapter, [{ replicate: 1, chapter: 1, off: 100, on: 120 }]);
  assert.deepEqual(longer.totals, { off: 100, on: 120 });
  assert.equal(longer.ratio, 1.2);
  assert.equal(longer.longerTextNote, true);
  const close = run('a'.repeat(100), 'b'.repeat(105));
  assert.equal(close.ratio, 1.05);
  assert.equal(close.longerTextNote, false);
  assert.equal(run('a'.repeat(100), 'b'.repeat(80)).longerTextNote, true);
  const graphemes = run('한글', '가\u0301👨‍👩‍👧');
  assert.deepEqual(graphemes.totals, { off: 2, on: 2 });
  assert.equal(lengthMetrics({ pairs: [], exchanges: [] }).ratio, null);
});
