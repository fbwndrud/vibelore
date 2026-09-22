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
 */
export const REWRITE_SYSTEM = [
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
    'sentinel 포맷:',
    '⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":["도련님"]}]}⟧',
    'cast 에는 본문에 등장(대사 또는 행동 주체)한 모든 캐릭터를 빠짐없이 기재. characterId 는 Foundation 의 id 그대로 사용. addressTermsUsed 는 해당 캐릭터가 본문에서 다른 인물을 부른 호칭만 기록.',
    '본문에 `⟦vle:…⟧` 패턴은 cast-manifest 외에 다른 어떤 것도 출력하지 말 것.',
].join(' ');
export function buildRewriteUserPrompt(input) {
    const sections = [
        `## 회차 번호`,
        String(input.chapterNumber),
        ``,
        `## 언어`,
        input.language,
        ``,
        `## 작가 다시쓰기 지시 (intent)`,
        input.intentSummary.trim().length > 0
            ? input.intentSummary.trim()
            : '(지시 없음 — 원본의 의도를 유지하되 문장을 다듬어 다시 쓴다)',
        ``,
        `## Foundation 컨텍스트 (다시 쓸 때 일치시킬 정본)`,
        JSON.stringify(input.foundationContext, null, 2),
        ``,
    ];
    // P4b (#516) — 멘션 entity 섹션. Foundation 뒤, StoryState 앞 (draft.ts 의
    // 섹션 순서와 정합 — entity 가 화 컨텍스트 핵심).
    if (input.entityContextRender && input.entityContextRender.length > 0) {
        sections.push(input.entityContextRender, ``);
    }
    sections.push(`## 이전 상태 요약 (StoryState N-1 — 연속성 기준)`, JSON.stringify(input.prevStateSummary, null, 2), ``, `## 원본 본문`, input.previousProse, ``, `## 출력`, '작가 지시를 반영해 다시 쓴 전체 본문(순수 산문) + 빈 줄 1개 + cast-manifest sentinel 블록.', '본문 외 어떤 헤더·메타 설명도 출력하지 말 것.');
    return sections.join('\n');
}
