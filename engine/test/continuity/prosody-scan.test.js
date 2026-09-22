/**
 * prosody-scan — Arc Flow Stage A (EPIC #191).
 *
 * 4-축 baseline 측정. snapshot 대신 monotonic 가설로 검증 — 평면 prose < 다양 prose.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { runProsodyScan } from '../../src/continuity/prosody-scan.js';
/** prosody-scan.js 의 KOREAN_SIMPSON_CEILING 과 같은 값 — 아래 재척도 가드가 옛 눈금의
 *  값을 역산하는 데만 쓴다(모듈이 export 하지 않는 내부 상수라 여기서 다시 적는다). */
const KOREAN_SIMPSON_CEILING = 0.3;
describe('runProsodyScan', () => {
    it('returns a 0-100 score with 4-축 breakdown + sample stats', () => {
        const result = runProsodyScan('첫 문장이다. 두 번째 문장이다.');
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
        expect(result.breakdown).toHaveProperty('sentenceLengthVariance');
        expect(result.breakdown).toHaveProperty('endingDiversity');
        expect(result.breakdown).toHaveProperty('endingClusterPenalty');
        expect(result.breakdown).toHaveProperty('nounVerbBalance');
        expect(result.sample.sentenceCount).toBe(2);
        expect(result.sample.charCount).toBe(18);
    });
    it('penalizes mono-ending prose (all "~다") via endingDiversity', () => {
        const monotone = '비가 내린다. 바람이 분다. 새가 운다. 강이 흐른다. 산이 솟는다.';
        const varied = '비가 내린다. 바람이 부네요. 새가 우는구나. 강이 흐르지. 산이 솟았다. 길이 길어졌어.';
        const a = runProsodyScan(monotone);
        const b = runProsodyScan(varied);
        expect(b.breakdown.endingDiversity).toBeGreaterThan(a.breakdown.endingDiversity);
    });
    it('penalizes consecutive same-ending clusters', () => {
        const clustered = '왔다. 갔다. 봤다. 했다. 됐다.';
        const broken = '왔어. 갔지. 봤네. 했나. 됐다.';
        expect(runProsodyScan(broken).breakdown.endingClusterPenalty).toBeGreaterThan(runProsodyScan(clustered).breakdown.endingClusterPenalty);
    });
    it('penalizes uniform sentence length (low variance)', () => {
        // 5문장 모두 약 10자 — variance 낮음.
        const uniform = '하늘이 푸르다. 바다도 푸르다. 풀도 푸르다. 산도 푸르다. 옷도 푸르다.';
        // 길이 분산 큰 prose.
        const varied = '비. 어제 저녁 하늘이 검게 물들었다. 그리고 갑자기 천둥이 쳤다, 무서웠다. 끝.';
        const a = runProsodyScan(uniform);
        const b = runProsodyScan(varied);
        expect(b.breakdown.sentenceLengthVariance).toBeGreaterThan(a.breakdown.sentenceLengthVariance);
    });
    it('handles single-sentence prose without throwing', () => {
        const result = runProsodyScan('단 한 문장만 있다.');
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.sample.sentenceCount).toBe(1);
    });
    it('handles empty prose gracefully', () => {
        const result = runProsodyScan('');
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.sample.sentenceCount).toBe(0);
        expect(result.sample.charCount).toBe(0);
    });
    // -----------------------------------------------------------------------
    // 한국어 재캘리브레이션 (QA-Z4-04-E1 / #253)
    //
    // 두 종결어미 축의 눈금이 영어 산문을 전제하고 있어서, 실제로 생성된 한국어
    // 산문 7 편이 34-41 점에 갇혔다 — 엔진 기본값 50 조차 0/7. 아래 가드는 새
    // 눈금의 **곡선 자체**를 고정한다. 상수만 슬쩍 옮기면 전부 실패한다.
    //
    // 실측 대역: 연속 동일 어미 비율 78.4-88.9%, Simpson 0.11-0.24.
    // -----------------------------------------------------------------------
    /** 지정한 "연속 동일 어미 비율"을 정확히 갖는 문장열을 만든다. */
    const proseWithClusterRatio = (sentenceCount, ratio) => {
        // 이웃 쌍 (n-1) 개 중 정확히 round(ratio*(n-1)) 쌍이 같은 어미가 되게 배치한다:
        // 앞쪽을 전부 `~다`로 채우면 그 구간의 이웃은 전부 동일 어미가 된다.
        const pairs = sentenceCount - 1;
        const same = Math.round(ratio * pairs);
        const endings = [];
        for (let i = 0; i < sentenceCount; i++) {
            // 앞 (same + 1) 문장은 전부 `다`, 그 뒤는 매번 다른 어미로 끊는다.
            endings.push(i <= same ? '다' : ['네', '지', '까', '어', '군'][i % 5]);
        }
        return endings.map((e, i) => `그는 ${'아'.repeat((i % 7) + 2)}았${e}.`).join(' ');
    };
    it('cluster penalty: the observed Korean band (78-89%) now spans a real range, not a flat 0', () => {
        // 이전 식은 `100 - ratio*200` 이라 ratio 0.5 에서 이미 0 점이었다. 관측치가
        // 전부 그 경계의 1.6-1.8 배라 **0 이 아닌 값이 나올 수가 없었다** — 4 축 중
        // 한 축이 상수 0 이면 그 축은 측정을 하지 않는 것과 같다.
        const best = runProsodyScan(proseWithClusterRatio(100, 0.784)).breakdown.endingClusterPenalty;
        const worst = runProsodyScan(proseWithClusterRatio(100, 0.889)).breakdown.endingClusterPenalty;
        expect(best).toBeGreaterThan(0);
        expect(worst).toBeGreaterThan(0);
        expect(best).toBeGreaterThan(worst);
        // 대역이 눌리지 않았는지 — 두 끝의 차이가 30 점 이상이어야 변별이 된다.
        expect(best - worst).toBeGreaterThanOrEqual(30);
    });
    it('cluster penalty: pins the calibration boundaries (0.75 → 100, 0.95 → 0)', () => {
        // 경계 자체를 고정한다. FLOOR/CEILING 을 옮기면 여기서 잡힌다.
        expect(runProsodyScan(proseWithClusterRatio(100, 0.7)).breakdown.endingClusterPenalty).toBe(100);
        expect(runProsodyScan(proseWithClusterRatio(100, 0.99)).breakdown.endingClusterPenalty).toBe(0);
    });
    it('ending diversity: the Korean-typical band is rescaled onto the usable range', () => {
        // 최빈 어미가 대부분을 먹는 것은 한국어 평서형의 문법이지 산문의 결함이 아니다.
        // 실측 7 편의 Simpson 은 0.11-0.24 였고, 이전 눈금(`simpson*100`)에서는 그것이
        // 그대로 11-24 점 — 척도의 아래 1/4 에 뭉쳤다.
        //
        // 임계는 CEILING(0.30) 으로 나눈 결과에서 나온다. 옛 눈금이 이 표본에 주는
        // 값보다 확실히 위여야 가드가 의미가 있다 — `> 24` 로는 옛 식도 통과한다.
        const rescaled = runProsodyScan(proseWithClusterRatio(120, 0.85)).breakdown.endingDiversity;
        const rawSimpsonScore = Math.round(rescaled * KOREAN_SIMPSON_CEILING);
        expect(rawSimpsonScore).toBeLessThan(35); // 옛 눈금이 줬을 값
        expect(rescaled).toBeGreaterThanOrEqual(80); // 새 눈금
    });
    it('ending diversity: clamps at 100 — a ceiling, not an unbounded rescale', () => {
        // 어미가 완전히 분산된 (Simpson > 0.30) 산문도 100 을 넘지 않는다.
        const varied = ['다', '네', '지', '까', '어', '군', '요', '나', '구나', '데']
            .map((e, i) => `그는 ${'아'.repeat(i + 2)}았${e}.`)
            .join(' ');
        expect(runProsodyScan(varied).breakdown.endingDiversity).toBe(100);
    });
    it('snapshot: known sample produces stable score range', () => {
        // 한국어 web-novel 표본 — 점수가 reasonable 범위 안 들어가는지 sanity check.
        const sample = '비가 내리는 거리를 그는 걸었다. 우산도 없이. 머리카락에서 물이 뚝뚝 떨어졌고, 발걸음은 느렸지만 멈추지 않았다. 멀리서 불빛이 보였다. 그는 다시 한 번 그 약속을 떠올렸다.';
        const result = runProsodyScan(sample);
        expect(result.score).toBeGreaterThan(30);
        expect(result.score).toBeLessThan(100);
    });
});
