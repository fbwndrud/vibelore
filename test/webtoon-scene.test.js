import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workId, pixel } from './fixtures/webtoon.js';
import { scenePlan, scenePreflight, sceneSetup } from './fixtures/webtoon-scene.js';
import { digest } from '../src/core/webtoon-contract.js';
import { runWebtoonSceneTool } from '../src/tools/webtoon-scene.js';
import { readWebtoonWorkflow } from '../src/tools/webtoon.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';
import { validateScenePlan, sceneBinding, sceneImageBinding, validateSceneRenderBrief, SCENE_CHECKS } from '../src/core/webtoon-scene.js';

const plan = scenePlan, preflight = scenePreflight, setup = sceneSetup;
function provider({ blocking = false, visual = true } = {}) {
  return { provenance: { kind: 'fixture' }, async complete(r) {
    const d = JSON.parse(r.messages.at(-1).content); let answer;
    if (r.step === 'webtoon-scene-plan') answer = plan(d.source);
    else if (r.step === 'webtoon-scene-preflight') answer = preflight(d, blocking);
    else answer = { ...d.schema, observedPanelCount: 6, inspectedImages: visual, spatialCoherence: true, readingOrder: true, evidence: 'The actual image was inspected in this fixture.', textObservations: d.plan.texts.map(t => ({ id: t.id, observedText: t.text, readable: true, speakerCorrect: true, evidence: 'Visible caption.' })) };
    return { text: JSON.stringify(answer) };
  } };
}
test('paid image jobs require complete semantic preflight; source and references remain bound', async () => {
  const { store, repo, args } = await setup(); const before = await readFile(store.chapterPath(1));
  const r = await runWebtoonSceneTool({ store, args, providers: provider({ blocking: true }) });
  assert.equal(r.status, 'scene_preflight_blocked'); assert.equal(r.jobs, undefined);
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId, asset: { path: args.references[0].path, inputHash: sceneBinding(await repo.load()), provenance: {} } }, providers: provider() }), /SCENE_PREFLIGHT_REQUIRED/);
  const fixed = await runWebtoonSceneTool({ store, args: { workId, action: 'revise', feedback: 'Clarify the spatial ambiguity.' }, providers: provider() });
  assert.equal(fixed.jobs.length, 1); assert.match(fixed.jobs[0].prompt, /Each panel shows one clear moment/);
  await writeFile(args.references[0].path, Buffer.concat([pixel, Buffer.from('changed')]));
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId }, providers: provider() }), /SCENE_REFERENCE_CHANGED|INVALID_PNG_CONTAINER/);
  assert.deepEqual(await readFile(store.chapterPath(1)), before);
});
test('native host relay resumes exact request IDs through planning and preflight', async () => {
  const { store, args } = await setup();
  let r = await runWebtoonSceneTool({ store, args, providers: createHostRelay() });
  assert.equal(r.status, 'needs_model'); const q = r.requests[0]; const data = JSON.parse(q.user);
  const run = await loadRun(store.rootDir, r.runId); assert.equal(run.tool, 'lore_webtoon_scene');
  r = await runWebtoonSceneTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(plan(data.source)) }) });
  assert.equal(r.requests[0].step, 'webtoon-scene-preflight');
  const q2 = r.requests[0], d2 = JSON.parse(q2.user), run2 = await loadRun(store.rootDir, r.runId);
  r = await runWebtoonSceneTool({ store, args: run2.args, run: run2, providers: createHostRelay({ [q2.id]: JSON.stringify(preflight(d2)) }) });
  assert.equal(r.status, 'needs_scene_image'); assert.equal((await readWebtoonWorkflow({ store, workId })).productionMode, 'scene-direct-v1');
});
test('stale assets and uninspected reviews fail; valid image review completes without prose writes', async () => {
  const { store, args } = await setup(); const before = await readFile(store.chapterPath(1));
  const r = await runWebtoonSceneTool({ store, args, providers: provider() });
  const asset = { path: args.references[0].path, inputHash: r.jobs[0].inputHash, provenance: { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: 'selected-api' } };
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId, asset: { ...asset, inputHash: 'old' } }, providers: provider() }), /SCENE_PREFLIGHT_REQUIRED/);
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId, asset }, providers: provider({ visual: false }) }), /SCENE_IMAGE_NOT_INSPECTED/);
  const final = await runWebtoonSceneTool({ store, args: { workId, action: 'retry' }, providers: provider() });
  assert.equal(final.status, 'completed'); assert.ok(final.artifacts['scene.html']);
  assert.deepEqual(await readFile(store.chapterPath(1)), before);
});
test('dialogue changed from source and missing text bindings are rejected before image generation', () => {
  const units = [{ id: 'p1', text: '원문 대사.' }]; const p = plan(units);
  p.texts[0].text = '모델이 바꾼 대사.';
  assert.throws(() => validateScenePlan(p, units), /SCENE_TEXT_NOT_VERBATIM/);
  p.texts[0].text = units[0].text; p.beats[0].textIds = [];
  assert.throws(() => validateScenePlan(p, units), /SCENE_TEXT_COVERAGE/);
});

test('with autoRevisions 0, observed text or speaker failures remain review findings and do not trigger a new image job', async () => {
  const { store, args } = await setup();
  const r = await runWebtoonSceneTool({ store, args: { ...args, autoRevisions: 0 }, providers: provider() });
  const p = provider(), complete = p.complete;
  p.complete = async request => {
    const response = await complete(request);
    if (request.step !== 'webtoon-scene-image-review') return response;
    const value = JSON.parse(response.text); value.textObservations[0].speakerCorrect = false;
    value.findings = [{ severity: 'blocking', evidence: 'Caption appears as the wrong speaker.' }];
    return { text: JSON.stringify(value) };
  };
  const result = await runWebtoonSceneTool({ store, args: { workId, asset: { path: args.references[0].path, inputHash: r.jobs[0].inputHash,
    provenance: { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: 'selected-api' } } }, providers: p });
  assert.equal(result.status, 'scene_needs_revision'); assert.equal(result.jobs, undefined);
  assert.equal(result.visualReview.passed, false); assert.ok(result.artifacts['scene.html']);
});

test('a changed source blocks image dispatch without overwriting the previous plan', async () => {
  const { store, repo, args } = await setup();
  await runWebtoonSceneTool({ store, args, providers: provider() });
  const before = (await repo.load()).scenePlan;
  await writeFile(store.chapterPath(1), (await readFile(store.chapterPath(1), 'utf8')) + '\n\n새로 바뀐 사건.\n');
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId }, providers: provider() }), /SCENE_SOURCE_CHANGED/);
  assert.deepEqual((await repo.load()).scenePlan, before);
});

test('panel count is a user choice before model calls; missing or invalid choices never create a workflow', async () => {
  const { store, repo, args } = await setup();
  const providers = { complete() { throw new Error('Must not call model'); } };
  const r = await runWebtoonSceneTool({ store, args: { ...args, panelCount: undefined }, providers });
  assert.equal(r.status, 'needs_interview'); assert.deepEqual(r.jobs, []); assert.equal(await repo.load(), null);
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, panelCount: 0 }, providers }), /INVALID_SCENE_PANEL_COUNT/);
});

test('a count mismatch blocks completion and changing a selected count cannot reuse an image receipt', async () => {
  const { store, args } = await setup();
  const r = await runWebtoonSceneTool({ store, args: { ...args, panelCount: 8, autoRevisions: 0 }, providers: provider() });
  assert.match(r.jobs[0].prompt, /EXACTLY 8 panels/);
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId, panelCount: 6 }, providers: provider() }), /SCENE_PANEL_COUNT_PINNED/);
  const result = await runWebtoonSceneTool({ store, args: { workId, asset: { path: args.references[0].path, inputHash: r.jobs[0].inputHash,
    provenance: { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: 'selected-api' } } }, providers: provider() });
  assert.equal(result.status, 'scene_needs_revision'); assert.equal(result.visualReview.observedPanelCount, 6);
});

test('continuation preserves prior failure, binds its image, and requires actual two-image continuity review', async () => {
  const { store, repo, args: base } = await setup(), args = { ...base, autoRevisions: 0 };
  const r = await runWebtoonSceneTool({ store, args: { ...args, panelCount: 8, sourceUnitIds: ['ch-1-p-1'] }, providers: provider() });
  const first = await runWebtoonSceneTool({ store, args: { workId, asset: { path: args.references[0].path, inputHash: r.jobs[0].inputHash,
    provenance: { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: 'selected-api' } } }, providers: provider() });
  const nextArgs = { ...args, previousWorkflowId: first.workflowId, sourceUnitIds: ['ch-1-p-2'] };
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...nextArgs, sourceUnitIds: ['ch-1-p-1'] }, providers: provider() }), /SCENE_CONTINUATION_SCOPE/);
  const next = await runWebtoonSceneTool({ store, args: nextArgs, providers: provider() });
  assert.equal(next.jobs[0].referenceImages.at(-1).hash, first.image.hash);
  assert.equal((await repo.load(first.workflowId)).stage, 'scene_needs_revision');
  const p = provider(), complete = p.complete;
  p.complete = async request => {
    const response = await complete(request);
    if (request.step !== 'webtoon-scene-image-review') return response;
    const a = JSON.parse(response.text);
    a.continuity = { inspectedPreviousImage: true, identity: { passed: false, evidence: 'Fixture character costume differs.' },
      setting: { passed: true, evidence: 'Same door.' }, actionTransition: { passed: true, evidence: 'Stops then speaks.' } };
    return { text: JSON.stringify(a) };
  };
  const asset = { path: args.references[0].path, inputHash: next.jobs[0].inputHash, provenance: { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: 'selected-api' } };
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId, asset }, providers: provider() }), /INCOMPLETE_SCENE_CONTINUITY_REVIEW/);
  const result = await runWebtoonSceneTool({ store, args: { workId, action: 'retry' }, providers: p });
  assert.equal(result.status, 'scene_needs_revision'); assert.equal(result.visualReview.continuity.identity.passed, false);
  const previousPath = (await repo.load(first.workflowId)).sceneImage.path;
  await writeFile(previousPath, Buffer.from('changed'));
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId }, providers: provider() }), /SCENE_REFERENCE_CHANGED|UNSUPPORTED_WEBTOON_IMAGE|INVALID_/);
});

test('preflight must produce a drawable brief before dispatch; audit prose must not reach the image model', async () => {
  const { store, args } = await setup();
  const p = provider(), complete = p.complete;
  p.complete = async request => {
    const r = await complete(request); const a = JSON.parse(r.text);
    if (request.step === 'webtoon-scene-plan') a.facts[0].statement += ' AUDIT_ONLY_DETAIL';
    if (request.step === 'webtoon-scene-preflight') {
      const d = JSON.parse(request.messages.at(-1).content);
      a.checks = d.schema.checks.map(c => ({ ...c, passed: true, evidence: 'Source checked and reduced to separate visible moments.' }));
      a.renderBrief = { style: 'Warm colored ink.', moments: Array.from({ length: 6 }, (_, i) => ({ sourceIds: [d.source[0].id], action: 'She waits at the door.', textIds: i === 0 ? ['text-1'] : [] })) };
    }
    return { text: JSON.stringify(a) };
  };
  const r = await runWebtoonSceneTool({ store, args, providers: p });
  assert.equal(r.status, 'needs_scene_image');
  assert.doesNotMatch(r.jobs[0].prompt, /AUDIT_ONLY_DETAIL/);
  assert.match(r.jobs[0].prompt, /Warm colored ink/);
});

test('all-pass preflight without a simplified image brief cannot issue paid image jobs', async () => {
  const { store, args } = await setup();
  const p = provider(), complete = p.complete;
  p.complete = async request => {
    const r = await complete(request); const a = JSON.parse(r.text);
    if (request.step === 'webtoon-scene-preflight') delete a.renderBrief;
    return { text: JSON.stringify(a) };
  };
  await assert.rejects(runWebtoonSceneTool({ store, args, providers: p }), /SCENE_RENDER_BRIEF_REQUIRED/);
});

test('drawability failure stops image dispatch even when factual checks pass', async () => {
  const { store, args } = await setup();
  const p = provider(), complete = p.complete;
  p.complete = async request => {
    const r = await complete(request); const a = JSON.parse(r.text);
    if (request.step === 'webtoon-scene-preflight') a.drawability = { passed: false, evidence: 'One moment still requires reaching, cutting and leading in sequence.' };
    return { text: JSON.stringify(a) };
  };
  const r = await runWebtoonSceneTool({ store, args, providers: p });
  assert.equal(r.status, 'scene_preflight_blocked'); assert.equal(r.jobs, undefined);
});

test('the short request preserves all exact texts and changed drawing instructions invalidate image receipts', async () => {
  const { store, repo, args } = await setup();
  const r = await runWebtoonSceneTool({ store, args, providers: provider() });
  const w = await repo.load(), original = sceneImageBinding(w);
  assert.equal(original, r.jobs[0].inputHash);
  assert.throws(() => validateSceneRenderBrief({ ...w.preflight.renderBrief, moments: w.preflight.renderBrief.moments.slice(1) }, w), /OVERLOADED/);
  const missing = structuredClone(w.preflight.renderBrief); missing.moments[0].textIds = [];
  assert.throws(() => validateSceneRenderBrief(missing, w), /SCENE_TEXT_COVERAGE/);
  w.preflight.renderBrief.moments[0].action = 'She opens the door.';
  assert.notEqual(sceneImageBinding(w), original);
  await repo.save(w);
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId }, providers: provider() }), /SCENE_RENDER_BRIEF_CHANGED/);
});

function autoProvider(counts) {
  const p = provider(), complete = p.complete, queue = [...counts];
  p.complete = async request => {
    const r = await complete(request); const a = JSON.parse(r.text);
    if (request.step === 'webtoon-scene-plan') { const next = queue.shift(); if (next !== null) a.panelCount = next; }
    return { text: JSON.stringify(a) };
  };
  return p;
}

test('interview offers four panels and auto; auto lets the model pick a count per adaptation', async () => {
  const { store, repo, args } = await setup();
  const asked = await runWebtoonSceneTool({ store, args: { ...args, panelCount: undefined }, providers: provider() });
  assert.deepEqual(asked.questions[0].options, [4, 6, 8, 9, 'auto']);
  const r = await runWebtoonSceneTool({ store, args: { ...args, panelCount: 'auto' }, providers: autoProvider([5, 7]) });
  assert.equal(r.status, 'needs_scene_image'); assert.equal(r.panelCountMode, 'auto'); assert.equal(r.panelCount, 5);
  assert.match(r.jobs[0].prompt, /EXACTLY 5 panels/); assert.equal(r.preflight.renderBrief.moments.length, 5);
  const revised = await runWebtoonSceneTool({ store, args: { workId, action: 'revise', feedback: 'Give the door more room.' }, providers: autoProvider([7]) });
  assert.equal(revised.panelCount, 7); assert.match(revised.jobs[0].prompt, /EXACTLY 7 panels/);
  assert.equal((await readWebtoonWorkflow({ store, workId })).panelCountMode, 'auto');
});

test('auto mode rejects a plan without a count or with fewer than three panels; unknown strings never start', async () => {
  const { store, args } = await setup();
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, panelCount: 'later' }, providers: provider() }), /INVALID_SCENE_PANEL_COUNT/);
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, panelCount: 'auto' }, providers: autoProvider([null]) }), /SCENE_PANEL_COUNT_UNRESOLVED/);
  const { store: store2, args: args2 } = await setup();
  await assert.rejects(runWebtoonSceneTool({ store: store2, args: { ...args2, panelCount: 'auto' }, providers: autoProvider([2]) }), /SCENE_PANEL_COUNT_UNRESOLVED/);
});

test('a user count below three is allowed but carries a continuity warning', async () => {
  const { store, args } = await setup();
  const one = await runWebtoonSceneTool({ store, args: { ...args, panelCount: 1 }, providers: provider() });
  assert.equal(one.status, 'needs_scene_image'); assert.equal(one.panelCountMode, 'user');
  assert.ok(one.warnings.some(w => /연속성/.test(w)));
  const { store: store2, args: args2 } = await setup();
  const four = await runWebtoonSceneTool({ store: store2, args: { ...args2, panelCount: 4 }, providers: provider() });
  assert.deepEqual(four.warnings, []);
});

test('needs_model responses carry the count mode and continuity warning; revise clears an auto count before re-planning', async () => {
  const { store, args } = await setup();
  const r = await runWebtoonSceneTool({ store, args: { ...args, panelCount: 1 }, providers: createHostRelay() });
  assert.equal(r.status, 'needs_model'); assert.equal(r.panelCountMode, 'user'); assert.equal(r.panelCount, 1);
  assert.ok(r.warnings.some(w => /연속성/.test(w)));
  const { store: store2, repo: repo2, args: args2 } = await setup();
  const done = await runWebtoonSceneTool({ store: store2, args: { ...args2, panelCount: 'auto' }, providers: autoProvider([5]) });
  assert.equal(done.panelCount, 5);
  const revised = await runWebtoonSceneTool({ store: store2, args: { workId, action: 'revise', feedback: 'Fewer moments.' }, providers: createHostRelay() });
  assert.equal(revised.status, 'needs_model'); assert.equal(revised.panelCountMode, 'auto'); assert.equal(revised.panelCount, null);
  assert.equal((await repo2.load()).panelCount, undefined); assert.deepEqual(revised.warnings, []);
});

test('a scene workflow saved before the short render brief gets the new drawing request on its next revise', async () => {
  const { store, repo, args } = await setup();
  await runWebtoonSceneTool({ store, args, providers: provider() });
  const legacy = await repo.load(); delete legacy.renderPromptVersion; legacy.stage = 'scene_needs_revision'; await repo.save(legacy);
  const revised = await runWebtoonSceneTool({ store, args: { workId, action: 'revise', feedback: 'Continue with the same door.' }, providers: provider() });
  assert.equal(revised.status, 'needs_scene_image');
  assert.match(revised.jobs[0].prompt, /Each panel shows one clear moment/);
  assert.equal(revised.jobs[0].inputHash, sceneImageBinding(await repo.load()));
});

const apiAsset = (path, job) => ({ path, inputHash: job.inputHash, provenance: { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: 'selected-api' } });

test('a failed image review re-plans automatically with the observed defects, keeps each attempt, and stops at the budget', async () => {
  const { store, args } = await setup();
  const p = provider(), complete = p.complete, seen = [];
  p.complete = async request => {
    const d = JSON.parse(request.messages.at(-1).content); seen.push({ step: request.step, d });
    const response = await complete(request);
    if (request.step === 'webtoon-scene-preflight' && d.feedback) {
      const v = JSON.parse(response.text); v.renderBrief.corrections = ['Keep the caption text exactly as quoted.']; return { text: JSON.stringify(v) };
    }
    if (request.step !== 'webtoon-scene-image-review') return response;
    const v = JSON.parse(response.text); v.textObservations[0].observedText = '틀린 글자';
    return { text: JSON.stringify(v) };
  };
  let r = await runWebtoonSceneTool({ store, args, providers: p });
  assert.deepEqual(r.autoRevision, { limit: 2, used: 0 });
  assert.match(r.jobs[0].prompt, /never add speaker names/); assert.match(r.jobs[0].prompt, /Never copy lettering from reference images/);
  assert.doesNotMatch(r.jobs[0].prompt, /Fix from the previous attempt/);
  for (let i = 1; i <= 2; i++) {
    r = await runWebtoonSceneTool({ store, args: { workId, asset: apiAsset(args.references[0].path, r.jobs[0]) }, providers: p });
    assert.equal(r.status, 'needs_scene_image'); assert.equal(r.revision, i + 1);
    assert.deepEqual(r.autoRevision, { limit: 2, used: i }); assert.equal(r.attempts.length, i);
    assert.equal(r.attempts[i - 1].failedAt, 'image_review'); assert.ok(r.attempts[i - 1].image.hash);
    assert.match(r.attempts[i - 1].feedback, /but the image showed "틀린 글자"/);
    assert.match(r.jobs[0].prompt, /Fix from the previous attempt:\n- Keep the caption text exactly as quoted\./);
  }
  const replans = seen.filter(x => x.step === 'webtoon-scene-plan' && x.d.feedback);
  assert.equal(replans.length, 2); assert.ok(replans[0].d.previousFindings.textObservations);
  r = await runWebtoonSceneTool({ store, args: { workId, asset: apiAsset(args.references[0].path, r.jobs[0]) }, providers: p });
  assert.equal(r.status, 'scene_needs_revision'); assert.equal(r.jobs, undefined); assert.equal(r.attempts.length, 2);
});

test('auto revision budget is validated at start and older workflows without a budget never auto revise', async () => {
  const { store, repo, args } = await setup();
  for (const autoRevisions of [-1, 4, 1.5, '2']) await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, autoRevisions }, providers: provider() }), /INVALID_SCENE_AUTO_REVISIONS/);
  const r = await runWebtoonSceneTool({ store, args, providers: provider() });
  const legacy = await repo.load(); delete legacy.autoRevision; delete legacy.attempts; await repo.save(legacy);
  const p = provider(), complete = p.complete;
  p.complete = async request => { const response = await complete(request);
    if (request.step !== 'webtoon-scene-image-review') return response;
    const v = JSON.parse(response.text); v.observedPanelCount = 7; return { text: JSON.stringify(v) }; };
  const done = await runWebtoonSceneTool({ store, args: { workId, asset: apiAsset(args.references[0].path, r.jobs[0]) }, providers: p });
  assert.equal(done.status, 'scene_needs_revision'); assert.deepEqual(done.autoRevision, { limit: 0, used: 0 });
});

test('render brief corrections are bounded English lines', () => {
  const w = { panelCount: 1, sceneUnits: [{ id: 'u' }], scenePlan: { texts: [] } };
  const brief = { style: 'Ink.', moments: [{ sourceIds: ['u'], action: 'She waits.', textIds: [] }] };
  assert.ok(validateSceneRenderBrief({ ...brief, corrections: ['No name labels on balloons.'] }, w));
  for (const corrections of [['a', 'b', 'c', 'd'], ['이름표 금지'], [Array(21).fill('word').join(' ')], 'text'])
    assert.throws(() => validateSceneRenderBrief({ ...brief, corrections }, w), /SCENE_RENDER_BRIEF_OVERLOADED/);
});
