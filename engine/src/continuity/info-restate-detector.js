/**
 * Info-restate detector — flags excessive restatement of world facts in a
 * single chapter. Pulls salient noun phrases from
 * `Foundation.worldFacts[].statement` and counts their occurrences in the
 * chapter prose; ≥ RESTATE_THRESHOLD per phrase → SOFT FLAG
 * `INFO_RESTATED`.
 *
 * Pure lexical, deterministic. Korean particles trimmed off candidate
 * phrase tails so the same noun matches "왕국은" / "왕국이" / "왕국에" alike.
 *
 * Phrase extraction is rough (no morphological parser): chooses
 * whitespace-tokenised n-grams of length 2-4 ≥ 4 chars total. Skips tokens
 * with only common stop-words to keep noise down.
 */
const RESTATE_THRESHOLD = 3;
const PHRASE_MIN_LENGTH = 4;
const PHRASE_MAX_TOKENS = 4;
const KO_STOPWORDS = new Set([
    '이', '그', '저', '것', '수', '등', '및', '의', '를', '을', '에', '에서',
    '와', '과', '도', '는', '은', '이다', '있다', '되다', '하다', '한', '한다',
    '그리고', '하지만', '그러나', '또한', '또', '뿐', '만', '까지', '부터',
]);
const KO_PARTICLES = /(은|는|이|가|을|를|에|에서|와|과|로|으로|도|만|부터|까지|의|에게|께|한테|이여|이라|이라고)$/;
export function scanInfoRestate(input) {
    const { prose, chapterNumber, foundation } = input;
    if (!prose || prose.length === 0)
        return { violations: [] };
    if (foundation.worldFacts.length === 0)
        return { violations: [] };
    const phrases = extractPhrases(foundation.worldFacts.map((f) => f.statement));
    if (phrases.size === 0)
        return { violations: [] };
    const violations = [];
    const seen = new Set();
    for (const phrase of phrases) {
        const count = countOccurrences(prose, phrase);
        if (count < RESTATE_THRESHOLD)
            continue;
        if (seen.has(phrase))
            continue;
        seen.add(phrase);
        violations.push({
            severity: 'soft',
            code: 'INFO_RESTATED',
            chapterNumber,
            message: `worldFact noun phrase '${phrase}' 반복 ${count}회 (≥ ${RESTATE_THRESHOLD})`,
        });
    }
    return { violations };
}
function extractPhrases(statements) {
    const out = new Set();
    for (const statement of statements) {
        if (!statement)
            continue;
        const tokens = statement
            .split(/[\s,.!?;:()\[\]{}「」『』"'"'"]+/)
            .map((t) => t.replace(KO_PARTICLES, ''))
            .filter((t) => t.length > 0 && !KO_STOPWORDS.has(t));
        for (let n = 1; n <= PHRASE_MAX_TOKENS && n <= tokens.length; n++) {
            for (let i = 0; i + n <= tokens.length; i++) {
                const slice = tokens.slice(i, i + n).join(' ');
                if (slice.length < PHRASE_MIN_LENGTH)
                    continue;
                out.add(slice);
            }
        }
    }
    return out;
}
function countOccurrences(prose, term) {
    if (!term)
        return 0;
    let count = 0;
    let idx = 0;
    while ((idx = prose.indexOf(term, idx)) !== -1) {
        count++;
        idx += term.length;
    }
    return count;
}
