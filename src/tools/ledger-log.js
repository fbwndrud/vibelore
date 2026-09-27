/**
 * The ledger's chapter history. The chapter deltas are the source of truth;
 * this file is rebuilt from them, so it follows commits, rollbacks and syncs
 * without its own bookkeeping.
 */
import { createHash } from 'node:crypto';
import { emptyStoryState, isLegacyLedger, ledgerStep, normalizeStoryState } from '../../engine/src/continuity/story-state.js';
import { loadLedgerConfig } from '../core/review-policy.js';
import { applyMerges, ledgerConfigAt, ledgerHistory, withLegacyEntities } from '../../engine/src/continuity/ledger.js';

export { ledgerHistory };

/** An entity as it stood before any chapter: registered at 0, in its starting status. */
function seedEntity(entity) {
  const { updatedAtChapter: _updated, retiredAtChapter: _retired, ...rest } = entity;
  return { ...rest, status: 'active', registeredAtChapter: 0 };
}

/**
 * The entities before chapter 1, where every replay starts. lore_create writes
 * them to ledger/seed.json. A work without that file gets one the first time
 * it is needed, from the entity snapshots: before any chapter they are the
 * seed as they are; after one, the snapshots were rewritten by the commits, so
 * the ones registered before chapter 1 are taken back to their starting status
 * (their fields stay as the snapshot has them). Written once, never re-derived.
 */
export async function ledgerSeedEntities(store, workId, { persist = true } = {}) {
  const saved = await store.loadLedgerSeed?.(workId);
  if (Array.isArray(saved?.entities)) return saved.entities;
  const snapshots = ((await store.loadEntitySnapshots(workId)) ?? []).filter((entity) => entity?.entityId);
  const written = (await store.listChapters()).length > 0;
  const entities = written
    ? snapshots.filter((entity) => (entity.registeredAtChapter ?? 0) === 0).map(seedEntity)
    : snapshots.map((entity) => ({ ...entity, registeredAtChapter: 0 }));
  if (persist) await store.saveLedgerSeed?.(workId, { entities, source: written ? 'entity-snapshots-reset' : 'entity-snapshots' });
  return entities;
}

/** The state before chapter 1, from the seed entities. */
export function ledgerSeedState(workId, entities = []) {
  return normalizeStoryState({ ...emptyStoryState(workId), ledger: undefined }, {
    entities: (entities ?? []).filter((entity) => (entity.registeredAtChapter ?? 0) === 0),
  });
}

/**
 * The state chapter `loaded.chapterNumber + 1` builds on: a state written
 * before the ledger gets one from the entity snapshots, and any snapshot no
 * record holds yet is added (the working store may have given a legacy state
 * a ledger without them). Without a loaded state, the seed.
 */
export function ledgerPrevState(workId, loaded, entities = []) {
  const seeded = loaded ? normalizeStoryState(loaded, { entities }) : ledgerSeedState(workId, entities);
  return { ...seeded, ledger: withLegacyEntities(seeded.ledger, entities) };
}

/** Replays the chapter deltas (through `through`, or all) from the seed, each under the config in effect at its chapter. */
async function replayLedger({ store, workId, config, through = null }) {
  const chapters = (await store.listChapters()).filter((chapter) => through === null || chapter <= through);
  let state = ledgerSeedState(workId, await ledgerSeedEntities(store, workId));
  const events = [];
  const violations = [];
  let replayed = 0;
  for (const chapter of chapters) {
    const artifact = await store.loadArtifact(workId, chapter);
    if (!artifact?.delta) continue;
    const step = ledgerStep(state, { ...artifact.delta, chapterNumber: chapter }, { config });
    events.push(...step.events);
    violations.push(...step.violations.map((violation) => ({ chapter, ...violation })));
    state = { ...state, chapterNumber: chapter, ledger: step.ledger, hooks: step.hooks };
    replayed += 1;
  }
  return { state, events, violations, chapters, replayed };
}

/** The ledger and hooks the deltas replay to, with the history lines and findings of the replay. */
export async function replayLedgerState({ store, workId, config = null, through = null }) {
  return replayLedger({ store, workId, config: config ?? await loadLedgerConfig(store, workId), through });
}

// Key order is not content: the published tree stores deltas with sorted keys, the working store as written.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const sha = (value) => createHash('sha256').update(JSON.stringify(stable(value ?? null))).digest('hex');

async function deltaHashes(store, workId, chapters) {
  const hashes = [];
  for (const chapter of chapters) hashes.push([chapter, sha((await store.loadArtifact(workId, chapter))?.delta)]);
  return hashes;
}

/** What a log is built from: the seed, the ledger config with its history, and each chapter's delta. */
async function ledgerDigest({ store, workId, config, hashes, persist = true }) {
  const { tracking = {}, customTracking = [], merges = [], history = [] } = config ?? {};
  return `sha256:${sha({ seed: await ledgerSeedEntities(store, workId, { persist }), config: { tracking, customTracking, merges, history }, deltas: hashes })}`;
}

async function saveLog({ store, workId, config, events, hashes }) {
  await store.saveLedgerEvents(workId, events, {
    throughChapter: hashes.at(-1)?.[0] ?? null, chapters: hashes.length, eventCount: events.length,
    digest: await ledgerDigest({ store, workId, config, hashes }),
  });
}

export async function rebuildLedgerLog({ store, workId, config = null }) {
  const effective = config ?? await loadLedgerConfig(store, workId);
  const { events, chapters } = await replayLedger({ store, workId, config: effective });
  await saveLog({ store, workId, config: effective, events, hashes: await deltaHashes(store, workId, chapters) });
  return { events, chapters: chapters.length };
}

/**
 * The log after committing `chapter`. A log built through the
 * chapter before, from the same deltas and config, gets this chapter's lines
 * appended; anything else (a first chapter, a legacy work, a rollback, refold,
 * sync or config change since) is rebuilt from the deltas.
 */
export async function updateLedgerLog({ store, workId, chapter, delta, config = null }) {
  const effective = config ?? await loadLedgerConfig(store, workId);
  const chapters = await store.listChapters();
  const { events, malformed, build, missing } = await store.loadLedgerLog(workId);
  const loaded = chapter > 1 ? await store.loadStoryState(workId, chapter - 1) : null;
  const shaped = chapters.at(-1) === chapter && loaded && !isLegacyLedger(normalizeStoryState(loaded).ledger)
    && !missing && malformed === 0 && build?.throughChapter === chapter - 1 && build.eventCount === events.length;
  const hashes = shaped ? await deltaHashes(store, workId, chapters.filter((item) => item < chapter)) : [];
  if (!shaped || build.digest !== await ledgerDigest({ store, workId, config: effective, hashes })) {
    await rebuildLedgerLog({ store, workId, config: effective });
    return { mode: 'rebuild' };
  }
  // From the committed state as it was, not the base state: that one already folds this chapter's
  // merges for the extractor, and the step must emit them as the full replay does.
  const step = ledgerStep(normalizeStoryState(loaded), { ...delta, chapterNumber: chapter }, { config: effective });
  await saveLog({ store, workId, config: effective, events: [...events, ...step.events], hashes: [...hashes, [chapter, sha(delta)]] });
  return { mode: 'append' };
}

/**
 * The state the chapter after `chapter` builds on. A state written before the
 * ledger kept only some tracked entities and would number them afresh, so a
 * legacy work takes the ledger the delta replay ends with: the same records
 * and ids as the history log. Once a commit writes a state with a ledger, that
 * ledger is used as it is. Merges approved for the next chapter are folded in,
 * so its extractor and writer see the merged record.
 */
export async function ledgerBaseState({ store, workId, chapter, config = null }) {
  const effective = config ?? await loadLedgerConfig(store, workId);
  const loaded = await store.loadStoryState(workId, chapter);
  let base;
  if (!loaded) {
    base = ledgerSeedState(workId, await ledgerSeedEntities(store, workId));
  } else {
    const entities = await store.loadEntitySnapshots(workId);
    base = ledgerPrevState(workId, loaded, entities);
    if (isLegacyLedger(normalizeStoryState(loaded).ledger)) {
      const replay = await replayLedger({ store, workId, through: chapter, config: effective });
      // No delta to replay (a damaged work): the conversion of the last state is all there is.
      if (replay.replayed) base = { ...base, ledger: withLegacyEntities(replay.state.ledger, entities) };
    }
  }
  return { ...base, ledger: applyMerges(base.ledger, ledgerConfigAt(effective, chapter + 1).merges, chapter + 1).ledger };
}

/**
 * The log is current when its file is there, reads cleanly, holds as many
 * lines as it was built with, and was built through the last committed chapter
 * from the same seed, deltas and ledger config. A work with no chapters has
 * nothing to build.
 */
export async function ledgerLogStatus({ store, workId }) {
  const { events, malformed, build, missing } = await store.loadLedgerLog(workId);
  const chapters = await store.listChapters();
  const lastChapter = events.length ? events.at(-1).chapter ?? null : null;
  const committed = chapters.at(-1) ?? null;
  if (committed === null) return { ok: (build?.throughChapter ?? null) === null, lastChapter, committed };
  const shaped = !missing && malformed === 0 && build?.throughChapter === committed && build.eventCount === events.length;
  const ok = shaped && build.digest === await ledgerDigest({ store, workId, config: await loadLedgerConfig(store, workId), hashes: await deltaHashes(store, workId, chapters), persist: false });
  return { ok, lastChapter, committed };
}
