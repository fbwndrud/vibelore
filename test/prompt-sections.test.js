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
    { id: 'c1', canonicalName: '리아', aliases: ['꼬마 길잡이'], registeredAtChapter: 1,
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
  ledger: { records: [
    { id: 'o1', feature: 'objects', label: 'Artifact', name: '구겨진 쪽지', aliases: [], status: 'active', fields: { holder: 'c2' }, lastEventAt: 6, recent: [{ chapter: 6, event: 'changed' }] },
    { id: 'o2', feature: 'objects', label: 'Artifact', name: 'UNRELATED_ITEM', aliases: [], status: 'active', fields: { holder: 'c9', state: '먼 곳' }, lastEventAt: 2, recent: [] },
  ] },
  characterStates: {
    c1: { location: '거점 마당', status: '손목 부상 은폐', knownFacts: ['f-a', 'f-b', 'f-c', 'LATEST_FACT'], sinceChapter: 7 },
    c2: { vitalStatus: 'dead', location: '골짜기', sinceChapter: 6 },
  },
  arcCursor: { c1: { beat: 'attempt', note: 'ARC_NOTE' } },
};

test('characters render as text with ids inline, without design-time state or JSON', () => {
  const text = renderCharacters(foundation, ['c1'], 7, kit, { appearance: true });
  assert.match(text, /리아 \(`c1`\)/);
  assert.match(text, /별칭: 꼬마 길잡이/, 'aliases let a reviewer attribute a nickname to the character');
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
  const text = renderCurrentState(state, foundation, { cast: ['c1', 'c2', 'c4'], kit, mode: 'writer', focusText: '표식을 따라 간다' });
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

test('extract state lists the hooks, items and address terms the prose touches with their exact keys, and counts the rest', () => {
  const prose = '도윤은 구겨진 쪽지를 폈다. 표식은 어디로 이어지나. 리아가 "마렌 씨" 하고 불렀다.';
  const text = renderCurrentState(state, foundation, { cast: ['c1'], kit, mode: 'extract', focusText: prose });
  assert.match(text, /`mark`/);
  assert.match(text, /1화/);
  assert.match(text, /`o1` \[Artifact\] 구겨진 쪽지/, 'the item the prose names keeps its id');
  assert.match(text, /`c2->c4`/, 'address terms between named characters');
  assert.doesNotMatch(text, /UNRELATED_ITEM|OFFSTAGE_TERM/);
  assert.match(text, /관련 없는 1건은 생략/);
  assert.doesNotMatch(text, /LATEST_FACT/, 'known-fact history is not re-sent to the extractor');
});

test('extract state shows the status of a hook that has no legacy phase', () => {
  const current = { ...state, hooks: [{ id: 'mark', text: '표식은 어디로 이어지나', plantedAtChapter: 1, status: 'open', recent: [] }] };
  const text = renderCurrentState(current, foundation, { cast: ['c1'], kit, mode: 'extract', focusText: '표식은 어디로 이어지나.' });
  assert.match(text, /`mark` · open · 1화/);
});

test('multilingual family renders English labels', () => {
  const text = renderCurrentState(state, foundation, { cast: ['c1', 'c2'], kit: en, mode: 'writer' });
  assert.match(text, /dead/i);
  assert.doesNotMatch(text, /위치:|상태:|열린 떡밥|추적 항목/, 'labels are not Korean');
});

test('check sections keep tracked-item changes so ownership invariants can be judged', async () => {
  const { renderCheckSections } = await import('../src/core/prompt-sections.js');
  const sections = renderCheckSections({ foundation: { ...foundation, genreProfile: { invariants: [{ id: 'OWN', severity: 'soft', description: '소유자 이동은 사건 필요' }] } },
    prevState: state, kit,
    delta: { appearedCharacterIds: ['c1'], newAddressEntries: [], mutableChanges: [], trackedEntityOps: [{ kind: 'Artifact', data: { id: 'slip', holder: 'c1' } }] } });
  assert.match(sections.delta, /\[delta\.trackedEntityOps\[0\]\] \[Artifact\] id: slip; holder: 리아/);
  assert.match(sections.invariants, /OWN: 소유자 이동은 사건 필요/);
  assert.doesNotMatch(sections.foundation, /DESIGN_TIME_LOCATION/);
});

test('extract render lists records by id with aliases and a duplicate marker', () => {
  const state = { chapterNumber: 7, addressMap: { entries: {} }, relationships: [], hooks: [
    { id: 'h1', text: '누가 사슬을 박았나', status: 'open', plantedAtChapter: 2, lastMovedChapter: 6 },
    { id: 'h9', text: '다른 이야기', status: 'open', plantedAtChapter: 1, lastMovedChapter: 1 },
  ], ledger: { records: [
    { id: 'o1', feature: 'objects', label: '물건', name: '서명 쪽지', aliases: [{ text: '그 쪽지' }], status: 'active', fields: { holder: 'c2' }, lastEventAt: 5, recent: [{ chapter: 5, event: 'changed', note: '재서명' }] },
    { id: 'o3', feature: 'objects', label: '물건', name: '재서명된 쪽지', aliases: [], status: 'active', fields: {}, lastEventAt: 6, possibleDuplicateOf: 'o1', recent: [] },
  ] } };
  const text = renderCurrentState(state, foundation, { kit, mode: 'extract', focusText: '리아는 그 쪽지를 펼쳤다.' });
  assert.match(text, /`o1` \[물건\] 서명 쪽지 \(별칭: 그 쪽지\) · active/);
  assert.match(text, /`o3`.*\n  \(중복 후보: o1\)/);
  assert.match(text, /`h1`/); // moved in chapter 6: recent
  assert.doesNotMatch(text, /`h9`/);
});

test('writer render adds a short history for a record back after a long gap', () => {
  const state = { chapterNumber: 40, addressMap: { entries: {} }, relationships: [], hooks: [], ledger: { records: [
    { id: 'o1', feature: 'objects', label: '물건', name: '서명 쪽지', aliases: [], status: 'active', fields: {}, lastEventAt: 7, recent: [] },
  ] } };
  const history = [{ chapter: 4, target: 'record', id: 'o1', event: 'registered' }, { chapter: 5, target: 'record', id: 'o1', event: 'changed', note: '재서명' }];
  const text = renderCurrentState(state, foundation, { kit, mode: 'writer', focusText: '서명 쪽지를 다시 꺼낸다', history });
  assert.match(text, /이력: 4화 registered, 5화 changed 재서명/);
});

test('pinned author items are always listed', () => {
  const state = { chapterNumber: 9, addressMap: { entries: {} }, relationships: [], hooks: [], ledger: { records: [
    { id: 'u1', feature: 'objects', label: '', name: '금화', aliases: [], status: 'active', fields: { amount: '10닢' }, lastEventAt: 1, recent: [] },
  ] } };
  const config = { customTracking: [{ id: 'u1', name: '금화', feature: 'objects', pinned: true }] };
  assert.match(renderCurrentState(state, foundation, { kit, mode: 'writer', focusText: '아무 관련 없는 문장', config }), /금화/);
});

test('planner render adds long-dormant hooks and pending scheduled events; the writer lists only open hooks', () => {
  const state = { chapterNumber: 30, addressMap: { entries: {} }, relationships: [], hooks: [
    { id: 'd1', text: 'DORMANT_OLD', status: 'dormant', plantedAtChapter: 2, lastMovedChapter: 12 },
    { id: 'd2', text: 'DORMANT_FRESH', status: 'dormant', plantedAtChapter: 2, lastMovedChapter: 25 },
    { id: 'p1', text: 'PAID_ONE', status: 'paid', plantedAtChapter: 2, lastMovedChapter: 29 },
  ], ledger: { records: [
    { id: 's1', feature: 'scheduled', label: '예정', name: '왕성 공성전', aliases: [], status: 'pending', fields: {}, lastEventAt: 3, recent: [] },
    { id: 's2', feature: 'scheduled', label: '예정', name: 'DONE_EVENT', aliases: [], status: 'happened', fields: {}, lastEventAt: 29, recent: [] },
  ] } };
  const planner = renderCurrentState(state, foundation, { kit, mode: 'planner', focusText: '' });
  assert.match(planner, /잠복한 떡밥 \(다시 꺼낼 수 있음\):\n- DORMANT_OLD/);
  assert.doesNotMatch(planner, /DORMANT_FRESH|PAID_ONE/);
  assert.match(planner, /아직 일어나지 않은 예정 사건:\n- \[예정\] 왕성 공성전 · pending/);
  assert.doesNotMatch(planner, /DONE_EVENT/);
  const writer = renderCurrentState(state, foundation, { kit, mode: 'writer', focusText: '' });
  assert.doesNotMatch(writer, /DORMANT_OLD|잠복한 떡밥|PAID_ONE/);
});

test('check sections name speaker-only aliases of the characters on the page', async () => {
  const { renderCheckSections } = await import('../src/core/prompt-sections.js');
  const prevState = { chapterNumber: 7, addressMap: { entries: {} }, hooks: [], relationships: [], ledger: { records: [
    { id: 'o1', feature: 'objects', label: '물건', name: '서명 쪽지', aliases: [{ text: '그 종이', by: 'c1' }, { text: '쪽지' }], status: 'active', fields: {}, lastEventAt: 5, recent: [] },
    { id: 'u1', feature: 'objects', label: '', name: '금화', aliases: [], status: 'active', fields: {}, lastEventAt: 1, recent: [] },
    { id: 'o2', feature: 'objects', label: '물건', name: '검', aliases: [{ text: 'OFFSTAGE_ALIAS', by: 'c4' }], status: 'active', fields: {}, lastEventAt: 5, recent: [] },
  ] } };
  const config = { customTracking: [{ id: 'u1', name: '금화', feature: 'objects', rules: [{ type: 'speakerOnly', alias: '반짝이', by: 'c2' }] }] };
  const sections = renderCheckSections({ foundation, prevState, kit, config, focusText: '리아와 도윤이 말했다.',
    delta: { appearedCharacterIds: ['c1', 'c2'], newAddressEntries: [], mutableChanges: [], trackedEntityOps: [] } });
  assert.match(sections.prev, /- "그 종이"는 리아만 쓰는 서명 쪽지의 별칭/);
  assert.match(sections.prev, /- "반짝이"는 도윤만 쓰는 금화의 별칭/);
  assert.doesNotMatch(sections.prev, /OFFSTAGE_ALIAS|"쪽지"/);
});
