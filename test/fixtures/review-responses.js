// Synthetic successful reviews for transport/continuity tests, not prose ratings.
export const REVIEW_RESPONSES = Object.fromEntries(Object.entries({
  'coherence-judge': { score: 88, reason: '검사용 연결 확인' },
  'editorial-quality': { score: 88, dimensions: { density: 88 }, findings: [] },
  'character-fidelity': { score: 88, dimensions: { voice: 88, motivation: 88, responseCausality: 88, relationshipContinuity: 88, dialogueIntent: 88 }, findings: [] },
  'reader-hook': { score: 88, dimensions: { competenceProof: 88 }, findings: [] },
  'pattern-ledger': { solutionPattern: '전투', protagonistMethod: '도움을 받는다', mistakeAndCorrection: '방법을 바꾼다', supportingAgency: {} },
  'arc-review': { score: 88, dimensions: { payoffCadence: 88, patternVariety: 88, moralChoiceVariety: 88, emotionalTemperatureRange: 88, evidenceVariety: 88, endingVariety: 88, commercialMomentum: 88 }, findings: [] },
}).map(([step, value]) => [step, JSON.stringify(value)]));
