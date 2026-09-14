/**
 * POV narrator resolver — picks the narrator character for a scene so the
 * downstream POV check (pov-check.ts) can flag knowledge leaks across
 * narrative voice.
 *
 * Deterministic heuristic, no LLM:
 *   - omniscient / multi-pov → null (skip — narrator can know anything)
 *   - first-person / limited-third → cast-manifest head ?? Foundation
 *     protagonist (first char with role contains '주인공') ?? first character.
 *
 * T9.1 will lift povMode to Work.povMode + DB persistence; until then we
 * default to 'limited-third' when foundation.povMode is absent.
 */
const DEFAULT_POV = 'limited-third';
export function resolveNarrator(input) {
    const povMode = input.foundation.povMode ?? DEFAULT_POV;
    if (povMode === 'omniscient' || povMode === 'multi-pov') {
        return { narratorId: null, povMode };
    }
    if (input.foundation.characters.length === 0) {
        return { narratorId: null, povMode };
    }
    // Cast-manifest head — writer's declared focal character for this chapter.
    const manifestHead = input.castManifest[0]?.characterId;
    const knownIds = new Set(input.foundation.characters.map((c) => c.id));
    if (manifestHead && knownIds.has(manifestHead)) {
        return { narratorId: manifestHead, povMode };
    }
    // Foundation protagonist by role label.
    const protagonist = input.foundation.characters.find((c) => c.intrinsic.role.includes('주인공'));
    if (protagonist) {
        return { narratorId: protagonist.id, povMode };
    }
    // Fallback: first registered character.
    return { narratorId: input.foundation.characters[0].id, povMode };
}
