/**
 * Revise-foundation prompt — founder-feedback-driven Foundation revision.
 *
 * Used by the foundation review REVISE path (Item 2 of
 * docs/01-plan/features/rewrite-revise-worklock.plan.md). The founder has seen
 * the generated Foundation in the awaiting_review gate and supplied free-text
 * feedback ("the protagonist should be older", "add a rival faction", …). The
 * LLM revises the Foundation and emits a structured JSON patch.
 *
 * append-only constraint (mirrors the Foundation registry's community-continuation
 * design — `continuity/foundation.ts`):
 *   - worldFacts MAY be rewritten / extended.
 *   - existing characters MAY have role / coreAppearance / aliases / contradiction
 *     / mutable revised, but identity anchors (id, canonicalName, gender, ageBand,
 *     registeredAtChapter) are pinned and ignored if the model tries to change them.
 *   - new characters MAY be added.
 *   - characters MUST NOT be removed. The prompt forbids it; the generator also
 *     enforces it by keeping any existing character the model omits.
 *
 * Output is a single JSON object (no fences) so the generator can fold it onto
 * the current Foundation deterministically.
 *
 * 다국어 Phase 2A — 계열은 둘이다. 발의자 피드백은 **작가 데이터**라 번역하지 않고
 * 원문 그대로 싣고, 스키마 키·enum·인물 id 는 기계 계약이라 두 계열에서 같다.
 */
import { pickByFamily, promptFamilyCaptureContext, resolveStepPromptLanguage, } from '../../../core/prompt-language.js';

export const REVISE_FOUNDATION_SYSTEM = [
    '당신은 한국어 웹소설의 토대(Foundation) 편집자이다.',
    '발의자(작가)가 검토 단계에서 남긴 피드백을 읽고 현재 토대를 수정한다.',
    '엄수 사항:',
    '1) worldFacts 는 자유롭게 다시 쓰거나 추가할 수 있다. 각 사실은 한 문장.',
    '2) 기존 인물은 삭제 금지. 피드백이 인물 삭제를 요구해도 무시하고 그대로 유지한다.',
    '3) 기존 인물은 role(서사 역할)·coreAppearance·aliases·contradiction·mutable 만 수정 가능.',
    '   id·canonicalName·gender·ageBand·registeredAtChapter 는 정체성 고정값 — 변경 금지.',
    '4) 새 인물은 추가 가능. 새 인물은 identity intrinsic과 작품별 dramaticModel을 모두 채워야 한다.',
    '5) 출력은 코드 블록·설명·주석 없이 순수 JSON 객체 한 개.',
].join(' ');
/**
 * 다국어 계열. ko 규칙의 번역이 아니라 같은 편집 계약을 영어 지시로 쓴 별도
 * 계열이며, 사람이 읽는 값(worldFact 문장·인물 설명)은 목표 작품 언어로 요구한다.
 */
export const REVISE_FOUNDATION_SYSTEM_MULTILINGUAL = [
    'You edit the Foundation of a serial-fiction work written in the target work language.',
    'Read the feedback the founding author left at the review gate and revise the current Foundation.',
    'Rules:',
    '1) worldFacts may be rewritten or extended freely. One sentence per fact, in the target work language.',
    '2) Never remove an existing character. If the feedback asks for a removal, ignore it and keep the character.',
    '3) For existing characters you may revise only role, coreAppearance, aliases, contradiction and mutable.',
    '   id, canonicalName, gender, ageBand and registeredAtChapter are pinned identity values — do not change them.',
    '4) New characters may be added. Each new character must fill in both the identity intrinsic and a work-specific dramaticModel.',
    '5) Output exactly one pure JSON object, with no code fence, explanation or comments. Do not translate JSON keys, enum values or character ids.',
].join(' ');
/** ADR-0006 promptManifest 수집용 계열 정적 표면. */
export function reviseFoundationSystemStatic(family) {
    return pickByFamily(promptFamilyCaptureContext(family), {
        ko: REVISE_FOUNDATION_SYSTEM,
        multilingual: REVISE_FOUNDATION_SYSTEM_MULTILINGUAL,
    });
}
/** 이번 호출에 쓸 system. 계약이 없으면 구형 ko 문자열 그대로다. */
export function reviseFoundationSystemFor(context) {
    return pickByFamily(context, {
        ko: REVISE_FOUNDATION_SYSTEM,
        multilingual: REVISE_FOUNDATION_SYSTEM_MULTILINGUAL,
    });
}

const FOUNDATION_LABELS_KO = {
    empty: '  (없음)',
    contradiction: (v) => ` | 모순: ${v}`,
    genre: '## 작품 장르',
    worldFacts: '## 현재 worldFacts',
    characters: '## 현재 인물 (삭제 금지 — 모두 출력에 포함되어야 한다)',
    feedback: '## 발의자 피드백',
    task: '## 과제',
    taskLine: `위 피드백을 반영해 토대를 수정하라. 기존 인물은 절대 삭제하지 말 것.`,
    schema: '## 출력 스키마 (순수 JSON 한 개)',
    existingId: '<기존 인물 id>',
    dimensionKey: '작품별축',
    note: [
        `updatedCharacters 는 변경할 기존 인물만, newCharacters 는 추가할 신규 인물만 포함. 변경 없으면 빈 배열.`,
        `각 필드는 실제로 바꿀 때만 채워라. coreAppearance·aliases·knownFacts 에 빈 배열([])을 보내면 "변경 없음"으로 처리되어 기존 값이 유지된다 (절대 비워지지 않음).`,
    ],
};
const FOUNDATION_LABELS_EN = {
    empty: '  (none)',
    contradiction: (v) => ` | contradiction: ${v}`,
    genre: '## Genre of the work',
    worldFacts: '## Current worldFacts',
    characters: '## Current characters (no removals — every one must appear in your output)',
    feedback: '## Founding author feedback',
    task: '## Task',
    taskLine: 'Revise the Foundation to reflect the feedback above. Never remove an existing character.',
    schema: '## Output schema (one pure JSON object)',
    existingId: '<existing character id>',
    dimensionKey: 'work_specific_axis',
    note: [
        'updatedCharacters holds only existing characters you are changing; newCharacters holds only characters you are adding. Use an empty array when there is nothing to change.',
        'Fill a field only when you actually change it. Sending an empty array ([]) for coreAppearance, aliases or knownFacts means "no change" and keeps the existing value (it never blanks it).',
    ],
};

/** Build the user prompt: current Foundation summary + founder feedback + JSON schema. */
export function buildReviseFoundationUserPrompt(input) {
    const ctx = resolveStepPromptLanguage(input);
    const labels = pickByFamily(ctx, { ko: FOUNDATION_LABELS_KO, multilingual: FOUNDATION_LABELS_EN });
    const worldFactBlock = input.worldFacts.length > 0
        ? input.worldFacts.map((wf) => `  - [${wf.id}] ${wf.statement}`).join('\n')
        : labels.empty;
    // 인물 줄의 키(role/gender/ageBand/aliases)는 기계 이름이라 그대로 두고 값은
    // 작품 데이터다. 한국어 라벨 '모순' 만 계열을 따른다.
    const characterBlock = input.characters.length > 0
        ? input.characters
            .map((c) => `  - [${c.id}] ${c.canonicalName} | role: ${c.role} | gender: ${c.gender} | ageBand: ${c.ageBand}` +
            (c.aliases.length > 0 ? ` | aliases: ${c.aliases.join(', ')}` : '') +
            (c.contradiction.length > 0 ? labels.contradiction(c.contradiction) : ''))
            .join('\n')
        : labels.empty;
    return [
        labels.genre,
        input.genre,
        ``,
        labels.worldFacts,
        worldFactBlock,
        ``,
        labels.characters,
        characterBlock,
        ``,
        labels.feedback,
        input.feedback.slice(0, 6000),
        ``,
        labels.task,
        labels.taskLine,
        ``,
        labels.schema,
        `{`,
        `  "worldFacts": [ { "id": "wf1", "statement": "..." } ],`,
        `  "updatedCharacters": [`,
        `    { "id": "${labels.existingId}", "role": "...", "coreAppearance": ["..."], "aliases": ["..."], "contradiction": "...", "mutable": { "status": "alive", "location": "...", "knownFacts": [] } }`,
        `  ],`,
        `  "newCharacters": [`,
        `    {`,
        `      "id": "c<N>",`,
        `      "canonicalName": "...",`,
        `      "aliases": [],`,
        `      "intrinsic": { "gender": "male|female|nonbinary|unknown|undisclosed|not_applicable|custom", "genderLabel": "", "species": "human", "form": "humanoid", "ageBand": "...", "birthOrder": "not_applicable", "role": "...", "coreAppearance": ["..."], "addressing": {"acceptedPronouns":[],"acceptedGenderedTerms":[],"forbiddenGenderedTerms":[]} },`,
        `      "dramaticModel": { "valueOrder": ["","",""], "behaviorTraits": [{"trigger":"","actionBias":"","benefit":"","cost":""}], "perception": {"seesFirst":[""],"missesFirst":[""]}, "defense":{"public":"","underPressure":""}, "repair":{"firstMove":"","cannotDo":""}, "privateDelights":[""], "unproductiveWant":"", "dimensionBaselines":{"${labels.dimensionKey}":0}, "genreDetails":{} },`,
        `      "mutable": { "status": "alive", "knownFacts": [] },`,
        `      "relationships": [],`,
        `      "contradiction": "..."`,
        `    }`,
        `  ]`,
        `}`,
        ``,
        ...labels.note,
    ].join('\n');
}
