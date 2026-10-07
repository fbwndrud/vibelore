import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { sharedSaga, sagaBinding, sagaScene, sceneMapAnswer } from './fixtures/shared-lore.js';
import { qualityStore, workId, outputs } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';
import { LoreRegistryStore } from '../src/store/lore-registry-store.js';
import { inspectWorkBinding, applyWorkBinding } from '../src/core/work-binding.js';
import { runWriteWorkflow, runWorkflowDecide } from '../src/tools/workflow.js';
import { compileLoreRegistry } from '../engine/src/index.js';

const def = (id, key, overrides = {}) => ({ schemaVersion: 1, kind: 'field', id, namespace: 'u1', key, label: key, aliases: [], definition: `${key} 값`, subjectTypeIds: ['type-character'], valueType: { kind: 'text' }, owner: 'state', requiredScopes: ['continuity', 'worldPoint'], cardinality: 'one', constraints: [], missingPolicy: 'unknown', requiredCapabilities: [], ...overrides });
const providers = (requests = []) => ({ async complete(req) {
  requests.push(req);
  if (req.step === 'shared-scene-map') return { text: sceneMapAnswer(req.messages.find(m => m.role === 'user').content) };
  return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' };
} });
function rpc(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, VIBELORE_MCP_SURFACE: 'public' } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`MCP timeout: ${stderr}`)); }, 20000);
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) return reject(new Error(stderr)); resolve(JSON.parse(stdout.trim().split('\n').at(-1)).result); });
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
}

describe('AI definition extension', () => {
  it('searches, reuses, registers only safe additions, records migrations and refuses unsupported behavior', async t => {
    const w = await sharedSaga(); t.after(() => rm(w.root, { recursive: true, force: true }));
    const store = new LoreRegistryStore(w.root, 'u1');
    const needs = [
      { definition: def('curse-mark', 'curse.mark'), why: '저주 표식이 장면마다 바뀐다' },
      { definition: def('gender-copy', 'body.gender', { valueType: { kind: 'enum', values: ['male', 'female'] } }), why: '같은 의미의 새 ID 제안' },
      { definition: def('name', 'character.name', { owner: 'state' }), why: '이름을 시점별로 바꾸려는 제안' },
      { definition: def('loop-memory', 'loop.memory', { requiredCapabilities: ['experience-path-v1'] }), why: '회귀 기억' },
    ];
    const first = await store.ensure({ needs, reason: '2화 장면에 필요한 정의', operationId: 'write-run-0001' });
    assert.deepEqual(first.outcomes.map(o => o.outcome), ['registered', 'reused', 'migration_required', 'unsupported']);
    assert.equal(first.outcomes[1].definitionId, 'body-gender'); assert.equal(first.outcomes[1].proposedId, 'gender-copy');
    assert.ok(first.outcomes[2].changes.some(c => c.field === 'owner'));
    assert.equal(first.outcomes[3].capabilities[0].capability, 'experience-path-v1');
    assert.equal(first.addedRevisionIds.length, 1); assert.notEqual(first.head, first.previousHead);
    const compiled = compileLoreRegistry((await store.read()).registry);
    assert.ok(compiled.definition('curse-mark')); assert.equal(compiled.definition('gender-copy'), null); assert.equal(compiled.definition('loop-memory'), null);
    assert.equal(compiled.definition('name').definition.owner, 'profile', 'migration candidates are never applied');
    assert.equal((await readdir(join(w.root, '.vibelore/shared-lore/registry/migrations'))).length, 1);
    const replay = await store.ensure({ needs, reason: '2화 장면에 필요한 정의', operationId: 'write-run-0001' });
    assert.equal(replay.replayed, true); assert.equal(replay.head, first.head); assert.deepEqual(replay.addedRevisionIds, first.addedRevisionIds);
    await assert.rejects(store.ensure({ needs: needs.slice(0, 1), reason: '다른 요청', operationId: 'write-run-0001' }), { code: 'OPERATION_CONFLICT' });
    const retry = await store.ensure({ needs: [{ definition: def('curse-mark-2', 'curse.mark') }], reason: '응답 유실 후 재시도' });
    assert.equal(retry.outcomes[0].outcome, 'reused'); assert.equal(retry.outcomes[0].definitionId, 'curse-mark'); assert.equal(retry.head, first.head);
  });
  it('replays ensure over public MCP for a resumed host call', async t => {
    const w = await sharedSaga(); t.after(() => rm(w.root, { recursive: true, force: true }));
    const args = { action: 'ensure', registryRoot: w.root, universeId: 'u1', reason: '호스트 재개', operationId: 'mcp-op-0001', needs: [{ definition: def('oath', 'oath.bound') }] };
    const a = await rpc('lore_registry', args), b = await rpc('lore_registry', args);
    assert.equal(a.isError, undefined, JSON.stringify(a)); assert.equal(a.structuredContent.outcomes[0].outcome, 'registered');
    assert.equal(b.structuredContent.replayed, true); assert.equal(b.structuredContent.head, a.structuredContent.head);
    const status = await rpc('lore_registry', { action: 'status', registryRoot: w.root, universeId: 'u1' });
    assert.ok(status.structuredContent.unsupportedCapabilities['experience-path-v1']);
  });
  it('re-pins a new definition through world adoption and rebinding without mutating the issued lock or receipt', async t => {
    const w = await sharedSaga(), store = await qualityStore();
    t.after(() => Promise.all([rm(w.root, { recursive: true, force: true }), rm(store.rootDir, { recursive: true, force: true })]));
    const bind = async (world, chapters) => { const p = await inspectWorkBinding({ store, workId, worldRoot: w.root, binding: sagaBinding(world, workId, chapters) }); return applyWorkBinding({ store, workId, proposalId: p.proposalId, expectedHead: p.expectedHead }); };
    await bind(w, { 1: [sagaScene('s1', 'ts')] });
    const checked = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: providers() });
    assert.equal(checked.status, 'awaiting_approval', JSON.stringify(checked).slice(0, 800));
    const oldReceipt = await store.loadCheckReceipt(workId, checked.checkId ?? (await store.loadWorkflow(workId)).checkId);
    const oldLock = oldReceipt.identity.productionLockId;
    // The writing host discovers it needs a curse mark: definition first, world value adoption separately.
    const registry = new LoreRegistryStore(w.root, 'u1');
    const ensured = await registry.ensure({ needs: [{ definition: def('curse-mark', 'curse.mark') }], reason: '1화에 저주 표식이 필요', operationId: 'write-0001-curse' });
    const rev = compileLoreRegistry((await registry.read()).registry).definition('curse-mark').revisionId;
    const content = structuredClone(w.content);
    content.values.push({ id: 'ts-curse', subject: { kind: 'entity', entityId: 'character-a' }, fieldDefinitionRevisionId: rev, owner: 'state', value: '왼손의 검은 문양', storyScope: { continuityId: 'main', timelineId: 't1', fromPointId: 'ts', untilPointId: null }, evidenceIds: ['ts-doc'] });
    content.states.find(s => s.id === 'state-ts').valueIds.push('ts-curse');
    content.documents.find(d => d.id === 'ts-doc').text += '왼손에 검은 문양이 남는다.\n';
    const proposal = await w.world.propose({ expectedHead: w.head, registryRevisionId: ensured.registryRevisionId, content, reason: '저주 표식 채택' });
    const adopted = await w.world.decide({ proposalId: proposal.proposalId, expectedHead: w.head, action: 'approve' });
    const scene = { ...sagaScene('s1', 'ts'), requirements: [{ entityId: 'character-a', fieldId: 'name', required: true }, { entityId: 'character-a', fieldId: 'curse-mark', required: true }] };
    await bind({ ...w, head: adopted.head, registry: { revisionId: ensured.registryRevisionId } }, { 1: [scene] });
    await assert.rejects(runWorkflowDecide({ store, workId, action: 'approve', approvalId: checked.approvalId, providers: providers() }), { code: 'STALE_WORK_CONTRACT' });
    const preserved = await store.loadCheckReceipt(workId, oldReceipt.checkId);
    assert.equal(preserved.identity.productionLockId, oldLock, 'issued receipt keeps its lock');
    const requests = [];
    const rechecked = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: providers(requests) });
    assert.equal(rechecked.status, 'awaiting_approval', JSON.stringify(rechecked).slice(0, 800));
    const workflow = await store.loadWorkflow(workId);
    const newReceipt = await store.loadCheckReceipt(workId, workflow.checkId);
    assert.notEqual(newReceipt.identity.productionLockId, oldLock);
    assert.equal(newReceipt.identity.registryRevisionId, ensured.registryRevisionId);
    assert.match(requests.map(r => r.messages.map(m => m.content).join('\n')).join('\n'), /왼손의 검은 문양/);
    const done = await runWorkflowDecide({ store, workId, action: 'approve', approvalId: rechecked.approvalId, providers: providers() });
    assert.equal(done.status, 'completed', JSON.stringify(done).slice(0, 800));
  });
});
