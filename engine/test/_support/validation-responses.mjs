/** Structured mock verdicts for prompt-routing fixtures, not language-quality tests. */
export function validationFixtureResponse(req, fallback = '{}') {
    const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
    const hash = user.match(/(?:contextHash:\s*|## artifactHash\s*\n)([a-f0-9]{64})/)?.[1];
    if (req.step === 'output-language-compliance') {
        const language = user.match(/language: ([A-Za-z0-9-]+)/)?.[1];
        return JSON.stringify({ language, verdict: 'pass', artifactHash: hash, evidence: [], allowedExceptions: [] });
    }
    if (req.step === 'chapter-title-summary')
        return JSON.stringify({ title: 'A chapter', summary: 'A character approaches the gate.' });
    if (req.step === 'continuity-extract' || req.step === 'continuity-extract-repair')
        return JSON.stringify({ newAddressEntries: [], relationshipOps: [], hookOps: [], mutableChanges: [],
            influenceEvents: [], trackedEntityOps: [], noInfluenceReason: 'No new enduring changes in this scene.',
            extractionValidation: { contextHash: hash } });
    if (req.step === 'continuity-check') {
        const base = JSON.parse(fallback);
        const ids = user.match(/(?:판정한다|these invariants): ([A-Z, ]+)\./)?.[1]?.split(', ') ?? [];
        return JSON.stringify({ ...base, semanticValidation: { contextHash: hash,
            verdicts: Object.fromEntries(ids.map((id) => [id, 'pass'])), evidence: [] } });
    }
    return fallback;
}
