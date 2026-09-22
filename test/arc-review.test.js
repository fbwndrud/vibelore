import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { arcReviewAdvisories, arcReviewCheckpoint, arcReviewViolations, runArcReview, runStoredArcReview } from '../src/tools/arc-review.js';
import { createPreflightRelay } from '../src/provider/host-relay.js';

function plan(total = 10) {
  return {
    arcNumber: 1, title: '첫 아크', promise: '첫 승리를 지급한다.', startChapter: 1, estimatedEpisodes: total,
    episodes: Array.from({ length: total }, (_, index) => ({ index: index + 1, chapter: index + 1 })),
    readerContract: { minimumPayoff: '승리의 실제 결과' },
  };
}

describe('arc review', () => {
  it('reviews every fifth episode and the final episode', () => {
    assert.equal(arcReviewCheckpoint(plan(12), 4), null);
    assert.equal(arcReviewCheckpoint(plan(12), 5), 'checkpoint');
    assert.equal(arcReviewCheckpoint(plan(12), 10), 'checkpoint');
    assert.equal(arcReviewCheckpoint(plan(12), 12), 'final');
  });

  it('derives its score and only gates actionable current-chapter findings', async () => {
    const dimensions = { payoffCadence: 45, patternVariety: 35, moralChoiceVariety: 40, emotionalTemperatureRange: 50, evidenceVariety: 55, endingVariety: 75, commercialMomentum: 80 };
    const review = await runArcReview({
      store: {
        async loadRecentChapterSummaries() { return [{ chapterNumber: 4, summary: '같은 선택을 했다.' }]; },
        async loadPatternLedger() { return [{ chapter: 4, moralChoice: '사람vs성과' }]; },
      },
      workId: 'work', arcPlan: plan(10), chapter: 5, prose: '현재 화', patternEntry: { chapter: 5, moralChoice: '사람vs성과' },
      providers: { async complete() { return { text: JSON.stringify({
        score: 99, dimensions,
        findings: [
          { dimension: 'payoffCadence', code: 'PAYOFF_DROUGHT', scope: 'current_chapter', message: '이번 화 지급이 없다.' },
          { dimension: 'patternVariety', code: 'PATTERN_FAMILY_REPETITION', scope: 'arc', message: '누적 반복이다.' },
        ],
      }) }; } },
    });
    assert.equal(review.score, 54);
    assert.equal(review.reportedScore, 99);
    assert.deepEqual(arcReviewViolations(review, 5).map((item) => item.code), ['PAYOFF_DROUGHT']);
  });

  it('backfills stored chapters through the same relayed MCP operation', async () => {
    let savedLedger;
    let savedReview;
    const arcPlan = plan(3);
    const store = {
      async loadArcPlan() { return arcPlan; },
      async listChapters() { return [1, 2, 3]; },
      async loadArtifact(_workId, chapter) { return { prose: `${chapter}화 본문` }; },
      async loadRecentChapterSummaries() { return []; },
      async loadPatternLedger() { return []; },
      async savePatternLedger(_workId, ledger) { savedLedger = ledger; },
      async saveArcReview(_workId, review) { savedReview = review; },
    };
    const providers = { get pending() { return []; }, async complete(request) {
      if (request.step === 'pattern-ledger') return { text: JSON.stringify({ solutionPattern: '협상', emotionalTemperature: '긴장' }) };
      return { text: JSON.stringify({
        score: 80,
        dimensions: { payoffCadence: 80, patternVariety: 80, moralChoiceVariety: 80, emotionalTemperatureRange: 80, evidenceVariety: 80, endingVariety: 80, commercialMomentum: 80 },
        findings: [],
      }) };
    } };
    const result = await runStoredArcReview({ store, workId: 'work', throughChapter: 3, providers });
    assert.equal(result.review.checkpoint, 'final');
    assert.deepEqual(savedLedger.map((entry) => entry.chapter), [1, 2, 3]);
    assert.equal(savedReview.score, 80);
  });

  it('keeps conditional relationship findings advisory and outside the arc score', async () => {
    const dimensions = { payoffCadence: 90, patternVariety: 90, moralChoiceVariety: 90, emotionalTemperatureRange: 90, evidenceVariety: 90, endingVariety: 90, commercialMomentum: 90 };
    let request;
    const review = await runArcReview({
      store: {
        async loadRecentChapterSummaries() { return [{ chapterNumber: 3, summary: '부하가 지휘관을 공격했다.' }, { chapterNumber: 4, summary: '곧바로 공동 작전을 시작했다.' }]; },
        async loadPatternLedger() { return []; },
        async loadArtifact(_workId, chapter) { return { prose: `${chapter}화 관계 표본` }; },
      },
      workId: 'work', arcPlan: plan(5), chapter: 5, prose: '5화 본문', patternEntry: { chapter: 5 },
      providers: { async complete(input) { request = input; return { text: JSON.stringify({
        score: 90, dimensions, findings: [],
        targetedReview: { applicable: true, findings: [{
          code: 'SOCIAL_CONSEQUENCE_RESET', message: '공격의 지휘 책임이 후속 관계에서 사라졌다.',
          evidence: '3화 공격 뒤 4화의 공동 작전에 책임 추궁이나 거리 변화가 없다.', confidence: 0.92,
        }] },
      }) }; } },
    });
    assert.equal(review.score, 90);
    assert.match(request.messages[1].content, /3화 관계 표본/);
    assert.deepEqual(arcReviewViolations(review, 5), []);
    assert.deepEqual(arcReviewAdvisories(review, 5).map((item) => item.code), ['SOCIAL_CONSEQUENCE_RESET']);
  });

  it('parks one pattern backfill request at a time to keep MCP payloads bounded', async () => {
    const arcPlan = plan(3);
    const relay = createPreflightRelay({});
    const result = await runStoredArcReview({
      store: {
        async loadArcPlan() { return arcPlan; },
        async listChapters() { return [1, 2, 3]; },
        async loadArtifact(_workId, chapter) { return { prose: `${chapter}화의 충분히 긴 본문` }; },
      },
      workId: 'work', throughChapter: 3, providers: relay,
    });
    assert.equal(result.preview, true);
    assert.equal(result.operation, 'arc_review_pattern_backfill');
    assert.equal(result.patternChapter, 1);
    assert.equal(relay.pending.length, 1);
    assert.equal(relay.pending[0].step, 'pattern-ledger');
  });

  it('records only grounded outcomes for planned character arcs at the final checkpoint', async () => {
    const arcPlan = {
      ...plan(3),
      characterArcs: [{ characterId: 'lua', promise: '보호받기보다 스스로 선택한다.', sourceEvidence: [{ eventId: 'lua-2', observation: '전장에 따라갔다' }] }],
    };
    const review = await runArcReview({
      store: {
        async loadRecentChapterSummaries() { return []; },
        async loadPatternLedger() { return []; },
      },
      workId: 'work', arcPlan, chapter: 3, prose: '루아는 안전한 문을 닫고 아이들이 빠져나갈 때까지 남았다.', patternEntry: { chapter: 3 },
      providers: { async complete() { return { text: JSON.stringify({
        dimensions: { payoffCadence: 80, patternVariety: 80, moralChoiceVariety: 80, emotionalTemperatureRange: 80, evidenceVariety: 80, endingVariety: 80, commercialMomentum: 80 },
        findings: [],
        characterOutcomes: [
          { characterId: 'lua', status: 'complicated', evidence: '3화에서 피난을 지휘했지만 주인공에게 계획을 숨겼다.', remainingPressure: '독립과 신뢰를 함께 지킬 수 있는가' },
          { characterId: 'unplanned', status: 'resolved', evidence: '근거 없음', remainingPressure: '' },
        ],
      }) }; } },
    });
    assert.deepEqual(review.characterOutcomes, [{
      characterId: 'lua', status: 'complicated',
      evidence: '3화에서 피난을 지휘했지만 주인공에게 계획을 숨겼다.',
      remainingPressure: '독립과 신뢰를 함께 지킬 수 있는가',
    }]);
  });
});
