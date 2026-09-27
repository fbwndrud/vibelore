import { DatabaseSync } from 'node:sqlite';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isHookActive, normalizeHook } from '../../engine/src/continuity/story-state.js';
import { searchTerms } from '../core/search-terms.js';

const ftsQuery = (queryTerms) => queryTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');

/** Rebuildable FTS projection. Markdown/StoryState remain authoritative. */
export async function rebuildMemoryIndex({ store, workId, language }) {
  const path = store.sidecar('memory.db');
  await mkdir(dirname(path), { recursive: true });
  // The index is a projection. Start from an empty file so a database written
  // by a Node build with a different SQLite (for example with FTS5) or a
  // damaged file cannot block the rebuild.
  await rm(path, { force: true });
  const db = new DatabaseSync(path);
  try {
    let backend = 'sqlite-bm25';
    // `terms` holds segmented words joined by spaces; unicode61 alone cannot
    // split scripts written without spaces.
    try { db.exec('CREATE VIRTUAL TABLE memory USING fts5(scope UNINDEXED, ref UNINDEXED, chapter UNINDEXED, text UNINDEXED, terms, tokenize="unicode61");'); backend = 'sqlite-fts5-bm25'; }
    catch { db.exec('CREATE TABLE memory(scope TEXT NOT NULL, ref TEXT NOT NULL, chapter INTEGER NOT NULL, text TEXT NOT NULL, terms TEXT NOT NULL);'); }
    const statement = db.prepare('INSERT INTO memory(scope, ref, chapter, text, terms) VALUES (?, ?, ?, ?, ?)');
    const insert = { run: (scope, ref, chapter, text) => statement.run(scope, ref, chapter, text, searchTerms(text, language).join(' ')) };
    const foundation = await store.loadFoundation(workId);
    for (const fact of foundation?.worldFacts ?? []) insert.run('fact', fact.id, fact.registeredAtChapter ?? 1, fact.statement);
    for (const character of foundation?.characters ?? []) insert.run('character', character.id, character.registeredAtChapter ?? 1, [character.canonicalName, ...(character.aliases ?? []), character.contradiction, character.description].filter(Boolean).join(' '));
    const chapters = await store.listChapters();
    for (const summary of await store.loadRecentChapterSummaries(workId, Number.MAX_SAFE_INTEGER, 10000)) {
      if (summary?.summary) insert.run('summary', String(summary.chapterNumber), summary.chapterNumber, summary.summary);
    }
    const latest = chapters.at(-1) ?? 0;
    const state = latest ? await store.loadStoryState(workId, latest) : null;
    for (const hook of state?.hooks ?? []) {
      // Dormant hooks stay searchable: they may come back.
      const { status } = normalizeHook(hook) ?? {};
      if (status === 'paid' || status === 'closed') continue;
      insert.run('hook', hook.id ?? '', hook.plantedAtChapter ?? 0, hook.text ?? '');
    }
    for (const entity of await store.loadEntitySnapshots(workId)) insert.run('entity', entity.entityId ?? entity.id ?? entity.canonicalName, entity.registeredAtChapter ?? 0, [entity.canonicalName, ...(entity.aliases ?? []), JSON.stringify(entity.attrs ?? {})].join(' '));
    return { rebuilt: true, backend, documents: Number(db.prepare('SELECT count(*) AS n FROM memory').get().n) };
  } finally { db.close(); }
}

export async function retrieveMemory({ store, workId, query, currentChapter, limit = 8, language }) {
  const rebuilt = await rebuildMemoryIndex({ store, workId, language });
  const queryTerms = searchTerms(query, language).slice(0, 16);
  if (!queryTerms.length) return { query, candidates: [], selected: [], ...rebuilt };
  const db = new DatabaseSync(store.sidecar('memory.db'), { readOnly: true });
  try {
    if (rebuilt.backend === 'sqlite-fts5-bm25') {
      const candidates = db.prepare('SELECT scope, ref, CAST(chapter AS INTEGER) AS chapter, text, -bm25(memory) AS score FROM memory WHERE memory MATCH ? ORDER BY bm25(memory) LIMIT ?').all(ftsQuery(queryTerms), Math.max(limit * 3, 12)).map((row) => ({ ...row, score: Number(row.score) }));
      const selected = candidates.filter((row) => row.scope !== 'summary' || row.chapter < currentChapter - 5).slice(0, limit);
      return { query, candidates, selected, ...rebuilt };
    }
    const rows = db.prepare('SELECT scope, ref, chapter, text, terms FROM memory').all();
    const documents = rows.map(({ terms: indexed, ...row }) => ({ ...row, tokens: indexed ? indexed.split(' ') : [] }));
    const averageLength = documents.reduce((sum, doc) => sum + doc.tokens.length, 0) / Math.max(documents.length, 1);
    const candidates = documents.map((document) => {
      let score = 0;
      for (const term of queryTerms) {
        const frequency = document.tokens.filter((token) => token === term || token.includes(term) || term.includes(token)).length;
        if (!frequency) continue;
        const containing = documents.filter((doc) => doc.tokens.some((token) => token === term || token.includes(term) || term.includes(token))).length;
        const idf = Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5));
        score += idf * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * document.tokens.length / Math.max(averageLength, 1)));
      }
      const { tokens: ignored, ...row } = document;
      return { ...row, score: Math.round(score * 10000) / 10000 };
    }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(limit * 3, 12));
    const selected = candidates
      .filter((row) => row.scope !== 'summary' || row.chapter < currentChapter - 5)
      .slice(0, limit);
    return { query, candidates, selected, ...rebuilt };
  } finally { db.close(); }
}

export function renderRetrievedMemory(result) {
  if (!result?.selected?.length) return '';
  return ['## 오래된 관련 기억 (검색 투영 — 아래 원문 정본에서 재구축됨)', ...result.selected.map((item) => `- [${item.scope}:${item.ref}${item.chapter ? ` · ${item.chapter}화` : ''}] ${item.text}`)].join('\n');
}

const STALE_AFTER = { next: 2, soon: 5, arc: 10, long: 16, finale: 24 };
export function hookDebt(hooks, currentChapter) {
  return (hooks ?? []).map(normalizeHook).filter(Boolean).flatMap((hook) => {
    if (!isHookActive(hook)) return [];
    const last = hook.lastMovedChapter ?? hook.plantedAtChapter ?? currentChapter;
    const threshold = STALE_AFTER[hook.horizon] ?? (hook.core ? 8 : 10);
    return currentChapter - last >= threshold ? [{ id: hook.id, staleFor: currentChapter - last, action: 'advance|pay|park' }] : [];
  });
}
