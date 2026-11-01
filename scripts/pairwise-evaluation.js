import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseJsonCompletion } from '../engine/src/core/json-completion.js';
import { publishedProse } from '../engine/src/core/length-measure.js';
import { promptFamilyFor } from '../engine/src/core/language-policy.js';
import { deriveRequestFingerprint } from '../engine/src/core/request-fingerprint.js';
import { loadCurrentExperienceLedger } from '../src/core/experience-ledger.js';
import { hostExecutionNote, relayScaffold } from '../src/core/relay-prompt-layout.js';
import { parseDocument } from '../src/md/frontmatter.js';
import { PendingModelWork, createHostRelay, runWithRelay } from '../src/provider/host-relay.js';
import { withJsonRepair } from '../src/provider/json-repair.js';
import { createLocalOpenAIProvider } from '../src/provider/local-openai.js';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { patternViolations } from '../src/tools/story-experience.js';

export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PROTOCOL_VERSION = 'pairwise-v1';
export const DIMENSIONS = ['plot', 'creativity', 'development', 'language'];

const LETTERS = new Set(['A', 'B', 'tie']);
const SCORES = { on: 1, tie: 0.5, off: 0 };

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseVerdict(text) {
  const parsed = parseJsonCompletion(text);
  const source = isRecord(parsed) ? parsed : {};
  return Object.fromEntries(DIMENSIONS.map(dimension => {
    const entry = source[dimension];
    const letter = isRecord(entry) ? entry.winner : entry;
    return [dimension, LETTERS.has(letter) ? letter : 'invalid'];
  }));
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

export const JUDGE_DELIMITERS = Object.freeze({
  startA: '<<<VERSION A>>>',
  endA: '<<<END VERSION A>>>',
  startB: '<<<VERSION B>>>',
  endB: '<<<END VERSION B>>>',
});

const JUDGE_SCHEMA = '{"plot":{"winner":"A|B|tie","reason":"<=200 chars"},"creativity":{"winner":"A|B|tie","reason":"<=200 chars"},"development":{"winner":"A|B|tie","reason":"<=200 chars"},"language":{"winner":"A|B|tie","reason":"<=200 chars"}}';

const JUDGE_SYSTEM = {
  ko: [
    '너는 같은 연재 소설 한 화의 두 판본을 나란히 읽는 비교 독자다. 어느 판본이 어떤 방식으로 만들어졌는지 알려져 있지 않으며, 알려고 하지 않는다.',
    [
      '네 가지 항목마다 더 나은 판본을 고른다.',
      '- plot: 사건들이 서로 맞물리며 앞으로 나아가는가.',
      '- creativity: 뜻밖이지만 작품에 어울리는 선택이 있는가.',
      '- development: 인물과 상황이 변하고, 그 변화에 충분한 지면이 주어지는가.',
      '- language: 문장의 질과 작품 고유의 목소리에 대한 어울림.',
    ].join('\n'),
    '두 판본을 구별할 수 없을 때만 tie를 고른다. 조금이라도 차이가 보이면 더 나은 쪽을 고른다.',
    '분량이 길든 짧든 그것만으로 선호하지 않으며, 판본이 어떻게 만들어졌는지는 언급하지 않는다.',
    `답은 항목마다 승자(A, B, tie)와 200자 이내의 이유를 담은 다음 형태다.\n${JUDGE_SCHEMA}`,
    relayScaffold('ko').json,
    hostExecutionNote('ko'),
  ],
  multilingual: [
    'You are a comparative reader who reads two versions of the same serial-fiction chapter side by side. You are not told how either version was produced and you do not try to guess.',
    [
      'For each of the four dimensions, pick the better version.',
      '- plot: the events cohere and move the story forward.',
      '- creativity: the choices are unexpected yet fit the work.',
      '- development: characters and situation change, and the change is given room.',
      '- language: sentence quality and fit to the work\'s voice.',
    ].join('\n'),
    'Choose tie only when the two versions are indistinguishable on that dimension. If you can see any difference, pick the better one.',
    'Do not prefer a version for its length, whether longer or shorter, and do not comment on how the versions were made.',
    `Answer with the winner (A, B or tie) and a reason of at most 200 characters for each dimension, in this shape:\n${JUDGE_SCHEMA}`,
    relayScaffold('multilingual').json,
    hostExecutionNote('multilingual'),
  ],
};

export function judgeFamilyFor(language) {
  return promptFamilyFor(language) === 'ko' ? 'ko' : 'multilingual';
}

export function buildJudgeRequest({ family, a, b }) {
  const markers = Object.values(JUDGE_DELIMITERS);
  for (const prose of [a, b]) {
    if (markers.some(marker => prose.includes(marker))) {
      throw fail('PROSE_DELIMITER_CONFLICT', 'Chapter prose contains a judge delimiter');
    }
  }
  const { startA, endA, startB, endB } = JUDGE_DELIMITERS;
  return {
    step: 'pairwise-judge',
    jsonMode: true,
    model: { provider: 'host', modelId: 'host-agent' },
    messages: [
      { role: 'system', content: JUDGE_SYSTEM[family === 'ko' ? 'ko' : 'multilingual'].join('\n\n') },
      { role: 'user', content: `${startA}\n${a}\n${endA}\n\n${startB}\n${b}\n${endB}` },
    ],
  };
}

const LEDGER_LABEL_SOURCE = 'stored pattern-ledger review of the writing copy';

export function ledgerCounts(entries, chapters) {
  const judged = [...new Set(chapters)].sort((left, right) => left - right);
  const ordered = [...entries].sort((left, right) => left.chapter - right.chapter);
  const perChapter = [];
  const totals = {};
  const missingChapters = [];
  for (const chapter of judged) {
    const current = ordered.find(item => item.chapter === chapter);
    if (!current) {
      missingChapters.push(chapter);
      continue;
    }
    const prior = ordered.filter(item => item.chapter < chapter);
    const codes = {};
    for (const { code } of patternViolations(prior, current)) {
      codes[code] = (codes[code] ?? 0) + 1;
      totals[code] = (totals[code] ?? 0) + 1;
    }
    perChapter.push({ chapter, codes });
  }
  return { perChapter, totals, missingChapters };
}

export async function ledgerMetric({ root, chapters }) {
  const base = { labelSource: LEDGER_LABEL_SOURCE };
  if (root === null) return { ...base, status: 'unavailable', reason: 'no-root', missingChapters: [] };
  const ledger = await loadCurrentExperienceLedger({ store: new MarkdownStateStore(root), workId: 'evaluation' });
  if (ledger.status === 'stale') return { ...base, status: 'unavailable', reason: 'stale', missingChapters: [] };
  if (!ledger.entries.length) return { ...base, status: 'unavailable', reason: 'no-entries', missingChapters: [] };
  const counts = ledgerCounts(ledger.entries, chapters);
  return { ...base, status: counts.missingChapters.length ? 'incomplete' : 'available', counts, missingChapters: counts.missingChapters };
}

export function independenceLabel({ providerKind, judgeModel, writerModel }) {
  if (providerKind === 'host-relay') return 'not-independent';
  if (providerKind === 'local' && judgeModel && judgeModel === writerModel) return 'not-independent';
  return 'unverified';
}

const REQUIRED_FLAGS = ['off', 'on', 'out', 'language'];

export function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        off: { type: 'string', multiple: true },
        on: { type: 'string', multiple: true },
        out: { type: 'string' },
        language: { type: 'string' },
        chapters: { type: 'string' },
        answers: { type: 'string' },
        feature: { type: 'string' },
        'judge-label': { type: 'string' },
        'writer-model': { type: 'string' },
        'timeout-ms': { type: 'string' },
      },
    }));
  } catch (error) {
    throw Object.assign(new Error(error.message), { code: 'UNKNOWN_ARGUMENT' });
  }
  for (const flag of REQUIRED_FLAGS) {
    const value = values[flag];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      throw Object.assign(new Error(`missing required argument --${flag}`), { code: 'MISSING_ARGUMENT' });
    }
  }
  if (values.off.length !== values.on.length) {
    throw Object.assign(new Error('--off and --on must be given the same number of times'), { code: 'PAIR_COUNT_MISMATCH' });
  }
  const rawTimeout = values['timeout-ms'] ?? '300000';
  const timeoutMs = /^\d+$/.test(rawTimeout) ? Number(rawTimeout) : NaN;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw Object.assign(new Error('--timeout-ms must be a positive integer'), { code: 'INVALID_TIMEOUT' });
  }
  return {
    off: values.off, on: values.on, out: values.out, language: values.language, chapters: values.chapters,
    answers: values.answers, feature: values.feature, judgeLabel: values['judge-label'],
    writerModel: values['writer-model'], timeoutMs,
  };
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function resolveExisting(path) {
  const absolute = resolve(path);
  const rest = [];
  let current = absolute;
  for (;;) {
    try {
      return join(await realpath(current), ...rest);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return absolute;
      rest.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
      current = parent;
    }
  }
}

export async function assertOutPath({ out, inputRoots, repoRoot }) {
  const resolved = await resolveExisting(out);
  const forbidden = await Promise.all([repoRoot, ...inputRoots].map(resolveExisting));
  if (forbidden.some(root => isInside(root, resolved))) {
    throw Object.assign(new Error(`--out must be outside the repository and every input directory: ${out}`), { code: 'OUT_PATH_FORBIDDEN' });
  }
  return resolved;
}

const REQUESTS_INSTRUCTION = 'Answer each request from its "system" and "user" text alone, as JSON without code fences. Collect the answers as {"<id>": "<answer text>"} in an answers file and run this script again with --answers <file>. If an answer is not valid JSON, a repair request for it appears on the next run.';

const SMALL_SAMPLE_PAIRS = 10;

function independenceCaveat(judge) {
  if (judge.providerKind === 'host-relay') {
    return 'Independence: judged through the host relay; same host as the writer unless shown otherwise; not an independent evaluation.';
  }
  const model = judge.model ? `\`${judge.model}\`` : 'not recorded';
  const declared = `Independence: the judge model id (${model}) is declared by the endpoint configuration and unverified`;
  if (judge.independence === 'not-independent') {
    return `${declared}; independence is labelled not-independent because it is the same model as the writer.`;
  }
  return `${declared}; independence from the writer is unverified.`;
}

export function buildCaveats(report) {
  const pairs = report.chapters?.length ?? 0;
  const sample = pairs < SMALL_SAMPLE_PAIRS
    ? ` Small sample: fewer than ${SMALL_SAMPLE_PAIRS} judged pairs, so treat the preferences and p-values as rough indications only.`
    : '';
  const caveats = [
    'Results are LLM-judge pairwise preferences, not human evaluation, and may differ from what human readers prefer.',
    independenceCaveat(report.judge ?? {}),
    `${pairs} chapter ${pairs === 1 ? 'pair was' : 'pairs were'} judged; sign-test p-values are listed in the table.${sample}`,
  ];
  if (report.feature !== 'baseline') {
    caveats.push('No A/A baseline supplied: without a run that compares a copy against itself, the amount of preference caused by judge noise and presentation order alone is unknown.');
  }
  const length = report.metrics?.length;
  if (length?.longerTextNote) {
    const ratio = typeof length.ratio === 'number' ? ` (ON/OFF ratio ${length.ratio.toFixed(2)})` : '';
    caveats.push(`The two sets differ noticeably in length${ratio}; a judge may favor a longer or shorter text for that reason alone.`);
  }
  return caveats;
}

const fixed = (value, digits) => (typeof value === 'number' ? value.toFixed(digits) : 'n/a');
const chapterList = chapters => `${chapters.length === 1 ? 'chapter' : 'chapters'} ${chapters.join(', ')}`;
const sideName = side => side.toUpperCase();
const outcomeName = outcome => (outcome === 'on' || outcome === 'off' ? sideName(outcome) : outcome);

const LEDGER_REASONS = {
  'no-root': 'no work root was given for this copy',
  stale: 'stored ledger is stale',
  'no-entries': 'no ledger entries recorded',
};

function ledgerSummary(counts, scope) {
  const codes = Object.entries(counts.totals).map(([code, count]) => `${code} ${count}`);
  return codes.length ? codes.join(', ') : `no pattern codes flagged in ${scope}`;
}

function ledgerLine(replicate, side, metric) {
  const prefix = `- Replicate ${replicate} ${sideName(side)}:`;
  if (metric.status === 'unavailable') return `${prefix} unavailable (${LEDGER_REASONS[metric.reason] ?? metric.reason})`;
  const { counts } = metric;
  const covered = counts.perChapter.map(item => item.chapter);
  if (metric.status === 'incomplete' && !covered.length) {
    return `${prefix} incomplete; no judged chapter has a ledger entry (${chapterList(metric.missingChapters)}), so there are no counts to show; this is missing data, not a clean result`;
  }
  if (metric.status === 'incomplete') {
    return `${prefix} incomplete; counts cover ${chapterList(covered)} only (no entry for ${chapterList(metric.missingChapters)}); ${ledgerSummary(counts, 'the covered chapters')}`;
  }
  return `${prefix} ${ledgerSummary(counts, `the ${covered.length} judged ${covered.length === 1 ? 'chapter' : 'chapters'}`)}`;
}

function judgeLines(judge) {
  const lines = [`- Judge: ${judge.providerKind === 'host-relay' ? 'host relay' : 'local endpoint'}`];
  if (judge.model) lines.push(`- Judge model id (declared, unverified): \`${judge.model}\``);
  if (judge.declaredLabel) lines.push(`- Judge label (declared): ${judge.declaredLabel}`);
  lines.push(`- Context isolation: ${judge.contextIsolation}`, `- Independence label: ${judge.independence}`);
  return lines;
}

function dimensionRows(aggregateByDimension) {
  const header = ['Dimension', 'ON preferred in', 'OFF preferred in', 'Ties', 'Conflicts', 'Invalid', 'onPreference', 'signTestP', 'firstPositionRate'];
  const rows = DIMENSIONS.map(dimension => {
    const stat = aggregateByDimension[dimension];
    return [
      dimension, `ON preferred in ${stat.onWins} of ${stat.n} pairs`, `OFF preferred in ${stat.offWins} of ${stat.n} pairs`,
      stat.ties, stat.conflicts, stat.invalid, fixed(stat.onPreference, 3), fixed(stat.signTestP, 4), fixed(stat.firstPositionRate, 3),
    ];
  });
  return [header, header.map(() => '---'), ...rows].map(row => `| ${row.join(' | ')} |`);
}

function chapterLine({ replicate, chapter, outcomes }) {
  const parts = DIMENSIONS.map(dimension => {
    const { outcome, score } = outcomes[dimension];
    return `${dimension} ${outcomeName(outcome)}${typeof score === 'number' ? ` (${score.toFixed(2)})` : ''}`;
  });
  return `- Replicate ${replicate}, chapter ${chapter}: ${parts.join(', ')}`;
}

const listLine = (label, items) => `- ${label}: ${items.length ? items.join('; ') : 'none'}`;

export function renderReportMarkdown(report) {
  const { length } = report.metrics;
  const invalidExchanges = report.exchanges.filter(item => Object.values(item.verdict).includes('invalid')).length;
  const lines = [
    '# Pairwise evaluation report',
    '',
    ...report.caveats.flatMap(caveat => [caveat, '']),
    '## Run',
    '',
    `- Created: ${report.createdAt}`,
    `- Feature label: ${report.feature ?? 'none'}`,
    `- Language: ${report.language} (judge prompt family ${report.promptFamily})`,
    ...report.inputs.map(item => `- Replicate ${item.replicate}: OFF \`${item.off}\`, ON \`${item.on}\``),
    `- Chapter filter: ${report.chapterFilter ?? 'none'}`,
    ...judgeLines(report.judge),
    '',
    '## Preferences by dimension',
    '',
    ...dimensionRows(report.aggregate),
    '',
    'Each pair is judged in both presentation orders. A conflict means the two orders disagreed and counts toward neither side; invalid means at least one order gave no usable answer. firstPositionRate is the share of answers that chose the version shown first; 0.5 means no position preference.',
    '',
    '## Per-chapter outcomes',
    '',
    ...(report.chapters.length ? report.chapters.map(chapterLine) : ['- none']),
    '',
    '## Length',
    '',
    `- Totals over judged chapters (graphemes): OFF ${length.totals.off}, ON ${length.totals.on}, ON/OFF ratio ${fixed(length.ratio, 2)}`,
    '',
    '## Pattern ledger counts',
    '',
    ...report.metrics.patternLedger.flatMap(item => [ledgerLine(item.replicate, 'off', item.off), ledgerLine(item.replicate, 'on', item.on)]),
    '',
    `Labels come from the ${report.metrics.patternLedger[0]?.off.labelSource ?? LEDGER_LABEL_SOURCE}, written by whichever model ran \`pattern-ledger\` in each copy; this report does not know which model that was, and the two copies may differ.`,
    '',
    '## Excluded and invalid',
    '',
    listLine('Identical in both copies, not judged', report.identical.map(item => `replicate ${item.replicate} chapter ${item.chapter}`)),
    listLine('Unpaired chapters, not judged', report.unpaired.map(item => `replicate ${item.replicate} chapter ${item.chapter} (${sideName(item.side)} copy only)`)),
    `- Exchanges with at least one invalid dimension: ${invalidExchanges} of ${report.exchanges.length}`,
    '',
  ];
  return lines.join('\n');
}

const sha256 = text => createHash('sha256').update(text).digest('hex');
const allInvalid = () => Object.fromEntries(DIMENSIONS.map(dimension => [dimension, 'invalid']));

async function readAnswers(path) {
  const invalid = detail => fail('INVALID_ANSWERS', `Answers file ${path} ${detail}`);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw invalid('is unreadable or not valid JSON');
  }
  if (!isRecord(parsed) || Object.values(parsed).some(value => typeof value !== 'string')) {
    throw invalid('must be a JSON object mapping request ids to answer text');
  }
  return parsed;
}

function buildExchanges(scheduled, family) {
  return scheduled.map(({ a, b, ...rest }) => {
    const request = buildJudgeRequest({ family, a, b });
    return { ...rest, request, id: deriveRequestFingerprint(request) };
  });
}

async function answerExchange(provider, exchange) {
  const response = await provider.complete(exchange.request);
  if (typeof response?.text !== 'string') throw new Error('judge returned no text');
  return {
    id: exchange.id,
    replicate: exchange.replicate,
    chapter: exchange.chapter,
    order: exchange.order,
    answerSha256: sha256(response.text),
    verdict: parseVerdict(response.text),
  };
}

async function judgeLocal(exchanges, provider) {
  const judge = withJsonRepair(provider);
  const results = [];
  for (const exchange of exchanges) {
    try {
      results.push(await answerExchange(judge, exchange));
    } catch (error) {
      const { id, replicate, chapter, order } = exchange;
      results.push({ id, replicate, chapter, order, answerSha256: null, verdict: allInvalid(), error: error.message });
    }
  }
  return { results, pending: [] };
}

async function judgeRelay(exchanges, answers) {
  const pass = async relay => {
    const judge = withJsonRepair(relay);
    const results = [];
    for (const exchange of exchanges) {
      try {
        results.push(await answerExchange(judge, exchange));
      } catch (error) {
        if (!(error instanceof PendingModelWork)) throw error;
      }
    }
    return results;
  };
  const { result, pending } = await runWithRelay(pass, async () => ({}), { answers });
  return { results: result, pending };
}

function localProvider({ provider, env, timeoutMs }) {
  if (provider) return provider;
  const baseUrl = env.VIBELORE_LOCAL_BASE_URL;
  const model = env.VIBELORE_LOCAL_MODEL;
  return baseUrl && model ? createLocalOpenAIProvider({ baseUrl, model, timeoutMs }) : null;
}

function pairOutcomes(first, second) {
  const sidesFirst = mapToSides(first.verdict, first.order);
  const sidesSecond = mapToSides(second.verdict, second.order);
  return Object.fromEntries(DIMENSIONS.map(dimension => [dimension, {
    ...combineOrders(sidesFirst[dimension], sidesSecond[dimension]),
    letters: [first.verdict[dimension], second.verdict[dimension]],
  }]));
}

function judgedPairs(results) {
  const byPair = new Map();
  for (const result of results) {
    const key = `${result.replicate}:${result.chapter}`;
    byPair.set(key, { ...byPair.get(key), replicate: result.replicate, chapter: result.chapter, [result.order]: result });
  }
  return [...byPair.values()].map(({ replicate, chapter, ...orders }) => ({
    replicate, chapter, outcomes: pairOutcomes(orders['off-first'], orders['on-first']),
  }));
}

async function patternLedgerMetrics({ sets, pairs, exchanges }) {
  const metrics = [];
  for (let index = 0; index < pairs.length; index += 1) {
    const replicate = index + 1;
    const chapters = [...new Set(exchanges.filter(item => item.replicate === replicate).map(item => item.chapter))];
    metrics.push({
      replicate,
      off: await ledgerMetric({ root: sets[index].off.root, chapters }),
      on: await ledgerMetric({ root: sets[index].on.root, chapters }),
    });
  }
  return metrics;
}

async function buildReport({ args, family, sets, pairs, plan, exchanges, results, judge, now }) {
  const judged = judgedPairs(results);
  const report = {
    protocolVersion: PROTOCOL_VERSION,
    createdAt: now().toISOString(),
    feature: args.feature ?? null,
    language: args.language,
    promptFamily: family,
    inputs: args.off.map((off, index) => ({ replicate: index + 1, off, on: args.on[index] })),
    chapterFilter: args.chapters ?? null,
    judge,
    exchanges: results,
    chapters: judged.map(({ replicate, chapter, outcomes }) => ({
      replicate,
      chapter,
      sha256: { off: pairs[replicate - 1].off.get(chapter).sha256, on: pairs[replicate - 1].on.get(chapter).sha256 },
      outcomes: Object.fromEntries(DIMENSIONS.map(dimension => [dimension, { outcome: outcomes[dimension].outcome, score: outcomes[dimension].score }])),
    })),
    aggregate: aggregate(judged.map(item => item.outcomes)),
    metrics: {
      length: lengthMetrics({ pairs, exchanges: plan.exchanges }),
      patternLedger: await patternLedgerMetrics({ sets, pairs, exchanges }),
    },
    identical: plan.identical,
    unpaired: plan.unpaired,
    caveats: [],
  };
  report.caveats = buildCaveats(report);
  return report;
}

function judgeDescription({ provider, args }) {
  const provenance = provider ? provider.provenance : createHostRelay({}).provenance;
  const providerKind = provider ? 'local' : 'host-relay';
  const model = provider ? provenance.model : undefined;
  return {
    providerKind,
    ...(model ? { model } : {}),
    declaredLabel: args.judgeLabel ?? null,
    contextIsolation: provenance.contextIsolation,
    independence: independenceLabel({ providerKind, judgeModel: model, writerModel: args.writerModel }),
  };
}

async function writeNeedsModel({ outDir, pending }) {
  const requestsPath = join(outDir, 'requests.json');
  await Promise.all([rm(join(outDir, 'report.json'), { force: true }), rm(join(outDir, 'report.md'), { force: true })]);
  await writeFile(requestsPath, JSON.stringify({ status: 'needs_model', requests: pending, instruction: REQUESTS_INSTRUCTION }, null, 2));
  return { status: 'needs_model', exitCode: 2, outDir, requestsPath, pending: pending.length };
}

async function writeReport({ outDir, report }) {
  const reportPath = join(outDir, 'report.json');
  await rm(join(outDir, 'requests.json'), { force: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await writeFile(join(outDir, 'report.md'), renderReportMarkdown(report));
  return { status: 'report', exitCode: 0, outDir, reportPath };
}

export async function runPairwiseEvaluation({
  off, on, out, language, chapters, answers, feature, judgeLabel, writerModel, timeoutMs,
  env = process.env, provider = null, now = () => new Date(),
}) {
  const args = { off, on, out, language, chapters, answers, feature, judgeLabel, writerModel };
  if (!Array.isArray(off) || !off.length || !Array.isArray(on) || off.length !== on.length) {
    throw fail('PAIR_COUNT_MISMATCH', '--off and --on must be given the same non-zero number of times');
  }
  if (!out) throw fail('MISSING_ARGUMENT', 'missing required argument --out');
  const family = judgeFamilyFor(language);
  const range = parseChapterRange(chapters);
  const givenAnswers = answers ? await readAnswers(answers) : {};
  await assertOutPath({ out, inputRoots: [...off, ...on], repoRoot: REPO_ROOT });

  const sets = [];
  for (let index = 0; index < off.length; index += 1) {
    sets.push({ off: await readChapterSet(off[index]), on: await readChapterSet(on[index]) });
  }
  const pairs = sets.map(set => ({ off: set.off.chapters, on: set.on.chapters }));
  const plan = schedulePairs({ pairs, chapters: range });
  const exchanges = buildExchanges(plan.exchanges, family);

  const outDir = resolve(out);
  await mkdir(outDir, { recursive: true });
  await assertOutPath({ out: outDir, inputRoots: [...off, ...on], repoRoot: REPO_ROOT });

  const local = localProvider({ provider, env, timeoutMs });
  const { results, pending } = local ? await judgeLocal(exchanges, local) : await judgeRelay(exchanges, givenAnswers);
  if (pending.length) return writeNeedsModel({ outDir, pending });
  const report = await buildReport({
    args, family, sets, pairs, plan, exchanges, results, judge: judgeDescription({ provider: local, args }), now,
  });
  return writeReport({ outDir, report });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const { timeoutMs, ...args } = parseCliArgs(argv);
    const result = await runPairwiseEvaluation({ ...args, timeoutMs, env });
    if (result.status === 'needs_model') {
      console.log(`needs_model: ${result.pending} pending request(s) written to ${result.requestsPath}`);
    } else {
      console.log(`report written: ${result.reportPath}`);
    }
    return result.exitCode;
  } catch (error) {
    console.error(`${error.code ?? 'ERROR'}: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await main());
}
