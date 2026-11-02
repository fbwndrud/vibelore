import test from 'node:test';
import assert from 'node:assert/strict';

import { chapterFoundation, overlay } from '../src/core/chapter-foundation.js';
import { gateFoundation } from '../src/core/canon-gates.js';
import { loadLoreRuntime, planningFoundation } from '../src/core/lore-runtime.js';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { createFoundation, registerCharacter } from '../engine/src/continuity/foundation.js';
import { createGenreProfileRegistry } from '../engine/src/continuity/genre-profile.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  const wide = chapterFoundation({ raw: raw(), chapter: 30 });
  assert.deepEqual(chapterFoundation({ raw: wide, chapter: 11 }), chapterFoundation({ raw: raw(), chapter: 11 }));

  const plain = { worldFacts: [{ id: 'a', statement: 's' }], characters: [{ id: 'c', canonicalName: 'C' }] };
  const copy = chapterFoundation({ raw: plain, chapter: 5 });
  assert.deepEqual(copy, plain);
  assert.notEqual(copy, plain);
});

test('overlay is the identity for now', () => {
  const foundation = raw();
  assert.equal(overlay(foundation, { anything: 1 }), foundation);
});

test('loadLoreRuntime gates the foundation at the chapter when no production lock applies', async () => {
  const runtime = await loadLoreRuntime({ canonicalStore: { publishedRevision: null }, foundation: raw(), chapter: 5 });
  assert.deepEqual(runtime.foundation.worldFacts.map((f) => f.id), ['w1']);
  const kai = runtime.foundation.characters.find((c) => c.id === 'kai');
  assert.equal(kai.progressions, undefined);
  assert.doesNotMatch(JSON.stringify(runtime.foundation), /Lost an arm/);
  assert.equal(runtime.productionLock, null);
  const later = await loadLoreRuntime({ canonicalStore: { publishedRevision: null }, foundation: raw(), chapter: 12 });
  assert.deepEqual(later.foundation.worldFacts.map((f) => f.id), ['w1', 'w7']);
  await assert.rejects(loadLoreRuntime({ canonicalStore: { publishedRevision: null }, foundation: raw() }), { code: 'CANON_GATE_HORIZON' });
});

test('planningFoundation gates an unbound work at the highest planned chapter', async (t) => {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-')));
  t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  let f = createFoundation({ workId: 'gated', genre: 'action', genreProfile: createGenreProfileRegistry().get('action'), povMode: '3인칭제한' });
  f = { ...f, worldFacts: [
    { id: 'w1', statement: '왕국이 있다.', registeredAtChapter: 1 },
    { id: 'w7', statement: '왕은 죽었다.', registeredAtChapter: 12 }
  ] };
  f = registerCharacter(f, { id: 'kai', canonicalName: 'Kai', registeredAtChapter: 1, description: 'Apprentice.\n\n### 12화부터\nLost an arm.\n' });
  await store.saveFoundation(f);
  const early = await planningFoundation({ store, workId: 'gated', chapters: [5] });
  assert.deepEqual(early.foundation.worldFacts.map((fact) => fact.id), ['w1']);
  assert.equal(early.foundation.characters.find((c) => c.id === 'kai').progressions, undefined);
  const range = await planningFoundation({ store, workId: 'gated', chapters: [10, 11, 12] });
  const w7 = range.foundation.worldFacts.find((fact) => fact.id === 'w7');
  assert.equal(w7.registeredAtChapter, 12);
  assert.equal(range.foundation.characters.find((c) => c.id === 'kai').progressions.length, 1);
  const open = await planningFoundation({ store, workId: 'gated' });
  assert.deepEqual(open.foundation.worldFacts.map((fact) => fact.id), ['w1', 'w7']);
  assert.equal(open.foundation.characters.find((c) => c.id === 'kai').progressions.length, 1);
});
