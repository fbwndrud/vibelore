/**
 * Foundation — append-only registry of canonical fact for one work.
 *
 * Holds the world facts, the character registry, the intrinsic-change log,
 * and the bound genre profile. Append-only design supports community-driven
 * continuation: a later contributor may introduce new characters at any
 * chapter, but cannot mutate an existing character's pinned intrinsic.
 *
 * Implementation in T2.2.
 */
import { effectiveIntrinsic, getContradiction, } from './character.js';
function registryError(code, message) {
    return Object.assign(new Error(message), { code });
}
export function registerCharacter(f, c, opts = {}) {
    if (f.characters.some((existing) => existing.id === c.id)) {
        throw registryError('DUPLICATE_CHARACTER_ID', `Foundation: character id "${c.id}" already registered`);
    }
    if (opts.enforceContradiction && getContradiction(c).trim().length === 0) {
        throw registryError('MISSING_CONTRADICTION', `Foundation: character "${c.id}" requires non-empty contradiction (좌담 통찰 #05). 예: "모범생 학생회장이지만 비밀리에 빈집털이"`);
    }
    return {
        ...f,
        characters: [...f.characters, c],
    };
}
/**
 * Append an intrinsic change event. Throws MISSING_NARRATIVE_CAUSE if
 * `narrativeCause` is empty, UNKNOWN_CHARACTER if `characterId` is not
 * registered. Does NOT mutate `Character.intrinsic` directly — effective
 * intrinsic is derived via `effectiveIntrinsic()` at read time.
 */
export function appendIntrinsicChange(f, e) {
    if (!e.narrativeCause || e.narrativeCause.trim().length === 0) {
        throw registryError('MISSING_NARRATIVE_CAUSE', `Foundation: intrinsic change for "${e.characterId}" at chapter ${e.atChapter} requires non-empty narrativeCause`);
    }
    const character = f.characters.find((c) => c.id === e.characterId);
    if (!character) {
        throw registryError('UNKNOWN_CHARACTER', `Foundation: intrinsic change references unknown character id "${e.characterId}"`);
    }
    const priorEvents = f.intrinsicChanges.filter((ev) => ev.characterId === e.characterId);
    const priorChapter = e.atChapter - 1;
    const expected = effectiveIntrinsic(character.intrinsic, priorEvents, priorChapter);
    const expectedValue = expected[e.field];
    if (JSON.stringify(expectedValue) !== JSON.stringify(e.from)) {
        throw registryError('INTRINSIC_LOCKED', `Foundation: intrinsic ${String(e.field)} for "${e.characterId}" at chapter ${e.atChapter} expected from=${JSON.stringify(expectedValue)} but event has from=${JSON.stringify(e.from)}`);
    }
    return {
        ...f,
        intrinsicChanges: [...f.intrinsicChanges, e],
    };
}
/**
 * Resolve a character to its effective form at `atChapter`. Returns the
 * character with `intrinsic` folded over applied events ≤ `atChapter`.
 */
export function resolveCharacter(f, atChapter, id) {
    const character = f.characters.find((c) => c.id === id);
    if (!character) {
        throw registryError('UNKNOWN_CHARACTER', `Foundation: no character with id "${id}"`);
    }
    if (character.registeredAtChapter > atChapter) {
        throw registryError('UNKNOWN_CHARACTER', `Foundation: character "${id}" not yet registered at chapter ${atChapter} (registered at ${character.registeredAtChapter})`);
    }
    const events = f.intrinsicChanges.filter((ev) => ev.characterId === id);
    const intrinsic = effectiveIntrinsic(character.intrinsic, events, atChapter);
    return { ...character, intrinsic };
}
/** Initialize an empty Foundation bound to a genre profile. */
export function createFoundation(args) {
    return {
        workId: args.workId,
        genre: args.genre,
        worldFacts: [],
        characters: [],
        intrinsicChanges: [],
        genreProfile: args.genreProfile,
        ...(args.povMode ? { povMode: args.povMode } : {}),
        ...(args.worldEra ? { worldEra: args.worldEra } : {}),
        ...(args.fanficSource ? { fanficSource: args.fanficSource } : {}),
        ...(args.worldGroup ? { worldGroup: args.worldGroup } : {}),
    };
}
