/**
 * Layer-2 continuity gate — LLM semantic layer.
 *
 * Two responsibilities:
 *   1. `extractDelta` — parse chapter prose + the writer's sentinel
 *      cast-manifest block (OutputSanitizer.extractBlock) into a structured
 *      `ChapterDelta`. The "who appeared in this chapter" question is
 *      manifest-parsed, not LLM-inferred — this closes the design's biggest
 *      open question on extraction reliability.
 *   2. `continuityCheck` — diff the delta against `StoryState(N-1) + Foundation`:
 *        * intrinsic / invariant violations → HARD FAIL
 *        * mutable changes without a narrative event → SOFT FLAG
 *        * unknown honorific terms → classify, append to HonorificLexicon
 *
 * Both functions use one LLM call apiece via ProviderRegistry so the layer
 * benefits from model upgrades automatically (Epic #23). Parsing is permissive —
 * a malformed LLM response degrades to empty ops rather than throwing, so a
 * single hallucinated delimiter cannot wedge a chapter.
 *
 * Phase 3 (multilingual) adds three things and changes nothing else:
 *   - Prompts come in exactly two families (ko / multilingual). The work
 *     language is resolved through `resolveStepPromptLanguage` **before** any
 *     provider call, so an explicit language that conflicts with the stored
 *     contract fails fast instead of producing a prompt in the wrong language.
 *   - ko-lexical deterministic scanners (`scanLexicon`, the Hangul proper-noun
 *     heuristic) do not run as proof on non-ko works; the result says so.
 *   - With a `checkerPlan` the same (single) continuityCheck call also asks for
 *     structured per-invariant semantic verdicts bound to a deterministic
 *     context hash (`result.semanticValidation`). Unusable answers stay
 *     unvalidated. There is no nested semantic-repair loop.
 */
import { createHash } from 'node:crypto';
import { computeLanguageContractHash } from '../core/language-policy.js';
import { languageSystemLines, pickByFamily, promptFamilyCaptureContext, resolveStepPromptLanguage, } from '../core/prompt-language.js';
import { scanLexicon, } from './lexicon-scan.js';
import { isHookActive, normalizeHook } from './story-state.js';
// ───────────────────────────── cast-manifest parsing ──────────────────────
/**
 * Parse the cast-manifest body emitted by the writer. The OutputSanitizer has
 * already extracted the block body, so the input is the JSON-shaped string
 * (no sentinel wrapping). Expected shape:
 *   `{ "cast": [{ "characterId": "c1", "addressTermsUsed": ["도련님"] }, ...] }`
 *
 * Defensive: returns `[]` on any structural deviation rather than throwing —
 * a malformed manifest is logged as a violation candidate via
 * `unregisteredNamed`, not a chapter-wedging exception.
 */
function parseCastManifest(raw) {
    if (!raw || raw.trim().length === 0)
        return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return [];
    }
    if (!parsed || typeof parsed !== 'object')
        return [];
    const cast = parsed.cast;
    if (!Array.isArray(cast))
        return [];
    const out = [];
    for (const entry of cast) {
        if (!entry || typeof entry !== 'object')
            continue;
        const e = entry;
        if (typeof e.characterId !== 'string' || e.characterId.length === 0)
            continue;
        const terms = [];
        if (Array.isArray(e.addressTermsUsed)) {
            for (const t of e.addressTermsUsed) {
                if (typeof t === 'string' && t.length > 0)
                    terms.push(t);
            }
        }
        out.push({ characterId: e.characterId, addressTermsUsed: terms });
    }
    return out;
}
// ───────────────────────────── unregistered named scan ────────────────────
/**
 * Heuristic Hangul proper-noun extraction. Matches 2–4 contiguous Hangul
 * syllables that appear in a dialogue-attribution-like context — either
 * immediately before/after an ASCII or fullwidth quote, or before a colon.
 * Conservative on purpose: false-positives surface to the caller as
 * `unregisteredNamed` (caller decides whether to `registerCharacter`), so
 * over-inclusion is tolerable while silent omission is not.
 */
function findUnregisteredNamed(prose, foundation) {
    if (!prose)
        return [];
    const known = new Set();
    for (const c of foundation.characters) {
        known.add(c.canonicalName);
        for (const alias of c.aliases)
            known.add(alias);
    }
    // Tokens of 2–4 hangul syllables in dialogue-adjacent context.
    // Dialogue-adjacent = ASCII quote, fullwidth quote, or colon within ~2 chars.
    const TOKEN_RE = /[가-힣]{2,4}/g;
    const candidates = new Set();
    for (;;) {
        const match = TOKEN_RE.exec(prose);
        if (!match)
            break;
        const name = match[0];
        if (known.has(name))
            continue;
        const start = match.index;
        const end = start + name.length;
        // ±6-char window for dialogue context.
        const before = prose.slice(Math.max(0, start - 6), start);
        const after = prose.slice(end, Math.min(prose.length, end + 6));
        const dialogueContext = /["'“”‘’「」『』]/.test(before) ||
            /["'“”‘’「」『』]/.test(after) ||
            /:/.test(after.slice(0, 2)) ||
            /이\s*["'“”]/.test(after) || // "라이덴이 말했다" → followed by 이 + space + quote
            /가\s*["'“”]/.test(after);
        if (!dialogueContext)
            continue;
        candidates.add(name);
    }
    return Array.from(candidates);
}
/**
 * ko-lexical detectors (`findUnregisteredNamed`, `scanLexicon`) read Korean
 * syllables and a Korean honorific lexicon. On a non-ko work they cannot
 * observe anything, and an empty finding from a detector that never applied is
 * not evidence. They are skipped and the skip is reported instead — coverage
 * aggregation belongs to the checker-registry owner, not to this module.
 */
const KO_LEXICAL_SKIP_REASON = 'ko_lexical_unsupported';
function scanMarker(checkerId, ran) {
    return Object.freeze({
        checkerId,
        status: ran ? 'ran' : 'skipped',
        skipReason: ran ? null : KO_LEXICAL_SKIP_REASON,
    });
}
// ───────────────────────────── LLM prompt + parse helpers ─────────────────
/** Strip optional ```json fences and trim — defensive against models that add formatting. */
function stripJsonFence(text) {
    let t = text.trim();
    if (t.startsWith('```')) {
        const firstNl = t.indexOf('\n');
        if (firstNl >= 0)
            t = t.slice(firstNl + 1);
        if (t.endsWith('```'))
            t = t.slice(0, -3);
    }
    return t.trim();
}
function tryParseJson(text) {
    try {
        return JSON.parse(stripJsonFence(text));
    }
    catch {
        return null;
    }
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
function asNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonicalChapterNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
/** system 줄 조립. 계약 없는 구형 호출은 지시문 줄이 없어 기존 문자열 그대로다. */
function systemContent(ctx, staticText) {
    // 연속성 판정 출력은 회차 본문이 아니다 — 분량 목표 줄은 싣지 않는다.
    return [staticText, ...languageSystemLines(ctx, { includeChapterLength: false })].join(' ');
}
// ───────────────────────────── semantic context hash ──────────────────────
/**
 * 의미 검증 응답이 **어떤 자료에 대한 답인지** 고정하는 hash 의 버전.
 * 직렬화 규칙이 바뀌면 올린다(이전 응답이 새 규칙의 hash 를 맞출 수 없게).
 * v2: `chapterNumber` 를 입력에서 직접 넣는다 — delta/prevState 가 비거나
 * 손상돼도 회차끼리 같은 hash 로 붕괴하지 않게.
 */
export const CONTINUITY_CONTEXT_HASH_VERSION = 2;
/** extractDelta 원천 바인딩 hash 의 버전. continuity hash 와 섞이지 않는다. */
export const EXTRACTION_CONTEXT_HASH_VERSION = 1;
/**
 * 키 정렬만 하는 정본 직렬화. **Unicode 정규화를 하지 않는다** — 정규화하면 서로
 * 다른 원고가 같은 hash 를 갖게 되고, 그 순간 "이전 응답이 바뀐 원고를 승인"한다.
 */
function canonicalValue(value) {
    if (value === null)
        return null;
    if (Array.isArray(value))
        return value.map((item) => canonicalValue(item));
    if (value instanceof Map)
        return Array.from(value.entries())
            .map(([k, v]) => [String(k), canonicalValue(v)])
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (value instanceof Set)
        return Array.from(value.values()).map((item) => canonicalValue(item));
    if (typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            const entry = canonicalValue(value[key]);
            if (entry !== undefined)
                out[key] = entry;
        }
        return out;
    }
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' || typeof value === 'boolean')
        return value;
    // function / symbol / undefined — hash 대상이 아니다.
    return undefined;
}
function sha256Hex(payload) {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
function continuityHashPayload(input, contract) {
    return {
        version: CONTINUITY_CONTEXT_HASH_VERSION,
        chapterNumber: canonicalChapterNumber(input.chapterNumber),
        prose: typeof input.prose === 'string' ? input.prose : '',
        foundation: canonicalValue(input.foundation ?? null),
        delta: canonicalValue(input.delta ?? null),
        prevState: canonicalValue(input.prevState ?? null),
        workContractHash: computeLanguageContractHash(contract),
    };
}
function extractionHashPayload(input, contract) {
    return {
        version: EXTRACTION_CONTEXT_HASH_VERSION,
        chapterNumber: canonicalChapterNumber(input.chapterNumber),
        prose: typeof input.prose === 'string' ? input.prose : '',
        foundation: canonicalValue(input.foundation ?? null),
        prevState: canonicalValue(input.prevState ?? null),
        castManifestRaw: typeof input.castManifestRaw === 'string' ? input.castManifestRaw : '',
        workContractHash: computeLanguageContractHash(contract),
    };
}
/**
 * `continuityCheck` 가 모델에게 되돌려 적게 하는 의미 컨텍스트 hash.
 *
 * 호출자(플러그인 검사 영수증)가 **같은 입력으로 다시 계산**해 응답이 그 원고에
 * 대한 답이 맞는지 확인할 수 있도록 공개한다. 회차 번호·원고·Foundation·Delta·
 * 이전 상태·언어 계약 중 하나라도 달라지면 hash 가 달라진다.
 *
 * @param {object} input `continuityCheck` 와 같은 입력 객체.
 * @returns {string} sha256 hex.
 */
export function computeContinuityContextHash(input = {}) {
    const ctx = resolveStepPromptLanguage(input);
    return sha256Hex(continuityHashPayload(input, ctx.contract));
}
/**
 * `extractDelta` 원천 바인딩 hash. 명시 계약 호출에서는 모델이 이 값을
 * `extractionValidation.contextHash` 로 되돌려 적어야 한다.
 *
 * @param {object} input `extractDelta` 와 같은 입력 객체.
 * @returns {string} sha256 hex.
 */
export function computeExtractionContextHash(input = {}) {
    const ctx = resolveStepPromptLanguage(input);
    return sha256Hex(extractionHashPayload(input, ctx.contract));
}
// ───────────────────────────── semantic invariants ────────────────────────
/** 이 모듈이 실제로 판정을 요청하고 검증할 수 있는 invariant ID(기계 값). */
export const SEMANTIC_INVARIANT_IDS = Object.freeze([
    'ADDRESSING', 'FORMAT', 'INTRINSIC', 'POV', 'REGISTRATION', 'SENSITIVE', 'WORLD',
]);
/**
 * 의미 블록이 아니라 별도 검증기가 소유하는 ID. 계획에 `requiresSemantic` 이
 * 있어도 여기서 묻거나 통과시키지 않는다.
 */
export const SEPARATE_VALIDATOR_IDS = Object.freeze(['LENGTH', 'OUTPUT_LANGUAGE', 'SCHEMA']);
/** 판정 enum(기계 값). `uncertain` 은 미검증이며 pass 로 승격되지 않는다. */
export const SEMANTIC_VERDICTS = Object.freeze(['pass', 'fail', 'uncertain']);
/** `semanticValidation.status` / `extractionValidation.status` enum. */
export const SEMANTIC_VALIDATION_STATUSES = Object.freeze(['completed', 'pending', 'error', 'invalid']);
function requiredSemanticRows(checkerPlan) {
    const rows = [];
    for (const raw of asArray(checkerPlan?.rows)) {
        const row = asRecord(raw);
        if (row.requiresSemantic !== true)
            continue;
        if (row.invariant !== 'required')
            continue;
        if (row.applicability === 'not_applicable')
            continue;
        const id = asString(row.invariantId);
        if (!id)
            continue;
        rows.push(id);
    }
    return rows;
}
/**
 * checkerPlan 이 **실제로** 이 모듈에 의미 판정을 요구하는 invariant ID 목록.
 * `SCHEMA`/`LENGTH`/`OUTPUT_LANGUAGE` 와 미지원 ID 는 여기 없다.
 */
export function requiredSemanticInvariantIds(checkerPlan) {
    const ids = new Set();
    for (const id of requiredSemanticRows(checkerPlan)) {
        if (SEMANTIC_INVARIANT_IDS.includes(id))
            ids.add(id);
    }
    return Array.from(ids).sort();
}
/**
 * 계획이 의미 판정을 요구하지만 이 모듈도 별도 검증기도 소유하지 않는 ID.
 * 조용히 빼지 않고 `semanticValidation.status = 'invalid'` 로 남긴다.
 */
export function unsupportedRequiredSemanticInvariantIds(checkerPlan) {
    const ids = new Set();
    for (const id of requiredSemanticRows(checkerPlan)) {
        if (SEMANTIC_INVARIANT_IDS.includes(id))
            continue;
        if (SEPARATE_VALIDATOR_IDS.includes(id))
            continue;
        ids.add(id);
    }
    return Array.from(ids).sort();
}
const INVARIANT_DESCRIPTIONS_KO = Object.freeze({
    ADDRESSING: '인물 사이의 호칭·경어 사용이 등록된 관계·지위와 맞는가',
    FORMAT: '승인된 대사·문단 형식(dialogueBreakMode)을 본문이 지키는가. 목표 언어의 인용 관습이 고립 검사와 다르면 그 관습을 기준으로 판정한다',
    INTRINSIC: '본문 묘사가 Foundation 의 캐릭터 intrinsic(성별·연령대·역할·핵심 외형)과 맞는가',
    POV: 'Foundation 요약의 povMode 로 선언된 시점·서술자가 회차 내내 유지되는가',
    REGISTRATION: '본문에서 행동·발화하는 named 인물이 모두 Foundation 에 올바른 ID 로 등록돼 있는가',
    SENSITIVE: '선언된 민감도 모드가 허용하지 않는 묘사가 본문에 있는가',
    WORLD: '본문이 확정된 세계 사실·집단 규칙과 충돌하지 않는가',
});
const INVARIANT_DESCRIPTIONS_EN = Object.freeze({
    ADDRESSING: 'do the address terms and politeness levels between characters match the registered relationships and status',
    FORMAT: 'does the chapter follow the approved dialogue and paragraph format (dialogueBreakMode); when the target language quote conventions are not the isolation checker, judge against those conventions',
    INTRINSIC: 'does the text agree with the Foundation character intrinsics (gender, age band, role, core appearance)',
    POV: 'is the point of view and narrator declared by povMode in the Foundation summary held throughout the chapter',
    REGISTRATION: 'is every named character who acts or speaks in the text registered in Foundation under the correct ID',
    SENSITIVE: 'does the text contain material the declared sensitivity mode does not allow',
    WORLD: 'does the text contradict established world facts or group rules',
});
// ───────────────────────────── extractDelta ───────────────────────────────
// Exported for ADR-0006 promptManifest collection. Keep value-only changes
// (rewording) version-bumped via ENGINE_VERSION.
export const EXTRACT_DELTA_SYSTEM = [
    '당신은 한국어 웹소설 연속성 분석기이다.',
    '제공된 회차 본문·이전 상태 요약·등장 캐스트 명단을 읽고, 구조화된 ChapterDelta JSON 한 개만 출력한다.',
    '본문 외 추론은 금지. 본문에서 직접 관찰되는 변화만 기록한다.',
    'characterId, speakerId, targetId에는 이번 회차 등장 캐스트에 제공된 정확한 ID만 사용한다. 이름·직책·역할명은 ID가 아니며 임의로 만들지 않는다.',
    '출력은 코드 블록 없이 순수 JSON. 한국어 키/값을 사용해도 무방하나 스키마 키는 영문 그대로 유지한다.',
    '들여쓰기와 줄바꿈 없는 한 줄 compact JSON으로 출력한다.',
].join(' ');
/**
 * 다국어 계열. 정적 지시는 영어지만 **설명 값**(anchor·interpretation·description
 * 등)은 목표 작품 언어로 쓰게 한다. 스키마 키·enum·ID 는 두 계열에서 같다.
 */
export const EXTRACT_DELTA_SYSTEM_MULTILINGUAL = [
    'You are a continuity analyser for serial fiction.',
    'Read the chapter text, the previous state summary and the cast list, and output exactly one structured ChapterDelta JSON object.',
    'Do not infer beyond the text. Record only changes that are directly observable in the chapter.',
    'For characterId, speakerId and targetId use only the exact IDs given in this chapter\'s cast. Names, titles and role words are not IDs and must never be invented.',
    'Output pure JSON with no code fence. Write natural-language values (descriptions, anchors, interpretations, reasons) in the target work language, and keep schema keys, enum values and IDs exactly as written here.',
    'Output the JSON as a single compact line with no indentation or line breaks.',
].join(' ');
const EXTRACT_LABELS_KO = Object.freeze({
    chapter: '## 회차 번호',
    prev: '## 이전 상태 요약 (StoryState N-1)',
    cast: '## 이번 회차 등장 캐스트 (writer manifest)',
    castNote: '- characterId 는 canonicalName/aliases 로 식별한다. addressTermsUsed 는 그 인물이 다른 인물을 부를 때 쓴 호칭이며, 그 인물이 불리는 호칭이 아니다.',
    prose: '## 본문',
    schema: '## 출력 스키마 (이 JSON 한 개만 출력)',
    bindHeading: '## 추출 검증 (extractionValidation)',
    bindEcho: '위 contextHash 를 extractionValidation.contextHash 에 글자 그대로 옮겨 적는다. 한 글자라도 다르면 추출은 확인된 것이 아니다.',
    hookText: '독자가 아직 답을 기다리는 약속',
    anchor: '본문에서 확인 가능한 짧은 근거',
    interpretation: '이 사건을 인물이 어떻게 받아들였는가',
    dimensionId: '작품별_dimension_id',
    nextChoiceBias: '다음 선택에 생긴 편향',
    hypothesis: '성격 가설',
    alternatives: ['선택A', '선택B'],
    chosen: '실제 선택',
    costPaid: '지불한 비용',
    belief: 'from이 to를 어떻게 보게 됐는가',
    noInfluenceReason: '인물의 선택·비용·인식·관계 변화가 정말 없을 때만 구체적으로 작성. influenceEvents 가 있으면 빈 문자열',
});
const EXTRACT_LABELS_EN = Object.freeze({
    chapter: '## Chapter number',
    prev: '## Previous state summary (StoryState N-1)',
    cast: '## Cast appearing in this chapter (writer manifest)',
    castNote: '- Identify each characterId by its canonicalName/aliases. addressTermsUsed are the terms that character uses toward others, not the terms that character is called.',
    prose: '## Chapter text',
    schema: '## Output schema (output this one JSON object only)',
    bindHeading: '## Extraction validation (extractionValidation)',
    bindEcho: 'Copy the contextHash above into extractionValidation.contextHash character for character. If a single character differs the extraction is not confirmed.',
    hookText: 'a promise the reader is still waiting on',
    anchor: 'short evidence observable in the chapter text',
    interpretation: 'how the character took this event',
    dimensionId: 'work_specific_dimension_id',
    nextChoiceBias: 'the bias this creates for the next choice',
    hypothesis: 'personality hypothesis',
    alternatives: ['option A', 'option B'],
    chosen: 'the choice actually made',
    costPaid: 'the cost paid',
    belief: 'how "from" now sees "to"',
    noInfluenceReason: 'fill in specifically only when there truly is no choice, cost, perception or relationship change; an empty string when influenceEvents is non-empty',
});
function extractDeltaSchemaLines(labels, bindHash) {
    const lines = [
        '{',
        '  "newAddressEntries": [{ "speakerId": "...", "targetId": "...", "term": "...", "register": "formal|intimate|subordinate|..." }],',
        '  "relationshipOps": [{ "to": "...", "kind": "...", "state": "..." }],',
        `  "hookChanges": [{ "id": "...", "text": "${labels.hookText}", "plantedAtChapter": 0, "phase": "planted|advancing|paid|parked", "horizon": "next|soon|arc|long|finale", "lastMovedChapter": 0 }],`,
        '  "mutableChanges": [{ "characterId": "...", "location": "...", "status": "...", "knownFactsAdded": ["..."] }],',
        `  "influenceEvents": [{ "characterId": "...", "anchor": "${labels.anchor}", "interpretation": "${labels.interpretation}", "dimensionChanges": { "${labels.dimensionId}": -1 }, "nextChoiceBias": "${labels.nextChoiceBias}", "behavioralProof": { "hypothesis": "${labels.hypothesis}", "voluntary": true, "alternativesKnown": true, "alternativesAvailable": ["${labels.alternatives[0]}", "${labels.alternatives[1]}"], "chosen": "${labels.chosen}", "costPaid": "${labels.costPaid}", "competingHypotheses": [] }, "relationshipClaims": [{ "from": "...", "to": "...", "dimensions": { "trust": 1 }, "belief": "${labels.belief}" }] }],`,
        `  "noInfluenceReason": "${labels.noInfluenceReason}",`,
        bindHash
            ? '  "trackedEntityOps": [{ "kind": "Timeline|RelationshipState|PowerSystem|Artifact|Clue|KnowledgeMatrix", "data": {} }],'
            : '  "trackedEntityOps": [{ "kind": "Timeline|RelationshipState|PowerSystem|Artifact|Clue|KnowledgeMatrix", "data": {} }]',
    ];
    if (bindHash)
        lines.push('  "extractionValidation": { "contextHash": "copy the contextHash above exactly" }');
    lines.push('}');
    return lines;
}
function buildExtractDeltaUserPrompt(input, manifest, ctx, bindHash) {
    const { prose, chapterNumber, prevState } = input;
    const labels = pickByFamily(ctx, { ko: EXTRACT_LABELS_KO, multilingual: EXTRACT_LABELS_EN });
    const prevSummary = {
        chapterNumber: prevState.chapterNumber,
        addressMapKeys: Object.keys(prevState.addressMap.entries),
        activeHookIds: (prevState.hooks ?? []).filter(isHookActive).map((h) => h.id ?? h.hookId),
    };
    // 추출기가 ID 와 본문 인물을 잇는 유일한 단서는 이 명단이다. 이름 없이 ID 와 호칭만
    // 주면 c1/c2 가 뒤바뀐 Delta 가 나온다(2026-09-15 ko·zh-Hant·es 표본, REGISTRATION fail).
    const knownCharacters = new Map((input.foundation?.characters ?? []).map((c) => [c.id, c]));
    const castSummary = manifest.map((c) => {
        const known = knownCharacters.get(c.characterId);
        return {
            characterId: c.characterId,
            ...(known ? { canonicalName: known.canonicalName, aliases: known.aliases ?? [] } : {}),
            addressTermsUsed: c.addressTermsUsed,
        };
    });
    return [
        labels.chapter,
        String(chapterNumber),
        ``,
        labels.prev,
        JSON.stringify(prevSummary),
        ``,
        labels.cast,
        JSON.stringify(castSummary),
        labels.castNote,
        ``,
        labels.prose,
        prose,
        ``,
        ...(bindHash ? [
            labels.bindHeading,
            `contextHash: ${bindHash}`,
            `- ${labels.bindEcho}`,
            ``,
        ] : []),
        labels.schema,
        ...extractDeltaSchemaLines(labels, Boolean(bindHash)),
    ].join('\n');
}
/**
 * influence 관찰 재요청. 이 지시는 "비어 있으니 아무거나 채우라"가 아니라
 * "본문에 있으면 채우고, 정말 없으면 이유를 구체적으로 쓰라"이다 — 두 계열 모두.
 */
const EXTRACT_REPAIR_KO = '이전 응답에는 influenceEvents와 noInfluenceReason이 모두 비어 있어 커밋할 수 없다. 본문에 선택·비용·인식·관계 변화가 있으면 influenceEvents를 스키마대로 채우고, 정말 없을 때만 구체적인 noInfluenceReason을 채워 전체 ChapterDelta JSON을 다시 출력하라.';
const EXTRACT_REPAIR_EN = 'The previous response left both influenceEvents and noInfluenceReason empty, so it cannot be committed. If the chapter contains a choice, a cost, a change of perception or a change of relationship, fill influenceEvents according to the schema; only if there truly is none, write a specific noInfluenceReason in the target work language. Output the whole ChapterDelta JSON again.';
const EXTRACT_REPAIR_PREVIOUS_KO = '이전 응답:';
const EXTRACT_REPAIR_PREVIOUS_EN = 'Previous response:';
const EXTRACT_ARRAY_KEYS = Object.freeze([
    'newAddressEntries', 'relationshipOps', 'hookChanges', 'mutableChanges', 'influenceEvents', 'trackedEntityOps',
]);
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function isFiniteNumberRecord(value) {
    if (!isRecord(value))
        return false;
    for (const entry of Object.values(value)) {
        if (!isFiniteNumber(entry))
            return false;
    }
    return true;
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}
/** 구형 호출: 키가 있으면 타입만 본다. 빠진 배열은 빈 연산으로 채운다. */
function isLegacyWellFormedExtraction(parsed) {
    if (!isRecord(parsed))
        return false;
    for (const key of EXTRACT_ARRAY_KEYS) {
        if (key in parsed && !Array.isArray(parsed[key]))
            return false;
    }
    if ('noInfluenceReason' in parsed
        && parsed.noInfluenceReason !== null
        && parsed.noInfluenceReason !== undefined
        && typeof parsed.noInfluenceReason !== 'string')
        return false;
    if ('extractionValidation' in parsed && !isRecord(parsed.extractionValidation))
        return false;
    return true;
}
function resolvableId(resolveId, value) {
    return isNonEmptyString(value) && resolveId(value) !== null;
}
function isCompleteAddressEntry(raw, resolveId) {
    if (!isRecord(raw))
        return false;
    return resolvableId(resolveId, raw.speakerId)
        && resolvableId(resolveId, raw.targetId)
        && isNonEmptyString(raw.term)
        && isNonEmptyString(raw.register);
}
function isCompleteRelationshipOp(raw) {
    if (!isRecord(raw))
        return false;
    return isNonEmptyString(raw.to) && isNonEmptyString(raw.kind) && isNonEmptyString(raw.state);
}
function isCompleteHookChange(raw) {
    if (!isRecord(raw))
        return false;
    if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.text) || !isNonEmptyString(raw.phase))
        return false;
    if ('plantedAtChapter' in raw && !isFiniteNumber(raw.plantedAtChapter))
        return false;
    if ('lastMovedChapter' in raw && !isFiniteNumber(raw.lastMovedChapter))
        return false;
    if ('horizon' in raw && typeof raw.horizon !== 'string')
        return false;
    return true;
}
function isCompleteMutableChange(raw, resolveId) {
    if (!isRecord(raw))
        return false;
    if (!resolvableId(resolveId, raw.characterId))
        return false;
    if ('location' in raw && typeof raw.location !== 'string')
        return false;
    if ('status' in raw && typeof raw.status !== 'string')
        return false;
    if ('knownFactsAdded' in raw && !isStringArray(raw.knownFactsAdded))
        return false;
    return true;
}
function isCompleteTrackedEntityOp(raw) {
    if (!isRecord(raw))
        return false;
    if (!isNonEmptyString(raw.kind))
        return false;
    if ('data' in raw && !isRecord(raw.data))
        return false;
    return true;
}
function isCompleteRelationshipClaim(raw, resolveId) {
    if (!isRecord(raw))
        return false;
    if (!resolvableId(resolveId, raw.from) || !resolvableId(resolveId, raw.to))
        return false;
    if ('dimensions' in raw && !isFiniteNumberRecord(raw.dimensions))
        return false;
    if ('belief' in raw && typeof raw.belief !== 'string')
        return false;
    return true;
}
function isCompleteInfluenceEvent(raw, resolveId) {
    if (!isRecord(raw))
        return false;
    if (!resolvableId(resolveId, raw.characterId) || !isNonEmptyString(raw.anchor))
        return false;
    if ('interpretation' in raw && typeof raw.interpretation !== 'string')
        return false;
    if ('nextChoiceBias' in raw && typeof raw.nextChoiceBias !== 'string')
        return false;
    if ('dimensionChanges' in raw && !isFiniteNumberRecord(raw.dimensionChanges))
        return false;
    if ('relationshipClaims' in raw) {
        if (!Array.isArray(raw.relationshipClaims))
            return false;
        if (!raw.relationshipClaims.every((claim) => isCompleteRelationshipClaim(claim, resolveId)))
            return false;
    }
    if ('behavioralProof' in raw && raw.behavioralProof !== null && !isRecord(raw.behavioralProof))
        return false;
    return true;
}
const NEW_CONTRACT_ENTRY_VALIDATORS = Object.freeze({
    newAddressEntries: isCompleteAddressEntry,
    relationshipOps: (raw) => isCompleteRelationshipOp(raw),
    hookChanges: (raw) => isCompleteHookChange(raw),
    mutableChanges: isCompleteMutableChange,
    influenceEvents: isCompleteInfluenceEvent,
    trackedEntityOps: (raw) => isCompleteTrackedEntityOp(raw),
});
/**
 * 신규 계약 추출의 원본 JSON. 관대한 parser 가 null/부분 레코드를 버리기 전에
 * 약속된 키와 항목 형태가 모두 있는지 본다. 빈 배열은 확인된 무변경이다.
 */
function isNewContractDeltaComplete(parsed, resolveId) {
    if (!isRecord(parsed))
        return false;
    // noInfluenceReason is the substitute for an empty influenceEvents: when the
    // model recorded events it may leave the key out or null, but when it
    // recorded none the reason must be present as a string.
    const reason = parsed.noInfluenceReason;
    if (reason !== undefined && reason !== null && typeof reason !== 'string')
        return false;
    if (typeof reason !== 'string' && !(Array.isArray(parsed.influenceEvents) && parsed.influenceEvents.length > 0))
        return false;
    for (const key of EXTRACT_ARRAY_KEYS) {
        const rows = parsed[key];
        if (!Array.isArray(rows))
            return false;
        const valid = NEW_CONTRACT_ENTRY_VALIDATORS[key];
        for (const row of rows) {
            if (!valid(row, resolveId))
                return false;
        }
    }
    return true;
}
function validateExtractionPayload(parsed, { explicit, contextHash, resolveId }) {
    if (!explicit) {
        if (!isLegacyWellFormedExtraction(parsed))
            return { ok: false, code: 'malformed' };
        return { ok: true };
    }
    if (!isRecord(parsed))
        return { ok: false, code: 'malformed' };
    const block = parsed.extractionValidation;
    if (!isRecord(block))
        return { ok: false, code: 'missing_block' };
    if (asString(block.contextHash) !== contextHash)
        return { ok: false, code: 'hash_mismatch' };
    if (!isNewContractDeltaComplete(parsed, resolveId))
        return { ok: false, code: 'malformed' };
    return { ok: true };
}
function extractionValidationResult(status, contextHash, code) {
    const result = { status, contextHash };
    if (status !== 'completed' && code)
        result.diagnostics = Object.freeze({ code });
    return Object.freeze(result);
}
function parseChapterDeltaPayload(parsed, chapterNumber, appearedCharacterIds) {
    const obj = asRecord(parsed);
    const newAddressEntries = [];
    for (const raw of asArray(obj.newAddressEntries)) {
        const e = asRecord(raw);
        const speakerId = asString(e.speakerId);
        const targetId = asString(e.targetId);
        const term = asString(e.term);
        const register = asString(e.register);
        if (!speakerId || !targetId || !term || !register)
            continue;
        newAddressEntries.push({ speakerId, targetId, term, register });
    }
    const relationshipOps = [];
    for (const raw of asArray(obj.relationshipOps)) {
        const e = asRecord(raw);
        const to = asString(e.to);
        const kind = asString(e.kind);
        const state = asString(e.state);
        if (!to || !kind || !state)
            continue;
        relationshipOps.push({ to, kind, state });
    }
    const hookChanges = [];
    for (const raw of asArray(obj.hookChanges ?? obj.hookOps)) {
        const e = asRecord(raw);
        const hook = normalizeHook({
            ...e,
            plantedAtChapter: asNumber(e.plantedAtChapter ?? e.startChapter) ?? chapterNumber,
            lastMovedChapter: asNumber(e.lastMovedChapter ?? e.lastAdvancedChapter) ?? chapterNumber,
        });
        if (!hook || !hook.text)
            continue;
        hookChanges.push(hook);
    }
    const mutableChanges = [];
    for (const raw of asArray(obj.mutableChanges)) {
        const e = asRecord(raw);
        const characterId = asString(e.characterId);
        if (!characterId)
            continue;
        const entry = { characterId };
        const location = asString(e.location);
        if (location)
            entry.location = location;
        const status = asString(e.status);
        if (status)
            entry.status = status;
        if (Array.isArray(e.knownFactsAdded)) {
            const facts = [];
            for (const f of e.knownFactsAdded) {
                if (typeof f === 'string' && f.length > 0)
                    facts.push(f);
            }
            if (facts.length > 0)
                entry.knownFactsAdded = facts;
        }
        mutableChanges.push(entry);
    }
    const trackedEntityOps = [];
    for (const raw of asArray(obj.trackedEntityOps)) {
        const e = asRecord(raw);
        const kind = asString(e.kind);
        if (!kind)
            continue;
        const data = asRecord(e.data);
        trackedEntityOps.push({ kind, data });
    }
    const influenceEvents = [];
    for (const raw of asArray(obj.influenceEvents)) {
        const e = asRecord(raw);
        const characterId = asString(e.characterId);
        const anchor = asString(e.anchor);
        if (!characterId || !anchor)
            continue;
        const dimensionChanges = {};
        for (const [key, value] of Object.entries(asRecord(e.dimensionChanges))) {
            if (typeof value === 'number' && Number.isFinite(value))
                dimensionChanges[key] = value;
        }
        const relationshipClaims = [];
        for (const rawClaim of asArray(e.relationshipClaims)) {
            const claim = asRecord(rawClaim);
            const from = asString(claim.from);
            const to = asString(claim.to);
            if (!from || !to)
                continue;
            relationshipClaims.push({ from, to, dimensions: asRecord(claim.dimensions), belief: asString(claim.belief) ?? '' });
        }
        influenceEvents.push({ characterId, anchor, interpretation: asString(e.interpretation) ?? '', dimensionChanges, nextChoiceBias: asString(e.nextChoiceBias) ?? '', behavioralProof: e.behavioralProof && typeof e.behavioralProof === 'object' ? e.behavioralProof : null, relationshipClaims });
    }
    return {
        chapterNumber,
        appearedCharacterIds,
        newAddressEntries,
        relationshipOps,
        hookChanges,
        mutableChanges,
        influenceEvents,
        noInfluenceReason: asString(obj.noInfluenceReason) ?? '',
        trackedEntityOps,
    };
}
function characterIdResolver(foundation) {
    const idByReference = new Map();
    for (const character of foundation.characters) {
        idByReference.set(character.id, character.id);
        idByReference.set(character.canonicalName, character.id);
        for (const alias of character.aliases ?? [])
            idByReference.set(alias, character.id);
    }
    return (value) => idByReference.get(value) ?? null;
}
function resolveCharacterIds(delta, resolveId) {
    delta.mutableChanges = delta.mutableChanges.flatMap((change) => {
        const characterId = resolveId(change.characterId);
        return characterId ? [{ ...change, characterId }] : [];
    });
    delta.newAddressEntries = delta.newAddressEntries.flatMap((entry) => {
        const speakerId = resolveId(entry.speakerId);
        const targetId = resolveId(entry.targetId);
        return speakerId && targetId ? [{ ...entry, speakerId, targetId }] : [];
    });
    delta.influenceEvents = delta.influenceEvents.flatMap((event) => {
        const characterId = resolveId(event.characterId);
        if (!characterId)
            return [];
        const relationshipClaims = event.relationshipClaims.flatMap((claim) => {
            const from = resolveId(claim.from);
            const to = resolveId(claim.to);
            return from && to ? [{ ...claim, from, to }] : [];
        });
        return [{ ...event, characterId, relationshipClaims }];
    });
    return delta;
}
export async function extractDelta(input) {
    // 언어 해석이 먼저다 — 저장된 계약과 어긋나는 명시 인자는 provider 호출 전에
    // 예외로 끝난다(잘못된 언어로 회차를 분석하고 나서 발견하지 않는다).
    const ctx = resolveStepPromptLanguage(input);
    const system = systemContent(ctx, pickByFamily(ctx, {
        ko: EXTRACT_DELTA_SYSTEM,
        multilingual: EXTRACT_DELTA_SYSTEM_MULTILINGUAL,
    }));
    const manifest = parseCastManifest(input.castManifestRaw);
    const unregisteredNamed = ctx.isKo ? findUnregisteredNamed(input.prose, input.foundation) : [];
    const unregisteredNamedScan = scanMarker('findUnregisteredNamed', ctx.isKo);
    const contextHash = sha256Hex(extractionHashPayload(input, ctx.contract));
    const requireHash = ctx.explicit === true;
    const bindHash = requireHash ? contextHash : null;
    const userPrompt = buildExtractDeltaUserPrompt(input, manifest, ctx, bindHash);
    let llmText = '';
    let sawResponse = false;
    let sawThrow = false;
    try {
        const response = await input.providers.complete({
            model: input.model,
            jsonMode: true,
            step: 'continuity-extract',
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: userPrompt },
            ],
        });
        llmText = response.text ?? '';
        sawResponse = true;
    }
    catch {
        // Provider failure → degrade to empty delta; caller observes via empty ops.
        llmText = '';
        sawThrow = true;
    }
    const appearedCharacterIds = manifest.map((c) => c.characterId);
    const resolveId = characterIdResolver(input.foundation);
    let parsed = llmText ? tryParseJson(llmText) : null;
    let delta = parseChapterDeltaPayload(parsed, input.chapterNumber, appearedCharacterIds);
    // Explicit contracts share the caller's persisted attempt budget: each
    // extraction failure must return after one request. Keep legacy repair only.
    // A relay that is still collecting the first extraction has no real delta
    // yet; a repair built on that placeholder would only waste a host answer.
    if (!requireHash && input.requireInfluenceObservation === true
        && (input.providers.pending?.length ?? 0) === 0
        && delta.influenceEvents.length === 0
        && !delta.noInfluenceReason) {
        const repair = pickByFamily(ctx, {
            ko: { instruction: EXTRACT_REPAIR_KO, previous: EXTRACT_REPAIR_PREVIOUS_KO },
            multilingual: { instruction: EXTRACT_REPAIR_EN, previous: EXTRACT_REPAIR_PREVIOUS_EN },
        });
        try {
            const response = await input.providers.complete({
                model: input.model,
                jsonMode: true,
                step: 'continuity-extract-repair',
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: `${userPrompt}\n\n${repair.instruction}\n\n${repair.previous}\n${llmText}` },
                ],
            });
            llmText = response.text ?? '';
            parsed = llmText ? tryParseJson(llmText) : null;
            delta = parseChapterDeltaPayload(parsed, input.chapterNumber, appearedCharacterIds);
            sawResponse = true;
            sawThrow = false;
        }
        catch {
            // The workflow observes a pending relay request or keeps the invalid
            // delta blocked; it must never invent an influence event.
            sawThrow = true;
        }
    }
    const validated = validateExtractionPayload(parsed, {
        explicit: requireHash, contextHash, resolveId,
    });
    resolveCharacterIds(delta, resolveId);
    let extraction;
    if (validated.ok)
        extraction = extractionValidationResult('completed', contextHash);
    else if (sawResponse)
        extraction = extractionValidationResult('invalid', contextHash, validated.code);
    else
        extraction = extractionValidationResult('error', contextHash, sawThrow ? 'provider_error' : 'malformed');
    return { delta, manifest, unregisteredNamed, unregisteredNamedScan, extractionValidation: extraction };
}
// Exported for ADR-0006 promptManifest collection.
export const CONTINUITY_CHECK_SYSTEM = [
    '당신은 한국어 웹소설 연속성 검수기이다.',
    '본문, 이전 상태 요약, Foundation 요약, 회차 Delta, 장르 invariant 목록을 받아',
    '본문과 구조화 데이터가 충돌하는 지점을 골라낸다. 출력은 순수 JSON 한 개.',
    '의심만으로 hard 위반을 만들지 말 것. Foundation·delta·prevState 와 본문이 명확히 모순되는 경우만 hard 로 분류.',
    '본문에 새로 등장한 호칭(존칭/대명사)이 있고 함의(성별/화자성별/지위)가 명확히 추론되면 lexiconAdditions 에 담는다.',
].join(' ');
/** 다국어 계열. `message`·`reason` 같은 설명 값만 목표 작품 언어로 쓴다. */
export const CONTINUITY_CHECK_SYSTEM_MULTILINGUAL = [
    'You are a continuity reviewer for serial fiction.',
    'You receive the chapter text, the previous state summary, a Foundation summary, this chapter\'s Delta and the genre invariant list,',
    'and you pick out the places where the text contradicts the structured data. Output one pure JSON object.',
    'Never raise a hard violation on suspicion alone. Classify as hard only where the text plainly contradicts Foundation, delta or prevState.',
    'When the text uses an address term (honorific or pronoun) that is not yet known and its implication (gender / speaker gender / status) is clearly inferable, put it in lexiconAdditions.',
    'Write every message and reason in the target work language; keep JSON keys, enum values, invariant IDs and character IDs exactly as given.',
].join(' ');
const CHECK_LABELS_KO = Object.freeze({
    chapter: '## 회차 번호',
    prev: '## 이전 상태 요약',
    foundation: '## Foundation 요약',
    delta: '## 이번 회차 Delta',
    invariants: '## 장르 invariant 목록',
    prose: '## 본문',
    taskHeading: '## 검수 작업',
    tasks: Object.freeze([
        '- intrinsic 위반: Foundation 의 캐릭터 intrinsic(성별/연령대/역할 등)과 본문 묘사가 충돌하는 사례',
        '- invariant 위반: 위 invariant 목록 중 본문/Delta 에서 깨진 항목 (invariantId 명시)',
        '- 정당화되지 않은 mutable 변경: location/status 변화가 본문에 명시되지 않는 경우',
        '- lexicon 추가: 본문에 등장한 호칭이 알려지지 않은 경우 함의 분류',
    ]),
    schemaHeading: '## 출력 스키마 (이 JSON 한 개만 출력)',
});
const CHECK_LABELS_EN = Object.freeze({
    chapter: '## Chapter number',
    prev: '## Previous state summary',
    foundation: '## Foundation summary',
    delta: '## Delta for this chapter',
    invariants: '## Genre invariant list',
    prose: '## Chapter text',
    taskHeading: '## Review tasks',
    tasks: Object.freeze([
        '- intrinsic violation: the text describes a character in a way that conflicts with the Foundation intrinsics (gender / age band / role and so on)',
        '- invariant violation: an entry of the invariant list above that the text or the Delta breaks (state the invariantId)',
        '- unjustified mutable change: a location/status change that the text does not show',
        '- lexicon addition: an address term used in the text that is not yet known, classified by its implication',
    ]),
    schemaHeading: '## Output schema (output this one JSON object only)',
});
const CHECK_SCHEMA_ENTRIES = Object.freeze([
    '  "intrinsicViolations": [{ "characterId": "...", "message": "..." }]',
    '  "invariantViolations": [{ "invariantId": "...", "message": "..." }]',
    '  "unjustifiedMutable": [{ "characterId": "...", "message": "..." }]',
    '  "lexiconAdditions": [{ "term": "...", "genderImplication": "male|female|null", "speakerGenderImplication": "male|female|null", "statusImplication": "..." }]',
]);
const SEMANTIC_SCHEMA_ENTRY_KO = [
    '  "semanticValidation": {',
    '    "contextHash": "위 contextHash 를 글자 그대로 옮겨 적는다",',
    '    "verdicts": { "INVARIANT_ID": "pass|fail|uncertain" },',
    '    "evidence": [{ "invariantId": "...", "fieldPath": "prose 또는 delta.<경로> 또는 foundation.<경로> 또는 prevState.<경로>", "quote": "fieldPath 가 가리키는 그 필드에서 글자 그대로 복사한 짧은 발췌", "reason": "작품 언어로 쓴 판정 근거" }]',
    '  }',
].join('\n');
const SEMANTIC_SCHEMA_ENTRY_EN = [
    '  "semanticValidation": {',
    '    "contextHash": "copy the contextHash above character for character",',
    '    "verdicts": { "INVARIANT_ID": "pass|fail|uncertain" },',
    '    "evidence": [{ "invariantId": "...", "fieldPath": "prose, or delta.<path>, or foundation.<path>, or prevState.<path>", "quote": "a short excerpt copied verbatim from the field fieldPath names", "reason": "why, written in the target work language" }]',
    '  }',
].join('\n');
function semanticSectionLines(ctx, contextHash, requiredIds) {
    const descriptions = pickByFamily(ctx, { ko: INVARIANT_DESCRIPTIONS_KO, multilingual: INVARIANT_DESCRIPTIONS_EN });
    const idLines = requiredIds.map((id) => {
        const extra = id === 'FORMAT' ? ` (dialogueBreakMode=${ctx.dialogueBreakMode})` : '';
        return `  - ${id}: ${descriptions[id]}${extra}`;
    });
    return pickByFamily(ctx, {
        ko: () => [
            '## 의미 검증 (semanticValidation)',
            `contextHash: ${contextHash}`,
            '- 위 contextHash 를 응답에 그대로 되돌려 적는다. 한 글자라도 다르면 응답 전체가 폐기된다.',
            `- 다음 invariant 를 하나도 빠짐없이 판정한다: ${requiredIds.join(', ')}. 목록에 없는 ID 는 넣지 않는다.`,
            ...idLines,
            '- 판정값은 pass / fail / uncertain 뿐이다. 위 자료만으로 확인할 수 없으면 pass 가 아니라 uncertain 이다.',
            '- "해당 없음"(N/A)이나 판정 생략은 허용되지 않는다.',
            '- fail 은 evidence 를 최소 하나 포함해야 한다. quote 는 fieldPath 가 가리키는 그 필드에 글자 그대로 있어야 하며, 다른 필드·요약·지어낸 문장은 폐기된다.',
            '- reason 은 작품 언어로 쓴 실제 설명이어야 한다. ID·판정값·필드 경로만 적은 reason 은 근거로 인정되지 않는다.',
        ],
        multilingual: () => [
            '## Semantic validation (semanticValidation)',
            `contextHash: ${contextHash}`,
            '- Echo the contextHash above back exactly. If a single character differs the whole response is discarded.',
            `- Give a verdict for every one of these invariants: ${requiredIds.join(', ')}. Do not add IDs that are not on the list.`,
            ...idLines,
            '- The only verdicts are pass / fail / uncertain. If the material above does not let you confirm it, answer uncertain, not pass.',
            '- "Not applicable" (N/A) and leaving a verdict out are not allowed.',
            '- Every fail needs at least one evidence entry. The quote must appear verbatim in the field named by fieldPath; a quote that only exists somewhere else in the prompt, a paraphrase, or an invented quote discards the response.',
            '- The reason must be a real explanation written in the target work language. A reason that only repeats an ID, a verdict or a field path is not evidence.',
        ],
    });
}
function buildContinuityCheckSections(input) {
    const { prevState, foundation, delta } = input;
    const prevSummary = {
        chapterNumber: prevState.chapterNumber,
        addressMapKeys: Object.keys(prevState.addressMap.entries),
        activeHookIds: (prevState.hooks ?? []).filter(isHookActive).map((h) => h.id ?? h.hookId),
    };
    // 선언 시점이 없으면 검수기는 POV 를 판정할 수 없어 uncertain 만 돌려준다
    // (2026-09-15 ko·zh-Hant·es 표본). 있을 때만 싣어 시점 없는 legacy 프롬프트는 그대로 둔다.
    const foundationSummary = {
        genre: foundation.genre,
        ...(typeof foundation.povMode === 'string' && foundation.povMode.trim() ? { povMode: foundation.povMode } : {}),
        characters: foundation.characters.map((c) => ({
            id: c.id,
            canonicalName: c.canonicalName,
            aliases: c.aliases,
            intrinsic: c.intrinsic,
            mutable: c.mutable,
        })),
        intrinsicChanges: foundation.intrinsicChanges,
        worldFacts: foundation.worldFacts,
    };
    return Object.freeze({
        prevSummary: JSON.stringify(prevSummary),
        foundationSummary: JSON.stringify(foundationSummary),
        delta: JSON.stringify(delta),
        invariants: JSON.stringify(foundation.genreProfile.invariants),
        prose: typeof input.prose === 'string' ? input.prose : '',
    });
}
function buildContinuityCheckUserPrompt(input, ctx, sections, semantic) {
    const labels = pickByFamily(ctx, { ko: CHECK_LABELS_KO, multilingual: CHECK_LABELS_EN });
    const schemaEntries = [...CHECK_SCHEMA_ENTRIES];
    if (semantic)
        schemaEntries.push(pickByFamily(ctx, { ko: SEMANTIC_SCHEMA_ENTRY_KO, multilingual: SEMANTIC_SCHEMA_ENTRY_EN }));
    return [
        labels.chapter,
        String(input.chapterNumber),
        ``,
        labels.prev,
        sections.prevSummary,
        ``,
        labels.foundation,
        sections.foundationSummary,
        ``,
        labels.delta,
        sections.delta,
        ``,
        labels.invariants,
        sections.invariants,
        ``,
        labels.prose,
        sections.prose,
        ``,
        labels.taskHeading,
        ...labels.tasks,
        ``,
        ...(semantic ? [...semanticSectionLines(ctx, semantic.contextHash, semantic.requiredIds), ``] : []),
        labels.schemaHeading,
        '{',
        schemaEntries.join(',\n'),
        '}',
    ].join('\n');
}
/**
 * 모델이 message 를 비워 보냈을 때의 대체 문구. 계열 언어로 쓴다 — 임의의 목표
 * 언어로 번역해 낼 수는 없으므로 다국어 계열은 영어이며, 이것은 모델이 쓴 설명이
 * 아니라 엔진 문구다.
 */
const CHECK_FALLBACK_KO = Object.freeze({
    intrinsic: '본문이 Foundation intrinsic 과 충돌',
    invariant: (id) => `invariant 위반${id ? ` (${id})` : ''}`,
    mutable: 'mutable 변경에 서사적 근거 부족',
    unregistered: (id) => `Foundation 에 미등록된 캐릭터 "${id}" 의 knownFacts 변경 시도`,
});
const CHECK_FALLBACK_EN = Object.freeze({
    intrinsic: 'the chapter text contradicts a Foundation intrinsic',
    invariant: (id) => `invariant violation${id ? ` (${id})` : ''}`,
    mutable: 'the mutable change is not grounded in the chapter text',
    unregistered: (id) => `knownFacts change attempted for character "${id}" which is not registered in Foundation`,
});
function normaliseGender(value) {
    if (value === 'male' || value === 'female')
        return value;
    return undefined;
}
// ───────────────────────────── semantic validation ────────────────────────
const FIELD_PATH_ROOTS = Object.freeze(['prose', 'delta', 'foundation', 'prevState']);
function tokenizeFieldPath(fieldPath) {
    const parts = [];
    let i = 0;
    while (i < fieldPath.length) {
        if (fieldPath[i] === '.') {
            i += 1;
            if (i >= fieldPath.length)
                return null;
            continue;
        }
        if (fieldPath[i] === '[') {
            const close = fieldPath.indexOf(']', i);
            if (close < 0)
                return null;
            const idx = fieldPath.slice(i + 1, close);
            if (!/^\d+$/.test(idx))
                return null;
            parts.push({ type: 'index', value: Number(idx) });
            i = close + 1;
            continue;
        }
        let j = i;
        while (j < fieldPath.length && /[A-Za-z0-9_]/.test(fieldPath[j]))
            j += 1;
        if (j === i)
            return null;
        parts.push({ type: 'key', value: fieldPath.slice(i, j) });
        i = j;
    }
    return parts.length > 0 ? parts : null;
}
function resolveFieldPath(roots, fieldPath) {
    const parts = tokenizeFieldPath(fieldPath);
    if (!parts || parts[0].type !== 'key' || !FIELD_PATH_ROOTS.includes(parts[0].value))
        return { ok: false, reason: 'malformed' };
    let value = roots[parts[0].value];
    for (const part of parts.slice(1)) {
        if (value === null || value === undefined)
            return { ok: false, reason: 'missing' };
        if (part.type === 'index') {
            if (!Array.isArray(value) || part.value >= value.length)
                return { ok: false, reason: 'missing' };
            value = value[part.value];
            continue;
        }
        if (typeof value !== 'object')
            return { ok: false, reason: 'missing' };
        if (!Object.prototype.hasOwnProperty.call(value, part.value))
            return { ok: false, reason: 'missing' };
        value = value[part.value];
    }
    return { ok: true, value };
}
function valueContainsQuote(value, quote) {
    if (typeof value === 'string')
        return value.includes(quote);
    if (typeof value === 'number' || typeof value === 'boolean')
        return quote === String(value) || quote === JSON.stringify(value);
    if (value === null)
        return quote === 'null';
    try {
        const compact = JSON.stringify(value);
        if (typeof compact === 'string' && compact.includes(quote))
            return true;
        const pretty = JSON.stringify(value, null, 2);
        return typeof pretty === 'string' && pretty.includes(quote);
    }
    catch {
        return false;
    }
}
function rejected(code) {
    return { ok: false, code };
}
/**
 * reason 이 실제 설명인지 본다. 기계 토큰(판정값·ID·필드 경로)을 지운 뒤 남는 것이
 * 없으면 근거가 아니다. 목표 언어가 무엇인지는 여기서 판정하지 않는다 — 최종
 * 산출물의 언어 검증은 공용 gate 소유다.
 */
function reasonIsNaturalLanguage(reason, entry) {
    const tokens = [entry.invariantId, entry.fieldPath, ...SEMANTIC_VERDICTS, 'N/A', 'n/a'];
    let rest = reason;
    for (const token of tokens) {
        if (!token)
            continue;
        rest = rest.split(token).join(' ');
    }
    return rest.replace(/[\s\p{P}\p{S}]/gu, '').length >= 4;
}
/**
 * 모델 응답의 semanticValidation 블록을 검증한다. 하나라도 규칙을 어기면 부분
 * 채택 없이 전부 폐기한다 — 절반만 믿은 판정이 통과 증거로 쓰이지 않게 한다.
 */
function validateSemanticBlock(parsed, { requiredIds, contextHash, fieldRoots }) {
    const block = parsed?.semanticValidation;
    if (!isRecord(block))
        return rejected('missing_block');
    if (asString(block.contextHash) !== contextHash)
        return rejected('hash_mismatch');
    if (!isRecord(block.verdicts))
        return rejected('missing_block');
    const verdicts = {};
    for (const [id, value] of Object.entries(block.verdicts)) {
        if (!requiredIds.includes(id))
            return rejected('unknown_invariant_id');
        if (!SEMANTIC_VERDICTS.includes(value))
            return rejected('unknown_verdict');
        verdicts[id] = value;
    }
    for (const id of requiredIds) {
        if (!(id in verdicts))
            return rejected('missing_required_id');
    }
    const rawEvidence = block.evidence ?? [];
    if (!Array.isArray(rawEvidence))
        return rejected('malformed_evidence');
    const evidence = [];
    for (const raw of rawEvidence) {
        if (!isRecord(raw))
            return rejected('malformed_evidence');
        const invariantId = asString(raw.invariantId);
        if (!invariantId)
            return rejected('malformed_evidence');
        if (!requiredIds.includes(invariantId))
            return rejected('unknown_invariant_id');
        const fieldPath = asString(raw.fieldPath)?.trim();
        if (!fieldPath)
            return rejected('malformed_evidence');
        const quote = asString(raw.quote);
        if (!quote || quote.trim().length === 0)
            return rejected('malformed_evidence');
        const resolved = resolveFieldPath(fieldRoots, fieldPath);
        if (!resolved.ok && resolved.reason === 'malformed')
            return rejected('malformed_evidence');
        if (!resolved.ok || !valueContainsQuote(resolved.value, quote))
            return rejected('quote_not_found');
        const reason = asString(raw.reason)?.trim();
        if (!reason)
            return rejected('empty_reason');
        const entry = Object.freeze({ invariantId, fieldPath, quote, reason });
        if (!reasonIsNaturalLanguage(reason, entry))
            return rejected('reason_not_natural_language');
        evidence.push(entry);
    }
    for (const id of requiredIds) {
        if (verdicts[id] !== 'fail')
            continue;
        if (!evidence.some((e) => e.invariantId === id))
            return rejected('fail_without_evidence');
    }
    const ordered = {};
    for (const id of requiredIds)
        ordered[id] = verdicts[id];
    return { ok: true, verdicts: Object.freeze(ordered), evidence: Object.freeze(evidence) };
}
function semanticValidation(status, contextHash, verdicts = {}, evidence = []) {
    return Object.freeze({
        status,
        contextHash,
        verdicts: Object.isFrozen(verdicts) ? verdicts : Object.freeze(verdicts),
        evidence: Object.isFrozen(evidence) ? evidence : Object.freeze(evidence),
    });
}
function fieldRootsOf(input) {
    return Object.freeze({
        prose: typeof input.prose === 'string' ? input.prose : '',
        delta: input.delta ?? null,
        foundation: input.foundation ?? null,
        prevState: input.prevState ?? null,
    });
}
// ───────────────────────────── static prompt captures ─────────────────────
/** ADR-0006 promptManifest 수집용 계열 정적 표면. 수집·hash 는 integrator 소유다. */
export function continuityExtractSystemStatic(family) {
    return pickByFamily(promptFamilyCaptureContext(family), {
        ko: EXTRACT_DELTA_SYSTEM,
        multilingual: EXTRACT_DELTA_SYSTEM_MULTILINGUAL,
    });
}
/** extract 재요청은 같은 system 을 쓰고 지시문만 다르다 — 그 지시문을 캡처한다. */
export function continuityExtractRepairStatic(family) {
    return pickByFamily(promptFamilyCaptureContext(family), {
        ko: EXTRACT_REPAIR_KO,
        multilingual: EXTRACT_REPAIR_EN,
    });
}
export function continuityCheckSystemStatic(family) {
    return pickByFamily(promptFamilyCaptureContext(family), {
        ko: CONTINUITY_CHECK_SYSTEM,
        multilingual: CONTINUITY_CHECK_SYSTEM_MULTILINGUAL,
    });
}
/** live step id → 계열 정적 캡처 함수. id 는 `providers.complete({step})` 값이다. */
export const CONTINUITY_STATIC_PROMPT_CAPTURES = Object.freeze({
    'continuity-check': continuityCheckSystemStatic,
    'continuity-extract': continuityExtractSystemStatic,
    'continuity-extract-repair': continuityExtractRepairStatic,
});
/** 수집 대상 id 목록(정렬 고정 — 수집 순서가 hash 를 흔들지 않게). */
export const CONTINUITY_STATIC_PROMPT_STEPS = Object.freeze(Object.keys(CONTINUITY_STATIC_PROMPT_CAPTURES).sort());
// ───────────────────────────── continuityCheck ────────────────────────────
export async function continuityCheck(input) {
    // 언어 해석 먼저 — 저장된 계약과 어긋나는 명시 인자는 provider 호출 전에 끝난다.
    const ctx = resolveStepPromptLanguage(input);
    const fallback = pickByFamily(ctx, { ko: CHECK_FALLBACK_KO, multilingual: CHECK_FALLBACK_EN });
    const violations = [];
    // ─── Layer-1: deterministic lexicon scan ──────────────────────────────
    // ko 전용 사전 기반 검사다. 비ko 에서는 돌리지 않고 건너뛴 사실을 알린다 —
    // 실행되지 않은 검사의 빈 결과는 통과 증거가 아니다.
    const deterministicScan = scanMarker('scanLexicon', ctx.isKo);
    if (ctx.isKo) {
        const layer1 = scanLexicon({
            prose: input.prose,
            chapterNumber: input.chapterNumber,
            foundation: input.foundation,
            lexicon: input.lexicon,
        });
        for (const v of layer1.violations)
            violations.push(v);
    }
    // ─── Structural: mutableChanges against an unknown character ──────────
    const characterIds = new Set(input.foundation.characters.map((c) => c.id));
    for (const change of input.delta.mutableChanges) {
        if (characterIds.has(change.characterId))
            continue;
        if (!change.knownFactsAdded || change.knownFactsAdded.length === 0)
            continue;
        violations.push({
            severity: 'hard',
            code: 'INTRINSIC_VIOLATION',
            chapterNumber: input.chapterNumber,
            characterId: change.characterId,
            // 같은 code 를 두 곳에서 낸다 — 여기(결정적 구조 검사)와 아래 Layer-2 (LLM 판정).
            // host 는 message 를 영속화할 수 없으므로(LLM 자유 텍스트라 본문이 샐 수 있다)
            // 어느 쪽이 터졌는지 가릴 수단이 이 상수뿐이다. #255.
            origin: 'structural',
            message: fallback.unregistered(change.characterId),
        });
    }
    // ─── Layer-2: LLM semantic pass ───────────────────────────────────────
    const requiredIds = input.checkerPlan ? requiredSemanticInvariantIds(input.checkerPlan) : [];
    const unsupportedIds = input.checkerPlan ? unsupportedRequiredSemanticInvariantIds(input.checkerPlan) : [];
    const semanticRequested = input.checkerPlan !== null && input.checkerPlan !== undefined;
    const contextHash = sha256Hex(continuityHashPayload(input, ctx.contract));
    const sections = buildContinuityCheckSections(input);
    // 미지원 필수 ID 가 있으면 의미 블록을 묻지 않는다 — 물어 만든 부분 판정을
    // 통과처럼 남기지 않기 위해서다. 결과는 invalid.
    const semanticPrompt = semanticRequested && requiredIds.length > 0 && unsupportedIds.length === 0
        ? { contextHash, requiredIds }
        : null;
    const userPrompt = buildContinuityCheckUserPrompt(input, ctx, sections, semanticPrompt);
    let llmText = '';
    let providerError = false;
    try {
        const response = await input.providers.complete({
            model: input.model,
            jsonMode: true,
            step: 'continuity-check',
            messages: [
                {
                    role: 'system',
                    content: systemContent(ctx, pickByFamily(ctx, {
                        ko: CONTINUITY_CHECK_SYSTEM,
                        multilingual: CONTINUITY_CHECK_SYSTEM_MULTILINGUAL,
                    })),
                },
                { role: 'user', content: userPrompt },
            ],
        });
        llmText = response.text ?? '';
    }
    catch {
        llmText = '';
        providerError = true;
    }
    const parsed = llmText ? asRecord(tryParseJson(llmText)) : {};
    // ─── Semantic verdicts (new contract only) ────────────────────────────
    // 판정은 legacy findings 와 분리돼 있다. 여기서 나온 fail 은 coverage 소유자가
    // 막고, 아래 legacy `passed` 계산에는 손대지 않는다.
    let semantic;
    if (unsupportedIds.length > 0)
        semantic = semanticValidation('invalid', contextHash);
    else if (!semanticPrompt)
        semantic = semanticValidation('pending', contextHash);
    else if (providerError)
        semantic = semanticValidation('error', contextHash);
    else {
        const first = llmText
            ? validateSemanticBlock(parsed, { requiredIds, contextHash, fieldRoots: fieldRootsOf(input) })
            : rejected('missing_block');
        semantic = first.ok
            ? semanticValidation('completed', contextHash, first.verdicts, first.evidence)
            : semanticValidation('invalid', contextHash);
    }
    const invariantById = new Map(input.foundation.genreProfile.invariants.map((inv) => [inv.id, inv]));
    for (const raw of asArray(parsed.intrinsicViolations)) {
        const e = asRecord(raw);
        const characterId = asString(e.characterId);
        const message = asString(e.message) ?? fallback.intrinsic;
        violations.push({
            severity: 'hard',
            code: 'INTRINSIC_VIOLATION',
            chapterNumber: input.chapterNumber,
            ...(characterId ? { characterId } : {}),
            origin: 'llm',
            message,
        });
    }
    for (const raw of asArray(parsed.invariantViolations)) {
        const e = asRecord(raw);
        const invariantId = asString(e.invariantId);
        const message = asString(e.message) ?? fallback.invariant(invariantId);
        const matched = invariantId ? invariantById.get(invariantId) : undefined;
        violations.push({
            severity: matched?.severity ?? 'soft',
            code: 'INVARIANT_VIOLATION',
            chapterNumber: input.chapterNumber,
            message,
        });
    }
    for (const raw of asArray(parsed.unjustifiedMutable)) {
        const e = asRecord(raw);
        const characterId = asString(e.characterId);
        const message = asString(e.message) ?? fallback.mutable;
        violations.push({
            severity: 'soft',
            code: 'MUTABLE_UNJUSTIFIED',
            chapterNumber: input.chapterNumber,
            ...(characterId ? { characterId } : {}),
            message,
        });
    }
    const lexiconAdditions = [];
    for (const raw of asArray(parsed.lexiconAdditions)) {
        const e = asRecord(raw);
        const term = asString(e.term);
        if (!term)
            continue;
        const entry = { term };
        const gender = normaliseGender(e.genderImplication);
        if (gender)
            entry.genderImplication = gender;
        const speakerGender = normaliseGender(e.speakerGenderImplication);
        if (speakerGender)
            entry.speakerGenderImplication = speakerGender;
        const status = asString(e.statusImplication);
        if (status)
            entry.statusImplication = status;
        lexiconAdditions.push(entry);
    }
    const passed = violations.every((v) => v.severity !== 'hard');
    return { passed, violations, lexiconAdditions, semanticValidation: semantic, deterministicScan };
}
