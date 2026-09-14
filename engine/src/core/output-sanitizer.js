/**
 * OutputSanitizer — mandatory gate before a chapter artifact is persisted.
 *
 * Sentinel blocks (`⟦vle:tag … ⟧`) carry machine metadata and are removed
 * before persistence. Ordinary bracketed prose is preserved. Bracketed
 * machine annotations outside a sentinel are flagged for review.
 *
 * Layer-1 contract (T1.1):
 *   1. Strip all `⟦vle:tag … ⟧` blocks from the prose.
 *   2. Return the cleaned prose, the list of removed blocks, and a `leaked`
 *      flag set when a residual sentinel or known internal pattern remained.
 *   3. Leak detection runs **after** strip — any sentinel marker still present
 *      means the strip did not converge, which is a HARD FAIL upstream.
 */
export const SENTINEL_OPEN = '⟦vle:';
export const SENTINEL_CLOSE = '⟧';
/**
 * Tags reserved for engine-internal sentinel blocks. The TextGenerator
 * (T3.3) emits these alongside the chapter prose; the sanitizer strips them
 * before publish. Complete blocks with other well-formed tags are also stripped.
 */
export const RESERVED_SENTINEL_TAGS = ['cast-manifest', 'delta-hint', 'reviser-note'];
function* sentinelBlocks(raw) {
    // Consume the header once, then search for its close once. Combining
    // whitespace and body repetition backtracks quadratically on an orphan.
    const header = /⟦vle:([a-z][a-z0-9-]*)\s+/g;
    for (let match; (match = header.exec(raw));) {
        const close = raw.indexOf(SENTINEL_CLOSE, header.lastIndex);
        if (close === -1)
            return;
        yield { start: match.index, end: close + 1,
            tag: match[1], body: raw.slice(header.lastIndex, close) };
        header.lastIndex = close + 1;
    }
}
function hasInternalAnnotation(prose) {
    // Read each label once, including an unfinished label. Classify by its
    // metadata purpose rather than a particular external writer's vocabulary.
    const metadataKinds = new Set(['note', 'hint', 'manifest', 'ops']);
    const phases = new Set(['draft', 'review', 'reviser', 'state']);
    for (const [, label] of prose.matchAll(/\[([a-z][a-z0-9-]*)/gi)) {
        const parts = label.toLowerCase().split('-');
        if (parts.length > 1 && (metadataKinds.has(parts.at(-1)) || phases.has(parts[0])))
            return true;
    }
    return false;
}
export class DefaultOutputSanitizer {
    sanitize(raw) {
        const removed = [];
        const parts = [];
        let cursor = 0;
        for (const { start, end, tag, body } of sentinelBlocks(raw)) {
            parts.push(raw.slice(cursor, start));
            removed.push({ tag, body });
            cursor = end;
        }
        parts.push(raw.slice(cursor));
        const clean = parts.join('');
        const leaked = clean.includes(SENTINEL_OPEN) ||
            clean.includes(SENTINEL_CLOSE) ||
            hasInternalAnnotation(clean);
        return { clean, removed, leaked };
    }
    extractBlock(raw, tag) {
        const prefix = SENTINEL_OPEN + tag;
        let cursor = 0;
        for (let start; (start = raw.indexOf(prefix, cursor)) !== -1;) {
            cursor = start + prefix.length;
            if (cursor === raw.length || !/\s/u.test(raw[cursor]))
                continue;
            while (cursor < raw.length && /\s/u.test(raw[cursor]))
                cursor++;
            const close = raw.indexOf(SENTINEL_CLOSE, cursor);
            if (close === -1)
                return null;
            return { tag, body: raw.slice(cursor, close) };
        }
        return null;
    }
    extractAllBlocks(raw) {
        return Array.from(sentinelBlocks(raw), ({ tag, body }) => ({ tag, body }));
    }
}
