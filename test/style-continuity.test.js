import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildStyleAnchor,
  evaluateChapterStyle,
  evaluateRevisionPreservation,
  renderStyleAnchor,
} from '../src/core/style-continuity.js';
import { chooseBestRevision } from '../src/tools/revision-selection.js';
import { runStyleAnchor } from '../src/tools/style-anchor.js';

const paragraphs = (count, separator = '\n\n') => Array.from(
  { length: count },
  (_, index) => `카르온은 ${index + 1}번째 충격을 확인하고 루아가 있는 시장을 돌아봤다.`,
).join(separator);

describe('work-level style continuity', () => {
  it('builds a bounded immutable anchor from explicitly selected canonical chapters', async () => {
    const artifacts = new Map([
      [1, { chapterNumber: 1, prose: paragraphs(30) }],
      [3, { chapterNumber: 3, prose: paragraphs(28) }],
      [7, { chapterNumber: 7, prose: paragraphs(32) }],
    ]);
    const store = {
      async loadArtifact(_workId, chapter) { return artifacts.get(chapter) ?? null; },
      async loadStyleAnchor() { return null; },
      async saveStyleAnchor(_workId, anchor) { this.saved = anchor; },
    };
    const result = await runStyleAnchor({ store, workId: 'novel', action: 'approve', chapters: [1, 3, 7], reason: '관찰이 능청스럽고 상실 장면은 조용하다.' });
    assert.equal(result.status, 'active');
    assert.deepEqual(result.anchor.sourceChapters, [1, 3, 7]);
    assert.equal(result.anchor.excerpts.length, 3);
    assert.ok(result.anchor.excerpts.every((item) => item.text.length <= 700));
    assert.equal(store.saved.revision, 1);
    assert.match(renderStyleAnchor(result.anchor), /관찰이 능청스럽고 상실 장면은 조용하다/);
    assert.doesNotMatch(renderStyleAnchor(result.anchor), /createdAt|fingerprint/);
  });

  it('detects the chapter-8 failure where blank paragraph boundaries become soft line breaks', () => {
    const source = paragraphs(25, '\n\n');
    const revised = paragraphs(25, '\n');
    const audit = evaluateRevisionPreservation({ sourceProse: source, candidateProse: revised, violations: [{ code: 'QUALITY_GATE_LENGTH' }] });
    assert.equal(audit.passed, false);
    assert.ok(audit.violations.some((item) => item.code === 'REVISION_LAYOUT_DRIFT'));
    assert.ok(audit.metrics.softLineBreakDelta >= 20);
  });

  it('allows a localized paragraph correction without treating it as a new voice', () => {
    const source = paragraphs(20);
    const revised = source.replace('10번째 충격', '열 번째 충격');
    const audit = evaluateRevisionPreservation({ sourceProse: source, candidateProse: revised, violations: [{ code: 'INTRINSIC_VIOLATION' }] });
    assert.equal(audit.passed, true);
    assert.ok(audit.metrics.unchangedParagraphRatio >= 0.9);
  });

  it('reports a fresh chapter that strongly departs from an approved anchor without auto-rewrite instructions', () => {
    const anchor = buildStyleAnchor({
      workId: 'novel',
      chapters: [
        { chapterNumber: 1, prose: paragraphs(30) },
        { chapterNumber: 2, prose: paragraphs(30) },
      ],
    });
    const dense = Array.from({ length: 30 }, (_, index) => `그는 ${index + 1}번째 결과를 계산했다.`).join(' ');
    const report = evaluateChapterStyle({ prose: dense, anchor, chapterNumber: 8 });
    assert.equal(report.drifted, true);
    assert.equal(report.advisories[0].code, 'STYLE_ANCHOR_DRIFT');
    assert.equal(report.advisories[0].advisoryOnly, true);
  });

  it('prefers a style-preserving candidate before a marginally higher score', () => {
    const preserved = { attempt: 1, gatePassed: true, preservationPassed: true, hard: 0, lengthValid: true, score: 92.1 };
    const drifted = { attempt: 2, gatePassed: true, preservationPassed: false, hard: 0, lengthValid: true, score: 92.5 };
    assert.equal(chooseBestRevision([drifted, preserved]), preserved);
  });
});
