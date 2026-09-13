import { digest } from '../src/core/webtoon-contract.js';
import { webtoonStore, workId as webtoonWorkId, answers as webtoonAnswers, plan as webtoonPlan, editorial as webtoonEditorial, pixel } from './fixtures/webtoon.js';
import { sceneSetup, scenePlan, scenePreflight } from './fixtures/webtoon-scene.js';
/**
 * Protocol-level tests: drive the real server binary over stdio the way a host
 * does. If these pass, the thing is installable; unit tests on the tools say
 * nothing about that.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, unlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { runCommit } from '../src/tools/commit.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { rollbackToSnapshot } from '../src/tools/snapshots.js';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { qualityStore, outputs as qualityOutputs, workId as qualityWorkId } from './fixtures/quality-workflow.js';
import { approvalResponse } from './fixtures/approval-response.js';
import { contractResponse } from './fixtures/contract-response.js';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

/** Send a list of requests, collect the replies keyed by id. */
function session(messages, { timeoutMs = 20000, surface = 'advanced' } = {}) {
  return new Promise((resolveAll, rejectAll) => {
    const env = { ...process.env };
    if (surface === 'advanced') env.VIBELORE_MCP_SURFACE = 'advanced';
    else delete env.VIBELORE_MCP_SURFACE;
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env });
    const byId = new Map();
    let buffer = '';
    let stderr = '';
    const wanted = messages.filter((m) => m.id !== undefined).length;
    const timer = setTimeout(() => {
      child.kill();
      rejectAll(new Error(`server timed out; stderr=${stderr}`));
    }, timeoutMs);

    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        const msg = JSON.parse(line);
        byId.set(msg.id, msg);
      }
      if (byId.size >= wanted) {
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        resolveAll(byId);
      }
    });
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  });
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const payload = (msg) => JSON.parse(msg.result.content[0].text);
const proofAnswer = request => {
  const full = { step: request.step, messages: [
    { role: 'system', content: request.system ?? '' }, { role: 'user', content: request.user ?? '' },
  ] };
  return contractResponse(full)?.text ?? approvalResponse(full)?.text;
};
async function initializeWork(args, extra = {}) {
  let replies = await session([init, call(2, 'lore_init', { ...args, ...extra })]);
  let result = payload(replies.get(2));
  for (let attempt = 0; result.status === 'needs_model' && attempt < 5; attempt++) {
    const answers = Object.fromEntries(result.requests.map(request => {
      const answer = proofAnswer(request);
      assert.ok(answer, `Unexpected initialization request: ${request.step}`);
      return [request.id, answer];
    }));
    replies = await session([init, call(2, 'lore_resume', { project: args.project, runId: result.runId, answers })]);
    assert.equal(replies.get(2).result.isError, undefined);
    result = payload(replies.get(2));
  }
  assert.equal(result.status, 'ok', JSON.stringify(result));
  return result;
}
async function legacyWork(args, statement) {
  const store = new MarkdownStateStore(args.project);
  await store.saveFoundation({ workId: args.workId, genre: 'action', povMode: '3인칭제한',
    targetChapters: 40, worldFacts: [{ id: 'wf-1', statement, registeredAtChapter: 1 }],
    characters: [], genreProfile: { invariants: [], dialogueRatioRange: [0, 1] } });
}

describe('MCP surface', () => {
  for (const failedReview of [false, true]) {
    it(`writes and resumes over real MCP stdio with ${failedReview ? 'failed review approval' : 'complete review evidence'}`, async () => {
      const store = await qualityStore();
      const args = { project: store.rootDir, workId: qualityWorkId };
      const invoke = async (name, more = {}) => {
        const replies = await session([init, call(2, name, { ...args, ...more })], { surface: 'public' });
        assert.equal(replies.get(2).result.isError, undefined, JSON.stringify(replies.get(2)));
        return payload(replies.get(2));
      };
      let result = await invoke('lore_write', { autonomy: 'auto' });
      let sawDraft = false;
      for (let pass = 0; result.status === 'needs_model' && pass < 30; pass++) {
        const answers = {};
        for (const request of result.requests) {
          if (request.step === 'draft') {
            sawDraft = true;
            assert.match(request.user, /모르는 것을 배우며 능청스럽게/);
            assert.match(request.user, /지도는 배웠다/);
          }
          answers[request.id] = failedReview && request.step === 'editorial-quality'
            ? '{malformed' : proofAnswer(request) ?? qualityOutputs[request.step] ?? '{}';
        }
        result = await invoke('lore_resume', { runId: result.runId, answers });
      }
      assert.ok(sawDraft);
      assert.equal(result.status, failedReview ? 'awaiting_approval' : 'completed', JSON.stringify(result));
      if (failedReview) {
        assert.equal(result.degraded.code, 'CRITIC_INCOMPLETE');
        const repeated = await invoke('lore_write', { autonomy: 'auto' });
        assert.equal(repeated.approvalId, result.approvalId);
        result = await invoke('lore_decide', { approvalId: result.approvalId, action: 'approve' });
        assert.equal(result.status, 'completed', JSON.stringify(result));
      }
      const history = await invoke('lore_workflow_history', { includeModelExchanges: true });
      const review = history.events.findLast((event) => event.event === 'reviews_completed').review;
      assert.equal(review.status, failedReview ? 'failed' : 'completed');
      assert.ok(review.records.every((record) => record.evaluator.kind === 'host-relay'));
      assert.ok(history.modelExchanges.some((item) => item.exchange.request.step === 'draft'));
      assert.ok(history.modelExchanges.some((item) => item.exchange.request.step === 'editorial-quality'));
      assert.equal(history.events.filter((event) => event.event === 'reviews_completed').length, 1);
      const anchor = await invoke('lore_style_anchor', { action: 'approve', chapters: [1], reason: '인물의 관찰 방식이 마음에 든다.' });
      assert.equal(anchor.anchor.reason, '인물의 관찰 방식이 마음에 든다.');
    });
  }

  it('routes lore_write model hints per stage and keeps the profile through resume and decide', async () => {
    const store = await qualityStore();
    const args = { project: store.rootDir, workId: qualityWorkId };
    const invoke = async (name, more = {}) => {
      const replies = await session([init, call(2, name, { ...args, ...more })], { surface: 'public' });
      assert.equal(replies.get(2).result.isError, undefined, JSON.stringify(replies.get(2)));
      return payload(replies.get(2));
    };
    const modelProfile = { default: { modelId: 'strong', reasoningEffort: 'high' }, light: 'fast', quality: { reasoningEffort: 'low' } };
    let result = await invoke('lore_write', { autonomy: 'guided', modelProfile });
    const seen = {};
    for (let pass = 0; result.status === 'needs_model' && pass < 30; pass++) {
      const answers = {};
      for (const request of result.requests) {
        seen[request.step] = { stage: request.stage, model: request.model, reasoningEffort: request.reasoningEffort };
        answers[request.id] = qualityOutputs[request.step] ?? '{}';
      }
      result = await invoke('lore_resume', { runId: result.runId, answers });
    }
    assert.equal(result.status, 'awaiting_approval', JSON.stringify(result));
    assert.deepEqual(seen.draft, { stage: 'draft', model: { provider: 'host', modelId: 'fast' }, reasoningEffort: 'high' });
    assert.deepEqual(seen['editorial-quality'], { stage: 'review', model: { provider: 'host', modelId: 'fast' }, reasoningEffort: 'high' });
    assert.deepEqual(seen['continuity-extract'], { stage: 'quality', model: { provider: 'host', modelId: 'strong' }, reasoningEffort: 'low' });
    const status = await invoke('lore_workflow_status');
    assert.deepEqual(status.modelProfile ?? (await store.loadWorkflow(qualityWorkId)).modelProfile, {
      default: { provider: 'host', modelId: 'strong', reasoningEffort: 'high' }, light: { provider: 'host', modelId: 'fast' }, quality: { reasoningEffort: 'low' },
    });
    result = await invoke('lore_decide', { approvalId: result.approvalId, action: 'approve' });
    for (let pass = 0; result.status === 'needs_model' && pass < 30; pass++) {
      const answers = {};
      for (const request of result.requests) {
        seen[request.step] = { stage: request.stage, model: request.model, reasoningEffort: request.reasoningEffort };
        answers[request.id] = qualityOutputs[request.step] ?? '{}';
      }
      result = await invoke('lore_resume', { runId: result.runId, answers });
    }
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const finalSteps = Object.entries(seen).filter(([, v]) => v.stage === 'final');
    assert.ok(finalSteps.length > 0, JSON.stringify(Object.keys(seen)));
    assert.ok(finalSteps.every(([, v]) => v.model.modelId === 'strong'));
  });

  it('initializes and echoes the protocol version the host asked for', async () => {
    const out = await session([init]);
    const r = out.get(1).result;
    assert.equal(r.protocolVersion, '2025-06-18');
    assert.equal(r.serverInfo.name, 'vibelore');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(r.serverInfo.version, pkg.version);
    assert.match(r.instructions, /lore_write/);
  });

  it('lists only complete workflows on the default public surface', async () => {
    const out = await session(
      [init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }],
      { surface: 'public' },
    );
    const tools = out.get(2).result.tools;
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['lore_arc_decide', 'lore_arc_plan', 'lore_arc_review', 'lore_arc_status', 'lore_configure', 'lore_create', 'lore_decide', 'lore_init', 'lore_profile', 'lore_profile_decide', 'lore_profile_status', 'lore_resume', 'lore_rollback', 'lore_snapshot_status', 'lore_status', 'lore_story_decide', 'lore_story_plan', 'lore_story_status', 'lore_style_anchor', 'lore_sync', 'lore_webtoon_decide', 'lore_webtoon_plan', 'lore_webtoon_render', 'lore_webtoon_scene', 'lore_workflow_history', 'lore_workflow_status', 'lore_write', 'lore_writer_decide', 'lore_writer_skill', 'lore_writer_status'],
    );
    for (const t of tools) {
      assert.ok(t.description.length > 20, `${t.name} needs a real description`);
      assert.equal(t.inputSchema.type, 'object');
    }
  });

  it('keeps low-level primitives behind the explicit advanced surface', async () => {
    const listed = await session(
      [init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }],
      { surface: 'advanced' },
    );
    assert.equal(listed.get(2).result.tools.length, 43);
    assert.ok(listed.get(2).result.tools.some((tool) => tool.name === 'lore_commit'));

    const hidden = await session(
      [init, call(2, 'lore_commit', { workId: 'hidden', chapter: 1, prose: '본문' })],
      { surface: 'public' },
    );
    assert.equal(hidden.get(2).result.isError, true);
    assert.match(hidden.get(2).result.content[0].text, /public surface/);
  });

  it('serves style-anchor status through the public MCP route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibelore-mcp-style-anchor-'));
    const out = await session([
      init,
      call(2, 'lore_style_anchor', { project: dir, workId: 'style-work', action: 'status' }),
    ], { surface: 'public' });
    assert.equal(payload(out.get(2)).status, 'missing');
  });

  it('runs the scene-direct interview, auto panel count and exact model resume through public stdio', async () => {
    const { store, args: sceneArgs } = await sceneSetup();
    const invoke = async (name, more = {}) => {
      const replies = await session([init, call(2, name, { project: store.rootDir, ...more })], { surface: 'public' });
      assert.equal(replies.get(2).result.isError, undefined, JSON.stringify(replies.get(2)));
      return payload(replies.get(2));
    };
    const asked = await invoke('lore_webtoon_scene', { ...sceneArgs, panelCount: undefined });
    assert.equal(asked.status, 'needs_interview'); assert.ok(asked.questions[0].options.includes('auto'));
    let result = await invoke('lore_webtoon_scene', { ...sceneArgs, panelCount: 'auto' });
    assert.equal(result.status, 'needs_model'); assert.equal(result.panelCountMode, 'auto'); assert.equal(result.panelCount, null);
    for (let pass = 0; result.status === 'needs_model' && pass < 3; pass++) {
      const answers = {};
      for (const request of result.requests) {
        const data = JSON.parse(request.user);
        answers[request.id] = JSON.stringify(request.step === 'webtoon-scene-plan' ? scenePlan(data.source, 5) : scenePreflight(data));
      }
      result = await invoke('lore_resume', { runId: result.runId, answers });
    }
    assert.equal(result.status, 'needs_scene_image'); assert.equal(result.panelCount, 5);
    assert.match(result.jobs[0].prompt, /EXACTLY 5 panels/);
    const status = await invoke('lore_workflow_status', { workId: webtoonWorkId, lane: 'webtoon', workflowId: result.workflowId });
    assert.equal(status.productionMode, 'scene-direct-v1'); assert.equal(status.panelCountMode, 'auto'); assert.equal(status.panelCount, 5);
  });

  it('runs the webtoon interview, exact model resume and approval through public stdio', async () => {
    const store = await webtoonStore();
    const args = { project: store.rootDir, workId: webtoonWorkId };
    const invoke = async (name, more = {}) => {
      const replies = await session([init, call(2, name, { ...args, ...more })], { surface: 'public' });
      assert.equal(replies.get(2).result.isError, undefined, JSON.stringify(replies.get(2)));
      return payload(replies.get(2));
    };
    const first = await invoke('lore_webtoon_plan', { imageModel: 'gpt-image-2' });
    assert.equal(first.status, 'needs_interview');
    const profile = await invoke('lore_webtoon_plan', { workflowId: first.workflowId, responses: webtoonAnswers });
    let result = await invoke('lore_webtoon_decide', { workflowId: first.workflowId, approvalId: profile.approvalId, action: 'approve' });
    const pending = await invoke('lore_workflow_status', { lane: 'webtoon', workflowId: first.workflowId });
    assert.equal(pending.pendingRunId, result.runId);
    const noAnswer = await invoke('lore_resume', { runId: result.runId, answers: {} });
    assert.equal(noAnswer.status, 'needs_model');
    for (let pass = 0; result.status === 'needs_model' && pass < 4; pass++) {
      const answers = {};
      for (const request of result.requests) {
        const data = JSON.parse(request.user);
        answers[request.id] = JSON.stringify(request.step === 'webtoon-editorial' ? webtoonEditorial(data.source) : request.step === 'webtoon-plan' ? webtoonPlan(data.source) : { ...data.schema, findings: [] });
      }
      result = await invoke('lore_resume', { runId: result.runId, answers });
    }
    assert.equal(result.approval.kind, 'plan');
    const approved = await invoke('lore_webtoon_decide', { workflowId: first.workflowId, approvalId: result.approvalId, action: 'approve' });
    assert.equal(approved.status, 'plan_accepted');
    const history = await invoke('lore_workflow_history', { lane: 'webtoon', workflowId: first.workflowId, includeModelExchanges: true });
    assert.equal(history.modelExchanges.length, 3);
    assert.equal((await invoke('lore_workflow_status')).active, false);
    const workflowId = first.workflowId;
    const visualReview = async (pending) => {
      assert.equal(pending.status, 'needs_model');
      if (pending.requests[0].step === 'webtoon-layout-analyze') {
        const request = pending.requests[0]; const data = JSON.parse(request.user);
        const maps = data.shots.map(i => ({ shotId:i.shot.id,inputHash:i.inputHash,inspectedImages:true,evidence:'Synthetic protocol fixture only',protected:[],entries:i.shot.texts.map((t,textIndex)=>({textIndex,anchor:[.5,.65],candidates:[[.5,.35]],confidence:1,reason:'Synthetic mouth'})) }));
        const unchanged = await invoke('lore_resume', { runId: pending.runId, answers: {} });
        assert.equal(unchanged.requests[0].id,request.id);
        pending = await invoke('lore_resume',{runId:pending.runId,answers:{[request.id]:JSON.stringify({maps})}});
      }
      const answers = Object.fromEntries(pending.requests.map((request) => {
        assert.equal(request.step, 'webtoon-render-review');
        const data = JSON.parse(request.user);
        return [request.id, JSON.stringify({ ...data.schema, inspectedImages: true, findings: [] })];
      }));
      return invoke('lore_resume', { runId: pending.runId, answers });
    };
    const referenceJobs = await invoke('lore_webtoon_render', { workflowId });
    assert.equal(referenceJobs.status, 'needs_reference_images');
    const path = join(store.rootDir, 'synthetic.png'); await writeFile(path, pixel);
    const referenceReview = await invoke('lore_webtoon_render', { workflowId, references: referenceJobs.jobs.map(({ referenceId, inputHash }) => ({ referenceId, inputHash, path })) });
    const referenceGate = await visualReview(referenceReview);
    assert.equal(referenceGate.approval.kind, 'references');
    await invoke('lore_webtoon_decide', { workflowId, approvalId: referenceGate.approvalId, action: 'approve' });
    const missingPlan = await invoke('lore_webtoon_render', { workflowId });
    assert.equal(missingPlan.status, 'needs_continuity_plan');
    assert.deepEqual(missingPlan.jobs, []);
    const planned = approved.plan.sequences.flatMap(s => s.shots);
    const continuityPlan = { version: 2,
      scenes: [{ id: 'scene', environmentId: planned[0].environmentId, layout: 'Hero left, door right', cameraAxis: 'South' }],
      shots: planned.map((s, i) => ({ shotId: s.id, sceneId: 'scene', transition: i ? 'cut' : 'reset',
        ...(i ? { previousShotId: planned[i - 1].id } : {}), blocking: 'Hero left', camera: 'Medium',
        before: 'Door closed', after: 'Door closed', change: 'Speech', decisiveMoment: 'Opening mouth' })) };
    const roughJobs = await invoke('lore_webtoon_render', { workflowId, continuityPlan, feedback: 'Fixture storyboard' });
    let roughReview = await invoke('lore_webtoon_render', { workflowId,
      continuityRoughs: roughJobs.jobs.map(j => ({ sceneId: j.sceneId, inputHash: j.inputHash, path })) });
    const rough = roughReview.continuity.roughs[0];
    roughReview = await invoke('lore_webtoon_render', { workflowId, continuityReviews: [{ kind: 'rough', id: rough.sceneId,
      hash: rough.hash, contextHash: roughReview.roughReviewJobs[0].contextHash, inspectedImages: true, passed: true,
      evidence: 'Synthetic protocol fixture', observations: planned.map(s => ({ shotId: s.id, verdict: 'clear', evidence: 'Fixture silhouette' })),
      transitions: planned.slice(1).map((s, i) => ({ from: planned[i].id, to: s.id, verdict: 'clear', evidence: 'Fixture connection' })) }] });
    assert.equal(roughReview.approval.kind, 'storyboard');
    await invoke('lore_webtoon_decide', { workflowId, approvalId: roughReview.approvalId, action: 'approve' });
    const shotJobs = await invoke('lore_webtoon_render', { workflowId });
    assert.equal(shotJobs.status, 'needs_images');
    assert.equal(shotJobs.imagePolicy.targetModel, 'gpt-image-2');
    const pairs = await invoke('lore_webtoon_render', { workflowId,
      assets: shotJobs.jobs.map(({ shotId, inputHash }) => ({ shotId, inputHash, path })),
      continuityReviews: planned.map(s => ({ kind: 'shot', id: s.id, hash: digest(pixel), inspectedImages: true, passed: true,
        evidence: 'Synthetic fixture', composition: { verdict: 'clear', evidence: 'Fixture composition' } })) });
    assert.equal(pairs.status, 'needs_continuity_review');
    const look = await visualReview(await invoke('lore_webtoon_render', { workflowId,
      continuityReviews: pairs.continuity.transitions.map(p => ({ kind: 'transition', id: p.id, hash: p.hash,
        inspectedImages: true, passed: true, evidence: 'Synthetic fixture pair' })) }));
    assert.equal(look.approval.kind, 'look');
    await invoke('lore_webtoon_decide', { workflowId, approvalId: look.approvalId, action: 'approve' });
    const final = await visualReview(await invoke('lore_webtoon_render', { workflowId, quality: 'final' }));
    assert.equal(final.approval.kind, 'final');
    const completed = await invoke('lore_webtoon_decide', { workflowId, approvalId: final.approvalId, action: 'approve' });
    assert.equal(completed.status, 'completed');
  });

  it('answers an unknown method with a JSON-RPC error rather than dying', async () => {
    const out = await session([init, { jsonrpc: '2.0', id: 2, method: 'nope/nope' }]);
    assert.equal(out.get(2).error.code, -32601);
  });

  it('reports a tool failure as isError, keeping the session alive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibelore-mcp-'));
    const out = await session([
      init,
      call(2, 'lore_context', { project: dir, workId: 'nothing', chapter: 1 }),
      call(3, 'lore_status', { project: dir, workId: 'nothing' }),
    ]);
    assert.equal(out.get(2).result.isError, true);
    assert.match(out.get(2).result.content[0].text, /lore_init/);
    assert.equal(payload(out.get(3)).initialized, false);
    assert.equal(payload(out.get(3)).runtime.contractVersion, 'readability-v1');
  });

  it('exposes the integrated writer and reports missing setup instead of drafting out of order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibelore-mcp-workflow-'));
    await initializeWork({ project: dir, workId: 'ordered' }, { genre: 'litrpg', worldFacts: ['죽음은 영구적이다.'] });
    const out = await session([
      init,
      call(3, 'lore_write', { project: dir, workId: 'ordered', autonomy: 'guided' }),
    ]);
    const result = payload(out.get(3));
    assert.equal(result.status, 'needs_setup');
    assert.equal(result.code, 'PROFILE_NOT_ACTIVE');
  });

  it('runs init -> context -> check end to end over the protocol', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibelore-mcp-'));
    const args = { project: dir, workId: 'tower' };
    const initialized = await initializeWork(args, { genre: 'action', targetChapters: 40, worldFacts: ['검은 탑은 백 년째 아무도 오르지 못했다.'] });
    const out = await session([
      init,
      call(3, 'lore_context', { ...args, chapter: 1 }),
      call(4, 'lore_check', { ...args, chapter: 1, prose: '리엘은 탑을 올려다보았다.\n\n바람이 불었다.', deterministicOnly: true }),
      call(5, 'lore_status', args),
    ]);
    assert.equal(initialized.adopted, false);
    assert.match(payload(out.get(3)).context, /검은 탑은 백 년째/);
    const check = payload(out.get(4));
    assert.equal(check.status, 'ok');
    assert.equal(check.deterministicOnly, true);
    assert.equal(typeof check.prosody.score, 'number');
    assert.equal(check.checkId, undefined, 'deterministic preview cannot authorize publication');
    assert.equal(payload(out.get(5)).nextChapter, 1);
    assert.equal(payload(out.get(5)).runtime.contractVersion, 'readability-v1');
  });

  it('parks a run when it needs the model, and resumes it after a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibelore-mcp-'));
    const args = { project: dir, workId: 'tower' };
    await legacyWork(args, '탑이 있다.');
    const first = await session([
      init,
      call(3, 'lore_check', { ...args, chapter: 1, prose: '리엘은 탑을 보았다. 문은 잠겨 있었다.' }),
    ]);
    const parked = payload(first.get(3));
    assert.equal(parked.status, 'needs_model');
    assert.ok(parked.requests.length >= 1);
    assert.ok(parked.requests.some((r) => r.step === 'continuity-extract'));
    assert.ok(parked.deterministicResult.violations !== undefined,
      '모델을 못 써도 결정론 결과는 함께 와야 합니다');

    // A brand-new server process -- the run has to come off disk. The semantic
    // check depends on the extracted delta, so it is asked in the next pass.
    const answers = Object.fromEntries(parked.requests.map((r) => [r.id, '{}']));
    const second = await session([init, call(2, 'lore_resume', { project: dir, runId: parked.runId, answers })]);
    const followUp = payload(second.get(2));
    assert.equal(followUp.status, 'needs_model');
    assert.equal(followUp.runId, parked.runId);
    assert.ok(followUp.requests.some((r) => r.step === 'continuity-check'));
    for (const r of followUp.requests) answers[r.id] = '{}';
    const third = await session([init, call(2, 'lore_resume', { project: dir, runId: parked.runId, answers })]);
    const resumed = payload(third.get(2));
    assert.equal(resumed.status, 'ok');
    assert.ok(['clean', 'soft-only', 'blocked'].includes(resumed.verdict));

    // The run is spent; asking again must not silently re-run it.
    const fourth = await session([init, call(2, 'lore_resume', { project: dir, runId: parked.runId, answers })]);
    assert.equal(fourth.get(2).result.isError, true);
  });

  it('resumes lore_write from persisted workflow answers after its run file expires', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibelore-mcp-write-resume-'));
    const workId = 'resume-book';
    const store = new MarkdownStateStore(dir);
    await store.saveFoundation({
      workId, genre: 'litrpg', povMode: '3인칭제한', targetChapters: 10,
      worldFacts: [{ id: 'wf1', statement: '죽음은 영구적이다.', registeredAtChapter: 1 }],
      characters: [], genreProfile: { invariants: [], dialogueRatioRange: [0, 1] },
    });
    await store.saveStoryProfile(workId, {
      workId, status: 'active', genreLabel: '성장물', engineGenre: 'litrpg',
      subgenres: [], tones: [], storyEngines: [], themes: [],
      format: { pov: '3인칭제한', chapterChars: 1000, serialization: '웹소설' },
      tracking: { engineBacked: [], semantic: [] },
      promptGuidance: { worldbuild: [], cast: [], arc: [], draft: [], avoid: [] },
    });
    await store.saveStorySpine(workId, { status: 'active', causalChain: ['시작', '선택', '비용', '붕괴', '최종 선택'] });
    await store.saveWriterSkill(workId, { status: 'active', coreAttention: ['이상', '비용'], sceneTransformations: ['행동', '비용', '재해석'], antiFixation: ['반복 금지', '완결 대사 금지'], discoverySpaces: ['행동 자유'] });
    await store.saveArcPlan(workId, {
      workId, arcNumber: 1, title: '첫 아크', promise: '문을 연다.', type: 'small',
      startChapter: 1, estimatedEpisodes: 3, status: 'active',
      episodes: [{ index: 1, chapter: 1, title: '문', beat: '문을 연다.', pressure: '잠겼다.', turn: '열쇠를 찾는다.', carry: '문 앞에 선다.', goal: '문을 연다.', conflict: '잠겼다.', growth: '', cost: '열쇠를 잃는다.', hook: '', status: 'pending' }],
    });
    await store.saveEpisodePlan(workId, {
      workId, chapter: 1, arcNumber: 1, arcEpisodeIndex: 1, title: '문', premise: '문을 연다.',
      cast: [], locations: ['문 앞'], openingState: '닫힘', closingState: '열림',
      scenePressure: { choiceOwner: '문을 여는 사람', incompatibleGoods: ['열쇠 보존', '문 개방'], decisionDeadline: '문이 다시 잠기기 전' },
      arcBeat: { goal: '문을 연다.', conflict: '잠겼다.', cost: '열쇠를 잃는다.' },
      scenes: [
        { order: 1, location: '문 앞', characters: [], situation: '문이 닫혔다.', choice: '열쇠를 찾는다.', change: '경첩에서 흔적을 발견한다.' },
        { order: 2, location: '문 앞', characters: [], situation: '열쇠는 한 번만 쓸 수 있다.', choice: '열쇠를 사용한다.', change: '문이 열리고 열쇠를 잃는다.' },
      ],
      reveals: [], withheld: [], tension: {}, powerChanges: [], artifacts: [], absurdity: '', hooksTouched: [], carryForward: [], status: 'active', revision: 1,
    });
    // This test isolates relay-answer durability after planning; the new
    // story-experience bootstrap is covered by the generation integration test.
    await store.saveStoryIdentity(workId, {
      workId, readerPromise: '문을 여는 선택', protagonistAppeal: '집요함', competenceSignature: ['관찰'],
      emotionalDefect: '불신', comedyEngines: ['상황 역전'], solutionPatternsToRotate: ['관찰'],
    });
    await store.savePilotContract(workId, {
      workId, beforeState: '문 밖', firstFailure: '열쇠 부재', protagonistSpecificAction: '흔적 관찰',
      irreversibleChoice: '문을 연다', competenceProof: '경첩 발견', humanHook: '안으로 갈 것인가',
      seriesPromise: '문 너머 탐험', closingQuestion: '안에는 무엇이 있는가',
    });

    const first = await session([init, call(2, 'lore_write', { project: dir, workId, autonomy: 'auto' })]);
    const draftRun = payload(first.get(2));
    assert.deepEqual(draftRun.requests.map((request) => request.step), ['draft']);

    await unlink(join(dir, '.vibelore', 'runs', `${draftRun.runId}.json`));
    const resumed = await session([init, call(2, 'lore_write', { project: dir, workId, autonomy: 'auto' })]);
    const resumedRun = payload(resumed.get(2));
    assert.deepEqual(resumedRun.requests.map((request) => request.step), ['draft'],
      '만료 뒤에는 이전 단계를 되묻지 않고 미완 단계부터 재개해야 한다');
  });

  it('preserves legacy automatic commit summaries and carries them into the next chapter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibelore-mcp-'));
    const args = { project: dir, workId: 'tower' };
    await legacyWork(args, '탑의 문은 백 년째 잠겨 있다.');
    const prose = '리엘은 탑의 잠긴 문 앞에서 오늘 반드시 들어가겠다고 선언했다. 문은 대답 대신 더 굳게 잠겼다.';
    const first = await session([
      init,
      call(3, 'lore_commit', { ...args, chapter: 1, prose }),
    ]);
    const parked = payload(first.get(3));
    assert.equal(parked.status, 'needs_model');
    assert.ok(parked.requests.some((request) => request.step === 'chapter-summary'));

    const answers = Object.fromEntries(parked.requests.map((request) => [
      request.id,
      request.step === 'chapter-summary'
        ? JSON.stringify({
          summary: '리엘은 백 년째 잠긴 탑의 문 앞에서 진입을 선언한다. 그러나 문은 끝내 열리지 않는다.',
          plotBeat: 'inciting', sceneTags: ['긴장'], povCharacter: 'riel',
        })
        : '{}',
    ]));
    const second = await session([
      init,
      call(2, 'lore_resume', { project: dir, runId: parked.runId, answers }),
      call(3, 'lore_context', { ...args, chapter: 2 }),
    ]);
    const committed = payload(second.get(2));
    assert.equal(committed.status, 'ok');
    assert.equal(committed.summary.source, 'generated');
    assert.match(payload(second.get(3)).context, /리엘은 백 년째 잠긴 탑/);
  });
});

for (const interrupted of [false, true]) {
  it(`restores status, context and the next writing workflow through MCP (interrupted=${interrupted})`, async () => {
    const store = await qualityStore();
    for (const chapter of [1, 2]) await runCommit({ store, workId: qualityWorkId, chapter, prose: `${chapter}번째 문을 열었다.`, summary: `${chapter}번째 문.`, providers: createHostRelay({}), delta: { chapterNumber: chapter, appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], hookChanges: [], mutableChanges: [], trackedEntityOps: [] } });
    const args = { project: store.rootDir, workId: qualityWorkId };
    if (interrupted) await assert.rejects(rollbackToSnapshot({ store, workId: qualityWorkId, chapter: 1, failAt: 'after:chapters' }), /injected/);
    else {
      const rollback = await session([init, call(2, 'lore_rollback', { ...args, chapter: 1 })], { surface: 'public' });
      assert.equal(rollback.get(2).result.isError, undefined);
    }
    const replies = await session([init, call(2, 'lore_status', args), call(3, 'lore_context', { ...args, chapter: 2 })]);
    assert.equal(payload(replies.get(2)).nextChapter, 2);
    assert.equal(payload(replies.get(2)).workingTree.status, 'clean');
    assert.equal(replies.get(3).result.isError, undefined);
    assert.doesNotMatch(payload(replies.get(3)).context, /2번째 문을 열었다/);
    const writing = await session([init, call(2, 'lore_write', { ...args, autonomy: 'guided' })], { surface: 'public' });
    assert.equal(writing.get(2).result.isError, undefined);
    assert.equal(payload(writing.get(2)).status, 'needs_model');
    assert.equal((await store.loadWorkflow(qualityWorkId)).chapter, 2);
  });
}

it('rejects malformed public tool input and remains available', async () => {
  const store = await qualityStore();
  const replies = await session([init,
    call(2, 'lore_rollback', { project: store.rootDir, workId: qualityWorkId, chapter: '../../../outside' }),
    call(3, 'lore_status', { project: store.rootDir, workId: qualityWorkId }),
  ], { surface: 'public' });
  assert.equal(replies.get(2).result.isError, true);
  assert.match(replies.get(2).result.content[0].text, /INVALID_ARGUMENT/);
  assert.equal(payload(replies.get(3)).initialized, true);
});

it('bounds input frames and accepts the next request after an oversized frame', async () => {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (data) => { stdout += data; });
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('frame test timeout')); }, 10000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  child.stdin.end('x'.repeat(16 * 1024 * 1024 + 1) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n');
  assert.equal(await completed, 0);
  const messages = stdout.trim().split('\n').map(JSON.parse);
  assert.equal(messages[0].error.code, -32600);
  assert.deepEqual(messages.at(-1), { jsonrpc: '2.0', id: 9, result: {} });
});

describe('lore_write model profile schema', () => {
  it('accepts a review stage hint separately from the state-writing quality stage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibelore-mcp-profile-'));
    const out = await session([init, call(2, 'lore_write', { project: dir, workId: 'tower', modelProfile: { review: 'fast', quality: 'careful' } })]);
    assert.notEqual(out.get(2).result.isError, true, JSON.stringify(out.get(2).result).slice(0, 300));
  });
});
