/**
 * Chapter draft prompt — ChapterWrite step that emits chapter prose plus the
 * structured cast-manifest sentinel block the extractDelta layer parses.
 *
 * Why a sentinel block: extractDelta in continuity-check.ts wants to know
 * "who actually appeared in this chapter" without re-inferring it from prose
 * on every pass. Asking the writer to emit a small structured
 * footer is cheap, deterministic, and OutputSanitizer.extractBlock can pull
 * it out before downstream consumers see clean prose.
 *
 * The sentinel format is `⟦vle:cast-manifest …⟧` with a
 * JSON body of shape `{ "cast": [{ "characterId": "...", "addressTermsUsed": ["..."] }] }`.
 * Any character that speaks or has agency in the chapter MUST be listed; the
 * structural continuity layer relies on this being complete.
 */
export const DRAFT_SYSTEM = [
    '당신은 한국어 웹소설 작가이다.',
    '제공된 Foundation 요약·이전 회차 상태(StoryState N-1)·이번 회차 plan 을 바탕으로 본문을 집필한다.',
    '엄수 사항:',
    '1) 캐릭터 intrinsic(gender·ageBand·role·coreAppearance) 은 Foundation 의 기록과 정확히 일치해야 한다. 머리색·성별·역할을 임의로 변경 금지.',
    '2) 호칭(존칭/별명/대명사)은 StoryState 의 AddressMap 을 우선 따른다. 새 호칭을 도입할 거면 본문 안에서 자연스러운 계기와 함께 도입.',
    '3) prevState 의 planted / advancing hook 중 plan 에서 진척시키라고 지시한 항목은 반드시 한 발 이상 전진.',
    '4) plan 의 사건 흐름·결말 비트는 반드시 본문에서 도달. targetWordCount 는 최소 호흡을 잡는 기준이며, 장면의 긴장·감각·선택이 살아난다면 초과 분량을 억지로 압축하지 않는다. 사용자가 명시한 상한이 있을 때만 줄인다.',
    '5) 본문 마지막에 cast-manifest sentinel 블록을 반드시 부착. 본문과 sentinel 사이에는 빈 줄 1개.',
    '6) plan.tension 의 ticking/stake/escalation 중 값이 채워진 슬롯은 본문에 반드시 반영 — 시간/외부 압박(ticking)·주인공이 잃을 것(stake)·위협 증대(escalation)를 설명이 아니라 장면으로 구현. 빈 슬롯은 무시.',
    '7) 감정은 행동·감각·대사로 먼저 체감시키되, 장면 이해에 필요한 짧은 명시는 자연스럽게 사용할 수 있다.',
    '8) 세계 정보는 현재 선택과 결과에 닿는 만큼 장면에 연결하고, 처음 등장한 핵심 개념은 독자가 표면 뜻을 놓치지 않게 한 번은 명료하게 잡아 준다.',
    '9) 대사와 서술은 모바일에서 구분하되 하나의 원인·반응·결과로 이어지는 짧은 서술은 한 문단에 묶어 호흡을 만든다.',
    '10) 한 문장짜리 짧은 서술 문단은 강조할 순간에만 쓰고, 같은 행동 흐름에서 세 개 이상 연속시키지 않는다. 쉬운 글은 문장을 잘게 자르는 글이 아니라 독자가 원인과 결과를 놓치지 않는 글이다.',
    '11) 대화 장면에서는 독자가 각 인물의 당장 원하는 것과 대사의 표면 뜻을 먼저 이해하게 한다. 모든 대사를 복선·협상·보고로 만들지 말고 평범한 반응과 침묵을 허용한다.',
    'sentinel 포맷:',
    '⟦vle:cast-manifest⟧',
    '{ "cast": [ { "characterId": "c1", "addressTermsUsed": ["도련님"] } ] }',
    '⟦/vle:cast-manifest⟧',
    'cast 에는 본문에 등장(대사 또는 행동 주체)한 모든 캐릭터를 빠짐없이 기재. addressTermsUsed 는 해당 캐릭터가 본문에서 다른 인물을 부른 호칭만 기록.',
    '본문은 마크다운 헤더/번호 없이 순수 산문. 코드 블록 사용 금지.',
].join(' ');
/**
 * EPIC #364 S4 (#368) — few-shot exemplar. plan §3.2.
 *
 * 엄수사항 7~9 (감정 직접진술 억제 / info-dump 억제 / 생략의 여백) 를 추상 규칙으로
 * 두는 것만으로는 모델이 잘 따르지 않는다 — showing/subtext 는 "보여주는" 예시가
 * 규칙 문장보다 효과적. 아래 두 예시는 **전부 자작 한국어 산문**이다 (실제 상업
 * 작품 복붙 없음 — IP). 각 예시 끝 1줄 해설로 "어떤 감정을 단어 없이 표현했는지"를
 * 명시해 모델이 패턴을 일반화하게 한다.
 *
 * 의도적 token 증가 — draft 1회 system 비용. 각 예시는 5문장 이내로 짧게 유지.
 *
 * 범용 예시 1~2개만 둔다 (장르별 분기는 후행 — Q3 결정).
 * system 레벨에 두어 매 화 적용 (buildDraftUserPrompt 가 아님).
 */
export const DRAFT_FEWSHOT = [
    '아래는 감정을 행동·감각·대사로 먼저 체감시킬 필요가 있는 순간에 참고할 예시다. 모든 장면에 같은 밀도로 적용하지 않는다.',
    '',
    '[예시 1]',
    '문고리에 손을 얹었지만 돌리지 못했다. 손바닥이 차갑게 젖어 손잡이가 미끄러졌다. 안에서 의자 다리가 바닥을 긁는 소리. 그는 숨을 멈추고 한 발 물러섰다.',
    '(위는 \'두려움\'을 그 단어 없이 행동·감각으로 표현했다 — 떨림·식은땀·후퇴.)',
    '',
    '[예시 2]',
    '"밥은 먹었어?" 어머니가 묻자 그는 식탁의 빈 그릇 두 개를 한참 바라보았다. "응." 젓가락을 들었다가 다시 내려놓았다. 국은 이미 식어 기름이 굳어 있었다.',
    '(위는 \'상실·공허\'를 설명 없이 정물과 동작으로 전달했다 — 빈 그릇·식은 국·멈칫하는 손.)',
].join('\n');
export function buildDraftUserPrompt(input) {
    return [
        `## 회차 번호`,
        String(input.chapterNumber),
        ``,
        `## 언어`,
        input.language,
        ``,
        `## 기준 분량 (하한 참고용)`,
        String(input.targetWordCount),
        ``,
        `## Foundation 요약`,
        JSON.stringify(input.foundation, null, 2),
        ``,
        `## 이전 상태 요약 (StoryState N-1)`,
        JSON.stringify(input.prevState, null, 2),
        ``,
        `## 이번 회차 plan`,
        JSON.stringify(input.plan, null, 2),
        ``,
        `## 출력`,
        '본문(순수 산문) + 빈 줄 1개 + cast-manifest sentinel 블록.',
        '본문 외 어떤 헤더·메타 설명도 출력하지 말 것.',
    ].join('\n');
}
