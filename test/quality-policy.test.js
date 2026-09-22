import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { autoCommitDecision, classifyQualityViolations, dedupeQualityViolations, qualityDecision } from '../src/core/quality-policy.js';
import { runWorkflowDecide } from '../src/tools/workflow.js';

describe('quality policy and approval state', () => {
  it('keeps semantic findings advisory while blocking deterministic invariants', () => {
    const violations = [
      { severity: 'hard', code: 'METADATA_LEAK' },
      { severity: 'soft', code: 'PROFILE_OVERPERFORMANCE' },
      { severity: 'soft', code: 'WEBNOVEL_DIALOGUE_BURIED' },
      { severity: 'soft', code: 'WEBNOVEL_DENSE_PARAGRAPH' },
    ];
    assert.deepEqual(classifyQualityViolations(violations), {
      blocking: [violations[0], violations[2]],
      advisory: [violations[1], violations[3]],
    });
    assert.equal(qualityDecision({ violations }).shouldRevise, true);
  });

  it('does not auto-revise a stylistic advisory in the default pipeline', () => {
    const violations = [{ severity: 'soft', code: 'WEBNOVEL_FRAGMENTED_RHYTHM' }];
    assert.equal(qualityDecision({ violations }).shouldRevise, false);
  });

  it('requires completed review for auto publication and keeps model codes advisory', () => {
    for (const reviewStatus of [undefined, 'failed', 'pending']) {
      assert.deepEqual(autoCommitDecision({ autonomy: 'auto', reviewStatus }), { allowed: false, code: 'CRITIC_INCOMPLETE' });
    }
    assert.equal(qualityDecision({ violations: [{ severity: 'soft', advisoryOnly: true, code: 'WEBNOVEL_DIALOGUE_BURIED' }] }).shouldRevise, false);
  });

  it('blocks prose layout corruption independently of taste scores', () => {
    const violation = { severity: 'soft', code: 'WEBNOVEL_SOFT_LINEBREAKS' };
    assert.deepEqual(classifyQualityViolations([violation]), { blocking: [violation], advisory: [] });
    assert.equal(qualityDecision({ violations: [violation] }).shouldRevise, true);
  });

  it('downgrades auto commit for style-anchor drift without turning it into a rewrite', () => {
    const violations = [{ severity: 'soft', advisoryOnly: true, code: 'STYLE_ANCHOR_DRIFT' }];
    assert.equal(qualityDecision({ violations }).shouldRevise, false);
    assert.deepEqual(autoCommitDecision({ autonomy: 'auto', reviewStatus: 'completed', styleDrift: true }), {
      allowed: false, code: 'STYLE_ANCHOR_DRIFT',
    });
    assert.equal(autoCommitDecision({ autonomy: 'auto', reviewStatus: 'completed', styleDrift: false }).allowed, true);
  });

  it('deduplicates identical scanner findings without collapsing distinct evidence', () => {
    const repeated = { severity: 'soft', code: 'CAST_MANIFEST_MISMATCH', chapterNumber: 3, message: "호칭 '그' 모호" };
    const distinct = { ...repeated, message: "호칭 '그녀' 모호" };
    assert.deepEqual(dedupeQualityViolations([repeated, { ...repeated }, distinct]), [repeated, distinct]);
  });

  it('preserves the same workflow and draft when the user requests a revision', async () => {
    const workflow = {
      workflowId: 'wf-1', workId: 'work', chapter: 2, stage: 'awaiting_draft_approval',
      approvalId: 'approval-1', draftProse: '원고', castManifestRaw: '{"cast":[]}',
    };
    const events = [];
    const store = {
      async loadWorkflow() { return workflow; },
      async saveWorkflow(_workId, next) { Object.assign(workflow, next); },
      async appendWorkflowEvent(_workId, _workflowId, event) { events.push(event); },
    };
    const result = await runWorkflowDecide({
      store, workId: 'work', approvalId: 'approval-1', action: 'request_revision',
      feedback: '마지막 선택의 대가를 장면으로 보여줘.', providers: {},
    });
    assert.equal(result.status, 'revision_requested');
    assert.equal(workflow.stage, 'revision_requested');
    assert.equal(workflow.operation, 'user_revision');
    assert.equal(workflow.draftProse, '원고');
    assert.equal(events.at(-1).event, 'user_revision_requested');
  });

  it('holds an approval without consuming or replacing it', async () => {
    const workflow = {
      workflowId: 'wf-2', workId: 'work', chapter: 1, stage: 'awaiting_draft_approval',
      approvalId: 'approval-2', draftProse: '원고',
    };
    const store = {
      async loadWorkflow() { return workflow; },
      async appendWorkflowEvent() {},
    };
    const result = await runWorkflowDecide({
      store, workId: 'work', approvalId: 'approval-2', action: 'hold', providers: {},
    });
    assert.equal(result.status, 'on_hold');
    assert.equal(workflow.stage, 'awaiting_draft_approval');
    assert.equal(workflow.approvalId, 'approval-2');
  });
});
