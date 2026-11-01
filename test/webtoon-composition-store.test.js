import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runWebtoonSceneTool } from '../src/tools/webtoon-scene.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';
import { CompositionStore, sceneEpisodeKey, sceneKey } from '../src/store/webtoon-composition-store.js';
import { compositionFingerprint, COMPOSITION_VOCAB_VERSION } from '../src/core/webtoon-composition.js';
import { sceneSetup, scenePlan, scenePreflight, sceneCompositionCheck } from './fixtures/webtoon-scene.js';
import { workId } from './fixtures/webtoon.js';

const checkNames = ['reflectionGeometry', 'propStructure', 'handsAndContact', 'withinSceneContinuity', 'layoutAndTiming'];
const checks = () => Object.fromEntries(checkNames.map(key => [key, { status: 'not_applicable', panels: [], evidence: 'Synthetic protocol fixture.' }]));
const planner = { async complete(req) {
  const d = JSON.parse(req.messages.at(-1).content);
  return { text: JSON.stringify(req.step === 'webtoon-scene-plan' ? scenePlan(d.source) : scenePreflight(d)) };
} };
const assetFor = (args, job) => ({ path: args.references[0].path, inputHash: job.inputHash,
  provenance: { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: 'selected-api' } });
const answer = (q, { fail = false } = {}) => {
  const d = JSON.parse(q.user);
  const a = { ...d.schema, ...sceneCompositionCheck(d.schema.compositionCheck), visualChecks: checks(), inspectedImages: true, observedPanelCount: d.requestedPanelCount,
    spatialCoherence: true, readingOrder: true, evidence: 'Synthetic protocol receipt.', findings: [],
    textObservations: d.plan.texts.map(t => ({ id: t.id, observedText: t.text, readable: true, speakerCorrect: true, evidence: 'Synthetic text.' })) };
  if (fail) a.visualChecks.propStructure = { status: 'uncertain', panels: [1], evidence: 'Required support cannot be identified.' };
  return a;
};
const review = async (store, args, drawn, options) => {
  const pending = await runWebtoonSceneTool({ store, args: { workId, asset: assetFor(args, drawn.jobs[0]) }, providers: createHostRelay() });
  const q = pending.requests[0], run = await loadRun(store.rootDir, pending.runId);
  return runWebtoonSceneTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(answer(q, options)) }) });
};
const shardPath = (repo, key = 'ep-0001') => repo.path('composition', 'l0', `${key}.jsonl`);
const lines = async (repo, key) => (await readFile(shardPath(repo, key), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));

test('adopting a v1 scene writes one page row and one panel row per panel to the episode shard', async () => {
  const { store, repo, args } = await sceneSetup();
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: planner });
  const done = await review(store, args, drawn);
  assert.equal(done.status, 'completed');
  const w = await repo.load(), rows = await lines(repo);
  assert.equal(rows.filter(r => r.type === 'page').length, 1);
  assert.equal(rows.filter(r => r.type === 'panel').length, w.panelCount);
  const page = rows.find(r => r.type === 'page'), panel = rows.find(r => r.type === 'panel' && r.panel === 1);
  assert.equal(page.status, 'adopted');
  assert.equal(page.layout, 'strip-stack');
  assert.equal(page.openPanel, 1);
  assert.equal(page.closePanel, w.panelCount);
  assert.deepEqual(page.references, [{ id: 'ref', hash: w.sceneReferences[0].hash, role: 'user' }]);
  assert.match(page.adoptedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(panel.workflowId, w.workflowId);
  assert.equal(panel.revision, w.revision);
  assert.equal(panel.reviewVersion, w.imageReviewVersion);
  assert.equal(panel.episodeKey, 'ep-0001');
  assert.equal(panel.sceneKey, sceneKey(w));
  assert.equal(panel.status, 'adopted');
  assert.equal(panel.vocabVersion, COMPOSITION_VOCAB_VERSION);
  assert.equal(panel.source, 'plan');
  assert.equal(panel.confidence, 'clear');
  assert.equal(panel.directed, false);
  assert.deepEqual(panel.required, []);
  assert.equal(panel.fingerprint, compositionFingerprint(panel.label));
  assert.deepEqual(await new CompositionStore(repo).listEpisodes(), [{ episodeKey: 'ep-0001', order: 1 }]);
});

test('a failed review writes rejected rows', async () => {
  const { store, repo, args } = await sceneSetup();
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: planner });
  const done = await review(store, args, drawn, { fail: true });
  assert.equal(done.status, 'scene_needs_revision');
  const rows = await lines(repo);
  assert.ok(rows.length > 1);
  assert.ok(rows.every(r => r.status === 'rejected'));
});

test('re-reviewing the same workflow and revision leaves exactly one set of rows', async () => {
  const { store, repo, args } = await sceneSetup();
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: planner });
  await review(store, args, drawn);
  const first = await lines(repo);
  const pending = await runWebtoonSceneTool({ store, args: { workId, action: 'review' }, providers: createHostRelay() });
  const q = pending.requests[0], run = await loadRun(store.rootDir, pending.runId);
  await runWebtoonSceneTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(answer(q)) }) });
  const second = await lines(repo);
  assert.equal(second.length, first.length);
  assert.equal(second.filter(r => r.type === 'page').length, 1);
  assert.equal(new Set(second.filter(r => r.type === 'panel').map(r => r.panel)).size, second.filter(r => r.type === 'panel').length);
  assert.equal(second.find(r => r.type === 'page').adoptedAt, first.find(r => r.type === 'page').adoptedAt);
});

const fake = (workflowId, extra = {}) => ({ workflowId, revision: 1, imageReviewVersion: 2, compositionVersion: 1, panelCount: 2,
  source: { kind: 'novel' }, sceneUnits: [{ id: 'ch-1-p-2', chapter: 1 }, { id: 'ch-1-p-1', chapter: 1 }], sceneReferences: [],
  preflight: { renderBrief: { pageComposition: { layout: 'grid' }, moments: [1, 2].map(() => ({ composition: { shot: 'MS', angle: 'eye', focal: 'space', background: 'detailed', subjects: [], directed: false } })) } },
  visualReview: { compositionCheck: [1, 2].map(panel => ({ panel, result: 'match', observed: null, evidence: 'ok' })) }, ...extra });

test('a second workflow adopting the same scene supersedes the first set', async () => {
  const { repo } = await sceneSetup();
  const store = new CompositionStore(repo);
  await store.recordScene(fake('wt-a'), { adopted: true });
  await store.recordScene(fake('wt-b'), { adopted: true });
  const rows = await store.readShard('ep-0001');
  assert.ok(rows.filter(r => r.workflowId === 'wt-a').every(r => r.status === 'superseded'));
  assert.ok(rows.filter(r => r.workflowId === 'wt-b').every(r => r.status === 'adopted'));
  await store.recordScene(fake('wt-c'), { adopted: false });
  const after = await store.readShard('ep-0001');
  assert.ok(after.filter(r => r.workflowId === 'wt-b').every(r => r.status === 'adopted'), 'a rejected candidate does not supersede');
  assert.ok(after.filter(r => r.workflowId === 'wt-c').every(r => r.status === 'rejected'));
});

test('a different scene in the same episode is left alone', async () => {
  const { repo } = await sceneSetup();
  const store = new CompositionStore(repo);
  await store.recordScene(fake('wt-a'), { adopted: true });
  await store.recordScene(fake('wt-b', { sceneUnits: [{ id: 'ch-1-p-3', chapter: 1 }] }), { adopted: true });
  assert.ok((await store.readShard('ep-0001')).filter(r => r.workflowId === 'wt-a').every(r => r.status === 'adopted'));
});

test('a truncated shard line is a hard error naming the episode', async () => {
  const { repo } = await sceneSetup();
  const store = new CompositionStore(repo);
  await store.recordScene(fake('wt-a'), { adopted: true });
  const text = await readFile(shardPath(repo), 'utf8');
  await writeFile(shardPath(repo), text.trimEnd().slice(0, -7));
  await assert.rejects(store.readShard('ep-0001'), /CORRUPT_COMPOSITION_SHARD: ep-0001/);
  await assert.rejects(store.recordScene(fake('wt-b'), { adopted: true }), /CORRUPT_COMPOSITION_SHARD: ep-0001/);
  assert.equal(await readFile(shardPath(repo), 'utf8'), text.trimEnd().slice(0, -7), 'the damaged shard is not rewritten');
});

test('a missing shard reads as empty and an unsafe episode key is refused', async () => {
  const { repo } = await sceneSetup();
  const store = new CompositionStore(repo);
  assert.deepEqual(await store.readShard('ep-0009'), []);
  assert.deepEqual(await store.listEpisodes(), []);
  await assert.rejects(store.readShard('../x'), /INVALID_COMPOSITION_EPISODE/);
});

test('episode keys: zero-padded minimum chapter, or script- plus the script id', () => {
  assert.equal(sceneEpisodeKey(fake('x', { sceneUnits: [{ id: 'a', chapter: 12 }, { id: 'b', chapter: 3 }] })), 'ep-0003');
  assert.equal(sceneEpisodeKey(fake('x', { source: { kind: 'scene-script', scriptId: 'script_1' }, sceneUnits: [{ id: 's-p-1', sceneId: 's' }] })), 'script-script_1');
  assert.equal(sceneKey(fake('x')), sceneKey(fake('y', { sceneUnits: [{ id: 'ch-1-p-1' }, { id: 'ch-1-p-2' }] })));
});

test('episodes list chapters numerically, then scripts by first adoption time', async () => {
  const { repo } = await sceneSetup();
  const store = new CompositionStore(repo);
  const at = iso => ({ now: () => iso });
  const script = id => fake(`wt-${id}`, { source: { kind: 'scene-script', scriptId: id }, sceneUnits: [{ id: `${id}-p-1`, sceneId: id }] });
  const chapter = n => fake(`wt-c${n}`, { sceneUnits: [{ id: `ch-${n}-p-1`, chapter: n }] });
  await new CompositionStore(repo, at('2026-11-02T00:00:00.000Z')).recordScene(script('late'), { adopted: true });
  await new CompositionStore(repo, at('2026-11-01T00:00:00.000Z')).recordScene(script('early'), { adopted: true });
  await store.recordScene(chapter(10), { adopted: true });
  await store.recordScene(chapter(2), { adopted: true });
  assert.deepEqual((await store.listEpisodes()).map(e => e.episodeKey), ['ep-0002', 'ep-0010', 'script-early', 'script-late']);
  assert.deepEqual((await store.listEpisodes()).map(e => e.order), [1, 2, 3, 4]);
});

test('backfill rows keep an unclear panel with a null label and fingerprint', async () => {
  const { repo } = await sceneSetup();
  const store = new CompositionStore(repo);
  const w = fake('wt-bf', { compositionVersion: undefined, compositionBackfill: true, preflight: undefined,
    visualReview: { compositionCheck: [{ panel: 1, result: 'unclear', observed: null, evidence: 'x' },
      { panel: 2, result: 'observed', observed: { shot: 'CU', angle: 'low', focal: 'face', background: 'bokeh', subjects: [], directed: false }, evidence: 'x' }] } });
  const { rows } = await store.recordScene(w, { adopted: true });
  const [p1, p2] = rows.filter(r => r.type === 'panel');
  assert.deepEqual([p1.label, p1.fingerprint, p1.confidence, p1.source, p1.directed], [null, null, 'unclear', 'observed-backfill', false]);
  assert.equal(p2.fingerprint, compositionFingerprint(p2.label));
  assert.equal(rows.find(r => r.type === 'page').layout, null);
});

test('a workflow from before this change writes nothing', async () => {
  const { store, repo, args } = await sceneSetup();
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: planner });
  const old = await repo.load(); delete old.compositionVersion; await repo.save(old);
  const pending = await runWebtoonSceneTool({ store, args: { workId, asset: assetFor(args, drawn.jobs[0]) }, providers: createHostRelay() });
  const q = pending.requests[0], run = await loadRun(store.rootDir, pending.runId);
  const done = await runWebtoonSceneTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(answer(q)) }) });
  assert.equal(done.status, 'completed');
  await assert.rejects(readdir(repo.path('composition')), { code: 'ENOENT' });
});

test('a write failure surfaces and leaves the review stage retryable', async () => {
  const { store, repo, args } = await sceneSetup();
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: planner });
  // A directory where the shard should be is an I/O failure, not a damaged shard: it must stay retryable.
  await mkdir(shardPath(repo), { recursive: true });
  const pending = await runWebtoonSceneTool({ store, args: { workId, asset: assetFor(args, drawn.jobs[0]) }, providers: createHostRelay() });
  const q = pending.requests[0], run = await loadRun(store.rootDir, pending.runId);
  await assert.rejects(runWebtoonSceneTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(answer(q)) }) }), /EISDIR/);
  const failed = await repo.load();
  assert.deepEqual([failed.stage, failed.failedStage], ['scene_model_failed', 'scene_image_review']);
  await rm(shardPath(repo), { recursive: true });
  const again = await runWebtoonSceneTool({ store, args: { workId, action: 'retry' }, providers: createHostRelay() });
  const q2 = again.requests[0], run2 = await loadRun(store.rootDir, again.runId);
  const retry = await runWebtoonSceneTool({ store, args: run2.args, run: run2, providers: createHostRelay({ [q2.id]: JSON.stringify(answer(q2)) }) });
  assert.equal(retry.status, 'completed');
  assert.equal((await lines(repo)).filter(r => r.type === 'page').length, 1);
  assert.equal('compositionRecordError' in retry, false);
});

test('a damaged shard never blocks adoption: the scene completes, the record is written and the reason is visible', async () => {
  const { store, repo, args } = await sceneSetup();
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: planner });
  await mkdir(dirname(shardPath(repo)), { recursive: true });
  const damaged = '{"type":"pa';
  await writeFile(shardPath(repo), damaged);
  const done = await review(store, args, drawn);
  assert.equal(done.status, 'completed');
  assert.match(done.compositionRecordError, /^CORRUPT_COMPOSITION_SHARD: ep-0001$/);
  const w = await repo.load();
  assert.equal(w.stage, 'completed');
  assert.equal(w.visualReview.passed, true);
  assert.equal(typeof w.productionRecordHash, 'string', 'the production record was written');
  assert.deepEqual((await runWebtoonSceneTool({ store, args: { workId, action: 'verify' }, providers: createHostRelay() })).status, 'verified');
  const event = w.events.find(e => e.event === 'composition_record_failed');
  assert.ok(event, JSON.stringify(w.events.map(e => e.event)));
  assert.match(event.reason, /CORRUPT_COMPOSITION_SHARD: ep-0001/);
  assert.equal(await readFile(shardPath(repo), 'utf8'), damaged, 'the damaged shard is left as it was');
});

test('an index that cannot be written is recorded as an event and never blocks adoption', async () => {
  const { store, repo, args } = await sceneSetup();
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: planner });
  await mkdir(repo.path('composition', 'l2.json'), { recursive: true });
  const done = await review(store, args, drawn);
  assert.equal(done.status, 'completed');
  const w = await repo.load();
  assert.equal((await lines(repo)).filter(r => r.type === 'page').length, 1, 'the rows were recorded');
  const event = w.events.find(e => e.event === 'composition_index_skipped');
  assert.ok(event, JSON.stringify(w.events.map(e => e.event)));
  assert.equal(typeof event.reason, 'string');
  assert.equal('compositionRecordError' in done, false);
});

test('adopting through the tool keeps the derived index equal to a rebuild, and a rejected review leaves it empty of scenes', async () => {
  const { store, repo, args } = await sceneSetup();
  const drawn = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: planner });
  await review(store, args, drawn);
  const composition = new CompositionStore(repo), index = await composition.peekIndex();
  assert.ok(index, 'adoption wrote a fresh index');
  assert.equal(Object.keys(index.scenes).length, 1);
  assert.deepEqual(await composition.rebuildIndex(), index);
  const failed = await sceneSetup();
  const failedDrawn = await runWebtoonSceneTool({ store: failed.store, args: { ...failed.args, autoRevisions: 0 }, providers: planner });
  await review(failed.store, failed.args, failedDrawn, { fail: true });
  const none = await new CompositionStore(failed.repo).peekIndex();
  assert.deepEqual(none.scenes, {});
  assert.deepEqual(none.order, ['ep-0001']);
});
