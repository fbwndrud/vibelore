import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessChapterLength, chapterDensityViolations } from '../src/tools/chapter-density.js';

describe('chapter density', () => {
  it('warns but does not revise a long chapter without textual density evidence', () => {
    const assessment = assessChapterLength({ chars: 4700, targetChars: 3000, editorial: { dimensions: { density: 82, endingFocus: 80 }, findings: [] } });
    assert.equal(assessment.band, 'very_long');
    assert.equal(assessment.warning, true);
    assert.equal(assessment.requiresRevision, false);
    assert.deepEqual(chapterDensityViolations(assessment, 10), []);
  });

  it('revises an overlong chapter when the editor identifies a double ending', () => {
    const assessment = assessChapterLength({
      chars: 4300, targetChars: 3000,
      editorial: { dimensions: { density: 75, endingFocus: 42 }, findings: [{ dimension: 'endingFocus', code: 'DOUBLE_ENDING', message: '두 번째 결말이 첫 종료의 힘을 지운다.' }] },
    });
    assert.equal(assessment.requiresRevision, true);
    assert.deepEqual(chapterDensityViolations(assessment, 10).map((item) => item.code), ['DOUBLE_ENDING']);
  });
});
