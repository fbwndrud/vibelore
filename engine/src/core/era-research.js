/**
 * Era-research adapter — provider tool-use (web search) cross-check for
 * era-fidelity dim. Active only when GenreContinuityProfile.eraResearch
 * is true (urban / historical / mystery-thriller). Cost-gated by
 * per-job budget — never exceeds budget.maxCalls without short-circuiting.
 *
 * The actual provider implementation is injected so that the engine
 * remains provider-agnostic. Mock implementations are used in tests.
 */
export async function runEraResearch(input) {
    const violations = [];
    const budget = { ...input.budget };
    for (const claim of input.claims) {
        if (budget.used >= budget.maxCalls)
            break;
        const finding = await input.provider.research({
            era: input.era,
            claim,
            chapterNumber: input.chapterNumber,
        });
        budget.used++;
        if (!finding)
            continue;
        if (finding.verdict === 'contradicts') {
            violations.push({
                severity: 'soft',
                code: 'ERA_FIDELITY_CONFLICT',
                chapterNumber: input.chapterNumber,
                message: `시대 고증 충돌 (era=${input.era}): "${claim}" — ${finding.explanation}${finding.sources.length > 0 ? ` (sources: ${finding.sources.slice(0, 2).join(', ')})` : ''}`,
            });
        }
    }
    return { violations, budgetAfter: budget };
}
/** Default budget — 1 call per chapter. */
export const DEFAULT_ERA_RESEARCH_BUDGET = {
    maxCalls: 1,
    used: 0,
};
/** Null provider — no-op, returns null always. Wired in production until
 *  real provider tool-use is enabled. */
export const NULL_ERA_RESEARCH_PROVIDER = {
    provider: 'null',
    research: async () => null,
};
