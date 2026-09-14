import assert from 'node:assert/strict';
import { test } from 'node:test';
import { characterArcBeatCollisions } from '../src/tools/arc-quality.js';

// 2026-09-14 en 표본: 같은 회차에 비트 둘 → 정규화 뒤 단계 건너뛰기처럼 보였다.
test('names the episode that carries more than one emotion beat', () => {
  const raw = [{ characterId: 'c1', beats: [
    { episodeIndex: 1, beat: 'wound' }, { episodeIndex: 2, beat: 'attempt' }, { episodeIndex: 2, beat: 'collapse' },
    { episodeIndex: 3, beat: 'companion' }, { episodeIndex: 3, beat: 'self-choice' }, { episodeIndex: 9, beat: 'echo' },
  ] }, { characterId: 'c2', beats: [{ episodeIndex: 1, beat: 'wound' }, { episodeIndex: 3, beat: 'attempt' }] }];
  const out = characterArcBeatCollisions(raw, 3);
  assert.deepEqual(out.map(v => v.code), ['CHARACTER_ARC_MULTIPLE_BEATS_PER_EPISODE', 'CHARACTER_ARC_MULTIPLE_BEATS_PER_EPISODE']);
  assert.match(out[0].message, /^c1의 2화에 감정 비트가 2개다/);
  assert.match(out[1].message, /^c1의 3화에/);
  assert.deepEqual(characterArcBeatCollisions([{ characterId: 'c1', beats: [{ episodeIndex: 1, beat: 'wound' }] }], 3), []);
  assert.deepEqual(characterArcBeatCollisions(undefined, 3), []);
});
