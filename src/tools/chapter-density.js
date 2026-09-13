const DENSITY_CODES = new Set(['OVERLONG_DENSITY', 'REPEATED_NEGOTIATION', 'DOUBLE_ENDING']);
const MIN_DENSITY_DIMENSION = 60;

/**
 * New-contract length assessment. Uses the workContract measurement
 * (`unit`/`actual`/`target`) instead of JS string length / chapterChars.
 * Over-target still does not by itself require revision.
 */
export function assessContractLength({ measurement, editorial }) {
  if (!measurement || !Number.isFinite(measurement.actual) || !Number.isFinite(measurement.target) || measurement.target <= 0) throw new Error('UNSUPPORTED_LENGTH_MEASUREMENT');
  const { target, actual, unit } = measurement;
  const min = Math.max(1, Number(measurement?.min) || Math.floor(target * 0.85));
  const ratio = actual / target;
  const densityFindings = (editorial?.findings ?? []).filter((finding) => DENSITY_CODES.has(finding?.code));
  const weakDimensions = ['density', 'endingFocus'].filter((dimension) => {
    const score = Number(editorial?.dimensions?.[dimension]);
    return Number.isFinite(score) && score < MIN_DENSITY_DIMENSION;
  });
  const evidenceBased = densityFindings.length > 0 || weakDimensions.length > 0;
  const band = ratio < 0.85 ? 'short' : ratio > 1.4 ? 'very_long' : ratio > 1.25 ? 'long' : 'within_range';
  return {
    unit, actual, target, min, recommended: Number(measurement?.recommended) || target,
    ratio: Math.round(ratio * 100) / 100, band,
    warning: ratio > 1.25,
    requiresRevision: ratio > 1.25 && evidenceBased,
    belowMinimum: actual < min,
    weakDimensions,
    findings: densityFindings,
    lengthMeasurement: { unit, actual, min, recommended: Number(measurement?.recommended) || target },
  };
}

export function assessChapterLength({ chars, targetChars, editorial }) {
  const target = Math.max(1, Number(targetChars) || 3000);
  const actual = Math.max(0, Number(chars) || 0);
  const ratio = actual / target;
  const densityFindings = (editorial?.findings ?? []).filter((finding) => DENSITY_CODES.has(finding?.code));
  const weakDimensions = ['density', 'endingFocus'].filter((dimension) => {
    const score = Number(editorial?.dimensions?.[dimension]);
    return Number.isFinite(score) && score < MIN_DENSITY_DIMENSION;
  });
  const evidenceBased = densityFindings.length > 0 || weakDimensions.length > 0;
  const band = ratio < 0.85 ? 'short' : ratio > 1.4 ? 'very_long' : ratio > 1.25 ? 'long' : 'within_range';
  return {
    chars: actual, targetChars: target, ratio: Math.round(ratio * 100) / 100, band,
    warning: ratio > 1.25,
    requiresRevision: ratio > 1.25 && evidenceBased,
    weakDimensions,
    findings: densityFindings,
  };
}

export function chapterDensityViolations(assessment, chapter) {
  if (!assessment?.requiresRevision) return [];
  if (assessment.findings.length) {
    return assessment.findings.map((finding) => ({
      severity: 'soft', chapterNumber: chapter, code: finding.code,
      message: finding.message,
    }));
  }
  return assessment.weakDimensions.map((dimension) => ({
    severity: 'soft', chapterNumber: chapter,
    code: dimension === 'endingFocus' ? 'DOUBLE_ENDING' : 'OVERLONG_DENSITY',
    message: `본문이 목표 분량의 ${Math.round(assessment.ratio * 100)}%이고 ${dimension}가 ${MIN_DENSITY_DIMENSION}점 미만이다. 반복 기능은 덜어내되 고유 장면과 감정 체류는 보존하라.`,
  }));
}
