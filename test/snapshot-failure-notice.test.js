import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { it } from 'node:test';
import { runCommit } from '../src/tools/commit.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';

const providers = { async complete(req) { return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' }; } };
async function blockSnapshots(store) {
  await rm(store.sidecar('snapshots'), { recursive: true, force: true });
  await writeFile(store.sidecar('snapshots'), 'injected snapshot directory failure');
}
function assertNotice(result, snapshot) {
  assert.equal(snapshot.created, false);
  assert.match(result.nextAction, /1화.*rollback.*없/);
  assert.ok(result.nextAction.includes(snapshot.error));
}

it('runCommit reports a missing rollback point without undoing publication', async (t) => {
  const store = await qualityStore();
  t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  const workflow = await store.loadWorkflow(workId);
  const receipt = await store.loadCheckReceipt(workId, workflow.checkId);
  await blockSnapshots(store);
  const result = await runCommit({ store, workId, chapter: 1, prose: workflow.draftProse,
    title: workflow.title, summary: workflow.summary, castManifestRaw: workflow.castManifestRaw,
    providers, delta: receipt.delta, checkId: receipt.checkId });
  assert.equal(result.committed, 1);
  assertNotice(result, result.snapshot);
  assert.ok((await store.loadCheckReceipt(workId, workflow.checkId)).consumedAt);
  assert.deepEqual(await store.listChapters(), [1]);
});

for (const which of ['both', 'final']) {
  it(`completed workflow reports ${which} snapshot failure`, async (t) => {
    const store = await qualityStore();
    t.after(() => rm(store.rootDir, { recursive: true, force: true }));
    if (which === 'both') await blockSnapshots(store);
    else {
      const save = store.saveExperienceLedger.bind(store);
      store.saveExperienceLedger = async (...args) => {
        await save(...args);
        await blockSnapshots(store);
      };
    }
    const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers });
    assert.equal(result.status, 'completed');
    assertNotice(result, result.commit.snapshot);
    assertNotice(result.commit, result.commit.snapshot);
    assert.equal((await store.loadWorkflow(workId)).stage, 'completed');
    assert.deepEqual(await store.listChapters(), [1]);
  });
}
