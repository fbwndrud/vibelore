import { join, isAbsolute, resolve } from 'node:path';
import { unlink } from 'node:fs/promises';
import { createWorkBinding, validateWorkBinding, prepareLoreProduction } from '../../engine/src/lore/production.js';
import { hashLore, isLoreRevisionId } from '../../engine/src/lore/registry.js';
import { requireLore } from '../../engine/src/lore/schemas.js';
import { UniverseStore } from '../store/universe-store.js';
import { createPublicationUnit } from './publication-unit.js';
import { fingerprintWorkingTree, detectWorkingTreeDrift, captureWorkingTreeFingerprint, SHARED_LORE_SECTION_BEGIN } from './working-tree-sync.js';
import { loreReadText, loreReadJson, loreWriteText, loreWriteJson } from './lore-files.js';
import { renderProductionContext } from './production-input.js';
import { workMigrationReport } from './work-migration.js';

const begin = SHARED_LORE_SECTION_BEGIN, end = '<!-- shared-lore:end -->';
function bindingSource(previous, sharedLore) {
  const section = `${begin}\n## SharedLore binding\n\n\`\`\`json\n${JSON.stringify(sharedLore, null, 2)}\n\`\`\`\n${end}`;
  if (!(previous ?? '').includes(begin)) return `${previous ?? '# 작품 연결\n'}\n${section}\n`;
  const start = previous.indexOf(begin), finish = previous.indexOf(end, start);
  requireLore(finish >= 0 && previous.indexOf(begin, start + begin.length) === -1, 'INVALID_LORE_DATA', 'malformed work.md binding section');
  return previous.slice(0, start) + section + previous.slice(finish + end.length);
}
async function currentWork(store, workId) {
  const unit = createPublicationUnit({ rootDir: store.rootDir }), published = await unit.readPublished();
  requireLore(published.ok, 'LORE_INTEGRITY', 'work publication corrupt');
  requireLore(!published.value || published.value.tree.workId === workId, 'INVALID_LORE_DATA', 'workId mismatch');
  const foundation = published.value?.tree.foundation ?? await store.loadFoundation(workId);
  requireLore(foundation?.workId === workId, 'INVALID_LORE_DATA', 'initialize the work before binding');
  requireLore(published.value || !(await store.listChapters()).length, 'SHARED_LORE_MIGRATION_REQUIRED', 'publish existing legacy chapters before binding');
  return { unit, published: published.value, foundation };
}
export async function inspectWorkBinding({ store, workId, binding: input, worldRoot }) {
  requireLore(isAbsolute(worldRoot ?? '') && resolve(worldRoot) !== resolve(store.rootDir), 'INVALID_LORE_DATA', 'use a separate absolute worldRoot');
  const binding = createWorkBinding(input);
  requireLore(binding.workId === workId, 'INVALID_LORE_DATA', 'binding workId mismatch');
  const current = await currentWork(store, workId);
  if (current.published) {
    const drift = await detectWorkingTreeDrift({ store, sourceHead: current.published.head });
    requireLore(drift.status === 'clean', 'WORKING_TREE_DRIFT', 'sync work edits before binding', drift);
  }
  requireLore(binding.cast.every(c => current.foundation.characters.some(local => local.id === c.localCharacterId)), 'INVALID_ENTITY_REFERENCE', 'binding local cast must exist');
  const world = new UniverseStore(worldRoot, binding.universeId), worldStatus = await world.status();
  requireLore(worldStatus.drift.status === 'clean', 'SHARED_LORE_SOURCE_DRIFT', 'adopt world edits before binding');
  const publication = await world.read(binding.loreRevisionId), previews = [];
  for (const context of binding.chapters) {
    const prepared = prepareLoreProduction({ binding, publication, chapter: context.chapter });
    requireLore(prepared.status === 'ready', 'SHARED_LORE_UNRESOLVED', `chapter ${context.chapter}`, prepared.blockers);
    renderProductionContext(prepared.lock, current.foundation);
    previews.push({ chapter: context.chapter, productionLockId: prepared.lock.revisionId, scenes: prepared.lock.scenes, projections: prepared.lock.projections, ...(prepared.lock.sceneVarying ? { sceneVarying: prepared.lock.sceneVarying } : {}) });
  }
  const before = await loreReadText(store.rootDir, join(store.rootDir, 'work.md'));
  const sharedLore = { worldRoot, binding };
  const fingerprint = await fingerprintWorkingTree(store.rootDir);
  const proposal = { schemaVersion: 1, workId, expectedHead: current.published?.head ?? null, sharedLore, before, after: bindingSource(before, sharedLore), sourceDigest: fingerprint.digest, sourceInventory: fingerprint.inventory };
  const proposalId = hashLore(proposal), path = join(store.rootDir, '.vibelore', 'shared-lore', 'work-proposals', `${proposalId.slice(7)}.json`);
  await loreWriteJson(store.rootDir, path, proposal, { immutable: true });
  const migration = workMigrationReport({ foundation: current.foundation, binding, publication, previews, inventory: fingerprint.inventory });
  return { status: 'awaiting_approval', proposalId, expectedHead: proposal.expectedHead, binding, previews, migration, impact: {
    previousBindingRevisionId: current.published?.tree.sharedLore?.binding.revisionId ?? null,
    invalidatesExistingReceipts: true, planReview: 'shared fields or scene contexts changed; review active arc/episode promises before applying',
    activeArc: await store.loadArcPlan(workId), nextEpisode: await store.loadEpisodePlan(workId, binding.chapters[0].chapter),
  } };
}
export async function applyWorkBinding({ store, workId, proposalId, expectedHead, failAfterHead = false }) {
  requireLore(isLoreRevisionId(proposalId), 'INVALID_LORE_DATA', 'invalid binding proposal ID');
  const path = join(store.rootDir, '.vibelore', 'shared-lore', 'work-proposals', `${proposalId.slice(7)}.json`);
  const proposal = await loreReadJson(store.rootDir, path);
  requireLore(proposal && hashLore(proposal) === proposalId && proposal.workId === workId, 'LORE_INTEGRITY', 'binding proposal mismatch');
  const current = await currentWork(store, workId);
  requireLore(expectedHead === proposal.expectedHead && (current.published?.head ?? null) === expectedHead, 'STALE_WORK_BINDING', 'work HEAD changed after review');
  requireLore((await fingerprintWorkingTree(store.rootDir)).digest === proposal.sourceDigest && await loreReadText(store.rootDir, join(store.rootDir, 'work.md')) === proposal.before, 'WORKING_TREE_DRIFT', 'work sources changed after review');
  const { binding, worldRoot } = proposal.sharedLore; validateWorkBinding(binding);
  const world = new UniverseStore(worldRoot, binding.universeId);
  requireLore((await world.status()).drift.status === 'clean', 'SHARED_LORE_SOURCE_DRIFT', 'world sources changed after review');
  const publication = await world.read(binding.loreRevisionId);
  for (const context of binding.chapters) requireLore(prepareLoreProduction({ binding, publication, chapter: context.chapter }).status === 'ready', 'SHARED_LORE_UNRESOLVED', `chapter ${context.chapter}`);
  const token = await current.unit.issueFencingToken(), lastChapter = Math.max(0, ...Object.keys(current.published?.tree.chapters ?? {}).map(Number));
  const pendingPath = join(store.rootDir, '.vibelore', 'shared-lore', 'binding-pending.json');
  await loreWriteJson(store.rootDir, pendingPath, { proposalId });
  const result = await current.unit.publish({ context: {
    snapshotId: `shared-binding:${proposalId}`, expectedHead, storyTimeScope: { worldline: binding.continuityId, through: lastChapter }, publicationOrder: lastChapter + 1,
    transactionTime: new Date().toISOString(), policyRevision: 'shared-lore-binding-v1', semanticGeneration: 'shared-lore-binding-v1', fencingToken: token.value.fencingToken,
  }, candidate: { tree: { workId, foundation: current.foundation, sharedLore: { ...proposal.sharedLore, bindingSource: proposal.after } }, projections: {}, impactClosure: [] } });
  if (!result.ok) { await unlink(pendingPath); requireLore(false, 'STALE_WORK_BINDING', result.error?.code ?? 'binding publication failed'); }
  if (failAfterHead) throw new Error('injected work binding materialization interruption');
  await resumePendingWorkBinding({ store });
  return { status: 'bound', head: result.value.head, bindingRevisionId: binding.revisionId, loreRevisionId: binding.loreRevisionId };
}
/** Called under the work lock. A journal authorizes only these already approved bytes. */
export async function resumePendingWorkBinding({ store }) {
  const pendingPath = join(store.rootDir, '.vibelore', 'shared-lore', 'binding-pending.json'), journal = await loreReadJson(store.rootDir, pendingPath);
  if (!journal) return null;
  requireLore(isLoreRevisionId(journal.proposalId), 'LORE_INTEGRITY', 'invalid binding recovery journal');
  const proposal = await loreReadJson(store.rootDir, join(store.rootDir, '.vibelore', 'shared-lore', 'work-proposals', `${journal.proposalId.slice(7)}.json`));
  requireLore(proposal && hashLore(proposal) === journal.proposalId, 'LORE_INTEGRITY', 'binding recovery proposal mismatch');
  const published = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
  requireLore(published.ok, 'LORE_INTEGRITY', 'work recovery publication corrupt');
  if ((published.value?.head ?? null) === proposal.expectedHead) { await unlink(pendingPath); return { status: 'not_published' }; }
  requireLore(published.value?.tree.sharedLore?.binding.revisionId === proposal.sharedLore.binding.revisionId && published.value.tree.sharedLore.bindingSource === proposal.after, 'STALE_WORK_BINDING', 'published binding differs from recovery candidate');
  const actual = await fingerprintWorkingTree(store.rootDir);
  const digestWithoutBinding = rows => hashLore(rows.filter(r => r.path !== 'work.md').map(({ path, contentDigest }) => ({ path, contentDigest })));
  requireLore(digestWithoutBinding(actual.inventory) === digestWithoutBinding(proposal.sourceInventory), 'WORKING_TREE_DRIFT', 'unrelated work sources changed during binding recovery');
  const source = await loreReadText(store.rootDir, join(store.rootDir, 'work.md'));
  requireLore(source === proposal.before || source === proposal.after, 'WORKING_TREE_DRIFT', 'work.md has new human edits; preserve them before recovery');
  await loreWriteText(store.rootDir, join(store.rootDir, 'work.md'), proposal.after);
  await captureWorkingTreeFingerprint({ store, sourceHead: published.value.head });
  await unlink(pendingPath);
  return { status: 'recovered', head: published.value.head };
}
export async function workBindingStatus({ store, workId }) {
  const current = await currentWork(store, workId);
  return { status: 'ok', head: current.published?.head ?? null, sharedLore: current.published?.tree.sharedLore ?? null };
}
