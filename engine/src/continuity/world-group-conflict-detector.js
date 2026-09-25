/**
 * World-group conflict detector — when this Work is part of a WorldGroup
 * (foundation.worldGroup set), the shared worldFacts are canonical
 * invariants the chapter prose must respect. A simple lexical
 * "contradicts" check: shared fact phrases that appear with a leading
 * negation marker (`아니다`, `없다`, `존재하지 않`) in prose → SOFT FLAG
 * `WORLD_GROUP_CONFLICT`.
 *
 * 결정적 휴리스틱 — 의미론 충돌 검출은 layer-2 LLM 의 일이고, 여기는
 * 누락 / 명백한 부정만 잡는다. Phase 12+ 외전 epic 의 entry-floor.
 */
import { skipKoLexical } from './checker-registry.js';
const NEGATION_MARKERS = [
    '아니다', '아니었다', '없다', '없었다', '존재하지 않', '아닌',
    '거짓이다', '거짓이었다', '틀렸다', '틀리다', '없는', '아닌',
];
const PHRASE_MIN_LENGTH = 4;
const PHRASE_MAX_TOKENS = 4;
const KO_STOPWORDS = new Set([
    '이', '그', '저', '것', '수', '등', '및', '의', '를', '을', '에', '에서',
    '와', '과', '도', '는', '은', '이다', '있다', '되다', '하다', '한', '한다',
    '그리고', '하지만', '그러나', '또한', '또', '뿐', '만', '까지', '부터',
]);
const KO_PARTICLES = /(은|는|이|가|을|를|에|에서|와|과|로|으로|도|만|부터|까지|의|에게|께|한테|이여|이라|이라고)$/;
export function scanWorldGroupConflict(input) {
    if (input.language != null || input.workContract != null || input.promptFamily != null) {
        if (!input.foundation?.worldGroup) {
            return {
                violations: [],
                status: 'skipped',
                skipReason: 'no_world_group',
                invariantCoverage: 'not_applicable',
                requiresSemantic: false,
            };
        }
    }
    const skipped = skipKoLexical(input, 'scanWorldGroupConflict');
    if (skipped)
        return skipped;
    const { prose, chapterNumber, foundation } = input;
    if (!prose || prose.length === 0)
        return { violations: [] };
    if (!foundation.worldGroup)
        return { violations: [] };
    const { sharedWorldFacts, name } = foundation.worldGroup;
    if (sharedWorldFacts.length === 0)
        return { violations: [] };
    const phrases = extractPhrases(sharedWorldFacts.map((f) => f.statement));
    if (phrases.size === 0)
        return { violations: [] };
    const violations = [];
    const seen = new Set();
    for (const phrase of phrases) {
        let idx = 0;
        while ((idx = prose.indexOf(phrase, idx)) !== -1) {
            const window = prose.slice(idx, idx + phrase.length + 25);
            const negated = NEGATION_MARKERS.some((m) => window.includes(m));
            if (negated) {
                const key = phrase;
                if (seen.has(key)) {
                    idx += phrase.length;
                    continue;
                }
                seen.add(key);
                violations.push({
                    severity: 'soft',
                    code: 'WORLD_GROUP_CONFLICT',
                    chapterNumber,
                    message: `WorldGroup '${name}' 공유 fact '${phrase}' 가 본문에서 부정·부재 표현과 결합 — 검수 필요`,
                });
                break;
            }
            idx += phrase.length;
        }
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
