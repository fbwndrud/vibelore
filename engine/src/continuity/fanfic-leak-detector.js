/**
 * Fanfic future-leak detector — when this Work is a fanfic
 * (foundation.fanficSource set), any canonical worldFact registered
 * after `branchAtChapter` is "future knowledge" the fanfic should not
 * know. Phrase-level scan over the future-facts surfaces this as
 * SOFT FLAG `FANFIC_FUTURE_LEAK`.
 *
 * Pure lexical, deterministic. Phrase extraction mirrors
 * info-restate-detector (n-gram from canonical statements, KO particles
 * stripped, stopword filter).
 */
const PHRASE_MIN_LENGTH = 4;
const PHRASE_MAX_TOKENS = 4;
const KO_STOPWORDS = new Set([
    '이', '그', '저', '것', '수', '등', '및', '의', '를', '을', '에', '에서',
    '와', '과', '도', '는', '은', '이다', '있다', '되다', '하다', '한', '한다',
    '그리고', '하지만', '그러나', '또한', '또', '뿐', '만', '까지', '부터',
]);
const KO_PARTICLES = /(은|는|이|가|을|를|에|에서|와|과|로|으로|도|만|부터|까지|의|에게|께|한테|이여|이라|이라고)$/;
export function scanFanficLeak(input) {
    const { prose, chapterNumber, foundation } = input;
    if (!prose || prose.length === 0)
        return { violations: [] };
    if (!foundation.fanficSource)
        return { violations: [] };
    const { branchAtChapter, canonicalWorldFacts } = foundation.fanficSource;
    const futureFacts = canonicalWorldFacts.filter((f) => f.registeredAtChapter > branchAtChapter);
    if (futureFacts.length === 0)
        return { violations: [] };
    const phrases = extractPhrases(futureFacts.map((f) => f.statement));
    if (phrases.size === 0)
        return { violations: [] };
    const violations = [];
    const seen = new Set();
    for (const phrase of phrases) {
        if (!prose.includes(phrase))
            continue;
        if (seen.has(phrase))
            continue;
        seen.add(phrase);
        violations.push({
            severity: 'soft',
            code: 'FANFIC_FUTURE_LEAK',
            chapterNumber,
            message: `외전이 canonical 미래 정보 누출 — '${phrase}' 는 분기점 chapter ${branchAtChapter} 이후 등록된 canonical worldFact`,
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
            .split(/[\s,.!?;:()\[\]{}「」『』"'""]+/)
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
