/**
 * foundationInit step — assemble a Foundation from the upstream
 * (worldbuild, castDesign, genreProfile) outputs.
 *
 * Mechanics:
 *   - Start with `createFoundation({workId, genre, genreProfile})`.
 *   - Append worldFacts directly (no public mutator — worldFacts are
 *     append-only in the same spirit as character registration; we shape a new
 *     Foundation object preserving the rest of the structure).
 *   - For each character: validate, then `registerCharacter()`.
 *   - On duplicate-id from upstream, the caller (`worldbuild` composer) is
 *     responsible for uniquifying; we still defensively re-uniquify here in
 *     case a downstream caller invokes us directly.
 */
import { createFoundation, registerCharacter, } from '../../../continuity/foundation.js';
function uniquifyCharacterId(seen, id) {
    if (!seen.has(id)) {
        seen.add(id);
        return id;
    }
    let n = 2;
    while (seen.has(`${id}-${n}`))
        n += 1;
    const next = `${id}-${n}`;
    seen.add(next);
    return next;
}
export function foundationInit(ctx, input) {
    let foundation = createFoundation({
        workId: ctx.workId,
        genre: input.genre,
        genreProfile: input.genreProfile,
        ...(input.povMode ? { povMode: input.povMode } : {}),
    });
    // World facts — append directly. They're not character-registered so
    // `registerCharacter` doesn't apply; the structure of Foundation guarantees
    // append-only semantics on this slot just by being constructed once.
    if (input.worldFacts.length > 0) {
        foundation = {
            ...foundation,
            worldFacts: [...foundation.worldFacts, ...input.worldFacts],
        };
    }
    // Characters — register one at a time so the registry's duplicate detection
    // runs. We pre-uniquify defensively for robustness against direct callers.
    const seen = new Set(foundation.characters.map((c) => c.id));
    for (const c of input.characters) {
        const safeId = uniquifyCharacterId(seen, c.id);
        const safeChar = safeId === c.id ? c : { ...c, id: safeId };
        foundation = registerCharacter(foundation, safeChar);
    }
    return foundation;
}
