import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';
import { runWriteWorkflow, runWorkflowDecide } from '../src/tools/workflow.js';

test('a revision request points lasting feedback to lore_preferences without recording it', async () => {
  const store = await qualityStore();
  const providers = { async complete(req) { return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' }; } };
  const ready = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  assert.equal(ready.status, 'awaiting_approval', JSON.stringify(ready).slice(0, 300));
  const revision = await runWorkflowDecide({ store, workId, approvalId: ready.approvalId, action: 'request_revision',
    feedback: '윤재는 앞으로도 항상 반말로 말하게 해 줘.', providers });
  assert.equal(revision.status, 'revision_requested');
  assert.match(revision.nextAction, /^lore_write를 다시 호출하면 같은 원고와 workflow에서 수정·재검사를 이어갑니다\. /);
  assert.match(revision.nextAction, /사용자에게 범위를 확인한 뒤 lore_preferences\(action="adopt"\)/);
  assert.equal(await store.loadCreativeDecisions(workId), null);
});
