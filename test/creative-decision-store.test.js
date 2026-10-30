import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { legacyWorkFixture } from './fixtures/legacy-work.js';
import { runCommit, runStatus } from '../src/tools/commit.js';
import { rollbackToSnapshot } from '../src/tools/snapshots.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { adoptCreativeDecision } from '../src/core/creative-decision-ledger.js';

const workId = 'decision-store';
const delta = (chapterNumber) => ({ chapterNumber, appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], hookChanges: [], mutableChanges: [], trackedEntityOps: [] });
const ledger = adoptCreativeDecision(null, { level: 'work', statement: '서술은 건조하게 쓴다.', userAnswer: '좀 더 건조하게' },
  { workId, at: '2026-10-28T01:00:00.000Z' }).ledger;

async function committedWork(t) {
  const root = await mkdtemp(join(tmpdir(), 'vibelore-decision-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MarkdownStateStore(root);
  await legacyWorkFixture({ store, workId, genre: 'other', worldFacts: ['문은 열쇠로 열린다.'] });
  for (const chapter of [1, 2]) await runCommit({ store, workId, chapter, prose: `${chapter}번째 문을 열었다.`, summary: `${chapter}번째 문.`, delta: delta(chapter), providers: createHostRelay({}) });
  return store;
}

test('the ledger round-trips as machine state and never shows up as working-tree drift', async (t) => {
  const store = await committedWork(t);
  assert.equal(await store.loadCreativeDecisions(workId), null);
  await store.saveCreativeDecisions(workId, ledger);
  assert.deepEqual(await store.loadCreativeDecisions(workId), ledger);
  assert.deepEqual(JSON.parse(await readFile(join(store.rootDir, '.vibelore', 'creative-decisions.json'), 'utf8')), ledger);
  assert.equal((await runStatus({ store, workId })).workingTree.status, 'clean');
});

test('chapter rollback keeps the user preferences', async (t) => {
  const store = await committedWork(t);
  await store.saveCreativeDecisions(workId, ledger);
  await rollbackToSnapshot({ store, workId, chapter: 1 });
  assert.deepEqual((await runStatus({ store, workId })).chapters.numbers, [1]);
  assert.deepEqual(await store.loadCreativeDecisions(workId), ledger);
});

test('an unparsable ledger file fails with the decision error code, and other state is untouched', async (t) => {
  const store = await committedWork(t);
  const path = join(store.rootDir, '.vibelore', 'creative-decisions.json');
  for (const raw of ['{ not json', '']) {
    await writeFile(path, raw);
    await assert.rejects(store.loadCreativeDecisions(workId), { code: 'INVALID_CREATIVE_DECISION', message: /damaged/ });
  }
});

test('saving leaves no temporary file behind and replaces the ledger whole', async (t) => {
  const store = await committedWork(t);
  await store.saveCreativeDecisions(workId, ledger);
  await store.saveCreativeDecisions(workId, { ...ledger, revision: 2 });
  assert.equal((await store.loadCreativeDecisions(workId)).revision, 2);
  assert.deepEqual((await readdir(join(store.rootDir, '.vibelore'))).filter((name) => name.startsWith('creative-decisions')), ['creative-decisions.json']);
});
