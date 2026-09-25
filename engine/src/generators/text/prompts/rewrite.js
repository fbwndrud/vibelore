/**
 * Rewrite prompt — author-directed full rewrite of an existing chapter.
 *
 * EPIC #254 (다시쓰기) — the user supplies an *intent* (direction chips +
 * private note + adopted reader comments, composed upstream into a single
 * `intentSummary` string) and the engine re-writes the chapter prose to satisfy
 * that intent while preserving continuity with the rest of the work.
 *
 * Distinct from `revise.ts`:
 *   - revise = minimum-edit-distance repair of *continuity violations* the gate
 *     flagged. It must NOT change the story.
 *   - rewrite = author *wants* the story (within this one chapter) changed per
 *     their intent. It is free to rework scenes/pacing/dialogue, but MUST stay
 *     consistent with the Foundation (intrinsic facts, invariants) and the
 *     prior story state (N-1 carry-forward) so downstream chapters still cohere.
 *
 * Shape parity with draft.ts: the rewrite emits raw prose + a single trailing
 * `⟦vle:cast-manifest …⟧` sentinel block so `commitPhase` can run
 * extractDelta → continuityCheck → sanitize unchanged. Failing to emit the
 * sentinel trips `SanitizeLeakError` in commitPhase (the manifest is the only
 * allowed inline metadata channel).
 *
 * 다국어 Phase 2A — 계열은 둘이다. 구형 `## 언어` 슬롯에 한 줄 적고 한국어 system 을
 * 그대로 쓰는 형태는 **금지**이므로, 비ko 는 영어 집필 지시 계열 전체를 쓰고 목표
 * 언어는 검증된 계약 지시문으로만 말한다. 작가의 다시쓰기 지시(intent)는 작가
 * 데이터라 번역하거나 요약하지 않고 원문 그대로 싣는다.
 */
import {
    pickByFamily, promptFamilyCaptureContext, resolveDialogueBreakMode, resolveStepPromptLanguage,
} from '../../../core/prompt-language.js';

/**
 * 대사·문단 배치 규칙. 계열이 아니라 포맷 정책(`dialogueBreakMode`)이 정한다.
 * ko + `strict` 는 구형 프롬프트에 이 규칙이 없었으므로 줄을 추가하지 않는다
 * (legacy byte-identical). 비ko 는 목표 언어 관습을 기본(`natural`)으로 명시한다.
 */
const REWRITE_DIALOGUE_RULE_KO = Object.freeze({
    strict: null,
    relaxed: '9) 대사는 서술 문단 안에 놓을 수 있지만 긴 서술 뒤에 파묻지 않는다.',
    natural: '9) 대사와 문단의 배치는 목표 독자의 산문 관습에 맞춘다. 대사 독립 문단이나 문단 밀도 상한을 강제하지 않는다.',
});
const REWRITE_DIALOGUE_RULE_MULTILINGUAL = Object.freeze({
    strict: '9) Give each line of dialogue its own paragraph and keep paragraphs short enough to read on a phone.',
    relaxed: '9) Dialogue may sit inside a narrative paragraph, but do not bury it at the end of a long stretch of narration.',
    natural: '9) Follow the dialogue and paragraph conventions of the target language: inline speech attribution and dialogue inside a narrative paragraph are both fine. Do not impose paragraph-density caps or one-line-per-utterance layout from another market.',
});

function rewriteSystemLinesKo(dialogueRule) {
    return [
        '당신은 한국어 웹소설 작가이다. 작가(사용자)의 다시쓰기 지시(intent)에 따라 기존 회차를 다시 쓴다.',
        '엄수 사항:',
        '1) 작가 지시(intent)를 본문에 충실히 반영한다 — 방향·강조·채택 코멘트가 요구하는 변화를 실제 장면·대사·전개로 구현한다.',
        '2) 캐릭터 intrinsic(gender·ageBand·role·coreAppearance) 은 Foundation 의 기록과 정확히 일치해야 한다. 머리색·성별·역할을 임의로 변경 금지.',
        '3) 이전 회차 상태(StoryState N-1)와의 연속성을 유지한다 — 앞 회차에서 확정된 호칭·관계·열린 떡밥·등장 인물 설정을 부정하지 않는다.',
        '4) 사건의 큰 틀(이 회차가 작품 전체에서 차지하는 위치)은 보존하되, 회차 내부의 장면·대사·연출은 작가 지시에 맞게 자유롭게 다시 구성할 수 있다.',
        '5) 분량은 원본과 비슷한 수준(±20%)으로 유지한다.',
        '6) 감정을 직접 단어(슬프다/기뻤다/화났다/두려웠다 등)로 명시하지 말고 행동·감각·대사로 치환한다.',
        '7) 본문은 마크다운 헤더/번호 없이 순수 산문. 코드 블록 사용 금지.',
        '8) 본문 마지막에 cast-manifest sentinel 블록을 반드시 부착. 본문과 sentinel 사이에는 빈 줄 1개.',
        ...(dialogueRule ? [dialogueRule] : []),
        'sentinel 포맷:',
        '⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":["도련님"]}]}⟧',
        'cast 에는 본문에 등장(대사 또는 행동 주체)한 모든 캐릭터를 빠짐없이 기재. characterId 는 Foundation 의 id 그대로 사용. addressTermsUsed 는 해당 캐릭터가 본문에서 다른 인물을 부른 호칭만 기록.',
        '본문에 `⟦vle:…⟧` 패턴은 cast-manifest 외에 다른 어떤 것도 출력하지 말 것.',
    ].join(' ');
}

/**
 * 다국어 계열. ko 규칙의 번역이 아니라 같은 다시쓰기 원칙을 영어 지시로 쓴 별도
 * 계열이며, 존대/반말처럼 ko 전용 장치는 목표 언어의 등가 장치로 바꿔 말한다.
 * sentinel 문법·JSON 키·Foundation id 는 기계 계약이라 동일하다.
 */
function rewriteSystemLinesMultilingual(dialogueRule) {
    return [
        'You are a serial-fiction novelist writing in the target work language. Rewrite an existing chapter according to the author\'s rewrite intent.',
        'Rules:',
        '1) Realise the author\'s intent in the prose — implement the direction, emphasis and adopted comments as actual scenes, dialogue and development.',
        '2) Character intrinsics (gender, ageBand, role, coreAppearance) must match the Foundation exactly. Never change hair colour, gender or role on your own.',
        '3) Keep continuity with the previous chapter state (StoryState N-1) — do not contradict settled address terms, relationships, open hooks or character facts.',
        '4) Preserve this chapter\'s place in the whole work, but you are free to rebuild its scenes, dialogue and staging to serve the author\'s intent.',
        '5) Keep the length close to the original (within ±20%).',
        '6) Do not name feelings directly (sad, happy, angry, afraid); carry them through action, sensation and dialogue.',
        '7) Plain prose only — no markdown headings or numbering, no code blocks.',
        '8) Append the cast-manifest sentinel block at the end, with exactly one blank line between the prose and it.',
        dialogueRule,
        'Sentinel format:',
        '⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":["young master"]}]}⟧',
        'List every character who appears in the prose (speaking or acting) in cast. Use the Foundation id verbatim as characterId; do not translate ids, JSON keys or the sentinel tag. addressTermsUsed records only the terms that character used for other characters, written in the target work language exactly as they appear in the prose.',
        'Do not emit any `⟦vle:…⟧` pattern other than the cast-manifest block.',
    ].join(' ');
}

/** 구형 상수 — ko + `strict` 계열 정적 표면. 값은 기존과 동일하다. */
export const REWRITE_SYSTEM = rewriteSystemLinesKo(REWRITE_DIALOGUE_RULE_KO.strict);
/** 다국어 계열 정적 표면(비ko 기본 포맷 모드 = `natural`). */
export const REWRITE_SYSTEM_MULTILINGUAL = rewriteSystemLinesMultilingual(REWRITE_DIALOGUE_RULE_MULTILINGUAL.natural);

/**
 * 이번 호출에 쓸 rewrite system. 포맷 모드는 계약 고정값 → 호출자가 승인해 넘긴
 * 값 → 계열 기본값 순이며, 어긋난 조합은 조용히 덮지 않고 오류다.
 */
export function rewriteSystemFor(context, { dialogueBreakMode = null } = {}) {
    const mode = resolveDialogueBreakMode(context, dialogueBreakMode);
    return pickByFamily(context, {
        ko: () => rewriteSystemLinesKo(REWRITE_DIALOGUE_RULE_KO[mode]),
        multilingual: () => rewriteSystemLinesMultilingual(REWRITE_DIALOGUE_RULE_MULTILINGUAL[mode]),
    });
}

/** ADR-0006 promptManifest 수집용 계열 정적 표면(계열 기본 포맷 모드). */
export function rewriteSystemStatic(family) {
    return rewriteSystemFor(promptFamilyCaptureContext(family));
}

const REWRITE_LABELS_KO = {
    chapterNumber: '## 회차 번호',
    language: '## 언어',
    intent: '## 작가 다시쓰기 지시 (intent)',
    intentMissing: '(지시 없음 — 원본의 의도를 유지하되 문장을 다듬어 다시 쓴다)',
    foundation: '## Foundation 컨텍스트 (다시 쓸 때 일치시킬 정본)',
    prevState: '## 이전 상태 요약 (StoryState N-1 — 연속성 기준)',
    original: '## 원본 본문',
    output: '## 출력',
    outputLines: [
        '작가 지시를 반영해 다시 쓴 전체 본문(순수 산문) + 빈 줄 1개 + cast-manifest sentinel 블록.',
        '본문 외 어떤 헤더·메타 설명도 출력하지 말 것.',
    ],
};
const REWRITE_LABELS_EN = {
    chapterNumber: '## Chapter number',
    language: '## Target work language (BCP 47)',
    intent: '## Author rewrite intent',
    intentMissing: '(No intent given — keep the original intention and rewrite for cleaner sentences.)',
    foundation: '## Foundation context (the canon your rewrite must match)',
    prevState: '## Previous state summary (StoryState N-1 — the continuity baseline)',
    original: '## Original prose',
    output: '## Output',
    outputLines: [
        'The full rewritten prose that realises the author\'s intent (plain prose) + one blank line + the cast-manifest sentinel block.',
        'Output nothing but the prose — no headings, no meta commentary.',
    ],
};

export function buildRewriteUserPrompt(input) {
    const ctx = resolveStepPromptLanguage(input);
    const labels = pickByFamily(ctx, { ko: REWRITE_LABELS_KO, multilingual: REWRITE_LABELS_EN });
    const sections = [
        labels.chapterNumber,
        String(input.chapterNumber),
        ``,
        labels.language,
        // 검증된 계약 태그. 작가 자유 텍스트를 언어 지시로 보간하지 않는다.
        ctx.language,
        ``,
        labels.intent,
        // 작가 지시는 작품 데이터다 — 계열과 무관하게 원문 그대로 싣는다.
        input.intentSummary.trim().length > 0 ? input.intentSummary.trim() : labels.intentMissing,
        ``,
        labels.foundation,
        JSON.stringify(input.foundationContext, null, 2),
        ``,
    ];
    // P4b (#516) — 멘션 entity 섹션. Foundation 뒤, StoryState 앞 (draft.ts 의
    // 섹션 순서와 정합 — entity 가 화 컨텍스트 핵심).
    if (input.entityContextRender && input.entityContextRender.length > 0) {
        sections.push(input.entityContextRender, ``);
    }
    sections.push(labels.prevState, JSON.stringify(input.prevStateSummary, null, 2), ``, labels.original, input.previousProse, ``, labels.output, ...labels.outputLines);
    return sections.join('\n');
}
