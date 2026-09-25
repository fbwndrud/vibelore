/**
 * buildContext threads the work's prompt family into the entity-context,
 * sliding-window and memory budgets. ko works keep the exact 52e5aee flat
 * `/ 2` estimates (same entities, same summaries, same `used ~Nt` headings);
 * other families use script-aware tokenUnits() and stop over-trimming Latin.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runInit } from '../src/tools/init.js';
import { approvalFixtureProvider } from './fixtures/approval-response.js';
import { buildContext } from '../src/tools/context.js';
import { tokenUnits } from '../src/core/token-units.js';

const mixedKo = (n, seed) => {
  const u = `- (${seed}) 등대지기는 수리공이 도착하기 전에 널빤지를 세었다. "status": "active", "tags": ["harbor", "council"], see docs/notes.md. `;
  return u.repeat(Math.ceil(n / u.length)).slice(0, n);
};
const latin = (n, seed) => {
  const u = `(${seed}) The keeper counts planks before the repairman arrives; "status": "active". `;
  return u.repeat(Math.ceil(n / u.length)).slice(0, n);
};
const legacy = (text) => Math.ceil(text.length / 2);

async function work(lang) {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), `vibelore-budget-family-${lang}-`)));
  await runInit({
    store, workId: 'w', genre: 'other', ...(lang === 'en' ? { language: 'en' } : {}), povMode: '3인칭제한',
    worldFacts: [lang === 'en' ? 'The tower taxes every reward.' : '탑은 모든 보상에 세금을 매긴다.'],
    providers: approvalFixtureProvider(),
  });
  const text = lang === 'en' ? latin : mixedKo;
  const snaps = Array.from({ length: 12 }, (_, i) => ({
    entityId: `e${i}`, kind: 'location', canonicalName: lang === 'en' ? `Harbor Gate ${i}` : `항구 관문 ${i}`,
    aliases: [], status: 'active', attrs: { note: text(420, i), tier: 'S' },
  }));
  await store.saveEntitySnapshots('w', snaps);
  for (let c = 1; c <= 7; c += 1) await store.saveChapterSummary({ workId: 'w', chapterNumber: c, summary: text(2400, c) });
  const scene = { settings: snaps.map((s) => s.entityId), characters: [], items: [], antagonists: [], additionalRefs: [], entityIds: ['harbor'] };
  const { context } = await buildContext({ store, workId: 'w', chapter: 8, scene });
  return { context, snaps };
}
const entityLines = (context) => context.split('\n').filter((line) => /^- \[location\] /.test(line));

describe('buildContext budgets follow the work prompt family', () => {
  it('ko: same entities and `used ~Nt` headings as 52e5aee (legacy / 2)', async () => {
    const { context, snaps } = await work('ko');
    const lines = context.split('\n');
    // golden headings recorded at 52e5aee on this exact fixture
    assert.ok(lines.includes('## 이번 화 무대 entity (7개, budget 2000t, used ~1771t)'));
    assert.ok(lines.includes('(token budget 으로 5 개 생략)'));
    assert.ok(lines.includes('## 최근 5 화 요약 (sliding window, budget 12000t, used ~6040t)'));
    assert.equal(entityLines(context).length, 7);
    const used = snaps.slice(0, 7).reduce((sum, e) => sum + legacy(e.canonicalName) + legacy(JSON.stringify(e.attrs)) + 8, 0);
    assert.equal(used, 1771);
  });

  it('en: every staged entity fits and the heading reports the tokenUnits cost', async () => {
    const { context, snaps } = await work('en');
    assert.equal(entityLines(context).length, 12, 'the flat / 2 estimate injected only 8 of 12');
    const used = snaps.reduce((sum, e) => sum + tokenUnits(e.canonicalName) + tokenUnits(JSON.stringify(e.attrs)) + 8, 0);
    assert.ok(context.includes(`used ~${used}t`), `expected entity heading with used ~${used}t`);
    assert.ok(!context.includes('token budget 으로 4 개 생략'));
  });
});
