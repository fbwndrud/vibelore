/**
 * Deterministic continuity checks for names and address terms.
 *
 * An attributed term can conflict with a registered character's fixed attributes.
 * Unattributed prose matches remain advisory because their target is uncertain.
 * These checks do not claim to detect every possible narrative contradiction.
 */
import { effectiveIntrinsic } from './character.js';
/**
 * Layer-1 lexicon scan. See module-level doc for design rationale.
 *
 * Two modes:
 *   - Mode A (hints): caller supplies attributed term spans → may emit hard
 *     violations on gender mismatch.
 *   - Mode B (no hints): best-effort prose scan → only emits soft violations
 *     (attribution is uncertain without a parser).
 */
export function scanLexicon(input) {
    const { prose, chapterNumber, foundation, lexicon, hints } = input;
    if (!prose || prose.length === 0) {
        return { violations: [] };
    }
    if (foundation.characters.length === 0) {
        return { violations: [] };
    }
    if (hints && hints.length > 0) {
        return { violations: scanWithHints(hints, chapterNumber, foundation, lexicon) };
    }
    return { violations: scanProse(prose, chapterNumber, foundation, lexicon) };
}
function effectiveGenderAt(character, chapterNumber, foundation) {
    const events = foundation.intrinsicChanges.filter((e) => e.characterId === character.id);
    return effectiveIntrinsic(character.intrinsic, events, chapterNumber).gender;
}
function scanWithHints(hints, chapterNumber, foundation, lexicon) {
    const out = [];
    const seen = new Set();
    for (const hint of hints) {
        const entry = lexicon.lookup(hint.term);
        if (!entry)
            continue;
        if (!entry.genderImplication)
            continue;
        if (!hint.targetId)
            continue;
        const character = foundation.characters.find((c) => c.id === hint.targetId);
        if (!character)
            continue;
        const effective = effectiveGenderAt(character, chapterNumber, foundation);
        if (effective !== 'male' && effective !== 'female')
            continue;
        if (effective === entry.genderImplication)
            continue;
        const key = `${character.id}:${hint.span.start}:${hint.span.end}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({
            severity: 'hard',
            code: 'GENDER_HONORIFIC_MISMATCH',
            chapterNumber,
            characterId: character.id,
            span: hint.span,
            message: `호칭 '${hint.term}' 은 성별 ${entry.genderImplication} 함의 — 캐릭터 ${character.id} intrinsic.gender=${effective}`,
        });
    }
    return out;
}
/**
 * Boundary = anywhere that is NOT a hangul syllable or an ASCII alphanumeric.
 * Covers whitespace, ASCII punctuation (incl. `"` `'` `(` `)`), CJK
 * punctuation, halfwidth/fullwidth forms — without enumerating each.
 * Korean prose frequently surrounds honorifics with ASCII quotes
 * (e.g. `… "도련님" …`), so a positive-list boundary class misses those.
 */
const BOUNDARY_CLASS = '(?:^|[^\\uac00-\\ud7a3a-zA-Z0-9])';
const BOUNDARY_TAIL = '(?:[^\\uac00-\\ud7a3a-zA-Z0-9]|$)';
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function findOccurrences(prose, term) {
    const pattern = new RegExp(`${BOUNDARY_CLASS}(${escapeRegex(term)})${BOUNDARY_TAIL}`, 'g');
    const out = [];
    for (;;) {
        const match = pattern.exec(prose);
        if (!match)
            break;
        const groupIndex = match.index + match[0].indexOf(match[1]);
        out.push({ start: groupIndex, end: groupIndex + match[1].length });
        // Allow overlapping boundary chars to start the next match.
        if (pattern.lastIndex === match.index)
            pattern.lastIndex++;
    }
    return out;
}
function characterNamedInProse(character, prose) {
    if (prose.includes(character.canonicalName))
        return true;
    for (const alias of character.aliases) {
        if (alias && prose.includes(alias))
            return true;
    }
    return false;
}
function scanProse(prose, chapterNumber, foundation, lexicon) {
    const events = [];
    const seen = new Set();
    const gendered = lexicon.all().filter((e) => !!e.genderImplication);
    const candidatesByCharId = new Map();
    for (const c of foundation.characters) {
        if (c.registeredAtChapter > chapterNumber)
            continue;
        if (c.intrinsic.gender !== 'male' && c.intrinsic.gender !== 'female')
            continue;
        candidatesByCharId.set(c.id, c);
    }
    for (const entry of gendered) {
        const occurrences = findOccurrences(prose, entry.term);
        if (occurrences.length === 0)
            continue;
        const conflicting = [];
        for (const character of candidatesByCharId.values()) {
            const effective = effectiveGenderAt(character, chapterNumber, foundation);
            if (effective !== 'male' && effective !== 'female')
                continue;
            if (effective === entry.genderImplication)
                continue;
            conflicting.push(character);
        }
        if (conflicting.length === 0)
            continue;
        for (const occurrence of occurrences) {
            if (conflicting.length === 1) {
                const character = conflicting[0];
                if (!characterNamedInProse(character, prose))
                    continue;
                const key = `${character.id}:${occurrence.start}:${occurrence.end}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                events.push({
                    occurrence,
                    violation: {
                        severity: 'soft',
                        code: 'GENDER_HONORIFIC_MISMATCH',
                        chapterNumber,
                        characterId: character.id,
                        span: occurrence,
                        message: `호칭 '${entry.term}' 은 성별 ${entry.genderImplication} 함의 — 캐릭터 ${character.id} intrinsic.gender=${effectiveGenderAt(character, chapterNumber, foundation)} (attribution: heuristic)`,
                    },
                });
            }
            else {
                const ids = conflicting.map((c) => c.id).sort();
                const key = `__ambig__:${entry.term}:${occurrence.start}:${occurrence.end}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                events.push({
                    occurrence,
                    violation: {
                        severity: 'soft',
                        code: 'CAST_MANIFEST_MISMATCH',
                        chapterNumber,
                        span: occurrence,
                        message: `호칭 '${entry.term}' 모호 — 충돌 후보 ${ids.join(', ')} — layer-2 cast-manifest 해결 필요`,
                    },
                });
            }
        }
    }
    events.sort((a, b) => a.occurrence.start - b.occurrence.start);
    return events.map((e) => e.violation);
}
