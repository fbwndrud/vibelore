import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';
import { runReviseTool } from '../src/tools/generate.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';

// Frozen on the base code before any preference work: a work with no active
// preference must keep sending these exact requests and writing this exact receipt.
const EXPECTED = {
  draft: 'ef2679697ca5ee742b1ffb75b45046f104d70a6ca3841071db7cc03b57cb4e98',
  coherence: 'ee4ee92b7aac23b46d7bab865dd70d4af7d3547423739aa01f2a270955ac953c',
  revise: '3d0c0ced95b7346f6fa3badd2b53677890f0a21a03e8a1adbcedfd5db639d4e3',
  receipt: 'd35bb4459cc57d00b31f082860aa285aba2fb6759c10f9a633b20c19dec1af2a',
};

const sha = (text) => createHash('sha256').update(text).digest('hex');
const requestBytes = (req) => req.messages.map((message) => message.content).join('\n\u0000\n');
// Identity, time and hash keys differ between runs by construction; everything else must not.
// validationScope is `workflow-<random workflow id>`, so it differs per run too.
const VOLATILE = /(Id|At|id|Hash|hash|digest|Digest|epoch|validationScope)$/;
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !VOLATILE.test(key)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

test('a work without preferences keeps its draft, coherence, revise requests and receipt byte-identical', async () => {
  const store = await qualityStore();
  const requests = [];
  const providers = {
    async complete(req) {
      requests.push(req);
      if (req.step === 'revise') return { text: '{"replacements":[],"insertions":[],"castManifest":{"cast":[]}}' };
      return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' };
    },
  };
  const first = await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
  assert.equal(first.status, 'awaiting_approval', JSON.stringify(first).slice(0, 300));
  await runReviseTool({ store, workId, chapter: 1, prose: first.prose,
    violations: [{ severity: 'hard', code: 'X', chapterNumber: 1, message: '문장을 고친다.' }], providers });
  const workflow = await store.loadWorkflow(workId);
  const receipt = await store.loadCheckReceipt(workId, workflow.checkId);
  const request = (step) => {
    const found = requests.find((req) => req.step === step);
    assert.ok(found, `no ${step} request`);
    return sha(requestBytes(found));
  };
  const actual = {
    draft: request('draft'),
    coherence: request('coherence-judge'),
    revise: request('revise'),
    receipt: sha(JSON.stringify(stable(receipt))),
  };
  if (process.env.PRINT_GOLDEN) console.log(JSON.stringify(actual, null, 2));
  assert.deepEqual(actual, EXPECTED);
});
