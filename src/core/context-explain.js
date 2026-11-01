// Read-only explanation of why material is in, or left out of, a stored draft
// input. It is derived on read from the id-only `contextAudit` record and never
// stored, scored, or fed to a model. Only ids, kinds, chapter numbers, reason
// codes and counts are read from stored entries; text fields never are.

/** Most item-sentences one layer prints before it collapses the rest into one "and N more". */
export const LAYER_SENTENCE_CAP = 12;
// The writer-side older-memory filter keeps this many items; `over-cap` names the rest.
export const OLDER_MEMORY_CAP = 8;
const MAX_ID_CODE_POINTS = 64;

const plain = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const list = (value) => (Array.isArray(value) ? value : []);
const entries = (value) => list(value).filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
const finite = (value) => (Number.isFinite(value) ? value : '?');

/** The only path from a stored string into sentence text. */
export function safeId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const clean = String(value).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, MAX_ID_CODE_POINTS).join('');
}

const nameOf = (value) => safeId(value) || '?';
const codeOf = (value) => safeId(value) || '?';

function item(layer, outcome, code, text, extra = {}) {
  return { layer, outcome, code, ...extra, text };
}

/**
 * Pushes the first LAYER_SENTENCE_CAP items of one capped layer, then one
 * "and N more" note. `total` is the stored true count when the record carries
 * one; it never reports fewer than the entries actually listed.
 */
function pushCapped(push, t, layer, items, total) {
  for (const entry of items.slice(0, LAYER_SENTENCE_CAP)) push(entry);
  const all = Math.max(Number.isFinite(total) ? total : 0, items.length);
  if (all > LAYER_SENTENCE_CAP) {
    const count = all - LAYER_SENTENCE_CAP;
    push(item(layer, 'note', 'and-more', t.andMore(count), { count }));
  }
}

// One entry per stored reason code. Each maps a subject kind to its outcome and
// phrase; a code used on a subject it does not describe falls back to `unknownCode`.
const REASONS = {
  'context-token-budget': {
    summary: ({ t, u, subject }) => ['left-out', t.summaryCut(subject, finite(u.maxContextTokens))],
    memory: ({ t, u, subject }) => ['left-out', t.olderMemoryContextBudget(subject, finite(u.maxContextTokens))],
  },
  truncated: { summary: ({ t, subject }) => ['shortened', t.summaryTruncated(subject)] },
  'unsafe-content': {
    summary: ({ t, subject }) => ['left-out', t.summaryUnsafe(subject)],
    memory: ({ t, subject }) => ['left-out', t.olderMemoryUnsafe(subject)],
  },
  'no-query-match': { memory: ({ t, subject }) => ['left-out', t.olderMemoryNoMatch(subject)] },
  budget: { memory: ({ t, subject }) => ['left-out', t.olderMemoryBudget(subject)] },
  'in-foundation': { memory: ({ t, subject }) => ['left-out', t.olderMemoryInFoundation(subject)] },
  'over-cap': { memory: ({ t, subject }) => ['left-out', t.olderMemoryOverCap(subject, OLDER_MEMORY_CAP)] },
};

/** One left-out item for a stored exclusion; unknown reasons never throw. */
function excludedItem(ctx, layer, kind, rawSubject, rawReason) {
  const subject = nameOf(rawSubject);
  const reason = typeof rawReason === 'string' ? rawReason : '';
  const phrase = Object.hasOwn(REASONS, reason) ? REASONS[reason][kind] : undefined;
  if (!phrase) return item(layer, 'left-out', 'unknown-code', ctx.t.unknownCode(codeOf(reason), subject), { subject });
  const [outcome, text] = phrase({ ...ctx, subject });
  return item(layer, outcome, reason, text, { subject });
}

const fixed = (audit, t, push) => {
  push(item('fixed', 'included', 'fixed', t.fixedMaterial()));
};

// Settings a canon gate hid from this draft: refs and chapter numbers only.
const canonGates = (audit, t, push) => {
  const gates = audit.canonGates;
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) return;
  const hidden = entries(gates.hidden)
    .filter((entry) => safeId(entry.ref))
    .map((entry) => {
      const ref = safeId(entry.ref);
      return item('canonGates', 'left-out', 'canon_gate', t.canonGateHidden(ref, finite(entry.fromChapter)), { subject: ref });
    });
  pushCapped(push, t, 'canonGates', hidden, gates.total);
};

const recentSummaries = (audit, t, push, u) => {
  const trace = plain(plain(audit.draftInputTrace).continuity);
  const stored = list(trace.recentSummaryChapters).length ? trace.recentSummaryChapters : audit.recentSummaryChapters;
  const chapters = list(stored);
  if (chapters.length) {
    push(item('recentSummaries', 'included', 'included', t.summaryIncluded(chapters.map(finite).join(', '), chapters.length), { count: chapters.length }));
  }
  const ctx = { t, u };
  const cut = entries(trace.excluded)
    .filter((entry) => entry.kind === 'recentSummary')
    .map((entry) => excludedItem(ctx, 'recentSummaries', 'summary', finite(entry.chapter), entry.reason));
  pushCapped(push, t, 'recentSummaries', cut);
  const trimmed = plain(audit.memory).trimmedSummaries;
  if (Number.isFinite(trimmed) && trimmed > 0) {
    push(item('recentSummaries', 'note', 'outside-window', t.outsideWindow(trimmed), { count: trimmed }));
  }
};

const olderMemory = (audit, t, push, u) => {
  // The sections layer reports a switched-off older-memory section.
  if (list(audit.disabledDraftSections).includes('older-memory')) return;
  const memory = plain(audit.memory);
  const trace = plain(plain(audit.draftInputTrace).continuity);
  const refs = list(trace.olderMemoryRefs).length ? trace.olderMemoryRefs : audit.olderMemoryRefs;
  const included = list(refs).map(safeId).filter(Boolean);
  if (included.length) {
    push(item('olderMemory', 'included', 'included', t.olderMemoryIncluded(included.length, included.map((id) => `\`${id}\``).join(', ')), { count: included.length }));
  }
  const ctx = { t, u };
  const memoryItem = (rawSubject, reason) => excludedItem(ctx, 'olderMemory', 'memory', rawSubject, reason);
  // An entry without an id has no subject to name, so it is skipped like a canon-gate entry without a ref.
  const named = (stored, idKey, kind) => entries(stored).filter((entry) => safeId(entry[idKey]) && (!kind || entry.kind === kind));
  const fromTrace = named(trace.excluded, 'ref', 'olderMemory').map((entry) => memoryItem(entry.ref, entry.reason));
  const fromFiltered = named(memory.filtered, 'id').map((entry) => memoryItem(entry.id, entry.reason));
  const fromExcluded = named(memory.excluded, 'id').map((entry) => memoryItem(entry.id, entry.reason));
  const countOf = (stored, listed) => Math.max(Number.isFinite(stored) ? stored : 0, listed.length);
  const total = fromTrace.length + countOf(memory.filteredTotal, fromFiltered) + countOf(memory.excludedTotal, fromExcluded);
  pushCapped(push, t, 'olderMemory', [...fromTrace, ...fromFiltered, ...fromExcluded], total);
  // A record from before per-item reasons: the selection kept only counts.
  const retrieval = memory.retrieval;
  if (retrieval && typeof retrieval === 'object' && !Array.isArray(retrieval) && memory.excluded === undefined) {
    push(item('olderMemory', 'note', 'detail-not-recorded', t.olderMemoryCountsOnly(finite(retrieval.candidates), finite(retrieval.selected), finite(memory.droppedForBudget))));
  }
};

const previousTail = (audit, t, push, u) => {
  if (list(audit.disabledDraftSections).includes('previous-tail')) return;
  const tail = plain(plain(plain(audit.draftInputTrace).sections).previousTail);
  if (Number.isFinite(tail.includedTokens) && tail.includedTokens > 0) {
    push(item('previousTail', 'included', 'included', t.previousTailIncluded()));
  } else if (tail.truncated === true && tail.reason === 'plan-token-budget') {
    push(item('previousTail', 'left-out', 'plan-token-budget', t.previousTailDropped(finite(u.maxPlanTokens))));
  }
};

const preferences = (audit, t, push, u) => {
  const section = plain(audit.draftInputTrace).sections?.creativePreferences;
  if (!section || typeof section !== 'object' || Array.isArray(section)) return;
  const ids = list(section.includedIds);
  if (section.truncated === true && section.reason === 'plan-token-budget') {
    push(item('preferences', 'left-out', 'plan-token-budget', t.preferencesDropped(finite(u.maxPlanTokens))));
  } else if (ids.length) {
    push(item('preferences', 'included', 'included', t.preferencesIncluded(ids.length), { count: ids.length }));
  }
};

const sections = (audit, t, push) => {
  const labels = plain(t.sectionLabels);
  for (const name of list(audit.disabledDraftSections)) {
    const subject = nameOf(name);
    const label = typeof name === 'string' && Object.hasOwn(labels, name) ? labels[name] : subject;
    push(item('sections', 'switched-off', 'disabled-by-user', t.sectionSwitchedOff(label), { subject }));
  }
};

const coverage = (audit, t, push) => {
  push(item('coverage', 'note', 'coverage', t.coverageNote()));
};

// Fixed order; a later layer is appended here.
const LAYERS = [fixed, canonGates, recentSummaries, olderMemory, previousTail, preferences, sections, coverage];

const result = (kit, available, items) => ({
  schema: 1, family: kit?.family ?? null, available, items, sentences: items.map((entry) => entry.text),
});

function failure(kit, code, phrase) {
  let text = '';
  try { text = kit.phrases.contextExplain[phrase](); } catch { /* an unusable kit still yields a result */ }
  return result(kit, false, [item('coverage', 'note', code, text)]);
}

/**
 * Why each piece of material is in or out of a stored draft input.
 * Deterministic and read-only; never throws.
 */
export function explainDraftContext(args) {
  let kit;
  try {
    const { contextAudit } = args ?? {};
    kit = args?.kit;
    if (contextAudit === null || contextAudit === undefined) return failure(kit, 'not-yet-drafted', 'notYetDrafted');
    if (typeof contextAudit !== 'object' || Array.isArray(contextAudit)) return failure(kit, 'detail-not-recorded', 'detailUnavailable');
    const t = kit.phrases.contextExplain;
    const usage = plain(contextAudit.draftInputUsage);
    const items = [];
    const push = (entry) => { items.push(entry); };
    for (const layer of LAYERS) layer(contextAudit, t, push, usage);
    return result(kit, true, items);
  } catch {
    return failure(kit, 'detail-not-recorded', 'detailUnavailable');
  }
}
