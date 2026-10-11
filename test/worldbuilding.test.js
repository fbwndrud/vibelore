import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { resolveWorldbuildingChoice, prepareWorldbuildingSource, WORLDBUILDING_QUESTION_ID } from '../src/core/worldbuilding.js';
import { runStoryProfile, runStoryProfileDecide } from '../src/tools/story-profile.js';
import { runCreate } from '../src/tools/generate.js';
import { runUniverse } from '../src/tools/universe.js';
import { LoreRegistryStore } from '../src/store/lore-registry-store.js';
import { inspectWorkBinding, applyWorkBinding } from '../src/core/work-binding.js';
import { planningFoundation, loadPlanningLore, loadLoreRuntime } from '../src/core/lore-runtime.js';
import { runRangeReview } from '../src/tools/range-review.js';
import { runStorySpine } from '../src/tools/story-spine.js';
import { runArcPlan } from '../src/tools/arc.js';
import { runEpisodePlan } from '../src/tools/episode-plan.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';
import { createPublicationUnit } from '../src/core/publication-unit.js';
import { createWorkBinding, compileLoreRegistry, verifyLoreProductionLock } from '../engine/src/index.js';
import { sharedSaga, sagaBinding, sagaScene, sceneMapAnswer } from './fixtures/shared-lore.js';
import { qualityStore, workId, outputs } from './fixtures/quality-workflow.js';
import { approvalResponse } from './fixtures/approval-response.js';
import { projectApprovalValue } from '../src/core/approval-language-gate.js';
import { contractResponse } from './fixtures/contract-response.js';

async function emptyStore(t) {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'worldbuilding-')));
  t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  return store;
}
const profileProvider = obj => ({ pending: [], async complete(req) { return approvalResponse(req) ?? { text: JSON.stringify(obj) }; } });

test('preparation depth is asked before other design questions, without trusting invented world confirmation', async t => {
  const store = await emptyStore(t);
  const obj = { engineGenre: 'litrpg', worldbuilding: { scope: 'universe', userAnswer: 'a fabricated answer' },
    designReview: { openQuestions: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, question: `질문 ${i}` })) } };
  const out = await runStoryProfile({ store, workId: 'book', brief: '마법 학교 이야기', providers: profileProvider(obj) });
  assert.equal(out.profile.worldbuilding.authority, 'unconfirmed');
  assert.equal(out.profile.worldbuilding.scope, 'starter');
  assert.deepEqual(out.profile.designReview.openQuestions.map(q => q.id), ['discovery-depth']);
  await assert.rejects(runStoryProfileDecide({ store, workId: 'book', action: 'approve', providers: profileProvider(obj) }), /DISCOVERY_PREFERENCE_REQUIRED/);
});

test('a detailed choice survives model omission, accepts a later smaller scope, and keeps delegation separate', () => {
  const source = '여러 작품에 쓸 큰 세계부터 만들고 싶어요.';
  const choice = resolveWorldbuildingChoice({ proposed: { scope: 'universe', focus: ['마법의 대가', '가문의 역사'], userAnswer: source }, source, mode: 'review' });
  assert.equal(choice.authority, 'user');
  assert.deepEqual(resolveWorldbuildingChoice({ existing: choice, source: '마법부터 정하죠', mode: 'review' }), choice);
  assert.deepEqual(resolveWorldbuildingChoice({ existing: choice, proposed: { scope: 'starter', userAnswer: '빨리 시작할게요' }, source: '빨리 시작할게요', changeSource: '학교 이름부터 정하죠', mode: 'review' }), choice, 'a quote from an earlier brief cannot undo a later settled scope');
  const reduced = resolveWorldbuildingChoice({ existing: choice, requested: { scope: 'starter', userAnswer: '일단 빨리 시작할게요.' }, source: '일단 빨리 시작할게요.', mode: 'review' });
  assert.equal(reduced.scope, 'starter');
  assert.throws(() => resolveWorldbuildingChoice({ requested: { scope: 'story', userAnswer: '없던 답변' }, source, mode: 'review' }), { code: 'INVALID_WORLDBUILDING_CHOICE' });
  assert.equal(resolveWorldbuildingChoice({ source: '알아서 해줘', mode: 'auto' }).authority, 'delegated');
  assert.equal(resolveWorldbuildingChoice({ existing: choice, source: '알아서 이어서 해줘', mode: 'auto' }).scope, 'universe');
});

test('user world choices remain provenance in a different work language; their exact values still affect the approval artifact', () => {
  const value = { worldbuilding: { scope: 'story', authority: 'user', focus: ['마법의 대가'], userAnswer: '자세히 준비하고 싶어요.' } };
  const projected = projectApprovalValue(value, [], { promptFamily: 'multilingual' });
  assert.deepEqual(projected.worldbuilding.focus, { id: ['마법의 대가'] });
  assert.notDeepEqual(projected, projectApprovalValue({ worldbuilding: { ...value.worldbuilding, focus: ['학교의 역사'] } }, [], { promptFamily: 'multilingual' }));
});

test('detailed creation waits for an adopted world before any generation call', async t => {
  const store = await emptyStore(t);
  await store.saveStoryProfile('book', { workId: 'book', status: 'active', engineGenre: 'litrpg', worldbuilding: { scope: 'story', authority: 'user' } });
  const calls = [];
  await assert.rejects(runCreate({ store, workId: 'book', title: '학교', brief: '마법 학교', providers: { complete: r => calls.push(r) } }), { code: 'WORLD_BUILDING_PREPARATION_REQUIRED' });
  assert.equal(calls.length, 0);
  assert.equal(await store.loadFoundation('book'), null);
});

test('opening selection pins adopted bytes, exposes catalog ownership, and rejects author-only and missing documents', async t => {
  const w = await sharedSaga(); t.after(() => rm(w.root, { recursive: true, force: true }));
  const source = { worldRoot: w.root, universeId: 'u1', loreRevisionId: w.head, documentIds: ['world-doc', 'profile-doc'] };
  const prepared = await prepareWorldbuildingSource({ choice: { scope: 'universe' }, source });
  assert.match(prepared.contextText, /두 개의 달/);
  assert.equal(prepared.documents.length, 2);
  const catalog = await runUniverse({ action: 'documents', worldRoot: w.root, universeId: 'u1', loreRevisionId: w.head });
  assert.equal(catalog.documents.find(d => d.id === 'adult-doc').owner.kind, 'state');
  assert.equal(catalog.documents.find(d => d.id === 'adult-doc').owner.storyScope.fromPointId, 'adulthood');
  assert.equal(catalog.documents[0].text, undefined);
  const raw = await runUniverse({ action: 'documents', ...source });
  assert.equal(raw.documents.length, 2); assert.match(raw.documents[0].text, /世界|세계/);
  for (const documentIds of [['secret-doc'], ['missing']]) await assert.rejects(prepareWorldbuildingSource({ choice: { scope: 'story' }, source: { ...source, documentIds } }), { code: 'INVALID_WORLDBUILDING_SOURCE' });
});

async function magicWorld(t) {
  const w = await sharedSaga(), store = await qualityStore();
  t.after(() => Promise.all([w.root, store.rootDir].map(p => rm(p, { recursive: true, force: true }))));
  const unset = { schemaVersion: 1, kind: 'field', id: 'unset-rule', namespace: 'u1', key: 'rule.unset', label: '미정 규칙', aliases: [], definition: '아직 결정하지 않은 규칙', subjectTypeIds: ['type-character'], valueType: { kind: 'text' }, owner: 'fact', requiredScopes: ['continuity', 'worldPoint'], cardinality: 'one', constraints: [], missingPolicy: 'unknown', requiredCapabilities: [] };
  const registered = await new LoreRegistryStore(w.root, 'u1').register({ expectedHead: w.registry.revisionId, reason: '마법 사용의 대가', definitions: [unset, { schemaVersion: 1, kind: 'field', id: 'magic-cost', namespace: 'u1', key: 'magic.cost', label: '마법의 대가', aliases: [], definition: '마법 한 번을 쓸 때 치르는 대가', subjectTypeIds: ['type-character'], valueType: { kind: 'text' }, owner: 'fact', requiredScopes: ['continuity', 'worldPoint'], cardinality: 'one', constraints: [], missingPolicy: 'unknown', requiredCapabilities: [] }] });
  const registry = registered.registry, content = structuredClone(w.content);
  content.documents.push({ id: 'magic-doc', path: 'world/magic.md', text: 'MAGIC_COST_ONE_YEAR: 마법을 쓰면 수명 1년을 잃는다.', visibility: 'context' },
    { id: 'history-doc', path: 'world/remote-history.md', text: 'UNRELATED_HISTORY '.repeat(12000), visibility: 'context' });
  content.worldDocumentIds.push('magic-doc', 'history-doc');
  content.values.push({ id: 'cost-a', subject: { kind: 'entity', entityId: 'character-a' }, fieldDefinitionRevisionId: compileLoreRegistry(registry).definition('magic-cost').revisionId, owner: 'fact', value: '수명 1년', storyScope: { continuityId: 'main', timelineId: 't1', fromPointId: 'childhood', untilPointId: null }, evidenceIds: ['magic-doc'] });
  const proposal = await w.world.propose({ expectedHead: w.head, registryRevisionId: registry.revisionId, content, reason: '큰 세계와 마법 규칙 채택' });
  const adopted = await w.world.decide({ expectedHead: w.head, proposalId: proposal.proposalId, action: 'approve' });
  const scene = { ...sagaScene('opening', 'adulthood'), worldDocumentIds: ['world-doc'], requirements: [{ entityId: 'character-a', fieldId: 'magic-cost', required: true }] };
  const binding = sagaBinding({ head: adopted.head, registry }, workId, { 1: [scene] });
  const inspected = await inspectWorkBinding({ store, workId, worldRoot: w.root, binding });
  await applyWorkBinding({ store, workId, proposalId: inspected.proposalId, expectedHead: inspected.expectedHead });
  return { w, store, binding, scene };
}

test('a large world delivers selected original rules and custom values to story, arc, episode, draft and review', async t => {
  const { store } = await magicWorld(t);
  const planned = await planningFoundation({ store, workId, chapters: [1] });
  assert.match(planned.foundation.sharedLore.contextText, /MAGIC_COST_ONE_YEAR/);
  assert.match(planned.foundation.sharedLore.contextText, /마법의 대가: "수명 1년"/);
  assert.doesNotMatch(planned.foundation.sharedLore.contextText, /UNRELATED_HISTORY|TS_ONLY|CHILD_ONLY|FUTURE_SECRET_TOKEN/);
  assert.ok(planned.planning.documents.includes('magic-doc'), 'required value evidence cannot be dropped by selection');
  for (const [run, args, step] of [[runStorySpine, {}, 'story-spine'], [runArcPlan, { episodes: 3, replaceActive: true }, 'arc-plan'], [runEpisodePlan, { chapter: 1 }, 'episode-plan']]) {
    let request;
    await assert.rejects(run({ store, workId, ...args, providers: { pending: [], async complete(r) { request = r; throw new Error('captured'); } } }), /captured/);
    assert.equal(request.step, step);
    assert.match(JSON.stringify(request.messages), /MAGIC_COST_ONE_YEAR/);
    assert.doesNotMatch(JSON.stringify(request.messages), /UNRELATED_HISTORY|TS_ONLY|FUTURE_SECRET_TOKEN/);
  }
  const requests = [];
  const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: { async complete(req) {
    requests.push(req);
    return req.step === 'shared-scene-map' ? { text: sceneMapAnswer(req.messages.find(m => m.role === 'user').content) }
      : contractResponse(req) ?? { text: outputs[req.step] ?? '{}' };
  } } });
  assert.equal(result.status, 'completed', JSON.stringify(result).slice(0, 1200));
  for (const step of ['draft', 'continuity-check']) {
    const request = requests.find(r => r.step === step);
    assert.match(JSON.stringify(request.messages), /MAGIC_COST_ONE_YEAR/);
    assert.doesNotMatch(JSON.stringify(request.messages), /UNRELATED_HISTORY|TS_ONLY|FUTURE_SECRET_TOKEN/);
  }
  const published = (await createPublicationUnit({ rootDir: store.rootDir }).readPublished()).value;
  const lock = published.tree.productionInputs[1];
  assert.equal(verifyLoreProductionLock(lock).revisionId, lock.revisionId);
  let rangeRequest;
  await assert.rejects(runRangeReview({ store, workId, providers: { async complete(request) {
    rangeRequest = request; throw Error('range captured');
  } } }), /range captured/);
  const input = JSON.parse(rangeRequest.messages[1].content);
  assert.equal(input.context.worldInput, lock.revisionId);
  assert.match(input.context.foundation.sharedLore.contextText, /MAGIC_COST_ONE_YEAR/);
  assert.doesNotMatch(input.context.foundation.sharedLore.contextText, /UNRELATED_HISTORY|TS_ONLY|FUTURE_SECRET_TOKEN/);
  const offlineCanon = { publishedRevision: { ...published, tree: { ...published.tree,
    sharedLore: { ...published.tree.sharedLore, worldRoot: '/missing-world-during-review' } } } };
  const sealed = await loadLoreRuntime({ canonicalStore: offlineCanon, foundation: published.tree.foundation, chapter: 1, preferSealed: true });
  assert.equal(sealed.productionLock.revisionId, lock.revisionId);
  assert.match(sealed.foundation.sharedLore.contextText, /MAGIC_COST_ONE_YEAR/);
});

test('planning refuses unresolved required values and excessive context instead of quietly omitting them', async t => {
  const { w, store, binding, scene } = await magicWorld(t);
  const foundation = await store.loadFoundation(workId);
  const canonical = scenes => ({ loadFoundation: async () => foundation, publishedRevision: { tree: { sharedLore: { worldRoot: w.root, binding: createWorkBinding({ ...binding, chapters: [{ chapter: 1, scenes }] }) } } } });
  const invalid = { ...scene, requirements: [{ entityId: 'character-a', fieldId: 'unset-rule', required: true }] };
  await assert.rejects(loadPlanningLore({ store, canonicalStore: canonical([invalid]), workId, chapters: [1] }), { code: 'SHARED_LORE_UNRESOLVED' });
  const huge = { ...scene }; delete huge.worldDocumentIds;
  await assert.rejects(loadPlanningLore({ store, canonicalStore: canonical([huge]), workId, chapters: [1] }), { code: 'SHARED_LORE_CONTEXT_BUDGET' });
  await assert.rejects(loadPlanningLore({ store, canonicalStore: canonical([{ ...scene, worldDocumentIds: ['secret-doc'] }]), workId, chapters: [1] }), { code: 'LORE_DOCUMENT_MISSING' });
  const current = await w.world.read(binding.loreRevisionId), content = structuredClone(current.revision.content);
  content.values.find(v => v.id === 'cost-a').evidenceIds = ['ts-doc'];
  const proposal = await w.world.propose({ expectedHead: binding.loreRevisionId, registryRevisionId: binding.registryRevisionId, content, reason: '잘못된 미래 근거가 설정에 채택된 경우' });
  const adopted = await w.world.decide({ expectedHead: binding.loreRevisionId, proposalId: proposal.proposalId, action: 'approve' });
  const futureEvidence = canonical([scene]);
  futureEvidence.publishedRevision.tree.sharedLore.binding = createWorkBinding({ ...binding, loreRevisionId: adopted.head });
  await assert.rejects(loadPlanningLore({ store, canonicalStore: futureEvidence, workId, chapters: [1] }), { code: 'SHARED_LORE_EVIDENCE_SCOPE' });

});

test('prepared worlds must be connected before planning; legacy works still plan without a shared world', async t => {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  assert.equal((await planningFoundation({ store, workId })).planning, null);
  const foundation = await store.loadFoundation(workId);
  await store.saveFoundation({ ...foundation, worldbuilding: { scope: 'story', source: { worldRoot: '/tmp/approved-world', universeId: 'u1', loreRevisionId: 'sha256:' + 'a'.repeat(64) } } });
  await assert.rejects(planningFoundation({ store, workId }), { code: 'WORLD_BUILDING_BINDING_REQUIRED' });
});
