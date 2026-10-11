import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sharedWorld, sharedBinding } from './fixtures/shared-lore.js';
import { qualityStore, workId, outputs } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';
import { inspectWorkBinding, applyWorkBinding, resumePendingWorkBinding } from '../src/core/work-binding.js';
import { currentValidationContext, sameIdentity } from '../src/core/validation-context.js';
import { createPublicationUnit } from '../src/core/publication-unit.js';
import { prepareLoreProduction, verifyLoreProductionLock, createWorkBinding } from '../engine/src/index.js';
import { renderWriterFoundation } from '../src/core/prompt-sections.js';
import { promptKit } from '../src/prompts/index.js';
import { runWriteWorkflow, runWorkflowDecide } from '../src/tools/workflow.js';
import { rollbackToSnapshot } from '../src/tools/snapshots.js';

const providers = requests => ({ async complete(req) { requests?.push(req); return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' }; } });
async function world(t) { const w = await sharedWorld(); t.after(() => rm(w.root, { recursive: true, force: true })); return w; }
async function work(t) { const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true })); return store; }
async function bind(store, w, point = 'p1') {
  const proposed = await inspectWorkBinding({ store, workId, worldRoot: w.root, binding: sharedBinding(w, workId, point) });
  return applyWorkBinding({ store, workId, proposalId: proposed.proposalId, expectedHead: proposed.expectedHead });
}

describe('SharedLore adoption and production binding', () => {
  it('adopts readable source documents with values, preserves old checkpoints and detects unadopted edits', async t => {
    const w = await world(t);
    assert.equal((await w.world.status()).drift.status, 'clean');
    assert.equal(await readFile(join(w.root, 'characters/states/after.md'), 'utf8'), w.content.documents.find(d => d.id === 'after').text);
    const content = structuredClone(w.content); content.documents.find(d => d.id === 'world').text = '# 세계\n달은 세 개다.\n';
    const p = await w.world.propose({ expectedHead: w.head, registryRevisionId: w.registry.revisionId, content, reason: '달 설정 변경' });
    assert.equal(await w.world.head(), w.head); assert.equal(p.status, 'awaiting_approval');
    const next = await w.world.decide({ proposalId: p.proposalId, expectedHead: w.head, action: 'approve' });
    assert.notEqual(next.head, w.head);
    assert.match((await w.world.read(w.head)).revision.content.documents[0].text, /두 개/);
    await writeFile(join(w.root, 'world/setting.md'), '손수정한 아직 미채택 설정');
    assert.equal((await w.world.status()).drift.status, 'modified');
    assert.match((await w.world.read(w.head)).revision.content.documents[0].text, /두 개/);
  });
  it('refuses invalid ownership, missing evidence, overlapping truth and source changes after review', async t => {
    const w = await world(t);
    const propose = content => w.world.propose({ expectedHead: w.head, registryRevisionId: w.registry.revisionId, content, reason: '변경 검사' });
    const wrong = structuredClone(w.content); wrong.states[0].valueIds.push('value-after');
    await assert.rejects(propose(wrong), { code: 'LORE_OWNERSHIP_CONFLICT' });
    const missing = structuredClone(w.content); missing.values[0].evidenceIds = ['missing'];
    await assert.rejects(propose(missing), { code: 'LORE_DOCUMENT_MISSING' });
    const conflicting = structuredClone(w.content); conflicting.values[2].storyScope.fromPointId = 'p0'; conflicting.states[1].storyScope.fromPointId = 'p0';
    await assert.rejects(propose(conflicting), { code: 'LORE_VALUE_CONFLICT' });
    const p = await propose(w.content); await writeFile(join(w.root, 'characters/character-a.md'), '검토 뒤 변경');
    await assert.rejects(w.world.decide({ proposalId: p.proposalId, expectedHead: w.head, action: 'approve' }), { code: 'SHARED_LORE_SOURCE_DRIFT' });
    assert.equal(await w.world.head(), w.head);
  });
  it('recovers a sealed publication interrupted before source materialization without overwriting new human edits', async t => {
    const w = await world(t), content = structuredClone(w.content); content.documents[0].text = '# 세계\n복구할 설정\n';
    const p = await w.world.propose({ expectedHead: w.head, registryRevisionId: w.registry.revisionId, content, reason: '중단 검증' });
    await assert.rejects(w.world.decide({ proposalId: p.proposalId, expectedHead: w.head, action: 'approve', failAfterHead: true }), /injected/);
    assert.notEqual(await w.world.head(), w.head);
    assert.equal((await w.world.status()).drift.status, 'modified');
    assert.equal((await w.world.recover()).drift.status, 'clean');
    assert.match(await readFile(join(w.root, 'world/setting.md'), 'utf8'), /복구할/);
    await writeFile(join(w.root, 'world/setting.md'), '새로운 작가 손수정');
    await assert.rejects(w.world.recover(), { code: 'SHARED_LORE_SOURCE_DRIFT' });
  });
  it('pins two works to different stages of the same entity without leaking future state or author-only prose', async t => {
    const w = await world(t), a = await work(t), b = await work(t);
    await writeFile(join(a.rootDir, 'work.md'), '# 개인 메모\nKEEP_MY_NOTES\n');
    await bind(a, w, 'p0'); await bind(b, w, 'p1');
    const before = await currentValidationContext({ store: a, workId, chapter: 1 }), after = await currentValidationContext({ store: b, workId, chapter: 1 });
    assert.equal(before.foundation.characters[0].intrinsic.gender, 'male'); assert.equal(after.foundation.characters[0].intrinsic.gender, 'female');
    assert.match(before.foundation.sharedLore.contextText, /BEFORE_BODY_ONLY/); assert.doesNotMatch(before.foundation.sharedLore.contextText, /AFTER_BODY_ONLY|FUTURE_SECRET_TOKEN/);
    assert.match(after.foundation.sharedLore.contextText, /AFTER_BODY_ONLY/); assert.doesNotMatch(after.foundation.sharedLore.contextText, /BEFORE_BODY_ONLY|FUTURE_SECRET_TOKEN/);
    assert.equal((await b.loadFoundation(workId)).characters[0].intrinsic.gender, 'male');
    assert.match(await readFile(join(a.rootDir, 'work.md'), 'utf8'), /KEEP_MY_NOTES/);
    const rendered = renderWriterFoundation(after.foundation, ['hero'], 1, promptKit({ contract: after.workContract })); assert.match(rendered, /AFTER_BODY_ONLY/);
    assert.equal(verifyLoreProductionLock(after.productionLock).revisionId, after.productionLock.revisionId);
    await rm(w.root, { recursive: true, force: true });
    assert.equal(verifyLoreProductionLock(after.productionLock).revisionId, after.productionLock.revisionId);
    const tampered = structuredClone(after.productionLock); tampered.scenes[0].documents[0].text = '변조';
    await assert.rejects(async () => verifyLoreProductionLock(tampered), { code: 'LORE_INTEGRITY' });
  });
  it('keeps a prior world revision until explicit rebind and invalidates validation identity when the binding changes', async t => {
    const w = await world(t), store = await work(t); await bind(store, w, 'p0');
    const before = await currentValidationContext({ store, workId, chapter: 1 });
    const content = structuredClone(w.content); content.documents[0].text = '# 세계\nWORLD_NEW_TOKEN\n';
    const p = await w.world.propose({ expectedHead: w.head, registryRevisionId: w.registry.revisionId, content, reason: '신규 설정' });
    const next = await w.world.decide({ proposalId: p.proposalId, expectedHead: w.head, action: 'approve' });
    const pinned = await currentValidationContext({ store, workId, chapter: 1 });
    assert.equal(sameIdentity(before.identity, pinned.identity), true); assert.doesNotMatch(pinned.foundation.sharedLore.contextText, /WORLD_NEW_TOKEN/);
    const updated = { ...w, head: next.head }; await bind(store, updated, 'p1');
    const after = await currentValidationContext({ store, workId, chapter: 1 });
    assert.equal(sameIdentity(before.identity, after.identity), false); assert.match(after.foundation.sharedLore.contextText, /WORLD_NEW_TOKEN/);
    await writeFile(join(store.rootDir, 'work.md'), '# manual edit');
    await assert.rejects(currentValidationContext({ store, workId, chapter: 1 }), { code: 'WORKING_TREE_DRIFT' });
  });
  it('blocks missing required data and heterogeneous scene projections instead of applying one state across a chapter', async t => {
    const w = await world(t), binding = sharedBinding(w, workId);
    binding.chapters[0].scenes[0].requirements.push({ entityId: 'character-a', fieldId: 'unknown-power', required: true });
    const missing = prepareLoreProduction({ binding: createWorkBinding(binding), publication: w.publication, chapter: 1 });
    assert.equal(missing.status, 'unresolved'); assert.equal(missing.blockers[0].status, 'unknown');
    const two = sharedBinding(w, workId); two.chapters[0].scenes.push({ ...structuredClone(two.chapters[0].scenes[0]), id: 'past-scene', scope: { continuityId: 'main', timelineId: 't1', pointId: 'p0' } });
    const changing = prepareLoreProduction({ binding: createWorkBinding(two), publication: w.publication, chapter: 1 });
    assert.equal(changing.status, 'unresolved'); assert.equal(changing.blockers[0].status, 'requires_scene_checker');
  });
  it('uses shared input in actual writing, seals the lock with the chapter, and restores binding sources on rollback', async t => {
    const w = await world(t), store = await work(t); await bind(store, w, 'p1'); const requests = [];
    const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: providers(requests) });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.match(requests.find(r => r.step === 'draft').messages.map(m => m.content).join('\n'), /AFTER_BODY_ONLY/);
    const published = (await createPublicationUnit({ rootDir: store.rootDir }).readPublished()).value;
    assert.ok(published.tree.productionInputs[1].revisionId); assert.equal(verifyLoreProductionLock(published.tree.productionInputs[1]).loreRevisionId, w.head);
    assert.equal(published.tree.foundation.characters[0].intrinsic.gender, 'male');
    await bind(store, w, 'p0'); assert.equal((await currentValidationContext({ store, workId, chapter: 2 })).foundation.characters[0].intrinsic.gender, 'male');
    await rollbackToSnapshot({ store, workId, chapter: 1 });
    const restored = await currentValidationContext({ store, workId, chapter: 2 });
    assert.equal(restored.foundation.characters[0].intrinsic.gender, 'female');
    assert.equal((await readFile(join(store.rootDir, 'work.md'), 'utf8')).includes('"pointId": "p1"'), true);
  });
  it('cannot commit a checked draft after a shared binding update', async t => {
    const w = await world(t), store = await work(t); await bind(store, w, 'p1');
    const checked = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers: providers() });
    assert.equal(checked.status, 'awaiting_approval', JSON.stringify(checked));
    await bind(store, w, 'p0');
    await assert.rejects(runWorkflowDecide({ store, workId, action: 'approve', approvalId: checked.approvalId, providers: providers() }), { code: 'STALE_WORK_CONTRACT' });
    assert.deepEqual(await store.listChapters(), []);
  });
  it('recovers approved work.md bytes after HEAD publication and refuses unrelated human edits during recovery', async t => {
    const w = await world(t), store = await work(t);
    const proposal = await inspectWorkBinding({ store, workId, worldRoot: w.root, binding: sharedBinding(w, workId) });
    await assert.rejects(applyWorkBinding({ store, workId, proposalId: proposal.proposalId, expectedHead: proposal.expectedHead, failAfterHead: true }), /injected/);
    const foundationPath = join(store.rootDir, 'world/setting.md'), original = await readFile(foundationPath, 'utf8');
    await writeFile(foundationPath, `${original}\n작가가 새로 적은 설정`);
    await assert.rejects(resumePendingWorkBinding({ store }), { code: 'WORKING_TREE_DRIFT' });
    await writeFile(foundationPath, original);
    assert.equal((await resumePendingWorkBinding({ store })).status, 'recovered');
    assert.equal((await currentValidationContext({ store, workId, chapter: 1 })).foundation.characters[0].intrinsic.gender, 'female');
  });
  it('rejects an oversized shared prompt during binding inspection instead of truncating required canon', async t => {
    const w = await world(t), store = await work(t), content = structuredClone(w.content);
    content.documents[0].text = '가'.repeat(30000);
    const candidate = await w.world.propose({ expectedHead: w.head, registryRevisionId: w.registry.revisionId, content, reason: '긴 원문 예산 검사' });
    const adopted = await w.world.decide({ proposalId: candidate.proposalId, expectedHead: w.head, action: 'approve' });
    await assert.rejects(inspectWorkBinding({ store, workId, worldRoot: w.root, binding: sharedBinding({ ...w, head: adopted.head }, workId) }), { code: 'SHARED_LORE_CONTEXT_BUDGET' });
    assert.equal((await createPublicationUnit({ rootDir: store.rootDir }).readPublished()).value, null);
  });
  it('keeps work-owned intrinsic changes while shared fields take authority in the execution DTO', async t => {
    const w = await world(t), store = await work(t), foundation = await store.loadFoundation(workId);
    await store.saveFoundation({ ...foundation, intrinsicChanges: [
      { characterId: 'hero', field: 'gender', from: 'male', to: 'male', atChapter: 1, narrativeCause: '기존 작품 설정' },
      { characterId: 'hero', field: 'ageBand', from: '20대', to: '30대', atChapter: 1, narrativeCause: '작품의 시간 경과' },
    ] });
    await bind(store, w);
    const runtime = await currentValidationContext({ store, workId, chapter: 1 });
    assert.equal(runtime.foundation.characters[0].intrinsic.gender, 'female');
    assert.equal(runtime.foundation.characters[0].intrinsic.ageBand, '30대');
    assert.deepEqual(runtime.foundation.intrinsicChanges, []);
  });
});
