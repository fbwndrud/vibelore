import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositionStore, sceneKey } from '../src/store/webtoon-composition-store.js';
import { COMPOSITION_VOCAB, compositionFingerprint } from '../src/core/webtoon-composition.js';
import { compositionDigest, DEFAULT_COMPOSITION_CONFIG } from '../src/core/webtoon-composition-digest.js';
import { addVector, buildIndex, emptyVector, protagonistIdsFor, sceneSummary, subVector, windowCounts } from '../src/core/webtoon-composition-aggregate.js';

const repoAt = async () => { const dir = await mkdtemp(join(tmpdir(), 'vl-comp-')); return { dir, path: (...p) => join(dir, ...p) }; };
const label = (over = {}) => ({ shot: 'MS', angle: 'eye', focal: 'face', background: 'detailed',
  subjects: [{ id: 'hero', visibility: 'face', side: 'L', facing: 'R', expression: 'neutral' }], ...over });
const panelRow = (n, over = {}, labelOver = {}) => {
  const l = label(labelOver);
  return { type: 'panel', workflowId: 'wt-a', revision: 1, reviewVersion: 2, sceneKey: 's1', episodeKey: 'ep-0001', panel: n, status: 'adopted',
    vocabVersion: 1, source: 'plan', confidence: 'clear', label: l, required: [], directed: false, fingerprint: compositionFingerprint(l), ...over };
};
const pageRow = (over = {}) => ({ type: 'page', workflowId: 'wt-a', revision: 1, reviewVersion: 2, sceneKey: 's1', episodeKey: 'ep-0001', status: 'adopted',
  adoptedAt: '2026-11-01T00:00:00.000Z', layout: 'grid', openPanel: 1, closePanel: 6, sceneType: 'dialogue', references: [], ...over });
const total = v => Object.values(v.shot).reduce((a, b) => a + b, 0);

test('a scene summary counts only adopted, clear, mapped, labelled, non-required panels', () => {
  const rows = [pageRow(),
    panelRow(1),
    panelRow(2, { status: 'rejected' }),
    panelRow(3, { status: 'superseded' }),
    panelRow(4, { confidence: 'unclear' }),
    panelRow(5, { vocabVersion: 99 }),
    panelRow(6, { label: null, fingerprint: null }),
    panelRow(7, { required: [{ kind: 'prop' }] }, { shot: 'CU' })];
  const s = sceneSummary(rows, { protagonistIds: ['hero'] });
  assert.equal(s.counts.panels, 1);
  assert.equal(total(s.counts), 1);
  assert.equal(s.counts.shot.MS, 1);
  assert.equal(s.counts.visibility.face, 1);
  assert.equal(s.counts.layout.grid, 1);
  assert.equal(s.counts.protagonistVisibility.face, 1);
  assert.equal(s.requiredCounts.panels, 1);
  assert.equal(s.requiredCounts.shot.CU, 1);
  assert.equal(s.counts.shot.CU, 0);
  assert.equal(s.sceneType, 'dialogue');
  assert.deepEqual(Object.keys(s.characters), ['hero']);
  assert.equal('characters' in buildIndex([{ episodeKey: 'ep-0001', rows }], {}).scenes['ep-0001:s1'], false, 'per-character vectors feed L3 only');
});

test('page close, fingerprints and the protagonist side in multi-subject panels are summarised', () => {
  const two = { subjects: [{ id: 'hero', visibility: 'face', side: 'R' }, { id: 'rival', visibility: 'back', side: 'L' }] };
  const rows = [pageRow({ closePanel: 2 }), panelRow(1), panelRow(2, {}, two)];
  const s = sceneSummary(rows, { protagonistIds: ['hero'] });
  assert.deepEqual(s.closes, ['MS|hero']);
  assert.equal(s.counts.pageClose['MS|hero'], 1);
  assert.equal(s.counts.twoShotSide.R, 1);
  assert.equal(s.counts.twoShotSide.L, 0, 'single-subject panels do not count');
  assert.equal(Object.keys(s.fingerprints).length, 2);
  assert.equal(s.characters.rival.visibility.back, 1);
});

test('vector add and subtract return new vectors and cancel out', () => {
  const a = sceneSummary([pageRow(), panelRow(1)], { protagonistIds: [] }).counts;
  const b = sceneSummary([pageRow(), panelRow(1, {}, { shot: 'WS' })], { protagonistIds: [] }).counts;
  const sum = addVector(a, b);
  assert.equal(sum.panels, 2);
  assert.deepEqual(subVector(sum, b), a);
  assert.deepEqual(addVector(emptyVector(), emptyVector()), emptyVector());
  assert.equal(a.panels, 1, 'inputs are untouched');
  assert.deepEqual(Object.keys(emptyVector().shot), [...COMPOSITION_VOCAB.shot]);
});

test('an empty, all-unclear or cast-less history yields finite numbers only', () => {
  const noRows = buildIndex([], { sourceHead: 'h' });
  const unclear = buildIndex([{ episodeKey: 'ep-0001', rows: [pageRow(), panelRow(1, { confidence: 'unclear' }), panelRow(2, { label: null, fingerprint: null })] }], { sourceHead: 'h' });
  const noCast = buildIndex([{ episodeKey: 'ep-0001', rows: [pageRow(), panelRow(1, {}, { subjects: [] })] }], { sourceHead: 'h' });
  for (const index of [noRows, unclear, noCast]) {
    const text = JSON.stringify(index);
    assert.ok(!/null|NaN|Infinity/.test(text.replace(/"sourceHead":"h"/, '')), text);
    assert.deepEqual(protagonistIdsFor(index, []), []);
    assert.equal(windowCounts(index, 0, 5).panels, index.prefix.at(-1).panels);
  }
  assert.deepEqual(noRows.prefix, [emptyVector()]);
  assert.equal(noCast.episodes['ep-0001'].panels, 1);
});

test('protagonist ids: configured wins, otherwise the most frequent subject', () => {
  const rows = [pageRow(), panelRow(1), panelRow(2), panelRow(3, {}, { subjects: [{ id: 'rival', visibility: 'face', side: 'L' }] })];
  const index = buildIndex([{ episodeKey: 'ep-0001', rows }], {});
  assert.deepEqual(protagonistIdsFor(index, ['rival']), ['rival']);
  assert.deepEqual(protagonistIdsFor(index, []), ['hero']);
  assert.deepEqual(index.protagonistIds, ['hero']);
  assert.equal(index.scenes['ep-0001:s1'].counts.protagonistVisibility.face, 2);
  const configured = buildIndex([{ episodeKey: 'ep-0001', rows }], { protagonistIds: ['rival'] });
  assert.equal(configured.scenes['ep-0001:s1'].counts.protagonistVisibility.face, 1);
});

const planned = (subjects = [{ id: 'hero', visibility: 'face', side: 'L' }], shot = 'MS') =>
  ({ composition: { shot, angle: 'eye', focal: 'face', background: 'detailed', subjects, directed: false } });
const fake = (workflowId, ep, units, extra = {}) => ({ workflowId, revision: 1, imageReviewVersion: 2, compositionVersion: 1, panelCount: 3,
  source: { kind: 'novel' }, sceneUnits: units.map(id => ({ id, chapter: ep })), sceneReferences: [], scenePlan: { sceneType: 'action' },
  preflight: { renderBrief: { pageComposition: { layout: 'grid' }, moments: [planned(), planned([{ id: 'rival', visibility: 'back', side: 'R' }], 'CU'), planned()] } },
  visualReview: { compositionCheck: [1, 2, 3].map(panel => ({ panel, result: 'match', observed: null, evidence: 'ok' })) }, ...extra });

const sameAsRebuild = async store => {
  const incremental = await store.peekIndex();
  assert.ok(incremental, 'index is fresh after adoption');
  const rebuilt = await store.rebuildIndex();
  assert.deepEqual(incremental, rebuilt);
  assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), rebuilt);
  return rebuilt;
};

test('adopting, readopting and rejecting scenes keeps the incremental index equal to a rebuild', async () => {
  const store = new CompositionStore(await repoAt());
  await store.adoptScene(fake('wt-a', 1, ['p1']), { adopted: true });
  await sameAsRebuild(store);
  await store.adoptScene(fake('wt-b', 1, ['p2']), { adopted: true });
  await store.adoptScene(fake('wt-c', 3, ['p9']), { adopted: true });
  await store.adoptScene(fake('wt-d', 2, ['p5']), { adopted: true });
  const before = await sameAsRebuild(store);
  assert.deepEqual(before.order, ['ep-0001', 'ep-0002', 'ep-0003']);
  assert.equal(before.episodes['ep-0001'].panels, 6);
  // readopt scene p1 with a different shot, then a rejected candidate of the same scene, then re-review of the same revision
  const changed = fake('wt-e', 1, ['p1'], { preflight: { renderBrief: { pageComposition: { layout: 'bleed' }, moments: [planned(undefined, 'WS'), planned(undefined, 'WS'), planned(undefined, 'WS')] } } });
  await store.adoptScene(changed, { adopted: true });
  const after = await sameAsRebuild(store);
  assert.equal(after.episodes['ep-0001'].shot.WS, 3);
  assert.equal(after.episodes['ep-0001'].layout.bleed, 1);
  await store.adoptScene(fake('wt-f', 1, ['p1']), { adopted: false });
  await sameAsRebuild(store);
  await store.adoptScene(changed, { adopted: false });
  const dropped = await sameAsRebuild(store);
  assert.equal(`ep-0001:${sceneKey(changed)}` in dropped.scenes, false, 'a scene with no adopted rows left is gone');
  assert.equal(dropped.episodes['ep-0001'].panels, 3);
});

test('page order follows first adoption, so an incremental update and a rebuild give the same digest', async () => {
  let tick = 0;
  const store = new CompositionStore(await repoAt(), { now: () => `2026-11-01T00:00:${String(++tick).padStart(2, '0')}.000Z` });
  const closing = shot => ({ preflight: { renderBrief: { pageComposition: { layout: 'grid' }, moments: [planned(), planned(), planned(undefined, shot)] } } });
  const first = fake('wt-1', 1, ['p1'], closing('WS'));
  await store.adoptScene(first, { adopted: true });
  for (const n of [2, 3, 4]) await store.adoptScene(fake(`wt-${n}`, 1, [`p${n}`], closing('MS')), { adopted: true });
  // The first page is reviewed again: its rows move to the end of the shard, but it stays the first page.
  await store.adoptScene(first, { adopted: true });
  const options = { episodeKey: 'ep-0001', castIds: ['hero', 'rival'], requiredLocks: [], seed: 'wt-5', config: DEFAULT_COMPOSITION_CONFIG, basisStats: await store.basisStats() };
  const incremental = compositionDigest(await store.peekIndex(), options);
  const rebuilt = compositionDigest(await store.rebuildIndex(), options);
  assert.deepEqual(rebuilt, incremental);
  assert.equal(rebuilt.streaks.some(streak => streak.kind === 'pageClose' && streak.length === 3), true, JSON.stringify(rebuilt.streaks));
  assert.deepEqual(compositionDigest(await store.computeIndex(), options), incremental);
});

test('an adoption by a first-time store builds the index from scratch', async () => {
  const store = new CompositionStore(await repoAt());
  assert.equal(await store.peekIndex(), null);
  await store.adoptScene(fake('wt-a', 1, ['p1']), { adopted: true });
  assert.equal((await store.peekIndex()).episodes['ep-0001'].panels, 3);
  for (const name of ['l1-scenes.json', 'l1-episodes.json', 'l2.json', 'l3.json']) assert.ok((await stat(store.repo.path('composition', name))).size > 0);
});

test('windowCounts over episodes 3-5 equals the sum of those episode vectors', async () => {
  const store = new CompositionStore(await repoAt());
  for (let ep = 1; ep <= 6; ep++) await store.adoptScene(fake(`wt-${ep}`, ep, [`p${ep}`], { preflight: { renderBrief: { pageComposition: { layout: 'grid' }, moments: Array.from({ length: 3 }, (_, i) => planned(undefined, COMPOSITION_VOCAB.shot[(ep + i) % 8])) } } }), { adopted: true });
  const index = await store.loadIndex();
  const naive = [2, 3, 4].map(i => index.episodes[index.order[i]]).reduce(addVector, emptyVector());
  assert.deepEqual(windowCounts(index, 2, 4), naive);
  assert.equal(windowCounts(index, 2, 4).panels, 9);
  assert.deepEqual(windowCounts(index, 0, 5), (await store.rebuildIndex()).order.map(k => index.episodes[k]).reduce(addVector, emptyVector()));
});

test('changing a shard on disk makes loadIndex rebuild', async () => {
  const repo = await repoAt(), store = new CompositionStore(repo);
  await store.adoptScene(fake('wt-a', 1, ['p1']), { adopted: true });
  const first = await store.loadIndex();
  const path = repo.path('composition', 'l0', 'ep-0001.jsonl');
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.split('\n').filter(l => !l.includes('"panel":3')).join('\n'));
  assert.equal(await store.peekIndex(), null, 'stale source head');
  const second = await store.loadIndex();
  assert.equal(first.episodes['ep-0001'].panels, 3);
  assert.equal(second.episodes['ep-0001'].panels, 2);
  assert.notEqual(second.sourceHead, first.sourceHead);
  assert.deepEqual(await store.peekIndex(), second);
});

test('a missing or vocabulary-stale index file is rebuilt; a changed protagonist setting too', async () => {
  const repo = await repoAt(), store = new CompositionStore(repo);
  await store.adoptScene(fake('wt-a', 1, ['p1']), { adopted: true });
  const l2 = repo.path('composition', 'l2.json');
  const body = JSON.parse(await readFile(l2, 'utf8'));
  await writeFile(l2, JSON.stringify({ ...body, vocabVersion: 0 }));
  assert.equal(await store.peekIndex(), null);
  assert.equal((await store.loadIndex()).vocabVersion, 1);
  await writeFile(l2, '{broken');
  assert.equal(await store.peekIndex(), null);
  await store.loadIndex();
  assert.ok(await store.peekIndex());
  assert.equal(await store.peekIndex({ protagonistIds: ['rival'] }), null);
  const rival = await store.loadIndex({ protagonistIds: ['rival'] });
  assert.deepEqual(rival.protagonistIds, ['rival']);
  assert.equal(rival.scenes[Object.keys(rival.scenes)[0]].counts.protagonistVisibility.back, 1);
});

test('the implied protagonist changing mid-history falls back to a full rebuild that still matches', async () => {
  const store = new CompositionStore(await repoAt());
  let rebuilds = 0;
  const rebuild = store.rebuildIndex.bind(store);
  store.rebuildIndex = async options => { rebuilds++; return rebuild(options); };
  const scene = (id, ep, ids) => fake(`wt-${id}`, ep, [`p-${id}`], { preflight: { renderBrief: { pageComposition: { layout: 'grid' },
    moments: ids.map(subject => planned([{ id: subject, visibility: 'face', side: 'L' }])) } } });
  await store.adoptScene(scene('first', 1, ['aaa', 'aaa', 'mmm']), { adopted: true });
  assert.deepEqual((await store.peekIndex()).protagonistIds, ['aaa']);
  const afterFirst = rebuilds;
  await store.adoptScene(scene('second', 2, ['zzz', 'zzz', 'zzz']), { adopted: true });
  assert.equal(rebuilds, afterFirst + 1, 'the changed implied protagonist forced a full rebuild');
  const stored = await store.peekIndex();
  assert.deepEqual(stored.protagonistIds, ['zzz']);
  assert.deepEqual(stored, await store.rebuildIndex());
  // without a flip the update stays incremental
  const before = rebuilds;
  await store.adoptScene(scene('third', 3, ['zzz', 'mmm', 'mmm']), { adopted: true });
  assert.equal(rebuilds, before, 'no flip, no rebuild');
  assert.deepEqual(await store.peekIndex(), await store.rebuildIndex());
});

test('scale: 300 episodes x 40 panels rebuild fast, windows are one subtraction, l2.json stays small', async () => {
  const repo = await repoAt(), store = new CompositionStore(repo);
  await mkdir(repo.path('composition', 'l0'), { recursive: true });
  let seed = 7;
  const next = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const cast = ['hero', 'rival', 'mentor', 'friend', 'villain', 'child'];
  const pick = list => list[next(list.length)];
  for (let ep = 1; ep <= 300; ep++) {
    const episodeKey = `ep-${String(ep).padStart(4, '0')}`, lines = [];
    for (let sc = 0; sc < 4; sc++) {
      const sceneKey = `scene-${ep}-${sc}`, base = { workflowId: `wt-${ep}-${sc}`, revision: 1, reviewVersion: 2, sceneKey, episodeKey, status: 'adopted' };
      lines.push({ type: 'page', ...base, adoptedAt: '2026-11-01T00:00:00.000Z', layout: pick(COMPOSITION_VOCAB.layout), openPanel: 1, closePanel: 10, sceneType: pick(['dialogue', 'action', 'reveal', 'quiet']), references: [] });
      for (let panel = 1; panel <= 10; panel++) {
        const l = { shot: pick(COMPOSITION_VOCAB.shot), angle: pick(COMPOSITION_VOCAB.angle), focal: pick(COMPOSITION_VOCAB.focal), background: pick(COMPOSITION_VOCAB.background),
          subjects: Array.from({ length: 1 + next(2) }, (_, i) => ({ id: cast[(next(6) + i) % 6], visibility: pick(COMPOSITION_VOCAB.visibility), side: pick(COMPOSITION_VOCAB.side), facing: pick(COMPOSITION_VOCAB.facing), expression: pick(COMPOSITION_VOCAB.expression) })) };
        lines.push({ type: 'panel', ...base, panel, vocabVersion: 1, source: 'plan', confidence: 'clear', label: l, required: [], directed: false, fingerprint: compositionFingerprint(l) });
      }
    }
    await writeFile(repo.path('composition', 'l0', `${episodeKey}.jsonl`), lines.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  const started = performance.now();
  const index = await store.rebuildIndex();
  const elapsed = performance.now() - started;
  console.log(`# scale rebuild ${Math.round(elapsed)} ms`);
  assert.ok(elapsed < 2000, `rebuild took ${Math.round(elapsed)} ms`);
  assert.equal(index.order.length, 300);
  assert.equal(index.prefix.length, 301);
  assert.equal(index.prefix.at(-1).panels, 12000);
  const l2 = (await stat(repo.path('composition', 'l2.json'))).size;
  const sizeOf = async name => (await stat(repo.path('composition', name))).size;
  const [l1Scenes, l1Episodes, l3] = [await sizeOf('l1-scenes.json'), await sizeOf('l1-episodes.json'), await sizeOf('l3.json')];
  console.log(`# scale l1-scenes ${l1Scenes} l1-episodes ${l1Episodes} l2 ${l2} l3 ${l3} bytes`);
  assert.ok(l2 < 1.5 * 1024 * 1024, `l2.json is ${l2} bytes`);
  assert.ok(l1Episodes < 320 * 1024, `l1-episodes.json is ${l1Episodes} bytes (about 1 KB per episode)`);
  assert.ok(l1Scenes < 900 * 1000, `l1-scenes.json is ${l1Scenes} bytes`);
  for (const [from, to] of [[0, 299], [10, 10], [0, 0], [299, 299], [5, 120], [100, 250], [33, 34], [200, 299], [1, 298], [149, 151]]) {
    const naive = index.order.slice(from, to + 1).map(k => index.episodes[k]).reduce(addVector, emptyVector());
    assert.deepEqual(windowCounts(index, from, to), naive);
  }
  const loaded = await store.loadIndex();
  assert.deepEqual(loaded, index);
  // l2.json grows linearly: 150 episodes are about half of 300
  const half = buildIndex(index.order.slice(0, 150).map(episodeKey => ({ episodeKey, rows: [] })), {});
  assert.ok(JSON.stringify({ order: half.order, prefix: half.prefix }).length < l2 / 1.5);
});
