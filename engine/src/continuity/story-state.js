/**
 * StoryState — a structured snapshot carried forward across chapters.
 *
 * StoryState(N) = reduceStoryState(StoryState(N-1), ChapterDelta(N)).
 * Every work tracks address terms, relationships, and unresolved story hooks.
 * Genre profiles add typed categories of tracked entities. Reducers return new
 * containers so evaluating a candidate does not mutate the prior snapshot.
 */
import { advanceCursor, CHARACTER_ARC_BEATS } from './character-arc.js';
import { applyLedgerOps, applyMerges, emptyLedger, HOOK_HORIZONS, ledgerConfigAt, hookStatusOf, HOOK_STATUSES, LEGACY_KNOWLEDGE_KINDS, LEGACY_LOG_KINDS, LEGACY_SKIPPED_KINDS, ledgerFromLegacy, legacyRecord } from './ledger.js';
/**
 * Hook lifecycle. A hook is a narrative promise to the reader.
 *   open    — the reader is waiting on it
 *   dormant — set aside for now; planners may bring it back
 *   paid    — answered on the page; may be reopened
 *   closed  — no longer used
 */
export { HOOK_HORIZONS, HOOK_STATUSES };
const LEGACY_HORIZON = { immediate: 'next', 'near-term': 'soon', 'mid-arc': 'arc', 'slow-burn': 'long', endgame: 'finale' };
/** True while the hook is open. Dormant hooks are listed separately by planners. */
export function isHookActive(hook) {
    return hookStatusOf(hook) === 'open';
}
/** Normalize a hook record, including those written by earlier vibelore builds. */
export function normalizeHook(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const id = raw.id ?? raw.hookId;
    if (typeof id !== 'string' || id.length === 0)
        return null;
    const text = raw.text ?? raw.description ?? '';
    const plantedAtChapter = raw.plantedAtChapter ?? raw.startChapter;
    let horizon = raw.horizon ?? LEGACY_HORIZON[raw.payoffTiming];
    if (!HOOK_HORIZONS.includes(horizon))
        horizon = undefined;
    const lastMovedChapter = raw.lastMovedChapter ?? raw.lastAdvancedChapter ?? plantedAtChapter;
    const status = hookStatusOf(raw);
    const { hookId, description, startChapter, phase, payoffTiming, lastAdvancedChapter, ...rest } = raw;
    return {
        ...rest,
        id,
        text,
        status,
        ...(plantedAtChapter !== undefined ? { plantedAtChapter } : {}),
        ...(horizon ? { horizon } : {}),
        ...(lastMovedChapter !== undefined ? { lastMovedChapter } : {}),
        recent: Array.isArray(raw.recent) ? raw.recent : [],
    };
}
// Ledgers converted from a state written before the ledger. Kept out of the
// object so it is never persisted: a state reduced from one carries a new ledger.
const LEGACY_LEDGERS = new WeakSet();
/**
 * Whether this ledger was converted from a state written before the ledger.
 * Such a ledger holds only the tracked entities the last state kept, numbered
 * afresh; callers that build on it replay the chapter deltas instead.
 */
export function isLegacyLedger(ledger) {
    return Boolean(ledger) && typeof ledger === 'object' && LEGACY_LEDGERS.has(ledger);
}
/** Normalize a persisted StoryState (or null). A state written before the ledger gets one from its tracked entities and the entity snapshots. */
export function normalizeStoryState(state, { entities = [] } = {}) {
    if (!state || typeof state !== 'object')
        return state;
    const hooks = Array.isArray(state.hooks) ? state.hooks.map(normalizeHook).filter(Boolean) : [];
    if (state.ledger?.records)
        return { ...state, hooks, ledger: state.ledger };
    const ledger = ledgerFromLegacy({ trackedEntities: state.trackedEntities, entities });
    LEGACY_LEDGERS.add(ledger);
    return { ...state, hooks, ledger };
}
/**
 * StoryState(N) = reduce(StoryState(N-1), ChapterDelta(N)). Pure — never
 * mutates `prev`. Returns a fresh `StoryState` with cloned containers.
 *
 * Merge rules (engine design §3.6, §3.7):
 *   1. `addressMap.entries`: each `delta.newAddressEntries` upserts the key
 *      `${speakerId}->${targetId}` with `sinceChapter = delta.chapterNumber`.
 *      Last-write-wins within the same delta.
 *   2. `relationships`: each `delta.relationshipOps` replaces the existing
 *      entry whose `(from, to, kind)` matches, preserving position; otherwise
 *      appended at the end.
 *   3. Ledger and hooks: `delta.ledgerOps` fold through `applyLedgerOps`.
 *      A delta written before the ledger (`hookChanges`/`hookOps`,
 *      `trackedEntityOps`, `entityOps`) is converted by `legacyLedgerOps`
 *      first. Hooks are normalized through `normalizeHook`, so snapshots in
 *      the `phase` or older `status` vocabulary load with a current status.
 *   4. `config.merges` (user-approved {from, into, atChapter}) fold before
 *      and after the ops from their chapter on, every reduce, so a merge
 *      stays applied to records re-registered later. Tracking switches and
 *      author items apply as they were at this chapter (`ledgerConfigAt`).
 *      `trackedEntities` is always `[]`; readers move to `ledger.records`.
 *   5. `characterStates`: `delta.mutableChanges` fold per character —
 *      `vitalStatus` (alive|dead|missing), location, status, accumulated
 *      `knownFacts` and `sinceChapter`. Foundation keeps the design-time
 *      `Character.mutable`; this is the chapter-by-chapter state.
 *
 * NOT applied to StoryState (consumed by other layers):
 *   - `delta.appearedCharacterIds`: writer cast-manifest output consumed by
 *     the continuity check / context builder; not part of carry-forward state.
 *
 * Throws `chapter-out-of-order` if `delta.chapterNumber <= prev.chapterNumber`.
 */
export const VITAL_STATUSES = new Set(['alive', 'dead', 'missing']);
const TRACKED_KEY_FIELDS = ['id', 'key', 'name', 'fact', 'event', 'clue', 'item', 'title'];
const TRACKED_KEY_PAIRS = [['from', 'to'], ['user', 'ability'], ['owner', 'item']];
/**
 * Natural key of a tracked-entity record within its kind. A record without
 * one (a whole-kind snapshot such as `{ now: '회귀후' }`) keeps the old
 * one-snapshot-per-kind behaviour under the empty key.
 */
export function trackedRecordKey(data) {
    const record = data ?? {};
    for (const [left, right] of TRACKED_KEY_PAIRS) {
        if (typeof record[left] === 'string' && typeof record[right] === 'string')
            return `${left}:${record[left]}|${right}:${record[right]}`;
    }
    for (const field of TRACKED_KEY_FIELDS) {
        if (typeof record[field] === 'string' && record[field].trim())
            return `${field}:${record[field].trim()}`;
    }
    return '';
}
const LEGACY_EVENT = { planted: 'mentioned', advancing: 'advanced', paid: 'paid', parked: 'parked', closed: 'closed' };
const LEGACY_PHASE = { open: 'planted', progressing: 'advancing', resolved: 'paid', deferred: 'parked', paid: 'paid', dormant: 'parked' };
const STATUS_PHASE = { paid: 'paid', dormant: 'parked', closed: 'closed' };
/** The phase a legacy hook change means. Its status, once current, wins over a stale phase (as in `hookStatusOf`). */
function legacyPhase(raw) {
    const status = hookStatusOf(raw);
    if (STATUS_PHASE[status])
        return STATUS_PHASE[status];
    const phase = raw.phase ?? LEGACY_PHASE[raw.status];
    return phase === 'advancing' ? 'advancing' : 'planted';
}
/** Ledger ops equivalent to a delta written before the ledger. */
export function legacyLedgerOps(prev, delta) {
    const ops = [];
    const known = new Map((prev.hooks ?? []).map((hook) => [hook.id, hook]));
    for (const raw of delta.hookChanges ?? delta.hookOps ?? []) {
        const hook = normalizeHook(raw);
        if (!hook)
            continue;
        const phase = legacyPhase(raw);
        if (!known.has(hook.id)) {
            ops.push({ op: 'plant', text: hook.text, id: hook.id, ...(hook.horizon ? { horizon: hook.horizon } : {}), ...(hook.plantedAtChapter !== undefined ? { plantedAtChapter: hook.plantedAtChapter } : {}) });
            // A hook first seen already moved, paid or parked keeps that state.
            if (phase !== 'planted' && LEGACY_EVENT[phase])
                ops.push({ op: 'hook', id: hook.id, event: LEGACY_EVENT[phase] });
            known.set(hook.id, { ...hook, status: hookStatusOf(raw) });
            continue;
        }
        const before = known.get(hook.id);
        const event = before.status === 'paid' && phase !== 'paid' ? 'reopened' : LEGACY_EVENT[phase] ?? 'mentioned';
        const text = hook.text && hook.text !== before.text ? { text: hook.text } : {};
        const horizon = hook.horizon && hook.horizon !== before.horizon ? { horizon: hook.horizon } : {};
        ops.push({ op: 'hook', id: hook.id, event, ...text, ...horizon });
    }
    for (const op of delta.trackedEntityOps ?? []) {
        if (LEGACY_LOG_KINDS.has(op.kind)) {
            const events = Array.isArray(op.data?.events) ? op.data.events : [op.data?.event].filter(Boolean);
            for (const note of events)
                ops.push({ op: 'chapter-note', note: String(note) });
            continue;
        }
        if (LEGACY_SKIPPED_KINDS.has(op.kind))
            continue;
        const { name, fields } = legacyRecord(op.data);
        if (!name)
            continue;
        const feature = LEGACY_KNOWLEDGE_KINDS.has(op.kind) ? 'knowledge' : 'objects';
        ops.push({ op: 'register', feature, label: op.kind, name, ...(Object.keys(fields).length ? { fields } : {}) });
    }
    for (const op of delta.entityOps ?? []) {
        if (op.op === 'register')
            ops.push({ op: 'register', feature: 'objects', label: op.kind, name: op.name, ...(op.entityId ? { id: op.entityId } : {}) });
        else if (op.op === 'update')
            ops.push({ op: 'event', id: op.entityId, event: 'changed', set: op.fields });
        else if (op.op === 'retire')
            ops.push({ op: 'event', id: op.entityId, event: 'status', status: op.cause === 'destroyed' ? 'destroyed' : 'retired' });
    }
    return ops;
}
/**
 * The ledger part of a reduce, with the history lines and findings it produced.
 * Callers keep deltas in chapter order. The config in effect at this chapter
 * applies (`ledgerConfigAt`), so a replay of the deltas reproduces each commit.
 * Merges fold before the chapter's ops (a merge approved for this chapter is
 * what the extractor saw) and again after them (a record registered now).
 */
export function ledgerStep(prev, delta, { config = {} } = {}) {
    const state = normalizeStoryState(prev);
    const effective = ledgerConfigAt(config, delta.chapterNumber);
    const before = applyMerges(state.ledger, effective.merges, delta.chapterNumber);
    const ops = [...legacyLedgerOps(state, delta), ...(delta.ledgerOps ?? [])];
    const applied = applyLedgerOps({ ...state, ledger: before.ledger }, ops, { chapter: delta.chapterNumber, config: effective });
    const after = applyMerges(applied.ledger, effective.merges, delta.chapterNumber);
    return { ledger: after.ledger, hooks: applied.hooks, events: [...before.events, ...applied.events, ...after.events], violations: applied.violations };
}
export function reduceStoryState(prev, delta, { config = {} } = {}) {
    if (delta.chapterNumber <= prev.chapterNumber) {
        throw new Error(`chapter-out-of-order: prev=${prev.chapterNumber} expected delta>${prev.chapterNumber}`);
    }
    const nextEntries = {};
    for (const key of Object.keys(prev.addressMap.entries)) {
        const e = prev.addressMap.entries[key];
        nextEntries[key] = { term: e.term, sinceChapter: e.sinceChapter, register: e.register };
    }
    for (const a of delta.newAddressEntries) {
        nextEntries[`${a.speakerId}->${a.targetId}`] = {
            term: a.term,
            sinceChapter: delta.chapterNumber,
            register: a.register,
        };
    }
    const nextRelationships = prev.relationships.map((r) => ({
        ...(r.from !== undefined ? { from: r.from } : {}),
        to: r.to,
        kind: r.kind,
        state: r.state,
    }));
    for (const op of delta.relationshipOps) {
        // Direction is part of the key: A->C and B->C are different relationships.
        // Legacy entries without `from` only match ops without `from`.
        const idx = nextRelationships.findIndex((r) => r.to === op.to && r.kind === op.kind && (r.from ?? null) === (op.from ?? null));
        const cloned = { ...(op.from !== undefined ? { from: op.from } : {}), to: op.to, kind: op.kind, state: op.state };
        if (idx >= 0) {
            nextRelationships[idx] = cloned;
        }
        else {
            nextRelationships.push(cloned);
        }
    }
    let nextArcCursor = { ...(prev.arcCursor ?? {}) };
    for (const op of delta.arcCursorOps ?? []) {
        const current = nextArcCursor[op.characterId]?.beat;
        const currentIndex = CHARACTER_ARC_BEATS.indexOf(current);
        const targetIndex = CHARACTER_ARC_BEATS.indexOf(op.nextBeat);
        // Compatibility for plans persisted before arc-plan sequence validation:
        // fold missing forward beats at the same chapter, while advanceCursor
        // remains strict for every direct caller and for regressions.
        if (currentIndex >= 0 && targetIndex > currentIndex + 1) {
            for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
                nextArcCursor = advanceCursor(nextArcCursor, {
                    characterId: op.characterId,
                    nextBeat: CHARACTER_ARC_BEATS[index],
                    chapterNumber: delta.chapterNumber,
                    note: index === targetIndex ? op.note : `legacy plan repair: ${CHARACTER_ARC_BEATS[index]}`,
                });
            }
        }
        else {
            try {
                nextArcCursor = advanceCursor(nextArcCursor, {
                    characterId: op.characterId,
                    nextBeat: op.nextBeat,
                    chapterNumber: delta.chapterNumber,
                    note: op.note,
                });
            }
            catch (error) {
                // The arc cursor is an advisory observation: an arc start over the
                // active quota (e.g. an approved arc opening a third personal arc)
                // is left out rather than failing the chapter commit. Order
                // violations stay errors.
                if (error?.code !== 'ACTIVE_ARC_QUOTA_EXCEEDED')
                    throw error;
            }
        }
    }
    const nextCharacterStates = {};
    for (const [id, entry] of Object.entries(prev.characterStates ?? {})) {
        nextCharacterStates[id] = { ...entry, knownFacts: [...(entry.knownFacts ?? [])] };
    }
    for (const change of delta.mutableChanges ?? []) {
        const current = nextCharacterStates[change.characterId] ?? { knownFacts: [] };
        const knownFacts = [...current.knownFacts];
        for (const fact of change.knownFactsAdded ?? []) {
            if (!knownFacts.includes(fact))
                knownFacts.push(fact);
        }
        nextCharacterStates[change.characterId] = {
            ...current,
            ...(VITAL_STATUSES.has(change.vitalStatus) ? { vitalStatus: change.vitalStatus } : {}),
            ...(change.location ? { location: change.location } : {}),
            ...(change.status ? { status: change.status } : {}),
            knownFacts,
            sinceChapter: delta.chapterNumber,
        };
    }
    const ledger = ledgerStep(prev, delta, { config });
    return {
        workId: prev.workId,
        chapterNumber: delta.chapterNumber,
        addressMap: { entries: nextEntries },
        relationships: nextRelationships,
        hooks: ledger.hooks,
        ledger: ledger.ledger,
        trackedEntities: [],
        // Present only once a character state was recorded, so states of
        // works that never recorded one stay byte-identical.
        ...(Object.keys(nextCharacterStates).length ? { characterStates: nextCharacterStates } : {}),
        // Arc Flow Stage A (EPIC #191) — Stage A 는 carry-forward 만.
        // 신규 ChapterDelta.arcCursorOps 는 Stage B 가 추가 (delta-driven 갱신).
        arcCursor: nextArcCursor,
    };
}
/** Initial empty state for chapter 0. */
export function emptyStoryState(workId) {
    return {
        workId,
        chapterNumber: 0,
        addressMap: { entries: {} },
        relationships: [],
        hooks: [],
        ledger: emptyLedger(),
        trackedEntities: [],
        arcCursor: {},
    };
}
