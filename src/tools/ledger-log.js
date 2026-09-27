/**
 * The ledger's chapter history. The chapter deltas are the source of truth;
 * this file is rebuilt from them, so it follows commits, rollbacks and syncs
 * without its own bookkeeping.
 */
import { emptyStoryState, isLegacyLedger, ledgerStep, normalizeStoryState } from '../../engine/src/continuity/story-state.js';
import { loadLedgerConfig } from '../core/review-policy.js';
import { ledgerHistory, withLegacyEntities } from '../../engine/src/continuity/ledger.js';

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

/**
 * The state chapter `loaded.chapterNumber + 1` builds on: a state written
 * before the ledger gets one from the entity snapshots, chapter 1 starts from
 * the seeded entities, and any snapshot no record holds yet is added (the
 * working store may have given a legacy state a ledger without them).
 */
export function ledgerPrevState(workId, loaded, entities = []) {
  const seeded = loaded ? normalizeStoryState(loaded, { entities }) : ledgerSeedState(workId, entities);
  return { ...seeded, ledger: withLegacyEntities(seeded.ledger, entities) };
}

/** Replays the chapter deltas (through `through`, or all) from the seeded state. */
async function replayLedger({ store, workId, config = {}, through = null }) {
  const chapters = (await store.listChapters()).filter((chapter) => through === null || chapter <= through);
  let state = ledgerSeedState(workId, await store.loadEntitySnapshots(workId));
  const events = [];
  let replayed = 0;
  for (const chapter of chapters) {
    const artifact = await store.loadArtifact(workId, chapter);
    if (!artifact?.delta) continue;
    const step = ledgerStep(state, { ...artifact.delta, chapterNumber: chapter }, { config });
    events.push(...step.events);
    state = { ...state, chapterNumber: chapter, ledger: step.ledger, hooks: step.hooks };
    replayed += 1;
  }
  return { state, events, chapters, replayed };
}

export async function rebuildLedgerLog({ store, workId, config = {} }) {
  const { events, chapters } = await replayLedger({ store, workId, config });
  await store.saveLedgerEvents(workId, events, { throughChapter: chapters.at(-1) ?? null, chapters: chapters.length });
  return { events, chapters: chapters.length };
}

/**
 * The state the chapter after `chapter` builds on. A state written before the
 * ledger kept only some tracked entities and would number them afresh, so a
 * legacy work takes the ledger the delta replay ends with: the same records
 * and ids as the history log, with the approved merges. Once a commit writes
 * a state with a ledger, that ledger is used as it is.
 */
export async function ledgerBaseState({ store, workId, chapter, config = null }) {
  const loaded = await store.loadStoryState(workId, chapter);
  const entities = await store.loadEntitySnapshots(workId);
  const base = ledgerPrevState(workId, loaded, entities);
  if (!loaded || !isLegacyLedger(normalizeStoryState(loaded).ledger)) return base;
  const replay = await replayLedger({ store, workId, through: chapter, config: config ?? await loadLedgerConfig(store, workId) });
  // No delta to replay (a damaged work): the conversion of the last state is all there is.
  if (!replay.replayed) return base;
  return { ...base, ledger: withLegacyEntities(replay.state.ledger, entities) };
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
