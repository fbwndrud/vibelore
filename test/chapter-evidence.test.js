import assert from 'node:assert/strict';
import { it } from 'node:test';
import { rm } from 'node:fs/promises';
import { qualityStore, workId, outputs } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';
import { SYNTHETIC_LONG_PROSE } from './fixtures/synthetic-prose.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';
import { createPublicationUnit } from '../src/core/publication-unit.js';

it('commits inferred interpretations with exact evidence without manufacturing world truth or reader knowledge', async t => {
  const store = await qualityStore(); t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  const anchor = SYNTHETIC_LONG_PROSE.split('\n\n')[0];
  const influence = { characterId: 'hero', anchor, interpretation: '윤재는 자신이 겁쟁이라고 해석했다.', dimensionChanges: {}, nextChoiceBias: '다음에는 먼저 확인한다.',
    relationshipClaims: [{ from: 'hero', to: 'hero', dimensions: {}, belief: '자신의 판단을 믿지 못한다.' }] };
  const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: { async complete(request) {
    const response = contractResponse(request);
    if (request.step === 'continuity-extract' && response) {
      const payload = JSON.parse(response.text); payload.influenceEvents = [influence]; payload.noInfluenceReason = '';
      payload.ledgerOps = [
        { op: 'register', id: 'city', feature: 'objects', label: '지명', name: '백야', fields: { region: '북부' } },
        { op: 'register', id: 'sword', feature: 'objects', label: '검', name: '백야', fields: { holder: 'hero' } },
      ];
      return { text: JSON.stringify(payload) };
    }
    return response ?? { text: outputs[request.step] ?? '{}' };
  } } });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const tree = (await createPublicationUnit({ rootDir: store.rootDir }).readPublished()).value.tree;
  const observation = tree.observations[1];
  assert.deepEqual(observation.epistemic.truthAssertions, []);
  assert.deepEqual(observation.epistemic.readerAssertions, []);
  assert.deepEqual(observation.epistemic.believers, []);
  assert.equal(observation.status, 'accepted');
  assert.equal(observation.evidenceLedger.schemaVersion, 1);
  assert.deepEqual(observation.evidenceLedger.evidence[0].span, { from: 0, to: anchor.length });
  assert.equal(observation.evidenceLedger.evidence[0].quote, anchor);
  assert.equal(observation.evidenceLedger.evidence[0].sourceHash, observation.sourceHash);
  assert.equal(observation.evidenceLedger.claims[0].basis, 'model-inferred');
  assert.equal(observation.evidenceLedger.claims[0].canonStatus, 'proposed');
  assert.deepEqual(observation.influenceEvents[0].relationshipClaims, influence.relationshipClaims);
  assert.equal(tree.chapters[1].delta.ledgerIdentityVersion, 2);
  assert.deepEqual(tree.chapters[1].delta.ledgerOps.map(op => op.id), ['city', 'sword']);
});

it('does not claim an exact source location for missing or repeated extraction anchors', async () => {
  const { buildChapterObservation } = await import('../src/core/chapter-observation.js');
  const context = { transactionTime: '2026-10-17T00:00:00Z', policyRevision: 'test' };
  for (const [prose, anchor, expected] of [['문을 열었다. 문을 열었다.', '문을 열었다.', 'ambiguous_anchor'], ['문을 열었다.', '없는 문장', 'anchor_not_found']]) {
    const result = buildChapterObservation({ chapter: 1, prose, executionContext: context,
      delta: { influenceEvents: [{ characterId: 'hero', anchor, interpretation: '낙관적이었다.', relationshipClaims: [] }] } });
    assert.equal(result.evidenceLedger.evidence[0].span, null);
    assert.equal(result.evidenceLedger.evidence[0].basis, 'model-inferred');
    assert.ok(result.evidenceLedger.evidence[0].limitations.includes(expected));
  }
});

it('does not label half of a UTF-16 surrogate pair as explicit quoted evidence', async () => {
  const { buildChapterObservation } = await import('../src/core/chapter-observation.js');
  const result = buildChapterObservation({ chapter: 1, prose: '😀', executionContext: { transactionTime: 'now', policyRevision: 'test' },
    delta: { influenceEvents: [{ characterId: 'hero', anchor: '\ud83d', interpretation: '추론', relationshipClaims: [] }] } });
  assert.equal(result.evidenceLedger.evidence[0].span, null);
  assert.equal(result.evidenceLedger.evidence[0].basis, 'model-inferred');
  assert.ok(result.evidenceLedger.evidence[0].limitations.includes('invalid_anchor_boundary'));
});
