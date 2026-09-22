/**
 * reviseFoundation generator — fold founder review feedback onto an existing
 * Foundation, producing a complete replacement Foundation.
 *
 * Item 2 of docs/01-plan/features/rewrite-revise-worklock.plan.md. The
 * foundation review REVISE path (handlers.ts handleFoundationReviewInner) calls
 * this with the current Foundation + the founder's free-text note. The result
 * is a fully-formed Foundation the handler persists via state.saveFoundation —
 * an immutable full replacement (schemaVersion-compatible shape preserved).
 *
 * Reuses the Foundation primitives:
 *   - genre / genreProfile / workId / povMode / intrinsicChanges and any other
 *     slot from the current Foundation are carried forward unchanged.
 *   - new characters are wired in via `registerCharacter` (duplicate-id
 *     detection + append-only semantics).
 *
 * append-only constraint (engine design — community continuation):
 *   - worldFacts: replaced wholesale by the LLM output (still append-only in
 *     spirit — the registry is rebuilt once, not mutated mid-story).
 *   - existing characters: role / coreAppearance / aliases / contradiction /
 *     mutable MAY change. Identity anchors (id, canonicalName, gender, ageBand,
 *     registeredAtChapter) are pinned — LLM attempts to change them are ignored.
 *   - new characters: ADDED.
 *   - removal: FORBIDDEN. Any existing character the LLM omits is kept. A
 *     removal request (existing id absent from output) is logged, not honoured.
 *
 */
import { registerCharacter, } from '../../continuity/foundation.js';
import { normalizeDramaticModel, normalizeIdentityIntrinsic } from '../../continuity/character-design.js';
import { REVISE_FOUNDATION_SYSTEM, buildReviseFoundationUserPrompt, } from '../text/prompts/revise-foundation.js';
function asString(v, fallback = '') {
    return typeof v === 'string' ? v : fallback;
}
function asStringArray(v) {
    if (!Array.isArray(v))
        return [];
    return v.filter((s) => typeof s === 'string');
}
function tryParse(raw) {
    const fenced = raw
        .replace(/```(?:json)?\s*/g, '')
        .replace(/```\s*$/g, '')
        .trim();
    try {
        return JSON.parse(fenced);
    }
    catch {
        return null;
    }
}
/** Parse worldFacts from the LLM patch. Falls back to current facts on absence. */
function parseWorldFacts(raw, current) {
    if (!Array.isArray(raw))
        return current;
    const seen = new Set();
    const out = [];
    let autoSeq = 1;
    for (const item of raw) {
        if (typeof item !== 'object' || item === null)
            continue;
        const obj = item;
        const statement = asString(obj.statement).trim();
        if (statement.length === 0)
            continue;
        let id = asString(obj.id).trim();
        if (id.length === 0 || seen.has(id)) {
            while (seen.has(`wf${autoSeq}`))
                autoSeq += 1;
            id = `wf${autoSeq}`;
            autoSeq += 1;
        }
        seen.add(id);
        out.push({ id, statement, registeredAtChapter: 1 });
    }
    // Empty / unusable output → keep the current facts (never blank the registry).
    return out.length > 0 ? out : current;
}
/**
 * Sentinel narrativeCause that marks an IntrinsicChangeEvent originating from a
 * founder-review revise (as opposed to an in-fiction transformation written by
 * the chapter generator). Used to consolidate repeated revises of the same field
 * into a single event rather than stacking an unbounded history.
 */
const REVISE_NARRATIVE_CAUSE = '발의자 검토 단계 토대 수정 (foundation revise)';
/** Merge a mutable patch object onto a base CharacterMutable (mutable layer — safe to edit). */
function applyMutablePatch(base, raw) {
    if (typeof raw !== 'object' || raw === null)
        return base;
    const obj = raw;
    const status = asString(obj.status).trim();
    const location = asString(obj.location).trim();
    const knownFactsRaw = obj.knownFacts;
    return {
        ...base,
        ...(status.length > 0 ? { status } : {}),
        ...(location.length > 0 ? { location } : {}),
        // Empty-array wipe guard: only replace knownFacts when the patch provides a
        // non-empty array (an [] from the LLM never blanks existing facts).
        ...(Array.isArray(knownFactsRaw) && knownFactsRaw.length > 0
            ? { knownFacts: asStringArray(knownFactsRaw) }
            : {}),
    };
}
/**
 * Apply the LLM's `updatedCharacters` patch onto the existing cast.
 *
 *   - identity anchors (id, canonicalName, registeredAtChapter, gender, ageBand)
 *     are pinned — never taken from the patch.
 *   - intrinsic role / coreAppearance changes are emitted as IntrinsicChangeEvents
 *     (NOT written onto the base) — see CharacterUpdateFoldResult jsdoc.
 *   - aliases / contradiction / mutable are edited directly (non-intrinsic).
 *   - EMPTY-ARRAY WIPE guard: coreAppearance / aliases / knownFacts are only
 *     replaced when the patch array is non-empty. An LLM `[]` is a no-op, never a
 *     wipe.
 *
 * Returns a new array (no mutation of `current`) + the intrinsic events to log.
 */
function applyCharacterUpdates(current, existingEvents, rawUpdates) {
    if (!Array.isArray(rawUpdates)) {
        return { characters: current.map((c) => ({ ...c })), intrinsicEvents: [...existingEvents] };
    }
    const updateById = new Map();
    for (const item of rawUpdates) {
        if (typeof item !== 'object' || item === null)
            continue;
        const obj = item;
        const id = asString(obj.id).trim();
        if (id.length === 0)
            continue;
        updateById.set(id, obj);
    }
    // Start from the existing intrinsic-change log; we consolidate revise-origin
    // events per (characterId, field) so repeated revises don't stack an unbounded
    // history that effectiveIntrinsic would have to fold.
    const events = existingEvents.map((e) => ({ ...e }));
    const upsertReviseEvent = (c, field, nextValue) => {
        // `from` MUST be the character's pinned BASE value for this field so the
        // event chain stays append-only-consistent: effectiveIntrinsic folds base→to.
        // (We anchor revise events at registeredAtChapter, so `from` = base, not the
        // post-fold value — a single consolidated event per field per character.)
        const baseValue = c.intrinsic[field];
        // No-op if the requested value equals the base (nothing to log).
        if (JSON.stringify(baseValue) === JSON.stringify(nextValue)) {
            // Drop any prior revise event for this field — the founder reverted it.
            const idx = events.findIndex((e) => e.characterId === c.id &&
                e.field === field &&
                e.narrativeCause === REVISE_NARRATIVE_CAUSE);
            if (idx >= 0)
                events.splice(idx, 1);
            return;
        }
        const existingIdx = events.findIndex((e) => e.characterId === c.id &&
            e.field === field &&
            e.narrativeCause === REVISE_NARRATIVE_CAUSE);
        const event = {
            characterId: c.id,
            atChapter: c.registeredAtChapter,
            field,
            from: baseValue,
            to: nextValue,
            narrativeCause: REVISE_NARRATIVE_CAUSE,
        };
        if (existingIdx >= 0) {
            // Consolidate: replace the prior revise event's `to` (keeps `from` = base).
            events[existingIdx] = event;
        }
        else {
            events.push(event);
        }
    };
    const characters = current.map((c) => {
        const patch = updateById.get(c.id);
        if (!patch)
            return { ...c };
        // — intrinsic edits → IntrinsicChangeEvents (never overwrite base.intrinsic) —
        const role = asString(patch.role).trim();
        if (role.length > 0) {
            upsertReviseEvent(c, 'role', role);
        }
        const coreAppearanceRaw = patch.coreAppearance;
        // EMPTY-ARRAY WIPE guard: only apply a non-empty coreAppearance patch.
        if (Array.isArray(coreAppearanceRaw) && coreAppearanceRaw.length > 0) {
            upsertReviseEvent(c, 'coreAppearance', asStringArray(coreAppearanceRaw));
        }
        // — non-intrinsic edits → directly on the Character (safe) —
        const aliasesRaw = patch.aliases;
        const contradiction = asString(patch.contradiction).trim();
        const next = {
            ...c,
            // base intrinsic is carried forward UNCHANGED — edits flow through events.
            intrinsic: { ...c.intrinsic },
            mutable: applyMutablePatch(c.mutable, patch.mutable),
            // EMPTY-ARRAY WIPE guard: only replace aliases when the patch is non-empty.
            ...(Array.isArray(aliasesRaw) && aliasesRaw.length > 0
                ? { aliases: asStringArray(aliasesRaw) }
                : {}),
            ...(contradiction.length > 0 ? { contradiction } : {}),
        };
        return next;
    });
    return { characters, intrinsicEvents: events };
}
/** Parse a single new-character object into a Character. Returns null if unusable. */
function parseNewCharacter(raw, fallbackId) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const obj = raw;
    const canonicalName = asString(obj.canonicalName).trim();
    if (canonicalName.length === 0)
        return null;
    const id = asString(obj.id).trim() || fallbackId;
    const intrinsicRaw = (obj.intrinsic ?? {});
    const mutableRaw = (obj.mutable ?? {});
    const statusRaw = asString(mutableRaw.status, 'alive');
    const locationRaw = asString(mutableRaw.location);
    const contradiction = asString(obj.contradiction).trim();
    const character = {
        id,
        canonicalName,
        aliases: asStringArray(obj.aliases),
        registeredAtChapter: 1,
        intrinsic: normalizeIdentityIntrinsic(intrinsicRaw),
        mutable: {
            status: statusRaw.length > 0 ? statusRaw : 'alive',
            knownFacts: asStringArray(mutableRaw.knownFacts),
            ...(locationRaw.length > 0 ? { location: locationRaw } : {}),
        },
        relationships: [],
        ...(contradiction.length > 0 ? { contradiction } : {}),
    };
    character.dramaticModel = normalizeDramaticModel(obj.dramaticModel, character);
    return character;
}
/**
 * Revise a Foundation from founder feedback. Returns a complete, fully-formed
 * Foundation. Throws on empty feedback or unparseable LLM output (caller
 * refunds the 0-amount hold + marks the job failed).
 */
export async function reviseFoundation(input) {
    const feedback = input.feedback.trim();
    if (feedback.length === 0) {
        throw new Error('reviseFoundation: feedback is empty');
    }
    const { current } = input;
    const language = input.language ?? 'ko';
    const userPrompt = buildReviseFoundationUserPrompt({
        feedback,
        genre: current.genre,
        language,
        worldFacts: current.worldFacts.map((wf) => ({ id: wf.id, statement: wf.statement })),
        characters: current.characters.map((c) => ({
            id: c.id,
            canonicalName: c.canonicalName,
            role: c.intrinsic.role,
            aliases: c.aliases,
            gender: c.intrinsic.gender,
            ageBand: c.intrinsic.ageBand,
            contradiction: typeof c.contradiction === 'string' ? c.contradiction : '',
        })),
    });
    const req = {
        model: input.model,
        step: 'revise-foundation',
        messages: [
            { role: 'system', content: REVISE_FOUNDATION_SYSTEM },
            { role: 'user', content: userPrompt },
        ],
        jsonMode: true,
    };
    const res = await input.providers.complete(req);
    const parsed = tryParse(res.text);
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('reviseFoundation parse failed');
    }
    const patch = parsed;
    // 1) worldFacts — replace wholesale (fallback to current on empty).
    const worldFacts = parseWorldFacts(patch.worldFacts, current.worldFacts);
    // 2) existing characters — apply updates, preserving identity anchors AND the
    //    pinned base intrinsic. role/coreAppearance edits are emitted as
    //    IntrinsicChangeEvents (never written onto the base) so effectiveIntrinsic
    //    stays consistent. No removals: every current character is carried forward.
    const { characters: updatedExisting, intrinsicEvents } = applyCharacterUpdates(current.characters, current.intrinsicChanges, patch.updatedCharacters);
    // 3) detect + log ignored removal requests. The LLM cannot remove characters,
    //    but if it returns updatedCharacters referencing ids that don't exist OR
    //    omits ids it "intended" to drop, we keep them silently. We surface the
    //    count of existing ids that were NOT mentioned in any patch so ops can see
    //    whether the model tried to prune.
    if (input.log) {
        const mentioned = new Set();
        if (Array.isArray(patch.updatedCharacters)) {
            for (const item of patch.updatedCharacters) {
                if (typeof item === 'object' && item !== null) {
                    const id = asString(item.id).trim();
                    if (id)
                        mentioned.add(id);
                }
            }
        }
        const unmentioned = current.characters
            .map((c) => c.id)
            .filter((id) => !mentioned.has(id));
        if (unmentioned.length > 0) {
            input.log.info('revise-foundation:characters_kept_unmentioned', {
                workId: current.workId,
                keptIds: unmentioned,
                note: 'append-only: existing characters are never removed by revise',
            });
        }
    }
    // 4) rebuild the Foundation. FIELD CARRY-FORWARD (rewrite-revise-worklock review):
    //    base-spread `...current` FIRST so EVERY existing Foundation field is
    //    preserved (no silent drop of a field this generator doesn't know about —
    //    schemaVersion compatibility), THEN apply targeted overrides. Previously
    //    this re-built via createFoundation() and re-added known slots one-by-one,
    //    which dropped any field outside that explicit list.
    let foundation = {
        ...current,
        worldFacts,
        // intrinsicChanges = existing log + consolidated revise events (role/coreAppearance
        // edits flow through here, NOT through base.intrinsic mutation).
        intrinsicChanges: intrinsicEvents,
        // existing characters with non-intrinsic edits applied + base intrinsic intact.
        characters: updatedExisting,
    };
    // Register new characters through the registry so duplicate-id detection runs
    // against the existing set. Skip any that collide (LLM re-emitted an existing
    // id as "new") rather than throwing — append-only revise should be resilient.
    const existingIds = new Set(updatedExisting.map((c) => c.id));
    const rawNew = Array.isArray(patch.newCharacters) ? patch.newCharacters : [];
    let autoNewSeq = updatedExisting.length + 1;
    for (const item of rawNew) {
        let fallbackId = `c${autoNewSeq}`;
        while (existingIds.has(fallbackId)) {
            autoNewSeq += 1;
            fallbackId = `c${autoNewSeq}`;
        }
        const character = parseNewCharacter(item, fallbackId);
        if (!character)
            continue;
        if (existingIds.has(character.id)) {
            // Collision with an existing id — the model mislabelled an update as new.
            // Skip rather than duplicate; the update path already preserved the row.
            input.log?.warn('revise-foundation:new_character_id_collision', {
                workId: current.workId,
                id: character.id,
            });
            continue;
        }
        foundation = registerCharacter(foundation, character);
        existingIds.add(character.id);
        autoNewSeq += 1;
    }
    return { foundation };
}
