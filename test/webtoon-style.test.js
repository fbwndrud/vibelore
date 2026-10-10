import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sceneSetup, scenePlan, scenePreflight } from './fixtures/webtoon-scene.js';
import { workId, pixel } from './fixtures/webtoon.js';
import { runWebtoonStyleTool } from '../src/tools/webtoon-style.js';
import { runWebtoonSceneTool } from '../src/tools/webtoon-scene.js';
import { readWebtoonWorkflow } from '../src/tools/webtoon.js';
import { WebtoonStyleStore, STYLE_REFERENCE_ID } from '../src/store/webtoon-style-store.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';

const call = (store, args) => runWebtoonStyleTool({ store, args: { workId, ...args } });
async function candidate(store, direction = 'Monochrome ink with expressive adult faces.') {
  const imagePath = join(store.rootDir, 'sample.png'); await writeFile(imagePath, pixel);
  return call(store, { action: 'propose', brief: '옛날 만화처럼 거칠게, 얼굴은 어른처럼.', direction, imagePath });
}
async function adopt(store, direction) {
  const c = await candidate(store, direction);
  return (await call(store, { action: 'approve', proposalId: c.proposalId, feedback: '이 그림으로 해 줘.' })).style;
}
// Fixtures prove input, persistence and review contracts, not visual style quality.
function provider({ verdict = 'matches', inspectedReference = true, calls = [] } = {}) {
  return { async complete(request) {
    calls.push(request); const d = JSON.parse(request.messages.at(-1).content); let answer;
    if (request.step === 'webtoon-scene-plan') answer = scenePlan(d.source);
    else if (request.step === 'webtoon-scene-preflight') {
      answer = scenePreflight(d); if (d.styleBasis) answer.renderBrief.style = d.styleBasis.profile.style;
    } else answer = { ...d.schema, observedPanelCount: d.requestedPanelCount, inspectedImages: true,
      spatialCoherence: true, readingOrder: true, evidence: 'Synthetic review fixture.',
      textObservations: d.plan.texts.map(t => ({ id: t.id, observedText: t.text, readable: true, speakerCorrect: true, evidence: 'Fixture caption.' })),
      ...(d.styleBasis ? { styleReview: { inspectedReference, verdict, evidence: 'Fixture visible treatment comparison.' } } : {}) };
    return { text: JSON.stringify(answer) };
  } };
}
const sceneAsset = (job, path) => ({ path, inputHash: job.inputHash,
  provenance: { kind: 'openai-api', requestedModel: job.apiRequest.model, selectionId: job.apiRequest.selectionId } });

test('a user-provided sample is preserved, requires explicit adoption, and cannot change prose or scene state', async () => {
  const { store, repo } = await sceneSetup(); const before = await readFile(store.chapterPath(1));
  const c = await candidate(store); assert.equal(c.status, 'awaiting_style_approval'); assert.deepEqual(c.jobs, []);
  assert.equal((await call(store, { action: 'status' })).style, null);
  await assert.rejects(call(store, { action: 'approve', proposalId: c.proposalId }), /STYLE_USER_APPROVAL_REQUIRED/);
  await assert.rejects(call(store, { action: 'approve', proposalId: c.proposalId, feedback: '좋아', applyToWorkflows: ['missing'] }), /INVALID_STYLE_APPLY_SCOPE/);
  await unlink(join(store.rootDir, 'sample.png'));
  const approved = await call(store, { action: 'approve', proposalId: c.proposalId, feedback: '이 그림으로 해 줘.' });
  assert.equal(approved.style.brief, '옛날 만화처럼 거칠게, 얼굴은 어른처럼.');
  assert.equal(approved.style.adoption.feedback, '이 그림으로 해 줘.');
  assert.equal(approved.style.image.provenance.kind, 'user-provided');
  assert.deepEqual(await readFile(approved.style.image.path), pixel);
  assert.equal(await repo.load(), null); assert.deepEqual(await readFile(store.chapterPath(1)), before);
  assert.equal((await call(store, { action: 'approve', proposalId: c.proposalId, feedback: '좋아' })).alreadyAdopted, true);
});

test('preview generation shares explicit runtime choice, survives a restart and validates the exact image receipt', async () => {
  const { store, repo, args: sceneArgs } = await sceneSetup(); await unlink(repo.path('image-selection.json'));
  const args = { action: 'propose', brief: '따뜻하지만 유치하지 않게.', direction: 'Warm illustrated comic with natural adult proportions.' };
  assert.equal((await call(store, args)).status, 'needs_image_runtime');
  const runtime = { host: 'codex', options: [{ id: 'builtin', execution: 'host-built-in', provider: 'codex', tool: 'image_gen', modelSelectable: false, models: [] }] };
  const choice = await call(store, { ...args, imageRuntime: runtime }); assert.equal(choice.status, 'needs_image_choice');
  const c = await call(store, { ...args, confirmImageChoice: choice.imageChoice.id, feedback: '내장 도구로 해 줘.' });
  assert.equal(c.status, 'needs_style_image'); assert.equal(c.jobs[0].hostRequest.tool, 'image_gen');
  assert.equal(c.jobs[0].hostRequest.model, null); assert.equal(await repo.load(), null);
  const resumed = await call(store, { action: 'status', proposalId: c.proposalId });
  assert.equal(resumed.jobs[0].inputHash, c.jobs[0].inputHash);
  const asset = { path: join(store.rootDir, 'ref.png'), inputHash: c.jobs[0].inputHash,
    provenance: { kind: 'host-built-in', provider: 'codex', tool: 'image_gen', selectionId: choice.imageChoice.id } };
  await assert.rejects(call(store, { action: 'import', proposalId: c.proposalId, asset: { ...asset, inputHash: 'old' } }), /STALE_STYLE_IMAGE/);
  await assert.rejects(call(store, { action: 'import', proposalId: c.proposalId, asset: { ...asset, provenance: {} } }), /IMAGE_EXECUTION_PROVENANCE_REQUIRED/);
  const imported = await call(store, { action: 'import', proposalId: c.proposalId, asset });
  assert.equal(imported.status, 'awaiting_style_approval'); assert.equal((await call(store, { action: 'status' })).style, null);
  const adopted = await call(store, { action: 'approve', proposalId: c.proposalId, feedback: '이 화풍으로 이어가자.' });
  const scene = await runWebtoonSceneTool({ store, args: { ...sceneArgs, direction: undefined }, providers: provider() });
  assert.equal(scene.jobs[0].hostRequest.selectionId, choice.imageChoice.id);
  assert.equal(scene.style.revisionId, adopted.style.revisionId);
});

test('concurrent candidates cannot silently replace a newly adopted style; old revisions remain accessible', async () => {
  const { store } = await sceneSetup(); const first = await candidate(store), other = await candidate(store, 'Warm watercolor.');
  const style1 = (await call(store, { action: 'approve', proposalId: first.proposalId, feedback: '첫 그림 좋아' })).style;
  await assert.rejects(call(store, { action: 'approve', proposalId: other.proposalId, feedback: '다른 그림 좋아' }), /STALE_STYLE_PROPOSAL/);
  await assert.rejects(call(store, { action: 'propose', brief: '다시', direction: 'Ink.', imagePath: first.image.path, expectedStyleRevision: null }), /STALE_STYLE_PROPOSAL/);
  const style2 = await adopt(store, 'Warm watercolor.'); assert.equal(style2.parentRevisionId, style1.revisionId);
  assert.equal((await call(store, { action: 'status', styleRevisionId: style1.revisionId })).style.revisionId, style1.revisionId);
});

test('adopted image and summary reach planning, preflight, generation and visual review; taste is advisory', async () => {
  const { store, args } = await sceneSetup(); const style = await adopt(store), calls = [], p = provider({ verdict: 'differs', calls });
  const r = await runWebtoonSceneTool({ store, args: { ...args, direction: undefined }, providers: p });
  assert.equal(r.style.revisionId, style.revisionId);
  assert.equal(r.jobs[0].referenceImages.find(x => x.id === STYLE_REFERENCE_ID).hash, style.image.hash);
  assert.match(r.jobs[0].prompt, /Monochrome ink/); assert.doesNotMatch(r.jobs[0].prompt, /finished color comic/);
  for (const q of calls) assert.ok(q.images.some(x => x.path === style.image.path), q.step);
  const done = await runWebtoonSceneTool({ store, args: { workId, asset: sceneAsset(r.jobs[0], args.references[0].path) }, providers: p });
  assert.equal(done.status, 'completed'); assert.equal(done.autoRevision.used, 0);
  assert.ok(done.visualReview.findings.some(f => f.category === 'style' && f.severity === 'advisory'));
  assert.equal(calls.filter(q => q.step === 'webtoon-scene-plan').length, 1);
  assert.ok(calls.at(-1).images.some(x => x.path === style.image.path));
  assert.match(await readFile(done.artifacts['scene.html'].path, 'utf8'), /Fixture visible treatment comparison/);
  const proof = await runWebtoonSceneTool({ store, args: { workId, action: 'verify' } });
  assert.equal(proof.record.styleRevisionId, style.revisionId); assert.ok(proof.checks.some(c => c.check === 'adopted-style'));
});

test('a style change keeps active scenes pinned, reports its impact and only updates them on explicit revise', async () => {
  const { store, repo, args } = await sceneSetup(); const style1 = await adopt(store);
  const r = await runWebtoonSceneTool({ store, args, providers: provider() });
  const c = await candidate(store, 'Soft watercolor with natural adult faces.');
  const change = await call(store, { action: 'approve', proposalId: c.proposalId, feedback: '이제 이 느낌으로', applyToWorkflows: [r.workflowId] });
  const style2 = change.style;
  assert.equal(change.change.existingScenes[0].effect, 'revision-requested');
  assert.equal((await repo.load()).styleSnapshot.revisionId, style1.revisionId);
  const status = await readWebtoonWorkflow({ store, workId, workflowId: r.workflowId });
  assert.equal(status.styleChange.activeRevisionId, style2.revisionId); assert.equal(status.style.revisionId, style1.revisionId);
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId, styleRevisionId: style2.revisionId }, providers: provider() }), /SCENE_STYLE_PINNED/);
  const fixed = await runWebtoonSceneTool({ store, args: { workId, action: 'revise', styleRevisionId: style2.revisionId, feedback: '선택한 새 화풍으로 바꿔 줘.' }, providers: provider() });
  assert.equal(fixed.style.revisionId, style2.revisionId); assert.notEqual(fixed.jobs[0].inputHash, r.jobs[0].inputHash);
  assert.equal(fixed.jobs[0].referenceImages.filter(x => x.id === STYLE_REFERENCE_ID).length, 1);
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId, asset: sceneAsset(r.jobs[0], args.references[0].path) }, providers: provider() }), /SCENE_PREFLIGHT_REQUIRED/);
});

test('new scenes use the current style while completed scenes and their production records keep the old one', async () => {
  const { store, args } = await sceneSetup(); const style1 = await adopt(store);
  const r = await runWebtoonSceneTool({ store, args, providers: provider() });
  const done = await runWebtoonSceneTool({ store, args: { workId, asset: sceneAsset(r.jobs[0], args.references[0].path) }, providers: provider() });
  const style2 = await adopt(store, 'Warm watercolor.');
  assert.equal((await runWebtoonSceneTool({ store, args: { workId, workflowId: done.workflowId, action: 'verify' } })).record.styleRevisionId, style1.revisionId);
  const next = await runWebtoonSceneTool({ store, args, providers: provider() });
  assert.equal(next.style.revisionId, style2.revisionId);
});

test('host relay resumes exact requests with the pinned style and cannot omit the required sample observation', async () => {
  const { store, args } = await sceneSetup(); await adopt(store);
  let r = await runWebtoonSceneTool({ store, args, providers: createHostRelay() });
  let run = await loadRun(store.rootDir, r.runId), q = r.requests[0], d = JSON.parse(q.user);
  assert.ok(q.images.length); assert.ok(d.styleBasis);
  r = await runWebtoonSceneTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(scenePlan(d.source)) }) });
  run = await loadRun(store.rootDir, r.runId); q = r.requests[0]; d = JSON.parse(q.user);
  const pf = scenePreflight(d); pf.renderBrief.style = d.styleBasis.profile.style;
  r = await runWebtoonSceneTool({ store, args: run.args, run, providers: createHostRelay({ [q.id]: JSON.stringify(pf) }) });
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId, asset: sceneAsset(r.jobs[0], args.references[0].path) },
    providers: provider({ inspectedReference: false }) }), /INCOMPLETE_SCENE_STYLE_REVIEW/);
});

test('tampering with the preserved sample blocks generation and old receipts remain unusable', async () => {
  const { store, repo, args } = await sceneSetup(); const style = await adopt(store);
  await runWebtoonSceneTool({ store, args, providers: provider() });
  await writeFile(style.image.path, Buffer.from('changed'));
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId }, providers: provider() }), /STYLE_IMAGE_CHANGED/);
  await assert.rejects(new WebtoonStyleStore(repo, workId).adopted(), /STYLE_IMAGE_CHANGED/);
});

const delegate = (scope = 'production', more = {}) => ({ scope, userAnswer: '알아서 해줘.', ...more });
const builtinRuntime = { host: 'codex', options: [{ id: 'builtin', execution: 'host-built-in', provider: 'codex', tool: 'image_gen', modelSelectable: false, models: [] }] };
const apiRuntime = { host: 'codex', options: [{ id: 'api', execution: 'api', provider: 'openai', modelSelectable: true, models: ['gpt-image-2.5-sunburst'], credential: 'OPENAI_API_KEY' }] };
const choose = c => ({ inspectedImage: true, imageHash: c.image.hash, rationale: 'The sample fits the source mood and user preference.' });
const proposal = (store, imagePath, delegation) => call(store, { action: 'propose', brief: '원작에 어울리게 알아서 해줘.', direction: 'Warm expressive comic.', imagePath, delegation });

test('delegation records the host choice separately from user adoption and requires the actual sample', async () => {
  const { store, args } = await sceneSetup();
  await assert.rejects(proposal(store, args.references[0].path, { scope: 'style', userAnswer: '' }), /INVALID_WEBTOON_DELEGATION/);
  const c = await proposal(store, args.references[0].path, delegate('style'));
  assert.equal(c.status, 'needs_style_decision');
  for (const choice of [undefined, { ...choose(c), inspectedImage: false }, { ...choose(c), imageHash: 'old' }]) {
    await assert.rejects(call(store, { action: 'approve', proposalId: c.proposalId, choice }), /STYLE_DELEGATED_CHOICE_REQUIRED/);
  }
  const adopted = await call(store, { action: 'approve', proposalId: c.proposalId, choice: choose(c) });
  assert.equal(adopted.style.adoption.authority, 'delegated');
  assert.equal(adopted.style.adoption.feedback, '알아서 해줘.');
  assert.equal(adopted.style.adoption.choice.imageHash, c.image.hash);
  assert.equal(adopted.style.adoption.delegation.scope, 'style');
});

test('preview-only waits for the user, and changing delegation reuses the same image with an audit trail', async () => {
  const { store, args } = await sceneSetup();
  const c = await proposal(store, args.references[0].path, delegate('preview', { maxAutoRevisions: 0 }));
  assert.equal(c.status, 'awaiting_style_approval');
  await assert.rejects(call(store, { action: 'approve', proposalId: c.proposalId, choice: choose(c) }), /STYLE_USER_APPROVAL_REQUIRED/);
  let changed = await call(store, { action: 'set_mode', proposalId: c.proposalId, delegation: delegate('style', { userAnswer: '선택도 네가 해 줘.' }) });
  assert.equal(changed.status, 'needs_style_decision'); assert.equal(changed.image.hash, c.image.hash); assert.deepEqual(changed.jobs, []);
  changed = await call(store, { action: 'set_mode', proposalId: c.proposalId, delegation: null, feedback: '잠깐, 먼저 보여줘.' });
  assert.equal(changed.status, 'awaiting_style_approval'); assert.equal(changed.decisionHistory.length, 2);
  assert.equal(changed.maxAutoRevisions, 0);
  await assert.rejects(call(store, { action: 'approve', proposalId: c.proposalId, delegation: delegate(), choice: choose(c) }), /STYLE_USER_APPROVAL_REQUIRED/);
  const result = await call(store, { action: 'approve', proposalId: c.proposalId, feedback: '이 그림으로 해 줘.' });
  assert.equal(result.style.adoption.authority, 'user'); assert.equal(result.style.adoption.decisionHistory.length, 2);
  await assert.rejects(call(store, { action: 'set_mode', proposalId: c.proposalId, delegation: delegate() }), /STYLE_DECISION_CLOSED/);
});

test('delegated built-in selection skips routine confirmation, survives restart and resumes host selection', async () => {
  const { store, repo } = await sceneSetup(); await unlink(repo.path('image-selection.json'));
  const args = { action: 'propose', brief: '원작에 어울리게 알아서 해줘.', direction: 'Warm expressive comic.', delegation: delegate(), imageRuntime: builtinRuntime };
  const c = await call(store, args); assert.equal(c.status, 'needs_style_image');
  const saved = JSON.parse(await readFile(repo.path('image-selection.json')));
  assert.equal(saved.selection.authority, 'delegated'); assert.equal(saved.selection.userAnswer, '알아서 해줘.');
  const imported = await call(store, { action: 'import', proposalId: c.proposalId, asset: { path: join(store.rootDir, 'ref.png'), inputHash: c.jobs[0].inputHash,
    provenance: { kind: 'host-built-in', provider: 'codex', tool: 'image_gen', selectionId: saved.selection.id } } });
  assert.equal(imported.status, 'needs_style_decision');
  const status = await call(store, { action: 'status', proposalId: c.proposalId });
  assert.equal(status.candidate.delegation.scope, 'production'); assert.match(status.nextAction, /approve/);
  const adopted = await call(store, { action: 'approve', proposalId: c.proposalId, choice: choose(imported) });
  assert.equal(adopted.style.adoption.authority, 'delegated');
});

test('delegation reuses approved API costs but needs separate authority for a new API and obeys a newer no-cost constraint', async () => {
  const { store, repo } = await sceneSetup();
  const args = { action: 'propose', brief: '알아서', direction: 'Ink comic.', delegation: delegate() };
  assert.equal((await call(store, args)).jobs[0].apiRequest.model, 'gpt-image-2.5-sunburst');
  await unlink(repo.path('image-selection.json'));
  const blocked = await call(store, { ...args, imageRuntime: apiRuntime });
  assert.equal(blocked.status, 'needs_image_choice'); assert.equal(blocked.blockedBy, 'new-api-cost');
  const allowed = await call(store, { ...args, delegation: delegate('production', { apiPolicy: 'allow', userAnswer: 'API 비용도 허용하니 알아서 해줘.' }), imageRuntime: apiRuntime });
  assert.equal(allowed.status, 'needs_style_image');
  const forbidden = await call(store, { ...args, delegation: delegate('production', { apiPolicy: 'forbid', userAnswer: '이제 돈 쓰지 말고 알아서 해줘.' }), imageRuntime: apiRuntime });
  assert.equal(forbidden.blockedBy, 'api-forbidden'); assert.deepEqual(forbidden.jobs, []);
  await assert.rejects(call(store, { ...args, delegation: delegate('production', { apiPolicy: 'forbid' }), confirmImageChoice: forbidden.imageChoice.id, feedback: '알아서' }), /WEBTOON_API_FORBIDDEN/);
  const free = await call(store, { ...args, delegation: delegate('production', { apiPolicy: 'forbid' }), imageRuntime: builtinRuntime });
  assert.equal(free.jobs[0].hostRequest.tool, 'image_gen');
});

test('production delegation defaults missing panels to auto, preserves explicit choices and enforces retry limits', async () => {
  const { store, args } = await sceneSetup(); await adopt(store);
  const p = { async complete(request) {
    const d = JSON.parse(request.messages.at(-1).content);
    return { text: JSON.stringify(request.step === 'webtoon-scene-plan' ? { ...scenePlan(d.source), panelCount: 4 }
      : { ...scenePreflight(d), renderBrief: { ...scenePreflight(d).renderBrief, style: d.styleBasis.profile.style } }) };
  } };
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, delegation: delegate('style') }, providers: p }), /SCENE_DELEGATION_SCOPE/);
  await assert.rejects(runWebtoonSceneTool({ store, args: { ...args, delegation: delegate('production', { maxAutoRevisions: 0 }), autoRevisions: 1 }, providers: p }), /WEBTOON_DELEGATION_RETRY_LIMIT/);
  const r = await runWebtoonSceneTool({ store, args: { ...args, panelCount: undefined, direction: undefined, delegation: delegate('production', { maxAutoRevisions: 0 }) }, providers: p });
  assert.equal(r.panelCountMode, 'auto'); assert.equal(r.panelCount, 4); assert.equal(r.autoRevision.limit, 0);
  assert.equal(r.delegation.userAnswer, '알아서 해줘.');
  const other = await sceneSetup();
  const explicit = await runWebtoonSceneTool({ store: other.store, args: { ...other.args, panelCount: 6, delegation: delegate() }, providers: provider() });
  assert.equal(explicit.panelCount, 6); assert.equal(explicit.panelCountMode, 'user');
});

test('delegation does not extend to existing scenes unless the user explicitly names them', async () => {
  const { store, args } = await sceneSetup(); await adopt(store);
  const scene = await runWebtoonSceneTool({ store, args, providers: provider() });
  let c = await proposal(store, args.references[0].path, delegate());
  await assert.rejects(call(store, { action: 'approve', proposalId: c.proposalId, choice: choose(c), applyToWorkflows: [scene.workflowId] }), /STYLE_DELEGATION_EXISTING_SCENES_FORBIDDEN/);
  await assert.rejects(runWebtoonSceneTool({ store, args: { workId, action: 'revise', delegation: delegate(), feedback: '알아서' }, providers: provider() }), /SCENE_DELEGATION_SCOPE/);
  c = await call(store, { action: 'set_mode', proposalId: c.proposalId,
    delegation: delegate('production', { userAnswer: '이 장면도 새 그림체로 알아서 바꿔줘.', reviseWorkflows: [scene.workflowId] }) });
  const result = await call(store, { action: 'approve', proposalId: c.proposalId, choice: choose(c), applyToWorkflows: [scene.workflowId] });
  assert.equal(result.change.existingScenes[0].effect, 'revision-requested');
  const revised = await runWebtoonSceneTool({ store, args: { workId, workflowId: scene.workflowId, action: 'revise', styleRevisionId: result.style.revisionId,
    delegation: c.delegation, feedback: c.delegation.userAnswer }, providers: provider() });
  assert.equal(revised.style.revisionId, result.style.revisionId);
});

test('revoking delegation while generation is pending keeps its receipt and later waits for user choice', async () => {
  const { store, repo } = await sceneSetup(); await unlink(repo.path('image-selection.json'));
  const c = await call(store, { action: 'propose', brief: '알아서', direction: 'Ink comic.', delegation: delegate(), imageRuntime: builtinRuntime });
  const changed = await call(store, { action: 'set_mode', proposalId: c.proposalId, delegation: null, feedback: '먼저 보여줘.' });
  assert.equal(changed.jobs[0].inputHash, c.jobs[0].inputHash);
  const j = c.jobs[0], imported = await call(store, { action: 'import', proposalId: c.proposalId, asset: { path: join(store.rootDir, 'ref.png'), inputHash: j.inputHash,
    provenance: { kind: 'host-built-in', provider: 'codex', tool: 'image_gen', selectionId: j.hostRequest.selectionId } } });
  assert.equal(imported.status, 'awaiting_style_approval');
  await assert.rejects(call(store, { action: 'approve', proposalId: c.proposalId, choice: choose(imported) }), /STYLE_USER_APPROVAL_REQUIRED/);
});

test('a later cost restriction blocks old sample jobs and scene dispatch until a permitted path is selected', async () => {
  const { store, args } = await sceneSetup();
  const c = await call(store, { action: 'propose', brief: '알아서', direction: 'Ink comic.', delegation: delegate() });
  const stopped = await call(store, { action: 'set_mode', proposalId: c.proposalId, delegation: delegate('production', { apiPolicy: 'forbid', userAnswer: '이제 돈 쓰지 마.' }) });
  assert.equal(stopped.blockedBy, 'api-forbidden'); assert.deepEqual(stopped.jobs, []);
  assert.deepEqual((await call(store, { action: 'status', proposalId: c.proposalId })).jobs, []);
  const manual = await call(store, { action: 'set_mode', proposalId: c.proposalId, delegation: null, feedback: '선택은 내가 할게. 돈은 쓰지 마.' });
  assert.equal(manual.apiRestriction, 'forbid'); assert.deepEqual(manual.jobs, []);
  await adopt(store);
  const scene = await runWebtoonSceneTool({ store, args, providers: provider() });
  const delegation = delegate('production', { apiPolicy: 'forbid', userAnswer: '이 장면도 돈 쓰지 말고 다시 해줘.', reviseWorkflows: [scene.workflowId] });
  const blocked = await runWebtoonSceneTool({ store, args: { workId, action: 'revise', delegation, feedback: delegation.userAnswer }, providers: provider() });
  assert.equal(blocked.status, 'needs_image_runtime');
  assert.deepEqual((await runWebtoonSceneTool({ store, args: { workId }, providers: provider() })).jobs, []);
  const changed = await runWebtoonSceneTool({ store, args: { workId, action: 'revise', delegation, feedback: delegation.userAnswer, imageRuntime: builtinRuntime }, providers: provider() });
  assert.equal(changed.jobs[0].hostRequest.tool, 'image_gen'); assert.notEqual(changed.jobs[0].inputHash, scene.jobs[0].inputHash);
});

test('user cancellation keeps artifacts, closes pending model work and cannot be resumed by stale answers', async () => {
  const { store, args } = await sceneSetup(); await adopt(store);
  const pending = await runWebtoonSceneTool({ store, args: { ...args, delegation: delegate() }, providers: createHostRelay() });
  const run = await loadRun(store.rootDir, pending.runId);
  const stopped = await runWebtoonSceneTool({ store, args: { workId, action: 'reject', feedback: '여기서 멈춰.' }, providers: provider() });
  assert.equal(stopped.status, 'rejected'); assert.deepEqual(stopped.artifacts, pending.artifacts);
  await assert.rejects(runWebtoonSceneTool({ store, args: run.args, run, providers: provider() }), /STALE_WEBTOON_RUN/);
  const next = await runWebtoonSceneTool({ store, args: { ...args, delegation: delegate() }, providers: provider() });
  assert.notEqual(next.workflowId, pending.workflowId);
});
