import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runInit } from '../src/tools/init.js';
import { runCommit, runStatus } from '../src/tools/commit.js';
import { rollbackToSnapshot, resumePendingRollback } from '../src/tools/snapshots.js';
import { createHostRelay } from '../src/provider/host-relay.js';

const workId = 'rollback-test';
const delta = (chapterNumber) => ({ chapterNumber, appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], hookChanges: [], mutableChanges: [], trackedEntityOps: [] });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vibelore-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MarkdownStateStore(root);
  await runInit({ store, workId, genre: 'other', worldFacts: ['문은 열쇠로 열린다.'] });
  for (const chapter of [1, 2]) await runCommit({ store, workId, chapter, prose: `${chapter}번째 문을 열었다.`, summary: `${chapter}번째 문.`, delta: delta(chapter), providers: createHostRelay({}) });
  return store;
}

test('rollback agrees with published status and allows writing the replacement chapter', async (t) => {
  const store = await fixture(t);
  await rollbackToSnapshot({ store, workId, chapter: 1 });
  const status = await runStatus({ store, workId });
  assert.deepEqual(status.chapters.numbers, [1]);
  assert.equal(status.nextChapter, 2);
  assert.equal(status.workingTree.status, 'clean');
  await runCommit({ store, workId, chapter: 2, prose: '이번에는 새 문을 열었다.', summary: '새 문.', delta: delta(2), providers: createHostRelay({}) });
  assert.match((await store.loadArtifact(workId, 2)).prose, /새 문/);
  assert.equal((await runStatus({ store, workId })).nextChapter, 3);
});

for (const chapter of ['../../../fake', '1', 0, -1, 1.5, null]) {
  test(`rejects invalid rollback chapter ${JSON.stringify(chapter)} without changes`, async (t) => {
    const store = await fixture(t);
    const before = await readFile(store.settingPath);
    await assert.rejects(rollbackToSnapshot({ store, workId, chapter }), /INVALID_CHAPTER/);
    assert.deepEqual(await readFile(store.settingPath), before);
    assert.deepEqual(await store.listChapters(), [1, 2]);
  });
}

for (const corruption of ['empty manifest', 'wrong work', 'tampered chapter', 'missing chapter', 'symlink']) {
  test(`rejects ${corruption} before changing the live work`, async (t) => {
    const store = await fixture(t);
    const base = store.sidecar('snapshots', '1');
    const manifestPath = join(base, 'manifest.json');
    const chapterPath = join(base, 'canonical', 'chapters', '001.md');
    if (corruption === 'empty manifest') await writeFile(manifestPath, '{}');
    if (corruption === 'wrong work') {
      const manifest = JSON.parse(await readFile(manifestPath));
      manifest.workId = 'someone-else'; await writeFile(manifestPath, JSON.stringify(manifest));
    }
    if (corruption === 'tampered chapter') await writeFile(chapterPath, '변조한 문장');
    if (corruption === 'missing chapter') await rm(chapterPath);
    if (corruption === 'symlink') { await rm(chapterPath); await symlink(store.chapterPath(2), chapterPath); }
    const before = await readFile(store.settingPath);
    await assert.rejects(rollbackToSnapshot({ store, workId, chapter: 1 }), /SNAPSHOT/);
    assert.deepEqual(await readFile(store.settingPath), before);
    assert.deepEqual(await store.listChapters(), [1, 2]);
  });
}

for (const failAt of ['afterPublication', 'after:world', 'after:chapters']) {
  test(`resumes interrupted rollback at ${failAt} and removes stale authorizations`, async (t) => {
    const store = await fixture(t);
    await store.saveWorkflow(workId, { workflowId: 'old-workflow', workId, chapter: 2, stage: 'awaiting_draft_approval', approvalId: 'old-approval' });
    await store.saveCheckReceipt(workId, { checkId: 'old-receipt', chapter: 2, verdict: 'passed' });
    await mkdir(store.sidecar('runs'), { recursive: true });
    await writeFile(store.sidecar('runs', 'run-old.json'), '{}');
    await assert.rejects(rollbackToSnapshot({ store, workId, chapter: 1, failAt }), /injected rollback interruption/);
    const result = await resumePendingRollback({ store });
    const status = await runStatus({ store, workId });
    assert.equal(status.nextChapter, 2);
    assert.equal(status.workingTree.status, 'clean');
    assert.equal(await store.loadWorkflow(workId), null);
    assert.equal(await store.loadCheckReceipt(workId, 'old-receipt'), null);
    assert.ok((await readFile(store.sidecar('rollback-archives', result.archiveId, 'before', 'machine', 'runs', 'run-old.json'), 'utf8')));
    assert.equal(await resumePendingRollback({ store }), null);
  });
}
