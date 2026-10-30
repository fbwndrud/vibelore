import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runCreativeDecisionTool } from '../src/tools/creative-decisions.js';
import { legacyWorkFixture } from './fixtures/legacy-work.js';
import { heroCharacter } from './fixtures/quality-workflow.js';

const workId = 'decision-tool';
const times = ['2026-10-28T01:00:00.000Z', '2026-10-28T02:00:00.000Z', '2026-10-28T03:00:00.000Z'];

async function tool(t) {
  const root = await mkdtemp(join(tmpdir(), 'vibelore-decision-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MarkdownStateStore(root);
  await legacyWorkFixture({ store, workId, characters: [heroCharacter] });
  let tick = 0;
  return { store, call: (args) => runCreativeDecisionTool({ store, workId, now: () => times[tick++], ...args }) };
}

test('status on a work without decisions is empty and writes nothing', async (t) => {
  const { store, call } = await tool(t);
  const status = await call({ action: 'status' });
  assert.deepEqual({ ...status, nextAction: undefined }, { revision: 0, active: [], retired: [], nextAction: undefined });
  assert.match(status.nextAction, /부드러운 지침/);
  assert.equal(await store.loadCreativeDecisions(workId), null);
});

test('adopt, supersede and retire are recorded with the user answer and dates', async (t) => {
  const { call } = await tool(t);
  const adopted = await call({ action: 'adopt', level: 'subject', subjectId: 'hero', topic: '말투',
    statement: '윤재는 누구에게나 반말을 쓴다.', userAnswer: '윤재는 항상 반말로 말해' });
  assert.equal(adopted.revision, 1);
  assert.deepEqual(adopted.adopted, {
    id: 'dec-1', status: 'active', kind: 'preference', topic: '말투', statement: '윤재는 누구에게나 반말을 쓴다.',
    scope: { level: 'subject', ref: { kind: 'character', id: 'hero' } }, userAnswer: '윤재는 항상 반말로 말해',
    supersedes: null, adoptedAt: times[0], retiredAt: null,
  });
  assert.match(adopted.nextAction, /다음 lore_write/);
  const superseded = await call({ action: 'adopt', level: 'subject', subjectId: 'hero', supersedes: 'dec-1',
    statement: '윤재는 어른에게만 존댓말을 쓴다.', userAnswer: '어른한테는 존댓말 쓰게 해 줘' });
  assert.deepEqual([superseded.adopted.id, superseded.retired.id, superseded.retired.retiredAt], ['dec-2', 'dec-1', times[1]]);
  const retired = await call({ action: 'retire', id: 'dec-2' });
  assert.deepEqual([retired.revision, retired.retired.status, retired.retired.retiredAt], [3, 'retired', times[2]]);
  const status = await call({ action: 'status' });
  assert.equal(status.revision, 3);
  assert.deepEqual(status.active, []);
  assert.deepEqual(status.retired.map((item) => [item.id, item.userAnswer]),
    [['dec-1', '윤재는 항상 반말로 말해'], ['dec-2', '어른한테는 존댓말 쓰게 해 줘']]);
});

test('refusals keep their codes and leave the stored ledger unchanged', async (t) => {
  const { store, call } = await tool(t);
  await call({ action: 'adopt', level: 'subject', subjectId: 'hero', statement: '윤재는 반말을 쓴다.', userAnswer: '윤재는 반말' });
  const path = join(store.rootDir, '.vibelore', 'creative-decisions.json');
  const before = await readFile(path, 'utf8');
  await assert.rejects(call({ action: 'adopt', level: 'work', statement: '모두 반말을 쓴다.', userAnswer: '윤재는 반말' }),
    { code: 'CREATIVE_DECISION_SCOPE_WIDENED' });
  await assert.rejects(call({ action: 'adopt', level: 'personal', statement: '반말', userAnswer: '내 모든 작품에서 반말' }),
    { code: 'INVALID_CREATIVE_DECISION' });
  await assert.rejects(call({ action: 'retire', id: 'dec-5' }), { code: 'INVALID_CREATIVE_DECISION' });
  await assert.rejects(call({ action: 'forget' }), /INVALID_ARGUMENT/);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('a damaged stored ledger is refused by every action and left untouched', async (t) => {
  const { store, call } = await tool(t);
  await call({ action: 'adopt', level: 'work', statement: '건조하게 쓴다.', userAnswer: '건조하게' });
  const path = join(store.rootDir, '.vibelore', 'creative-decisions.json');
  for (const damaged of [(ledger) => ({ ...ledger, items: [null] }), (ledger) => ({ ...ledger, items: [{ ...ledger.items[0], evidence: undefined }] })]) {
    await writeFile(path, JSON.stringify(damaged(JSON.parse(await readFile(path, 'utf8')))));
    const before = await readFile(path, 'utf8');
    for (const args of [{ action: 'status' }, { action: 'retire', id: 'dec-1' },
      { action: 'adopt', level: 'work', statement: '다른 선호.', userAnswer: '다른 말' }]) {
      await assert.rejects(call(args), { code: 'INVALID_CREATIVE_DECISION' });
    }
    assert.equal(await readFile(path, 'utf8'), before);
  }
  await writeFile(path, '{ broken');
  await assert.rejects(call({ action: 'status' }), { code: 'INVALID_CREATIVE_DECISION' });
});

test('an empty subjectId from an MCP host counts as absent for a work decision', async (t) => {
  const { call } = await tool(t);
  const adopted = await call({ action: 'adopt', level: 'work', subjectId: '', statement: '건조하게 쓴다.', userAnswer: '건조하게' });
  assert.deepEqual(adopted.adopted.scope, { level: 'work', ref: { kind: 'work', id: workId } });
  await assert.rejects(call({ action: 'adopt', level: 'subject', subjectId: '', statement: '반말.', userAnswer: '반말' }),
    { code: 'INVALID_CREATIVE_DECISION' });
});

test('adopt and retire refuse a work that does not exist here and write nothing', async (t) => {
  const { store, call } = await tool(t);
  const path = join(store.rootDir, '.vibelore', 'creative-decisions.json');
  const adoptArgs = { action: 'adopt', level: 'work', statement: '건조하게 쓴다.', userAnswer: '건조하게' };
  await assert.rejects(call({ ...adoptArgs, workId: 'typo-work' }), /작품이 없습니다/);
  await assert.rejects(call({ action: 'retire', id: 'dec-1', workId: 'typo-work' }), /작품이 없습니다/);
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' });
  // an empty project has no work for any id
  const empty = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-decision-empty-')));
  t.after(() => rm(empty.rootDir, { recursive: true, force: true }));
  await assert.rejects(runCreativeDecisionTool({ store: empty, workId, ...adoptArgs }), /작품이 없습니다/);
  await assert.rejects(readFile(join(empty.rootDir, '.vibelore', 'creative-decisions.json'), 'utf8'), { code: 'ENOENT' });
  assert.equal((await call({ ...adoptArgs })).adopted.id, 'dec-1');
});

test('adopting for an unknown character is refused without a write, and retire needs no character', async (t) => {
  const { store, call } = await tool(t);
  await assert.rejects(call({ action: 'adopt', level: 'subject', subjectId: '윤재', statement: '윤재는 반말을 쓴다.', userAnswer: '윤재는 반말' }),
    (error) => error.code === 'INVALID_CREATIVE_DECISION' && /hero/.test(error.message));
  assert.equal(await store.loadCreativeDecisions(workId), null);
  await call({ action: 'adopt', level: 'subject', subjectId: 'hero', statement: '윤재는 반말을 쓴다.', userAnswer: '윤재는 반말' });
  const foundation = await store.loadFoundation(workId);
  await store.saveFoundation({ ...foundation, characters: [] });
  assert.equal((await call({ action: 'retire', id: 'dec-1' })).retired.status, 'retired');
});
