import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GATE_SUMMARY_LIMIT,
  findIgnoredMarkers,
  formatGateMarker,
  gateFoundation,
  gateSummary,
  looksLikeGateMarker,
  parseFactTag,
  parseGateMarker,
  splitGatedSection
} from '../src/core/canon-gates.js';

const invalid = { code: 'CANON_GATE_INVALID' };
const horizonError = { code: 'CANON_GATE_HORIZON' };

const fixture = () => ({
  worldFacts: [
    { id: 'w1', statement: '왕국이 있다.', registeredAtChapter: 1 },
    { id: 'w7', statement: '왕은 죽었다.', registeredAtChapter: 12 }
  ],
  characters: [
    { id: 'kai', canonicalName: 'Kai', description: 'Apprentice.\n\n### 12화부터\nLost an arm.\n\n### from chapter 30\nHeir.\n' },
    { id: 'zed', canonicalName: 'Zed', description: 'Rival.', registeredAtChapter: 20 }
  ]
});

test('parseGateMarker accepts both styles and returns null for plain text', () => {
  for (const text of ['12화부터', ' 12 화부터 ', 'from chapter 12', 'From  Chapter 12 ', 'FROM CHAPTER12']) {
    assert.deepEqual(parseGateMarker(text), { fromChapter: 12 }, text);
  }
  assert.equal(parseGateMarker('Notes'), null);
});

test('parseGateMarker throws on near-miss markers with the offending text', () => {
  for (const text of ['0화부터', '-3화부터', '화부터', 'from chapter', 'from chapter x', 'from chapter 1.5', `from chapter ${'9'.repeat(40)}`]) {
    assert.throws(() => parseGateMarker(text), (error) => {
      assert.equal(error.code, 'CANON_GATE_INVALID');
      assert.equal(error.lineText, text);
      assert.match(error.message, /^CANON_GATE_INVALID: /);
      return true;
    }, text);
  }
});

test('looksLikeGateMarker never throws', () => {
  assert.equal(looksLikeGateMarker('12화부터'), true);
  assert.equal(looksLikeGateMarker('0화부터'), true);
  assert.equal(looksLikeGateMarker('from chapter x'), true);
  assert.equal(looksLikeGateMarker('Notes'), false);
});

test('parseFactTag reads a leading marker bracket', () => {
  assert.deepEqual(parseFactTag('[12화부터] 왕은 죽었다.'), { fromChapter: 12, statement: '왕은 죽었다.' });
  assert.deepEqual(parseFactTag('[from chapter 3]x'), { fromChapter: 3, statement: 'x' });
  assert.equal(parseFactTag('[Prologue] x'), null);
  assert.equal(parseFactTag('plain'), null);
  assert.throws(() => parseFactTag('[from chapter x] y'), invalid);
  assert.throws(() => parseFactTag('[12화부터]'), invalid);
  assert.throws(() => parseFactTag('[12화부터]   '), invalid);
});

test('splitGatedSection splits base and gate blocks in document order', () => {
  const text = ['Base line.', '', '### 12화부터', 'Lost an arm.', 'Second line.', '### Notes', 'Ungated again.', '### from chapter 30', 'Heir.', '', '#### sub', 'still in block'].join('\n');
  assert.deepEqual(splitGatedSection(text), {
    base: 'Base line.\n\n### Notes\nUngated again.',
    blocks: [
      { fromChapter: 12, text: 'Lost an arm.\nSecond line.' },
      { fromChapter: 30, text: 'Heir.\n\n#### sub\nstill in block' }
    ]
  });
  const reversed = splitGatedSection('b\n### 30화부터\nlate\n### 12화부터\nearly');
  assert.deepEqual(reversed.blocks.map((block) => block.fromChapter), [30, 12]);
});

test('splitGatedSection returns the input unchanged without gate headings and drops empty blocks', () => {
  const plain = '  Intro.\n\n#### deep\n### Notes\nx\n\n';
  assert.deepEqual(splitGatedSection(plain), { base: plain, blocks: [] });
  assert.deepEqual(splitGatedSection('b\n### 5화부터\n\n  \n### 6화부터\nx'), { base: 'b', blocks: [{ fromChapter: 6, text: 'x' }] });
  assert.throws(() => splitGatedSection('b\n### 0화부터\nx'), invalid);
});

test('gateFoundation projects facts and progressions by horizon', () => {
  const f = fixture();
  const before = structuredClone(f);

  const at11 = gateFoundation(f, 11);
  assert.deepEqual(at11.worldFacts.map((fact) => fact.id), ['w1']);
  const kai11 = at11.characters.find((c) => c.id === 'kai');
  assert.equal(kai11.description, 'Apprentice.');
  assert.equal('progressions' in kai11, false);
  assert.ok(at11.characters.some((c) => c.id === 'zed'));

  const at12 = gateFoundation(f, 12);
  assert.deepEqual(at12.worldFacts.map((fact) => fact.id), ['w1', 'w7']);
  assert.deepEqual(at12.characters[0].progressions, [{ fromChapter: 12, text: 'Lost an arm.' }]);

  for (const horizon of [30, Infinity]) {
    const open = gateFoundation(f, horizon);
    assert.deepEqual(open.characters[0].progressions, [
      { fromChapter: 12, text: 'Lost an arm.' },
      { fromChapter: 30, text: 'Heir.' }
    ]);
    assert.equal(open.characters[0].description, 'Apprentice.');
  }
  assert.deepEqual(f, before);
});

test('gateFoundation is idempotent, copies gate-less input and validates the horizon', () => {
  const f = fixture();
  assert.deepEqual(gateFoundation(gateFoundation(f, 12), 12), gateFoundation(f, 12));

  const plain = { worldFacts: [{ id: 'a', statement: 's' }], characters: [{ id: 'c', canonicalName: 'C', description: 'd' }] };
  const copy = gateFoundation(plain, 3);
  assert.deepEqual(copy, plain);
  assert.notEqual(copy, plain);

  for (const bad of [0, undefined, NaN, -1, '3', null]) assert.throws(() => gateFoundation(f, bad), horizonError);
  assert.equal(gateFoundation(null, 3), null);
});

test('gateSummary lists hidden entries by reference only', () => {
  const f = fixture();
  assert.deepEqual(gateSummary(f, 11), {
    hidden: [
      { ref: 'fact:w7', kind: 'world-fact', fromChapter: 12, reason: 'canon_gate' },
      { ref: 'character:kai', kind: 'progression', fromChapter: 12, reason: 'canon_gate' },
      { ref: 'character:kai', kind: 'progression', fromChapter: 30, reason: 'canon_gate' }
    ],
    total: 3
  });
  assert.deepEqual(gateSummary(f, 30), { hidden: [], total: 0 });
  assert.equal(gateSummary({ worldFacts: [{ id: 'a', statement: 's' }], characters: [] }, 3), null);
  assert.equal(gateSummary(null, 3), null);
  assert.throws(() => gateSummary(f, 0), horizonError);

  const many = { worldFacts: Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, statement: `secret ${i}`, registeredAtChapter: 5 })), characters: [] };
  const summary = gateSummary(many, 1);
  assert.equal(GATE_SUMMARY_LIMIT, 30);
  assert.equal(summary.hidden.length, 30);
  assert.equal(summary.total, 40);
  assert.equal(JSON.stringify(gateSummary(f, 11)).includes('Lost an arm'), false);
  assert.equal(JSON.stringify(summary).includes('secret'), false);
});

test('findIgnoredMarkers reports marker headings outside the Description section', () => {
  const file = '---\nid: kai\n---\n## 모순\n### 5화부터\nx\n## 설명\n### 6화부터\ny';
  assert.deepEqual(findIgnoredMarkers(file, ['설명', 'Description']), [5]);
});

test('formatGateMarker renders both styles', () => {
  assert.equal(formatGateMarker(12, 'ko'), '12화부터');
  assert.equal(formatGateMarker(12, 'en'), 'from chapter 12');
});
