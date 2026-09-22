import assert from 'node:assert/strict';
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { readWebtoonWorkflow } from '../src/tools/webtoon.js';
import { runLegacyWebtoonTool as runWebtoonTool } from './fixtures/legacy-webtoon.js';
import { WebtoonStore } from '../src/store/webtoon-store.js';
import { coverage, digest, validateWebtoonPlan } from '../src/core/webtoon-contract.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';
import { answers, webtoonStore, workId, provider, pixel } from './fixtures/webtoon.js';
import { shotJobs } from '../src/core/webtoon-images.js';

const invoke = (store, name, args = {}, providers = provider(), run = null) => runWebtoonTool({ store, toolName: `lore_webtoon_${name}`, args: { workId, ...(name === 'plan' ? { imageModel: 'gpt-image-2' } : {}), ...args }, providers, run });
const approve = (store, result, providers = provider()) => invoke(store, 'decide', { workflowId: result.workflowId, approvalId: result.approvalId, action: 'approve' }, providers);

test('lettering-only revision preserves art, prose and text; forwards feedback and renews the look gate', async () => {
  const {store,accepted}=await ready();
  const path=join(store.rootDir,'pixel.png');await writeFile(path,pixel);
  const look=await invoke(store,'render',{workflowId:accepted.workflowId,assets:await imageAssets(store,path)});
  const repo=new WebtoonStore(store);const before=await repo.load();
  const prose=await readFile(store.chapterPath(1));
  const p=provider();
  const revised=await invoke(store,'decide',{workflowId:accepted.workflowId,approvalId:look.approvalId,action:'request_revision',revisionTarget:{kind:'lettering',shotIds:['shot2']},feedback:'풍선을 입 가까이 배치'},p);
  const after=await repo.load();
  assert.deepEqual(after.images,before.images);
  assert.deepEqual(after.plan,before.plan);
  assert.deepEqual(await readFile(store.chapterPath(1)),prose);
  assert.equal(revised.approval.kind,'look');assert.notEqual(revised.approvalId,look.approvalId);
  assert.equal(revised.lettering.technicalStatus,'passed');
  assert.equal(revised.lettering.approvalStatus,'pending');
  const input=JSON.parse(p.requests.find(r=>r.step==='webtoon-layout-analyze').messages.at(-1).content);
  assert.equal(input.feedback.text,'풍선을 입 가까이 배치');
  assert.deepEqual(input.shots.map(s=>s.shot.id),['shot2']);
  assert.ok(revised.artifacts['lettered-samples.html']);
  await assert.rejects(approve(store,look),/STALE_WEBTOON_APPROVAL/);
  // Tests deliberately alter the receipt-bound state to verify fail-closed acceptance.
  after.visualMaps.shot2.evidence='Changed after render';await repo.save(after);
  await assert.rejects(approve(store,revised),/LETTERING_RECEIPT_REQUIRED/);
});

test('unverified geometry blocks approval and scoped revision recovers without image jobs', async () => {
  const {store,accepted}=await ready();
  const path=join(store.rootDir,'pixel.png');await writeFile(path,pixel);
  const p=provider({response:(r,d)=>r.step==='webtoon-layout-analyze'?{maps:d.schema.maps}:undefined});
  const blocked=await invoke(store,'render',{workflowId:accepted.workflowId,assets:await imageAssets(store,path)},p);
  assert.equal(blocked.status,'layout_blocked');assert.equal(blocked.approvalId,undefined);
  assert.equal(blocked.lettering.technicalStatus,'blocked');assert.match(blocked.nextAction,/revisionTarget/);
  const recovered=await invoke(store,'render',{workflowId:accepted.workflowId,revisionTarget:{kind:'lettering',shotIds:['shot2']},feedback:'실제 컷을 확인하고 입과 보호 영역을 지정'});
  assert.equal(recovered.approval.kind,'look');assert.equal(recovered.lettering.technicalStatus,'passed');
});

test('layout model failures retry through render, never restart the adaptation plan', async () => {
  const {store,accepted}=await ready();
  const path=join(store.rootDir,'pixel.png');await writeFile(path,pixel);
  const p=provider({response:r=>r.step==='webtoon-layout-analyze'?'invalid-json':undefined});
  assert.equal((await invoke(store,'render',{workflowId:accepted.workflowId,assets:await imageAssets(store,path)},p)).status,'model_failed');
  assert.equal((await new WebtoonStore(store).load()).stage,'model_failed');
  await assert.rejects(invoke(store,'plan',{retry:true}),/LAYOUT_RETRY_REQUIRES_RENDER/);
  const good=provider();const result=await invoke(store,'render',{workflowId:accepted.workflowId,retry:true},good);
  assert.equal(result.approval.kind,'look');
  assert.ok(!good.requests.some(r=>r.step==='webtoon-plan'));
});
async function imageAssets(store, path, ids = ['shot1', 'shot2']) {
  const jobs = shotJobs(await new WebtoonStore(store).load(), { all: true });
  return ids.map((shotId) => ({ shotId, path, inputHash: jobs.find((job) => job.shotId === shotId).inputHash }));
}
async function ready(providers = provider()) {
  const store = await webtoonStore();
  const profile = await invoke(store, 'plan', { responses: answers }, providers);
  assert.equal(profile.approval.kind, 'profile');
  const planned = await approve(store, profile, providers);
  assert.equal(planned.approval.kind, 'plan');
  let accepted = await approve(store, planned, providers);
  assert.equal(accepted.status, 'plan_accepted');
  const jobs = await invoke(store, 'render', { workflowId: accepted.workflowId });
  const path = join(store.rootDir, 'reference.png'); await writeFile(path, pixel);
  const refs = await invoke(store, 'render', { workflowId: accepted.workflowId, references: jobs.jobs.map(({ referenceId, inputHash }) => ({ referenceId, inputHash, path })) });
  accepted = await approve(store, refs);
  return { store, accepted, providers };
}

test('first entry asks the dependency frontier and partial answers survive restart without writing prose state', async () => {
  const store = await webtoonStore();
  const before = await readFile(store.chapterPath(1));
  const first = await invoke(store, 'plan');
  assert.equal(first.status, 'needs_interview');
  assert.deepEqual(first.questions.map(({ id }) => id), ['W04', 'W15', 'W16']);
  const next = await invoke(store, 'plan', { workflowId: first.workflowId, responses: { W01: '처음 읽는 사람' } });
  assert.equal(next.decisions.W01.value, '처음 읽는 사람');
  assert.ok(!next.questions.some(({ id }) => id === 'W01'));
  assert.ok(next.questions.some(({ id }) => id === 'W15'));
  assert.equal((await store.loadWorkflow(workId)), null);
  assert.deepEqual(await readFile(store.chapterPath(1)), before);
});

test('core and presentation areas are required; active conditional questions cannot be silently skipped', async () => {
  const store = await webtoonStore();
  const partial = { ...answers }; delete partial.W05;
  let result = await invoke(store, 'plan', { responses: partial });
  assert.equal(result.status, 'needs_interview');
  assert.ok(result.coverage.missing.includes('W05'));
  result = await invoke(store, 'plan', { responses: { W05: '개그에서도 치비 금지' } });
  assert.equal(result.status, 'needs_interview');
  assert.ok(result.coverage.missing.includes('E06'));
  result = await invoke(store, 'plan', { responses: { E06: '몸 비례는 유지하고 표정만 과장' } });
  assert.equal(result.approval.kind, 'profile');
});

test('profile changes supersede old decisions and reopen only dependent questions', async () => {
  const store = await webtoonStore();
  const first = await invoke(store, 'plan', { responses: answers });
  const next = await invoke(store, 'plan', { responses: { W04: '색은 연하게' } });
  assert.equal(next.status, 'needs_interview');
  assert.equal(next.decisions.W04.value, '색은 연하게');
  assert.equal(next.decisions.W05.status, 'unresolved');
  assert.equal(next.decisions.W02.status, 'answered');
  await assert.rejects(approve(store, first), /STALE_WEBTOON_APPROVAL/);
  const history = await readWebtoonWorkflow({ store, workId, history: true });
  assert.ok(history.decisionHistory.some(({ id, status }) => id === 'W04' && status === 'superseded'));
});

test('actual planner receives full user intent, raw source and as-of state, never latest mutable state', async () => {
  const p = provider(); const store = await webtoonStore();
  const long = '사용자 의도 '.repeat(300) + '끝에 있는 중요한 금지';
  const first = await invoke(store, 'plan', { responses: { ...answers, W09: long } }, p);
  await approve(store, first, p);
  const request = p.requests.find(({ step }) => step === 'webtoon-plan');
  const data = JSON.parse(request.messages.at(-1).content);
  assert.equal(data.contract.content.decisions.W09.value, long);
  assert.match(data.source.chapters[0].raw, /윤이 닫힌 문/);
  assert.deepEqual(data.source.chapters[0].afterState.scars, []);
  assert.equal(data.source.foundation.characters[0].mutable, undefined);
});

test('plan approval stores editable script separately and cannot consume the same approval twice', async () => {
  const { store, accepted } = await ready();
  const script = await readFile(join(store.rootDir, 'webtoon', 'episodes', `1-${accepted.workflowId}`, 'script.md'), 'utf8');
  assert.match(script, /안에 있나요/);
  await assert.rejects(access(store.sidecar('publication', 'HEAD')));
  await assert.rejects(invoke(store, 'decide', { workflowId: accepted.workflowId, approvalId: 'old', action: 'approve' }), /STALE_WEBTOON_APPROVAL/);
});

test('auto mode records delegated choices and failed critic degrades to a review gate', async () => {
  const store = await webtoonStore();
  const p = provider({ response: (request) => request.step === 'webtoon-plan-review' ? '{}' : undefined });
  const result = await invoke(store, 'plan', { mode: 'auto', responses: { W04: '선명한 컬러', W15: 'standard', W16: 'scroll' } }, p);
  assert.equal(result.status, 'awaiting_approval');
  assert.equal(result.approval.kind, 'plan');
  assert.equal(result.quality.code, 'CRITIC_INCOMPLETE');
  assert.ok(Object.values(result.decisions).filter(d => !['W04', 'W15', 'W16'].includes(d.id)).every(({ status }) => status === 'delegated'));
  assert.ok(['W04', 'W15', 'W16'].every(id => result.decisions[id].status === 'answered'));
  assert.equal((await approve(store, result)).status, 'plan_accepted');
});

test('soft critic findings are retained without an automatic rewrite', async () => {
  const p = provider({ response: (request, data) => request.step === 'webtoon-plan-review' ? { ...data.schema, findings: [{ code: 'PACE', message: '호흡이 길다' }] } : undefined });
  const store = await webtoonStore();
  const result = await invoke(store, 'plan', { mode: 'auto', responses: { W04: '선명한 컬러', W15: 'standard', W16: 'scroll' } }, p);
  assert.equal(result.status, 'plan_accepted');
  assert.equal(result.quality.findings[0].advisoryOnly, true);
  assert.equal(p.requests.filter(({ step }) => step === 'webtoon-plan').length, 1);
});

test('host model requests remain exact across an empty resume and coexist with the prose pointer', async () => {
  const store = await webtoonStore();
  await store.saveWorkflow(workId, { workflowId: 'prose-active', stage: 'awaiting_model' });
  const first = await invoke(store, 'plan', { responses: answers });
  const pending = await approve(store, first, createHostRelay());
  assert.equal(pending.status, 'needs_model');
  const run = await loadRun(store.rootDir, pending.runId);
  const empty = await invoke(store, 'plan', run.args, createHostRelay(), run);
  assert.equal(empty.runId, pending.runId);
  assert.equal(empty.requests[0].id, pending.requests[0].id);
  const data = JSON.parse(pending.requests[0].user);
  assert.equal(pending.requests[0].step, 'webtoon-editorial');
  const generated = JSON.stringify((await import('./fixtures/webtoon.js')).editorial(data.source));
  const planning = await invoke(store, 'plan', run.args, createHostRelay({ [pending.requests[0].id]: generated }), run);
  assert.equal(planning.requests[0].step, 'webtoon-plan');
  const planningRun = await loadRun(store.rootDir, planning.runId);
  const planAnswer = JSON.stringify((await import('./fixtures/webtoon.js')).plan(data.source));
  const reviewing = await invoke(store, 'plan', planningRun.args, createHostRelay({ [planning.requests[0].id]: planAnswer }), planningRun);
  assert.equal(reviewing.status, 'needs_model');
  assert.notEqual(reviewing.runId, pending.runId);
  assert.equal(reviewing.requests[0].step, 'webtoon-plan-review');
  assert.equal((await store.loadWorkflow(workId)).workflowId, 'prose-active');
});

test('a new user decision rejects a late model response from the superseded revision', async () => {
  const store = await webtoonStore();
  const first = await invoke(store, 'plan', { responses: answers });
  const pending = await approve(store, first, createHostRelay());
  const oldRun = await loadRun(store.rootDir, pending.runId);
  await invoke(store, 'plan', { responses: { W04: '새 화풍' } });
  await assert.rejects(invoke(store, 'plan', oldRun.args, createHostRelay(), oldRun), /STALE_WEBTOON_RUN/);
});

test('hand edits block regeneration and remain available for explicit reinspection', async () => {
  const { store } = await ready();
  const file = join(store.rootDir, 'webtoon', 'profile.md');
  await writeFile(file, '# 사람이 변경한 방향\n');
  await assert.rejects(invoke(store, 'plan'), /WORKING_TREE_DRIFT/);
  const result = await invoke(store, 'plan', { adoptEdits: true, feedback: '이 변경을 검토해' });
  assert.ok(['needs_interview', 'awaiting_approval'].includes(result.status));
  assert.match(await readFile(file, 'utf8'), /사람이 변경/);
});

test('invalid plan refs and layout are hard errors without an approval', async () => {
  const p = provider({ response: (request, data) => {
    if (request.step !== 'webtoon-plan') return undefined;
    return { title: 't', promise: 'p', closingQuestion: 'q', adaptation: [], visualBible: { characters: [], environments: [] }, sequences: [] };
  } });
  const store = await webtoonStore();
  const first = await invoke(store, 'plan', { responses: answers });
  const result = await approve(store, first, p);
  assert.equal(result.status, 'plan_invalid');
  assert.ok(result.quality.hard.some(({ code }) => code === 'UNMAPPED_SOURCE'));
  assert.equal(result.approvalId, undefined);
});

test('render requests real assets, then requires look approval and exact final bytes', async () => {
  const { store, accepted } = await ready();
  const args = { workflowId: accepted.workflowId };
  const jobs = await invoke(store, 'render', args);
  assert.equal(jobs.status, 'needs_images');
  assert.equal(jobs.jobs.length, 2);
  await assert.rejects(invoke(store, 'render', { ...args, quality: 'final' }), /LOOK_APPROVAL_REQUIRED/);
  const path = join(store.rootDir, 'pixel.png'); await writeFile(path, pixel);
  const assets = jobs.jobs.map(({ shotId, inputHash }) => ({ shotId, inputHash, path }));
  const look = await invoke(store, 'render', { ...args, assets });
  assert.equal(look.approval.kind, 'look');
  const looked = await approve(store, look);
  assert.equal(looked.status, 'look_accepted');
  const final = await invoke(store, 'render', { ...args, quality: 'final' });
  assert.equal(final.approval.kind, 'final');
  assert.notEqual(final.approval.hash, look.approval.hash);
  const before = await readFile(final.artifacts['episode.svg'].path, 'utf8');
  assert.match(before, /안에 있나요/);
  assert.match(before, /data:image\/png;base64/);
  await writeFile(final.artifacts['episode.svg'].path, before + '\n');
  await assert.rejects(approve(store, final), /RENDER_BYTES_CHANGED/);
  await writeFile(final.artifacts['episode.svg'].path, before);
  const completed = await approve(store, final);
  assert.equal(completed.status, 'completed');
  await access(join(store.rootDir, 'webtoon', 'episodes', `1-${completed.workflowId}`, 'episode.svg'));
});

test('a text-only critic cannot mark an image review completed', async () => {
  const { store, accepted } = await ready();
  const path = join(store.rootDir, 'pixel.png'); await writeFile(path, pixel);
  const p = provider({ response: (request, data) => request.step === 'webtoon-render-review' ? { ...data.schema, inspectedImages: false, findings: [] } : undefined });
  const look = await invoke(store, 'render', { workflowId: accepted.workflowId, assets: await imageAssets(store, path) }, p);
  assert.equal(look.quality.status, 'failed');
  assert.equal(look.quality.code, 'CRITIC_INCOMPLETE');
});

test('unsafe source and output paths fail without changing a ready plan', async () => {
  const { store, accepted } = await ready();
  const other = await webtoonStore();
  const outside = join(other.rootDir, 'outside.png');
  await writeFile(outside, pixel);
  await assert.rejects(invoke(store, 'render', { workflowId: accepted.workflowId, assets: await imageAssets(store, outside, ['shot1']) }), /ASSET_OUTSIDE_PROJECT/);
  await assert.rejects(invoke(store, 'plan', { workflowId: '../bad' }), /INVALID_WEBTOON_WORKFLOW_ID/);
  const workflow = await new WebtoonStore(store).load(accepted.workflowId);
  assert.equal(workflow.stage, 'plan_accepted');
});

test('coverage is independent of any model openQuestions array', async () => {
  const store = await webtoonStore();
  const p = provider({ response: (request) => request.step === 'webtoon-interview' ? { answers: [], openQuestions: [] } : undefined });
  const result = await invoke(store, 'plan', { direction: '웹툰을 만들자' }, p);
  const workflow = await new WebtoonStore(store).load(result.workflowId);
  assert.equal(coverage(workflow).complete, false);
  assert.equal(result.questions.length, 3);
});

test('malformed or ungrounded interview replies remain retryable with the original input', async () => {
  const store = await webtoonStore();
  const p = provider({ response: (request) => request.step === 'webtoon-interview' ? { answers: [{ id: 'W05', value: '아무 취향', quote: '없는 말' }] } : undefined });
  await assert.rejects(invoke(store, 'plan', { direction: '표정은 크게' }, p), /UNGROUNDED/);
  const failed = await readWebtoonWorkflow({ store, workId });
  assert.equal(failed.status, 'model_failed');
  const retried = await invoke(store, 'plan', { retry: true });
  assert.equal(retried.status, 'needs_interview');
  assert.equal(retried.decisions.W05.value, '표정은 크게');
});

test('a text-only plan revision reuses unchanged image bytes but requires new final approval', async () => {
  const { store, accepted } = await ready();
  const path = join(store.rootDir, 'pixel.png'); await writeFile(path, pixel);
  const look = await invoke(store, 'render', { workflowId: accepted.workflowId, assets: await imageAssets(store, path) });
  await approve(store, look);
  // Reopen the plan with the same profile values, then revise its text.
  const profile = await invoke(store, 'plan', { responses: { W07: answers.W07 } });
  const p = provider({ response: (request, data) => {
    if (request.step !== 'webtoon-plan') return undefined;
    const changed = JSON.parse(JSON.stringify(accepted.plan));
    changed.sequences[0].shots[1].texts[0].text = '문을 열어 줄래요?';
    return changed;
  } });
  const nextPlan = await approve(store, profile, p);
  await approve(store, nextPlan);
  const workflow = await new WebtoonStore(store).load(accepted.workflowId);
  assert.equal(Object.keys(workflow.images).length, 2);
  assert.equal(workflow.images.shot1.hash, digest(pixel));
  const final = await invoke(store, 'render', { workflowId: accepted.workflowId, quality: 'final' });
  assert.equal(final.approval.kind, 'final');
  assert.match(await readFile(final.artifacts['episode.svg'].path, 'utf8'), /문을 열어 줄래요/);
});

test('partially projected approval recovers without overwriting unrelated human edits', async () => {
  const store = await webtoonStore();
  const profile = await invoke(store, 'plan', { responses: answers });
  const pending = await approve(store, profile);
  const repo = new WebtoonStore(store); const workflow = await repo.load(pending.workflowId);
  const relativePath = `episodes/1-${workflow.workflowId}/plan.json`;
  const text = JSON.stringify(workflow.plan, null, 2);
  workflow.applyingApproval = { id: workflow.approval.id, files: { [relativePath]: digest(text) } };
  await repo.save(workflow);
  await mkdir(join(store.rootDir, 'webtoon', `episodes/1-${workflow.workflowId}`), { recursive: true });
  await writeFile(join(store.rootDir, 'webtoon', relativePath), text);
  await assert.rejects(invoke(store, 'plan', { workflowId: workflow.workflowId, adoptEdits: true, feedback: '수정 반입' }), /APPROVAL_RECOVERY_REQUIRED/);
  assert.equal((await repo.load(workflow.workflowId)).approval.id, pending.approval.id);
  assert.equal((await approve(store, pending)).status, 'plan_accepted');
});

test('null model rows are reported as invalid plans, and explicit newlines count for lettering overflow', async () => {
  const { store, accepted } = await ready();
  const workflow = await new WebtoonStore(store).load(accepted.workflowId);
  const broken = { ...accepted.plan, adaptation: {}, visualBible: { characters: [null], environments: [null] }, sequences: [null] };
  assert.ok(validateWebtoonPlan(broken, workflow.source, workflow.scope).length);
  const overflow = structuredClone(accepted.plan);
  overflow.sequences[0].shots[1].texts[0].text = '한\n'.repeat(100);
  assert.ok(validateWebtoonPlan(overflow, workflow.source, workflow.scope).some(({ code }) => code === 'TEXT_OVERFLOW'));
});

test('truncated images and unsupported image count do not mutate accepted assets', async () => {
  const { store, accepted } = await ready();
  const path = join(store.rootDir, 'bad.png'); await writeFile(path, pixel.subarray(0, 25));
  await assert.rejects(invoke(store, 'render', { workflowId: accepted.workflowId, assets: await imageAssets(store, path, ['shot1']) }), /TRUNCATED_PNG/);
  assert.deepEqual((await new WebtoonStore(store).load()).images, {});
});

test('source scope is pinned and later prose edits do not alter the stored source packet', async () => {
  const { store, accepted } = await ready();
  const repo = new WebtoonStore(store); const before = await repo.load();
  await store.saveArtifact({ workId, chapterNumber: 2, prose: '새로운 소설 화' });
  await assert.rejects(invoke(store, 'plan', { sourceChapters: [1, 2] }), /SCOPE_ALREADY_PINNED/);
  assert.equal((await repo.load()).source.hash, before.source.hash);
  assert.equal((await invoke(store, 'plan')).status, 'plan_accepted');
});
