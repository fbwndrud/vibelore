/**
 * Worldbuild prompt — first BookCreate step.
 *
 * Asks the model to produce a `premise` paragraph plus 5–10 concrete
 * `worldFacts` that will seed the Foundation registry. WorldFacts must be
 * verifiable propositions — they become canon the moment they land, and the
 * downstream continuity gate will hold the prose to them. Atmospheric
 * adjectives ("어두운 분위기", "신비로운 도시") do not qualify.
 *
 * The prompt is ko-native; the JSON envelope is structural so the model is
 * free to express values in Korean while preserving schema keys.
 */
export const WORLDBUILD_SYSTEM = [
    '당신은 한국어 웹소설의 세계관 설계자이다.',
    '제공된 제목·장르·brief 를 바탕으로, 작품 일관성의 토대가 될 worldFact 5~10개를 작성한다.',
    'worldFact 는 명시적·검증가능한 사실이어야 한다 — 추상적 분위기 설명 금지.',
    '예시 (good): "제국력 1124년, 황태자 계승 의식은 황궁 동궁에서 거행된다."',
    '예시 (bad): "왕국은 신비롭고 음울한 분위기이다."',
    'premise 는 한 문단 이내, 작품 컨셉을 압축. worldFact 는 회차가 늘어도 깨지지 않을 골조여야 한다.',
    '출력은 코드 블록 없이 순수 JSON 한 개. 한국어 키/값 사용 무방, 스키마 키는 영문 유지.',
].join(' ');
export function buildWorldbuildUserPrompt(input) {
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
        `## 작업`,
        '- premise: 작품 컨셉을 한 문단으로 압축 (장르 hook + 갈등 핵 + 톤).',
        '- worldFacts: 5~10개. 각각 명시적·검증가능한 사실. 시간/장소/제도/세력/물리법칙 등.',
        '- id 는 "wf1", "wf2", ... 형식.',
        ``,
        `## 출력 스키마 (이 JSON 한 개만 출력)`,
        '{',
        '  "premise": "한 문단 작품 컨셉",',
        '  "worldFacts": [',
        '    { "id": "wf1", "statement": "구체 사실 문장" }',
        '  ]',
        '}',
    ].join('\n');
}
