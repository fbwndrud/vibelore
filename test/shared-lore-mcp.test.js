import assert from 'node:assert/strict';
import { it } from 'node:test';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { sharedWorld, sharedBinding } from './fixtures/shared-lore.js';
import { qualityStore, workId } from './fixtures/quality-workflow.js';

function rpc(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, VIBELORE_MCP_SURFACE: 'public' } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`MCP timeout: ${stderr}`)); }, 20000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); if (code !== 0) return reject(new Error(`MCP failed: ${stderr}`));
      try { resolve(JSON.parse(stdout.trim().split('\n').at(-1)).result); } catch (error) { reject(error); }
    });
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
}
it('MCP exposes world adoption and approved work binding as complete host flows', async t => {
  const w = await sharedWorld(), store = await qualityStore();
  t.after(() => Promise.all([rm(w.root, { recursive: true, force: true }), rm(store.rootDir, { recursive: true, force: true })]));
  const world = { worldRoot: w.root, universeId: 'u1' }, project = { project: store.rootDir, workId };
  const content = structuredClone(w.content); content.documents[0].text += '\nMCP_APPROVED_WORLD';
  const candidate = await rpc('lore_universe', { ...world, action: 'propose', expectedHead: w.head, registryRevisionId: w.registry.revisionId, content, reason: '호스트 세계 제안' });
  assert.equal(candidate.isError, undefined); assert.equal(candidate.structuredContent.status, 'awaiting_approval');
  assert.equal((await rpc('lore_universe', { ...world, action: 'status' })).structuredContent.head, w.head);
  const accepted = await rpc('lore_universe', { ...world, action: 'decide', proposalId: candidate.structuredContent.proposalId, expectedHead: w.head, decision: 'approve' });
  assert.equal(accepted.structuredContent.status, 'adopted');
  const updatedWorld = { ...w, head: accepted.structuredContent.loreRevisionId };
  const inspected = await rpc('lore_bind', { ...project, action: 'inspect', worldRoot: w.root, binding: sharedBinding(updatedWorld, workId) });
  assert.equal(inspected.isError, undefined); assert.equal(inspected.structuredContent.status, 'awaiting_approval');
  const applied = await rpc('lore_bind', { ...project, action: 'apply', proposalId: inspected.structuredContent.proposalId, expectedHead: inspected.structuredContent.expectedHead });
  assert.equal(applied.structuredContent.status, 'bound');
  const status = await rpc('lore_bind', { ...project, action: 'status' });
  assert.equal(status.structuredContent.sharedLore.binding.loreRevisionId, updatedWorld.head);
  const resolve = await rpc('lore_universe', { ...world, action: 'resolve', loreRevisionId: updatedWorld.head, query: { subjectId: 'character-a', fieldId: 'gender', scope: { continuityId: 'main', timelineId: 't1', pointId: 'p1' } } });
  assert.equal(resolve.structuredContent.status, 'resolved'); assert.equal(resolve.structuredContent.value, 'female');
  assert.equal(resolve.structuredContent.loreRevisionId, updatedWorld.head);
});

it('two novels pin the same shared character at different states and write through public MCP lore_write', async t => {
  const { sharedSaga, sagaBinding, sagaScene, sceneMapAnswer } = await import('./fixtures/shared-lore.js');
  const { outputs } = await import('./fixtures/quality-workflow.js');
  const { contractResponse } = await import('./fixtures/contract-response.js');
  const { createPublicationUnit } = await import('../src/core/publication-unit.js');
  const w = await sharedSaga(), a = await qualityStore(), b = await qualityStore();
  t.after(() => Promise.all([w.root, a.rootDir, b.rootDir].map(dir => rm(dir, { recursive: true, force: true }))));
  const answer = r => r.step === 'shared-scene-map' ? sceneMapAnswer(r.user)
    : contractResponse({ step: r.step, messages: [{ role: 'system', content: r.system ?? '' }, { role: 'user', content: r.user }] })?.text ?? outputs[r.step] ?? '{}';
  const write = async (store, pointId) => {
    const project = { project: store.rootDir, workId };
    const inspected = (await rpc('lore_bind', { ...project, action: 'inspect', worldRoot: w.root, binding: sagaBinding(w, workId, { 1: [sagaScene('s1', pointId)] }) })).structuredContent;
    assert.equal(inspected.status, 'awaiting_approval', JSON.stringify(inspected).slice(0, 600));
    assert.equal((await rpc('lore_bind', { ...project, action: 'apply', proposalId: inspected.proposalId, expectedHead: inspected.expectedHead })).structuredContent.status, 'bound');
    const drafts = [];
    let result = (await rpc('lore_write', { ...project, autonomy: 'auto' })).structuredContent;
    for (let pass = 0; result.status === 'needs_model' && pass < 30; pass++) {
      for (const r of result.requests) if (r.step === 'draft') drafts.push(`${r.system ?? ''}\n${r.user}`);
      result = (await rpc('lore_resume', { ...project, runId: result.runId, answers: Object.fromEntries(result.requests.map(r => [r.id, answer(r)])) })).structuredContent;
    }
    assert.equal(result.status, 'completed', JSON.stringify(result).slice(0, 1200));
    const tree = (await createPublicationUnit({ rootDir: store.rootDir }).readPublished()).value.tree;
    return { draft: drafts.join('\n'), lock: tree.productionInputs[1], sceneCheck: tree.sceneChecks?.[1] };
  };
  const adult = await write(a, 'adulthood'), ts = await write(b, 'ts');
  assert.match(adult.draft, /ADULT_ONLY/); assert.doesNotMatch(adult.draft, /TS_ONLY|CHILD_ONLY|FUTURE_SECRET_TOKEN/);
  assert.match(ts.draft, /TS_ONLY/); assert.doesNotMatch(ts.draft, /ADULT_ONLY|CHILD_ONLY|FUTURE_SECRET_TOKEN/);
  assert.deepEqual([adult.lock.scenes[0].stateIds, ts.lock.scenes[0].stateIds], [{ 'character-a': ['state-adult'] }, { 'character-a': ['state-ts'] }]);
  assert.equal(adult.lock.loreRevisionId, ts.lock.loreRevisionId);
  assert.equal(adult.sceneCheck.check.status, 'passed'); assert.equal(ts.sceneCheck.check.status, 'passed');
  assert.equal((await w.world.status()).head, w.head, 'writing never changes the shared world');
});
