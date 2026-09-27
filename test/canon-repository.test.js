import test from 'node:test';
import assert from 'node:assert/strict';
import { openCanonRepository } from '../src/core/canon-repository.js';

test('published HEAD overlays mutable working files for canonical reads', async () => {
  const working = {
    loadFoundation: async () => ({ workId: 'w', title: 'working' }),
    loadStoryState: async () => ({ chapterNumber: 1, marker: 'working' }),
    loadRecentChapterSummaries: async () => [{ chapterNumber: 1, summary: 'working' }],
    listChapters: async () => [1],
    loadArcPlan: async () => ({ arcNumber: 2, status: 'active' }),
  };
  const published = { ok: true, value: {
    head: 'sha256:x', tree: { foundation: { workId: 'w', title: 'published' }, chapters: { 1: {}, 2: {} }, summaries: { 1: 'one', 2: 'two' }, plans: { arcPlan: { arcNumber: 1, status: 'completed' } } },
    projections: { storyState: { chapterNumber: 2, marker: 'published' }, entities: [{ id: 'e' }] },
  } };
  const repo = await openCanonRepository({ store: working, publicationUnit: { readPublished: async () => published } });
  assert.equal((await repo.loadFoundation('w')).title, 'published');
  assert.equal((await repo.loadStoryState('w', 2)).marker, 'published');
  assert.deepEqual(await repo.listChapters(), [1, 2]);
  assert.deepEqual((await repo.loadRecentChapterSummaries('w', 3, 2)).map((x) => x.summary), ['two', 'one']);
  // Plans are approved into the working store; the next arc is not canon until a chapter commits under it.
  assert.equal((await repo.loadArcPlan('w')).arcNumber, 2);
});

test('falls back to working tree before the first publication', async () => {
  const working = { loadFoundation: async () => ({ title: 'working' }) };
  const repo = await openCanonRepository({ store: working, publicationUnit: { readPublished: async () => ({ ok: true, value: null }) } });
  assert.equal((await repo.loadFoundation('w')).title, 'working');
});
