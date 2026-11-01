import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { promptKit } from '../src/prompts/index.js';

const ko = promptKit({ language: 'ko' }).phrases.contextExplain;
const en = promptKit({ language: 'en' }).phrases.contextExplain;

const MEMBERS = [
  'fixedMaterial', 'canonGateHidden', 'summaryIncluded', 'summaryCut', 'summaryTruncated', 'summaryUnsafe',
  'outsideWindow', 'olderMemoryIncluded', 'olderMemoryContextBudget', 'olderMemoryUnsafe', 'olderMemoryNoMatch',
  'olderMemoryBudget', 'olderMemoryInFoundation', 'olderMemoryOverCap', 'olderMemoryCountsOnly',
  'previousTailIncluded', 'previousTailDropped', 'preferencesIncluded', 'preferencesDropped',
  'sectionSwitchedOff', 'andMore', 'coverageNote', 'notYetDrafted', 'detailUnavailable', 'unknownCode',
];
const SECTION_KEYS = ['older-memory', 'previous-tail', 'author-craft', 'style-anchor'];

// One representative call per member so every phrase is exercised in both kits.
const CALLS = {
  fixedMaterial: [], canonGateHidden: ['fact:w7', 12], summaryIncluded: ['3, 4, 5'], summaryCut: [4, 2000],
  summaryTruncated: [4], summaryUnsafe: [4], outsideWindow: [2], olderMemoryIncluded: [2, '`summary:1`, `summary:2`'],
  olderMemoryContextBudget: ['summary:3', 1500], olderMemoryUnsafe: ['summary:3'], olderMemoryNoMatch: ['character:hana'],
  olderMemoryBudget: ['summary:3'], olderMemoryInFoundation: ['fact:w1'], olderMemoryOverCap: ['summary:9', 8],
  olderMemoryCountsOnly: [9, 4, 5], previousTailIncluded: [], previousTailDropped: [4000], preferencesIncluded: [3],
  preferencesDropped: [800], sectionSwitchedOff: ['author-craft'], andMore: [5], coverageNote: [], notYetDrafted: [],
  detailUnavailable: [], unknownCode: ['mystery', 'summary:3'],
};

describe('contextExplain phrases', () => {
  it('exposes the same members in both kits', () => {
    for (const kit of [ko, en]) {
      for (const name of MEMBERS) assert.equal(typeof kit[name], 'function', name);
      assert.equal(typeof kit.sectionLabels, 'object');
      assert.deepEqual(Object.keys(kit.sectionLabels).sort(), [...SECTION_KEYS].sort());
    }
    assert.deepEqual(Object.keys(ko).sort(), Object.keys(en).sort());
  });

  it('returns single-line strings, Korean for ko and Hangul-free for en', () => {
    for (const name of MEMBERS) {
      const koText = ko[name](...CALLS[name]);
      const enText = en[name](...CALLS[name]);
      assert.equal(typeof koText, 'string', name);
      assert.equal(typeof enText, 'string', name);
      assert.ok(koText.length > 0 && enText.length > 0, name);
      assert.doesNotMatch(koText, /\n/, `ko ${name}`);
      assert.doesNotMatch(enText, /\n/, `en ${name}`);
      assert.match(koText, /[가-힣]/, `ko ${name}`);
      assert.doesNotMatch(enText, /[가-힣]/, `en ${name}`);
    }
    for (const key of SECTION_KEYS) {
      assert.match(ko.sectionLabels[key], /[가-힣]/, key);
      assert.doesNotMatch(en.sectionLabels[key], /[가-힣]/, key);
      assert.doesNotMatch(ko.sectionLabels[key] + en.sectionLabels[key], /\n/);
    }
  });

  it('pins the English wording', () => {
    assert.equal(en.fixedMaterial(), "World facts and every character in this chapter's cast are always in the draft input in full; they are not budget-selected.");
    assert.equal(en.canonGateHidden('fact:w7', 12), 'Setting `fact:w7` was hidden from this draft by a canon gate: it takes effect from chapter 12.');
    assert.equal(en.summaryCut(4, 2000), 'Summary of chapter 4 was cut because the continuity window hit its 2000-token budget; older entries go first.');
    assert.equal(en.olderMemoryNoMatch('character:hana'), 'Memory `character:hana` was not selected: nothing in the chapter plan matched it.');
    assert.equal(en.olderMemoryInFoundation('fact:w1'), 'Memory `fact:w1` was not repeated because it is already in the prompt in full (world facts, hooks and cast characters are sent whole).');
    assert.equal(en.previousTailDropped(4000), "The previous chapter's closing scene was dropped because the draft brief exceeded its 4000-token budget.");
    assert.equal(en.sectionSwitchedOff('author-craft'), 'The author-craft section is switched off in your settings (`disabledDraftSections`).');
    assert.equal(en.andMore(5), 'and 5 more.');
    assert.deepEqual(en.sectionLabels, { 'older-memory': 'older-memory', 'previous-tail': 'previous-tail', 'author-craft': 'author-craft', 'style-anchor': 'style-anchor' });
  });

  it('pins the Korean wording', () => {
    assert.equal(ko.fixedMaterial(), '세계관 사실과 이번 화 등장인물은 예산으로 고르지 않고 항상 전부 초고 입력에 들어갑니다.');
    assert.equal(ko.canonGateHidden('fact:w7', 12), '설정 `fact:w7`은(는) 정사 시점 게이트로 이번 초고에서 숨겼습니다. 12화부터 적용됩니다.');
    assert.equal(ko.summaryCut(4, 2000), '4화 요약은 연속성 창이 2000 토큰 예산에 닿아 뺐습니다. 오래된 항목부터 뺍니다.');
    assert.equal(ko.olderMemoryNoMatch('character:hana'), '기억 `character:hana`은(는) 선택되지 않았습니다. 이번 화 계획과 겹치는 내용이 없었습니다.');
    assert.equal(ko.olderMemoryInFoundation('fact:w1'), '기억 `fact:w1`은(는) 이미 프롬프트에 전부 들어 있어 다시 넣지 않았습니다. 세계관 사실·떡밥·등장인물은 통째로 보냅니다.');
    assert.equal(ko.previousTailDropped(4000), '직전 회차 끝 장면은 초고 요청이 4000 토큰 예산을 넘어 뺐습니다.');
    assert.equal(ko.sectionSwitchedOff('author-craft'), 'author-craft 절은 설정(`disabledDraftSections`)에서 꺼져 있습니다.');
    assert.equal(ko.andMore(5), '그 밖에 5개가 더 있습니다.');
    assert.deepEqual(ko.sectionLabels, { 'older-memory': '오래된 기억', 'previous-tail': '직전 회차 끝 장면', 'author-craft': '작법', 'style-anchor': '문체 기준' });
  });

  it('keeps the safety, rank and coverage wording honest', () => {
    for (const kit of [ko, en]) {
      // An excluded item never claims a lower rank than the others, and an unsafe one never shows its content.
      assert.doesNotMatch(kit.olderMemoryBudget('x'), /rank|순위|lower|낮/i);
    }
    assert.match(en.summaryUnsafe(4), /safety screen/);
    assert.match(en.summaryUnsafe(4), /content is not shown/);
    assert.match(en.olderMemoryUnsafe('x'), /safety screen/);
    assert.match(en.olderMemoryUnsafe('x'), /content is not shown/);
    assert.match(ko.summaryUnsafe(4), /안전 검사/);
    assert.match(ko.summaryUnsafe(4), /내용은 여기에 표시하지 않습니다/);
    assert.match(ko.olderMemoryUnsafe('x'), /내용은 여기에 표시하지 않습니다/);
    assert.match(en.coverageNote(), /not proof it was included/);
    assert.match(ko.coverageNote(), /들어갔다는 증거는 아닙니다/);
    assert.match(en.olderMemoryOverCap('x', 8), /capped at 8 items/);
    assert.match(en.olderMemoryCountsOnly(9, 4, 5), /9 candidates, 4 selected, 5 dropped for budget/);
  });
});
