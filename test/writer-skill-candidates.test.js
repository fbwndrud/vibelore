import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runWriterSkill } from '../src/tools/writer-skill.js';

function candidate(name, overrides = {}) {
  return {
    id: name, name, aestheticThesis: '판단축', coreAttention: ['a', 'b'], sceneTransformations: ['a', 'b', 'c'],
    antiFixation: ['a', 'b'], discoverySpaces: ['질문'], audition: '산문',
    authorCraft: { judgments: ['a', 'b', 'c'], omissions: [], dialogueConduct: [], selfBetrayal: ['a'] },
    storyDramaturgy: { conflictSources: ['a', 'b'], escalationLaws: [], protagonistError: '오류', oppositionAdaptation: [] },
    ...overrides,
  };
}

function harness(candidates) {
  const prompts = [];
  const store = {
    async loadFoundation() { return { title: '작품', brief: '', worldFacts: [], characters: [] }; },
    async loadStorySpine() { return { status: 'active' }; },
    async loadStoryProfile() { return { genreLabel: '장르' }; },
  };
  const providers = {
    async complete({ step, messages }) {
      if (step !== 'writer-skill') throw new Error('audition judge reached');
      prompts.push(messages[1].content);
      return { text: JSON.stringify({ candidates }) };
    },
  };
  return { store, providers, prompts };
}

describe('WriterSkill candidates', () => {
  it('states the minimum counts the validator enforces', async () => {
    const h = harness([candidate('A'), candidate('B'), candidate('C', { sceneTransformations: ['a'] })]);
    await assert.rejects(runWriterSkill({ store: h.store, workId: 'w', providers: h.providers }));
    assert.match(h.prompts[0], /sceneTransformations 3개 이상/);
    assert.match(h.prompts[0], /authorCraft\.judgments 3개 이상/);
  });

  it('names the failing candidate and rule so a retry can fix it', async () => {
    const h = harness([candidate('A'), candidate('B'), candidate('C', { sceneTransformations: ['a'] })]);
    await assert.rejects(runWriterSkill({ store: h.store, workId: 'w', providers: h.providers }), /C: 재료를 장면으로 바꾸는 기술이 최소 3개 필요하다/);
  });
});
