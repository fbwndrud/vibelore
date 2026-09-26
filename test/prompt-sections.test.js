import test from 'node:test';
import assert from 'node:assert/strict';

import { renderCharacters, renderWorldFacts, renderCurrentState } from '../src/core/prompt-sections.js';
import { promptKit } from '../src/prompts/index.js';
import { buildLanguageContract } from '../engine/src/core/language-policy.js';

const kit = promptKit({ contract: buildLanguageContract({ language: 'ko' }) });
const en = promptKit({ contract: buildLanguageContract({ language: 'en' }) });

const foundation = {
  genre: 'action',
  intrinsicChanges: [],
  worldFacts: [{ id: 'f1', statement: '빛 방패는 한계를 넘으면 깨진다.' }],
  characters: [
    { id: 'c1', canonicalName: '리아', registeredAtChapter: 1,
      intrinsic: { gender: 'female', ageBand: '20대', role: '주인공', coreAppearance: ['밤색 머리'], visualHints: { hair: 'VISUAL_HINT' }, addressing: { acceptedGenderedTerms: [] } },
      mutable: { location: 'DESIGN_TIME_LOCATION', status: 'alive', knownFacts: ['INITIAL_KNOWLEDGE'] },
      contradiction: '지키려다 숨긴다.', speechProfile: { defaultRegister: '반말', samples: { everyday: '내가 들게.' } } },
    { id: 'c2', canonicalName: '도윤', registeredAtChapter: 1, intrinsic: { gender: 'male' }, mutable: { location: 'OLD' } },
    { id: 'c4', canonicalName: '마렌', registeredAtChapter: 1, intrinsic: { gender: 'female' }, mutable: {} },
  ],
};

const state = {
  chapterNumber: 7,
  addressMap: { entries: {
    'c2->c4': { term: '마렌 씨', sinceChapter: 3, register: 'polite' },
    'c1->c9': { term: 'OFFSTAGE_TERM', sinceChapter: 1, register: 'intimate' },
  } },
  hooks: [
    { id: 'mark', text: '표식은 어디로 이어지나', plantedAtChapter: 1, phase: 'advancing' },
    { id: 'old', text: 'PAID_HOOK', plantedAtChapter: 1, phase: 'paid' },
  ],
  relationships: [
    { to: 'c4', kind: 'UNDIRECTED', state: 'x' },
    { from: 'c2', to: 'c1', kind: '신뢰', state: '직접 확인하기로 함' },
  ],
  trackedEntities: [
    { kind: 'Artifact', data: { id: 'slip', holder: 'c2', state: '구겨진 쪽지' }, updatedChapter: 6 },
    { kind: 'Artifact', data: { name: 'UNRELATED_ITEM', holder: 'c9', state: '먼 곳' }, updatedChapter: 2 },
  ],
  characterStates: {
    c1: { location: '거점 마당', status: '손목 부상 은폐', knownFacts: ['f-a', 'f-b', 'f-c', 'LATEST_FACT'], sinceChapter: 7 },
    c2: { vitalStatus: 'dead', location: '골짜기', sinceChapter: 6 },
  },
  arcCursor: { c1: { beat: 'attempt', note: 'ARC_NOTE' } },
};

test('characters render as text with ids inline, without design-time state or JSON', () => {
  const text = renderCharacters(foundation, ['c1'], 7, kit, { appearance: true });
  assert.match(text, /리아 \(`c1`\)/);
  assert.match(text, /모순: 지키려다 숨긴다/);
  assert.match(text, /외형=밤색 머리/);
  assert.doesNotMatch(text, /DESIGN_TIME_LOCATION|VISUAL_HINT|[{}]/);
  assert.doesNotMatch(renderCharacters(foundation, ['c1'], 7, kit, { appearance: false }), /밤색 머리/);
  assert.match(text, /처음부터 아는 사실: INITIAL_KNOWLEDGE/);
  assert.match(renderCharacters(foundation, ['c1'], 1, kit, { initialPlacement: true }), /시작 위치·상태: DESIGN_TIME_LOCATION/);
});

test('world facts render as a text list', () => {
  const text = renderWorldFacts(foundation, kit);
  assert.match(text, /- 빛 방패는 한계를 넘으면 깨진다/);
  assert.doesNotMatch(text, /[{}\[\]]/);
});

test('writer state keeps what bears on this chapter and drops resolved, undirected and unrelated records', () => {
  const text = renderCurrentState(state, foundation, { cast: ['c1', 'c2', 'c4'], kit, mode: 'writer' });
  assert.match(text, /리아 \(c1\).*거점 마당.*손목 부상 은폐/);
  assert.match(text, /도윤 \(c2\).*사망/);
  assert.match(text, /LATEST_FACT/);
  assert.doesNotMatch(text, /f-a/, 'only the latest known facts');
  assert.match(text, /도윤 → 마렌: "마렌 씨"/);
  assert.doesNotMatch(text, /OFFSTAGE_TERM/);
  assert.match(text, /표식은 어디로 이어지나/);
  assert.doesNotMatch(text, /PAID_HOOK/);
  assert.match(text, /도윤 → 리아: 신뢰 — 직접 확인하기로 함/);
  assert.doesNotMatch(text, /UNDIRECTED/);
  assert.match(text, /구겨진 쪽지/);
  assert.doesNotMatch(text, /UNRELATED_ITEM|ARC_NOTE|DESIGN_TIME_LOCATION|OLD/);
  assert.doesNotMatch(text, /[{}]/);
});

test('extract state lists every active hook and tracked key verbatim so records can be updated', () => {
  const text = renderCurrentState(state, foundation, { cast: ['c1'], kit, mode: 'extract' });
  assert.match(text, /`mark`/);
  assert.match(text, /1화/);
  assert.match(text, /`id:slip`/);
  assert.match(text, /`name:UNRELATED_ITEM`/);
  assert.match(text, /OFFSTAGE_TERM/, 'extraction sees the whole address map');
  assert.doesNotMatch(text, /LATEST_FACT/, 'known-fact history is not re-sent to the extractor');
});

test('multilingual family renders English labels', () => {
  const text = renderCurrentState(state, foundation, { cast: ['c1', 'c2'], kit: en, mode: 'writer' });
  assert.match(text, /dead/i);
  assert.doesNotMatch(text, /위치:|상태:|열린 떡밥|추적 항목/, 'labels are not Korean');
});
