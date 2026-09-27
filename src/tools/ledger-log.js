/**
 * The ledger's chapter history. The chapter deltas are the source of truth;
 * this file is rebuilt from them, so it follows commits, rollbacks and syncs
 * without its own bookkeeping.
 */
import { emptyStoryState, ledgerStep, normalizeStoryState } from '../../engine/src/continuity/story-state.js';
import { ledgerHistory } from '../../engine/src/continuity/ledger.js';

export { ledgerHistory };

/**
 * The state before chapter 1. Entities seeded at creation (registered before
 * any chapter) start the ledger; later ones come back from the deltas.
 */
export function ledgerSeedState(workId, entities = []) {
  return normalizeStoryState({ ...emptyStoryState(workId), ledger: undefined }, {
    entities: (entities ?? []).filter((entity) => (entity.registeredAtChapter ?? 0) === 0),
  });
}

export async function rebuildLedgerLog({ store, workId, config = {} }) {
  const chapters = await store.listChapters();
  let state = ledgerSeedState(workId, await store.loadEntitySnapshots(workId));
  const events = [];
  for (const chapter of chapters) {
    const artifact = await store.loadArtifact(workId, chapter);
    if (!artifact?.delta) continue;
    const step = ledgerStep(state, { ...artifact.delta, chapterNumber: chapter }, { config });
    events.push(...step.events);
    state = { ...state, chapterNumber: chapter, ledger: step.ledger, hooks: step.hooks };
  }
  await store.saveLedgerEvents(workId, events);
  return { events, chapters: chapters.length };
}

export async function ledgerLogStatus({ store, workId }) {
  const events = await store.loadLedgerEvents(workId);
  const chapters = await store.listChapters();
  const lastChapter = events.length ? events.at(-1).chapter : null;
  const committed = chapters.at(-1) ?? null;
  return { ok: committed === null || lastChapter === null || lastChapter <= committed, lastChapter, committed };
}
