// Structured, request-bound test answers. These fixtures exercise the real parsers;
// they never replace runtime validation or infer pass from legacy empty findings.
export function contractResponse(req) {
  const text = req.messages.map(m => m.content).join('\n');
  const hash = text.match(/contextHash: ([a-f0-9]{64})/)?.[1];
  if (req.step === 'continuity-extract' && hash) return { text: JSON.stringify({ appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], hookOps: [], mutableChanges: [], influenceEvents: [], trackedEntityOps: [], noInfluenceReason: '지속되는 변화가 없다.', extractionValidation: { contextHash: hash } }) };
  if (req.step === 'continuity-check' && hash) {
    const ids = text.match(/these invariants: ([A-Z_, ]+)\./)?.[1]?.split(', ') ?? text.match(/판정한다: ([A-Z_, ]+)\./)?.[1]?.split(', ') ?? [];
    return { text: JSON.stringify({ violations: [], semanticValidation: { contextHash: hash, verdicts: Object.fromEntries(ids.map(id=>[id, 'pass'])), evidence: [] } }) };
  }
  if (req.step === 'language-contract') return { text: JSON.stringify({ language: text.match(/(?:Target language|목표 언어): ([^\n]+)/)?.[1], artifactHash: text.match(/artifactHash: ([a-f0-9]{64})/)?.[1], verdict: 'pass', evidence: [], allowedExceptions: [] }) };
  if (req.step === 'chapter-title') return { text: '{"title":"첫 문"}' };
  return null;
}
