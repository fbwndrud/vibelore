import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runWebtoonSceneTool } from '../src/tools/webtoon-scene.js';
import { runConfigureStatus } from '../src/tools/configure.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';
import { CompositionStore } from '../src/store/webtoon-composition-store.js';
import { compositionFingerprint } from '../src/core/webtoon-composition.js';
import { buildIndex } from '../src/core/webtoon-composition-aggregate.js';
import { RETRY_FRAMING, isEnglish } from '../src/core/webtoon-scene.js';
import { loadWebtoonCompositionConfig } from '../src/core/review-policy.js';
import { DEFAULT_COMPOSITION_CONFIG, DEFAULT_PRIOR, compositionDigest, compositionAdvisory } from '../src/core/webtoon-composition-digest.js';
import { sceneSetup, scenePlan, scenePreflight, sceneCompositionCheck } from './fixtures/webtoon-scene.js';
import { workId } from './fixtures/webtoon.js';

const label = (over = {}, subject = {}) => ({ shot: 'MS', angle: 'eye', focal: 'face', background: 'detailed',
  subjects: [{ id: 'hero', visibility: 'face', side: 'L', facing: 'R', expression: 'neutral', ...subject }], ...over });
const subject = (id, over = {}) => ({ id, visibility: 'face', side: 'L', facing: 'R', expression: 'neutral', ...over });
/** Rows of one adopted scene: a page plus one panel row per label; the last panel closes the page. */
const sceneRows = (episodeKey, sceneKey, labels) => [
  { type: 'page', workflowId: `wt-${sceneKey}`, revision: 1, sceneKey, episodeKey, status: 'adopted', adoptedAt: '2026-11-01T00:00:00.000Z',
    layout: 'grid', openPanel: 1, closePanel: labels.length, sceneType: 'dialogue', references: [] },
  ...labels.map((l, i) => ({ type: 'panel', workflowId: `wt-${sceneKey}`, revision: 1, sceneKey, episodeKey, panel: i + 1, status: 'adopted', vocabVersion: 1,
    source: 'plan', confidence: 'clear', label: l, required: [], directed: false, fingerprint: compositionFingerprint(l) }))];
const keyOf = e => `ep-${String(e + 1).padStart(4, '0')}`;
/** `episodes`: one array of scenes per episode; a scene is an array of panel labels. */
const indexOf = (episodes, options = { protagonistIds: ['hero'] }) => buildIndex(
  episodes.map((scenes, e) => ({ episodeKey: keyOf(e), rows: scenes.flatMap((labels, s) => sceneRows(keyOf(e), `s${e}-${s}`, labels)) })), options);
/** `face` labels with the lead's face visible, then `back` labels with the lead seen from behind. */
const mix = (face, back) => [...Array(face).fill(0).map(() => label()), ...Array(back).fill(0).map(() => label({}, { visibility: 'back' }))];
const noNulls = value => { const text = JSON.stringify(value); assert.ok(!/\bnull\b|NaN/.test(text), text); };
const unsafe = line => !isEnglish(line) || RETRY_FRAMING.test(line);
const base = { requiredLocks: [], seed: 'wt-1', config: DEFAULT_COMPOSITION_CONFIG };

test('defaults carry the specified thresholds and every prior table is a share table', () => {
  assert.deepEqual(DEFAULT_COMPOSITION_CONFIG, { shortWindowEpisodes: 2, shortWindowScenes: 6, overuseDelta: 0.20, overuseMinCount: 4,
    streakLength: 3, observedBasisRate: 0.40, protagonistIds: [] });
  assert.ok(Object.keys(DEFAULT_PRIOR).length >= 6);
  for (const [field, table] of Object.entries(DEFAULT_PRIOR)) {
    const sum = Object.values(table).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${field} sums to ${sum}`);
  }
});

// Baseline: three episodes with the lead's face in half the panels; short window: the last two episodes.
const banded = shortScenes => indexOf([0, 1, 2].map(() => [mix(2, 2)]).concat(shortScenes.map(scene => [scene])));

test('a share jump of at least the delta with enough panels is overused', () => {
  const result = compositionDigest(banded([mix(4, 1), mix(4, 1)]), { ...base, episodeKey: 'ep-0005', castIds: ['hero'] });
  const hit = result.overused.find(o => o.field === 'protagonistVisibility' && o.value === 'face');
  assert.ok(hit, JSON.stringify(result.overused));
  assert.equal(hit.shortCount, 8);
  assert.equal(hit.shortShare, 0.8);
  assert.equal(hit.baselineShare, 0.5);
  assert.equal(hit.basis, 'baseline');
  assert.ok(result.lines.some(line => /hero/.test(line)));
});

test('the same shares with a count of three are not overused', () => {
  const result = compositionDigest(banded([mix(2, 0), mix(1, 1)]), { ...base, episodeKey: 'ep-0005', castIds: ['hero'] });
  assert.equal(result.overused.find(o => o.field === 'protagonistVisibility'), undefined, JSON.stringify(result.overused));
});

test('a short baseline falls back to the prior shares', () => {
  const result = compositionDigest(indexOf([[mix(6, 0)], [mix(6, 0)]]), { ...base, episodeKey: 'ep-0002', castIds: [] });
  const hit = result.overused.find(o => o.field === 'shot' && o.value === 'MS');
  assert.ok(hit, JSON.stringify(result.overused));
  assert.equal(hit.baselineShare, DEFAULT_PRIOR.shot.MS);
  assert.equal(hit.basis, 'prior');
});

test('a single-episode work windows the last six scenes', () => {
  const calm = [1, 2, 3, 4].map(() => [label({ shot: 'WS' }), label({ shot: 'WS' })]);
  const heavy = [1, 2, 3, 4, 5, 6].map(() => [label({ shot: 'CU' }), label({ shot: 'CU' })]);
  const result = compositionDigest(indexOf([[...calm, ...heavy]]), { ...base, episodeKey: 'ep-0001', castIds: [] });
  const hit = result.overused.find(o => o.field === 'shot' && o.value === 'CU');
  assert.ok(hit, JSON.stringify(result.overused));
  assert.equal(hit.shortCount, 12);
  assert.equal(hit.shortShare, 1, 'the calm scenes before the window are not counted in it');
  assert.equal(hit.basis, 'prior');
});

const closing = angle => [label({ shot: 'WS', angle }), label({ shot: 'ECU', angle }, { id: 'draco', side: 'R' })];

test('three consecutive pages closing on the same framing give one streak line', () => {
  const index = indexOf([[closing('eye')], [closing('low')], [closing('top')]]);
  const result = compositionDigest(index, { ...base, episodeKey: 'ep-0003', castIds: ['hero', 'draco'] });
  assert.equal(result.streaks.length, 1, JSON.stringify(result.streaks));
  assert.deepEqual({ kind: result.streaks[0].kind, key: result.streaks[0].key, length: result.streaks[0].length }, { kind: 'pageClose', key: 'ECU|draco', length: 3 });
  assert.equal(result.lines.filter(line => /draco/.test(line) && /3 pages/.test(line)).length, 1, result.lines.join('\n'));
});

test('two pages are not a streak, and a streak must run to the latest page', () => {
  const close = (shot, angle) => [label({ shot, angle })];
  const two = indexOf([[close('ECU', 'eye')], [close('ECU', 'low')]]);
  assert.deepEqual(compositionDigest(two, { ...base, episodeKey: 'ep-0002', castIds: [] }).streaks, []);
  const broken = indexOf([[close('ECU', 'eye')], [close('ECU', 'low')], [close('ECU', 'top')], [close('WS', 'eye')]]);
  assert.deepEqual(compositionDigest(broken, { ...base, episodeKey: 'ep-0004', castIds: [] }).streaks, []);
});

test('streak kinds are capped at two', () => {
  const pair = [label({ shot: 'ECU' }, { side: 'R' }), label({ shot: 'ECU' }, { side: 'R' })];
  for (const l of pair) l.subjects.push(subject('draco', { side: 'L' }));
  const result = compositionDigest(indexOf([[pair], [pair], [pair], [pair]]), { ...base, episodeKey: 'ep-0004', castIds: [] });
  assert.deepEqual(result.streaks.map(s => s.kind), ['pageClose', 'twoShotSide']);
});

test('a repeated framing alone is a fingerprint streak', () => {
  const varyClose = n => [label({ shot: 'CU' }), label({ shot: ['ECU', 'WS', 'FS'][n], angle: 'low' })];
  const result = compositionDigest(indexOf([[varyClose(0)], [varyClose(1)], [varyClose(2)]]), { ...base, episodeKey: 'ep-0003', castIds: [] });
  assert.deepEqual(result.streaks.map(s => s.kind), ['fingerprint']);
});

const varied = () => indexOf([[mix(6, 0)], [mix(6, 0)], [mix(6, 0)], [mix(6, 0)]]);
const menuOf = (seed, extra = {}) => compositionDigest(varied(), { ...base, episodeKey: 'ep-0004', castIds: ['hero', 'draco', 'mira'], seed, ...extra }).menu;

test('the menu is reproducible for a seed and can differ between seeds', () => {
  assert.deepEqual(menuOf('wt-a:1'), menuOf('wt-a:1'));
  assert.ok(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(seed => JSON.stringify(menuOf(seed)))).size > 1);
  for (const seed of ['a', 'b', 'c', 'd']) {
    const menu = menuOf(seed);
    assert.ok(menu.length >= 2 && menu.length <= 3, JSON.stringify(menu));
    assert.equal(new Set(menu.map(o => o.field)).size, menu.length, 'one option per field');
  }
});

test('menu options never touch a locked field or a subject outside the cast', () => {
  const crowd = indexOf([0, 1, 2, 3].map(() => [[label({}, {}), { ...label({ focal: 'two-face' }), subjects: [subject('hero'), subject('draco', { side: 'R' }), subject('mira', { side: 'C' })] }]]));
  const seen = new Set();
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    const locked = compositionDigest(crowd, { ...base, episodeKey: 'ep-0004', castIds: ['hero', 'draco'], seed, requiredLocks: ['shot', 'angle', 'background'] }).menu;
    assert.ok(locked.every(o => !['shot', 'angle', 'background'].includes(o.field)), JSON.stringify(locked));
    const cast = compositionDigest(crowd, { ...base, episodeKey: 'ep-0004', castIds: ['mira'], seed }).menu;
    for (const o of cast.filter(o => o.field === 'subject')) { assert.equal(o.value, 'mira'); seen.add(seed); }
  }
  assert.ok(seen.size > 0, 'a subject option is offered for some seed');
});

test('with every menu field locked there is no menu', () => {
  const result = compositionDigest(varied(), { ...base, episodeKey: 'ep-0004', castIds: ['hero'], requiredLocks: ['shot', 'angle', 'focal', 'background', 'subject'] });
  assert.deepEqual(result.menu, []);
  assert.ok(!result.lines.some(line => /Fresh options/.test(line)));
});

test('with a single free field there is no menu either', () => {
  const result = compositionDigest(varied(), { ...base, episodeKey: 'ep-0004', castIds: [], requiredLocks: ['angle', 'focal', 'background', 'subject'] });
  assert.deepEqual(result.menu, []);
});

test('menu options come from the least used values of the long baseline', () => {
  const heavy = [0, 1, 2, 3, 4].map(() => [[label({ shot: 'CU' }), label({ shot: 'CU' }), label({ shot: 'CU' }), label({ shot: 'MS' })]]);
  for (const seed of ['a', 'b', 'c', 'd', 'e']) {
    const menu = compositionDigest(indexOf(heavy), { ...base, episodeKey: 'ep-0005', castIds: [], seed, requiredLocks: ['focal', 'background', 'subject'] }).menu;
    assert.ok(menu.length >= 2);
    for (const option of menu.filter(o => o.field === 'shot')) assert.ok(!['CU', 'MS'].includes(option.value), option.value);
  }
});

test('every line stays within eight, positive English, with bounded groups', () => {
  const noisy = label({ shot: 'ECU', angle: 'low' }, { id: 'no-one' });
  const episodes = [[mix(2, 0)], [mix(2, 0)], [mix(2, 0)], [[noisy, noisy, noisy, noisy]], [[noisy, noisy, noisy, noisy]], [[noisy, noisy, noisy, noisy]], [[noisy, noisy, noisy, noisy]]];
  for (const castIds of [[], ['hero', 'no-one', 'draco']]) for (const seed of ['a', 'b', 'c']) {
    const result = compositionDigest(indexOf(episodes), { ...base, episodeKey: 'ep-0007', castIds, seed, basisStats: { corrected: 9, total: 10 } });
    assert.ok(result.lines.length >= 3 && result.lines.length <= 8, result.lines.join('\n'));
    assert.ok(result.overused.length <= 3 && result.streaks.length <= 2);
    assert.ok(result.menu.length === 0 || (result.menu.length >= 2 && result.menu.length <= 3));
    for (const line of result.lines) assert.ok(!unsafe(line), line);
    for (const option of result.menu) assert.ok(!unsafe(option.text), option.text);
    assert.ok(result.streaks.length > 0 && result.lines.some(line => /a character/.test(line)), 'an unsafe id is replaced, not printed');
  }
});

test('a subject id that would read as retry framing is never offered', () => {
  const menu = menuOf('a', { castIds: ['avoid-it', 'not-here'] });
  assert.ok(menu.every(o => o.field !== 'subject'), JSON.stringify(menu));
});

test('an empty index gives finite, null-free output with a prior-based menu', () => {
  const result = compositionDigest(buildIndex([]), { ...base, episodeKey: 'ep-0001', castIds: [] });
  assert.deepEqual(result.overused, []);
  assert.deepEqual(result.streaks, []);
  assert.ok(result.menu.length >= 2);
  assert.ok(result.lines.length <= 8);
  noNulls(result);
});

test('an all-unclear history uses the prior and stays finite', () => {
  const unclear = e => sceneRows(keyOf(e), `u${e}`, [label(), label()]).map(r => r.type === 'panel' ? { ...r, confidence: 'unclear' } : r);
  const index = buildIndex([0, 1, 2, 3].map(e => ({ episodeKey: keyOf(e), rows: unclear(e) })), { protagonistIds: ['hero'] });
  const result = compositionDigest(index, { ...base, episodeKey: 'ep-0004', castIds: ['hero'] });
  assert.deepEqual(result.overused, []);
  assert.deepEqual(result.streaks, []);
  assert.ok(result.menu.length >= 2);
  noNulls(result);
  assert.equal(compositionAdvisory(index, { episodeKey: 'ep-0004', config: DEFAULT_COMPOSITION_CONFIG }), null);
});

test('a source with no cast applies no subject filter and stays finite', () => {
  const index = indexOf([[mix(2, 0)], [mix(2, 0)], [mix(2, 0)]]);
  for (const castIds of [undefined, []]) {
    const result = compositionDigest(index, { episodeKey: 'ep-0003', castIds, requiredLocks: undefined, seed: 'k', config: undefined });
    noNulls(result);
    assert.ok(result.menu.length >= 2);
  }
});

test('the corrected-history flag follows the basis stats and the configured rate', () => {
  const ask = basisStats => compositionDigest(varied(), { ...base, episodeKey: 'ep-0004', castIds: [], basisStats });
  assert.equal(ask({ corrected: 5, total: 10 }).basis.observationCorrected, true);
  assert.ok(ask({ corrected: 5, total: 10 }).lines.some(line => /review/.test(line)));
  assert.equal(ask({ corrected: 4, total: 10 }).basis.observationCorrected, false);
  assert.equal(ask({ corrected: 2, total: 2 }).basis.observationCorrected, false, 'too few panels to say');
  assert.equal(ask(undefined).basis.observationCorrected, false);
  assert.ok(!ask({ corrected: 4, total: 10 }).lines.some(line => /review/.test(line)));
  noNulls(ask(undefined));
});

test('the advisory fires on a streak or overuse, and is silent otherwise', () => {
  const streak = compositionAdvisory(indexOf([[closing('eye')], [closing('low')], [closing('top')]]), { episodeKey: 'ep-0003', config: DEFAULT_COMPOSITION_CONFIG });
  assert.equal(streak.severity, 'advisory');
  assert.equal(streak.category, 'composition');
  assert.equal(streak.code, 'COMPOSITION_REPETITION');
  assert.ok(streak.evidence.length > 0 && !unsafe(streak.evidence));
  const overuse = compositionAdvisory(banded([mix(4, 1), mix(4, 1)]), { episodeKey: 'ep-0005', config: DEFAULT_COMPOSITION_CONFIG });
  assert.equal(overuse.code, 'COMPOSITION_REPETITION');
  const calm = indexOf([[[label({ shot: 'ECU' })]], [[label({ shot: 'WS' })]]]);
  assert.equal(compositionAdvisory(calm, { episodeKey: 'ep-0002', config: DEFAULT_COMPOSITION_CONFIG }), null);
  assert.equal(compositionAdvisory(buildIndex([]), { episodeKey: 'ep-0001', config: DEFAULT_COMPOSITION_CONFIG }), null);
});

// ---- configuration -------------------------------------------------------

test('composition settings default, merge field by field, and are validated', async () => {
  const { store } = await sceneSetup();
  assert.deepEqual(await loadWebtoonCompositionConfig(store, workId), DEFAULT_COMPOSITION_CONFIG);
  await runConfigureStatus({ store, workId, webtoonComposition: { streakLength: 4, protagonistIds: ['hero'] } });
  assert.deepEqual(await loadWebtoonCompositionConfig(store, workId), { ...DEFAULT_COMPOSITION_CONFIG, streakLength: 4, protagonistIds: ['hero'] });
  await runConfigureStatus({ store, workId, webtoonComposition: { overuseDelta: 0.3 } });
  assert.deepEqual(await loadWebtoonCompositionConfig(store, workId), { ...DEFAULT_COMPOSITION_CONFIG, streakLength: 4, overuseDelta: 0.3, protagonistIds: ['hero'] });
  assert.equal((await runConfigureStatus({ store, workId })).webtoonComposition.streakLength, 4);
  for (const bad of [{ streakLength: 1 }, { streakLength: 2.5 }, { overuseDelta: 0 }, { overuseDelta: 1.5 }, { overuseMinCount: 0 }, { shortWindowEpisodes: 0 },
    { shortWindowScenes: 'six' }, { observedBasisRate: -0.1 }, { protagonistIds: 'hero' }, { protagonistIds: ['bad id'] }, { unknown: 1 }, 'x', []]) {
    await assert.rejects(runConfigureStatus({ store, workId, webtoonComposition: bad }), /INVALID_WEBTOON_COMPOSITION/, JSON.stringify(bad));
  }
  assert.equal((await loadWebtoonCompositionConfig(store, workId)).streakLength, 4, 'a rejected change stores nothing');
  await runConfigureStatus({ store, workId, webtoonComposition: null });
  assert.deepEqual(await loadWebtoonCompositionConfig(store, workId), DEFAULT_COMPOSITION_CONFIG);
});

test('composition-ledger is a switchable review', async () => {
  const { store } = await sceneSetup();
  const status = await runConfigureStatus({ store, workId, disabledReviews: ['composition-ledger'] });
  assert.deepEqual(status.reviewPolicy.disabled, ['composition-ledger']);
  assert.ok(status.reviewPolicy.available.includes('composition-ledger'));
});

// ---- tool integration ----------------------------------------------------

const checkNames = ['reflectionGeometry', 'propStructure', 'handsAndContact', 'withinSceneContinuity', 'layoutAndTiming'];
const checks = () => Object.fromEntries(checkNames.map(key => [key, { status: 'not_applicable', panels: [], evidence: 'Synthetic protocol fixture.' }]));
const requests = [];
const planner = { async complete(req) {
  requests.push(req);
  const d = JSON.parse(req.messages.at(-1).content);
  return { text: JSON.stringify(req.step === 'webtoon-scene-plan' ? scenePlan(d.source) : scenePreflight(d)) };
} };
const assetFor = (args, job) => ({ path: args.references[0].path, inputHash: job.inputHash,
  provenance: { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: 'selected-api' } });
const answer = q => {
  const d = JSON.parse(q.user);
  return { ...d.schema, ...sceneCompositionCheck(d.schema.compositionCheck), visualChecks: checks(), inspectedImages: true, observedPanelCount: d.requestedPanelCount,
    spatialCoherence: true, readingOrder: true, evidence: 'Synthetic protocol receipt.', findings: [],
    textObservations: d.plan.texts.map(t => ({ id: t.id, observedText: t.text, readable: true, speakerCorrect: true, evidence: 'Synthetic text.' })) };
};
const finish = async (store, args, drawn) => {
  const pending = await runWebtoonSceneTool({ store, args: { workId, asset: assetFor(args, drawn.jobs[0]) }, providers: createHostRelay() });
  const q = pending.requests[0], run = await loadRun(store.rootDir, pending.runId);
  return runWebtoonSceneTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(answer(q)) }) });
};
/** Two earlier adopted pages in the episode that close on the same plain medium shot the fixture scene closes on. */
const seedHistory = async repo => {
  const plain = angle => ({ shot: 'MS', angle, focal: 'space', background: 'detailed', subjects: [] });
  const rows = [1, 2].flatMap(n => sceneRows('ep-0001', `seed-${n}`, [plain(n === 1 ? 'high' : 'low'), plain(n === 1 ? 'low' : 'high')]));
  const path = repo.path('composition', 'l0', 'ep-0001.jsonl');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
};

test('scene_generate stores a digest for a v1 workflow but never sends it', async () => {
  requests.length = 0;
  const { store, repo, args } = await sceneSetup();
  await seedHistory(repo);
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: planner });
  const w = await repo.load();
  assert.equal(w.compositionVersion, 1);
  assert.ok(Array.isArray(w.compositionDigest.lines));
  assert.ok(w.compositionDigest.menu.length >= 2);
  assert.equal(w.compositionDigestError, undefined);
  assert.ok(requests.length >= 2);
  for (const request of requests) {
    const data = JSON.parse(request.messages.at(-1).content), text = JSON.stringify(request);
    assert.ok(!('compositionDigest' in data) && !('compositionDigest' in (data.schema ?? {})), request.step);
    for (const line of w.compositionDigest.lines) assert.ok(!text.includes(line), `${request.step} carries a digest line`);
  }
  assert.ok(w.compositionDigest.lines.length > 0);
  assert.ok(!JSON.stringify(drawn).includes('compositionDigest'));
});

test('a corrupt shard never blocks generation and leaves an inspectable reason', async () => {
  const { store, repo, args } = await sceneSetup();
  await seedHistory(repo);
  const path = repo.path('composition', 'l0', 'ep-0001.jsonl');
  await writeFile(path, (await readFile(path, 'utf8')).slice(0, -9));
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: planner });
  assert.equal(drawn.status, 'needs_scene_image');
  const w = await repo.load();
  assert.equal(w.compositionDigest, undefined);
  assert.match(w.compositionDigestError, /CORRUPT_COMPOSITION_SHARD/);
});

test('a workflow that started without composition gets no digest and no error', async () => {
  const { store, repo, args } = await sceneSetup();
  await seedHistory(repo);
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: { async complete() { throw new Error('model unavailable'); } } }), /model unavailable/);
  const w = await repo.load();
  assert.ok(w.compositionDigest, 'the v1 workflow computed a digest before asking the model');
  delete w.compositionVersion; delete w.compositionDefaults; delete w.unmergedSceneReferences; delete w.compositionDigest; delete w.pending; w.direction = args.direction;
  await repo.save(w);
  const result = await runWebtoonSceneTool({ store, args: { workId, action: 'retry' }, providers: planner });
  assert.equal(result.status, 'needs_scene_image');
  const after = await repo.load();
  assert.equal('compositionDigest' in after, false);
  assert.equal('compositionDigestError' in after, false);
});

test('a repeated closing frame attaches the advisory after adoption without touching the verdict', async () => {
  const { store, repo, args } = await sceneSetup();
  await seedHistory(repo);
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: planner });
  const done = await finish(store, args, drawn);
  assert.equal(done.status, 'completed');
  const w = await repo.load();
  assert.equal(w.visualReview.passed, true);
  const found = w.visualReview.findings.filter(f => f.code === 'COMPOSITION_REPETITION');
  assert.equal(found.length, 1, JSON.stringify(w.visualReview.findings));
  assert.equal(found[0].severity, 'advisory');
  assert.equal(found[0].category, 'composition');
  assert.ok(JSON.parse(await readFile(w.artifacts['image-review.json'].path, 'utf8')).findings.some(f => f.code === 'COMPOSITION_REPETITION'));
});

test('the advisory is suppressed when composition-ledger is disabled', async () => {
  const { store, repo, args } = await sceneSetup();
  await seedHistory(repo);
  await runConfigureStatus({ store, workId, disabledReviews: ['composition-ledger'] });
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: planner });
  const done = await finish(store, args, drawn);
  assert.equal(done.status, 'completed');
  const w = await repo.load();
  assert.equal(w.visualReview.passed, true);
  assert.ok(!w.visualReview.findings.some(f => f.code === 'COMPOSITION_REPETITION'));
});

test('configured protagonist ids reach the adopted index', async () => {
  const { store, repo, args } = await sceneSetup();
  await runConfigureStatus({ store, workId, webtoonComposition: { protagonistIds: ['hero'] } });
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: planner });
  await finish(store, args, drawn);
  const index = await new CompositionStore(repo).peekIndex({ protagonistIds: ['hero'] });
  assert.ok(index, 'the index was written for the configured ids');
  assert.deepEqual(index.configured, ['hero']);
});

test('the advisory never reaches the plan or review requests of a scene that continues from it', async () => {
  requests.length = 0;
  const { store, repo, args } = await sceneSetup();
  await seedHistory(repo);
  const start = { ...args, autoRevisions: 0 };
  const drawn = await runWebtoonSceneTool({ store, args: { ...start, sourceUnitIds: ['ch-1-p-1'] }, providers: planner });
  const first = await finish(store, args, drawn);
  assert.equal(first.status, 'completed');
  const advisory = (await repo.load(first.workflowId)).visualReview.findings.find(f => f.code === 'COMPOSITION_REPETITION');
  assert.ok(advisory, 'the first scene carries the advisory');
  requests.length = 0;
  const next = await runWebtoonSceneTool({ store, args: { ...start, previousWorkflowId: first.workflowId, sourceUnitIds: ['ch-1-p-2'] }, providers: planner });
  assert.equal(next.status, 'needs_scene_image');
  const pending = await runWebtoonSceneTool({ store, args: { workId, asset: assetFor(args, next.jobs[0]) }, providers: createHostRelay() });
  const q = pending.requests[0];
  assert.equal(q.step, 'webtoon-scene-image-review');
  const sent = [...requests, q];
  assert.ok(sent.some(r => JSON.parse(r.user ?? r.messages.at(-1).content).previousScene), 'the continuation sends previousScene');
  for (const request of sent) {
    const text = JSON.stringify(request);
    assert.ok(!text.includes('COMPOSITION_REPETITION') && !text.includes(advisory.evidence), request.step);
  }
  const w = await repo.load();
  assert.equal(w.previousScene.reviewPassed, true);
  assert.ok(!w.previousScene.findings.some(f => f.category === 'composition'));
});
