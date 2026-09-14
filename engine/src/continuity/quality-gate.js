/**
 * ADR-0009 (issue #220) — Chapter Quality Gate.
 *
 * commit phase 끝에서 sanitize 직후 호출 — prosody + coherence 점수가 작가
 * threshold 미만이면 QualityGateFailure throw → bounded revise loop 가
 * ContinuityFailure 와 동일 path 로 retry.
 *
 * threshold = Work.metadata.qualityThreshold (host 가 prosody/coherence 전달)
 * 또는 default { prosody: 50, coherence: 60 }.
 *
 * Pure fn — DB 없음. host 가 threshold load 해서 전달.
 */
/**
 * 문장 리듬(prosody) 강도 3 단계 — QA-Z4-04-E1 / #253.
 *
 * 사용자에게는 **숫자를 보여주지 않는다**(`voice-tone.md` §4-4). 0-100 슬라이더였는데
 * 실 산문 7 편의 관측 폭이 7 점이라 어포던스가 거짓말이었다. 그 눈금은 한국어 기준으로
 * 다시 매겼지만(`prosody-scan.js`), 관측 폭이 유한하다는 사실은 그대로다 — 숫자를 그대로
 * 노출하면 사용자가 의미 없는 정밀도를 고르게 된다.
 *
 * **계약 형태는 안 바꾼다.** `qualityThreshold` 는 여전히 `{prosody, coherence}` 숫자다.
 * 이름값은 **표시 층의 선택**이고, 여기 세 숫자는 그 이름이 가리키는 값이다. enum 을
 * 와이어 포맷으로 올리면 (a) Accepted 계약의 요청 shape 이 깨지고, (b) 4 번째 단계가
 * 생기는 날 그것도 계약 변경이 되며, (c) 이미 숫자로 저장된 잡을 마이그레이션해야 한다.
 * 이름이 눈금보다 오래 사는 이득은 매핑만으로 충분히 얻는다.
 *
 * 재캘리브레이션된 척도에서 실 산문 7 편(48/55/57/61/61/62/76)의 통과 수:
 *   느슨 45 → 7/7 · 보통 55 → 6/7 · 엄격 70 → 1/7
 *
 * ⚠ 표본이 7 편이라 특히 **엄격 대역이 성기다** — 63 부터 76 사이 어디를 잡아도 1/7 이라
 * 70 은 그 구간의 대표값일 뿐 실측이 고른 지점이 아니다. 표본이 늘면 다시 본다.
 */
export const PROSODY_LEVELS = Object.freeze({
    loose: 45,
    normal: 55,
    strict: 70,
});
/** 이름 → 숫자. 모르는 이름은 null (호출자가 400 으로 돌린다 — 조용히 기본값으로 떨어지지 않는다). */
export function prosodyThresholdForLevel(level) {
    return Object.hasOwn(PROSODY_LEVELS, level) ? PROSODY_LEVELS[level] : null;
}
export const DEFAULT_QUALITY_THRESHOLD = {
    // 보통(55) — #253 Q3 "기본값은 재캘리브레이션 후 재산정". 이전 값 50 은 재캘리브레이션
    // 이전 척도의 것이고, 그 척도에서 실 산문 7 편의 통과는 0/7 이었다.
    prosody: PROSODY_LEVELS.normal,
    // coherence 는 #253 범위 밖이다 — 이 티켓은 운율 축만 다뤘고, coherence 척도의
    // 도달 가능성은 아직 실측하지 않았다. 값을 건드리지 않는다.
    coherence: 60,
};
export function evaluateChapterQuality(input) {
    const threshold = {
        prosody: input.threshold?.prosody ?? DEFAULT_QUALITY_THRESHOLD.prosody,
        coherence: input.threshold?.coherence === null
            ? null
            : (input.threshold?.coherence ?? DEFAULT_QUALITY_THRESHOLD.coherence),
    };
    const fails = [];
    if (input.prosodyScore < threshold.prosody) {
        fails.push({ axis: 'prosody', score: input.prosodyScore, threshold: threshold.prosody });
    }
    if (threshold.coherence !== null &&
        input.coherenceScore !== null &&
        input.coherenceScore < threshold.coherence) {
        fails.push({
            axis: 'coherence',
            score: input.coherenceScore,
            threshold: threshold.coherence,
        });
    }
    return { pass: fails.length === 0, fails, threshold };
}
/**
 * QualityGateFailure — revise loop 가 ContinuityFailure 와 동일하게 처리.
 * violations[] 는 host 가 cost-logger / ManifestParseError 와 별도로 record.
 */
export class QualityGateFailure extends Error {
    chapterNumber;
    fails;
    violations;
    constructor(chapterNumber, fails, violations = []) {
        super(`QualityGate fail chapter=${chapterNumber}: ` +
            fails.map((f) => `${f.axis}=${f.score}/${f.threshold}`).join(', '));
        this.chapterNumber = chapterNumber;
        this.fails = fails;
        this.violations = violations;
        this.name = 'QualityGateFailure';
    }
}
/**
 * Map QualityFail → ContinuityViolation 로 revise prompt 에 잘 어울리는 형태.
 * revise.ts 가 violations 받아 prompt fragment 생성하므로 그쪽 contract 와
 * 호환되는 shape.
 */
export function failsToViolations(chapterNumber, fails) {
    return fails.map((f) => ({
        severity: 'soft',
        code: f.axis === 'prosody'
            ? 'QUALITY_GATE_PROSODY'
            : 'QUALITY_GATE_COHERENCE',
        chapterNumber,
        message: `${f.axis} 점수 ${f.score} (threshold ${f.threshold}) — 미만`,
    }));
}
