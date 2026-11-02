import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workId } from './fixtures/webtoon.js';
import { episodeSetup, adaptationAnswer, adaptationReviewAnswer } from './fixtures/webtoon-episode.js';
import { runWebtoonTool } from '../src/tools/webtoon.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { loadRun } from '../src/runs.js';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

/** One stdio session on the default (public) surface; replies keyed by request id. */
function session(messages, timeoutMs = 20000) {
  return new Promise((resolveAll, rejectAll) => {
    const env = { ...process.env }; delete env.VIBELORE_MCP_SURFACE;
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env });
    const byId = new Map(), wanted = messages.filter(m => m.id !== undefined).length; let buffer = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); rejectAll(new Error(`server timed out; stderr=${stderr}`)); }, timeoutMs);
    child.stderr.on('data', d => { stderr += d; });
    child.stdout.on('data', chunk => {
      const lines = (buffer + chunk).split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines.filter(l => l.trim())) { const msg = JSON.parse(line); byId.set(msg.id, msg); }
      if (byId.size >= wanted) { clearTimeout(timer); child.stdin.end(); child.kill(); resolveAll(byId); }
    });
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  });
}
const invoke = (project) => async (name, args) => {
  const reply = (await session([init, call(2, name, { project, ...args })])).get(2);
  assert.equal(reply.result.isError, undefined, JSON.stringify(reply));
  return JSON.parse(reply.result.content[0].text);
};
const answerFor = request => {
  const data = JSON.parse(request.user);
  return JSON.stringify(request.step === 'webtoon-adaptation' ? adaptationAnswer(data) : adaptationReviewAnswer(data, request));
};

/** Start through stdio and answer adaptation and review until the approval gate. */
async function toApprovalGate(call, args) {
  let result = await call('lore_webtoon_episode', args);
  const steps = [];
  for (let pass = 0; result.status === 'needs_model' && pass < 4; pass++) {
    steps.push(result.requests.map(r => r.step));
    result = await call('lore_resume', { runId: result.runId, answers: Object.fromEntries(result.requests.map(r => [r.id, answerFor(r)])) });
  }
  return { result, steps };
}

test('lore_webtoon_episode is on the public surface and resumes through lore_resume', async () => {
  const { store, args } = await episodeSetup(), invokeTool = invoke(store.rootDir);
  const tools = (await session([init, { jsonrpc: '2.0', id: 2, method: 'tools/list' }])).get(2).result.tools;
  const tool = tools.find(t => t.name === 'lore_webtoon_episode');
  assert.ok(tool, 'tool is listed on the public surface');
  assert.match(tool.description, /lore_webtoon_scene/); assert.match(tool.description, /webtoonAdaptationReviewModel/);
  const props = Object.keys(tool.inputSchema.properties);
  for (const key of ['action', 'workflowId', 'sourceChapters', 'scriptId', 'sourceUnitIds', 'maxPages', 'pages', 'references', 'delegation', 'adaptationRevisions',
    'pageRevisions', 'direction', 'approvalId', 'feedback', 'target', 'pageIds', 'asset', 'tiles', 'imageRuntime', 'confirmImageChoice', 'styleRevisionId']) assert.ok(props.includes(key), key);
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['start', 'approve', 'revise', 'retry', 'reject', 'verify']);
  assert.deepEqual(tool.inputSchema.properties.target.enum, ['adaptation', 'page']);
  assert.deepEqual(tool.inputSchema.properties.asset.properties.provenance.properties.requestedQuality.enum, ['low', 'medium', 'high']);

  const first = await invokeTool('lore_webtoon_episode', args);
  assert.equal(first.status, 'needs_model'); assert.deepEqual(first.requests.map(r => r.step), ['webtoon-adaptation']);
  const run = await loadRun(store.rootDir, first.runId); assert.equal(run.tool, 'lore_webtoon_episode');
  const second = await invokeTool('lore_resume', { runId: first.runId, answers: { [first.requests[0].id]: answerFor(first.requests[0]) } });
  assert.equal(second.status, 'needs_model'); assert.deepEqual(second.requests.map(r => r.step), ['webtoon-adaptation-review']);
  const gate = await invokeTool('lore_resume', { runId: second.runId, answers: { [second.requests[0].id]: answerFor(second.requests[0]) } });
  assert.equal(gate.status, 'awaiting_adaptation_approval'); assert.equal(gate.productionMode, 'episode-pages-v1');
  assert.ok(gate.approvalView.approvalId); assert.equal(gate.pages.length, 0);
  const approved = await invokeTool('lore_webtoon_episode', { workId, action: 'approve', workflowId: gate.workflowId, approvalId: gate.approvalView.approvalId, feedback: '이 대본으로 가자.' });
  assert.equal(approved.status, 'needs_model'); assert.deepEqual(approved.requests.map(r => r.step), ['webtoon-page-brief']);
  const status = await invokeTool('lore_workflow_status', { workId, lane: 'webtoon', workflowId: gate.workflowId });
  assert.equal(status.status, 'page_brief'); assert.equal(status.approval.by, 'user');
});

test('workflow status with lane webtoon shows an episode workflow', async () => {
  const { store, args } = await episodeSetup(), invokeTool = invoke(store.rootDir);
  const { result: gate } = await toApprovalGate(invokeTool, args);
  assert.equal(gate.status, 'awaiting_adaptation_approval');
  for (const name of ['lore_workflow_status', 'lore_workflow_history']) {
    const status = await invokeTool(name, { workId, lane: 'webtoon', workflowId: gate.workflowId });
    assert.equal(status.found, true); assert.equal(status.active, true); assert.equal(status.productionMode, 'episode-pages-v1');
    assert.equal(status.status, 'awaiting_adaptation_approval'); assert.equal(status.approvalView.approvalId, gate.approvalView.approvalId);
    if (name === 'lore_workflow_history') assert.ok(status.events.some(e => e.event === 'episode_started'));
  }
  const current = await invokeTool('lore_workflow_status', { workId, lane: 'webtoon' });
  assert.equal(current.workflowId, gate.workflowId);
  await assert.rejects(runWebtoonTool({ store, toolName: 'lore_webtoon_render', args: { workId, workflowId: gate.workflowId }, providers: createHostRelay() }), /USE_WEBTOON_EPISODE_TOOL/);
});
