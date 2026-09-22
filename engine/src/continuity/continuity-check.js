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
 * benefits from model upgrades automatically (Epic #23). Prompts are
 * ko-native; the JSON envelope is structural so the model can fill it
 * regardless of language. Parsing is permissive — a malformed LLM response
 * degrades to empty ops rather than throwing, so a single hallucinated
 * delimiter cannot wedge a chapter.
 */
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
function buildExtractDeltaUserPrompt(input, manifest) {
    const { prose, chapterNumber, prevState } = input;
    const prevSummary = {
        chapterNumber: prevState.chapterNumber,
        addressMapKeys: Object.keys(prevState.addressMap.entries),
        activeHookIds: (prevState.hooks ?? []).filter(isHookActive).map((h) => h.id ?? h.hookId),
    };
    const castSummary = manifest.map((c) => ({
        characterId: c.characterId,
        addressTermsUsed: c.addressTermsUsed,
    }));
    return [
        `## 회차 번호`,
        String(chapterNumber),
        ``,
        `## 이전 상태 요약 (StoryState N-1)`,
        JSON.stringify(prevSummary),
        ``,
        `## 이번 회차 등장 캐스트 (writer manifest)`,
        JSON.stringify(castSummary),
        ``,
        `## 본문`,
        prose,
        ``,
        `## 출력 스키마 (이 JSON 한 개만 출력)`,
        '{',
        '  "newAddressEntries": [{ "speakerId": "...", "targetId": "...", "term": "...", "register": "formal|intimate|subordinate|..." }],',
        '  "relationshipOps": [{ "to": "...", "kind": "...", "state": "..." }],',
        '  "hookChanges": [{ "id": "...", "text": "독자가 아직 답을 기다리는 약속", "plantedAtChapter": 0, "phase": "planted|advancing|paid|parked", "horizon": "next|soon|arc|long|finale", "lastMovedChapter": 0 }],',
        '  "mutableChanges": [{ "characterId": "...", "location": "...", "status": "...", "knownFactsAdded": ["..."] }],',
        '  "influenceEvents": [{ "characterId": "...", "anchor": "본문에서 확인 가능한 짧은 근거", "interpretation": "이 사건을 인물이 어떻게 받아들였는가", "dimensionChanges": { "작품별_dimension_id": -1 }, "nextChoiceBias": "다음 선택에 생긴 편향", "behavioralProof": { "hypothesis": "성격 가설", "voluntary": true, "alternativesKnown": true, "alternativesAvailable": ["선택A", "선택B"], "chosen": "실제 선택", "costPaid": "지불한 비용", "competingHypotheses": [] }, "relationshipClaims": [{ "from": "...", "to": "...", "dimensions": { "trust": 1 }, "belief": "from이 to를 어떻게 보게 됐는가" }] }],',
        '  "noInfluenceReason": "인물의 선택·비용·인식·관계 변화가 정말 없을 때만 구체적으로 작성",',
        '  "trackedEntityOps": [{ "kind": "Timeline|RelationshipState|PowerSystem|Artifact|Clue|KnowledgeMatrix", "data": {} }]',
        '}',
    ].join('\n');
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
export async function extractDelta(input) {
    const manifest = parseCastManifest(input.castManifestRaw);
    const unregisteredNamed = findUnregisteredNamed(input.prose, input.foundation);
    const userPrompt = buildExtractDeltaUserPrompt(input, manifest);
    let llmText = '';
    try {
        const response = await input.providers.complete({
            model: input.model,
            jsonMode: true,
            step: 'continuity-extract',
            messages: [
                { role: 'system', content: EXTRACT_DELTA_SYSTEM },
                { role: 'user', content: userPrompt },
            ],
        });
        llmText = response.text;
    }
    catch {
        // Provider failure → degrade to empty delta; caller observes via empty ops.
        llmText = '';
    }
    const appearedCharacterIds = manifest.map((c) => c.characterId);
    let parsed = llmText ? tryParseJson(llmText) : null;
    let delta = parseChapterDeltaPayload(parsed, input.chapterNumber, appearedCharacterIds);
    // A relay that is still collecting the first extraction has no real delta
    // yet; a repair built on that placeholder would only waste a host answer.
    if (input.requireInfluenceObservation === true
        && (input.providers.pending?.length ?? 0) === 0
        && delta.influenceEvents.length === 0
        && !delta.noInfluenceReason) {
        try {
            const response = await input.providers.complete({
                model: input.model,
                jsonMode: true,
                step: 'continuity-extract-repair',
                messages: [
                    { role: 'system', content: EXTRACT_DELTA_SYSTEM },
                    { role: 'user', content: `${userPrompt}\n\n이전 응답에는 influenceEvents와 noInfluenceReason이 모두 비어 있어 커밋할 수 없다. 본문에 선택·비용·인식·관계 변화가 있으면 influenceEvents를 스키마대로 채우고, 정말 없을 때만 구체적인 noInfluenceReason을 채워 전체 ChapterDelta JSON을 다시 출력하라.\n\n이전 응답:\n${llmText}` },
                ],
            });
            parsed = response.text ? tryParseJson(response.text) : null;
            delta = parseChapterDeltaPayload(parsed, input.chapterNumber, appearedCharacterIds);
        }
        catch {
            // The workflow observes a pending relay request or keeps the invalid
            // delta blocked; it must never invent an influence event.
        }
    }
    const idByReference = new Map();
    for (const character of input.foundation.characters) {
        idByReference.set(character.id, character.id);
        idByReference.set(character.canonicalName, character.id);
        for (const alias of character.aliases ?? [])
            idByReference.set(alias, character.id);
    }
    const resolveId = (value) => idByReference.get(value) ?? null;
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
    return { delta, manifest, unregisteredNamed };
}
// Exported for ADR-0006 promptManifest collection.
export const CONTINUITY_CHECK_SYSTEM = [
    '당신은 한국어 웹소설 연속성 검수기이다.',
    '본문, 이전 상태 요약, Foundation 요약, 회차 Delta, 장르 invariant 목록을 받아',
    '본문과 구조화 데이터가 충돌하는 지점을 골라낸다. 출력은 순수 JSON 한 개.',
    '의심만으로 hard 위반을 만들지 말 것. Foundation·delta·prevState 와 본문이 명확히 모순되는 경우만 hard 로 분류.',
    '본문에 새로 등장한 호칭(존칭/대명사)이 있고 함의(성별/화자성별/지위)가 명확히 추론되면 lexiconAdditions 에 담는다.',
].join(' ');
function buildContinuityCheckUserPrompt(input) {
    const { prose, chapterNumber, delta, prevState, foundation } = input;
    const prevSummary = {
        chapterNumber: prevState.chapterNumber,
        addressMapKeys: Object.keys(prevState.addressMap.entries),
        activeHookIds: (prevState.hooks ?? []).filter(isHookActive).map((h) => h.id ?? h.hookId),
    };
    const foundationSummary = {
        genre: foundation.genre,
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
    const invariants = foundation.genreProfile.invariants;
    return [
        `## 회차 번호`,
        String(chapterNumber),
        ``,
        `## 이전 상태 요약`,
        JSON.stringify(prevSummary),
        ``,
        `## Foundation 요약`,
        JSON.stringify(foundationSummary),
        ``,
        `## 이번 회차 Delta`,
        JSON.stringify(delta),
        ``,
        `## 장르 invariant 목록`,
        JSON.stringify(invariants),
        ``,
        `## 본문`,
        prose,
        ``,
        `## 검수 작업`,
        '- intrinsic 위반: Foundation 의 캐릭터 intrinsic(성별/연령대/역할 등)과 본문 묘사가 충돌하는 사례',
        '- invariant 위반: 위 invariant 목록 중 본문/Delta 에서 깨진 항목 (invariantId 명시)',
        '- 정당화되지 않은 mutable 변경: location/status 변화가 본문에 명시되지 않는 경우',
        '- lexicon 추가: 본문에 등장한 호칭이 알려지지 않은 경우 함의 분류',
        ``,
        `## 출력 스키마 (이 JSON 한 개만 출력)`,
        '{',
        '  "intrinsicViolations": [{ "characterId": "...", "message": "..." }],',
        '  "invariantViolations": [{ "invariantId": "...", "message": "..." }],',
        '  "unjustifiedMutable": [{ "characterId": "...", "message": "..." }],',
        '  "lexiconAdditions": [{ "term": "...", "genderImplication": "male|female|null", "speakerGenderImplication": "male|female|null", "statusImplication": "..." }]',
        '}',
    ].join('\n');
}
function normaliseGender(value) {
    if (value === 'male' || value === 'female')
        return value;
    return undefined;
}
export async function continuityCheck(input) {
    const violations = [];
    // ─── Layer-1: deterministic lexicon scan ──────────────────────────────
    const layer1 = scanLexicon({
        prose: input.prose,
        chapterNumber: input.chapterNumber,
        foundation: input.foundation,
        lexicon: input.lexicon,
    });
    for (const v of layer1.violations)
        violations.push(v);
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
            message: `Foundation 에 미등록된 캐릭터 "${change.characterId}" 의 knownFacts 변경 시도`,
        });
    }
    // ─── Layer-2: LLM semantic pass ───────────────────────────────────────
    let llmText = '';
    try {
        const response = await input.providers.complete({
            model: input.model,
            jsonMode: true,
            step: 'continuity-check',
            messages: [
                { role: 'system', content: CONTINUITY_CHECK_SYSTEM },
                { role: 'user', content: buildContinuityCheckUserPrompt(input) },
            ],
        });
        llmText = response.text;
    }
    catch {
        llmText = '';
    }
    const parsed = llmText ? asRecord(tryParseJson(llmText)) : {};
    const invariantById = new Map(input.foundation.genreProfile.invariants.map((inv) => [inv.id, inv]));
    for (const raw of asArray(parsed.intrinsicViolations)) {
        const e = asRecord(raw);
        const characterId = asString(e.characterId);
        const message = asString(e.message) ?? '본문이 Foundation intrinsic 과 충돌';
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
        const message = asString(e.message) ?? `invariant 위반${invariantId ? ` (${invariantId})` : ''}`;
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
        const message = asString(e.message) ?? 'mutable 변경에 서사적 근거 부족';
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
    return { passed, violations, lexiconAdditions };
}
