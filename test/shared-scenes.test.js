import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rm } from 'node:fs/promises';
import { sharedSaga, sagaBinding, sagaScene, sceneMapAnswer } from './fixtures/shared-lore.js';
import { qualityStore, workId, outputs } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';
import { SYNTHETIC_LONG_PROSE } from './fixtures/synthetic-prose.js';
import { inspectWorkBinding, applyWorkBinding } from '../src/core/work-binding.js';
import { currentValidationContext } from '../src/core/validation-context.js';
import { createPublicationUnit } from '../src/core/publication-unit.js';
import { planningFoundation } from '../src/core/lore-runtime.js';
import { verifyReceiptSceneCheck } from '../src/core/shared-scene-check.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';
import { runCheck } from '../src/tools/check.js';
import { runArcPlan } from '../src/tools/arc.js';
import { verifyLoreProductionLock, LORE_RESOLVER_VERSION_V2 } from '../engine/src/index.js';

const paragraphs = SYNTHETIC_LONG_PROSE.split('\n\n');
const half = Math.floor(paragraphs.length / 2);
const proseWith = (first, second) => [...paragraphs.slice(0, half), ...(first ? [first] : []), ...paragraphs.slice(half), ...(second ? [second] : [])].join('\n\n');
const userOf = req => req.messages.find(m => m.role === 'user').content;
function providers({ requests = [], sceneMap = user => sceneMapAnswer(user) } = {}) {
  return { async complete(req) {
    requests.push(req);
    if (req.step === 'shared-scene-map') return { text: sceneMap(userOf(req)) };
    return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' };
  } };
}
async function setup(t, chapters) {
  const w = await sharedSaga(), store = await qualityStore();
  t.after(() => Promise.all([rm(w.root, { recursive: true, force: true }), rm(store.rootDir, { recursive: true, force: true })]));
  const proposal = await inspectWorkBinding({ store, workId, worldRoot: w.root, binding: sagaBinding(w, workId, chapters) });
  await applyWorkBinding({ store, workId, proposalId: proposal.proposalId, expectedHead: proposal.expectedHead });
  return { w, store, proposal };
}
const check = (store, prose, p) => runCheck({ store, workId, chapter: 1, prose, providers: p ?? providers(), issueReceipt: true });

describe('SharedLore scene-level writing and checking', () => {
  it('writes one chapter across a TS boundary through lore_write and seals the per-scene lock, map and check', async t => {
    const { store, proposal } = await setup(t, { 1: [sagaScene('s-adult', 'adulthood'), sagaScene('s-ts', 'ts')], 2: [sagaScene('s2', 'ts')] });
    assert.equal(proposal.previews[0].scenes.length, 2);
    const context = await currentValidationContext({ store, workId, chapter: 1 });
    assert.equal(context.foundation.characters[0].intrinsic.gender, 'unknown', 'one scene state must not become the chapter state');
    assert.deepEqual(context.foundation.characters[0].intrinsic.addressing.forbiddenGenderedTerms, []);
    assert.equal((await store.loadFoundation(workId)).characters[0].intrinsic.gender, 'male', 'work sheet is not rewritten');
    const requests = [];
    const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: providers({ requests }) });
    assert.equal(result.status, 'completed', JSON.stringify(result).slice(0, 2000));
    const draft = requests.find(r => r.step === 'draft').messages.map(m => m.content).join('\n');
    assert.match(draft, /ADULT_ONLY/); assert.match(draft, /TS_ONLY/); assert.match(draft, /Write these scenes in this order/);
    assert.doesNotMatch(draft, /CHILD_ONLY|FUTURE_SECRET_TOKEN/);
    assert.ok(requests.some(r => r.step === 'shared-scene-map'));
    const tree = (await createPublicationUnit({ rootDir: store.rootDir }).readPublished()).value.tree;
    const lock = tree.productionInputs[1];
    assert.equal(lock.resolverVersion, LORE_RESOLVER_VERSION_V2); assert.equal(verifyLoreProductionLock(lock).revisionId, lock.revisionId);
    const sealed = tree.sceneChecks[1];
    assert.equal(sealed.check.status, 'passed'); assert.equal(sealed.check.productionLockId, lock.revisionId);
    assert.deepEqual(sealed.check.scenes.map(s => [s.sceneId, s.stateIds['character-a'][0]]), [['s-adult', 'state-adult'], ['s-ts', 'state-ts']]);
    assert.equal(sealed.check.proseHash, sealed.map.proseHash);
    const next = await currentValidationContext({ store, workId, chapter: 2 });
    assert.equal(next.foundation.characters[0].intrinsic.gender, 'female');
  });
  it('detects a wrong-state term in the exact scene and blocks receipt reuse after the manuscript changes', async t => {
    const { store } = await setup(t, { 1: [sagaScene('s-adult', 'adulthood'), sagaScene('s-ts', 'ts')] });
    const bad = await check(store, proseWith(null, '하녀가 도련님, 하고 불렀다.'));
    const violation = bad.violations.find(v => v.code === 'SHARED_SCENE_FORBIDDEN_TERM');
    assert.ok(violation, JSON.stringify(bad.violations));
    assert.equal(violation.sceneId, 's-ts'); assert.deepEqual(violation.stateIds, ['state-ts']); assert.equal(violation.term, '도련님');
    assert.ok(violation.span.start > 0 && violation.fieldDefinitionRevisionId.startsWith('sha256:'));
    assert.notEqual(bad.status, 'passed'); assert.equal(bad.checkId, undefined);
    const okProse = proseWith('하인이 도련님이라 불렀다.', '하녀가 아가씨, 하고 불렀다.');
    const passed = await check(store, okProse);
    assert.ok(passed.checkId, JSON.stringify(passed).slice(0, 1500));
    const receipt = await store.loadCheckReceipt(workId, passed.checkId);
    const context = await currentValidationContext({ store, workId, chapter: 1 });
    assert.equal(verifyReceiptSceneCheck({ lock: context.productionLock, prose: receipt.artifact.prose, receipt }).check.status, 'passed');
    assert.throws(() => verifyReceiptSceneCheck({ lock: context.productionLock, prose: `${receipt.artifact.prose}\n\n덧붙인 문단`, receipt }), { code: 'STALE_SCENE_MAP' });
  });
  it('keeps a flashback state out of the present chapter and checks each part against its own state', async t => {
    const { store } = await setup(t, { 1: [sagaScene('now', 'ts'), sagaScene('memory', 'adulthood', 'flashback')], 2: [sagaScene('later', 'later')] });
    const context = await currentValidationContext({ store, workId, chapter: 1 });
    assert.equal(context.foundation.characters[0].intrinsic.gender, 'unknown', 'a flashback in another state keeps body gender scene-only');
    assert.deepEqual(context.foundation.characters[0].intrinsic.addressing.forbiddenGenderedTerms, [], 'addressing is checked per scene, not chapter-wide');
    const allowed = await check(store, proseWith(null, '어린 하인이 도련님이라 불렀다.'));
    assert.ok(allowed.checkId, JSON.stringify(allowed.violations));
    const receipt = await store.loadCheckReceipt(workId, allowed.checkId);
    assert.equal(receipt.sharedSceneCheck.check.scenes[1].projections.find(p => p.target === 'intrinsic.gender').value, 'male');
    const wrong = await check(store, proseWith('하녀가 도련님이라 불렀다.', null), providers({ sceneMap: user => sceneMapAnswer(user, [0, half + 1]) }));
    assert.equal(wrong.violations.find(v => v.code === 'SHARED_SCENE_FORBIDDEN_TERM')?.sceneId, 'now', JSON.stringify({ s: wrong.status, c: wrong.code, v: wrong.violations.map(v => v.code), sc: wrong.sceneCheck?.check?.scenes?.map(x => [x.sceneId, x.paragraphs]) }));
    assert.equal((await currentValidationContext({ store, workId, chapter: 2 })).foundation.characters[0].intrinsic.gender, 'female');
  });
  it('returns an unresolved boundary as a blocking structured result instead of a pass', async t => {
    const { store } = await setup(t, { 1: [sagaScene('s-adult', 'adulthood'), sagaScene('s-ts', 'ts')] });
    const result = await check(store, SYNTHETIC_LONG_PROSE, providers({ sceneMap: user => { const r = JSON.parse(user); return JSON.stringify({ proseHash: r.proseHash, productionLockId: r.productionLockId, unresolved: { reason: '변화 시점이 본문에 드러나지 않는다', sceneIds: ['s-ts'] } }); } }));
    const blocked = result.violations.find(v => v.code === 'SHARED_SCENE_BOUNDARY_UNRESOLVED');
    assert.deepEqual(blocked.sceneIds, ['s-ts']); assert.equal(blocked.severity, 'hard'); assert.equal(result.checkId, undefined);
    const malformed = await check(store, SYNTHETIC_LONG_PROSE, providers({ sceneMap: user => { const r = JSON.parse(user); return JSON.stringify({ proseHash: r.proseHash, productionLockId: r.productionLockId, segments: [{ sceneId: 's-ts', fromParagraph: 0, toParagraph: 1 }] }); } }));
    assert.equal(malformed.code, 'SCENE_MAP_INVALID'); assert.equal(malformed.checkId, undefined);
  });
  it('plans from the shared resolver for the planned range instead of the work-local character copy', async t => {
    const { store } = await setup(t, { 1: [sagaScene('s-adult', 'adulthood'), sagaScene('s-ts', 'ts')], 2: [sagaScene('s2', 'ts')], 3: [sagaScene('s3', 'later')] });
    const later = await planningFoundation({ store, workId, chapters: [2, 3] });
    assert.equal(later.foundation.characters[0].intrinsic.gender, 'female');
    const range = await planningFoundation({ store, workId, chapters: [1, 2, 3, 4] });
    assert.equal(range.foundation.characters[0].intrinsic.gender, 'unknown');
    assert.deepEqual(range.planning.missingChapters, [4]);
    assert.match(range.foundation.sharedLore.contextText, /No bound scene context yet for chapters 4/);
    const requests = [];
    await runArcPlan({ store, workId, episodes: 3, replaceActive: true, providers: { pending: [], async complete(req) { requests.push(req); throw Object.assign(new Error('stop'), { name: 'StopAfterRequest' }); } } }).catch(error => { if (error.name !== 'StopAfterRequest') throw error; });
    assert.match(requests[0].messages.map(m => m.content).join('\n'), /SharedLore planning view/);
  });
});
