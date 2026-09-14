/**
 * P4b (#516, Epic #511) — entity mention scan (NovelAI Lorebook activation-key
 * 패턴).
 *
 * ADR-0004 의 entity context 는 chapter-plan 의 scene declaration 에만 의존한다
 * — plan LLM 이 entity 를 declare 하지 않으면 직전 화 본문에 실제로 등장한
 * entity 도 prompt 에서 빠진다 (모순 위험: "불 마법사" entity 가 빠진 채 얼음
 * 마법사로 재집필되는 류). 이 모듈은 본문 텍스트에서 entity 의
 * canonicalName/aliases 멘션을 감지해 activation 후보 id 를 돌려준다.
 *
 * 정밀도 노트:
 *   - 한국어는 \b word-boundary 가 없어 substring 매치를 쓴다 ("카엘은" ⊃
 *     "카엘"). 영문 이름도 동일 규칙 (대소문자 무시).
 *   - 1글자 term 은 과매치라 기본 제외 (minTermLength=2).
 *   - retired/destroyed entity 는 활성 후보에서 제외 — resolveEntityContext
 *     의 status filter 와 동일 기준.
 *
 * 성능: 엔티티 수십 개 × term 수 개 가정. term 별 indexOf 1-pass 로 충분
 * (plan reader-edit-customization §4 P4).
 */
const DEFAULT_MIN_TERM_LENGTH = 2;
/** 텍스트에서 entity 멘션을 감지한다. 텍스트/스냅샷이 비면 빈 결과. */
export function scanEntityMentions(input) {
    const minLen = input.minTermLength ?? DEFAULT_MIN_TERM_LENGTH;
    const mentionedIds = [];
    const matchedTerms = {};
    if (input.text.length === 0 || input.snapshots.length === 0) {
        return { mentionedIds, matchedTerms };
    }
    const haystack = input.text.toLowerCase();
    for (const snapshot of input.snapshots) {
        if (snapshot.status === 'retired' || snapshot.status === 'destroyed')
            continue;
        const terms = [snapshot.canonicalName, ...snapshot.aliases];
        for (const term of terms) {
            const trimmed = term.trim();
            if (trimmed.length < minLen)
                continue;
            if (haystack.includes(trimmed.toLowerCase())) {
                mentionedIds.push(snapshot.entityId);
                matchedTerms[snapshot.entityId] = trimmed;
                break;
            }
        }
    }
    return { mentionedIds, matchedTerms };
}
