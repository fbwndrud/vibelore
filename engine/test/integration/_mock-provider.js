/**
 * Helper for the end-to-end integration test (T3.7).
 *
 * Constructs a scripted ProviderRegistry whose `complete()` method matches
 * incoming LLM calls by the system-prompt keyword used elsewhere in the
 * engine. Each kind has its own monotonically advancing counter so a single
 * test can script per-chapter responses without coupling to call order across
 * kinds (e.g. plan→draft→extractDelta→continuityCheck repeats every chapter,
 * but worldbuild + castDesign happen only once during book-create).
 *
 * Why per-kind counters instead of a flat global counter: the strict global
 * sequence is brittle — adding a single new LLM call anywhere in the pipeline
 * (e.g. T3.4 inserting registerCharacter) would silently mis-align every
 * downstream response. Per-kind counters survive insertion of unrelated calls.
 *
 */
/**
 * Map an incoming LLMRequest to its `LlmCallKind` by inspecting the system
 * prompt keyword. The keywords below must match the literal strings used by
 * the step files (worldbuild.ts, cast-design.ts, chapter-plan.ts, draft.ts,
 * continuity-check.ts, revise.ts).
 */
export function classify(req) {
    const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
    if (sys.includes('월드빌더'))
        return 'worldbuild';
    if (sys.includes('캐스트 디자이너'))
        return 'castDesign';
    if (sys.includes('회차 기획자'))
        return 'chapterPlan';
    // NEP-V7 (V-D8): the multi-arc auto-transition proposal step. Distinct from
    // '회차 기획자' (chapterPlan) — matched on the 'Arc 기획자' literal only. No
    // production/integration path drives this yet, so scripts that omit a
    // `nextArcProposal` bucket keep returning '{}' (byte-identical to before).
    if (sys.includes('Arc 기획자'))
        return 'nextArcProposal';
    if (sys.includes('한국어 웹소설 작가'))
        return 'draft';
    if (sys.includes('연속성 분석기'))
        return 'extractDelta';
    if (sys.includes('연속성 검수기'))
        return 'continuityCheck';
    if (sys.includes('한국어 웹소설 교정자'))
        return 'revise';
    return 'unknown';
}
/**
 * Build a ProviderRegistry that returns scripted text per call-kind. Returns
 * the registry plus the live `calls` array so the test can introspect order
 * / count / payload after the fact.
 */
export function buildMockRegistry(script) {
    const calls = [];
    const indices = {
        worldbuild: 0,
        castDesign: 0,
        chapterPlan: 0,
        nextArcProposal: 0,
        draft: 0,
        extractDelta: 0,
        continuityCheck: 0,
        revise: 0,
        unknown: 0,
    };
    const registry = {
        register: () => undefined,
        has: () => true,
        async complete(req) {
            const kind = classify(req);
            calls.push({ kind, request: req });
            const bucket = script[kind] ?? [];
            const i = Math.min(indices[kind], bucket.length - 1);
            indices[kind] += 1;
            const text = bucket[i] ?? '{}';
            return {
                text,
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            };
        },
    };
    return { registry, calls };
}
