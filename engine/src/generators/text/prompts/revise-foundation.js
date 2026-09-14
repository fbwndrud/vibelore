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
 */
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
/** Build the user prompt: current Foundation summary + founder feedback + JSON schema. */
export function buildReviseFoundationUserPrompt(input) {
    const worldFactBlock = input.worldFacts.length > 0
        ? input.worldFacts.map((wf) => `  - [${wf.id}] ${wf.statement}`).join('\n')
        : '  (없음)';
    const characterBlock = input.characters.length > 0
        ? input.characters
            .map((c) => `  - [${c.id}] ${c.canonicalName} | role: ${c.role} | gender: ${c.gender} | ageBand: ${c.ageBand}` +
            (c.aliases.length > 0 ? ` | aliases: ${c.aliases.join(', ')}` : '') +
            (c.contradiction.length > 0 ? ` | 모순: ${c.contradiction}` : ''))
            .join('\n')
        : '  (없음)';
    return [
        `## 작품 장르`,
        input.genre,
        ``,
        `## 현재 worldFacts`,
        worldFactBlock,
        ``,
        `## 현재 인물 (삭제 금지 — 모두 출력에 포함되어야 한다)`,
        characterBlock,
        ``,
        `## 발의자 피드백`,
        input.feedback.slice(0, 6000),
        ``,
        `## 과제`,
        `위 피드백을 반영해 토대를 수정하라. 기존 인물은 절대 삭제하지 말 것.`,
        ``,
        `## 출력 스키마 (순수 JSON 한 개)`,
        `{`,
        `  "worldFacts": [ { "id": "wf1", "statement": "..." } ],`,
        `  "updatedCharacters": [`,
        `    { "id": "<기존 인물 id>", "role": "...", "coreAppearance": ["..."], "aliases": ["..."], "contradiction": "...", "mutable": { "status": "alive", "location": "...", "knownFacts": [] } }`,
        `  ],`,
        `  "newCharacters": [`,
        `    {`,
        `      "id": "c<N>",`,
        `      "canonicalName": "...",`,
        `      "aliases": [],`,
        `      "intrinsic": { "gender": "male|female|nonbinary|unknown|undisclosed|not_applicable|custom", "genderLabel": "", "species": "human", "form": "humanoid", "ageBand": "...", "birthOrder": "not_applicable", "role": "...", "coreAppearance": ["..."], "addressing": {"acceptedPronouns":[],"acceptedGenderedTerms":[],"forbiddenGenderedTerms":[]} },`,
        `      "dramaticModel": { "valueOrder": ["","",""], "behaviorTraits": [{"trigger":"","actionBias":"","benefit":"","cost":""}], "perception": {"seesFirst":[""],"missesFirst":[""]}, "defense":{"public":"","underPressure":""}, "repair":{"firstMove":"","cannotDo":""}, "privateDelights":[""], "unproductiveWant":"", "dimensionBaselines":{"작품별축":0}, "genreDetails":{} },`,
        `      "mutable": { "status": "alive", "knownFacts": [] },`,
        `      "relationships": [],`,
        `      "contradiction": "..."`,
        `    }`,
        `  ]`,
        `}`,
        ``,
        `updatedCharacters 는 변경할 기존 인물만, newCharacters 는 추가할 신규 인물만 포함. 변경 없으면 빈 배열.`,
        `각 필드는 실제로 바꿀 때만 채워라. coreAppearance·aliases·knownFacts 에 빈 배열([])을 보내면 "변경 없음"으로 처리되어 기존 값이 유지된다 (절대 비워지지 않음).`,
    ].join('\n');
}
