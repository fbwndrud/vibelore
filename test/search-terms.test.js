import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { searchTerms } from '../src/core/search-terms.js';
import { compileMemory } from '../src/core/memory-compiler.js';
import { retrieveMemory } from '../src/tools/memory-index.js';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { legacyWorkFixture } from './fixtures/legacy-work.js';

const context = {
  snapshotId: 'rev-1', expectedHead: 'rev-1', storyTimeScope: { worldline: 'main', through: 9 },
  publicationOrder: 9, transactionTime: '2026-09-26T00:00:00.000Z', policyRevision: 1,
  semanticGeneration: 1, fencingToken: 1,
};

async function storeWithSummary(summary) {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-terms-')));
  await legacyWorkFixture({ store, workId: 'terms', genre: 'other', povMode: '3인칭제한', targetChapters: 20, worldFacts: ['평범한 사실.'] });
  await store.saveChapterSummary({ workId: 'terms', chapterNumber: 1, summary });
  return store;
}

describe('search terms', () => {
  it('segments scripts written without spaces into words', () => {
    assert.ok(searchTerms('灯里は帳簿を閉じた。', 'ja').includes('帳簿'));
    assert.ok(searchTerms('燈里闔上帳簿。', 'zh-Hant').includes('帳簿'));
    assert.ok(searchTerms('เธอปิดสมุดบัญชี', 'th').includes('บัญชี'));
    assert.ok(searchTerms('أغلقت الدفتر', 'ar').includes('الدفتر'));
    assert.ok(searchTerms('Élodie ferma le registre', 'fr').includes('élodie'));
  });

  it('matches a Korean name across particles', () => {
    const left = searchTerms('수아가 문을 열었다', 'ko');
    const right = searchTerms('수아는 말했다', 'ko');
    assert.ok(left.includes('수아') && right.includes('수아'));
    assert.ok(left.includes('수아가'), 'the surface form stays searchable');
  });

  it('scores non-Korean candidates instead of dropping them as no match', () => {
    const result = compileMemory(context, {
      scope: { chapter: 10 }, budget: { maxTokens: 500, reservedTokens: 10 }, mandatory: [],
      candidates: [{ id: 's1', kind: 'summary', chapter: 1, text: '灯里は帳簿を閉じた。' }],
      query: '帳簿の行方', language: 'ja',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.discretionary.map((item) => item.id), ['s1']);
  });

  it('retrieves Japanese and Korean-particle memory from the index', async () => {
    const ja = await storeWithSummary('灯里は帳簿を閉じた。');
    const jaMemory = await retrieveMemory({ store: ja, workId: 'terms', query: '帳簿の行方', currentChapter: 10, language: 'ja' });
    assert.deepEqual(jaMemory.selected.map((item) => item.scope), ['summary']);
    const ko = await storeWithSummary('수아가 은빛열쇠를 창구에 맡겼다.');
    const koMemory = await retrieveMemory({ store: ko, workId: 'terms', query: '수아는 열쇠를 찾는다', currentChapter: 10, language: 'ko' });
    assert.equal(koMemory.selected[0]?.scope, 'summary');
  });

  it('rebuilds the index even when an unreadable memory.db is left behind', async () => {
    const store = await storeWithSummary('수아가 문을 열었다.');
    const path = store.sidecar('memory.db');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'not a sqlite database');
    const memory = await retrieveMemory({ store, workId: 'terms', query: '수아', currentChapter: 10, language: 'ko' });
    assert.equal(memory.selected[0]?.scope, 'summary');
  });
});
