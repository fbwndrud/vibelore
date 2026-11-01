import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { promptKit } from '../src/prompts/index.js';
import { writerOlderMemory } from '../src/tools/generate.js';
import { explainDraftContext, LAYER_SENTENCE_CAP, OLDER_MEMORY_CAP, safeId } from '../src/core/context-explain.js';

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
    assert.equal(en.olderMemoryInFoundation('fact:w1'), 'Memory `fact:w1` is not repeated in older memory: world facts and cast characters are sent in full in their own sections, and only open hooks appear in the current state.');
    assert.equal(en.previousTailDropped(4000), "The previous chapter's closing scene was dropped because the draft brief exceeded its 4000-token budget.");
    assert.equal(en.sectionSwitchedOff('author-craft'), 'The author-craft section is switched off in your settings (`disabledDraftSections`).');
    assert.equal(en.andMore(5), 'and 5 more.');
    assert.equal(en.summaryIncluded('3, 4, 5', 3), 'Summaries of chapters 3, 4, 5 are in the continuity window.');
    assert.equal(en.summaryIncluded('6', 1), 'Summary of chapter 6 is in the continuity window.');
    assert.equal(en.olderMemoryIncluded(2, '`summary:1`, `summary:2`'), '2 older memory items are in the draft input: `summary:1`, `summary:2`');
    assert.equal(en.olderMemoryIncluded(1, '`summary:1`'), '1 older memory item is in the draft input: `summary:1`');
    assert.equal(en.outsideWindow(2), '2 earlier chapter summaries are outside the continuity window; they only return through memory retrieval.');
    assert.equal(en.outsideWindow(1), '1 earlier chapter summary is outside the continuity window; it only returns through memory retrieval.');
    assert.equal(en.preferencesIncluded(3), '3 creative preferences you adopted are in the draft input.');
    assert.equal(en.preferencesIncluded(1), '1 creative preference you adopted is in the draft input.');
    assert.equal(en.olderMemoryCountsOnly(1, 1, 0), 'This draft was recorded before per-item reasons existed; only counts are known: 1 candidate, 1 selected, 0 dropped for budget.');
    assert.deepEqual(en.sectionLabels, { 'older-memory': 'older-memory', 'previous-tail': 'previous-tail', 'author-craft': 'author-craft', 'style-anchor': 'style-anchor' });
  });

  it('pins the Korean wording', () => {
    assert.equal(ko.fixedMaterial(), '세계관 사실과 이번 화 등장인물은 예산으로 고르지 않고 항상 전부 초고 입력에 들어갑니다.');
    assert.equal(ko.canonGateHidden('fact:w7', 12), '설정 `fact:w7`은(는) 정사 시점 게이트로 이번 초고에서 숨겼습니다. 12화부터 적용됩니다.');
    assert.equal(ko.summaryCut(4, 2000), '4화 요약은 연속성 창이 2000 토큰 예산에 닿아 뺐습니다. 오래된 항목부터 뺍니다.');
    assert.equal(ko.olderMemoryNoMatch('character:hana'), '기억 `character:hana`은(는) 선택되지 않았습니다. 이번 화 계획과 겹치는 내용이 없었습니다.');
    assert.equal(ko.olderMemoryInFoundation('fact:w1'), '기억 `fact:w1`은(는) 오래된 기억에 다시 넣지 않았습니다. 세계관 사실과 등장인물은 각자의 절에 전부 들어가고, 떡밥은 열린 것만 현재 상태에 나옵니다.');
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
    assert.doesNotMatch(en.olderMemoryInFoundation('x'), /already in the prompt/);
  });
});

const koKit = promptKit({ language: 'ko' });
const enKit = promptKit({ language: 'en' });

/** A complete new-format audit; `over` replaces top-level keys. */
function audit(over = {}) {
  return {
    recentSummaryChapters: [7, 6, 5],
    olderMemoryRefs: ['summary:1'],
    previousSceneChars: 120,
    disabledDraftSections: [],
    creativePreferenceIds: [],
    draftInputTrace: {
      continuity: { recentSummaryChapters: [7, 6, 5], olderMemoryRefs: ['summary:1'], excluded: [] },
      sections: { previousTail: { originalTokens: 30, includedTokens: 30, truncated: false, reason: null } },
    },
    draftInputUsage: { maxPlanTokens: 4000, maxContextTokens: 2000 },
    memory: {
      trimmedSummaries: 0, droppedForBudget: 0, retrieval: { documents: 9, candidates: 4, selected: 1 },
      excluded: [], excludedTotal: 0, filtered: [], filteredTotal: 0,
    },
    ...over,
  };
}

const withMemory = (memory, over = {}) => audit({ ...over, memory: { ...audit().memory, ...memory } });
const withTrace = (trace, over = {}) => audit({ ...over, draftInputTrace: { ...audit().draftInputTrace, ...trace } });
const excludedBy = (list) => withMemory({ excluded: list, excludedTotal: list.length });
const byCode = (result, code) => result.items.filter((item) => item.code === code);
const LAYER_ORDER = ['fixed', 'canonGates', 'recentSummaries', 'olderMemory', 'previousTail', 'preferences', 'sections', 'coverage'];

describe('explainDraftContext reason codes', () => {
  const cases = [
    ['context-token-budget', withTrace({ continuity: { recentSummaryChapters: [7], olderMemoryRefs: [], excluded: [{ kind: 'recentSummary', chapter: 4, reason: 'context-token-budget' }] } }),
      (k) => k.summaryCut(4, 2000)],
    ['truncated', withTrace({ continuity: { recentSummaryChapters: [7], olderMemoryRefs: [], excluded: [{ kind: 'recentSummary', chapter: 4, reason: 'truncated' }] } }),
      (k) => k.summaryTruncated(4)],
    ['unsafe-content', withTrace({ continuity: { recentSummaryChapters: [7], olderMemoryRefs: [], excluded: [{ kind: 'recentSummary', chapter: 4, reason: 'unsafe-content' }] } }),
      (k) => k.summaryUnsafe(4)],
    ['no-query-match', excludedBy([{ id: 'character:hana', reason: 'no-query-match' }]), (k) => k.olderMemoryNoMatch('character:hana')],
    ['budget', excludedBy([{ id: 'summary:3', reason: 'budget' }]), (k) => k.olderMemoryBudget('summary:3')],
    ['in-foundation', withMemory({ filtered: [{ id: 'fact:w1', reason: 'in-foundation' }], filteredTotal: 1 }), (k) => k.olderMemoryInFoundation('fact:w1')],
    ['over-cap', withMemory({ filtered: [{ id: 'summary:9', reason: 'over-cap' }], filteredTotal: 1 }), (k) => k.olderMemoryOverCap('summary:9', 8)],
    ['plan-token-budget', withTrace({ sections: { previousTail: { originalTokens: 30, includedTokens: 0, truncated: true, reason: 'plan-token-budget' } } }), (k) => k.previousTailDropped(4000)],
    ['plan-token-budget', withTrace({ sections: { previousTail: { originalTokens: 0, includedTokens: 0, truncated: false, reason: null }, creativePreferences: { originalTokens: 50, includedTokens: 0, includedIds: [], truncated: true, reason: 'plan-token-budget' } } }), (k) => k.preferencesDropped(4000)],
    ['disabled-by-user', audit({ disabledDraftSections: ['author-craft'] }), (k) => k.sectionSwitchedOff(k.sectionLabels['author-craft'])],
    ['outside-window', withMemory({ trimmedSummaries: 2 }), (k) => k.outsideWindow(2)],
  ];
  for (const [code, input, expected] of cases) {
    it(`explains ${code} in both kits`, () => {
      for (const kit of [koKit, enKit]) {
        const result = explainDraftContext({ contextAudit: input, kit });
        assert.ok(byCode(result, code).some((item) => item.text === expected(kit.phrases.contextExplain)), `${kit.family} ${code}`);
      }
    });
  }

  it('lists the included material', () => {
    const result = explainDraftContext({ contextAudit: audit({ creativePreferenceIds: ['p1'], draftInputTrace: { ...audit().draftInputTrace, sections: { previousTail: { originalTokens: 9, includedTokens: 9, truncated: false, reason: null }, creativePreferences: { originalTokens: 9, includedTokens: 9, includedIds: ['p1', 'p2'], truncated: false, reason: null } } } }), kit: enKit });
    assert.equal(result.available, true);
    assert.equal(result.schema, 1);
    assert.equal(result.items[0].layer, 'fixed');
    assert.equal(result.items[0].text, enKit.phrases.contextExplain.fixedMaterial());
    assert.ok(result.sentences.includes(enKit.phrases.contextExplain.summaryIncluded('7, 6, 5', 3)));
    assert.ok(result.sentences.includes(enKit.phrases.contextExplain.olderMemoryIncluded(1, '`summary:1`')));
    assert.ok(result.sentences.includes(enKit.phrases.contextExplain.previousTailIncluded()));
    assert.ok(result.sentences.includes(enKit.phrases.contextExplain.preferencesIncluded(2)));
    assert.equal(result.items.at(-1).layer, 'coverage');
    assert.equal(result.items.at(-1).code, 'coverage');
    assert.equal(result.items.at(-1).text, enKit.phrases.contextExplain.coverageNote());
  });

  it('keeps sentences equal to the item texts and reports the kit family', () => {
    const ko = explainDraftContext({ contextAudit: audit(), kit: koKit });
    const en = explainDraftContext({ contextAudit: audit(), kit: enKit });
    assert.equal(ko.family, 'ko');
    assert.equal(en.family, 'multilingual');
    assert.deepEqual(ko.sentences, ko.items.map((item) => item.text));
    assert.deepEqual(en.sentences, en.items.map((item) => item.text));
  });
});

describe('explainDraftContext determinism and order', () => {
  const rich = () => audit({
    disabledDraftSections: ['author-craft'],
    draftInputTrace: {
      continuity: { recentSummaryChapters: [7], olderMemoryRefs: ['summary:1'], excluded: [{ kind: 'recentSummary', chapter: 4, reason: 'truncated' }, { kind: 'olderMemory', ref: 'fact:x', reason: 'unsafe-content' }] },
      sections: { previousTail: { originalTokens: 9, includedTokens: 9, truncated: false, reason: null }, creativePreferences: { originalTokens: 9, includedTokens: 9, includedIds: ['p1'], truncated: false, reason: null } },
    },
    memory: { ...audit().memory, trimmedSummaries: 1, excluded: [{ id: 'summary:3', reason: 'budget' }], excludedTotal: 1, filtered: [{ id: 'fact:w1', reason: 'in-foundation' }], filteredTotal: 1 },
  });

  it('is deterministic for the same input and a structured clone', () => {
    const input = rich();
    const a = explainDraftContext({ contextAudit: input, kit: enKit });
    assert.deepEqual(explainDraftContext({ contextAudit: input, kit: enKit }), a);
    assert.deepEqual(explainDraftContext({ contextAudit: structuredClone(input), kit: enKit }), a);
  });

  it('follows the fixed layer order', () => {
    const layers = explainDraftContext({ contextAudit: rich(), kit: enKit }).items.map((item) => item.layer);
    const ranks = layers.map((layer) => LAYER_ORDER.indexOf(layer));
    assert.ok(ranks.every((rank) => rank >= 0));
    assert.deepEqual([...ranks].sort((x, y) => x - y), ranks);
    assert.deepEqual([...new Set(layers)], ['fixed', 'recentSummaries', 'olderMemory', 'previousTail', 'preferences', 'sections', 'coverage']);
  });

  it('orders older-memory left-out items trace, then filtered, then excluded', () => {
    const result = explainDraftContext({ contextAudit: rich(), kit: enKit });
    const codes = result.items.filter((item) => item.layer === 'olderMemory' && item.outcome === 'left-out').map((item) => item.code);
    assert.deepEqual(codes, ['unsafe-content', 'in-foundation', 'budget']);
  });
});

describe('explainDraftContext privacy', () => {
  it('sanitizes ids and never reads text fields', () => {
    const longId = `fact:${'x'.repeat(200)}`;
    const input = audit({
      draftProse: 'CANARY_PROSE',
      olderMemoryRefs: ['fact:a\nb\u0000c', longId],
      draftInputTrace: { ...audit().draftInputTrace, continuity: { recentSummaryChapters: [7], olderMemoryRefs: [], excluded: [
        { kind: 'olderMemory', ref: 'character:x', reason: 'unsafe-content', text: 'CANARY_PROSE' },
      ] } },
      memory: { ...audit().memory, excluded: [{ id: 'fact:a\nb\u0000c', reason: 'budget', text: 'CANARY_PROSE' }, { id: longId, reason: 'no-query-match', text: 'CANARY_PROSE' }], excludedTotal: 2 },
    });
    for (const kit of [koKit, enKit]) {
      const result = explainDraftContext({ contextAudit: input, kit });
      assert.doesNotMatch(JSON.stringify(result), /CANARY_PROSE/);
      for (const sentence of result.sentences) assert.doesNotMatch(sentence, /\n/);
      for (const match of JSON.stringify(result).match(/fact:x{1,}/g) ?? []) assert.ok([...match].length <= 64);
      const unsafe = result.items.find((item) => item.code === 'unsafe-content');
      assert.equal(unsafe.text, kit.phrases.contextExplain.olderMemoryUnsafe('character:x'));
      assert.equal(unsafe.subject, 'character:x');
    }
  });

  it('safeId strips controls, collapses whitespace and clips to 64 code points', () => {
    assert.equal(safeId('fact:a\nb\u0000c'), 'fact:a b c');
    assert.equal(safeId('  a \t\u2028 b\u2029c  '), 'a b c');
    assert.equal(safeId('a\u009fb'), 'a b');
    assert.equal([...safeId('x'.repeat(200))].length, 64);
    assert.equal([...safeId('\u{1F600}'.repeat(100))].length, 64);
    assert.equal(safeId(undefined), '');
  });
});

describe('explainDraftContext old and missing records', () => {
  it('summarizes an old record with counts only', () => {
    const old = audit({ memory: { trimmedSummaries: 0, droppedForBudget: 2, retrieval: { documents: 9, candidates: 4, selected: 1 } } });
    for (const kit of [koKit, enKit]) {
      const result = explainDraftContext({ contextAudit: old, kit });
      const notes = byCode(result, 'detail-not-recorded').filter((item) => item.layer === 'olderMemory');
      assert.equal(notes.length, 1);
      assert.equal(notes[0].text, kit.phrases.contextExplain.olderMemoryCountsOnly(4, 1, 2));
      assert.match(notes[0].text, /4/);
      assert.match(notes[0].text, /1/);
      assert.match(notes[0].text, /2/);
    }
  });

  it('still lists recent summaries without a draft input trace', () => {
    const { draftInputTrace, ...rest } = audit();
    const result = explainDraftContext({ contextAudit: rest, kit: enKit });
    assert.equal(result.available, true);
    assert.ok(result.sentences.includes(enKit.phrases.contextExplain.summaryIncluded('7, 6, 5', 3)));
  });
});

describe('explainDraftContext failures', () => {
  it('reports not-yet-drafted for a missing audit', () => {
    for (const missing of [null, undefined]) {
      const result = explainDraftContext({ contextAudit: missing, kit: enKit });
      assert.equal(result.available, false);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].code, 'not-yet-drafted');
      assert.equal(result.items[0].layer, 'coverage');
      assert.deepEqual(result.sentences, [enKit.phrases.contextExplain.notYetDrafted()]);
    }
  });

  it('never throws on malformed input', () => {
    for (const bad of ['oops', [], 7, true]) {
      const result = explainDraftContext({ contextAudit: bad, kit: enKit });
      assert.equal(result.available, false);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].code, 'detail-not-recorded');
      assert.deepEqual(result.sentences, [enKit.phrases.contextExplain.detailUnavailable()]);
    }
    assert.doesNotThrow(() => explainDraftContext({ contextAudit: { memory: 'x', draftInputTrace: 7 }, kit: enKit }));
    const skipped = explainDraftContext({ contextAudit: excludedBy([null, 5, {}, { id: 'summary:3', reason: 'budget' }]), kit: enKit });
    assert.equal(byCode(skipped, 'budget').length, 1);
    assert.doesNotThrow(() => explainDraftContext({ contextAudit: audit({ disabledDraftSections: 'x', recentSummaryChapters: 'y', olderMemoryRefs: 5 }), kit: enKit }));
    assert.doesNotThrow(() => explainDraftContext({ contextAudit: audit(), kit: null }));
    assert.doesNotThrow(() => explainDraftContext());
  });

  it('treats a null or missing argument as a missing audit', () => {
    for (const missing of [null, undefined]) {
      const result = explainDraftContext(missing);
      assert.equal(result.available, false);
      assert.equal(result.items[0].code, 'not-yet-drafted');
      assert.equal(result.family, null);
    }
    assert.doesNotThrow(() => explainDraftContext(7));
    assert.doesNotThrow(() => explainDraftContext('x'));
  });

  it('skips id-less entries in the older-memory lists', () => {
    const input = withMemory({
      excluded: [{}, { reason: 'budget' }, { id: '', reason: 'budget' }, { id: 'summary:3', reason: 'budget' }], excludedTotal: 4,
      filtered: [{}, { id: 'fact:w1', reason: 'in-foundation' }], filteredTotal: 2,
    }, { draftInputTrace: { ...audit().draftInputTrace, continuity: { recentSummaryChapters: [7], olderMemoryRefs: [], excluded: [{ kind: 'olderMemory', reason: 'unsafe-content' }, { kind: 'recentSummary', chapter: 4, reason: 'truncated' }] } } });
    for (const kit of [koKit, enKit]) {
      const result = explainDraftContext({ contextAudit: input, kit });
      const left = result.items.filter((item) => item.layer === 'olderMemory' && item.outcome === 'left-out');
      assert.deepEqual(left.map((item) => item.subject), ['fact:w1', 'summary:3']);
      assert.ok(result.sentences.every((sentence) => !sentence.includes('`?`')));
    }
  });

  it('renders the generic sentence for an unknown reason code', () => {
    for (const kit of [koKit, enKit]) {
      const result = explainDraftContext({ contextAudit: excludedBy([{ id: 'summary:3', reason: 'mystery' }]), kit });
      assert.ok(result.sentences.includes(kit.phrases.contextExplain.unknownCode('mystery', 'summary:3')));
      const traced = explainDraftContext({ contextAudit: withTrace({ continuity: { recentSummaryChapters: [], olderMemoryRefs: [], excluded: [{ kind: 'recentSummary', chapter: 4, reason: 'mystery' }] } }), kit });
      assert.ok(traced.sentences.includes(kit.phrases.contextExplain.unknownCode('mystery', '4')));
    }
  });

  it('uses ? for chapters and budgets that are not finite numbers', () => {
    const result = explainDraftContext({
      contextAudit: audit({
        recentSummaryChapters: [7, null],
        draftInputUsage: { maxPlanTokens: null, maxContextTokens: null },
        draftInputTrace: { ...audit().draftInputTrace, continuity: { recentSummaryChapters: [7, null], olderMemoryRefs: [], excluded: [{ kind: 'recentSummary', chapter: null, reason: 'context-token-budget' }] } },
      }),
      kit: enKit,
    });
    assert.ok(result.sentences.includes(enKit.phrases.contextExplain.summaryIncluded('7, ?', 2)));
    assert.ok(result.sentences.includes(enKit.phrases.contextExplain.summaryCut('?', '?')));
  });
});

describe('explainDraftContext switched-off sections', () => {
  const noisy = (disabled) => withMemory({
    excluded: [{ id: 'summary:3', reason: 'budget' }], excludedTotal: 1, filtered: [{ id: 'fact:w1', reason: 'in-foundation' }], filteredTotal: 1,
  }, { disabledDraftSections: disabled });

  it('leaves the older-memory layer to the sections layer when older-memory is switched off', () => {
    for (const kit of [koKit, enKit]) {
      const result = explainDraftContext({ contextAudit: noisy(['older-memory']), kit });
      assert.equal(result.items.filter((item) => item.layer === 'olderMemory').length, 0);
      const off = byCode(result, 'disabled-by-user');
      assert.equal(off.length, 1);
      assert.equal(off[0].text, kit.phrases.contextExplain.sectionSwitchedOff(kit.phrases.contextExplain.sectionLabels['older-memory']));
      const old = explainDraftContext({ contextAudit: withMemory({ retrieval: { documents: 9, candidates: 4, selected: 1 }, excluded: undefined }, { disabledDraftSections: ['older-memory'] }), kit });
      assert.equal(old.items.filter((item) => item.layer === 'olderMemory').length, 0);
    }
  });

  it('still explains older memory when another section is switched off', () => {
    const result = explainDraftContext({ contextAudit: noisy(['author-craft']), kit: enKit });
    assert.ok(result.items.some((item) => item.layer === 'olderMemory' && item.outcome === 'left-out'));
  });

  it('suppresses the previous-tail layer when previous-tail is switched off', () => {
    const dropped = { sections: { previousTail: { originalTokens: 30, includedTokens: 0, truncated: true, reason: 'plan-token-budget' } } };
    for (const trace of [dropped, audit().draftInputTrace]) {
      const result = explainDraftContext({ contextAudit: withTrace(trace, { disabledDraftSections: ['previous-tail'] }), kit: enKit });
      assert.equal(result.items.filter((item) => item.layer === 'previousTail').length, 0);
      assert.equal(byCode(result, 'disabled-by-user').length, 1);
      const shown = explainDraftContext({ contextAudit: withTrace(trace), kit: enKit });
      assert.equal(shown.items.filter((item) => item.layer === 'previousTail').length, 1);
    }
  });
});

describe('explainDraftContext older-memory parity with the writer filter', () => {
  it('uses the cap the writer-side filter keeps', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ scope: 'summary', ref: `${i + 1}`, text: 'x' }));
    const { kept, dropped } = writerOlderMemory(items, () => false);
    assert.equal(kept.length, OLDER_MEMORY_CAP);
    assert.deepEqual(dropped, [{ id: 'summary:9', reason: 'over-cap' }]);
    const result = explainDraftContext({ contextAudit: withMemory({ filtered: dropped, filteredTotal: 1 }), kit: enKit });
    assert.ok(result.sentences.includes(enKit.phrases.contextExplain.olderMemoryOverCap('summary:9', kept.length)));
  });

  it('explains a dormant hook the filter drops without claiming it is in the prompt', () => {
    const items = [{ scope: 'hook', ref: 'h-dormant', text: 'x' }, { scope: 'summary', ref: '1', text: 'x' }];
    const { kept, dropped } = writerOlderMemory(items, () => false);
    assert.deepEqual(kept.map((item) => `${item.scope}:${item.ref}`), ['summary:1']);
    assert.deepEqual(dropped, [{ id: 'hook:h-dormant', reason: 'in-foundation' }]);
    for (const kit of [koKit, enKit]) {
      const result = explainDraftContext({ contextAudit: withMemory({ filtered: dropped, filteredTotal: 1 }), kit });
      const [entry] = byCode(result, 'in-foundation');
      assert.equal(entry.subject, 'hook:h-dormant');
      assert.equal(entry.text, kit.phrases.contextExplain.olderMemoryInFoundation('hook:h-dormant'));
    }
    const text = explainDraftContext({ contextAudit: withMemory({ filtered: dropped, filteredTotal: 1 }), kit: enKit }).sentences.join(' ');
    assert.match(text, /only open hooks appear in the current state/);
    assert.doesNotMatch(text, /already in the prompt|hooks[^.]*sent (in full|whole)/);
  });
});

describe('explainDraftContext singular counts', () => {
  it('uses singular English wording for a count of one', () => {
    const result = explainDraftContext({
      contextAudit: audit({
        recentSummaryChapters: [6],
        draftInputTrace: { ...audit().draftInputTrace, continuity: { recentSummaryChapters: [6], olderMemoryRefs: ['summary:1'], excluded: [] }, sections: { previousTail: { originalTokens: 9, includedTokens: 9, truncated: false, reason: null }, creativePreferences: { originalTokens: 9, includedTokens: 9, includedIds: ['p1'], truncated: false, reason: null } } },
        memory: { ...audit().memory, trimmedSummaries: 1 },
      }),
      kit: enKit,
    });
    assert.ok(result.sentences.includes('Summary of chapter 6 is in the continuity window.'));
    assert.ok(result.sentences.includes('1 older memory item is in the draft input: `summary:1`'));
    assert.ok(result.sentences.includes('1 earlier chapter summary is outside the continuity window; it only returns through memory retrieval.'));
    assert.ok(result.sentences.includes('1 creative preference you adopted is in the draft input.'));
  });
});

describe('explainDraftContext caps', () => {
  const budgetList = (count) => Array.from({ length: count }, (_, i) => ({ id: `summary:${i}`, reason: 'budget' }));

  it('exposes the cap', () => {
    assert.equal(LAYER_SENTENCE_CAP, 12);
  });

  it('keeps 12 without an and-more sentence', () => {
    const result = explainDraftContext({ contextAudit: excludedBy(budgetList(12)), kit: enKit });
    assert.equal(byCode(result, 'budget').length, 12);
    assert.equal(byCode(result, 'and-more').length, 0);
  });

  it('adds one and-more sentence for 13', () => {
    const result = explainDraftContext({ contextAudit: excludedBy(budgetList(13)), kit: enKit });
    assert.equal(byCode(result, 'budget').length, 12);
    const more = byCode(result, 'and-more');
    assert.equal(more.length, 1);
    assert.equal(more[0].count, 1);
    assert.equal(more[0].text, enKit.phrases.contextExplain.andMore(1));
  });

  it('uses the stored total for the more-count', () => {
    const forty = explainDraftContext({ contextAudit: withMemory({ excluded: budgetList(40), excludedTotal: 40 }), kit: enKit });
    assert.equal(byCode(forty, 'budget').length, 12);
    assert.equal(byCode(forty, 'and-more')[0].text, enKit.phrases.contextExplain.andMore(28));
    const thirty = explainDraftContext({ contextAudit: withMemory({ excluded: budgetList(30), excludedTotal: 55 }), kit: koKit });
    assert.equal(byCode(thirty, 'budget').length, 12);
    assert.equal(byCode(thirty, 'and-more')[0].text, koKit.phrases.contextExplain.andMore(43));
  });

  it('caps the combined older-memory list across trace, filtered and excluded', () => {
    const result = explainDraftContext({
      contextAudit: withMemory({ excluded: budgetList(10), excludedTotal: 10, filtered: budgetList(5).map((e) => ({ ...e, reason: 'over-cap' })), filteredTotal: 5 }),
      kit: enKit,
    });
    assert.equal(result.items.filter((item) => item.layer === 'olderMemory' && item.outcome === 'left-out').length, 12);
    assert.equal(byCode(result, 'and-more')[0].count, 3);
  });
});

describe('explainDraftContext canon gates', () => {
  const gates = {
    hidden: [
      { ref: 'fact:w7', kind: 'world-fact', fromChapter: 12, reason: 'canon_gate' },
      { ref: 'character:kai', kind: 'progression', fromChapter: 15, reason: 'canon_gate' },
    ],
    total: 2,
  };
  const hiddenList = (count) => Array.from({ length: count }, (_, i) => ({ ref: `fact:w${i}`, kind: 'world-fact', fromChapter: 3, reason: 'canon_gate' }));

  it('lists each hidden setting in both kits', () => {
    for (const kit of [koKit, enKit]) {
      const result = explainDraftContext({ contextAudit: audit({ canonGates: gates }), kit });
      const items = byCode(result, 'canon_gate');
      assert.equal(items.length, 2);
      assert.ok(items.every((entry) => entry.layer === 'canonGates' && entry.outcome === 'left-out'));
      assert.deepEqual(items.map((entry) => entry.subject), ['fact:w7', 'character:kai']);
      assert.equal(items[0].text, kit.phrases.contextExplain.canonGateHidden('fact:w7', 12));
      assert.match(items[1].text, /15/);
    }
    const en = explainDraftContext({ contextAudit: audit({ canonGates: gates }), kit: enKit });
    assert.equal(byCode(en, 'canon_gate')[0].text, 'Setting `fact:w7` was hidden from this draft by a canon gate: it takes effect from chapter 12.');
    const ko = explainDraftContext({ contextAudit: audit({ canonGates: gates }), kit: koKit });
    assert.equal(byCode(ko, 'canon_gate')[0].text, '설정 `fact:w7`은(는) 정사 시점 게이트로 이번 초고에서 숨겼습니다. 12화부터 적용됩니다.');
  });

  it('sits between fixed and recentSummaries', () => {
    const layers = explainDraftContext({ contextAudit: audit({ canonGates: gates }), kit: enKit }).items.map((entry) => entry.layer);
    assert.deepEqual([...new Set(layers)].slice(0, 3), ['fixed', 'canonGates', 'recentSummaries']);
  });

  it('caps the layer and counts the rest from the stored total', () => {
    const forty = explainDraftContext({ contextAudit: audit({ canonGates: { hidden: hiddenList(40), total: 40 } }), kit: enKit });
    assert.equal(byCode(forty, 'canon_gate').length, 12);
    assert.equal(forty.items.filter((entry) => entry.layer === 'canonGates' && entry.code === 'and-more')[0].text, enKit.phrases.contextExplain.andMore(28));
    const thirty = explainDraftContext({ contextAudit: audit({ canonGates: { hidden: hiddenList(30), total: 100 } }), kit: koKit });
    assert.equal(byCode(thirty, 'canon_gate').length, 12);
    assert.equal(thirty.items.filter((entry) => entry.layer === 'canonGates' && entry.code === 'and-more')[0].text, koKit.phrases.contextExplain.andMore(88));
    const exact = explainDraftContext({ contextAudit: audit({ canonGates: { hidden: hiddenList(12), total: 12 } }), kit: enKit });
    assert.equal(exact.items.filter((entry) => entry.code === 'and-more').length, 0);
  });

  it('adds nothing when canonGates is absent or malformed', () => {
    const base = explainDraftContext({ contextAudit: audit(), kit: enKit });
    for (const canonGates of [undefined, null, 'x', 7, [], { hidden: 'x' }, { hidden: [null, 5, {}] }]) {
      const result = explainDraftContext({ contextAudit: audit({ canonGates }), kit: enKit });
      assert.equal(byCode(result, 'canon_gate').length, 0);
      assert.equal(result.items.filter((entry) => entry.layer === 'canonGates').length, 0);
      assert.equal(result.items[0].text, base.items[0].text);
    }
  });

  it('renders ? for a chapter that is not finite and sanitizes the ref', () => {
    const result = explainDraftContext({
      contextAudit: audit({ canonGates: { hidden: [{ ref: 'fact:a\nb', kind: 'world-fact', fromChapter: null, reason: 'canon_gate' }, { ref: 'fact:c', fromChapter: 'soon' }], total: 2 } }),
      kit: enKit,
    });
    const [first, second] = byCode(result, 'canon_gate');
    assert.equal(first.subject, 'fact:a b');
    assert.equal(first.text, enKit.phrases.contextExplain.canonGateHidden('fact:a b', '?'));
    assert.equal(second.text, enKit.phrases.contextExplain.canonGateHidden('fact:c', '?'));
    for (const sentence of result.sentences) assert.doesNotMatch(sentence, /\n/);
  });
});
