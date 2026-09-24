/**
 * 2026-09-24 fr acceptance: chapters/summaries/001.md carried the Korean heading
 * "## 요약" in a French work. The summary heading follows the canonical format
 * version: v1 (legacy/ko) keeps "## 요약", v2 (multilingual) writes "## Summary".
 * Reading accepts both forms so summaries written before this fix still load.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarkdownStateStore } from '../src/store/markdown-store.js';

const newStore = async () => new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'summary-heading-')));
const record = (language, canonicalFormatVersion) => ({ workId: 'book', language, canonicalFormatVersion, length: { unit: 'words', target: 2000 } });

test('a v2 (non-ko) work writes an English summary heading and reads it back', async () => {
  const store = await newStore();
  await store.saveAcceptedCreation('book', record('fr', 2));
  await store.saveChapterSummary({ workId: 'book', chapterNumber: 1, summary: 'Mara rouvre le port.' });
  const text = await readFile(store.summaryPath(1), 'utf8');
  assert.match(text, /^## Summary$/m);
  assert.doesNotMatch(text, /요약/);
  assert.equal((await store.loadChapterSummary('book', 1)).summary, 'Mara rouvre le port.');
});

test('a legacy work without a creation record and a v1 ko work keep the Korean heading', async () => {
  const legacy = await newStore();
  await legacy.saveChapterSummary({ workId: 'book', chapterNumber: 1, summary: '1화 요약문' });
  assert.match(await readFile(legacy.summaryPath(1), 'utf8'), /^## 요약$/m);
  const ko = await newStore();
  await ko.saveAcceptedCreation('book', { ...record('ko', 1), length: { unit: 'graphemes', target: 5000 } });
  await ko.saveChapterSummary({ workId: 'book', chapterNumber: 1, summary: '1화 요약문' });
  assert.match(await readFile(ko.summaryPath(1), 'utf8'), /^## 요약$/m);
  assert.equal((await ko.loadChapterSummary('book', 1)).summary, '1화 요약문');
});

test('reading parses both heading forms regardless of the work format', async () => {
  const store = await newStore();
  await store.saveAcceptedCreation('book', record('fr', 2));
  await store.saveChapterSummary({ workId: 'book', chapterNumber: 1, summary: 'placeholder' });
  // A 0.4.0 summary written with the Korean heading in a v2 work still loads.
  await writeFile(store.summaryPath(1), '---\nworkId: book\nchapter: 1\n---\n\n## 요약\n\nMara rouvre le port.\n');
  assert.equal((await store.loadChapterSummary('book', 1)).summary, 'Mara rouvre le port.');
  // And an English heading in a legacy work also loads.
  const legacy = await newStore();
  await legacy.saveChapterSummary({ workId: 'book', chapterNumber: 2, summary: 'placeholder' });
  await writeFile(legacy.summaryPath(2), '---\nworkId: book\nchapter: 2\n---\n\n## Summary\n\n2화 요약문\n');
  assert.equal((await legacy.loadChapterSummary('book', 2)).summary, '2화 요약문');
});
