import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sharedSaga, sagaBinding, sagaScene, sceneMapAnswer } from './fixtures/shared-lore.js';
import { qualityStore, workId, outputs } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';
import { approvalResponse } from './fixtures/approval-response.js';
import { inspectWorkBinding, applyWorkBinding } from '../src/core/work-binding.js';
import { currentValidationContext } from '../src/core/validation-context.js';
import { createPublicationUnit } from '../src/core/publication-unit.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';
import { rollbackToSnapshot } from '../src/tools/snapshots.js';

const providers = { async complete(req) {
  if (req.step === 'shared-scene-map') return { text: sceneMapAnswer(req.messages.find(m => m.role === 'user').content) };
  return contractResponse(req) ?? approvalResponse(req) ?? { text: outputs[req.step] ?? '{}' };
} };
async function sources(root) {
  const rows = [];
  for (const dir of ['characters', 'chapters', 'world']) for (const name of (await readdir(join(root, dir)).catch(() => [])).sort()) rows.push([`${dir}/${name}`, await readFile(join(root, dir, name), 'utf8').catch(() => null)]);
  return rows;
}

// Temporary fixture only: a written legacy work moves onto a shared world.
it('migrates an existing work with a dry-run diff, no name merge, preserved prose, drift/stale blocks and rollback', async t => {
  const w = await sharedSaga(), store = await qualityStore();
  t.after(() => Promise.all([rm(w.root, { recursive: true, force: true }), rm(store.rootDir, { recursive: true, force: true })]));
  assert.equal((await runWriteWorkflow({ store, workId, autonomy: 'auto', providers })).status, 'completed');
  const beforeHead = (await createPublicationUnit({ rootDir: store.rootDir }).readPublished()).value.head;
  const beforeSources = await sources(store.rootDir), beforeWork = await readFile(join(store.rootDir, 'work.md'), 'utf8').catch(() => null);

  const binding = sagaBinding(w, workId, { 2: [sagaScene('s2', 'ts')] });
  const proposal = await inspectWorkBinding({ store, workId, worldRoot: w.root, binding });
  const m = proposal.migration;
  assert.equal(m.dryRun, true);
  assert.deepEqual(m.diff.find(d => d.target === 'intrinsic.gender'), { chapter: 2, localCharacterId: 'hero', target: 'intrinsic.gender', local: 'male', shared: 'female', change: 'differs' });
  assert.ok(m.ownership.every(o => o.from === 'work' && o.to === 'shared' && o.localCharacterId === 'hero'));
  assert.deepEqual(m.sameNameCandidates, []);
  assert.ok(m.preservedSources.some(p => p.startsWith('chapters/')));
  assert.ok(m.workOwned[0].keeps.includes('mutable'));
  assert.ok(proposal.impact.activeArc, 'plan impact is shown');
  assert.deepEqual(await sources(store.rootDir), beforeSources, 'inspect is a dry run');

  // Hand edits after review block apply; restoring them unblocks it.
  const chapterFile = beforeSources.find(([p]) => p.startsWith('chapters/'))[0];
  await writeFile(join(store.rootDir, chapterFile), `${beforeSources.find(([p]) => p === chapterFile)[1]}\n작가 손수정\n`);
  await assert.rejects(applyWorkBinding({ store, workId, proposalId: proposal.proposalId, expectedHead: proposal.expectedHead }), { code: 'WORKING_TREE_DRIFT' });
  await writeFile(join(store.rootDir, chapterFile), beforeSources.find(([p]) => p === chapterFile)[1]);
  const applied = await applyWorkBinding({ store, workId, proposalId: proposal.proposalId, expectedHead: proposal.expectedHead });
  assert.equal(applied.status, 'bound');
  assert.deepEqual(await sources(store.rootDir), beforeSources, 'prose and sheets are preserved as written');
  const local = await store.loadFoundation(workId);
  assert.deepEqual(local.characters.map(c => [c.id, c.intrinsic.gender]), [['hero', 'male']], 'no shared value is copied into the work sheet');
  // A chapter written before the binding is still validated with the input it was written with.
  const before1 = await currentValidationContext({ store, workId, chapter: 1 });
  assert.equal(before1.productionLock, null); assert.equal(before1.foundation.characters[0].intrinsic.gender, 'male');

  // Rollback restores the pre-migration publication; the reviewed proposal is then stale.
  await rollbackToSnapshot({ store, workId, chapter: 1 });
  const rolled = (await createPublicationUnit({ rootDir: store.rootDir }).readPublished()).value;
  assert.equal(rolled.tree.sharedLore ?? null, null);
  assert.equal(await readFile(join(store.rootDir, 'work.md'), 'utf8').catch(() => null), beforeWork);
  assert.notEqual(rolled.head, applied.head);
  const again = await inspectWorkBinding({ store, workId, worldRoot: w.root, binding });
  assert.equal(again.expectedHead, rolled.head);
  await assert.rejects(applyWorkBinding({ store, workId, proposalId: proposal.proposalId, expectedHead: proposal.expectedHead }), { code: 'STALE_WORK_BINDING' });
  assert.notEqual(beforeHead, null);
});

it('reports a same-name local character as a candidate and never merges it', async t => {
  const w = await sharedSaga(), store = await qualityStore();
  t.after(() => Promise.all([rm(w.root, { recursive: true, force: true }), rm(store.rootDir, { recursive: true, force: true })]));
  const foundation = await store.loadFoundation(workId);
  await store.saveFoundation({ ...foundation, characters: [...foundation.characters,
    { id: 'stranger', canonicalName: '윤재', aliases: [], registeredAtChapter: 1, intrinsic: { gender: 'female', ageBand: '10대', role: '동명이인', coreAppearance: [] }, mutable: {} },
    { id: 'nick', canonicalName: '재', aliases: ['윤재'], registeredAtChapter: 1, intrinsic: { gender: 'male', ageBand: '20대', role: '별명', coreAppearance: [] }, mutable: {} }] });
  const proposal = await inspectWorkBinding({ store, workId, worldRoot: w.root, binding: sagaBinding(w, workId, { 1: [sagaScene('s1', 'childhood')] }) });
  assert.deepEqual(proposal.migration.sameNameCandidates.map(c => [c.localCharacterId, c.entityIds, c.action]).sort(), [['nick', ['character-a'], 'not_merged'], ['stranger', ['character-a'], 'not_merged']]);
  assert.deepEqual(proposal.binding.cast.map(c => c.localCharacterId), ['hero']);
  assert.deepEqual(proposal.migration.diff.find(d => d.target === 'intrinsic.ageBand'), { chapter: 1, localCharacterId: 'hero', target: 'intrinsic.ageBand', local: '20대', shared: 'child', change: 'differs' });
});
