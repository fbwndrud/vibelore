/**
 * Cliffhanger detector — Korean web-novel 절단신공 trigger scan over the
 * last paragraph.
 *
 * Triggers: interrogative endings, unfinished-event markers, reversal
 * triggers. Pure deterministic lexical match — no LLM dependency.
 *
 * Arc Flow Stage A (EPIC #191) — Arc-aware lint:
 *   기존: 모든 화에 cliffhanger 강제 (카카오페 절단신공 = 1화 단위 self-contained).
 *   문제: 작품 = "큰 이야기" 인데 매 화 "마무리 + 새로 열기" 가 인위적. Arc 중간엔
 *         일직선 흐름이 자연스럽다 — 좌담 통찰 #03 (individuation arc), #04 (salvation 6-beat).
 *   변경: arcPosition='closing' 일 때만 cliffhanger 부재를 SOFT FLAG. opening/rising/
 *         midpoint/falling 은 부재 OK (Arc 내부 박자 자유).
 *   미지정: 기존 동작 보존 (기존 작품 설정 호환).
 */
export const CLIFFHANGER_TRIGGERS = [
    // === interrogative endings (의문문 종결) ===
    { patternSource: '\\?\\s*$', kind: 'interrogative' },
    { patternSource: '(?:인가|이었나|일까|었을까|것일까|것인가)[\\.\\?!]?\\s*$', kind: 'interrogative' },
    { patternSource: '(?:할까|할까\\?|싶었다\\?)[\\.\\?!]?\\s*$', kind: 'interrogative' },
    { patternSource: '뭐였더라[\\.\\?!]?\\s*$', kind: 'interrogative' },
    { patternSource: '무엇이었을까[\\.\\?!]?\\s*$', kind: 'interrogative' },
    { patternSource: '누구였을까[\\.\\?!]?\\s*$', kind: 'interrogative' },
    { patternSource: '어떻게\\s*될까[\\.\\?!]?\\s*$', kind: 'interrogative' },
    { patternSource: '어떻게\\s*되는\\s*것일까[\\.\\?!]?\\s*$', kind: 'interrogative' },
    // === unfinished-event (미완 사건 표지) ===
    { patternSource: '려는\\s*순간', kind: 'unfinished-event' },
    { patternSource: '하려던\\s*찰나', kind: 'unfinished-event' },
    { patternSource: '할\\s*그\\s*때', kind: 'unfinished-event' },
    { patternSource: '려고\\s*했지만', kind: 'unfinished-event' },
    { patternSource: '다음\\s*순간', kind: 'unfinished-event' },
    { patternSource: '그\\s*순간', kind: 'unfinished-event' },
    { patternSource: '그러나\\s*다음\\s*순간', kind: 'unfinished-event' },
    { patternSource: '바로\\s*그때', kind: 'unfinished-event' },
    { patternSource: '그\\s*직후', kind: 'unfinished-event' },
    { patternSource: '미처\\s*\\S+기도\\s*전에', kind: 'unfinished-event' },
    { patternSource: '할\\s*사이도\\s*없이', kind: 'unfinished-event' },
    { patternSource: '채\\s*\\S+하지\\s*못하고', kind: 'unfinished-event' },
    { patternSource: '다\\s*말고', kind: 'unfinished-event' },
    { patternSource: '말이\\s*끝나기도\\s*전에', kind: 'unfinished-event' },
    { patternSource: '려는\\s*찰나', kind: 'unfinished-event' },
    // === reversal (반전 trigger) ===
    { patternSource: '하지만', kind: 'reversal' },
    { patternSource: '그러나', kind: 'reversal' },
    { patternSource: '그런데', kind: 'reversal' },
    { patternSource: '한데', kind: 'reversal' },
    { patternSource: '그럼에도\\s*불구하고', kind: 'reversal' },
    { patternSource: '다만', kind: 'reversal' },
    { patternSource: '반전', kind: 'reversal' },
    { patternSource: '예상치\\s*못한', kind: 'reversal' },
    { patternSource: '뜻밖에도', kind: 'reversal' },
    { patternSource: '뜻밖의', kind: 'reversal' },
    { patternSource: '그가\\s*모르는\\s*사이', kind: 'reversal' },
    { patternSource: '그러나\\s*그것은\\s*시작에\\s*불과했다', kind: 'reversal' },
    { patternSource: '이것이\\s*끝이\\s*아니었다', kind: 'reversal' },
    { patternSource: '진짜는\\s*따로\\s*있었다', kind: 'reversal' },
    { patternSource: '는\\s*줄도\\s*모르고', kind: 'reversal' },
    { patternSource: '알\\s*리가\\s*없었다', kind: 'reversal' },
];
/**
 * cliffhanger 검사 적용 여부 — Arc-aware.
 *   undefined: 기존 동작 (모든 화 강제) — legacy 호환.
 *   'closing': Arc 정산 단계 → cliffhanger 필요 (Arc 약속 마감 + 다음 Arc 훅).
 *   기타 ('opening' | 'rising' | 'midpoint' | 'falling'): Arc 내부 박자 → 자유.
 */
function cliffhangerRequired(arcPosition) {
    if (arcPosition === undefined)
        return true;
    return arcPosition === 'closing';
}
import { skipKoLexical } from './checker-registry.js';
export function detectCliffhanger(input) {
    const skipped = skipKoLexical(input, 'detectCliffhanger');
    if (skipped)
        return skipped;
    const { prose, chapterNumber, arcPosition } = input;
    if (!prose || prose.trim().length === 0)
        return { violations: [] };
    if (!cliffhangerRequired(arcPosition))
        return { violations: [] };
    const lastParagraph = extractLastParagraph(prose);
    if (lastParagraph.length === 0)
        return { violations: [] };
    for (const trigger of CLIFFHANGER_TRIGGERS) {
        const re = new RegExp(trigger.patternSource, 'mg');
        if (re.test(lastParagraph)) {
            return { violations: [] };
        }
    }
    return {
        violations: [
            {
                severity: 'soft',
                code: 'CLIFFHANGER_MISSING',
                chapterNumber,
                message: '마지막 단락에 절단신공 trigger 0 — Arc 종결 구간은 의문문/미완 사건/반전 marker 필요',
            },
        ],
    };
}
function extractLastParagraph(prose) {
    const trimmed = prose.trimEnd();
    const split = trimmed.split(/\n\s*\n/);
    return (split[split.length - 1] ?? '').trim();
}
