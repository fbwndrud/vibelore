/**
 * ArcContext — engine-internal Arc 컨텍스트 + 5-구간 ratio 계산.
 *
 * EPIC #191 / Stage A #192 — Arc Flow.
 *
 * Arc 는 작품-Arc 1:N 관계. chapter-write handler 가 EngineFoundation.currentArcId
 * 로 활성 Arc 를 load 한 뒤 ArcContext 를 채워 JobContext 에 주입한다. draft.ts
 * 의 prompt builder 가 이 컨텍스트를 prompt 헤더로 직렬화 — 모든 화 생성이 Arc
 * promise + 현재 위치를 의식하도록.
 *
 * Stage B+ 에서 driftDetector, next-arc-proposal, exit-echo 가 이 컨텍스트를
 * 확장한다. Stage A 는 골격만 (promise + position + estimated).
 */
import { pickByFamily } from './prompt-language.js';
/**
 * 5-구간 자동 산출 — currentChapter/estimatedEpisodes ratio.
 *
 *   ratio = (currentChapterInArc - 0.5) / max(1, estimatedEpisodes)
 *
 *   [0,     0.15)  opening
 *   [0.15,  0.45)  rising
 *   [0.45,  0.55)  midpoint
 *   [0.55,  0.85)  falling
 *   [0.85,  ∞  )   closing
 *
 * `-0.5` 는 화의 중심점 보정 — 1/1 이면 ratio=0.5 (midpoint) 가 되도록.
 * estimatedEpisodes <= 0 은 'opening' 으로 fallback (대원적으로 발생 안 함).
 */
export function arcPositionFromRatio(currentChapterInArc, estimatedEpisodes) {
    if (estimatedEpisodes <= 0)
        return 'opening';
    const ratio = (currentChapterInArc - 0.5) / estimatedEpisodes;
    if (ratio < 0.15)
        return 'opening';
    if (ratio < 0.45)
        return 'rising';
    if (ratio < 0.55)
        return 'midpoint';
    if (ratio < 0.85)
        return 'falling';
    return 'closing';
}
/** Arc 5-구간 한국어 라벨 — ko 계열 prompt 헤더용. */
export const ARC_POSITION_LABEL_KO = {
    opening: '도입 (Opening)',
    rising: '상승 (Rising)',
    midpoint: '중간점 (Midpoint)',
    falling: '하강 (Falling)',
    closing: '종결 (Closing)',
};
/**
 * 다국어 계열 라벨. 구간 키(`opening` 등)는 기계 enum 이라 번역하지 않고,
 * 사람이 읽는 라벨만 계열별로 고른다.
 */
export const ARC_POSITION_LABEL_EN = {
    opening: 'Opening',
    rising: 'Rising',
    midpoint: 'Midpoint',
    falling: 'Falling',
    closing: 'Closing',
};
/**
 * 계열별 구간 라벨. `context` 는 PromptLanguageContext / 언어 계약 / 생략 모두
 * 허용하며, 생략 시 기존 ko 라벨을 그대로 돌려준다(구형 호출 호환).
 */
export function arcPositionLabel(position, context) {
    const table = context === undefined || context === null
        ? ARC_POSITION_LABEL_KO
        : pickByFamily(context, { ko: ARC_POSITION_LABEL_KO, multilingual: ARC_POSITION_LABEL_EN });
    return table[position] ?? position;
}
