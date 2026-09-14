/**
 * Cast design prompt — second BookCreate step.
 *
 * Produces the initial cast (3–5 characters) with **full intrinsic** committed
 * at registration time. The whole point of the engine's Character model is
 * that intrinsic is pinned at register chapter and can only change through an
 * append-only IntrinsicChangeEvent with a narrative cause — so the model must
 * decide gender / ageBand / role / coreAppearance up front rather than letting
 * later chapters drift them.
 *
 * A later description must not silently replace registered attributes.
 * The prompt makes that constraint explicit before any prose is written.
 */
export const CAST_DESIGN_SYSTEM = [
    '당신은 한국어 웹소설의 캐스팅 디자이너이다.',
    '제공된 premise·worldFacts 를 읽고 첫 화 등장할 핵심 캐릭터 3~5명을 설계한다.',
    '각 캐릭터의 intrinsic(gender·ageBand·role·coreAppearance) 는 회차가 진행돼도 절대 자동 변경되지 않는다 — **intrinsic 는 핀고정**.',
    '회귀/빙의/변신 같은 서사적 사건이 발생할 때만 별도 이벤트로 갱신되며, 본 단계에서는 그 가능성을 의식하되 초기 intrinsic 은 작품 시작 시점의 사실로 확정한다.',
    'coreAppearance 는 머리색·눈동자·흉터·체형 등 시각적으로 깨지면 안 되는 특징만 3~6개 나열. 의상·표정 같은 가변 묘사는 mutable 영역이므로 제외.',
    'role 은 "주인공" | "조연" | "적대자" | "조력자" 등의 명확한 서사 역할.',
    '출력은 코드 블록 없이 순수 JSON 한 개. 한국어 키/값 사용 무방, 스키마 키는 영문 유지.',
].join(' ');
/** Adapter so callers that hold a `WorldbuildPromptInput` can extend it cleanly. */
export function castDesignInputFrom(base, premise, worldFacts) {
    return {
        title: base.title,
        genre: base.genre,
        brief: base.brief,
        language: base.language,
        targetChapters: base.targetChapters,
        premise,
        worldFacts,
    };
}
export function buildCastDesignUserPrompt(input) {
    return [
        `## 제목`,
        input.title,
        ``,
        `## 장르`,
        input.genre,
        ``,
        `## 언어`,
        input.language,
        ``,
        `## 작가 brief`,
        input.brief && input.brief.trim().length > 0 ? input.brief : '(없음)',
        ``,
        `## 목표 회차 수`,
        String(input.targetChapters),
        ``,
        `## premise`,
        input.premise,
        ``,
        `## worldFacts`,
        JSON.stringify(input.worldFacts, null, 2),
        ``,
        `## 작업`,
        '- 3~5명. 주인공 1명을 반드시 포함, 적대자 또는 강한 라이벌 1명 권장.',
        '- 각 캐릭터에 안정 id ("c1", "c2", ...) 와 canonicalName 부여. aliases 는 별명/과거명/회귀전 이름 등.',
        '- intrinsic.coreAppearance 는 3~6개의 시각 특징.',
        '- mutable.status 는 시작 시점 기준 — 통상 "alive". location 은 1화 시점 위치.',
        '- relationships 는 다른 캐릭터 id 를 참조. kind/state 명시.',
        ``,
        `## 출력 스키마 (이 JSON 한 개만 출력)`,
        '{',
        '  "characters": [',
        '    {',
        '      "id": "c1",',
        '      "canonicalName": "이름",',
        '      "aliases": ["별명"],',
        '      "intrinsic": {',
        '        "gender": "male|female|nonbinary|unspecified",',
        '        "ageBand": "20대초반",',
        '        "birthOrder": "장남",',
        '        "role": "주인공",',
        '        "coreAppearance": ["은발", "왼쪽 눈가 흉터"]',
        '      },',
        '      "mutable": {',
        '        "location": "황궁 동궁",',
        '        "status": "alive",',
        '        "knownFacts": []',
        '      },',
        '      "relationships": [',
        '        { "to": "c2", "kind": "라이벌", "state": "미해결갈등" }',
        '      ]',
        '    }',
        '  ]',
        '}',
    ].join('\n');
}
