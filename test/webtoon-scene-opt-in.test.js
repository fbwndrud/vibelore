import test from 'node:test';
import assert from 'node:assert/strict';
import { workId } from './fixtures/webtoon.js';
import { scenePlan, scenePreflight, sceneSetup, sceneVisualChecks } from './fixtures/webtoon-scene.js';
import { runWebtoonSceneTool } from '../src/tools/webtoon-scene.js';
import { WebtoonStore } from '../src/store/webtoon-store.js';
import { runConfigureStatus } from '../src/tools/configure.js';

function provider() {
  return { provenance: { kind: 'fixture' }, async complete(r) {
    const d = JSON.parse(r.messages.at(-1).content); let answer;
    if (r.step === 'webtoon-scene-plan') answer = scenePlan(d.source);
    else if (r.step === 'webtoon-scene-preflight') answer = scenePreflight(d);
    else answer = { ...d.schema, visualChecks: sceneVisualChecks(), observedPanelCount: 6, inspectedImages: true, spatialCoherence: true, readingOrder: true, evidence: 'The actual image was inspected in this fixture.', textObservations: d.plan.texts.map(t => ({ id: t.id, observedText: t.text, readable: true, speakerCorrect: true, evidence: 'Visible caption.' })) };
    return { text: JSON.stringify(answer) };
  } };
}
const asset = (args, job) => ({ path: args.references[0].path, inputHash: job.inputHash, provenance: { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: 'selected-api' } });

test('scene start is refused without the user opt-in words', async () => {
  const { store, args } = await sceneSetup(); delete args.sceneDirect;
  await assert.rejects(runWebtoonSceneTool({ store, args, providers: provider() }), /SCENE_DIRECT_OPT_IN_REQUIRED.*lore_webtoon_episode/s);
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, delegation: { scope: 'production', userAnswer: '알아서' } }, providers: provider() }), /SCENE_DIRECT_OPT_IN_REQUIRED/);
  for (const userAnswer of ['', '   ', 5]) await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, sceneDirect: { userAnswer } }, providers: provider() }), /SCENE_DIRECT_OPT_IN_REQUIRED/);
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, sceneDirect: { enabled: true } }, providers: provider() }), /SCENE_DIRECT_OPT_IN_REQUIRED/);
  assert.equal(await new WebtoonStore(store).load(), null, 'a refused start leaves no workflow');
});

test('the user answer is recorded in scene_started as sceneDirect', async () => {
  const { store, args } = await sceneSetup(); args.sceneDirect = { userAnswer: '  장면 통째로 한 장으로 줘  ' };
  assert.equal((await runWebtoonSceneTool({ store, args, providers: provider() })).status, 'needs_scene_image');
  const started = (await new WebtoonStore(store).load()).events.find(e => e.event === 'scene_started');
  assert.deepEqual(started.sceneDirect, { userAnswer: '  장면 통째로 한 장으로 줘  ', source: 'args' });
});

test('work-level opt-in allows start; existing workflows still revise and review', async () => {
  const { store, args } = await sceneSetup(); delete args.sceneDirect;
  await assert.rejects(runWebtoonSceneTool({ store, args, providers: provider() }), /SCENE_DIRECT_OPT_IN_REQUIRED/);
  await runConfigureStatus({ store, workId, webtoonSceneDirect: { enabled: true, userAnswer: '장면 통째 생성으로 해줘' } });
  let r = await runWebtoonSceneTool({ store, args, providers: provider() });
  assert.equal(r.status, 'needs_scene_image');
  assert.deepEqual((await new WebtoonStore(store).load()).events.find(e => e.event === 'scene_started').sceneDirect, { userAnswer: '장면 통째 생성으로 해줘', source: 'work-setting' });
  r = await runWebtoonSceneTool({ store, args: { workId, asset: asset(args, r.jobs[0]) }, providers: provider() });
  assert.equal(r.status, 'completed');

  await runConfigureStatus({ store, workId, webtoonSceneDirect: null });
  const revised = await runWebtoonSceneTool({ store, args: { workId, action: 'revise', feedback: 'Give the door more room.' }, providers: provider() });
  assert.equal(revised.status, 'needs_scene_image'); assert.equal(revised.jobs.length, 1);
  const redrawn = await runWebtoonSceneTool({ store, args: { workId, asset: asset(args, revised.jobs[0]) }, providers: provider() });
  assert.equal(redrawn.status, 'completed');
  const reviewed = await runWebtoonSceneTool({ store, args: { workId, action: 'review', feedback: 'Look at the door again.' }, providers: provider() });
  assert.equal(reviewed.status, 'completed'); assert.equal(reviewed.reviewHistory.length, 1);
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, previousWorkflowId: undefined }, providers: provider() }), /SCENE_DIRECT_OPT_IN_REQUIRED/);
});
