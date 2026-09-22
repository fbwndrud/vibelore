import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EDITORIAL_PROMPT, validateEditorial, validateEditorialPlan } from '../src/core/webtoon-editorial.js';
import { validateWebtoonPlan, planShots } from '../src/core/webtoon-contract.js';
import { shotJobs } from '../src/core/webtoon-images.js';
import { WebtoonStore } from '../src/store/webtoon-store.js';
import { runWebtoonTool } from '../src/tools/webtoon.js';
import { answers, workId, webtoonStore, plan, editorial, provider } from './fixtures/webtoon.js';

const source = { units: [{ id: 'p1' }, { id: 'p2' }], foundation: { characters: [{ id: 'hero' }] }, chapters: [], hash: 'source' };
const codes = errors => errors.map(e => e.code);
const invoke = (store, tool, args = {}, providers = provider()) => runWebtoonTool({ store, toolName: `lore_webtoon_${tool}`, args: { workId, ...(tool === 'plan' ? { imageModel: 'gpt-image-2' } : {}), ...args }, providers });
const approve = (store, state, providers) => invoke(store, 'decide', { workflowId: state.workflowId, approvalId: state.approvalId, action: 'approve' }, providers);

test('selection audits all source without requiring every source to be drawn or filling the ceiling', () => {
  const e = editorial(source); e.beats[1].decision = 'omit'; e.beats[1].visualProof = '';
  const p = plan(source); p.editorial = e; p.sequences[0].shots.pop();
  p.adaptation[1] = { sourceId: 'p2', operation: 'omit', reason: '중복 반응', payoffAt: '첫 컷에서 선택을 보존' };
  assert.deepEqual(validateEditorial(e, source), []);
  assert.deepEqual(validateEditorialPlan(p, e, source), []);
  assert.deepEqual(validateWebtoonPlan(p, source, { maxShots: 40 }), []);
  assert.equal(planShots(p).length, 1);
  assert.match(EDITORIAL_PROMPT, /maxShots를 채우지 않는다/);
});

test('missing, duplicate and unknown source units block selection; malformed beats do not throw', () => {
  const e = editorial(source); e.beats.pop();
  assert.ok(codes(validateEditorial(e, source)).includes('EDITORIAL_SOURCE_UNCOVERED'));
  e.beats[0].sourceIds.push('p1', 'unknown');
  assert.ok(codes(validateEditorial(e, source)).includes('EDITORIAL_SOURCE_INVALID_OR_DUPLICATE'));
  e.beats.push(null);
  assert.ok(codes(validateEditorial(e, source)).includes('EDITORIAL_BEAT_ID'));
});

test('excluded and deferred beats cannot sneak into panels; retained beats cannot disappear', () => {
  for (const decision of ['omit', 'defer']) {
    const e = editorial(source); e.beats[1].decision = decision;
    const p = plan(source); p.editorial = e;
    const errors = codes(validateEditorialPlan(p, e, source));
    assert.ok(errors.includes('EDITORIAL_EXCLUDED_BEAT_DRAWN'));
    assert.ok(errors.includes('EDITORIAL_OMISSION_MAP_CONFLICT'));
  }
  const p = plan(source); p.sequences[0].shots.pop();
  assert.ok(codes(validateEditorialPlan(p, p.editorial, source)).includes('EDITORIAL_RETAINED_BEAT_MISSING'));
});

test('selection binding, visual evidence, source links and per-panel experience are required', () => {
  const e = editorial(source); const p = plan(source);
  p.editorial.focus.primary = '새 취향'; p.sequences[0].shots[0].sourceIds = ['p2'];
  delete p.sequences[0].shots[0].readerDelta;
  const errors = codes(validateEditorialPlan(p, e, source));
  for (const code of ['EDITORIAL_BINDING_CHANGED', 'EDITORIAL_SHOT_SOURCE_MISMATCH', 'EDITORIAL_SHOT_PURPOSE_REQUIRED']) assert.ok(errors.includes(code));
  e.beats[0].visualProof = '';
  assert.ok(codes(validateEditorial(e, source)).includes('EDITORIAL_VISUAL_PROOF_REQUIRED'));
  assert.ok(validateEditorialPlan(null, editorial(source), source).length);
});

test('planner and critic receive selection, and approval publishes editorial with the script', async () => {
  const store = await webtoonStore(); const p = provider();
  const profile = await invoke(store, 'plan', { responses: answers }, p);
  const planned = await approve(store, profile, p);
  assert.deepEqual(p.requests.map(r => r.step), ['webtoon-editorial', 'webtoon-plan', 'webtoon-plan-review']);
  const input = JSON.parse(p.requests[1].messages.at(-1).content);
  assert.deepEqual(input.editorial, planned.editorial);
  assert.equal(input.limits.maxShotsMeaning, 'ceiling-not-target');
  assert.ok(JSON.parse(p.requests[2].messages.at(-1).content).editorialReview);
  assert.ok(planned.artifacts['editorial.md']);
  const accepted = await approve(store, planned);
  const md = await readFile(join(store.rootDir, 'webtoon', 'episodes', `1-${accepted.workflowId}`, 'editorial.md'), 'utf8');
  assert.match(md, /컷 수는 결과/);
});

test('invalid selection stops before planner and remains retryable with source and intent intact', async () => {
  const store = await webtoonStore(); const p = provider({ response: r => r.step === 'webtoon-editorial' ? {} : undefined });
  const profile = await invoke(store, 'plan', { responses: answers });
  const blocked = await approve(store, profile, p);
  assert.equal(blocked.status, 'editorial_invalid'); assert.equal(blocked.approvalId, undefined);
  assert.ok(!p.requests.some(r => r.step === 'webtoon-plan'));
  const retried = await invoke(store, 'plan', { retry: true });
  assert.equal(retried.approval.kind, 'plan'); assert.equal(retried.sourceHash, blocked.sourceHash);
});

test('explicit adaptation revision upgrades a legacy gate without changing canon or published plan', async () => {
  const store = await webtoonStore();
  const profile = await invoke(store, 'plan', { responses: answers });
  const planned = await approve(store, profile); await approve(store, planned);
  const repo = new WebtoonStore(store); const workflow = await repo.load();
  const prose = await readFile(store.chapterPath(1));
  const path = join(store.rootDir, 'webtoon', 'episodes', `1-${workflow.workflowId}`, 'plan.json');
  const published = await readFile(path);
  // Simulate an older saved final gate. Revision must not approve or render it.
  delete workflow.editorialVersion; delete workflow.editorial;
  workflow.stage = 'awaiting_approval'; workflow.approval = { ...planned.approval, id: 'legacy-final', kind: 'final' };
  await repo.save(workflow);
  const p = provider();
  const revised = await invoke(store, 'decide', { workflowId: workflow.workflowId, approvalId: 'legacy-final', action: 'request_revision',
    revisionTarget: { kind: 'adaptation' }, feedback: '사건 전부 대신 주된 경험을 선별' }, p);
  assert.equal(revised.approval.kind, 'plan'); assert.equal(revised.revision, workflow.revision + 1);
  assert.equal((await repo.load()).editorialVersion, 1);
  assert.match(JSON.parse(p.requests[0].messages.at(-1).content).feedback, /주된 경험/);
  assert.deepEqual(await readFile(path), published); assert.deepEqual(await readFile(store.chapterPath(1)), prose);
  await assert.rejects(invoke(store, 'decide', { approvalId: 'legacy-final', action: 'approve' }), /STALE_WEBTOON_APPROVAL/);
});

test('editorial purpose is part of image provenance; text changes alone keep art hash', () => {
  const workflow = { plan: plan(source), source, images: {}, references: {}, referenceSpecs: [], decisions: {} };
  const before = shotJobs(workflow)[0];
  workflow.plan.sequences[0].shots[0].texts = []; // Already blank: focus, not lettering, is the change below.
  assert.equal(shotJobs(workflow)[0].artInputHash, before.artInputHash);
  workflow.plan.sequences[0].shots[0].readerDelta = '새로운 감정 보상';
  const after = shotJobs(workflow)[0];
  assert.notEqual(after.artInputHash, before.artInputHash);
  assert.match(after.prompt, /새로운 감정 보상/);
});
