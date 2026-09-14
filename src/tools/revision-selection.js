function number(value, fallback = 0) { return Number.isFinite(value) ? value : fallback; }

export function makeRevisionCandidate({ attempt, prose, castManifestRaw, check, coherence, editorial, characterFidelity, readerHook, lengthFailed, mustRevise, experienceFailed, preservation = null }) {
  const hard = number(check?.counts?.hard);
  const score = Math.round((number(check?.prosody?.score, 50) * 0.15 + number(coherence?.score, 50) * 0.25
    + number(editorial?.score, 50) * 0.25 + number(characterFidelity?.score, 50) * 0.15 + number(readerHook?.score, 50) * 0.20) * 10) / 10;
  return {
    attempt, prose, castManifestRaw, proseChars: prose.length, score, hard,
    preservationPassed: preservation?.passed ?? true,
    preservation: preservation ? { passed: preservation.passed, metrics: preservation.metrics, violations: preservation.violations } : null,
    lengthValid: !lengthFailed, gatePassed: !mustRevise && !experienceFailed,
    metrics: { prosody: check?.prosody?.score ?? null, coherence: coherence?.score ?? null, editorial: editorial?.score ?? null, characterFidelity: characterFidelity?.score ?? null, readerHook: readerHook?.score ?? null },
    createdAt: new Date().toISOString(),
  };
}

export function chooseBestRevision(candidates) {
  return [...candidates].sort((a, b) => {
    if ((a.preservationPassed !== false) !== (b.preservationPassed !== false)) return a.preservationPassed !== false ? -1 : 1;
    if (a.gatePassed !== b.gatePassed) return a.gatePassed ? -1 : 1;
    if ((a.hard === 0) !== (b.hard === 0)) return a.hard === 0 ? -1 : 1;
    if (a.lengthValid !== b.lengthValid) return a.lengthValid ? -1 : 1;
    return b.score - a.score || a.attempt - b.attempt;
  })[0] ?? null;
}

export function publicRevisionCandidate(candidate) {
  if (!candidate) return null;
  const { prose, castManifestRaw, ...safe } = candidate;
  return safe;
}
