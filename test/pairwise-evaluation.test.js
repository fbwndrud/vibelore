import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { describe } from 'node:test';
import { deriveRequestFingerprint } from '../engine/src/core/request-fingerprint.js';
import { hostExecutionNote, relayScaffold } from '../src/core/relay-prompt-layout.js';
import {
  DIMENSIONS, JUDGE_DELIMITERS, PROTOCOL_VERSION, REPO_ROOT, aggregate, assertOutPath, buildJudgeRequest,
  buildCaveats, combineOrders, independenceLabel, judgeFamilyFor, ledgerCounts, ledgerMetric, lengthMetrics, mapToSides,
  parseChapterRange, parseCliArgs, parseVerdict, readChapterSet, renderReportMarkdown, runPairwiseEvaluation, schedulePairs, signTestP,
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
  const nested = '{"plot":{"winner":"B","reason":"r"},"creativity":{"winner":"tie"},"development":{"winner":"C"},"language":{"reason":"x"}}';
  assert.deepEqual(parseVerdict(nested), { plot: 'B', creativity: 'tie', development: 'invalid', language: 'invalid' });
  assert.equal(parseVerdict('{"plot":{"winner":"a"},"creativity":["A"],"development":null,"language":"A"}').plot, 'invalid');
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

const PROSE_A = '문이 열리고 낯선 사람이 들어왔다. 그는 아무 말 없이 젖은 외투를 벗었다.';
const PROSE_B = 'The lamp guttered twice before the stranger crossed the threshold and set down his case.';

test('judge system text follows the prompt family and names the four dimensions', () => {
  for (const family of ['ko', 'multilingual']) {
    const system = buildJudgeRequest({ family, a: PROSE_A, b: PROSE_B }).messages[0].content;
    for (const dimension of DIMENSIONS) assert.match(system, new RegExp(`"${dimension}":\\{"winner":"A\\|B\\|tie"`));
    assert.ok(system.includes('tie'));
    assert.ok(system.includes(relayScaffold(family).json));
    assert.ok(system.endsWith(`\n\n${hostExecutionNote(family)}`));
    assert.equal(system.split('\n\n').at(-1), hostExecutionNote(family));
  }
  const ko = buildJudgeRequest({ family: 'ko', a: PROSE_A, b: PROSE_B }).messages[0].content;
  const en = buildJudgeRequest({ family: 'multilingual', a: PROSE_A, b: PROSE_B }).messages[0].content;
  assert.match(ko, /\p{Script=Hangul}/u);
  assert.doesNotMatch(en, /\p{Script=Hangul}/u);
  assert.ok(!ko.includes(en.split('\n\n')[0]));
  assert.match(en, /indistinguishable/);
  assert.match(en, /length/i);
  assert.match(en, /JSON/);
});

test('judge user message wraps only the two versions', () => {
  const request = buildJudgeRequest({ family: 'multilingual', a: PROSE_A, b: PROSE_B });
  const { startA, endA, startB, endB } = JUDGE_DELIMITERS;
  assert.deepEqual(JUDGE_DELIMITERS, {
    startA: '<<<VERSION A>>>', endA: '<<<END VERSION A>>>', startB: '<<<VERSION B>>>', endB: '<<<END VERSION B>>>',
  });
  assert.equal(request.messages[1].role, 'user');
  assert.equal(request.messages[1].content, `${startA}\n${PROSE_A}\n${endA}\n\n${startB}\n${PROSE_B}\n${endB}`);
  assert.doesNotMatch(request.messages[1].content, /\bON\b|\bOFF\b/);
  for (const message of request.messages) assert.doesNotMatch(message.content, /\bON\b|\bOFF\b|chapters\/|\.vibelore|world\/|characters\//);
});

test('judge request is a deterministic host json request without sampling limits', () => {
  const base = { family: 'multilingual', a: PROSE_A, b: PROSE_B };
  const request = buildJudgeRequest(base);
  assert.equal(request.step, 'pairwise-judge');
  assert.equal(request.jsonMode, true);
  assert.deepEqual(request.model, { provider: 'host', modelId: 'host-agent' });
  assert.ok(!('temperature' in request));
  assert.ok(!('maxTokens' in request));
  const fingerprint = deriveRequestFingerprint(request);
  assert.equal(deriveRequestFingerprint(buildJudgeRequest({ ...base })), fingerprint);
  assert.notEqual(deriveRequestFingerprint(buildJudgeRequest({ ...base, a: PROSE_B, b: PROSE_A })), fingerprint);
  assert.notEqual(deriveRequestFingerprint(buildJudgeRequest({ ...base, family: 'ko' })), fingerprint);
});

test('judge request refuses prose that contains its own delimiter', () => {
  for (const [a, b] of [[`x ${JUDGE_DELIMITERS.endA} y`, PROSE_B], [PROSE_A, `x ${JUDGE_DELIMITERS.endA} y`]]) {
    assert.throws(() => buildJudgeRequest({ family: 'ko', a, b }), { code: 'PROSE_DELIMITER_CONFLICT' });
  }
});

test('judgeFamilyFor maps a language tag to a prompt family', () => {
  assert.equal(judgeFamilyFor('ko'), 'ko');
  assert.equal(judgeFamilyFor('en'), 'multilingual');
  assert.equal(judgeFamilyFor('ja'), 'multilingual');
  assert.throws(() => judgeFamilyFor('not a tag!'));
});

const entry = (chapter, extra = {}) => ({ chapter, solutionPattern: 'same trick', ...extra });

test('ledgerCounts flags a repeated pattern only on the third chapter', () => {
  const entries = [entry(1), entry(2), entry(3)];
  const counts = ledgerCounts(entries, [1, 2, 3]);
  assert.equal(counts.totals.PATTERN_REPETITION, 1);
  assert.deepEqual(counts.perChapter.map(item => item.chapter), [1, 2, 3]);
  assert.deepEqual(counts.perChapter.map(item => item.codes.PATTERN_REPETITION ?? 0), [0, 0, 1]);
  assert.deepEqual(counts.missingChapters, []);
});

test('ledgerCounts lists judged chapters that have no entry', () => {
  const counts = ledgerCounts([entry(1), entry(2), entry(3)], new Set([3, 4]));
  assert.deepEqual(counts.missingChapters, [4]);
  assert.deepEqual(counts.perChapter.map(item => item.chapter), [3]);
  assert.equal(counts.totals.PATTERN_REPETITION, 1);
});

test('ledgerCounts does not depend on entry order', () => {
  const sorted = ledgerCounts([entry(1), entry(2), entry(3)], [3]);
  const shuffled = ledgerCounts([entry(3), entry(1), entry(2)], [3]);
  assert.deepEqual(shuffled, sorted);
});

async function snapshotTree(dir, base = dir) {
  const out = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    out.push(path.slice(base.length));
    if (item.isDirectory()) out.push(...await snapshotTree(path, base));
  }
  return out.sort();
}

async function withWorkRoot(sidecars, run) {
  const root = await mkdtemp(join(tmpdir(), 'pairwise-ledger-'));
  try {
    await mkdir(join(root, 'chapters'), { recursive: true });
    if (sidecars) {
      await mkdir(join(root, '.vibelore'), { recursive: true });
      for (const [name, value] of Object.entries(sidecars)) await writeFile(join(root, '.vibelore', name), JSON.stringify(value));
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('ledgerMetric is unavailable without a work root', async () => {
  const metric = await ledgerMetric({ root: null, chapters: [3] });
  assert.equal(metric.status, 'unavailable');
  assert.equal(metric.reason, 'no-root');
  assert.equal(metric.labelSource, 'stored pattern-ledger review of the writing copy');
});

test('ledgerMetric reads a legacy pattern ledger and counts judged chapters', async () => {
  await withWorkRoot({ 'pattern-ledger.json': [entry(1), entry(2), entry(3)] }, async root => {
    const metric = await ledgerMetric({ root, chapters: [3] });
    assert.equal(metric.status, 'available');
    assert.deepEqual(metric.missingChapters, []);
    assert.equal(metric.counts.totals.PATTERN_REPETITION, 1);
  });
});

test('ledgerMetric is incomplete when a judged chapter has no entry', async () => {
  await withWorkRoot({ 'pattern-ledger.json': [entry(1), entry(2), entry(3)] }, async root => {
    const metric = await ledgerMetric({ root, chapters: new Set([3, 4]) });
    assert.equal(metric.status, 'incomplete');
    assert.deepEqual(metric.missingChapters, [4]);
    assert.equal(metric.counts.totals.PATTERN_REPETITION, 1);
  });
});

test('ledgerMetric treats a ledger from another head as stale', async () => {
  const ledger = { schemaVersion: 2, sourceHead: `sha256:${'0'.repeat(64)}`, entries: [entry(1), entry(2), entry(3)] };
  await withWorkRoot({ 'experience-ledger.json': ledger }, async root => {
    const metric = await ledgerMetric({ root, chapters: [3] });
    assert.equal(metric.status, 'unavailable');
    assert.equal(metric.reason, 'stale');
  });
});

test('ledgerMetric is unavailable when the ledger has no entries', async () => {
  await withWorkRoot({ 'pattern-ledger.json': [] }, async root => {
    const metric = await ledgerMetric({ root, chapters: [3] });
    assert.equal(metric.status, 'unavailable');
    assert.equal(metric.reason, 'no-entries');
  });
});

test('ledgerMetric is unavailable when no sidecar exists', async () => {
  await withWorkRoot(null, async root => {
    const metric = await ledgerMetric({ root, chapters: [3] });
    assert.equal(metric.reason, 'no-entries');
  });
});

test('ledgerMetric never writes into the work root', async () => {
  for (const sidecars of [null, { 'pattern-ledger.json': [entry(1), entry(2), entry(3)] }]) {
    await withWorkRoot(sidecars, async root => {
      const before = await snapshotTree(root);
      await ledgerMetric({ root, chapters: [3, 4] });
      assert.deepEqual(await snapshotTree(root), before);
    });
  }
});

test('independenceLabel never claims independence', () => {
  assert.equal(independenceLabel({ providerKind: 'host-relay', judgeModel: 'a', writerModel: 'b' }), 'not-independent');
  assert.equal(independenceLabel({ providerKind: 'local', judgeModel: 'm', writerModel: 'm' }), 'not-independent');
  assert.equal(independenceLabel({ providerKind: 'local', judgeModel: 'm', writerModel: 'n' }), 'unverified');
  assert.equal(independenceLabel({ providerKind: 'local', judgeModel: 'm' }), 'unverified');
  assert.equal(independenceLabel({ providerKind: 'local' }), 'unverified');
  for (const providerKind of ['host-relay', 'local', 'other', undefined]) {
    for (const judgeModel of ['m', 'n', undefined]) {
      for (const writerModel of ['m', 'n', undefined]) {
        assert.notEqual(independenceLabel({ providerKind, judgeModel, writerModel }), 'independent');
      }
    }
  }
});

const REQUIRED_ARGV = ['--off', 'a', '--on', 'b', '--out', 'o', '--language', 'ko'];

function argvWithout(flag) {
  const result = [];
  for (let i = 0; i < REQUIRED_ARGV.length; i += 2) {
    if (REQUIRED_ARGV[i] !== flag) result.push(REQUIRED_ARGV[i], REQUIRED_ARGV[i + 1]);
  }
  return result;
}

test('parseCliArgs reads repeated pairs and options with defaults', () => {
  const parsed = parseCliArgs([
    '--off', 'off1', '--on', 'on1', '--off', 'off2', '--on', 'on2', '--out', 'result', '--language', 'ko',
    '--chapters', '5-12', '--answers', 'answers.json', '--feature', 'f', '--judge-label', 'j',
    '--writer-model', 'w', '--timeout-ms', '600000',
  ]);
  assert.deepEqual(parsed, {
    off: ['off1', 'off2'], on: ['on1', 'on2'], out: 'result', language: 'ko', chapters: '5-12',
    answers: 'answers.json', feature: 'f', judgeLabel: 'j', writerModel: 'w', timeoutMs: 600000,
  });
  const minimal = parseCliArgs(REQUIRED_ARGV);
  assert.equal(minimal.timeoutMs, 300000);
  assert.equal(minimal.chapters, undefined);
  assert.deepEqual(minimal.off, ['a']);
});

test('parseCliArgs reports missing, mismatched, unknown and invalid arguments by code', () => {
  for (const flag of ['--off', '--on', '--out', '--language']) {
    assert.throws(() => parseCliArgs(argvWithout(flag)),
      error => error.code === 'MISSING_ARGUMENT' && error.message.includes(flag), flag);
  }
  assert.throws(() => parseCliArgs(['--off', 'a', '--off', 'b', '--on', 'c', '--out', 'o', '--language', 'ko']),
    error => error.code === 'PAIR_COUNT_MISMATCH');
  assert.throws(() => parseCliArgs([...REQUIRED_ARGV, '--bogus']), error => error.code === 'UNKNOWN_ARGUMENT');
  for (const value of ['0', '-5', '1.5', 'abc']) {
    assert.throws(() => parseCliArgs([...REQUIRED_ARGV, `--timeout-ms=${value}`]),
      error => error.code === 'INVALID_TIMEOUT', value);
  }
});

test('assertOutPath allows fresh and empty output directories outside inputs and the repo', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pairwise-out-'));
  try {
    const input = join(base, 'input');
    await mkdir(input);
    const fresh = join(base, 'fresh');
    assert.equal(await assertOutPath({ out: fresh, inputRoots: [input], repoRoot: REPO_ROOT }), join(await realpath(base), 'fresh'));
    await assert.rejects(access(fresh));
    const existing = join(base, 'existing');
    await mkdir(existing);
    assert.equal(await assertOutPath({ out: existing, inputRoots: [input], repoRoot: REPO_ROOT }), join(await realpath(base), 'existing'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('assertOutPath rejects the repo, input roots, their children, dot-dot and symlink routes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pairwise-out-'));
  try {
    const root = join(dir, 'input');
    await mkdir(root);
    const link = join(dir, 'link');
    await symlink(root, link);
    const repoOut = join(REPO_ROOT, 'tmp-pairwise-out');
    await assert.rejects(assertOutPath({ out: repoOut, inputRoots: [root], repoRoot: REPO_ROOT }),
      error => error.code === 'OUT_PATH_FORBIDDEN');
    await assert.rejects(access(repoOut));
    const forbidden = [root, join(root, 'child'), join(root, '..', basename(root), 'x'), link, join(link, 'child')];
    for (const out of forbidden) {
      await assert.rejects(assertOutPath({ out, inputRoots: [root], repoRoot: REPO_ROOT }),
        error => error.code === 'OUT_PATH_FORBIDDEN', out);
    }
    await assert.rejects(access(join(root, 'child')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const ALL_A = JSON.stringify(Object.fromEntries(DIMENSIONS.map(dimension => [dimension, { winner: 'A', reason: 'r' }])));

function fakeProvider(answer = () => ALL_A, model = 'fake') {
  const calls = [];
  return {
    calls,
    provenance: { kind: 'local-openai', model, contextIsolation: 'request-messages-only' },
    async complete(request) {
      calls.push(request);
      return { text: await answer(request, calls.length) };
    },
  };
}

async function writeChapters(root, chapters) {
  await mkdir(join(root, 'chapters'), { recursive: true });
  for (const [number, prose] of Object.entries(chapters)) {
    await writeFile(join(root, 'chapters', `${String(number).padStart(3, '0')}.md`), `---\ntitle: T${number}\n---\n\n${prose}\n`);
  }
}

async function withRun(run, { off = {}, on = {} } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'pairwise-run-'));
  try {
    const dirs = { base, off: join(base, 'off'), on: join(base, 'on'), out: join(base, 'out') };
    await writeChapters(dirs.off, { 1: 'Same opening chapter.', 2: 'Off two prose.', 3: 'Off three prose.', ...off });
    await writeChapters(dirs.on, { 1: 'Same opening chapter.', 2: 'On two prose, longer.', 3: 'On three prose.', ...on });
    return await run(dirs);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = path => access(path).then(() => true, () => false);

describe('runPairwiseEvaluation', () => {
  test('local mode writes a report with both orders, position bias and a non-independent label', () => withRun(async dirs => {
    const provider = fakeProvider();
    const result = await runPairwiseEvaluation({
      off: [dirs.off], on: [dirs.on], out: dirs.out, language: 'en', provider, writerModel: 'fake',
      judgeLabel: 'my-judge', feature: 'dice', now: () => new Date('2026-11-01T00:00:00Z'),
    });
    assert.equal(result.status, 'report');
    assert.equal(result.exitCode, 0);
    assert.equal(result.reportPath, join(dirs.out, 'report.json'));
    assert.equal(provider.calls.length, 4);
    const report = await readJson(result.reportPath);
    assert.equal(report.protocolVersion, 'pairwise-v1');
    assert.equal(report.createdAt, '2026-11-01T00:00:00.000Z');
    assert.equal(report.feature, 'dice');
    assert.equal(report.promptFamily, 'multilingual');
    assert.deepEqual(report.inputs, [{ replicate: 1, off: dirs.off, on: dirs.on }]);
    assert.deepEqual(report.identical, [{ replicate: 1, chapter: 1 }]);
    assert.equal(report.exchanges.length, 4);
    for (const exchange of report.exchanges) {
      assert.match(exchange.id, /^[0-9a-f]{64}$/);
      assert.match(exchange.answerSha256, /^[0-9a-f]{64}$/);
      assert.equal(exchange.verdict.plot, 'A');
      assert.ok(!('error' in exchange));
    }
    assert.deepEqual(report.chapters.map(item => item.chapter), [2, 3]);
    assert.match(report.chapters[0].sha256.off, /^[0-9a-f]{64}$/);
    for (const item of report.chapters) for (const dimension of DIMENSIONS) assert.equal(item.outcomes[dimension].outcome, 'conflict');
    for (const dimension of DIMENSIONS) {
      assert.equal(report.aggregate[dimension].conflicts, 2);
      assert.equal(report.aggregate[dimension].firstPositionRate, 1);
    }
    assert.deepEqual(report.judge, {
      providerKind: 'local', model: 'fake', declaredLabel: 'my-judge',
      contextIsolation: 'request-messages-only', independence: 'not-independent',
    });
    assert.equal(report.metrics.length.perChapter.length, 2);
    assert.equal(report.metrics.patternLedger[0].off.status, 'unavailable');
    assert.deepEqual(report.caveats, buildCaveats(report));
    assert.equal(typeof (await readFile(join(dirs.out, 'report.md'), 'utf8')), 'string');
    assert.ok(!(await exists(join(dirs.out, 'requests.json'))));

    const strings = [];
    JSON.stringify(report, (key, value) => { if (typeof value === 'string') strings.push(value); return value; });
    for (const text of strings) {
      assert.ok(!text.includes(join(dirs.off, 'chapters')) && !text.includes(join(dirs.on, 'chapters')), text);
      if (text.startsWith(dirs.base)) assert.ok(text === dirs.off || text === dirs.on, text);
    }

    const other = fakeProvider(undefined, 'other');
    await runPairwiseEvaluation({ off: [dirs.off], on: [dirs.on], out: dirs.out, language: 'en', provider: other, writerModel: 'writer' });
    assert.equal((await readJson(result.reportPath)).judge.independence, 'unverified');
    assert.equal((await readJson(result.reportPath)).judge.declaredLabel, null);
  }));

  test('local mode builds its provider from the environment and records endpoint failures', () => withRun(async dirs => {
    const result = await runPairwiseEvaluation({
      off: [dirs.off], on: [dirs.on], out: dirs.out, language: 'ko', env: { VIBELORE_LOCAL_BASE_URL: 'http://127.0.0.1:1', VIBELORE_LOCAL_MODEL: 'env-model' },
      timeoutMs: 1000,
    });
    const report = await readJson(result.reportPath);
    assert.equal(report.promptFamily, 'ko');
    assert.equal(report.judge.model, 'env-model');
    assert.equal(report.judge.providerKind, 'local');
    assert.equal(report.exchanges.length, 4);
    for (const exchange of report.exchanges) assert.ok(exchange.error);
  }));

  test('a failing local call becomes an invalid exchange and the run still reports', () => withRun(async dirs => {
    const provider = fakeProvider((request, count) => {
      if (count === 2) throw new Error('endpoint down');
      return JSON.stringify({ plot: 'A', creativity: 'A', development: 'A', language: 'A' });
    });
    const result = await runPairwiseEvaluation({ off: [dirs.off], on: [dirs.on], out: dirs.out, language: 'en', provider });
    assert.equal(result.status, 'report');
    const report = await readJson(result.reportPath);
    const failed = report.exchanges.filter(item => item.error);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].error, 'endpoint down');
    assert.equal(failed[0].answerSha256, null);
    assert.deepEqual(Object.values(failed[0].verdict), ['invalid', 'invalid', 'invalid', 'invalid']);
    for (const dimension of DIMENSIONS) {
      assert.equal(report.aggregate[dimension].invalid, 1);
      assert.equal(report.aggregate[dimension].conflicts, 1);
    }
  }));

  test('an unparsable local answer is repaired once and then counted invalid', () => withRun(async dirs => {
    const provider = fakeProvider(() => '{"plot":');
    const result = await runPairwiseEvaluation({ off: [dirs.off], on: [dirs.on], out: dirs.out, language: 'en', provider });
    const report = await readJson(result.reportPath);
    assert.equal(provider.calls.length, 8);
    for (const dimension of DIMENSIONS) assert.equal(report.aggregate[dimension].invalid, 2);
  }));

  async function relayRun(dirs, answersPath, extra = {}) {
    return runPairwiseEvaluation({
      off: [dirs.off], on: [dirs.on], out: dirs.out, language: 'en', env: {}, answers: answersPath, ...extra,
    });
  }

  const writeAnswers = async (dirs, value) => {
    const path = join(dirs.base, 'answers.json');
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };

  test('relay mode asks for answers, then reports from them', () => withRun(async dirs => {
    const first = await relayRun(dirs);
    assert.equal(first.status, 'needs_model');
    assert.equal(first.exitCode, 2);
    assert.equal(first.pending, 4);
    assert.equal(first.requestsPath, join(dirs.out, 'requests.json'));
    const requests = await readJson(first.requestsPath);
    assert.equal(requests.status, 'needs_model');
    assert.equal(new Set(requests.requests.map(item => item.id)).size, 4);
    assert.match(requests.instruction, /--answers/);
    for (const item of requests.requests) {
      assert.equal(item.step, 'pairwise-judge');
      assert.equal(item.jsonMode, true);
      assert.ok(item.system && item.user.includes(JUDGE_DELIMITERS.startA));
    }
    assert.ok(!(await exists(join(dirs.out, 'report.json'))));
    assert.ok(!(await exists(join(dirs.out, 'report.md'))));

    const answersPath = await writeAnswers(dirs, Object.fromEntries(requests.requests.map(item => [item.id, ALL_A])));
    const second = await relayRun(dirs, answersPath, { judgeLabel: 'host' });
    assert.equal(second.status, 'report');
    assert.ok(!(await exists(join(dirs.out, 'requests.json'))));
    const report = await readJson(second.reportPath);
    assert.equal(report.judge.providerKind, 'host-relay');
    assert.equal(report.judge.independence, 'not-independent');
    assert.equal(report.judge.contextIsolation, 'unverified');
    assert.ok(!('model' in report.judge));
    assert.deepEqual(report.exchanges.map(item => item.id).sort(), requests.requests.map(item => item.id).sort());
  }));

  test('relay mode never reports from missing, partial or malformed answers', () => withRun(async dirs => {
    const empty = await relayRun(dirs, await writeAnswers(dirs, {}));
    assert.equal(empty.status, 'needs_model');
    assert.ok(!(await exists(join(dirs.out, 'report.json'))));
    const ids = (await readJson(empty.requestsPath)).requests.map(item => item.id);
    assert.equal(ids.length, 4);

    const half = await relayRun(dirs, await writeAnswers(dirs, Object.fromEntries(ids.slice(0, 2).map(id => [id, ALL_A]))));
    assert.equal(half.status, 'needs_model');
    assert.deepEqual((await readJson(half.requestsPath)).requests.map(item => item.id), ids.slice(2));
    assert.ok(!(await exists(join(dirs.out, 'report.json'))));

    const answers = Object.fromEntries(ids.map(id => [id, ALL_A]));
    answers[ids[0]] = '{"plot":';
    const malformed = await relayRun(dirs, await writeAnswers(dirs, answers));
    assert.equal(malformed.status, 'needs_model');
    const repairs = (await readJson(malformed.requestsPath)).requests;
    assert.equal(repairs.length, 1);
    assert.ok(!ids.includes(repairs[0].id));
    assert.ok(repairs[0].user.includes('not valid JSON'));
    assert.ok(!(await exists(join(dirs.out, 'report.json'))));

    const repaired = await relayRun(dirs, await writeAnswers(dirs, { ...answers, [repairs[0].id]: ALL_A }));
    assert.equal(repaired.status, 'report');
    const report = await readJson(repaired.reportPath);
    assert.equal(report.exchanges.find(item => item.id === ids[0]).verdict.plot, 'A');
    assert.ok(!(await exists(join(dirs.out, 'requests.json'))));
  }));

  test('a fresh needs_model run removes a stale report', () => withRun(async dirs => {
    const first = await relayRun(dirs);
    const ids = (await readJson(first.requestsPath)).requests.map(item => item.id);
    const done = await relayRun(dirs, await writeAnswers(dirs, Object.fromEntries(ids.map(id => [id, ALL_A]))));
    assert.equal(done.status, 'report');
    assert.ok(await exists(join(dirs.out, 'report.md')));
    const again = await relayRun(dirs, await writeAnswers(dirs, {}));
    assert.equal(again.status, 'needs_model');
    assert.ok(!(await exists(join(dirs.out, 'report.json'))));
    assert.ok(!(await exists(join(dirs.out, 'report.md'))));
    assert.ok(await exists(join(dirs.out, 'requests.json')));
  }));

  test('an unusable answers file is rejected before any output', () => withRun(async dirs => {
    for (const content of ['[]', 'not json', '{"a":1}', '"text"']) {
      await assert.rejects(relayRun(dirs, await writeAnswers(dirs, content)), { code: 'INVALID_ANSWERS' }, content);
    }
    await assert.rejects(relayRun(dirs, join(dirs.base, 'missing.json')), { code: 'INVALID_ANSWERS' });
    assert.ok(!(await exists(dirs.out)));
  }));

  test('replicates share request ids and one answer serves them all', () => withRun(async dirs => {
    const run = (answersPath) => runPairwiseEvaluation({
      off: [dirs.off, dirs.off], on: [dirs.on, dirs.on], out: dirs.out, language: 'en', env: {}, answers: answersPath,
    });
    const first = await run();
    assert.equal(first.pending, 4);
    const ids = (await readJson(first.requestsPath)).requests.map(item => item.id);
    assert.equal(new Set(ids).size, ids.length);
    const done = await run(await writeAnswers(dirs, Object.fromEntries(ids.map(id => [id, ALL_A]))));
    assert.equal(done.status, 'report');
    const report = await readJson(done.reportPath);
    assert.equal(report.exchanges.length, 8);
    assert.deepEqual([...new Set(report.exchanges.map(item => item.replicate))], [1, 2]);
    assert.equal(report.metrics.patternLedger.length, 2);
    assert.equal(report.aggregate.plot.conflicts, 4);
  }));

  test('prose containing a judge delimiter is rejected before any provider call or output', () => withRun(async dirs => {
    const provider = fakeProvider();
    await assert.rejects(
      runPairwiseEvaluation({ off: [dirs.off], on: [dirs.on], out: dirs.out, language: 'en', provider }),
      { code: 'PROSE_DELIMITER_CONFLICT' },
    );
    assert.equal(provider.calls.length, 0);
    assert.ok(!(await exists(dirs.out)));
  }, { on: { 3: `Tricky ${JUDGE_DELIMITERS.endB} prose.` } }));

  test('reruns with the same inputs and answers match apart from createdAt', () => withRun(async dirs => {
    const reports = [];
    for (const [index, now] of [new Date('2026-01-01T00:00:00Z'), new Date('2027-06-01T00:00:00Z')].entries()) {
      const out = join(dirs.base, `out-${index}`);
      const result = await runPairwiseEvaluation({
        off: [dirs.off], on: [dirs.on], out, language: 'en', provider: fakeProvider(), now: () => now,
      });
      reports.push(await readJson(result.reportPath));
    }
    assert.notEqual(reports[0].createdAt, reports[1].createdAt);
    delete reports[0].createdAt;
    delete reports[1].createdAt;
    assert.deepEqual(reports[0], reports[1]);
  }));

  test('an output directory inside an input root is rejected and nothing is written there', () => withRun(async dirs => {
    const before = await snapshotTree(dirs.off);
    for (const out of [join(dirs.off, 'result'), join(dirs.on, 'chapters', 'x'), dirs.off]) {
      await assert.rejects(
        runPairwiseEvaluation({ off: [dirs.off], on: [dirs.on], out, language: 'en', provider: fakeProvider() }),
        { code: 'OUT_PATH_FORBIDDEN' },
      );
    }
    assert.deepEqual(await snapshotTree(dirs.off), before);
  }));

  test('chapter filters and unpaired chapters are respected', () => withRun(async dirs => {
    const provider = fakeProvider();
    const result = await runPairwiseEvaluation({
      off: [dirs.off], on: [dirs.on], out: dirs.out, language: 'en', provider, chapters: '3-4',
    });
    const report = await readJson(result.reportPath);
    assert.equal(provider.calls.length, 2);
    assert.deepEqual(report.chapters.map(item => item.chapter), [3]);
    assert.deepEqual(report.unpaired, [{ replicate: 1, chapter: 4, side: 'on' }]);
    assert.equal(report.chapterFilter, '3-4');
  }, { on: { 4: 'Only on four.' } }));
});

const FORBIDDEN_WORDS = /\b(better|worse|pass|fail)\b/i;

function sampleReport(overrides = {}) {
  const outcome = (name, score) => ({ outcome: name, score });
  const stat = { n: 3, onWins: 2, offWins: 1, ties: 0, conflicts: 0, invalid: 0, onPreference: 0.75, signTestP: 1, firstPositionRate: 0.5 };
  const side = { labelSource: 'stored pattern-ledger review of the writing copy', status: 'unavailable', reason: 'no-root', missingChapters: [] };
  return {
    protocolVersion: 'pairwise-v1',
    createdAt: '2026-11-01T00:00:00.000Z',
    feature: 'dice',
    language: 'en',
    promptFamily: 'multilingual',
    inputs: [{ replicate: 1, off: '/in/off', on: '/in/on' }],
    chapterFilter: null,
    judge: { providerKind: 'host-relay', declaredLabel: null, contextIsolation: 'unverified', independence: 'not-independent' },
    exchanges: [
      { id: 'a', replicate: 1, chapter: 2, order: 'off-first', verdict: { plot: 'A', creativity: 'A', development: 'A', language: 'A' } },
      { id: 'b', replicate: 1, chapter: 2, order: 'on-first', verdict: { plot: 'invalid', creativity: 'A', development: 'A', language: 'A' } },
    ],
    chapters: [{
      replicate: 1, chapter: 2, sha256: { off: 'x', on: 'y' },
      outcomes: { plot: outcome('on', 0.75), creativity: outcome('conflict', 0.5), development: outcome('tie', 0.5), language: outcome('invalid', null) },
    }],
    aggregate: Object.fromEntries(DIMENSIONS.map(dimension => [dimension, { ...stat }])),
    metrics: {
      length: { perChapter: [], totals: { off: 100, on: 130 }, ratio: 1.3, longerTextNote: true },
      patternLedger: [{ replicate: 1, off: { ...side }, on: { ...side } }],
    },
    identical: [{ replicate: 1, chapter: 1 }],
    unpaired: [{ replicate: 1, chapter: 4, side: 'on' }],
    caveats: [],
    ...overrides,
  };
}

describe('buildCaveats', () => {
  test('orders the generic, independence and sample caveats first', () => {
    const caveats = buildCaveats(sampleReport());
    assert.match(caveats[0], /LLM-judge pairwise preferences, not human evaluation, and may differ from what human readers prefer/);
    assert.ok(caveats[1].includes('judged through the host relay; same host as the writer unless shown otherwise; not an independent evaluation'));
    assert.match(caveats[2], /1 chapter pair was judged; sign-test p-values are listed in the table/);
    for (const caveat of caveats) assert.doesNotMatch(caveat, FORBIDDEN_WORDS);
  });

  test('the baseline caveat appears unless the feature is baseline', () => {
    for (const feature of ['dice', null]) {
      assert.ok(buildCaveats(sampleReport({ feature })).some(text => text.includes('No A/A baseline supplied')));
    }
    assert.ok(!buildCaveats(sampleReport({ feature: 'baseline' })).some(text => text.includes('No A/A baseline supplied')));
  });

  test('the small-sample warning appears below 10 pairs only', () => {
    const pairs = count => Array.from({ length: count }, (_, index) => ({ replicate: 1, chapter: index + 1 }));
    assert.ok(buildCaveats(sampleReport({ chapters: pairs(3) })).some(text => text.includes('Small sample')));
    assert.ok(buildCaveats(sampleReport({ chapters: pairs(9) })).some(text => text.includes('Small sample')));
    assert.ok(!buildCaveats(sampleReport({ chapters: pairs(10) })).some(text => text.includes('Small sample')));
    assert.ok(buildCaveats(sampleReport({ chapters: pairs(10) })).some(text => text.includes('10 chapter pairs were judged')));
  });

  test('the length caveat appears only with the longer-text note', () => {
    const metrics = longerTextNote => ({ ...sampleReport().metrics, length: { perChapter: [], totals: { off: 100, on: 101 }, ratio: 1.01, longerTextNote } });
    assert.ok(buildCaveats(sampleReport({ metrics: metrics(true) })).some(text => text.includes('length')));
    assert.ok(!buildCaveats(sampleReport({ metrics: metrics(false) })).some(text => text.includes('length')));
  });

  test('local judging states the declared model and never claims independence', () => {
    const judge = (independence, model = 'judge-x') => ({ providerKind: 'local', model, declaredLabel: null, contextIsolation: 'request-messages-only', independence });
    const same = buildCaveats(sampleReport({ judge: judge('not-independent') }))[1];
    assert.match(same, /judge-x/);
    assert.match(same, /declared/);
    assert.match(same, /unverified/);
    assert.match(same, /not-independent/);
    assert.match(same, /same model as the writer/);
    const other = buildCaveats(sampleReport({ judge: judge('unverified') }))[1];
    assert.match(other, /judge-x/);
    assert.match(other, /unverified/);
    assert.doesNotMatch(other, /not-independent|not an independent/);
    assert.doesNotMatch(other.replace(/unverified/g, ''), /independent/);
  });
});

describe('renderReportMarkdown', () => {
  test('renders the caveat block first and the per-dimension table', () => {
    const report = sampleReport({ caveats: buildCaveats(sampleReport()) });
    const markdown = renderReportMarkdown(report);
    assert.ok(markdown.startsWith(`# Pairwise evaluation report\n\n${report.caveats[0]}\n\n${report.caveats[1]}`));
    assert.equal(markdown, renderReportMarkdown(report));
    assert.match(markdown, /ON preferred in 2 of 3 pairs/);
    assert.match(markdown, /OFF preferred in 1 of 3 pairs/);
    assert.match(markdown, /Length/);
    assert.doesNotMatch(markdown, FORBIDDEN_WORDS);
  });

  test('lists per-chapter outcomes, identical and unpaired chapters and invalid exchanges', () => {
    const markdown = renderReportMarkdown(sampleReport({ caveats: [] }));
    assert.match(markdown, /Replicate 1, chapter 2: plot ON \(0\.75\), creativity conflict \(0\.50\), development tie \(0\.50\), language invalid/);
    assert.match(markdown, /Identical in both copies, not judged: replicate 1 chapter 1/);
    assert.match(markdown, /Unpaired chapters, not judged: replicate 1 chapter 4 \(ON copy only\)/);
    assert.match(markdown, /Exchanges with at least one invalid dimension: 1 of 2/);
    assert.match(markdown, /OFF 100, ON 130, ON\/OFF ratio 1\.30/);
  });

  test('ledger sections show unavailable reasons, counts and incomplete states plainly', () => {
    const label = 'stored pattern-ledger review of the writing copy';
    const base = { labelSource: label, missingChapters: [] };
    const metrics = {
      ...sampleReport().metrics,
      patternLedger: [{
        replicate: 1,
        off: { ...base, status: 'incomplete', counts: { perChapter: [], totals: {}, missingChapters: [2, 3] }, missingChapters: [2, 3] },
        on: { ...base, status: 'available', counts: { perChapter: [{ chapter: 2, codes: { 'repeated-opening': 1 } }], totals: { 'repeated-opening': 1 }, missingChapters: [] } },
      }, {
        replicate: 2,
        off: { ...base, status: 'unavailable', reason: 'stale' },
        on: { ...base, status: 'incomplete', counts: { perChapter: [{ chapter: 2, codes: {} }], totals: {}, missingChapters: [3] }, missingChapters: [3] },
      }],
    };
    const markdown = renderReportMarkdown(sampleReport({ metrics, caveats: [] }));
    assert.match(markdown, /Replicate 1 OFF: incomplete; no judged chapter has a ledger entry \(chapters 2, 3\), so there are no counts to show; this is missing data, not a clean result/);
    assert.match(markdown, /Replicate 1 ON: repeated-opening 1/);
    assert.match(markdown, /Replicate 2 OFF: unavailable \(stored ledger is stale\)/);
    assert.match(markdown, /Replicate 2 ON: incomplete; counts cover chapter 2 only \(no entry for chapter 3\); no pattern codes flagged in the covered chapters/);
    assert.ok(markdown.includes(`Labels come from the ${label}`));
    assert.match(markdown, /written by whichever model ran `pattern-ledger` in each copy/);
    assert.doesNotMatch(markdown, FORBIDDEN_WORDS);

    const no = renderReportMarkdown(sampleReport({ caveats: [] }));
    assert.match(no, /Replicate 1 OFF: unavailable \(no work root was given for this copy\)/);
  });

  test('unavailable ledger reasons are all described', () => {
    const base = { labelSource: 'x', status: 'unavailable', missingChapters: [] };
    const metrics = patternLedger => ({ ...sampleReport().metrics, patternLedger });
    const markdown = renderReportMarkdown(sampleReport({
      caveats: [],
      metrics: metrics([{ replicate: 1, off: { ...base, reason: 'no-entries' }, on: { ...base, reason: 'stale' } }]),
    }));
    assert.match(markdown, /OFF: unavailable \(no ledger entries recorded\)/);
    assert.match(markdown, /ON: unavailable \(stored ledger is stale\)/);
  });
});

describe('report.md from full runs', () => {
  const readReports = async dirs => ({
    markdown: await readFile(join(dirs.out, 'report.md'), 'utf8'),
    report: await readJson(join(dirs.out, 'report.json')),
  });

  test('a relay run writes the caveat block first and stays free of verdict wording', () => withRun(async dirs => {
    const run = answers => runPairwiseEvaluation({ off: [dirs.off], on: [dirs.on], out: dirs.out, language: 'en', env: {}, answers });
    const first = await run();
    const ids = (await readJson(first.requestsPath)).requests.map(item => item.id);
    assert.match((await readJson(first.requestsPath)).instruction, /repair/);
    const path = join(dirs.base, 'answers.json');
    await writeFile(path, JSON.stringify(Object.fromEntries(ids.map(id => [id, ALL_A]))));
    assert.equal((await run(path)).status, 'report');
    const { markdown, report } = await readReports(dirs);
    assert.ok(markdown.startsWith(`# Pairwise evaluation report\n\n${report.caveats[0]}`));
    assert.match(markdown, /ON preferred in/);
    assert.doesNotMatch(markdown, FORBIDDEN_WORDS);
    assert.ok(markdown.includes('not an independent evaluation'));
    assert.ok(report.caveats.some(text => text.includes('not an independent evaluation')));
  }));

  for (const language of ['ko', 'en']) {
    test(`a ${language} local run carries every caveat in report.md and report.json`, () => withRun(async dirs => {
      await runPairwiseEvaluation({
        off: [dirs.off], on: [dirs.on], out: dirs.out, language, provider: fakeProvider(), writerModel: 'fake', judgeLabel: 'my-judge',
      });
      const { markdown, report } = await readReports(dirs);
      assert.equal(report.caveats.length, 5);
      assert.match(report.caveats[0], /not human evaluation/);
      assert.match(report.caveats[1], /not-independent/);
      for (const caveat of report.caveats) assert.ok(markdown.includes(caveat), caveat);
      assert.ok(markdown.includes('my-judge'));
      assert.match(markdown, /ON preferred in 0 of 2 pairs/);
      assert.match(markdown, /Exchanges with at least one invalid dimension: 0 of 4/);
      assert.doesNotMatch(markdown, FORBIDDEN_WORDS);
    }));
  }

  test('invalid exchanges are counted without verdict wording', () => withRun(async dirs => {
    const provider = fakeProvider((request, count) => {
      if (count === 2) throw new Error('endpoint down');
      return ALL_A;
    });
    await runPairwiseEvaluation({ off: [dirs.off], on: [dirs.on], out: dirs.out, language: 'en', provider });
    const { markdown } = await readReports(dirs);
    assert.match(markdown, /Exchanges with at least one invalid dimension: 1 of 4/);
    assert.doesNotMatch(markdown, FORBIDDEN_WORDS);
  }));
});
