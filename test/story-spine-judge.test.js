import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runStorySpine } from '../src/tools/story-spine.js';

const SPINE = {
  dramaticQuestion: '질문', protagonistWant: '욕망', protagonistNeed: '필요', falseBelief: '믿음',
  incitingDisruption: '사건', initialStrategy: '해법', midpointReframe: '재해석', finalChoice: '선택',
  endingChange: '변화', endingCost: '비용', causalChain: ['1', '2', '3', '4', '5'],
  characterForces: [
    { characterId: 'c1', want: '살아남기', actionThatChangesPlot: '처형을 멈춘다' },
    { characterId: 'c2', want: '진상', actionThatChangesPlot: '칼을 멈춘다' },
  ],
};

function harness(dimensions) {
  const saved = [];
  const judgeMessages = [];
  const store = {
    async loadFoundation() { return { title: '작품', characters: [] }; },
    async loadStoryProfile() { return { status: 'active' }; },
    async saveStorySpine(_, spine) { saved.push(spine); },
  };
  const providers = {
    async complete({ step, messages }) {
      if (step === 'story-spine') return { text: JSON.stringify(SPINE) };
      judgeMessages.push(messages);
      return { text: JSON.stringify({ dimensions, findings: [] }) };
    },
  };
  return { store, providers, saved, judgeMessages };
}

const dims = (value) => ({ causalNecessity: value, protagonistError: value, expectationReframe: value, characterAgency: value, finalChoiceCost: value, endingTransformation: value });

describe('StorySpine quality judge', () => {
  it('states the 0~100 scale the verdict thresholds assume', async () => {
    const h = harness(dims(88));
    const result = await runStorySpine({ store: h.store, workId: 'w', providers: h.providers });
    assert.equal(result.spine.quality.verdict, 'passed');
    assert.match(h.judgeMessages[0].map((message) => message.content).join('\n'), /0~100/);
  });

  it('rejects a 1~5 scale answer as a scale error instead of a quality failure', async () => {
    const h = harness(dims(4));
    await assert.rejects(runStorySpine({ store: h.store, workId: 'w', providers: h.providers }), /0~100 척도가 아닙니다/);
    assert.equal(h.saved.length, 0);
  });
});
