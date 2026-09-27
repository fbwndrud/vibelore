/**
 * Existing works and the story ledger. The history log is rebuilt from the
 * chapter deltas without a model; record merges are only proposed and wait for
 * the user's approval through lore_configure(mergeRecords), which the reducer
 * applies at the next commit. A legacy work is asked about once; after that,
 * only a newly flagged near-duplicate pair is asked about, so a candidate the
 * user left unapproved is not proposed again.
 */
import { asKit } from '../prompts/index.js';
import { LEDGER_FEATURES } from '../../engine/src/continuity/ledger.js';
import { loadLedgerConfig } from '../core/review-policy.js';
import { isLegacyLedger, normalizeStoryState } from '../../engine/src/continuity/story-state.js';
import { ledgerBaseState, ledgerLogStatus, rebuildLedgerLog } from './ledger-log.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const SHOWN_FIELDS = 2;
// A long legacy work is asked about its likeliest duplicates, not every record.
const LEGACY_ASK_LIMIT = 150;

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

/** Rebuilds the history log when it is missing or behind the chapters. Deterministic. */
export async function ensureLedgerLog({ store, workId }) {
  if ((await ledgerLogStatus({ store, workId })).ok) return { rebuilt: false };
  await rebuildLedgerLog({ store, workId, config: await loadLedgerConfig(store, workId) });
  return { rebuilt: true };
}

/**
 * The ledger the next chapter builds on, and whether the latest committed
 * state was written before the ledger (it has no `ledger` of its own).
 */
async function latestLedger(store, workId) {
  const last = (await store.listChapters()).at(-1) ?? 0;
  const loaded = last ? await store.loadStoryState(workId, last) : null;
  const legacy = Boolean(loaded) && isLegacyLedger(normalizeStoryState(loaded).ledger);
  const { ledger } = await ledgerBaseState({ store, workId, chapter: last });
  return { records: ledger?.records ?? [], legacy };
}

/** `record → the record it may duplicate`, for flags whose target still exists. */
function flaggedPairs(records) {
  const ids = new Set(records.map((record) => record.id));
  return records.filter((record) => record.possibleDuplicateOf && ids.has(record.possibleDuplicateOf))
    .map((record) => ({ key: `${record.id}>${record.possibleDuplicateOf}`, ids: [record.id, record.possibleDuplicateOf] }));
}

function recordsText(records) {
  return LEDGER_FEATURES.map((feature) => {
    const own = records.filter((record) => record.feature === feature);
    if (!own.length) return '';
    return [`[${feature}]`, ...own.map((record) => JSON.stringify({
      id: record.id, label: record.label ?? '', name: record.name,
      aliases: (record.aliases ?? []).map((alias) => alias.text).filter(Boolean),
      status: record.status, registeredAt: record.registeredAt ?? 0, lastEventAt: record.lastEventAt ?? record.registeredAt ?? 0,
      fields: Object.fromEntries(Object.entries(record.fields ?? {}).slice(0, SHOWN_FIELDS)),
      ...(record.possibleDuplicateOf ? { possibleDuplicateOf: record.possibleDuplicateOf } : {}),
    }))].join('\n');
  }).filter(Boolean).join('\n');
}

/**
 * Groups whose ids all exist, share `into`'s feature and do not merge `into`
 * into itself. A record takes part in one group only, as `into` or `from`, so
 * the list never chains or contradicts itself.
 */
function validGroups(groups, records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const used = new Set();
  const kept = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const into = byId.get(group?.into);
    const from = [...new Set(Array.isArray(group?.from) ? group.from : [])];
    if (!into || used.has(into.id) || !from.length || from.includes(into.id)) continue;
    if (!from.every((id) => byId.get(id)?.feature === into.feature && !used.has(id))) continue;
    for (const id of [into.id, ...from]) used.add(id);
    kept.push({ into: into.id, from, reason: String(group.reason ?? '').trim() });
  }
  return kept;
}

/** A legacy work's records to ask about: those in a flagged pair first, then the most recently moved, up to LEGACY_ASK_LIMIT. */
function legacyShown(records, flagged) {
  const ranked = records.map((record, index) => ({ record, index }))
    .sort((a, b) => Number(flagged.has(b.record.id)) - Number(flagged.has(a.record.id))
      || (b.record.lastEventAt ?? 0) - (a.record.lastEventAt ?? 0) || a.index - b.index);
  const kept = new Set(ranked.slice(0, LEGACY_ASK_LIMIT).map((item) => item.record));
  return records.filter((record) => kept.has(record));
}

const candidateKey = (candidate) => `${candidate.into}<${[...candidate.from].sort().join(',')}`;

/**
 * Asks which records name the same thing: once over every record of a legacy
 * work, then only about flagged pairs not asked before, sending just the
 * records they involve. New candidates join the stored ones. `pending` while
 * a host answer is outstanding, `failed` when the answer was unusable (asked
 * again next time), `none` when there is nothing new to ask.
 */
export async function proposeLedgerMerges({ store, workId, providers, kit: kitSource }) {
  const { records, legacy } = await latestLedger(store, workId);
  const stored = await store.loadMergeCandidates(workId) ?? {};
  const known = stored.candidates ?? [];
  const asked = new Set(stored.askedPairs ?? []);
  const pairs = flaggedPairs(records);
  const fresh = pairs.filter((pair) => !asked.has(pair.key));
  const legacyAsk = legacy && !stored.legacyAsked;
  if (!legacyAsk && !fresh.length) return { status: 'none', candidates: known };
  const involved = new Set((legacyAsk ? pairs : fresh).flatMap((pair) => pair.ids));
  const shown = legacyAsk ? legacyShown(records, involved) : records.filter((record) => involved.has(record.id));
  const save = (candidates) => store.saveMergeCandidates(workId, {
    candidates, askedPairs: [...new Set([...asked, ...(legacyAsk ? pairs : fresh).map((pair) => pair.key)])],
    legacyAsked: Boolean(stored.legacyAsked || legacyAsk), updatedAt: new Date().toISOString(),
  });
  // Nothing to compare (a legacy work with fewer than two records of any feature).
  if (!LEDGER_FEATURES.some((feature) => shown.filter((record) => record.feature === feature).length >= 2)) {
    await save(known);
    return { status: 'none', candidates: known };
  }
  const kit = asKit(kitSource);
  const before = providers.pending?.length ?? 0;
  const response = await providers.complete({
    model: MODEL, jsonMode: true, step: 'ledger-merge',
    messages: kit.messages('ledger-merge', { recordsText: recordsText(shown) }),
  });
  if ((providers.pending?.length ?? 0) > before) return { status: 'pending', candidates: known };
  const obj = parse(response?.text);
  if (!Array.isArray(obj?.groups)) return { status: 'failed', candidates: known };
  const seen = new Set(known.map(candidateKey));
  const candidates = [...known, ...validGroups(obj.groups, shown).filter((candidate) => !seen.has(candidateKey(candidate)))];
  await save(candidates);
  return { status: 'done', candidates };
}

/**
 * Stored merge candidates the user has not approved yet, as lore_configure and
 * the guided approval screen show them.
 */
export async function openMergeCandidates({ store, workId }) {
  const { merges } = await loadLedgerConfig(store, workId);
  const approvedFrom = new Set(merges.map((merge) => merge.from));
  return ((await store.loadMergeCandidates?.(workId))?.candidates ?? [])
    .filter((candidate) => !candidate.from.every((id) => approvedFrom.has(id)));
}
