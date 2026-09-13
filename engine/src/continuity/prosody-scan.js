/**
 * prosody-scan — Arc Flow Stage A (EPIC #191 / Stage A #192).
 *
 * 좌담 통찰 #09 (운율). LLM-생성 한국어 prose 의 운율 평면화를 측정.
 * Stage A 는 **baseline 측정만** — threshold 미달 시 retry 안 함.
 * runAuxScans 가 점수를 telemetry log 로만 출력. Stage B+ 가 임계치 + revise 결정.
 *
 * 측정 4-축 (각 0-100, 종합 평균):
 *
 *   1. sentenceLengthVariance — 문장 길이 분산도 (높을수록 다양)
 *      σ / mean → 0-1 → 0-100 매핑. mean 0 이면 0 점.
 *
 *   2. endingDiversity — 종결어미 다양성 (높을수록 다양)
 *      문장 마지막 1-2 음절 패턴 (~다 / ~네 / ~지 / ~까 / ~어 / ~요 등)
 *      Simpson diversity: 1 - Σ pᵢ². 0-1 → 0-100.
 *
 *   3. endingClusterPenalty — 같은 종결어미 연속 클러스터 패널티 (높을수록 좋음)
 *      연속 같은 어미 비율의 역수. 0-1 → 0-100.
 *
 *   4. nounVerbBalance — 체언/용언 균형 (50 점 만점, 한쪽 쏠림 패널티)
 *      체언 비율이 0.5 에 가까울수록 100. 0 또는 1 이면 0.
 *
 * 정밀 형태소 분석 (KOMORAN / Mecab) 없이 휴리스틱 — baseline 측정엔 충분.
 *
 * ---------------------------------------------------------------------------
 * 한국어 재캘리브레이션 (QA-Z4-04-E1 / #253, 2026-08-07)
 * ---------------------------------------------------------------------------
 * 종결어미 2 축(가중치 50%)은 **영어 산문을 전제한 눈금**이었다. 어말이 분산되는
 * 언어에서는 맞지만, 한국어 평서형은 구조적으로 `~다` 단일 어미다. 그래서 실제로
 * 생성된 산문 7 편의 총점이 **34-41 점에 갇혔다** — 폭 7 점. 엔진 기본값 50 조차
 * 0/7 이었다. 0-100 슬라이더를 주면서 41 위가 전부 확정 실패였다는 뜻이다.
 *
 * 임계값이 엄격했던 게 아니라 **척도가 도달 불가능**했다. 아래 세 상수가 두 축의
 * 눈금을 실측 대역 위로 옮긴다. 게이트 자체와 4 축 구성, 평균 방식은 그대로다.
 *
 * ⚠ **근거 표본이 7 편뿐이다.** 좁은 표본 위에서 눈금을 정했다. 표본이 늘면 다시
 * 봐야 하고, 그때 UI 는 안 깨진다 — 사용자에게 보이는 것은 숫자가 아니라
 * 느슨/보통/엄격 세 이름이기 때문이다(`voice-tone.md` §4-4, quality-gate.js
 * PROSODY_LEVELS). 그게 이름값을 고른 실질 이유다.
 *
 * 재캘리브레이션 후 그 7 편의 실측 분포: 48 / 55 / 57 / 61 / 61 / 62 / 76 (폭 7 -> 28).
 * 회귀 가드는 그 총점 목록이 아니라 **곡선 자체**를 고정한다 — 아래 상수를 슬쩍
 * 옮기면 test/continuity/prosody-scan.test.js 가 실패한다. 총점 목록을 그대로 박으면
 * 다른 축(문장 길이 분산 등)의 변경까지 같이 잡혀 가드가 무엇을 지키는지 흐려진다.
 */
/**
 * `endingClusterPenalty` 의 만점/영점 경계 — 연속 동일 종결어미 비율.
 * 실측 대역이 0.784-0.889 이라 FLOOR 를 그 아래(0.75), CEILING 을 그 위(0.95)에
 * 둔다. 0.95 는 "거의 모든 문장이 앞 문장과 같은 어미" — 단조로움의 실질 상한이다.
 */
const KOREAN_CLUSTER_RATIO_FLOOR = 0.75;
const KOREAN_CLUSTER_RATIO_CEILING = 0.95;
/**
 * `endingDiversity` 의 100 점 기준 — Simpson 지수 상한.
 * 최빈 어미가 86.7% 를 먹는 실측 최선이 Simpson 0.24 였다. 0.30 은 그보다 조금
 * 위 — 한국어에서 현실적으로 도달 가능한 다양성의 천장이다. 그 이상은 clamp 된다.
 */
const KOREAN_SIMPSON_CEILING = 0.3;
/** 문장 분할 휴리스틱 — 종결부호 + 줄바꿈. 따옴표 내부도 분리 (대화 단위). */
function splitSentences(prose) {
    return prose
        .split(/(?<=[.!?。…])\s+|\n+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
/**
 * 한국어 종결어미 추출 — 문장 마지막 1 음절 normalize. 따옴표/구두점 제거 후
 * 1) 다음절 polite/formal 어미 (습니다/네요/지요/...) 가 우선 매칭되면 그걸 반환.
 * 2) 그 외는 마지막 1글자 — 동사 어간 ('왔'/'갔'/'봤') 의 'cluster' 가 종결어미
 *    ('다'/'어'/'지') 의 cluster 와 혼동되지 않도록 마지막 1글자만 본다.
 */
function extractEnding(sentence) {
    let end = sentence.length;
    while (end > 0 && /["'"".!?…。\s]/u.test(sentence[end - 1]))
        end--;
    const stripped = sentence.slice(0, end);
    if (stripped.length === 0)
        return '∅';
    const known = ['습니다', '니다', '어요', '아요', '해요', '에요', '예요', '네요', '지요'];
    for (const k of known) {
        if (stripped.endsWith(k))
            return k;
    }
    return stripped.slice(-1);
}
function scoreSentenceLengthVariance(sentences) {
    if (sentences.length < 2)
        return 0;
    const lengths = sentences.map((s) => s.length);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    if (mean === 0)
        return 0;
    const variance = lengths.reduce((acc, l) => acc + (l - mean) ** 2, 0) / lengths.length;
    const stddev = Math.sqrt(variance);
    // CV (coefficient of variation) 를 0-1 로 클램프. 한국어 prose CV 0.6 이상 = 다양.
    const cv = stddev / mean;
    return Math.min(100, Math.round((cv / 0.6) * 100));
}
function scoreEndingDiversity(sentences) {
    if (sentences.length === 0)
        return 0;
    const endings = sentences.map(extractEnding);
    const counts = new Map();
    for (const e of endings) {
        counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    const n = endings.length;
    // Simpson 1 - Σ pᵢ². 0-1.
    let sumSq = 0;
    for (const c of counts.values()) {
        const p = c / n;
        sumSq += p * p;
    }
    const simpson = 1 - sumSq;
    // 한국어 기준선으로 재척도 (QA-Z4-04-E1 / #253). 실측 산문 7편의 Simpson 은
    // 0.11-0.24 였다 — 최빈 어미(전부 `다`)가 86.7-94.5% 를 먹기 때문이다.
    // `simpson * 100` 을 그대로 쓰면 그 7편이 11-24 점이 되어 척도의 아래 1/4 에
    // 뭉친다. KOREAN_SIMPSON_CEILING 은 그 관측 상한을 100 점으로 놓아 실제로
    // 일어나는 범위 안에서 점수가 갈리게 한다.
    return Math.round(Math.min(100, (simpson / KOREAN_SIMPSON_CEILING) * 100));
}
function scoreEndingClusterPenalty(sentences) {
    if (sentences.length < 2)
        return 100;
    const endings = sentences.map(extractEnding);
    let clusterRuns = 0;
    for (let i = 1; i < endings.length; i++) {
        if (endings[i] === endings[i - 1])
            clusterRuns++;
    }
    const ratio = clusterRuns / (endings.length - 1);
    // 한국어 기준선으로 재척도 (QA-Z4-04-E1 / #253). 원래 식은 `100 - ratio*200`
    // 이라 ratio 0.5 에서 이미 0 점이었다. 실측 산문 7편의 ratio 는 78.4-88.9%
    // — 그 경계의 1.6-1.8 배다. 즉 0 이 아닌 값이 나올 수가 없었다.
    // 아래 두 상수는 그 관측 대역을 감싼다: FLOOR(0.75) 이하면 만점, CEILING(0.95)
    // 이상이면 0. 실측 7 편이 31-83 점으로 갈린다 (이전에는 전부 0).
    if (ratio <= KOREAN_CLUSTER_RATIO_FLOOR)
        return 100;
    if (ratio >= KOREAN_CLUSTER_RATIO_CEILING)
        return 0;
    const span = KOREAN_CLUSTER_RATIO_CEILING - KOREAN_CLUSTER_RATIO_FLOOR;
    return Math.round(((KOREAN_CLUSTER_RATIO_CEILING - ratio) / span) * 100);
}
/**
 * 한국어 체언/용언 간이 추정 — 정밀 형태소 분석 없이.
 * 체언 휴리스틱: 조사 ('은/는/이/가/을/를/의/도/만') 직전 단어 카운트.
 * 용언 휴리스틱: 'X다' / 'X어' / 'X해' / 'X았' / 'X었' 패턴.
 * 한쪽 쏠림 패널티.
 */
function scoreNounVerbBalance(prose) {
    if (prose.length < 50)
        return 50;
    // 한국어는 ASCII word-boundary (\b) 가 한글 사이에서 안 먹음 → 제거.
    // 휴리스틱 baseline 이라 false-positive 허용 (조사/어미 외 단순 음절 매칭 가능).
    // The old greedy match counted at most once per contiguous Hangul run.
    // Tokenize first so a run without a marker is never retried at each offset.
    let nounMarkers = 0;
    let verbMarkers = 0;
    for (const [word] of prose.matchAll(/[가-힣]+/gu)) {
        const suffix = word.slice(1);
        if (/[은는이가을를의도만]/u.test(suffix))
            nounMarkers++;
        if (/[다어해았었겠]/u.test(suffix))
            verbMarkers++;
    }
    const total = nounMarkers + verbMarkers;
    if (total === 0)
        return 50;
    const nounRatio = nounMarkers / total;
    // 0.5 에서 멀어질수록 패널티. abs(r-0.5) ∈ [0, 0.5] → 100 → 0.
    const deviation = Math.abs(nounRatio - 0.5);
    return Math.round(Math.max(0, 100 - deviation * 200));
}
import { skipKoLexical } from './checker-registry.js';
export function runProsodyScan(prose, options = {}) {
    const skipped = skipKoLexical(options, 'runProsodyScan');
    if (skipped)
        return skipped;
    const sentences = splitSentences(prose);
    const breakdown = {
        sentenceLengthVariance: scoreSentenceLengthVariance(sentences),
        endingDiversity: scoreEndingDiversity(sentences),
        endingClusterPenalty: scoreEndingClusterPenalty(sentences),
        nounVerbBalance: scoreNounVerbBalance(prose),
    };
    const score = Math.round((breakdown.sentenceLengthVariance +
        breakdown.endingDiversity +
        breakdown.endingClusterPenalty +
        breakdown.nounVerbBalance) /
        4);
    return {
        score,
        breakdown,
        sample: {
            sentenceCount: sentences.length,
            charCount: prose.length,
        },
    };
}
