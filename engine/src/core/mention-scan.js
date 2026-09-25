/**
 * P4b (#516, Epic #511) — entity mention scan (NovelAI Lorebook activation-key
 * 패턴).
 *
 * Matching (Phase 2B):
 *   - Hangul (Unicode Script=Hangul, including Jamo) in the term: substring so
 *     particles attach. NFD jamo names + attached 은 still match.
 *   - Han/Hiragana/Katakana: substring. 1-character terms stay excluded
 *     (minTermLength=2). Short-name overlap is observed, not NER.
 *   - Other letters: Unicode letter/number/mark boundaries so "Ann" does not
 *     fire inside "banner", "anniversary", or "Ann\u0301a". Case-insensitive.
 *   - Mixed Hangul/Latin or CJK/Latin aliases use the Hangul/CJK substring
 *     path with Unicode case folding (`iu`).
 *   - retired/destroyed entity 는 활성 후보에서 제외.
 *
 * This is an activation-key heuristic, not exhaustive registration coverage.
 */
const DEFAULT_MIN_TERM_LENGTH = 2;
const HANGUL_RE = /\p{Script=Hangul}/u;
const CJK_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u;
const WORD_CONSTITUENT = '[\\p{L}\\p{N}\\p{M}]';

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termScript(term) {
    if (HANGUL_RE.test(term))
        return 'hangul';
    if (CJK_RE.test(term))
        return 'cjk';
    return 'bounded';
}

function caseInsensitiveContains(text, term) {
    return new RegExp(escapeRegex(term), 'iu').test(text);
}

/**
 * Whether `term` occurs in `text` under the mention-scan matching rules.
 * Shared with destroyed-entity mention so case/boundary policy stays one place.
 */
export function termOccursInText(text, term, options = {}) {
    const minLen = options.minTermLength ?? DEFAULT_MIN_TERM_LENGTH;
    if (typeof text !== 'string' || typeof term !== 'string')
        return false;
    const trimmed = term.trim();
    if (trimmed.length < minLen)
        return false;
    const script = termScript(trimmed);
    if (script === 'hangul' || script === 'cjk')
        return caseInsensitiveContains(text, trimmed);
    const pattern = new RegExp(`(?<!${WORD_CONSTITUENT})${escapeRegex(trimmed)}(?!${WORD_CONSTITUENT})`, 'iu');
    return pattern.test(text);
}

/** 텍스트에서 entity 멘션을 감지한다. 텍스트/스냅샷이 비면 빈 결과. */
export function scanEntityMentions(input) {
    const minLen = input.minTermLength ?? DEFAULT_MIN_TERM_LENGTH;
    const mentionedIds = [];
    const matchedTerms = {};
    if (input.text.length === 0 || input.snapshots.length === 0) {
        return { mentionedIds, matchedTerms };
    }
    for (const snapshot of input.snapshots) {
        if (snapshot.status === 'retired' || snapshot.status === 'destroyed')
            continue;
        const terms = [snapshot.canonicalName, ...snapshot.aliases];
        for (const term of terms) {
            if (termOccursInText(input.text, term, { minTermLength: minLen })) {
                mentionedIds.push(snapshot.entityId);
                matchedTerms[snapshot.entityId] = term.trim();
                break;
            }
        }
    }
    return { mentionedIds, matchedTerms };
}
