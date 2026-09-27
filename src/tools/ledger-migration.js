/**
 * Existing works and the story ledger. The history log is rebuilt from the
 * chapter deltas without a model; record merges are only proposed — one model
 * request per ledger — and wait for the user's approval through
 * lore_configure(mergeRecords), which the reducer applies at the next commit.
 */
import { createHash } from 'node:crypto';
import { asKit } from '../prompts/index.js';
import { LEDGER_FEATURES } from '../../engine/src/continuity/ledger.js';
import { loadLedgerConfig } from '../core/review-policy.js';
import { ledgerLogStatus, ledgerPrevState, rebuildLedgerLog } from './ledger-log.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const SHOWN_FIELDS = 2;

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

/**
 * The latest committed state and the ledger the next chapter builds on. A
 * state written before the ledger still carries its tracked entities; states
 * written since always carry an empty list.
 */
async function latestLedger(store, workId) {
  const last = (await store.listChapters()).at(-1) ?? 0;
  const state = last ? await store.loadStoryState(workId, last) : null;
  const ledger = ledgerPrevState(workId, state, await store.loadEntitySnapshots(workId)).ledger;
  return { ledger, legacy: (state?.trackedEntities?.length ?? 0) > 0 };
}

/** Rebuilds the history log when it is missing or behind the chapters. Deterministic. */
export async function ensureLedgerLog({ store, workId }) {
  const { legacy } = await latestLedger(store, workId);
  if ((await ledgerLogStatus({ store, workId })).ok) return { rebuilt: false, legacy };
  await rebuildLedgerLog({ store, workId, config: await loadLedgerConfig(store, workId) });
  return { rebuilt: true, legacy };
}

/** Whether the ledger is worth asking about: a flagged near-duplicate, or records converted from a legacy work. */
export async function ledgerNeedsMergeReview({ store, workId }) {
  const { ledger, legacy } = await latestLedger(store, workId);
  return legacy || (ledger?.records ?? []).some((record) => record.possibleDuplicateOf);
}

function digestOf(records) {
  const lines = records.map((record) => `${record.id}\t${record.name}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function recordsText(records) {
  return LEDGER_FEATURES.map((feature) => {
    const own = records.filter((record) => record.feature === feature);
    if (!own.length) return '';
    return [`[${feature}]`, ...own.map((record) => JSON.stringify({
      id: record.id, label: record.label ?? '', name: record.name,
      aliases: (record.aliases ?? []).map((alias) => alias.text).filter(Boolean),
      status: record.status,
      fields: Object.fromEntries(Object.entries(record.fields ?? {}).slice(0, SHOWN_FIELDS)),
      ...(record.possibleDuplicateOf ? { possibleDuplicateOf: record.possibleDuplicateOf } : {}),
    }))].join('\n');
  }).filter(Boolean).join('\n');
}

/** Groups whose ids all exist, share `into`'s feature and do not merge `into` into itself; each record is merged once. */
function validGroups(groups, records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const used = new Set();
  const kept = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const into = byId.get(group?.into);
    const from = [...new Set(Array.isArray(group?.from) ? group.from : [])];
    if (!into || !from.length || from.includes(into.id)) continue;
    if (!from.every((id) => byId.get(id)?.feature === into.feature && !used.has(id))) continue;
    for (const id of from) used.add(id);
    kept.push({ into: into.id, from, reason: String(group.reason ?? '').trim() });
  }
  return kept;
}

/**
 * Asks once per ledger (digest of record ids and names) which records name the
 * same thing. `pending` while a host answer is outstanding, `failed` when the
 * answer was unusable (asked again next time), `none` when no feature has two
 * records to compare.
 */
export async function proposeLedgerMerges({ store, workId, providers, kit: kitSource }) {
  const { ledger } = await latestLedger(store, workId);
  const records = ledger?.records ?? [];
  if (!LEDGER_FEATURES.some((feature) => records.filter((record) => record.feature === feature).length >= 2)) {
    return { status: 'none', candidates: [] };
  }
  const digest = digestOf(records);
  const stored = await store.loadMergeCandidates(workId);
  if (stored?.digest === digest) return { status: 'done', candidates: stored.candidates ?? [] };
  const kit = asKit(kitSource);
  const response = await providers.complete({
    model: MODEL, jsonMode: true, step: 'ledger-merge',
    messages: kit.messages('ledger-merge', { recordsText: recordsText(records) }),
  });
  if ((providers.pending?.length ?? 0) > 0) return { status: 'pending', candidates: [] };
  const obj = parse(response?.text);
  if (!Array.isArray(obj?.groups)) return { status: 'failed', candidates: [] };
  const candidates = validGroups(obj.groups, records);
  await store.saveMergeCandidates(workId, { digest, candidates, createdAt: new Date().toISOString() });
  return { status: 'done', candidates };
}
