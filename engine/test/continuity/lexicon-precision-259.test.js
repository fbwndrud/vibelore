import { describe, it, expect } from '../_support/vitest-shim.mjs';
import {
  DefaultSensitiveLexicon,
  scanSensitive,
  KO_SENSITIVE_SEED,
} from '../../src/continuity/sensitive-lexicon.js';

// issue 259 — 정밀도 회귀 픽스처.
//
// 발단: 유해 표현이 전혀 없는 한국어 문장 12개 중 10개가 사전에 걸렸고, 그중 셋은
// 커뮤니티 공개작의 에피소드 본문 저장에서 실제로 409 EPISODE_BODY_MODERATION_FAILED를
// 냈다. 원인은 맨 부분문자열 매칭(`prose.includes(term)`)이다 — 사전 89개 중 공백 없는
// 2음절 이하 토큰이 37개인데 문맥 가드는 '보지' 하나뿐이었다.
//
// 오너 결정(2026-08-08) Q1 = ⓐ: notFollowedBy 문맥 가드를 충돌 항목에 적용한다.
// 이 파일이 그 결정의 회귀 가드다. 두 방향을 **모두** 고정한다:
//   1) 오탐이 다시 생기지 않는다 (가드가 지워지면 red)
//   2) 미탐이 생기지 않는다 (가드가 너무 넓어지면 red)
// 미탐 쪽이 더 위험한 방향이라 케이스를 더 많이 둔다.

const lex = new DefaultSensitiveLexicon();
const scan = (prose, mode) =>
  scanSensitive({ prose, chapterNumber: 1, lexicon: lex, mode }).violations;
/** 위반이 가리키는 사전 용어만 뽑는다 (메시지 형식: 검열 사전 '<term>' (<category>) — mode=<m>). */
const terms = (prose, mode) =>
  scan(prose, mode).map((v) => v.message.match(/'([^']+)'/)?.[1]);

// ── 1. 기계적 오탐 — 문맥 가드가 해소한 것 ────────────────────────────────────
// 전부 유해 표현이 0인 평범한 산문이다. youth·adult 양쪽에서 깨끗해야 한다.
const MECHANICAL_FALSE_POSITIVES = [
  ['밤새 자지 않고 성문을 지켰다.', '자다 + 부정 연결어미 vs 자지'],
  ['방 안의 등불이 꺼져 있었다.', '불이 꺼지다 vs 꺼져'],
  ['대마도에서 온 사신이라 했다.', '지명 對馬島 vs 대마'],
  ['병신년에 벌어진 일이라 했다.', '육십갑자 丙申年 vs 병신'],
  ['말을 몰아 지랄산 능선을 넘었다.', '지명 지랄산 vs 지랄'],
  ['아이는 어머니의 손을 잡았다.', 'minor-adjacent는 두 모드 다 allow'],
  ['학생들이 마당에 모여 있었다.', 'minor-adjacent는 두 모드 다 allow'],
];

describe('issue 259 — 기계적 오탐은 문맥 가드로 해소된다', () => {
  for (const [prose, why] of MECHANICAL_FALSE_POSITIVES) {
    it(`무해: 「${prose}」 (${why})`, () => {
      expect(terms(prose, 'youth')).toEqual([]);
      expect(terms(prose, 'adult')).toEqual([]);
    });
  }
});

// ── 2. 미탐 방지 — 가드가 진짜 용법까지 삼키면 안 된다 ────────────────────────
// 여기가 더 위험한 방향이다. 가드를 넓히려는 다음 사람은 이 목록을 먼저 볼 것.
const MUST_STILL_TRIP = [
  ['꺼져!', '꺼져'],
  ['당장 꺼져라.', '꺼져'],
  ['꺼져 버려, 다시는 오지 마.', '꺼져'], // '버'를 가드에 넣으면 여기서 red가 난다
  ['이 병신년아.', '병신'],
  ['병신년이 또 왔다.', '병신'],
  ['이 병신 같은 놈.', '병신'],
  ['병신년 저리 가.', '병신'], // '년 '(공백)을 가드에 넣으면 여기서 red가 난다
  ['지랄한다 정말.', '지랄'],
  ['지랄을 떨었다.', '지랄'],
  ['대마초를 피웠다.', '대마'],
  ['대마를 밀수했다.', '대마'],
  ['자지가 보였다.', '자지'],
  ['자지를 드러냈다.', '자지'],
  ['보지가 문제였다.', '보지'], // 선행 가드(NEP-S5)의 회귀도 함께 지킨다
];

describe('issue 259 — 가드가 진짜 용법을 삼키지 않는다 (미탐 0)', () => {
  for (const [prose, term] of MUST_STILL_TRIP) {
    it(`적발: 「${prose}」 → '${term}'`, () => {
      expect(terms(prose, 'youth')).toContain(term);
    });
  }
});

// ── 3. 아직 남은 오탐 — 특성화(characterization) 테스트 ───────────────────────
// 이 다섯은 **매칭 방식 문제가 아니다.** 어절 경계로 잘라도 그대로 걸린다 —
// 사전이 "이 단어는 본질적으로 민감하다"고 주장하는 것이 틀린 경우다:
//   신음  고통의 신음까지 sexual-explicit로 본다
//   정사  政事 / 情事 동음이의 — 뒤 문맥으로 구별 불가
//   토막  나무토막·토막잠 등 일반명사
//   학살  역사 서술까지 violence-graphic로 본다
//   자해  부정문("자해할 생각이 없었다")도 걸린다
// 해소하려면 사전 항목의 **카테고리/등급을 바꿔야 하고, 그건 정책 결정**이다
// (issue 259 Q2 — 오탐/미탐 중 어느 쪽으로 기울 것인가). 그때까지 현행 동작을
// 여기에 고정해 두어, 정책이 바뀌면 이 테스트가 **의도적으로** 갱신되게 한다.
const POLICY_FALSE_POSITIVES = [
  ['그는 고통에 겨워 낮게 신음했다.', '신음'],
  ['조정의 정사를 논하는 자리였다.', '정사'],
  ['창밖으로 토막 난 구름이 흘렀다.', '토막'],
  ['임진년의 학살을 기록한 문서였다.', '학살'],
  ['그는 자해할 생각이 없었다.', '자해'],
];

describe('issue 259 — 정책 결정이 남은 오탐 (현행 동작 고정)', () => {
  for (const [prose, term] of POLICY_FALSE_POSITIVES) {
    it(`아직 걸린다: 「${prose}」 → '${term}' (Q2 대기)`, () => {
      expect(terms(prose, 'youth')).toContain(term);
    });
  }

  it('정책 잔여는 정확히 5건이다 — 줄면 Q2가 답해진 것이니 이 목록을 갱신할 것', () => {
    const stillFiring = POLICY_FALSE_POSITIVES.filter(
      ([prose]) => terms(prose, 'youth').length > 0,
    );
    expect(stillFiring.length).toBe(5);
  });
});

// ── 4. 사전 위생 — 가드 적용률을 눈에 보이게 둔다 ─────────────────────────────
describe('issue 259 — 2음절 단일 토큰의 가드 적용률', () => {
  const shortSingleTokens = KO_SENSITIVE_SEED.filter(
    (e) => !/\s/.test(e.term) && e.term.length <= 2,
  );

  it('2음절 이하 단일 토큰은 37개다 (사전이 커지면 이 수를 의식적으로 갱신할 것)', () => {
    expect(shortSingleTokens.length).toBe(37);
  });

  it('충돌이 확인된 항목에는 문맥 가드가 붙어 있다', () => {
    const guarded = new Set(
      KO_SENSITIVE_SEED.filter((e) => Array.isArray(e.notFollowedBy)).map((e) => e.term),
    );
    // issue 259에서 실측으로 오탐이 재현된 항목 + 선행 NEP-S5의 '보지'.
    for (const term of ['보지', '자지', '꺼져', '병신', '지랄', '대마']) {
      expect(guarded.has(term)).toBe(true);
    }
  });
});
