import test from 'node:test';
import assert from 'node:assert/strict';

import { chapterFoundation, overlay } from '../src/core/chapter-foundation.js';
import { gateFoundation } from '../src/core/canon-gates.js';

const raw = () => ({
  worldFacts: [
    { id: 'w1', statement: '왕국이 있다.', registeredAtChapter: 1 },
    { id: 'w7', statement: '왕은 죽었다.', registeredAtChapter: 12 }
  ],
  characters: [
    { id: 'kai', canonicalName: 'Kai', description: 'Apprentice.\n\n### 12화부터\nLost an arm.\n\n### from chapter 30\nHeir.\n' },
    { id: 'zed', canonicalName: 'Zed', registeredAtChapter: 20 }
  ]
});

test('chapterFoundation equals the gated projection regardless of plan', () => {
  const expected = gateFoundation(raw(), 12);
  assert.deepEqual(chapterFoundation({ raw: raw(), chapter: 12 }), expected);
  assert.deepEqual(chapterFoundation({ raw: raw(), chapter: 12, plan: {} }), expected);
  assert.deepEqual(chapterFoundation({ raw: raw(), chapter: 12, plan: { anything: 1 } }), expected);
});

test('chapterFoundation passes null through and validates the chapter', () => {
  assert.equal(chapterFoundation({ raw: null, chapter: 3 }), null);
  assert.throws(() => chapterFoundation({ raw: raw(), chapter: undefined }), { code: 'CANON_GATE_HORIZON' });
});

test('chapterFoundation is idempotent and copies gate-less input', () => {
  const once = chapterFoundation({ raw: raw(), chapter: 12 });
  assert.deepEqual(chapterFoundation({ raw: once, chapter: 12 }), once);

  const plain = { worldFacts: [{ id: 'a', statement: 's' }], characters: [{ id: 'c', canonicalName: 'C' }] };
  const copy = chapterFoundation({ raw: plain, chapter: 5 });
  assert.deepEqual(copy, plain);
  assert.notEqual(copy, plain);
});

test('overlay is the identity for now', () => {
  const foundation = raw();
  assert.equal(overlay(foundation, { anything: 1 }), foundation);
});
