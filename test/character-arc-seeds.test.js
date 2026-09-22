import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileCharacterArcSeeds, renderCharacterArcSeeds } from '../src/core/character-arc-seeds.js';
import { deterministicArcViolations } from '../src/tools/arc-quality.js';

const foundation = { characters: [
  { id: 'lua', canonicalName: '루아', contradiction: '버려질까 두려워 위험을 따라간다.' },
  { id: 'sera', canonicalName: '세라', contradiction: '명령을 원하지만 책임은 두렵다.' },
] };

function projection() {
  return {
    characterStates: {
      lua: {
        nextChoiceBias: '보호받기보다 먼저 위험을 고른다',
        influences: [
          { eventId: 'lua-2', anchor: 'p3:l2', storyTime: 2, interpretation: '혼자 남겨질까 봐 전장에 따라갔다' },
          { eventId: 'lua-7', anchor: 'p8:l4', storyTime: 7, interpretation: '명령을 기다리지 않고 아이를 숨겼다', behavioralProof: { status: 'tested', hypothesis: '스스로 보호할 대상을 고른다' } },
        ],
      },
      sera: { nextChoiceBias: null, influences: [] },
    },
    agendas: { lua: { goal: '가족으로 인정받는다', nextAction: '주인공 몰래 피난로를 확인한다' } },
    relationshipStates: {
      'lua->hero': { from: 'lua', to: 'hero', claims: [{ storyTime: 7, belief: '아버지가 돌아오지만 항상 곁에 있지는 않는다' }] },
    },
  };
}

describe('CharacterArcSeed compiler', () => {
  it('turns accepted fragments into bounded planning evidence without activating every character', () => {
    const seeds = compileCharacterArcSeeds({ foundation, projection: projection() });
    assert.equal(seeds.length, 1);
    assert.equal(seeds[0].characterId, 'lua');
    assert.equal(seeds[0].status, 'latent');
    assert.deepEqual(seeds[0].evidence.map((item) => item.eventId), ['lua-2', 'lua-7']);
    assert.match(renderCharacterArcSeeds(seeds), /7화\/p8:l4.*명령을 기다리지 않고 아이를 숨겼다.*lua-7/);
  });

  it('carries a final arc outcome forward and does not reopen a resolved pressure by fallback', () => {
    const previousArcPlan = {
      status: 'completed', characterArcs: [{
        characterId: 'lua', promise: '보호받는 아이에서 선택하는 사람으로 움직인다.',
        beats: [{ episodeIndex: 1, beat: 'wound' }, { episodeIndex: 5, beat: 'self-choice' }],
      }],
    };
    const resolved = compileCharacterArcSeeds({
      foundation, projection: projection(), previousArcPlan,
      previousArcReview: { characterOutcomes: [{ characterId: 'lua', status: 'resolved', evidence: '5화에서 퇴로를 포기하고 아이들을 먼저 피신시켰다.', remainingPressure: '' }] },
    });
    assert.equal(resolved[0].status, 'resolved');
    assert.equal(resolved[0].unresolvedPressure, '');
    assert.match(resolved[0].previousArc.outcomeEvidence, /아이들을 먼저 피신/);

    const complicated = compileCharacterArcSeeds({
      foundation, projection: projection(), previousArcPlan,
      previousArcReview: { characterOutcomes: [{ characterId: 'lua', status: 'complicated', evidence: '선택했지만 동료를 속였다.', remainingPressure: '독립과 신뢰를 함께 지킬 수 있는가' }] },
    });
    assert.equal(complicated[0].unresolvedPressure, '독립과 신뢰를 함께 지킬 수 있는가');
  });

  it('allows a grounded character beat to continue across episode arcs without restarting at wound', () => {
    const violations = deterministicArcViolations({
      episodes: [],
      characterArcs: [{
        characterId: 'lua',
        inheritedState: { status: 'complicated', previousBeat: 'wound' },
        sourceEvidence: [{ eventId: 'lua-2', observation: '전장에 따라갔다' }],
        beats: [{ episodeIndex: 2, beat: 'attempt', note: '혼자 피난로를 확인한다.' }],
      }],
    });
    assert.deepEqual(violations, []);
    assert.equal(deterministicArcViolations({
      episodes: [],
      characterArcs: [{ characterId: 'lua', beats: [{ episodeIndex: 2, beat: 'attempt' }] }],
    })[0].code, 'CHARACTER_ARC_START_INVALID');
  });
});
