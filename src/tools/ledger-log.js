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
  await store.saveLedgerEvents(workId, events, { throughChapter: chapters.at(-1) ?? null, chapters: chapters.length });
  return { events, chapters: chapters.length };
}

/**
 * The log is current when it was built through the last committed chapter and
 * reads cleanly. A work with no chapters has nothing to build.
 */
export async function ledgerLogStatus({ store, workId }) {
  const { events, malformed, build } = await store.loadLedgerLog(workId);
  const chapters = await store.listChapters();
  const lastChapter = events.length ? events.at(-1).chapter ?? null : null;
  const committed = chapters.at(-1) ?? null;
  const ok = malformed === 0 && (committed === null ? (build?.throughChapter ?? null) === null : build?.throughChapter === committed);
  return { ok, lastChapter, committed };
}
