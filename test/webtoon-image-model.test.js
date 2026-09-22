import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLegacyWebtoonTool as runWebtoonTool } from './fixtures/legacy-webtoon.js';
import { WebtoonStore } from '../src/store/webtoon-store.js';
import { digest } from '../src/core/webtoon-contract.js';
import { imagePolicyFor, referenceSpecs, referenceJobs, shotJobs, LEGACY_CODEX_IMAGE_POLICY } from '../src/core/webtoon-images.js';
import { answers, webtoonStore, workId, provider, pixel } from './fixtures/webtoon.js';

const call = (store, name, args = {}, providers = provider()) => runWebtoonTool({ store, toolName: `lore_webtoon_${name}`, args: { workId, ...args }, providers });
const approve = (store, state) => call(store, 'decide', { workflowId: state.workflowId, approvalId: state.approvalId, action: 'approve' });
async function accepted(imageModel) {
  const store = await webtoonStore();
  const profile = await call(store, 'plan', { responses: answers, imageModel });
  const plan = await approve(store, profile);
  return { store, state: await approve(store, plan), oldGate: plan.approvalId };
}
async function choose(store, state, options = {}) {
  const choice = await call(store, 'render', { workflowId: state.workflowId, ...options });
  assert.equal(choice.status, 'needs_image_choice');
  const gate = await call(store, 'render', { workflowId: state.workflowId, confirmImageChoice: choice.imageChoice.id, feedback: '사용자가 모델과 경로 및 해당 비용을 확인하고 계속 사용하기로 선택했다.' });
  return approve(store, gate);
}

test('new default requires a choice; confirmed unavailable builtin yields no executable jobs or fake imports', async () => {
  const { store, state: initial } = await accepted();
  const state = await choose(store, initial);
  assert.equal(state.imagePolicy.targetModel, 'gpt-image-2.5-sunburst');
  assert.equal(state.imageRuntime.available, false);
  const p = provider();
  const result = await call(store, 'render', { workflowId: state.workflowId }, p);
  assert.equal(result.status, 'needs_image_runtime');
  assert.deepEqual(result.jobs, []);
  assert.equal(result.capabilities.observedModel, null);
  assert.equal(p.requests.length, 0);
  const repo = new WebtoonStore(store); const before = await repo.load();
  for (const field of ['assets', 'references']) {
    await assert.rejects(call(store, 'render', { workflowId: state.workflowId,
      [field]: [{ path: 'fake.png', provenance: { kind: 'codex-built-in', observedModel: 'gpt-image-2.5-sunburst' } }] }), /WEBTOON_IMAGE_RUNTIME_REQUIRED/);
  }
  assert.deepEqual(await repo.load(), before);
  assert.throws(() => referenceJobs(before), /WEBTOON_IMAGE_RUNTIME_REQUIRED/);
  assert.throws(() => shotJobs(before), /WEBTOON_IMAGE_RUNTIME_REQUIRED/);
});

test('model migration preserves approved script and prose but renews contract and approval', async () => {
  const { store, state, oldGate } = await accepted('gpt-image-2');
  const repo = new WebtoonStore(store); const before = await repo.load();
  const prose = await readFile(store.chapterPath(1));
  const p = provider();
  const choice = await call(store, 'render', { workflowId: state.workflowId, revision: state.revision, imageModel: 'gpt-image-2.5-sunburst' }, p);
  assert.equal(choice.status, 'needs_image_choice');
  assert.equal(choice.imagePolicy.targetModel, 'gpt-image-2');
  assert.equal(p.requests.length, 0);
  const result = await call(store, 'render', { workflowId: state.workflowId, confirmImageChoice: choice.imageChoice.id, feedback: '이 모델로 변경한다.' }, p);
  assert.equal(result.approval.kind, 'plan');
  assert.equal(result.revision, state.revision + 1);
  assert.notEqual(result.approvalId, oldGate);
  assert.notEqual(result.profileDigest, state.profileDigest);
  assert.deepEqual(result.plan, state.plan);
  assert.deepEqual(result.editorial, state.editorial);
  assert.deepEqual(await readFile(store.chapterPath(1)), prose);
  assert.deepEqual(p.requests.map(r => r.step), ['webtoon-plan-review']);
  assert.notDeepEqual(result.references.map(r => r.inputHash), before.referenceSpecs.map(r => r.inputHash));
  await assert.rejects(call(store, 'decide', { workflowId: state.workflowId, approvalId: oldGate, action: 'approve' }), /STALE_WEBTOON_APPROVAL/);
  await approve(store, result);
  assert.equal((await call(store, 'render', { workflowId: state.workflowId })).status, 'needs_image_runtime');
  // Persisted legacy data continues to hash and issue requests exactly as before.
  assert.deepEqual(before.imagePolicy, LEGACY_CODEX_IMAGE_POLICY);
  assert.deepEqual(referenceSpecs(before), before.referenceSpecs);
  assert.equal(referenceJobs(before)[0].execution.targetModel, 'gpt-image-2');
  const spec = before.referenceSpecs[0];
  const { kind, subjectId, design, original, variant, style } = spec;
  assert.equal(spec.inputHash, digest({ kind, subjectId, design, original, variant, style, policy: LEGACY_CODEX_IMAGE_POLICY }));
});

test('migration is explicit, isolated and refuses existing images without changing stored state', async () => {
  const { store, state } = await accepted('gpt-image-2');
  const args = { workflowId: state.workflowId, imageModel: 'gpt-image-2.5-flare' };
  const repo = new WebtoonStore(store); const before = await repo.load();
  await assert.rejects(call(store, 'plan', args), /IMAGE_MODEL_CHANGE_REQUIRES_RENDER/);
  await assert.rejects(call(store, 'render', { ...args, quality: 'preview' }), /IMAGE_MODEL_CHANGE_MUST_BE_SEPARATE/);
  assert.deepEqual(await repo.load(), before);
  before.images.shot1 = { hash: 'existing-image' }; await repo.save(before);
  await assert.rejects(call(store, 'render', args), /IMAGE_MODEL_CHANGE_REQUIRES_EMPTY_ART/);
  assert.deepEqual(await repo.load(), before);
});

test('only exact documented model names accepted; Flare remains explicit and blocked', async () => {
  for (const name of ['gpt-image-2.5', 'GPT 2.5', 'gpt-image-latest', null]) assert.throws(() => imagePolicyFor(name), /UNSUPPORTED_WEBTOON_IMAGE_MODEL/);
  const { store, state: initial } = await accepted('gpt-image-2.5-flare');
  const state = await choose(store, initial);
  const result = await call(store, 'render', { workflowId: state.workflowId, imageModel: 'gpt-image-2.5-flare' });
  assert.equal(result.status, 'needs_image_runtime');
  assert.equal(result.revision, state.revision);
  assert.equal(result.imagePolicy.targetModel, 'gpt-image-2.5-flare');
});

test('changing model unbinds approved references while preserving their files and reusable library', async () => {
  const { store, state } = await accepted('gpt-image-2');
  const workflowId = state.workflowId;
  const requested = await call(store, 'render', { workflowId });
  const path = join(store.rootDir, 'reference.png'); await writeFile(path, pixel);
  const gate = await call(store, 'render', { workflowId,
    references: requested.jobs.map(({ referenceId, inputHash }) => ({ referenceId, inputHash, path })) });
  await approve(store, gate);
  const repo = new WebtoonStore(store); const before = await repo.load();
  const library = await readFile(repo.path('reference-library.json'));
  const result = await choose(store, { workflowId }, { imageModel: 'gpt-image-2.5-sunburst' });
  assert.ok(result.references.every(ref => ref.status === 'missing'));
  for (const entry of Object.values(before.references)) assert.deepEqual(await readFile(entry.path), pixel);
  assert.deepEqual(await readFile(repo.path('reference-library.json')), library);
  assert.equal((await repo.load()).events.findLast(e => e.event === 'image_model_changed').previousReferences.length, requested.jobs.length);
});

test('API consent pins explicit request model and survives restart and the next workflow', async () => {
  const { store, state: initial } = await accepted();
  const state = await choose(store, initial, { imageExecution: 'openai-api' });
  assert.equal(state.imagePolicy.execution, 'openai-api');
  assert.equal(state.imageSelection.billing, 'openai-api');
  const workflowId = state.workflowId;
  const requested = await call(store, 'render', { workflowId });
  assert.equal(requested.status, 'needs_reference_images');
  assert.equal(requested.jobs[0].apiRequest.model, 'gpt-image-2.5-sunburst');
  assert.equal(requested.jobs[0].apiRequest.endpoint, '/v1/images/generations');
  assert.deepEqual((await call(store, 'render', { workflowId })).jobs, requested.jobs);
  const path = join(store.rootDir, 'reference.png'); await writeFile(path, pixel);
  const inputs = requested.jobs.map(({ referenceId, inputHash }) => ({ referenceId, inputHash, path }));
  await assert.rejects(call(store, 'render', { workflowId, references: inputs }), /IMAGE_EXECUTION_PROVENANCE_REQUIRED/);
  const provenance = { kind: 'openai-api', requestedModel: state.imagePolicy.targetModel, selectionId: state.imageSelection.id };
  const gate = await call(store, 'render', { workflowId, references: inputs.map(i => ({ ...i, provenance })) });
  await approve(store, gate);
  const shots = await call(store, 'render', { workflowId });
  assert.equal(shots.capabilities.provider, 'openai-api');
  assert.equal(shots.jobs[0].apiRequest.endpoint, '/v1/images/edits');
  const assets = shots.jobs.map(({ shotId, inputHash }) => ({ shotId, inputHash, path, provenance }));
  await assert.rejects(call(store, 'render', { workflowId, assets: assets.map(a => ({ ...a, provenance: { ...provenance, observedModel: 'gpt-image-2' } })) }), /IMAGE_OBSERVED_MODEL_MISMATCH/);
  await approve(store, await call(store, 'render', { workflowId, assets }));
  await approve(store, await call(store, 'render', { workflowId, quality: 'final' }));
  const next = await call(store, 'plan', { newWorkflow: true, episode: 2 });
  assert.deepEqual(next.imagePolicy, state.imagePolicy);
  assert.deepEqual(next.imageSelection, state.imageSelection);
  const nextPlan = await approve(store, next);
  const nextAccepted = await approve(store, nextPlan);
  assert.equal((await call(store, 'render', { workflowId: nextAccepted.workflowId })).status, 'needs_images');
});

test('choice IDs bind the proposal and reject stale, mixed, and empty confirmations', async () => {
  const { store, state } = await accepted();
  const args = { workflowId: state.workflowId };
  const first = await call(store, 'render', { ...args, imageExecution: 'openai-api' });
  const repeated = await call(store, 'render', args);
  assert.equal(repeated.imageChoice.id, first.imageChoice.id);
  await assert.rejects(call(store, 'render', { ...args, confirmImageChoice: first.imageChoice.id }), /IMAGE_CHOICE_USER_ANSWER_REQUIRED/);
  await assert.rejects(call(store, 'render', { ...args, confirmImageChoice: first.imageChoice.id, imageModel: 'gpt-image-2.5-flare', feedback: '승인' }), /STALE_IMAGE_CHOICE/);
  const second = await call(store, 'render', { ...args, imageModel: 'gpt-image-2.5-flare', imageExecution: 'openai-api' });
  await assert.rejects(call(store, 'render', { ...args, confirmImageChoice: first.imageChoice.id, feedback: '승인' }), /STALE_IMAGE_CHOICE/);
  const gate = await call(store, 'render', { ...args, confirmImageChoice: second.imageChoice.id, feedback: 'Flare API 선택' });
  await approve(store, gate);
  await assert.rejects(call(store, 'render', { ...args, confirmImageChoice: second.imageChoice.id, feedback: '재전송' }), /STALE_IMAGE_CHOICE/);
  assert.equal((await call(store, 'render', args)).jobs[0].execution.targetModel, 'gpt-image-2.5-flare');
});

test('explicit migration preserves approved reference provenance and rejects stale choices and tampered bytes', async () => {
  const { store, state: initial } = await accepted();
  const state = await choose(store, initial, { imageExecution: 'openai-api' });
  const workflowId = state.workflowId;
  await assert.rejects(call(store, 'render', { workflowId, imageModel: 'gpt-image-2.5-flare', preserveReferences: true }), /REFERENCE_PRESERVATION_REQUIRES_APPROVAL/);
  const requested = await call(store, 'render', { workflowId });
  const path = join(store.rootDir, 'reference.png'); await writeFile(path, pixel);
  const provenance = { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: state.imageSelection.id };
  const gate = await call(store, 'render', { workflowId, references: requested.jobs.map(({ referenceId, inputHash }) => ({ referenceId, inputHash, path, provenance })) });
  await approve(store, gate);
  const repo = new WebtoonStore(store); const before = await repo.load();
  const first = await call(store, 'render', { workflowId, imageModel: 'gpt-image-2.5-flare', preserveReferences: false });
  const choice = await call(store, 'render', { workflowId, preserveReferences: true });
  assert.notEqual(first.imageChoice.id, choice.imageChoice.id);
  await assert.rejects(call(store, 'render', { workflowId, confirmImageChoice: first.imageChoice.id, feedback: '진행' }), /STALE_IMAGE_CHOICE/);
  await assert.rejects(call(store, 'render', { workflowId, confirmImageChoice: choice.imageChoice.id, preserveReferences: false, feedback: '진행' }), /STALE_IMAGE_CHOICE/);
  const approvedPath = Object.values(before.references)[0].path;
  await writeFile(approvedPath, Buffer.concat([pixel, Buffer.from('tamper')]));
  await assert.rejects(call(store, 'render', { workflowId, confirmImageChoice: choice.imageChoice.id, feedback: '진행' }), /WEBTOON_WORKING_TREE_DRIFT|APPROVED_REFERENCE_BYTES_CHANGED/);
  assert.equal((await repo.load()).imagePolicy.targetModel, 'gpt-image-2.5-sunburst');
  await writeFile(approvedPath, pixel);
  const changed = await call(store, 'render', { workflowId, confirmImageChoice: choice.imageChoice.id, feedback: '기존 참조를 보존하고 새 컷은 Flare로 진행' });
  await approve(store, changed);
  const shots = await call(store, 'render', { workflowId });
  assert.equal(shots.status, 'needs_images');
  assert.ok(shots.jobs.every(j => j.apiRequest.model === 'gpt-image-2.5-flare'));
  for (const ref of shots.jobs.flatMap(j => j.referenceImages)) {
    assert.deepEqual(ref.provenance, provenance);
    assert.equal(ref.approval.id, gate.approvalId);
    assert.equal(ref.reuse.selectionId, choice.imageChoice.id);
    assert.deepEqual(await readFile(ref.path), pixel);
  }
  const assets = shots.jobs.map(({ shotId, inputHash }) => ({ shotId, inputHash, path, provenance }));
  await assert.rejects(call(store, 'render', { workflowId, assets }), /IMAGE_EXECUTION_PROVENANCE_REQUIRED/);
  const nextProvenance = { ...provenance, requestedModel: 'gpt-image-2.5-flare', selectionId: choice.imageChoice.id };
  await approve(store, await call(store, 'render', { workflowId, assets: assets.map(a => ({ ...a, provenance: nextProvenance })) }));
  await approve(store, await call(store, 'render', { workflowId, quality: 'final' }));
  const next = await call(store, 'plan', { newWorkflow: true, episode: 2 });
  const ready = await approve(store, await approve(store, next));
  const nextJobs = await call(store, 'render', { workflowId: ready.workflowId });
  assert.equal(nextJobs.status, 'needs_images');
  assert.deepEqual(nextJobs.jobs[0].referenceImages[0].provenance, provenance);
});

test('new cost constraints revoke remembered API consent instead of overriding the newer user answer', async () => {
  const { store, state: initial } = await accepted();
  const state = await choose(store, initial, { imageExecution: 'openai-api' });
  const changed = await call(store, 'plan', { workflowId: state.workflowId, responses: { W11: '이제 별도 API 과금은 중단한다.' } });
  assert.equal(changed.imageSelection, null);
  assert.equal(changed.imageRuntime.available, false);
  const saved = JSON.parse(await readFile(new WebtoonStore(store).path('image-selection.json')));
  assert.equal(saved.selection, null);
  const ready = await approve(store, await approve(store, changed));
  assert.equal((await call(store, 'render', { workflowId: ready.workflowId })).status, 'needs_image_choice');
});
