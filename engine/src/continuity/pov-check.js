/**
 * POV-check (N3) — deterministic narrative-voice POV-leak detector.
 *
 * HARD FAIL `POV_VIOLATION` when, in a first-person / limited-third scene,
 * the narrative voice (text outside dialogue quotes) asserts another
 * character's interior state as fact:
 *   - "<other-name><particle?> <emotion-verb>" — e.g. "라이덴은 슬펐다"
 *   - "<other-name>(는|은|이|가)? 속으로 …" / "마음속" / "생각했다" — interior tells
 *
 * Skips when narratorId is null (omniscient/multi-pov, or cannot resolve).
 * Skips dialogue (within quote pairs) — characters can speculate aloud
 * about other characters' feelings; that's not a POV violation, only an
 * authored narrator claim is.
 *
 * Policy-aware (optional `language`): multilingual skips the KO lexical
 * detector. Only explicit unrestricted/no-POV waives the invariant.
 * omniscient/multi-pov still require semantic POV. A missing narrator on a
 * required POV contract stays unvalidated. Legacy callers that omit language
 * keep the previous empty-violations return.
 */
import { UNRESTRICTED_POV_MODES, isPolicyAwareInput, skipKoLexical } from './checker-registry.js';
const QUOTE_PAIRS = [
    ['"', '"'],
    ['“', '”'],
    ["'", "'"],
    ['‘', '’'],
    ['「', '」'],
    ['『', '』'],
];
// Korean particles that follow a character name as grammatical subject/topic.
const NAME_TAIL_PARTICLES = '(?:는|은|이|가|도|만|께서|께서는)?';
// Interior-tell markers — narrator asserting another character's inner thought.
const INTERIOR_MARKERS = ['속으로', '마음속', '내심', '머릿속으로'];
const THOUGHT_VERBS = ['생각했다', '느꼈다', '깨달았다', '여겼다', '믿었다'];
function explicitPovMode(input) {
    const mode = input.povMode ?? input.foundation?.povMode;
    return typeof mode === 'string' ? mode.trim() : null;
}

export function checkPov(input) {
    const { prose, chapterNumber, foundation, narratorId, emotionLexicon } = input;
    const skipped = skipKoLexical(input, 'checkPov');
    if (skipped) {
        const mode = explicitPovMode(input);
        if (mode && UNRESTRICTED_POV_MODES.has(mode)) {
            return {
                ...skipped,
                checkerId: 'checkPov',
                skipReason: 'explicit_no_pov_contract',
                invariantCoverage: 'not_applicable',
                requiresSemantic: false,
                applicability: 'not_applicable',
            };
        }
        return skipped;
    }
    if (isPolicyAwareInput(input)) {
        const mode = explicitPovMode(input);
        if (mode && UNRESTRICTED_POV_MODES.has(mode)) {
            return {
                checkerId: 'checkPov',
                violations: [],
                status: 'skipped',
                skipReason: 'explicit_no_pov_contract',
                invariantCoverage: 'not_applicable',
                requiresSemantic: false,
                applicability: 'not_applicable',
            };
        }
        if (!narratorId) {
            return {
                checkerId: 'checkPov',
                violations: [],
                status: 'skipped',
                skipReason: 'unresolved_narrator',
                invariantCoverage: 'unvalidated',
                requiresSemantic: true,
                applicability: 'run',
            };
        }
    }
    else if (!narratorId)
        return { violations: [] };
    if (!prose || prose.length === 0) {
        if (isPolicyAwareInput(input))
            return { checkerId: 'checkPov', violations: [], status: 'passed', exhaustive: false, requiresSemantic: true };
        return { violations: [] };
    }
    const narrator = foundation.characters.find((c) => c.id === narratorId);
    if (!narrator) {
        if (isPolicyAwareInput(input)) {
            return {
                checkerId: 'checkPov',
                violations: [],
                status: 'skipped',
                skipReason: 'unresolved_narrator',
                invariantCoverage: 'unvalidated',
                requiresSemantic: true,
                applicability: 'run',
            };
        }
        return { violations: [] };
    }
    // Build name → characterId map for all non-narrator characters.
    const otherNames = new Map();
    for (const c of foundation.characters) {
        if (c.id === narratorId)
            continue;
        otherNames.set(c.canonicalName, c.id);
        for (const alias of c.aliases)
            otherNames.set(alias, c.id);
    }
    if (otherNames.size === 0)
        return { violations: [] };
    // Narrator's own names — excluded from "other" matches.
    const narratorNames = new Set([narrator.canonicalName, ...narrator.aliases]);
    const narrative = stripDialogue(prose);
    const emotionVerbs = emotionLexicon.all().map((e) => e.verb);
    const seenSpans = new Set();
    const violations = [];
    for (const [name, otherId] of otherNames) {
        if (narratorNames.has(name))
            continue;
        if (!name || name.length === 0)
            continue;
        // Pattern A — `<name><particle?>\s*<emotion-verb>`
        for (const verb of emotionVerbs) {
            const re = new RegExp(`${escapeRegex(name)}${NAME_TAIL_PARTICLES}\\s*${escapeRegex(verb)}`, 'g');
            let m;
            while ((m = re.exec(narrative)) !== null) {
                const key = `${otherId}:${m.index}:emotion`;
                if (seenSpans.has(key))
                    continue;
                seenSpans.add(key);
                violations.push({
                    severity: 'hard',
                    code: 'POV_VIOLATION',
                    chapterNumber,
                    characterId: otherId,
                    message: `narrator(${narratorId})가 ${name}의 감정 '${verb}'를 서술 내면 진술로 출력 (POV 누설)`,
                });
            }
        }
        // Pattern B — `<name><particle?>\s*<interior-marker>` or thought verb proximity.
        for (const marker of [...INTERIOR_MARKERS, ...THOUGHT_VERBS]) {
            const re = new RegExp(`${escapeRegex(name)}${NAME_TAIL_PARTICLES}\\s*[^.!?。…\\n]{0,20}${escapeRegex(marker)}`, 'g');
            let m;
            while ((m = re.exec(narrative)) !== null) {
                const key = `${otherId}:${m.index}:interior`;
                if (seenSpans.has(key))
                    continue;
                seenSpans.add(key);
                violations.push({
                    severity: 'hard',
                    code: 'POV_VIOLATION',
                    chapterNumber,
                    characterId: otherId,
                    message: `narrator(${narratorId})가 ${name}의 내면(${marker})을 서술 진술로 출력 (POV 누설)`,
                });
            }
        }
    }
    if (isPolicyAwareInput(input)) {
        const failed = violations.length > 0;
        return {
            checkerId: 'checkPov',
            violations,
            status: failed ? 'failed' : 'passed',
            invariantCoverage: failed ? 'failed' : 'unvalidated',
            exhaustive: false,
            requiresSemantic: true,
        };
    }
    return { violations };
}

function isLetter(ch) {
    return typeof ch === 'string' && ch.length > 0 && /\p{L}/u.test(ch);
}

/** ASCII/curly apostrophes inside words (Don't, O'Brien, Ann's) are not quote delimiters. */
function isWordApostrophe(chars, i, mark) {
    if (mark !== "'" && mark !== '’')
        return false;
    const prev = i > 0 ? chars[i - 1] : '';
    const next = i + 1 < chars.length ? chars[i + 1] : '';
    if (isLetter(prev) && isLetter(next))
        return true;
    if (isLetter(prev) && (next === '' || /\s/.test(next) || /[.,!?;:”"]/.test(next)))
        return true;
    return false;
}

/**
 * Replace dialogue (text between quote pairs) with spaces so name + verb
 * matches don't span into spoken lines. Preserves char offsets.
 */
function stripDialogue(prose) {
    const chars = prose.split('');
    for (const [open, close] of QUOTE_PAIRS) {
        if (open === close) {
            let inside = false;
            for (let i = 0; i < chars.length; i++) {
                if (chars[i] === open) {
                    if (isWordApostrophe(chars, i, open))
                        continue;
                    if (inside) {
                        chars[i] = ' ';
                        inside = false;
                    }
                    else {
                        chars[i] = ' ';
                        inside = true;
                        continue;
                    }
                }
                else if (inside) {
                    chars[i] = ' ';
                }
            }
        }
        else {
            let depth = 0;
            for (let i = 0; i < chars.length; i++) {
                if (chars[i] === open) {
                    if (isWordApostrophe(chars, i, open))
                        continue;
                    depth++;
                    chars[i] = ' ';
                }
                else if (chars[i] === close && depth > 0) {
                    if (isWordApostrophe(chars, i, close))
                        continue;
                    depth--;
                    chars[i] = ' ';
                }
                else if (depth > 0) {
                    chars[i] = ' ';
                }
            }
        }
    }
    return chars.join('');
}
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
