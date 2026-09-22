import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLegacyWebtoonTool as runWebtoonTool } from './fixtures/legacy-webtoon.js';
import { validateContinuity, continuityDescendants, continuityInput, reconfigureContinuity, roughBinding } from '../src/core/webtoon-continuity.js';
import { digest } from '../src/core/webtoon-contract.js';
import { answers, webtoonStore, workId, provider, pixel } from './fixtures/webtoon.js';

const production = () => ({ version: 1, scenes: [{ id: 'door-scene', environmentId: 'door', layout: '문 오른쪽, 인물 왼쪽', cameraAxis: '문 앞 남쪽 촬영' }],
  shots: ['shot1', 'shot2'].map((shotId, i) => ({ shotId, sceneId: 'door-scene', transition: i ? 'continue' : 'reset', ...(i ? { previousShotId: 'shot1', anchorShotId: 'shot1' } : {}),
    blocking: '인물 왼쪽, 문 오른쪽', camera: '같은 쪽 중경', before: '멈춤', after: '말검', change: '입과 손만 움직임', decisiveMoment: '선택' })) });

test('cut separates causal dependence from image attachment and validates optional framing', () => {
  const p = production(); p.shots[1].transition = 'cut'; delete p.shots[1].anchorShotId;
  p.shots[1].visibleCharacters = []; p.shots[1].background = 'abstract';
  const canon = { sequences: [{ shots: ['shot1', 'shot2'].map(id => ({ id, environmentId: 'door', characters: ['hero'] })) }] };
  validateContinuity(canon, p);
  const w = { source: { hash: 'source' }, references: {}, images: { shot1: { hash: 'image', continuityPath: '/fixture.png' } },
    continuity: { plan: p, roughs: {}, roughReviews: {}, shotReviews: {} } };
  assert.ok(continuityInput(w, 'shot2').blocked.includes('shot:shot1'));
  assert.deepEqual(continuityInput(w, 'shot2').referenceImages, []);
  w.continuity.shotReviews.shot1 = { hash: 'image', inspectedImages: true, passed: true, evidence: 'Synthetic fixture' };
  assert.ok(!continuityInput(w, 'shot2').blocked.includes('shot:shot1'));
  const binding = continuityInput(w, 'shot2').binding;
  w.images.shot1.hash = 'replacement';
  assert.notEqual(continuityInput(w, 'shot2').binding, binding);
  p.shots[1].anchorShotId = 'shot1';
  assert.equal(continuityInput(w, 'shot2').referenceImages[0].subjectId, 'shot1');
  p.shots[1].visibleCharacters = ['stranger'];
  assert.throws(() => validateContinuity(canon, p), /CAST_INVALID/);
  p.shots[1].visibleCharacters = []; p.shots[1].background = 'nonsense';
  assert.throws(() => validateContinuity(canon, p), /BACKGROUND_INVALID/);
});

test('reblocking one scene preserves reviewed unchanged scene and rebinds its rough', () => {
  const p = production(); p.scenes.push({ ...p.scenes[0], id: 'meal' });
  p.shots.push({ ...p.shots[0], shotId: 'meal-shot', sceneId: 'meal' });
  const w = { source: { hash: 'source' }, references: {}, images: {}, continuity: { plan: p, roughs: {}, roughReviews: {}, shotReviews: {} } };
  for (const scene of p.scenes) {
    w.continuity.roughs[scene.id] = { inputHash: roughBinding(w, scene.id), image: { hash: scene.id } };
    w.continuity.roughReviews[scene.id] = { hash: scene.id, inspectedImages: true, passed: true, evidence: 'Synthetic fixture' };
  }
  w.continuity.shotReviews['meal-shot'] = { hash: 'meal-image' };
  const revised = structuredClone(p); revised.shots[0].camera = 'close-up';
  const { affected, next } = reconfigureContinuity(w, revised);
  assert.deepEqual(affected, ['shot1', 'shot2']);
  assert.deepEqual(Object.keys(next.roughs), ['meal']);
  assert.equal(next.shotReviews['meal-shot'], w.continuity.shotReviews['meal-shot']);
  assert.equal(next.roughs.meal.inputHash, roughBinding({ ...w, continuity: next }, 'meal'));
  assert.notEqual(next.roughs.meal.inputHash, w.continuity.roughs.meal.inputHash);
  w.continuity.roughReviews.meal.passed = false;
  assert.ok(reconfigureContinuity(w, revised).affected.includes('meal-shot'));
});

test('continuity requires explicit transitions, forbids future references, resets detach prior scenes', () => {
  const p = { sequences: [{ shots: [{ id: 'shot1', environmentId: 'door' }, { id: 'shot2', environmentId: 'door' }] }] };
  assert.equal(validateContinuity(p, production()).version, 1);
  const bad = production(); bad.shots[0].previousShotId = 'shot2';
  assert.throws(() => validateContinuity(p, bad), /RESET_OR_PREVIOUS/);
  bad.shots[0].transition = 'continue';
  assert.throws(() => validateContinuity(p, bad), /FORWARD_OR_CROSS/);
  assert.deepEqual(continuityDescendants({ continuity: { plan: production() } }, ['shot1']), ['shot1', 'shot2']);
  const reset = production(); reset.shots[1].transition = 'reset'; delete reset.shots[1].previousShotId; delete reset.shots[1].anchorShotId;
  assert.deepEqual(continuityDescendants({ continuity: { plan: reset } }, ['shot1']), ['shot1']);
});

for (const cut of [false, true]) test(`real tool flow reviews dependencies and invalidates descendants (cut=${cut})`, async () => {
  const store = await webtoonStore(), providers = provider();
  const call = (tool, args = {}) => runWebtoonTool({ store, toolName: `lore_webtoon_${tool}`, args: { workId, ...args }, providers });
  const approve = r => call('decide', { workflowId: r.workflowId, approvalId: r.approvalId, action: 'approve' });
  let r = await call('plan', { responses: answers, imageModel: 'gpt-image-2' });
  r = await approve(r); r = await approve(r);
  const workflowId = r.workflowId, path = join(store.rootDir, 'fixture.png'); await writeFile(path, pixel);
  r = await call('render', { workflowId });
  r = await call('render', { workflowId, references: r.jobs.map(j => ({ referenceId: j.referenceId, inputHash: j.inputHash, path })) });
  await approve(r);
  const continuityPlan = production();
  if (cut) { Object.assign(continuityPlan.shots[1], { transition: 'cut', visibleCharacters: [], background: 'abstract' }); delete continuityPlan.shots[1].anchorShotId; }
  r = await call('render', { workflowId, continuityPlan, feedback: '공간 고정과 연결 검토' });
  assert.equal(r.status, 'needs_continuity_roughs');
  assert.ok(r.jobs[0].referenceImages.length);
  await assert.rejects(call('render', { workflowId, continuityRoughs: [{ sceneId: 'door-scene', inputHash: 'stale', path }] }), /STALE_CONTINUITY_ROUGH/);
  r = await call('render', { workflowId, continuityRoughs: [{ sceneId: r.jobs[0].sceneId, inputHash: r.jobs[0].inputHash, path }] });
  assert.equal(r.status, 'needs_continuity_review');
  const rough = r.continuity.roughs[0];
  const review = { kind: 'rough', id: rough.sceneId, hash: rough.hash, inspectedImages: true, passed: true, evidence: 'Synthetic test fixture, not visual QA' };
  await assert.rejects(call('render', { workflowId, continuityReviews: [{ ...review, inspectedImages: false }] }), /ACTUAL_REVIEW/);
  r = await call('render', { workflowId, continuityReviews: [review] });
  assert.deepEqual(r.jobs.map(j => j.shotId), ['shot1']);
  assert.equal(r.blockedJobs[0].shotId, 'shot2');
  await assert.rejects(call('render', { workflowId, assets: [{ shotId: 'shot2', inputHash: 'bad', path }] }), /DEPENDENCY_NOT_REVIEWED/);
  const first = r.jobs[0];
  assert.ok(first.prompt.includes('현재 continuityPrompt'));
  const continuityPrompt = JSON.parse(first.continuityPrompt.slice(first.continuityPrompt.indexOf('\n') + 1));
  const artPrompt = JSON.parse(first.prompt.slice(first.prompt.indexOf('\n') + 1));
  assert.deepEqual(continuityPrompt.style, artPrompt.style);
  if (cut) {
    const assets = [{ shotId: first.shotId, inputHash: first.inputHash, path }];
    await assert.rejects(call('render', { workflowId, assets, continuityReviews: [{ ...review, kind: 'shot', id: 'shot1', hash: 'stale' }] }), /STALE_CONTINUITY_REVIEW/);
    r = await call('render', { workflowId, assets, continuityReviews: [{ ...review, kind: 'shot', id: 'shot1', hash: digest(pixel) }] });
    assert.equal(r.scheduling.strategy, 'ready-first');
    assert.deepEqual(r.jobs.map(j => j.shotId), ['shot2']);
  } else {
    r = await call('render', { workflowId, assets: [{ shotId: first.shotId, inputHash: first.inputHash, path }] });
    assert.equal(r.jobs.length, 0);
    r = await call('render', { workflowId, continuityReviews: [{ ...review, kind: 'shot', id: 'shot1', hash: r.continuity.shots[0].imageHash }] });
  }
  const second = r.jobs[0], ref = second.referenceImages.find(i => i.role === 'previous-shot');
  if (cut) assert.deepEqual(second.referenceImages, []);
  else {
    assert.equal(ref.subjectId, 'shot1'); assert.deepEqual(await readFile(ref.path), pixel);
    assert.ok(second.referenceImages.some(i => i.role === 'character'));
    assert.ok(second.referenceImages.some(i => i.role === 'environment'));
  }
  r = await call('render', { workflowId, assets: [{ shotId: 'shot2', inputHash: second.inputHash, path }] });
  r = await call('render', { workflowId, continuityReviews: [{ ...review, kind: 'shot', id: 'shot2', hash: r.continuity.shots[1].imageHash }] });
  assert.equal(r.approval.kind, 'look');
  await call('decide', { workflowId, approvalId: r.approvalId, action: 'request_revision', feedback: '첫 컷 구도 수정' });
  r = await call('render', { workflowId, regenerateShotIds: ['shot1'], feedback: '왼쪽 손을 올린다' });
  assert.deepEqual(r.jobs.map(j => j.shotId), ['shot1']);
  assert.equal(r.blockedJobs[0].shotId, 'shot2');
  assert.ok(r.continuity.shots.every(s => !s.imageHash && !s.review));
  await assert.rejects(call('render', { workflowId, assets: [{ shotId: 'shot2', inputHash: second.inputHash, path }] }), /DEPENDENCY_NOT_REVIEWED/);
});
