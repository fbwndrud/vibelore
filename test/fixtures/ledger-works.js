import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MarkdownStateStore } from '../../src/store/markdown-store.js';
import { emptyStoryState } from '../../engine/src/continuity/story-state.js';

export const ledgerWorkId = 'ledger-legacy';
const base = (chapterNumber) => ({ chapterNumber, appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], mutableChanges: [] });

/**
 * Two chapters committed before the ledger: tracked-entity ops name the same
 * note twice ('서명 쪽지', '재서명된 쪽지') and one knowledge record, and the
 * matching story states carry `trackedEntities` and no `ledger`.
 */
export async function addLegacyChapters(store, workId = ledgerWorkId) {
  const note = { kind: 'Artifact', data: { name: '서명 쪽지', holder: 'c1' } };
  const renamed = { kind: 'Artifact', data: { name: '재서명된 쪽지', holder: 'c2' } };
  const secret = { kind: 'KnowledgeMatrix', data: { name: '은빛 열쇠', knownBy: 'c1' } };
  await store.saveArtifact({ workId, chapterNumber: 1, prose: '가', delta: { ...base(1),
    hookChanges: [{ id: 'wrist', text: '손목', phase: 'planted' }], trackedEntityOps: [note, secret] } });
  await store.saveArtifact({ workId, chapterNumber: 2, prose: '나', delta: { ...base(2), trackedEntityOps: [renamed] } });
  const tracked = (op, chapter) => ({ kind: op.kind, data: op.data, updatedChapter: chapter });
  const legacyState = (chapterNumber, trackedEntities) => {
    const { ledger: _ledger, ...state } = emptyStoryState(workId);
    return { ...state, chapterNumber, hooks: [{ id: 'wrist', text: '손목', phase: 'planted', plantedAtChapter: 1 }], trackedEntities };
  };
  await store.saveStoryState(legacyState(1, [tracked(note, 1), tracked(secret, 1)]));
  await store.saveStoryState(legacyState(2, [tracked(note, 1), tracked(secret, 1), tracked(renamed, 2)]));
}

export async function legacyWorkWithDuplicates() {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-ledger-legacy-')));
  await addLegacyChapters(store);
  return { store, workId: ledgerWorkId };
}
