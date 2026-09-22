import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runLegacyWebtoonTool as runWebtoonTool } from './fixtures/legacy-webtoon.js';
import { WebtoonStore, resolveWebtoonSource } from '../src/store/webtoon-store.js';
import { answers, webtoonStore, workId, provider, pixel, plan } from './fixtures/webtoon.js';

const invoke = (store, name, args = {}, p = provider()) => runWebtoonTool({ store, toolName: `lore_webtoon_${name}`, args: { workId, ...(name === 'plan' ? { imageModel: 'gpt-image-2' } : {}), ...args }, providers: p });
const approve = (store, result, p) => invoke(store, 'decide', { workflowId: result.workflowId, approvalId: result.approvalId, action: 'approve' }, p);
async function planned(p = provider()) {
  const store = await webtoonStore();
  const direction = await invoke(store, 'plan', { responses: answers }, p);
  const candidate = await approve(store, direction, p);
  const accepted = await approve(store, candidate, p);
  return { store, workflowId: accepted.workflowId };
}
async function references(store, workflowId) {
  const requested = await invoke(store, 'render', { workflowId });
  assert.equal(requested.status, 'needs_reference_images');
  const path = join(store.rootDir, 'refs.png'); await writeFile(path, pixel);
  const candidate = await invoke(store, 'render', { workflowId,
    references: requested.jobs.map(({ referenceId, inputHash }) => ({ referenceId, inputHash, path })) });
  assert.equal(candidate.approval.kind, 'references');
  await approve(store, candidate);
  return invoke(store, 'render', { workflowId });
}
async function fillShots(store, workflowId, requested) {
  const path = join(store.rootDir, 'shots.png'); await writeFile(path, pixel);
  return invoke(store, 'render', { workflowId, assets: requested.jobs.map(({ shotId, inputHash }) => ({ shotId, inputHash, path, provenance: { kind: 'codex-built-in' } })) });
}

test('raw extra world and character sections reach planner with source hashes and temporal caution', async () => {
  const store = await webtoonStore(); const p = provider();
  await mkdir(join(store.rootDir, 'world', 'places'));
  const raw = '# 독자 추가 공간\n\n문 손잡이는 물고기 모양의 청동이다.\n';
  await writeFile(join(store.rootDir, 'world', 'places', 'door.md'), raw);
  const character = join(store.rootDir, 'characters', 'hero.md');
  await writeFile(character, await readFile(character, 'utf8') + '\n## 별도 디자인 메모\n\n왼쪽 눈 밑에 작은 점.\n');
  const first = await invoke(store, 'plan', { responses: answers }, p);
  await approve(store, first, p);
  const data = JSON.parse(p.requests.find(({ step }) => step === 'webtoon-plan').messages.at(-1).content);
  assert.equal(data.source.documents.find(({ id }) => id === 'world/places/door.md').raw, raw);
  assert.match(data.source.documents.find(({ id }) => id === 'characters/hero.md').raw, /작은 점/);
  assert.equal(data.source.documents[0].temporalScope, 'current-document-not-as-of-scene');
  assert.equal(data.source.foundation.characters[0].mutable, undefined);
});

test('source-linked interview inherits known characters without answering visual preferences for the user', async () => {
  const store = await webtoonStore();
  const first = await invoke(store, 'plan');
  const result = await invoke(store, 'plan', { workflowId: first.workflowId, responses: { W04: '선명한 컬러', W15: 'standard', W16: 'scroll' } });
  const question = result.questions.find(({ id }) => id === 'W02');
  assert.equal(question.inherited.characters[0].canonicalName, '윤');
  assert.ok(question.inherited.documentIds.includes('characters/hero.md'));
  assert.equal(result.decisions.W05, undefined);
  assert.ok(result.coverage.missing.includes('W05'));
  assert.equal(result.imagePolicy.targetModel, 'gpt-image-2');
  assert.equal(result.imagePolicy.observedModel, null);
});

test('symlinked supplemental source documents are rejected', async () => {
  const store = await webtoonStore();
  await symlink('/etc/hosts', join(store.rootDir, 'world', 'extra.md'));
  await assert.rejects(resolveWebtoonSource(store, workId), /SOURCE_SYMLINK_UNSUPPORTED/);
});

test('reference candidates require actual visual review and approval before shot generation', async () => {
  const { store, workflowId } = await planned();
  const requested = await invoke(store, 'render', { workflowId });
  assert.equal(requested.status, 'needs_reference_images');
  assert.equal(requested.jobs.length, 2);
  assert.deepEqual(new Set(requested.jobs.map(({ design }) => design.kind)), new Set(['character', 'environment']));
  const path = join(store.rootDir, 'refs.png'); await writeFile(path, pixel);
  await assert.rejects(invoke(store, 'render', { workflowId, assets: [{ shotId: 'shot1', path }] }), /REFERENCES_APPROVAL_REQUIRED/);
  const candidate = await invoke(store, 'render', { workflowId, references: requested.jobs.map(({ referenceId, inputHash }) => ({ referenceId, inputHash, path })) },
    provider({ response: (request, data) => request.step === 'webtoon-render-review' ? { ...data.schema, inspectedImages: false } : undefined }));
  assert.equal(candidate.approval.kind, 'references');
  assert.equal(candidate.quality.status, 'failed');
  await assert.rejects(invoke(store, 'render', { workflowId }), /PLAN_APPROVAL_REQUIRED/);
  await approve(store, candidate);
  const shots = await invoke(store, 'render', { workflowId });
  assert.equal(shots.status, 'needs_images');
  assert.ok(shots.jobs.every((job) => job.referenceImages.length === 2 && job.referenceImages.every((ref) => ref.approval.id === candidate.approvalId)));
  for (const ref of shots.jobs[0].referenceImages) assert.deepEqual(await readFile(ref.path), pixel);
});

test('reference jobs reject stale hashes and retain partial results across calls', async () => {
  const { store, workflowId } = await planned();
  const request = await invoke(store, 'render', { workflowId });
  const path = join(store.rootDir, 'refs.png'); await writeFile(path, pixel);
  const job = request.jobs[0];
  await assert.rejects(invoke(store, 'render', { workflowId, references: [{ referenceId: job.referenceId, inputHash: 'stale', path }] }), /STALE_REFERENCE_JOB/);
  const partial = await invoke(store, 'render', { workflowId, references: [{ referenceId: job.referenceId, inputHash: job.inputHash, path }] });
  assert.equal(partial.status, 'needs_reference_images');
  assert.equal(partial.jobs.length, 1);
  assert.equal((await invoke(store, 'render', { workflowId })).jobs.length, 1);
});

test('shot provenance binds the exact approved references; missing and stale generation hashes fail', async () => {
  const { store, workflowId } = await planned();
  const jobs = await references(store, workflowId);
  const path = join(store.rootDir, 'shots.png'); await writeFile(path, pixel);
  for (const inputHash of [undefined, 'stale']) await assert.rejects(invoke(store, 'render', { workflowId, assets: [{ shotId: 'shot1', inputHash, path }] }), /STALE_IMAGE_JOB/);
  const look = await fillShots(store, workflowId, jobs);
  assert.equal(look.approval.kind, 'look');
  const w = await new WebtoonStore(store).load(workflowId);
  assert.equal(w.images.shot1.inputHash, jobs.jobs[0].inputHash);
  assert.equal(w.images.shot1.references[0].hash, jobs.jobs[0].referenceImages[0].hash);
  assert.equal(w.images.shot1.execution.observedModel, null);
  assert.equal(w.images.shot1.execution.targetModel, 'gpt-image-2');
});

test('changed visual reference invalidates only dependent shots and rejects their late old results', async () => {
  const p = provider({ response: (request, data) => {
    if (request.step !== 'webtoon-plan') return undefined;
    const result = plan(data.source); result.sequences[0].shots[1].visualState = '붉은 외투'; return result;
  } });
  const { store, workflowId } = await planned(p);
  const jobs = await references(store, workflowId);
  await approve(store, await fillShots(store, workflowId, jobs));
  const repo = new WebtoonStore(store); const before = await repo.load(workflowId);
  const spec = before.referenceSpecs.find((item) => item.kind === 'character' && item.usedBy.includes('shot1'));
  const changed = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const path = join(store.rootDir, 'ref-v2.png'); await writeFile(path, changed);
  const review = await invoke(store, 'render', { workflowId, quality: 'references', references: [{ referenceId: spec.id, inputHash: spec.inputHash, path }] });
  await approve(store, review);
  const after = await repo.load(workflowId);
  assert.equal(after.images.shot1, undefined);
  assert.equal(after.images.shot2.hash, before.images.shot2.hash);
  assert.equal(after.lookAccepted, null);
  await assert.rejects(invoke(store, 'render', { workflowId, assets: [{ shotId: 'shot1', inputHash: jobs.jobs[0].inputHash, path }] }), /STALE_IMAGE_JOB/);
});

test('selected-shot edit jobs preserve an immutable edit target and bind requested changes', async () => {
  const { store, workflowId } = await planned();
  const jobs = await references(store, workflowId);
  await approve(store, await fillShots(store, workflowId, jobs));
  const changed = await invoke(store, 'render', { workflowId, regenerateShotIds: ['shot1'], feedback: '시선을 문손잡이로 옮긴다.' });
  assert.equal(changed.status, 'needs_images');
  assert.equal(changed.jobs.length, 1);
  assert.equal(changed.jobs[0].kind, 'edit');
  assert.notEqual(changed.jobs[0].inputHash, jobs.jobs[0].inputHash);
  assert.deepEqual(await readFile(changed.jobs[0].editTarget.path), pixel);
  const path = join(store.rootDir, 'shots.png');
  await assert.rejects(invoke(store, 'render', { workflowId, assets: [{ shotId: 'shot1', inputHash: jobs.jobs[0].inputHash, path }] }), /STALE_IMAGE_JOB/);
  const review = await fillShots(store, workflowId, changed);
  assert.equal(review.approval.kind, 'look');
});

test('approved visual designs are reused in the next workflow without regenerating references', async () => {
  const { store, workflowId } = await planned();
  const jobs = await references(store, workflowId);
  await approve(store, await fillShots(store, workflowId, jobs));
  await approve(store, await invoke(store, 'render', { workflowId, quality: 'final' }));
  const profile = await invoke(store, 'plan', { newWorkflow: true, episode: 2 });
  const nextPlan = await approve(store, profile);
  const next = await approve(store, nextPlan);
  const result = await invoke(store, 'render', { workflowId: next.workflowId });
  assert.equal(result.status, 'needs_images');
  assert.equal(result.jobs[0].referenceImages[0].approval.workflowId, workflowId);
  assert.notEqual(result.workflowId, workflowId);
});

test('a pending edit is not hidden by an already sufficient number of preview shots', async () => {
  const p = provider({ response: (request, data) => {
    if (request.step !== 'webtoon-plan') return undefined;
    const result = plan(data.source);
    result.sequences[0].shots.push({ ...result.sequences[0].shots[0], id: 'shot3' });
    return result;
  } });
  const { store, workflowId } = await planned(p);
  const jobs = await references(store, workflowId);
  await approve(store, await fillShots(store, workflowId, jobs));
  const changed = await invoke(store, 'render', { workflowId, regenerateShotIds: ['shot3'], feedback: '표정만 놀란 얼굴로 바꾼다.' });
  assert.equal(changed.status, 'needs_images');
  assert.deepEqual(changed.jobs.map(({ shotId }) => shotId), ['shot3']);
  assert.equal(changed.jobs[0].kind, 'edit');
});
