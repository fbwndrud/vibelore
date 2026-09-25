/**
 * buildContext threads the work's prompt family into the entity-context,
 * sliding-window and memory budgets. ko works keep the exact 52e5aee flat
 * `/ 2` estimates (same entities, same summaries, same `used ~Nt` headings);
 * other families use script-aware tokenUnits() and stop over-trimming Latin.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runInit } from '../src/tools/init.js';
import { approvalFixtureProvider } from './fixtures/approval-response.js';
import { buildContext } from '../src/tools/context.js';
import { tokenUnits } from '../src/core/token-units.js';
import { resolveWorkLanguage } from '../src/core/work-language.js';

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

describe('entity and summary section labels follow the prompt family', () => {
  it('en: the writing context headings carry no Hangul; only user-authored canon may', async () => {
    const { context } = await work('en');
    const lines = context.split('\n');
    // Section headings and the bracketed notes the renderers add.
    const labels = lines.filter((line) => /^## /.test(line) || /^\(.*\)$/.test(line));
    const hangul = labels.filter((line) => /[\p{Script=Hangul}]/u.test(line));
    assert.deepEqual(hangul, [], `Korean labels in an en context: ${hangul.join(' | ')}`);
    assert.ok(lines.some((line) => /^## Entities on stage this chapter \(12, budget 2000t, used ~\d+t\)$/.test(line)));
    assert.ok(lines.some((line) => /^## Recent 5 chapter summaries \(sliding window, budget 12000t, used ~\d+t\)$/.test(line)));
    assert.ok(lines.some((line) => line.startsWith('- Chapter 7: ')));
    // Any Hangul left in the whole context must come from canon the user wrote, never from labels.
    const hangulLines = lines.filter((line) => /[\p{Script=Hangul}]/u.test(line));
    for (const line of hangulLines) assert.ok(!/^## |^\(|^- (화|Chapter) /.test(line), `label line with Hangul: ${line}`);
  });

  it('ko: the entity and summary labels stay Korean, byte for byte', async () => {
    const { context } = await work('ko');
    const lines = context.split('\n');
    assert.ok(lines.includes('## 이번 화 무대 entity (7개, budget 2000t, used ~1771t)'));
    assert.ok(lines.includes('## 최근 5 화 요약 (sliding window, budget 12000t, used ~6040t)'));
    assert.ok(lines.some((line) => line.startsWith('- 화 7: ')));
  });

  it('a non-ko work still stored as canonical v1 gets English labels matching its English prompt', async () => {
    const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-budget-family-v1en-')));
    await runInit({ store, workId: 'w', genre: 'other', language: 'en', povMode: '3인칭제한', worldFacts: ['The tower taxes every reward.'], providers: approvalFixtureProvider() });
    // A pre-release 0.4 work: no format-version key and no creation record, so it resolves to v1.
    const setting = join(store.rootDir, 'world', 'setting.md');
    await writeFile(setting, (await readFile(setting, 'utf8')).replace(/^canonicalFormatVersion: 2\n/m, '').replace('## World facts', '## 세계 사실'));
    await rm(store.sidecar('accepted-creation.json'), { force: true });
    assert.equal((await resolveWorkLanguage({ store, workId: 'w' })).canonicalFormatVersion, 1);
    await store.saveEntitySnapshots('w', [{ entityId: 'e0', kind: 'location', canonicalName: 'Harbor Gate', aliases: [], status: 'active', attrs: { tier: 'S' } }]);
    await store.saveChapterSummary({ workId: 'w', chapterNumber: 1, summary: 'The keeper counted planks.' });
    const scene = { settings: ['e0'], characters: [], items: [], antagonists: [], additionalRefs: [] };
    const { context } = await buildContext({ store, workId: 'w', chapter: 2, scene });
    const labels = context.split('\n').filter((line) => /^## |^\(.*\)$|^- (화|Chapter) /.test(line));
    assert.deepEqual(labels.filter((line) => /[\p{Script=Hangul}]/u.test(line)), []);
    assert.ok(context.includes('## Entities on stage this chapter (1, budget 2000t'));
    assert.ok(context.includes('## Recent 1 chapter summaries (sliding window'));
  });
});

describe('buildContext passes the family to MemoryCompiler', () => {
  const legacyMemory = (value) => Math.max(1, Math.ceil([...String(value)].length / 2));
  it('en: the mandatory recall set is measured with tokenUnits', async () => {
    const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-budget-memory-en-')));
    await runInit({ store, workId: 'w', genre: 'other', language: 'en', povMode: '3인칭제한', worldFacts: ['The tower taxes every reward, and the harbor council keeps the ledger.'], providers: approvalFixtureProvider() });
    await buildContext({ store, workId: 'w', chapter: 1 });
    const usage = (await store.loadContextTrace('w', 1)).retrieval.compiled.usage;
    const fact = 'The tower taxes every reward, and the harbor council keeps the ledger.';
    assert.ok(tokenUnits(fact) < legacyMemory(fact));
    assert.equal(usage.mandatoryTokens, tokenUnits(fact));
  });
  it('ko: the mandatory recall set keeps the legacy code-point / 2 estimate', async () => {
    const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-budget-memory-ko-')));
    const fact = '탑은 모든 보상에 세금을 매긴다. "status": "active", see docs/notes.md for the ledger.';
    await runInit({ store, workId: 'w', genre: 'other', povMode: '3인칭제한', worldFacts: [fact], providers: approvalFixtureProvider() });
    await buildContext({ store, workId: 'w', chapter: 1 });
    const usage = (await store.loadContextTrace('w', 1)).retrieval.compiled.usage;
    assert.ok(tokenUnits(fact) < legacyMemory(fact));
    assert.equal(usage.mandatoryTokens, legacyMemory(fact));
  });
});
