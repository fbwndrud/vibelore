/**
 * Character entity — canonical fact lives here, not in prose.
 *
 * Intrinsic attributes are stored explicitly so later chapters cannot silently
 * reinterpret a character's gender, age, role, or appearance from prose.
 *
 * Engine contract:
 *   - `Character.intrinsic` is pinned at the chapter the character is
 *     registered in. The Foundation registry (T2.2) enforces this.
 *   - Legal mutation only via an append-only `IntrinsicChangeEvent` log
 *     with a narrative cause (physical transformation, magical sex change,
 *     etc.). Identity reveals are NOT intrinsic changes — they're
 *     `mutable.knownFacts` updates.
 *   - Effective intrinsic at any chapter = fold(base, applied events).
 *     Implemented in T2.1.
 */
/**
 * Arc Flow Stage A (EPIC #191) — convenience accessor.
 * Returns the contradiction string or '' for legacy Characters where the field
 * was missing at deserialization.
 */
export function getContradiction(c) {
    return typeof c.contradiction === 'string' ? c.contradiction : '';
}
const WEAK_ARCHETYPE_PATTERNS = [
    /^선과 악$/,
    /^강함과 약함$/,
    /^정의와 악$/,
    /^빛과 어둠$/,
    /^삶과 죽음$/,
];
export function checkContradictionStrength(contradiction) {
    const trimmed = contradiction.trim();
    if (trimmed.length === 0)
        return 'missing';
    if (WEAK_ARCHETYPE_PATTERNS.some((re) => re.test(trimmed)))
        return 'weak';
    // 20 자 미만 + 동사 어미 ('다'/'다.'/'기'/'는'/'면') 없으면 archetype 두 단어 가능성.
    const hasActionMarker = /(다|기|는|면)\b|[가-힣]다\.?$/.test(trimmed);
    if (trimmed.length < 20 && !hasActionMarker)
        return 'weak';
    return 'strong';
}
/**
 * Fold `base` with all `events` whose `atChapter <= atChapter`, applied in
 * ascending chapter order (stable for equal chapters).
 *
 * Contract:
 *   - Caller MUST pre-filter `events` to a single character. This function
 *     does not consult `event.characterId`. Mixing characters here is a
 *     caller bug.
 *   - Pure: `base` is not mutated. A fresh `CharacterIntrinsic` is returned
 *     (with `coreAppearance` array also shallow-cloned so callers can swap it
 *     atomically via subsequent events).
 *   - Each event requires `event.from` to deep-equal the current value of
 *     `event.field`. The Foundation registry (T2.2) is responsible for
 *     enforcing `from` matches at append time; reaching this branch means
 *     the log was corrupted or built incorrectly, so we throw a
 *     `data-integrity` error rather than silently skipping.
 *   - Events with `atChapter > atChapter` (argument) are ignored.
 */
export function effectiveIntrinsic(base, events, atChapter) {
    const current = {
        ...base,
        coreAppearance: [...base.coreAppearance],
    };
    const applicable = events
        .filter((e) => e.atChapter <= atChapter)
        .map((e, idx) => ({ e, idx }))
        .sort((a, b) => a.e.atChapter - b.e.atChapter || a.idx - b.idx)
        .map((x) => x.e);
    for (const ev of applicable) {
        const field = ev.field;
        const currentValue = current[field];
        if (JSON.stringify(currentValue) !== JSON.stringify(ev.from)) {
            throw new Error(`data-integrity: intrinsic ${String(field)} expected ${JSON.stringify(ev.from)} but base has ${JSON.stringify(currentValue)}`);
        }
        // Safe assignment: `field` is `keyof CharacterIntrinsic` and Foundation
        // is responsible for type-correct `to` values.
        ;
        current[field] = ev.to;
    }
    return current;
}
