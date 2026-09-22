import { describe, expect, it } from '../_support/vitest-shim.mjs';
import {
  normalizeDramaticModel, normalizeIdentityIntrinsic, validateCharacterDesign,
} from '../../src/continuity/character-design.js';

describe('CharacterDesign', () => {
  it('distinguishes missing, non-applicable, and custom gender identities', () => {
    expect(normalizeIdentityIntrinsic({}).gender).toBe('unknown');
    const monster = normalizeIdentityIntrinsic({ gender: 'not_applicable', genderLabel: '분열로 번식', species: 'slime', form: 'amorphous' });
    expect(monster.gender).toBe('not_applicable');
    expect(monster.genderLabel).toBe('분열로 번식');
    expect(validateCharacterDesign({ intrinsic: monster, contradiction: '합쳐지고 싶지만 자아를 잃기 싫다', dramaticModel: {} })).toEqual([]);
    expect(validateCharacterDesign({ intrinsic: normalizeIdentityIntrinsic({ gender: 'custom' }), contradiction: '모순', dramaticModel: {} })).toContain('IDENTITY_GENDER_LABEL_REQUIRED');
  });

  it('normalizes story-specific dimensions and rejects a thin dramatic model in strict mode', () => {
    const dramaticModel = normalizeDramaticModel({
      valueOrder: ['팀 승리', '출전', '체면'],
      behaviorTraits: [
        { trigger: '벤치 지시가 틀려 보일 때', actionBias: '혼자 다른 신호를 보낸다', benefit: '즉시 공간을 연다', cost: '코칭 신뢰를 깎는다' },
        { trigger: '동료가 실수할 때', actionBias: '실수 원인을 대신 떠안는다', benefit: '동료를 보호한다', cost: '자기 출전 근거를 잃는다' },
      ],
      perception: { seesFirst: ['패스 경로'], missesFirst: ['동료의 공포'] },
      defense: { public: '수치로 설명한다', underPressure: '선택지를 줄인다' },
      repair: { firstMove: '콜 권한을 돌려준다', cannotDo: '억울함을 말한다' },
      dimensionBaselines: { coaching_receptivity: 2, team_trust: 1 },
      genreDetails: { dominantFoot: 'left' },
    });
    const character = { intrinsic: normalizeIdentityIntrinsic({ gender: 'male' }), contradiction: '읽을수록 통제하려 든다', dramaticModel };
    expect(validateCharacterDesign(character, { strict: true })).toEqual([]);
    expect(validateCharacterDesign({ ...character, dramaticModel: normalizeDramaticModel({}) }, { strict: true })).toContain('DRAMATIC_VALUE_ORDER_THIN');
  });
});
