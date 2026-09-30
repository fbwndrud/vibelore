import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { workId } from './fixtures/webtoon.js';
import { scenePlan, scenePreflight, sceneSetup } from './fixtures/webtoon-scene.js';
import { digest } from '../src/core/webtoon-contract.js';
import { runWebtoonSceneTool } from '../src/tools/webtoon-scene.js';

const noModel = { complete() { throw new Error('Must not call model'); } };
function provider() {
  return { provenance: { kind: 'fixture' }, async complete(r) {
    const d = JSON.parse(r.messages.at(-1).content); let answer;
    if (r.step === 'webtoon-scene-plan') answer = scenePlan(d.source);
    else if (r.step === 'webtoon-scene-preflight') answer = scenePreflight(d);
    else answer = { ...d.schema, observedPanelCount: 6, inspectedImages: true, spatialCoherence: true, readingOrder: true, evidence: 'Fixture inspection.',
      textObservations: d.plan.texts.map(t => ({ id: t.id, observedText: t.text, readable: true, speakerCorrect: true, evidence: 'Visible caption.' })) };
    return { text: JSON.stringify(answer) };
  } };
}

/** What Codex reports: a built-in tool without a model argument, and its API CLI with selectable models. */
const codexRuntime = { host: 'codex', options: [
  { id: 'codex-image-gen', execution: 'host-built-in', provider: 'codex', tool: 'image_gen', modelSelectable: false, models: [], billing: 'host-usage',
    note: 'Codex picks the model; the tool has no model argument. Output C2PA names ChatGPT gpt-image.' },
  { id: 'openai-api', execution: 'api', provider: 'openai', modelSelectable: true, models: ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'], billing: 'api', credential: 'OPENAI_API_KEY' },
] };
const apiOnlyRuntime = { host: 'claude-code', options: [codexRuntime.options[1]] };

async function freshWork() {
  const s = await sceneSetup();
  await writeFile(s.repo.path('image-selection.json'), '{}');
  return s;
}

test('a work without a saved image choice asks the host what image paths it offers before anything else', async () => {
  const { store, repo, args } = await freshWork();
  const r = await runWebtoonSceneTool({ store, args, providers: noModel });
  assert.equal(r.status, 'needs_image_runtime'); assert.deepEqual(r.jobs, []); assert.equal(await repo.load(), null);
  assert.match(r.nextAction, /imageRuntime/);
});

test('the host-reported built-in tool is proposed first and every reported option is shown to the user', async () => {
  const { store, args } = await freshWork();
  const r = await runWebtoonSceneTool({ store, args: { ...args, imageRuntime: codexRuntime }, providers: noModel });
  assert.equal(r.status, 'needs_image_choice');
  assert.equal(r.imageChoice.proposed.optionId, 'codex-image-gen');
  assert.equal(r.imageChoice.policy.execution, 'host-built-in'); assert.equal(r.imageChoice.policy.tool, 'image_gen');
  assert.equal(r.imageChoice.policy.targetModel, null); assert.equal(r.imageChoice.policy.modelSelectable, false);
  assert.match(r.imageChoice.policy.hostNote, /no model argument/);
  assert.deepEqual(r.imageChoice.options.map(o => o.id), ['codex-image-gen', 'openai-api']);
  assert.deepEqual(r.imageChoice.options[1].models, codexRuntime.options[1].models);
});

test('a confirmed built-in choice issues a host tool job and records what the host observed', async () => {
  const { store, repo, args } = await freshWork();
  const withRuntime = { ...args, imageRuntime: codexRuntime };
  const choice = await runWebtoonSceneTool({ store, args: withRuntime, providers: noModel });
  const r = await runWebtoonSceneTool({ store, args: { ...withRuntime, confirmImageChoice: choice.imageChoice.id, feedback: '코덱스 내장으로 그려 줘' }, providers: provider() });
  assert.equal(r.status, 'needs_scene_image');
  const job = r.jobs[0];
  assert.equal(job.apiRequest, undefined);
  assert.deepEqual(job.hostRequest, { host: 'codex', provider: 'codex', tool: 'image_gen', model: null, selectionId: choice.imageChoice.id, executionOwner: 'host' });
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId, asset: { path: args.references[0].path, inputHash: job.inputHash,
    provenance: { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: choice.imageChoice.id } } }, providers: provider() }), /IMAGE_EXECUTION_PROVENANCE_REQUIRED/);
  const done = await runWebtoonSceneTool({ store, args: { workId, asset: { path: args.references[0].path, inputHash: job.inputHash,
    provenance: { kind: 'host-built-in', provider: 'codex', tool: 'image_gen', selectionId: choice.imageChoice.id, observedModel: 'gpt-image (C2PA softwareAgent ChatGPT)' } } }, providers: provider() });
  assert.equal(done.status, 'completed');
  assert.equal(done.image.provenance.observedModel, 'gpt-image (C2PA softwareAgent ChatGPT)');
  const saved = JSON.parse(await readFile(repo.path('image-selection.json'), 'utf8'));
  assert.equal(saved.policy.execution, 'host-built-in'); assert.equal(saved.selection.userAnswer, '코덱스 내장으로 그려 줘');
  assert.equal(saved.selection.policyHash, digest(saved.policy));
});

test('the saved choice is reused, and only an explicit change request reopens it for an API model', async () => {
  const { store, repo, args } = await freshWork();
  const withRuntime = { ...args, imageRuntime: codexRuntime };
  const first = await runWebtoonSceneTool({ store, args: withRuntime, providers: noModel });
  await runWebtoonSceneTool({ store, args: { ...withRuntime, confirmImageChoice: first.imageChoice.id, feedback: '내장' }, providers: provider() });
  await writeFile(repo.path('current.json'), '{}');
  const reused = await runWebtoonSceneTool({ store, args, providers: provider() });
  assert.equal(reused.status, 'needs_scene_image'); assert.equal(reused.jobs[0].hostRequest.tool, 'image_gen');

  await writeFile(repo.path('current.json'), '{}');
  const change = { ...args, changeImageChoice: true, imageRuntime: codexRuntime, imageOption: 'openai-api', imageModel: 'gpt-image-2.5-sunburst' };
  const proposed = await runWebtoonSceneTool({ store, args: change, providers: noModel });
  assert.equal(proposed.status, 'needs_image_choice');
  assert.equal(proposed.imageChoice.policy.execution, 'api'); assert.equal(proposed.imageChoice.policy.targetModel, 'gpt-image-2.5-sunburst');
  assert.match(proposed.imageChoice.notice, /OPENAI_API_KEY/);
  const r = await runWebtoonSceneTool({ store, args: { ...change, confirmImageChoice: proposed.imageChoice.id, feedback: '이제부터 API 쓸래' }, providers: provider() });
  assert.deepEqual(r.jobs[0].apiRequest, { provider: 'openai', model: 'gpt-image-2.5-sunburst', endpoint: '/v1/images/edits', selectionId: proposed.imageChoice.id, executionOwner: 'host', credential: 'OPENAI_API_KEY' });
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId, asset: { path: args.references[0].path, inputHash: r.jobs[0].inputHash,
    provenance: { kind: 'api', provider: 'openai', requestedModel: 'gpt-image-2', selectionId: proposed.imageChoice.id } } }, providers: provider() }), /IMAGE_EXECUTION_PROVENANCE_REQUIRED/);
  const done = await runWebtoonSceneTool({ store, args: { workId, asset: { path: args.references[0].path, inputHash: r.jobs[0].inputHash,
    provenance: { kind: 'api', provider: 'openai', requestedModel: 'gpt-image-2.5-sunburst', selectionId: proposed.imageChoice.id } } }, providers: provider() });
  assert.equal(done.status, 'completed');
});

test('a host without a built-in image tool proposes its API option and a model the host did not offer is refused', async () => {
  const { store, args } = await freshWork();
  const r = await runWebtoonSceneTool({ store, args: { ...args, imageRuntime: apiOnlyRuntime }, providers: noModel });
  assert.equal(r.imageChoice.policy.execution, 'api'); assert.equal(r.imageChoice.policy.targetModel, 'gpt-image-2.5-sunburst');
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, imageRuntime: apiOnlyRuntime, imageModel: 'gpt-image-9' }, providers: noModel }), /IMAGE_MODEL_NOT_OFFERED/);
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, imageRuntime: codexRuntime, imageOption: 'codex-image-gen', imageModel: 'gpt-image-2' }, providers: noModel }), /IMAGE_MODEL_NOT_SELECTABLE/);
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, imageRuntime: codexRuntime, imageOption: 'missing' }, providers: noModel }), /IMAGE_OPTION_NOT_OFFERED/);
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, imageRuntime: { host: 'x', options: [] } }, providers: noModel }), /INVALID_IMAGE_RUNTIME/);
});

test('confirming requires the same reported option and the user own answer', async () => {
  const { store, args } = await freshWork();
  const withRuntime = { ...args, imageRuntime: codexRuntime };
  const choice = await runWebtoonSceneTool({ store, args: withRuntime, providers: noModel });
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...withRuntime, confirmImageChoice: choice.imageChoice.id }, providers: noModel }), /IMAGE_CHOICE_USER_ANSWER_REQUIRED/);
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...withRuntime, imageOption: 'openai-api', confirmImageChoice: choice.imageChoice.id, feedback: '승인' }, providers: noModel }), /STALE_IMAGE_CHOICE/);
});

test('an API path whose account models are unknown is accepted, and choosing it needs the user model', async () => {
  const { store, args } = await freshWork();
  const unknownModels = { host: 'codex', options: [codexRuntime.options[0], { ...codexRuntime.options[1], models: [], note: 'CLI accepts any gpt-image-* id; account models unknown.' }] };
  const r = await runWebtoonSceneTool({ store, args: { ...args, imageRuntime: unknownModels }, providers: noModel });
  assert.equal(r.imageChoice.proposed.optionId, 'codex-image-gen'); assert.deepEqual(r.imageChoice.options[1].models, []);
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, imageRuntime: unknownModels, imageOption: 'openai-api' }, providers: noModel }), /IMAGE_MODEL_REQUIRED/);
  const api = await runWebtoonSceneTool({ store, args: { ...args, imageRuntime: unknownModels, imageOption: 'openai-api', imageModel: 'gpt-image-2.5-flare' }, providers: noModel });
  assert.equal(api.imageChoice.policy.targetModel, 'gpt-image-2.5-flare');
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, imageRuntime: { host: 'codex', options: [{ ...codexRuntime.options[1], models: ['bad model'] }] } }, providers: noModel }),
    /INVALID_IMAGE_RUNTIME: options\[0\]\.models/);
});

test('a proposal is confirmed by its id alone', async () => {
  const { store, args } = await freshWork();
  const choice = await runWebtoonSceneTool({ store, args: { ...args, imageRuntime: codexRuntime }, providers: noModel });
  const r = await runWebtoonSceneTool({ store, args: { ...args, confirmImageChoice: choice.imageChoice.id, feedback: '내장으로' }, providers: provider() });
  assert.equal(r.status, 'needs_scene_image'); assert.equal(r.jobs[0].hostRequest.tool, 'image_gen');
});
