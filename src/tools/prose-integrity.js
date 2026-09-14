const MACHINE_VALUE_LINE = /^(?:null|undefined|nan|\[object Object\])$/i;

export function inspectProseIntegrity(prose) {
  const text = String(prose ?? '');
  const violations = [];
  if (!text.trim()) {
    violations.push({ code: 'EMPTY_PROSE', message: '본문이 비어 있습니다.' });
  }
  text.split(/\r?\n/).forEach((line, index) => {
    if (MACHINE_VALUE_LINE.test(line.trim())) {
      violations.push({
        code: 'MACHINE_VALUE_LEAK',
        line: index + 1,
        message: `${index + 1}행에 모델·도구의 기계값(${line.trim()})이 본문으로 유출됐습니다.`,
      });
    }
  });
  return violations;
}

/** Detect model-only cast projections that have escaped their sentinel block. */
export function trailingCastMetadata(prose, characters = []) {
  const tail = String(prose ?? '').split(/\r?\n/).slice(-15);
  const names = new Set(characters.map((character) => character.canonicalName).filter(Boolean));
  const pairs = new Set(characters.map((character) => `${character.id}|${character.canonicalName}`));
  const leaked = [];
  for (const line of tail) {
    const raw = line.trim();
    const bare = raw.replace(/^[-*]\s*/, '');
    if (pairs.has(bare) || (/^[-*]\s+/.test(raw) && names.has(bare))) leaked.push(raw);
  }
  return leaked;
}

export function assertProseIntegrity(prose) {
  const violations = inspectProseIntegrity(prose);
  if (violations.length) {
    const error = new Error(`본문 무결성 검사 실패: ${violations.map((v) => v.message).join(' ')}`);
    error.code = 'PROSE_INTEGRITY_FAILED';
    error.violations = violations;
    throw error;
  }
}
