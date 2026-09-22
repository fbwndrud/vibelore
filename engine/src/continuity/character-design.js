/**
 * CharacterDesign owns the normalization and quality contract for a newly
 * generated character. Callers provide one loose model response; this module
 * returns one durable identity core plus a story-specific dramatic model.
 */

export const GENDER_VALUES = new Set([
  'male', 'female', 'nonbinary', 'unknown', 'undisclosed', 'not_applicable', 'custom',
]);

const text = (value, fallback = '') => typeof value === 'string' ? value.trim() : fallback;
const strings = (value) => Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function normalizeGender(value) {
  if (value === 'unspecified') return 'unknown';
  return typeof value === 'string' && GENDER_VALUES.has(value) ? value : 'unknown';
}

function behaviorTraits(value, contradiction) {
  const parsed = (Array.isArray(value) ? value : []).flatMap((item) => {
    const trait = object(item);
    const trigger = text(trait.trigger);
    const actionBias = text(trait.actionBias);
    const benefit = text(trait.benefit);
    const cost = text(trait.cost);
    return trigger && actionBias && benefit && cost ? [{ trigger, actionBias, benefit, cost }] : [];
  });
  if (parsed.length) return parsed.slice(0, 5);
  return [{
    trigger: '핵심 욕망이 위협받을 때',
    actionBias: contradiction || '익숙한 방식으로 통제권을 되찾으려 한다',
    benefit: '즉시 행동하여 장면을 정체시키지 않는다',
    cost: '자신의 모순을 강화해 관계와 다음 선택에 비용을 만든다',
  }];
}

export function normalizeDramaticModel(raw, { contradiction = '', description = '' } = {}) {
  const model = object(raw);
  const perception = object(model.perception);
  const defense = object(model.defense);
  const repair = object(model.repair);
  const baselines = object(model.dimensionBaselines);
  const dimensionBaselines = Object.fromEntries(Object.entries(baselines)
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([key, value]) => [key, Math.max(0, Math.min(4, Number(value)))])
    .slice(0, 7));
  return {
    valueOrder: strings(model.valueOrder).slice(0, 6),
    behaviorTraits: behaviorTraits(model.behaviorTraits, contradiction),
    perception: {
      seesFirst: strings(perception.seesFirst).slice(0, 5),
      missesFirst: strings(perception.missesFirst).slice(0, 5),
    },
    defense: {
      public: text(defense.public, description || contradiction),
      underPressure: text(defense.underPressure, contradiction),
    },
    repair: {
      firstMove: text(repair.firstMove),
      cannotDo: text(repair.cannotDo),
    },
    privateDelights: strings(model.privateDelights).slice(0, 5),
    unproductiveWant: text(model.unproductiveWant),
    dimensionBaselines,
    genreDetails: object(model.genreDetails),
  };
}

export function normalizeIdentityIntrinsic(raw) {
  const intrinsic = object(raw);
  const gender = normalizeGender(intrinsic.gender);
  const genderLabel = text(intrinsic.genderLabel);
  return {
    gender,
    ...(genderLabel ? { genderLabel } : {}),
    species: text(intrinsic.species, 'human'),
    form: text(intrinsic.form, 'humanoid'),
    ageBand: text(intrinsic.ageBand, 'unknown'),
    birthOrder: text(intrinsic.birthOrder, 'not_applicable'),
    role: text(intrinsic.role, '조연'),
    coreAppearance: strings(intrinsic.coreAppearance),
    addressing: {
      acceptedPronouns: strings(object(intrinsic.addressing).acceptedPronouns),
      acceptedGenderedTerms: strings(object(intrinsic.addressing).acceptedGenderedTerms),
      forbiddenGenderedTerms: strings(object(intrinsic.addressing).forbiddenGenderedTerms),
    },
  };
}

export function validateCharacterDesign(character, { strict = false } = {}) {
  const violations = [];
  const intrinsic = object(character?.intrinsic);
  const model = object(character?.dramaticModel);
  if (!GENDER_VALUES.has(intrinsic.gender)) violations.push('IDENTITY_GENDER_INVALID');
  if (['custom', 'not_applicable'].includes(intrinsic.gender) && !text(intrinsic.genderLabel)) violations.push('IDENTITY_GENDER_LABEL_REQUIRED');
  if (!text(intrinsic.species)) violations.push('IDENTITY_SPECIES_REQUIRED');
  if (!text(character?.contradiction)) violations.push('DRAMATIC_CONTRADICTION_REQUIRED');
  if (strict && strings(model.valueOrder).length < 3) violations.push('DRAMATIC_VALUE_ORDER_THIN');
  if (strict && (model.behaviorTraits?.length ?? 0) < 2) violations.push('DRAMATIC_BEHAVIOR_TRAITS_THIN');
  if (strict && strings(model.perception?.seesFirst).length === 0) violations.push('DRAMATIC_PERCEPTION_SEES_EMPTY');
  if (strict && strings(model.perception?.missesFirst).length === 0) violations.push('DRAMATIC_PERCEPTION_MISSES_EMPTY');
  if (strict && !text(model.defense?.underPressure)) violations.push('DRAMATIC_DEFENSE_EMPTY');
  if (strict && !text(model.repair?.firstMove)) violations.push('DRAMATIC_REPAIR_EMPTY');
  if (strict && Object.keys(object(model.dimensionBaselines)).length < 2) violations.push('DRAMATIC_DIMENSIONS_THIN');
  return violations;
}

export function normalizeSalienceProfile(raw, characters = []) {
  const profile = object(raw);
  const supplied = Array.isArray(profile.dimensions) ? profile.dimensions : [];
  const fallbackIds = [...new Set(characters.flatMap((character) =>
    Object.keys(object(character?.dramaticModel?.dimensionBaselines))))];
  const source = supplied.length ? supplied : fallbackIds.map((id) => ({
    id, label: id, narrativeReason: '이 작품에서 반복 선택을 바꾸는 인물 축',
    positiveEvidence: ['비용을 감수한 선택으로 기존 편향과 다르게 행동한다'],
    negativeEvidence: ['압박 속에서 기존 편향을 강화한다'],
    nonEvidence: ['독백이나 해설만으로 선언한다'], saturationRisk: '모든 변화를 이 축 하나로 설명한다',
  }));
  const dimensions = source.flatMap((item) => {
    const dimension = object(item);
    const id = text(dimension.id).replace(/[^A-Za-z0-9_-]/g, '_');
    if (!id) return [];
    return [{
      id, label: text(dimension.label, id), narrativeReason: text(dimension.narrativeReason),
      positiveEvidence: strings(dimension.positiveEvidence), negativeEvidence: strings(dimension.negativeEvidence),
      nonEvidence: strings(dimension.nonEvidence), saturationRisk: text(dimension.saturationRisk), range: [0, 4],
    }];
  }).slice(0, 12);
  return { dimensions };
}

export function validateSalienceProfile(profile, { strict = false } = {}) {
  const dimensions = Array.isArray(profile?.dimensions) ? profile.dimensions : [];
  const violations = [];
  if (strict && dimensions.length < 2) violations.push('SALIENCE_DIMENSIONS_THIN');
  for (const dimension of dimensions) {
    if (!text(dimension.narrativeReason)) violations.push(`SALIENCE_REASON_EMPTY:${dimension.id}`);
    if (strict && strings(dimension.positiveEvidence).length === 0) violations.push(`SALIENCE_POSITIVE_EVIDENCE_EMPTY:${dimension.id}`);
    if (strict && strings(dimension.nonEvidence).length === 0) violations.push(`SALIENCE_NON_EVIDENCE_EMPTY:${dimension.id}`);
  }
  return violations;
}
