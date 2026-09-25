/**
 * Dialogue-marker variety scan — counts speech-tag verbs in prose,
 * flags when "말했다" dominates the distribution.
 *
 * Threshold: if `'말했다'` count / total speech-tag count > 0.8 →
 * SOFT FLAG `DIALOGUE_TAG_MONOTONY`. Helps writers vary speech
 * attribution (외쳤다, 속삭였다, 중얼거렸다, …).
 */
const MONOTONY_RATIO = 0.8;
const MIN_TAGS_FOR_SCAN = 5;
/** Korean speech-tag verbs in narrative past tense. Add liberally. */
export const KO_SPEECH_TAGS = [
    '말했다', '대답했다', '답했다', '물었다', '되물었다', '외쳤다', '소리쳤다',
    '속삭였다', '중얼거렸다', '읊조렸다', '내뱉었다', '뱉었다', '쏘아붙였다',
    '쏘아댔다', '받아쳤다', '되받아쳤다', '되받았다', '비웃었다', '웃었다',
    '비아냥거렸다', '으르렁거렸다', '으름장을 놓았다', '협박했다', '경고했다',
    '타일렀다', '달랬다', '꾸짖었다', '나무랐다', '꾸중했다', '호통쳤다',
    '신음했다', '한탄했다', '탄식했다', '한숨지었다',
    '울먹였다', '흐느꼈다', '훌쩍였다', '울었다', '웅얼거렸다', '얼버무렸다',
    '말끝을 흐렸다', '입을 열었다', '입을 다물었다', '말꼬리를 잡았다',
    '말을 잘랐다', '말을 끊었다', '말을 이었다', '덧붙였다', '거듭 말했다',
    '단언했다', '주장했다', '강조했다', '인정했다', '시인했다', '부정했다',
    '항변했다', '변명했다', '사과했다', '용서를 빌었다', '간청했다', '애원했다',
    '명령했다', '지시했다', '권유했다', '제안했다', '청했다', '부탁했다',
    '맞장구쳤다', '맞받았다', '응수했다', '대꾸했다', '응대했다', '읊었다',
    '내질렀다', '뇌까렸다', '뇌었다', '꼬집어 말했다',
];
import { skipKoLexical } from './checker-registry.js';
export function scanDialogueMarkerVariety(input) {
    const skipped = skipKoLexical(input, 'scanDialogueMarkerVariety');
    if (skipped)
        return skipped;
    const { prose, chapterNumber } = input;
    if (!prose || prose.trim().length === 0) {
        return {
            violations: [],
            stats: { totalTags: 0, saidCount: 0, saidRatio: 0 },
        };
    }
    let total = 0;
    let said = 0;
    for (const tag of KO_SPEECH_TAGS) {
        const count = countOccurrences(prose, tag);
        if (count === 0)
            continue;
        total += count;
        if (tag === '말했다')
            said += count;
    }
    if (total < MIN_TAGS_FOR_SCAN) {
        return {
            violations: [],
            stats: { totalTags: total, saidCount: said, saidRatio: 0 },
        };
    }
    const ratio = said / total;
    const violations = [];
    if (ratio > MONOTONY_RATIO) {
        violations.push({
            severity: 'soft',
            code: 'DIALOGUE_TAG_MONOTONY',
            chapterNumber,
            message: `발화 동사 단조 — '말했다' ${said}/${total} (${(ratio * 100).toFixed(0)}%) > ${MONOTONY_RATIO * 100}%`,
        });
    }
    return {
        violations,
        stats: { totalTags: total, saidCount: said, saidRatio: ratio },
    };
}
function countOccurrences(prose, term) {
    if (!term)
        return 0;
    let count = 0;
    let idx = 0;
    while ((idx = prose.indexOf(term, idx)) !== -1) {
        count++;
        idx += term.length;
    }
    return count;
}
