const FORMAT_INVARIANTS = new Set([
  'WEBNOVEL_DIALOGUE_BURIED',
  'WEBNOVEL_DIALOGUE_NOT_ISOLATED',
  'WEBNOVEL_SOFT_LINEBREAKS',
]);

export function classifyQualityViolations(violations = []) {
  const blocking = [];
  const advisory = [];
  for (const violation of violations.filter(Boolean)) {
    const invariant = !violation.advisoryOnly && (violation.severity === 'hard'
      || violation.code === 'QUALITY_GATE_LENGTH'
      || FORMAT_INVARIANTS.has(violation.code));
    (invariant ? blocking : advisory).push(violation);
  }
  return { blocking, advisory };
}

export function dedupeQualityViolations(violations = []) {
  const seen = new Set();
  return violations.filter((violation) => {
    if (!violation) return false;
    const key = [violation.severity, violation.code, violation.chapterNumber, violation.message].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function qualityDecision({ violations }) {
  const classified = classifyQualityViolations(violations);
  return {
    blocking: classified.blocking,
    advisory: classified.advisory,
    shouldRevise: classified.blocking.length > 0,
  };
}

export function autoCommitDecision({ autonomy, styleDrift = false, reviewStatus }) {
  if (autonomy !== 'auto') return { allowed: false, code: 'GUIDED_REVIEW' };
  if (reviewStatus !== 'completed') return { allowed: false, code: 'CRITIC_INCOMPLETE' };
  if (styleDrift) return { allowed: false, code: 'STYLE_ANCHOR_DRIFT' };
  return { allowed: true, code: null };
}
