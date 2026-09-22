/**
 * Revise prompt — bounded partial rewrite to fix listed continuity violations.
 *
 * Used by T3.4's revise loop after continuityCheck flags hard violations. The
 * goal is **minimum-edit-distance** repair: we do NOT want the model to take
 * the opportunity to "improve" pacing, swap scene order, or reword unaffected
 * paragraphs. That would invalidate prevState assumptions and could cascade
 * violations elsewhere in the chapter.
 *
 * Each ReviseViolation references the offending span (paragraph anchor or
 * quote) plus the rule that broke. The model must touch only those spans and
 * the cast-manifest sentinel (which may need updating if a character is
 * added/removed from the chapter).
 */
export const REVISE_SYSTEM = [
    '당신은 한국어 웹소설 교정자이다.',
    '제공된 본문에서 명시된 위반 사항만 정확히 수정한다. 연속성 위반은 최소 수정하고, 독서 체험 위반은 해당 장면을 다시 설계할 수 있다.',
    '엄수 사항:',
    '1) 위반에 직접 관련된 장면만 고친다. 위반과 무관한 장면은 한 글자도 변경 금지. 단, QUALITY_GATE_LENGTH는 원문의 사건과 문단을 보존한 채 인과적 행동, 반응, 선택의 여파를 완전한 장면 단위로 추가하는 확장 작업이다.',
    '2) 사건의 확정 결과와 정본은 보존한다. 단, STATIC_POWER·ON_THE_NOSE_DIALOGUE·CLEAN_CONFLICT_RESET·TELEGRAPHED_TURN·SCENE_THIN·PLAN_SHAPED_PROSE·QUALITY_GATE_READER_HOOK 위반은 해당 장면 안에서 행동 순서, 정보 공개 시점, 대사, 작은 선택과 대가를 재구성해 원인을 고친다.',
    '3) 캐릭터 intrinsic(gender·ageBand·role·coreAppearance) 충돌은 본문 묘사를 Foundation 사실에 맞추는 방향으로 수정 — Foundation 을 부정하지 말 것.',
    '4) 호칭 위반은 AddressMap / HonorificLexicon 함의를 따르도록 표현만 교체. 새 인물을 임의로 추가 금지.',
    '5) cast-manifest sentinel 은 본문 변경에 맞춰 갱신. 본문에서 등장이 사라지면 manifest 에서도 제거, 새로 등장하면 추가.',
    '6) QUALITY_GATE_LENGTH 수정에서는 기존 본문을 삭제·요약·압축하지 않는다. 위반에 명시된 recommendedChars 이상이 되도록 장면을 확장하고, 출력 직전 전체 본문 길이를 확인한다.',
    '7) 문단 경계의 빈 줄을 일반 줄바꿈으로 바꾸지 않는다. 일반 산문 문단 내부 문장은 공백으로 잇고, 서로 다른 문단과 독립 대사 앞뒤에는 빈 줄을 둔다.',
    '8) 출력은 수정된 전체 본문(순수 산문) + 빈 줄 1개 + cast-manifest sentinel 한 줄. 변경 로그·메타 설명 출력 금지.',
    'sentinel 예시: ⟦vle:cast-manifest {"cast":[{"characterId":"c1","addressTermsUsed":["선배"]}]}⟧',
].join(' ');

export const REVISE_PATCH_SYSTEM = [
    '당신은 한국어 웹소설의 국소 교정자이다.',
    '전체 원고를 다시 쓰지 말고, 번호가 붙은 원문 문단에 적용할 JSON 패치만 만든다.',
    '위반을 고치는 데 필요한 최소 문단만 replacement로 바꾸고, 새 장면이 꼭 필요할 때만 insertion을 사용한다.',
    '문단 번호, 사건 결과, 인물의 말투, 시점, 빈 문단으로 형성된 호흡을 보존한다.',
    '출력은 순수 JSON 하나뿐이며 설명이나 마크다운을 붙이지 않는다.',
].join(' ');

export function buildRevisePatchUserPrompt(input) {
    const paragraphs = String(input.originalProse ?? '').replace(/\r\n/g, '\n').trim()
        .split(/\n\s*\n/).map((text, index) => ({ paragraph: index + 1, text: text.trim() })).filter((item) => item.text);
    return [
        `## 회차 번호`,
        String(input.chapterNumber),
        ``,
        `## 위반 사항`,
        JSON.stringify(input.violations, null, 2),
        ``,
        ...(input.styleContext ? [
            `## 작품 문체 정본`,
            typeof input.styleContext === 'string' ? input.styleContext : JSON.stringify(input.styleContext, null, 2),
            ``,
        ] : []),
        `## Foundation 컨텍스트`,
        JSON.stringify(input.foundationContext, null, 2),
        ``,
        `## 수정 한도`,
        `replacement와 insertion을 합쳐 최대 ${input.maxOperations}개. 원문 문단은 총 ${paragraphs.length}개다.`,
        `QUALITY_GATE_LENGTH가 있으면 기존 문단을 유지하고 insertion으로 인과적 행동·반응·선택의 여파를 추가한다.`,
        ``,
        `## 번호가 붙은 원문 문단`,
        JSON.stringify(paragraphs, null, 2),
        ``,
        `## 현재 cast-manifest`,
        input.castManifestRaw || '{"cast":[]}',
        ``,
        `## 출력 JSON 스키마`,
        '{"replacements":[{"paragraph":3,"text":"교체할 문단 전체"}],"insertions":[{"afterParagraph":3,"text":"추가할 한 개 이상의 문단"}],"castManifest":{"cast":[]}}',
        `replacements의 paragraph는 기존 문단 번호다. insertions의 afterParagraph는 0부터 ${paragraphs.length}까지다.`,
        `바꾸지 않는 원문은 출력하지 않는다. castManifest는 본문의 실제 등장 인물과 호칭만 반영한다.`,
    ].join('\n');
}
export function buildReviseUserPrompt(input) {
    const lengthViolation = input.violations.find((violation) => violation.code === 'QUALITY_GATE_LENGTH');
    const lengthContract = lengthViolation
        ? [
            `## 분량 수정 계약`,
            `현재 본문: ${lengthViolation.actualChars ?? input.originalProse.length}자`,
            `통과 하한: ${lengthViolation.minChars ?? '위반 메시지 참조'}자`,
            `이번 수정 목표: ${lengthViolation.recommendedChars ?? lengthViolation.targetChars ?? '통과 하한보다 충분히 길게'}자 이상`,
            `원문의 기존 사건·대사·문단을 삭제하거나 압축하지 말고, 선택의 준비·충돌·즉각적 여파를 완전한 장면으로 추가한다. 단순 묘사 반복이나 같은 정보의 재진술로 채우지 않는다.`,
            ``,
        ]
        : [];
    return [
        `## 회차 번호`,
        String(input.chapterNumber),
        ``,
        `## 언어`,
        input.language,
        ``,
        `## 위반 사항 (이것과 관련된 장면만 수정)`,
        JSON.stringify(input.violations, null, 2),
        ``,
        ...lengthContract,
        ...(input.styleContext ? [
            `## 작품 문체 정본`,
            typeof input.styleContext === 'string' ? input.styleContext : JSON.stringify(input.styleContext, null, 2),
            ``,
        ] : []),
        `## Foundation 컨텍스트 (수정 시 일치시킬 정본)`,
        JSON.stringify(input.foundationContext, null, 2),
        ``,
        `## 원본 본문`,
        input.originalProse,
        ``,
        `## 출력`,
        '수정된 전체 본문 + 빈 줄 1개 + 갱신된 inline cast-manifest sentinel 한 줄.',
        '위반 외 장면은 원본과 글자 단위로 동일해야 한다. 변경 설명을 추가하지 말 것.',
    ].join('\n');
}
