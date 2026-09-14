/**
 * StoryState — a structured snapshot carried forward across chapters.
 *
 * StoryState(N) = reduceStoryState(StoryState(N-1), ChapterDelta(N)).
 * Every work tracks address terms, relationships, and unresolved story hooks.
 * Genre profiles add typed categories of tracked entities. Reducers return new
 * containers so evaluating a candidate does not mutate the prior snapshot.
 */
import { advanceCursor, CHARACTER_ARC_BEATS } from './character-arc.js';
/**
 * Hook lifecycle. A hook is a narrative promise the reader is still holding.
 *   planted   — introduced, nothing has moved yet
 *   advancing — new information or stakes landed in a later chapter
 *   paid      — answered on the page
 *   parked    — the story deliberately set it aside for now
 */
export const HOOK_PHASES = ['planted', 'advancing', 'paid', 'parked'];
/** How soon the reader expects the payoff. Semantic, never a chapter count. */
export const HOOK_HORIZONS = ['next', 'soon', 'arc', 'long', 'finale'];
const LEGACY_PHASE = { open: 'planted', progressing: 'advancing', resolved: 'paid', deferred: 'parked' };
const LEGACY_HORIZON = { immediate: 'next', 'near-term': 'soon', 'mid-arc': 'arc', 'slow-burn': 'long', endgame: 'finale' };
/** True while the hook still owes the reader something. */
export function isHookActive(hook) {
    const phase = hook?.phase ?? LEGACY_PHASE[hook?.status] ?? 'planted';
    return phase === 'planted' || phase === 'advancing';
}
/**
 * Normalize a hook record into the current shape. Accepts records written by
 * earlier vibelore builds so existing projects keep opening.
 */
export function normalizeHook(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const id = raw.id ?? raw.hookId;
    if (typeof id !== 'string' || id.length === 0)
        return null;
    const text = raw.text ?? raw.description ?? '';
    const plantedAtChapter = raw.plantedAtChapter ?? raw.startChapter;
    let phase = raw.phase ?? LEGACY_PHASE[raw.status];
    if (!HOOK_PHASES.includes(phase))
        phase = 'planted';
    let horizon = raw.horizon ?? LEGACY_HORIZON[raw.payoffTiming];
    if (!HOOK_HORIZONS.includes(horizon))
        horizon = undefined;
    const lastMovedChapter = raw.lastMovedChapter ?? raw.lastAdvancedChapter ?? plantedAtChapter;
    const { hookId, description, startChapter, status, payoffTiming, lastAdvancedChapter, ...rest } = raw;
    return {
        ...rest,
        id,
        text,
        ...(plantedAtChapter !== undefined ? { plantedAtChapter } : {}),
        phase,
        ...(horizon ? { horizon } : {}),
        ...(lastMovedChapter !== undefined ? { lastMovedChapter } : {}),
    };
}
/** Normalize a persisted StoryState (or null) into the current shape. */
export function normalizeStoryState(state) {
    if (!state || typeof state !== 'object')
        return state;
    const hooks = Array.isArray(state.hooks) ? state.hooks.map(normalizeHook).filter(Boolean) : [];
    return { ...state, hooks };
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
 *      entry whose `(to, kind)` matches, preserving position; otherwise
 *      appended at the end.
 *   3. `hooks`: upsert by `id`. Replace in place if present, else append.
 *      Records are normalized through `normalizeHook` so snapshots written by
 *      earlier vibelore builds (`hookId`/`status`/`payoffTiming` vocabulary)
 *      load into the current `id`/`phase`/`horizon` shape.
 *   4. `trackedEntities`: upsert by `kind` (one snapshot per kind). Replace in
 *      place if present, else append.
 *
 * NOT applied to StoryState (consumed by other layers):
 *   - `delta.mutableChanges`: folded into `Character.mutable` by the
 *     Foundation registry — Character lives in Foundation, not StoryState.
 *   - `delta.appearedCharacterIds`: writer cast-manifest output consumed by
 *     the continuity check / context builder; not part of carry-forward state.
 *
 * Throws `chapter-out-of-order` if `delta.chapterNumber <= prev.chapterNumber`.
 */
export function reduceStoryState(prev, delta) {
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
        to: r.to,
        kind: r.kind,
        state: r.state,
    }));
    for (const op of delta.relationshipOps) {
        const idx = nextRelationships.findIndex((r) => r.to === op.to && r.kind === op.kind);
        const cloned = { to: op.to, kind: op.kind, state: op.state };
        if (idx >= 0) {
            nextRelationships[idx] = cloned;
        }
        else {
            nextRelationships.push(cloned);
        }
    }
    const nextHooks = (prev.hooks ?? []).map(normalizeHook).filter(Boolean);
    for (const raw of delta.hookChanges ?? delta.hookOps ?? []) {
        const cloned = normalizeHook(raw);
        if (!cloned)
            continue;
        const idx = nextHooks.findIndex((h) => h.id === cloned.id);
        if (idx >= 0) {
            nextHooks[idx] = cloned;
        }
        else {
            nextHooks.push(cloned);
        }
    }
    const nextTracked = prev.trackedEntities.map((t) => ({
        kind: t.kind,
        data: { ...t.data },
    }));
    for (const op of delta.trackedEntityOps) {
        const idx = nextTracked.findIndex((t) => t.kind === op.kind);
        const cloned = { kind: op.kind, data: { ...op.data } };
        if (idx >= 0) {
            nextTracked[idx] = cloned;
        }
        else {
            nextTracked.push(cloned);
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
            nextArcCursor = advanceCursor(nextArcCursor, {
                characterId: op.characterId,
                nextBeat: op.nextBeat,
                chapterNumber: delta.chapterNumber,
                note: op.note,
            });
        }
    }
    return {
        workId: prev.workId,
        chapterNumber: delta.chapterNumber,
        addressMap: { entries: nextEntries },
        relationships: nextRelationships,
        hooks: nextHooks,
        trackedEntities: nextTracked,
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
        trackedEntities: [],
        arcCursor: {},
    };
}
