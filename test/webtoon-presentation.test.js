import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLegacyWebtoonTool as runWebtoonTool } from './fixtures/legacy-webtoon.js';
import { WebtoonStore } from '../src/store/webtoon-store.js';
import { answers, webtoonStore, workId, provider, pixel } from './fixtures/webtoon.js';
import { coverage, planShots, updateDecisions } from '../src/core/webtoon-contract.js';
import { letteringStyle } from '../src/core/webtoon-presentation.js';
import { letteringBinding, solveLettering } from '../src/core/webtoon-lettering.js';
import { composeWebtoonBoard } from '../src/core/webtoon-board.js';
import { shotJobs } from '../src/core/webtoon-images.js';

async function setup() {
  const store = await webtoonStore(), providers = provider();
  const call = (tool, args = {}) => runWebtoonTool({ store, toolName: `lore_webtoon_${tool}`, args: { workId, ...(tool === 'plan' ? { imageModel: 'gpt-image-2' } : {}), ...args }, providers });
  const approve = r => call('decide', { workflowId: r.workflowId, approvalId: r.approvalId, action: 'approve' });
  return { store, providers, call, approve };
}

test('explicit confirmation of an inherited value resolves mandatory choice without reopening unchanged dependents', () => {
  for (const status of ['delegated', 'unresolved']) {
    const w = { presentationVersion: 1, source: { foundation: { genre: 'other' } }, inputs: [], decisionHistory: [],
      decisions: { W04: { id: 'W04', status, value: 'ink', revision: 1 }, W05: { status: 'answered', value: 'natural' } } };
    updateDecisions(w, { W04: 'ink' }, { id: 'explicit' });
    assert.equal(w.decisions.W04.status, 'answered');
    assert.equal(w.decisions.W04.inputId, 'explicit');
    assert.equal(w.decisions.W05.status, 'answered');
    assert.ok(!coverage(w).questions.some(q => q.id === 'W04'));
  }
});

test('three independent choices are required even in auto mode, partial answers survive reload', async () => {
  const c = await setup(), before = await readFile(c.store.chapterPath(1));
  let r = await c.call('plan', { mode: 'auto' });
  assert.equal(r.status, 'needs_interview');
  assert.deepEqual(r.questions.map(q => q.id), ['W04', 'W15', 'W16']);
  assert.equal(c.providers.requests.length, 0);
  r = await c.call('plan', { workflowId: r.workflowId, responses: { W04: '섬세한 선과 컬러, 일본풍 참고', W15: 'minimal' } });
  assert.deepEqual(r.questions.map(q => q.id), ['W16']);
  assert.equal(c.providers.requests.length, 0);
  r = await c.call('plan', { workflowId: r.workflowId, responses: { W16: 'scroll' } });
  assert.equal(r.status, 'plan_accepted');
  assert.equal(r.plan.presentation.format, 'scroll');
  assert.equal(r.plan.presentation.lettering.thought, 'plain');
  assert.equal(r.plan.presentation.artStyle, '섬세한 선과 컬러, 일본풍 참고');
  assert.deepEqual(await readFile(c.store.chapterPath(1)), before);
  const saved = JSON.parse(await readFile(join(c.store.rootDir, '.vibelore/webtoon/profile.json')));
  assert.equal(saved.presentationVersion, 1);
  assert.equal(saved.decisions.W15.status, 'answered');
});

test('page preference is retained without launching scroll planning or images', async () => {
  const c = await setup();
  let r = await c.call('plan', { mode: 'auto', responses: { ...answers, W16: 'page-rtl' } });
  assert.equal(r.status, 'needs_format_support');
  assert.equal(r.presentation.readingDirection, 'rtl');
  assert.equal(r.presentation.supported, false);
  assert.equal(c.providers.requests.length, 0);
  assert.equal(r.approvalId, undefined);
  assert.throws(() => composeWebtoonBoard({ presentation: r.presentation, sequences: [] }), /UNSUPPORTED_COMIC_FORMAT/);
  r = await c.call('plan', { workflowId: r.workflowId });
  assert.equal(r.presentation.format, 'page-rtl');
  r = await c.call('plan', { workflowId: r.workflowId, responses: { W16: 'scroll' } });
  assert.equal(r.status, 'plan_accepted');
});

test('unsupported page choice stops before asking the rest of the production interview', async () => {
  const c = await setup();
  const r = await c.call('plan', { responses: { W04: '컬러 잉크선', W15: 'soft', W16: 'page-ltr' } });
  assert.equal(r.status, 'needs_format_support');
  assert.equal(r.coverage.complete, false);
  assert.equal(r.questions, undefined);
  assert.equal(c.providers.requests.length, 0);
});

test('existing workflow without presentation version keeps its original coverage', async () => {
  const c = await setup();
  const first = await c.call('plan');
  const repo = new WebtoonStore(c.store), old = await repo.load(first.workflowId);
  delete old.presentationVersion;
  // Simulate a stored pre-feature workflow, not a production-data migration.
  await repo.save(old);
  const r = await c.call('plan', { workflowId: first.workflowId });
  assert.deepEqual(r.questions.map(q => q.id), ['W01', 'W02', 'W04', 'W12']);
  assert.ok(!coverage(old).required.includes('W15'));
});

test('unsupported lettering requests are rejected, not silently coerced to a preset', () => {
  assert.throws(() => letteringStyle('구름 모양 풍선'), /LETTERING_CHOICE_REQUIRED/);
  assert.throws(() => letteringStyle(JSON.stringify({ dialogue: 'cloud', thought: 'plain', caption: 'plain', sfx: 'plain' })), /UNSUPPORTED_LETTERING/);
  assert.deepEqual(letteringStyle(JSON.stringify({ dialogue: 'square', thought: 'light', caption: 'plain', sfx: 'impact' })),
    { dialogue: 'square', thought: 'light', caption: 'plain', sfx: 'impact' });
});

test('lettering choice changes actual layout output and bindings, without changing source text', () => {
  const original = { id: 'thought', height: 640, gapAfter: 20, texts: [{ kind: 'thought', speaker: 'hero', text: '여기였구나.' }] };
  const image = { hash: 'synthetic', mime: 'image/png', base64: pixel.toString('base64') };
  const results = {};
  for (const preset of ['standard', 'soft', 'minimal']) {
    const plan = { title: 'Fixture', presentation: { lettering: letteringStyle(preset) }, sequences: [{ shots: [original] }] };
    const shot = planShots(plan)[0];
    const map = { inputHash: letteringBinding(shot, image), inspectedImages: true, evidence: 'Synthetic geometry, not visual QA', protected: [],
      entries: [{ textIndex: 0, anchor: null, candidates: [[0.5, 0.35]], confidence: 1, reason: 'Fixture' }] };
    const solved = solveLettering(shot, image, map); assert.equal(solved.status, 'passed');
    const item = solved.candidates[0].items[0];
    const svg = composeWebtoonBoard(plan, { thought: image }, { thought: solved }).svg;
    results[preset] = { hash: solved.inputHash, svg, item };
    assert.deepEqual(shot.texts, original.texts);
    assert.equal(item.tail, null);
  }
  assert.equal(new Set(Object.values(results).map(r => r.hash)).size, 3);
  assert.match(results.standard.svg, /fill="#26332e"/);
  assert.match(results.soft.svg, /fill="#eef2ed"/);
  assert.equal(results.minimal.item.appearance.box, 'none');
  assert.doesNotMatch(results.minimal.svg, /fill="#26332e"|fill="#eef2ed"/);
});

test('MCP applies selected lettering through planning, analysis and composed output', async () => {
  const c = await setup();
  let r = await c.call('plan', { responses: { ...answers, W15: 'minimal' } });
  r = await c.approve(r); r = await c.approve(r);
  const workflowId = r.workflowId, path = join(c.store.rootDir, 'fixture.png'); await writeFile(path, pixel);
  r = await c.call('render', { workflowId });
  r = await c.call('render', { workflowId, references: r.jobs.map(j => ({ referenceId: j.referenceId, inputHash: j.inputHash, path })) });
  await c.approve(r);
  r = await c.call('render', { workflowId });
  r = await c.call('render', { workflowId, assets: r.jobs.map(j => ({ shotId: j.shotId, inputHash: j.inputHash, path })) });
  assert.equal(r.approval.kind, 'look');
  const request = c.providers.requests.find(p => p.step === 'webtoon-layout-analyze');
  const packet = JSON.parse(request.messages.at(-1).content);
  assert.equal(packet.shots[0].shot.letteringStyle.thought, 'plain');
  const stored = await new WebtoonStore(c.store).load(workflowId);
  assert.equal(stored.lettering.shot2.candidates[0].items[0].appearance.box, 'round');
  const before = shotJobs(stored, { all: true }).map(j => j.artInputHash);
  const changed = structuredClone(stored); changed.plan.presentation.lettering = letteringStyle('soft');
  assert.deepEqual(shotJobs(changed, { all: true }).map(j => j.artInputHash), before);
  assert.notEqual(letteringBinding(planShots(changed.plan)[1], changed.images.shot2), stored.lettering.shot2.inputHash);
  await c.approve(r);
  r = await c.call('render', { workflowId, quality: 'final' }); await c.approve(r);
  r = await c.call('plan', { newWorkflow: true, episode: 2 });
  assert.equal(r.approval.kind, 'profile');
  assert.equal(r.presentation.lettering.thought, 'plain');
  assert.equal(r.presentation.format, 'scroll');
  assert.equal(r.questions, undefined);
});
