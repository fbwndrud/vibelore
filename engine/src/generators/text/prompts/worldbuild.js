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
 *
 * 실행 경로 주의: 실제 book-create 는 `steps/worldbuild.js` 의 자체 builder 를 쓴다.
 * 이 모듈은 공개 export 표면이며 다국어 Phase 2A 에서 계열이 둘이 됐다.
 */
import { pickByFamily, promptFamilyCaptureContext, resolveStepPromptLanguage, } from '../../../core/prompt-language.js';
export const WORLDBUILD_SYSTEM = [
    '당신은 한국어 웹소설의 세계관 설계자이다.',
    '제공된 제목·장르·brief 를 바탕으로, 작품 일관성의 토대가 될 worldFact 5~10개를 작성한다.',
    'worldFact 는 명시적·검증가능한 사실이어야 한다 — 추상적 분위기 설명 금지.',
    '예시 (good): "제국력 1124년, 황태자 계승 의식은 황궁 동궁에서 거행된다."',
    '예시 (bad): "왕국은 신비롭고 음울한 분위기이다."',
    'premise 는 한 문단 이내, 작품 컨셉을 압축. worldFact 는 회차가 늘어도 깨지지 않을 골조여야 한다.',
    '출력은 코드 블록 없이 순수 JSON 한 개. 한국어 키/값 사용 무방, 스키마 키는 영문 유지.',
].join(' ');
/**
 * 다국어 계열. worldFact 의 "검증가능한 사실" 계약은 그대로 두고, 값은 목표 작품
 * 언어로 요구한다. 스키마 키·id 형식은 기계 계약이라 동일하다.
 */
export const WORLDBUILD_SYSTEM_MULTILINGUAL = [
    'You design the world of a serial-fiction work written in the target work language.',
    'From the title, genre and brief, write 5-10 worldFacts that will be the foundation of the work\'s consistency.',
    'A worldFact must be an explicit, checkable proposition — not an atmospheric description.',
    'Good: "In imperial year 1124, the crown prince\'s succession rite is held in the eastern palace."',
    'Bad: "The kingdom has a mysterious, gloomy atmosphere."',
    'premise is at most one paragraph and compresses the concept of the work. A worldFact must be load-bearing enough to survive hundreds of chapters.',
    'Output one pure JSON object with no code fence. Write the values in the target work language and keep the schema keys verbatim.',
].join(' ');
/** 이번 호출에 쓸 공개 worldbuild system. 계약이 없으면 구형 ko 문자열 그대로다. */
export function worldbuildSystemFor(context) {
    return pickByFamily(context, { ko: WORLDBUILD_SYSTEM, multilingual: WORLDBUILD_SYSTEM_MULTILINGUAL });
}
/** ADR-0006 promptManifest 수집용 계열 정적 표면(공개 표면). */
export function publicWorldbuildSystemStatic(family) {
    return worldbuildSystemFor(promptFamilyCaptureContext(family));
}
const WORLDBUILD_LABELS_KO = {
    title: '## 제목',
    genre: '## 장르',
    language: '## 언어',
    brief: '## 작가 brief',
    briefMissing: '(없음)',
    targetChapters: '## 목표 회차 수',
    task: '## 작업',
    taskLines: [
        '- premise: 작품 컨셉을 한 문단으로 압축 (장르 hook + 갈등 핵 + 톤).',
        '- worldFacts: 5~10개. 각각 명시적·검증가능한 사실. 시간/장소/제도/세력/물리법칙 등.',
        '- id 는 "wf1", "wf2", ... 형식.',
    ],
    schema: '## 출력 스키마 (이 JSON 한 개만 출력)',
    premisePlaceholder: '한 문단 작품 컨셉',
    statementPlaceholder: '구체 사실 문장',
};
const WORLDBUILD_LABELS_EN = {
    title: '## Title',
    genre: '## Genre',
    language: '## Target work language (BCP 47)',
    brief: '## Author brief',
    briefMissing: '(none)',
    targetChapters: '## Target chapter count',
    task: '## Task',
    taskLines: [
        '- premise: compress the concept of the work into one paragraph (genre hook + core conflict + tone).',
        '- worldFacts: 5-10 entries, each an explicit and checkable fact — time, place, institutions, factions, physical law.',
        '- ids follow the "wf1", "wf2", … form.',
    ],
    schema: '## Output schema (emit this one JSON object only)',
    premisePlaceholder: 'one paragraph of concept, in the target work language',
    statementPlaceholder: 'one concrete fact, in the target work language',
};
export function buildWorldbuildUserPrompt(input) {
    const ctx = resolveStepPromptLanguage(input);
    const labels = pickByFamily(ctx, { ko: WORLDBUILD_LABELS_KO, multilingual: WORLDBUILD_LABELS_EN });
    return [
        labels.title,
        input.title,
        ``,
        labels.genre,
        input.genre,
        ``,
        labels.language,
        ctx.language,
        ``,
        labels.brief,
        input.brief && input.brief.trim().length > 0 ? input.brief : labels.briefMissing,
        ``,
        labels.targetChapters,
        String(input.targetChapters),
        ``,
        labels.task,
        ...labels.taskLines,
        ``,
        labels.schema,
        '{',
        `  "premise": "${labels.premisePlaceholder}",`,
        '  "worldFacts": [',
        `    { "id": "wf1", "statement": "${labels.statementPlaceholder}" }`,
        '  ]',
        '}',
    ].join('\n');
}
