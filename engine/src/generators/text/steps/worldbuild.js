/**
 * BookCreate composer — single function matching `TextGeneratorSteps.worldbuild`.
 *
 * Composes 4 sub-steps in order:
 *   1. worldbuild        — LLM produces { premise, worldFacts[] }
 *   2. castDesign        — LLM produces { characters[] } using worldbuild output
 *   3. genreProfileBind  — registry lookup; throws on unknown genre
 *   4. foundationInit    — assemble Foundation with everything wired
 *
 * The composed function is what gets plugged into
 * `TextGeneratorSteps.worldbuild` in the public surface (the name overload is
 * a historical artefact of the design — the step is the first of four in the
 * book-create path, and the shell uses the first step's name as the function
 * identifier).
 */
import { createGenreProfileRegistry } from '../../../continuity/genre-profile.js';
import {
    formatLengthTarget, languageSystemLines, pickByFamily, promptFamilyCaptureContext, resolveDialogueBreakMode,
    resolvePromptLanguageContext,
} from '../../../core/prompt-language.js';
import {
    checkFoundationApproval,
    isExplicitFoundationNewContract,
} from '../foundation-validation.js';
import { withGateContext } from '../chapter-validation.js';
import { llmCastDesign } from './cast-design.js';
import { foundationInit } from './foundation-init.js';
function asString(v, fallback = '') {
    return typeof v === 'string' ? v : fallback;
}
/**
 * book-create 입력의 언어 컨텍스트.
 *
 * - `workContract` 가 있으면 그것이 원천이고 함께 온 `language`/`chapterWordCount`
 *   는 확인용이다(어긋나면 조용히 고르지 않고 오류).
 * - 구형 `chapterWordCount` 는 이름 그대로 `legacyCodeUnits` 목표다. 호출자가 적지
 *   않았다면 중복 지정이 아니므로 아예 넘기지 않는다.
 * - 언어도 계약도 없으면 구형 ko 해석이라 프롬프트가 기존과 동일하다.
 */
export function bookCreateLanguageContext(input) {
    const hasLegacyTarget = input.chapterWordCount !== undefined && input.chapterWordCount !== null;
    return resolvePromptLanguageContext({
        workContract: input.workContract ?? null,
        language: input.language ?? null,
        length: input.length ?? null,
        legacyLength: hasLegacyTarget ? { chapterWordCount: input.chapterWordCount } : null,
    });
}
const WORLDBUILD_LABELS_KO = {
    header: (ctx) => `너는 ${ctx.language} 소설의 월드빌더다.`,
    workHeading: `작품 정보:`,
    title: (v) => `- 제목: ${v}`,
    genre: (v) => `- 장르: ${v}`,
    targetChapters: (v) => `- 목표 화수: ${v}`,
    // 계약 단위를 그대로 부른다. 구형 legacyCodeUnits 는 기존 문구 유지.
    length: (ctx) => ctx.length.unit === 'legacyCodeUnits'
        ? `- 화당 분량(어림): ${formatLengthTarget(ctx)} 단어`
        : `- 화당 분량(어림): ${formatLengthTarget(ctx)}`,
    brief: (v) => `브리프: ${v}`,
    task: `과제: 1화 집필을 시작할 수 있도록 작품의 토대를 설계하라.`,
    requirements: [
        `요구사항:`,
        `- premise: 작품 전제 1~2문장. 인물 이름은 아직 등장하지 않아도 된다 (캐스트는 별도 단계).`,
        `- worldFacts: 작품 세계의 영구적 사실 5~10개. 각 사실은 한 문장.`,
        `  - 시간/공간 배경, 마법/시스템 규칙, 정치/조직 구조, 핵심 갈등의 배경 등을 포함.`,
        `  - 인물 개인사보다는 세계 단위 사실 위주로.`,
        `  - 앞으로 추가 등장 인물이 있어도 깨지지 않을 일반적 사실로.`,
    ],
    output: `반드시 JSON 객체로만 응답하라. 마크다운 코드 펜스, 설명, 주석 금지.`,
    schema: `스키마:`,
};
const WORLDBUILD_LABELS_EN = {
    header: () => 'You are the worldbuilder for a novel written in the target work language.',
    workHeading: 'Work information:',
    title: (v) => `- Title: ${v}`,
    genre: (v) => `- Genre: ${v}`,
    targetChapters: (v) => `- Target chapter count: ${v}`,
    length: (ctx) => `- Approximate length per chapter: ${formatLengthTarget(ctx)}`,
    brief: (v) => `Brief: ${v}`,
    task: 'Task: design the foundation of the work so chapter 1 can be written.',
    requirements: [
        'Requirements:',
        '- premise: 1-2 sentences of premise, in the target work language. Character names are not needed yet (the cast is a separate step).',
        '- worldFacts: 5-10 permanent facts about the world, one sentence each, in the target work language.',
        '  - Cover the time and place, the rules of magic or the system, political and organisational structure, and the background of the central conflict.',
        '  - Prefer world-level facts over the personal history of individual characters.',
        '  - State them so they still hold once more characters appear.',
    ],
    output: 'Respond with a single JSON object only. No markdown code fence, no explanation, no comments.',
    schema: 'Schema:',
};
function buildWorldbuildPrompt(input, context) {
    const ctx = resolvePromptLanguageContext(context ?? {});
    const labels = pickByFamily(ctx, { ko: WORLDBUILD_LABELS_KO, multilingual: WORLDBUILD_LABELS_EN });
    const briefLine = input.brief && input.brief.length > 0 ? labels.brief(input.brief) : '';
    return [
        labels.header(ctx),
        '',
        labels.workHeading,
        labels.title(input.title),
        labels.genre(input.genre),
        labels.targetChapters(input.targetChapters),
        labels.length(ctx),
        briefLine,
        '',
        labels.task,
        '',
        ...labels.requirements,
        '',
        labels.output,
        labels.schema,
        // JSON 스키마 키는 기계 계약이라 두 계열에서 동일하다.
        `{`,
        `  "premise": "...",`,
        `  "worldFacts": [`,
        `    { "id": "wf1", "statement": "..." }`,
        `  ]`,
        `}`,
    ]
        .filter((line) => line !== '')
        .join('\n');
}
/** 계열별 worldbuild system. ko 값은 기존 문자열과 동일하다. */
export const WORLDBUILD_STEP_SYSTEM = '한국어 소설 월드빌더. JSON 만 출력. 세계 단위 사실 위주.';
export const WORLDBUILD_STEP_SYSTEM_MULTILINGUAL = 'Worldbuilder for a novel in the target work language. Output JSON only. Prefer world-level facts. Keep JSON keys and ids verbatim.';
/** ADR-0006 promptManifest 수집용 계열 정적 표면. */
export function worldbuildSystemStatic(family) {
    return pickByFamily(promptFamilyCaptureContext(family), {
        ko: WORLDBUILD_STEP_SYSTEM,
        multilingual: WORLDBUILD_STEP_SYSTEM_MULTILINGUAL,
    });
}
async function llmWorldbuild(ctx, input, promptLanguage) {
    const prompt = buildWorldbuildPrompt(input, promptLanguage);
    const res = await ctx.providers.complete({
        model: ctx.model,
        step: 'worldbuild',
        messages: [
            {
                role: 'system',
                content: [
                    pickByFamily(promptLanguage, {
                        ko: WORLDBUILD_STEP_SYSTEM,
                        multilingual: WORLDBUILD_STEP_SYSTEM_MULTILINGUAL,
                    }),
                    // 회차 분량은 user 프롬프트의 작품 정보가 말한다 — system 에 같은
                    // 수치를 다시 싣지 않는다.
                    ...languageSystemLines(promptLanguage, { includeChapterLength: false }),
                ].join(' '),
            },
            { role: 'user', content: prompt },
        ],
        jsonMode: true,
    });
    let parsed;
    try {
        parsed = JSON.parse(res.text);
    }
    catch {
        throw new Error('worldbuild parse failed');
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('worldbuild parse failed');
    }
    const obj = parsed;
    const premise = asString(obj.premise).trim();
    if (premise.length === 0) {
        throw new Error('worldbuild parse failed');
    }
    const rawFacts = obj.worldFacts;
    if (rawFacts !== undefined && !Array.isArray(rawFacts)) {
        throw new Error('worldbuild parse failed');
    }
    const seenIds = new Set();
    const worldFacts = [];
    let autoSeq = 1;
    for (const item of Array.isArray(rawFacts) ? rawFacts : []) {
        if (typeof item !== 'object' || item === null)
            continue;
        const factObj = item;
        const statement = asString(factObj.statement).trim();
        if (statement.length === 0)
            continue;
        let id = asString(factObj.id).trim();
        if (id.length === 0 || seenIds.has(id)) {
            // Auto-id: walk forward until we find a free wf<N>.
            while (seenIds.has(`wf${autoSeq}`))
                autoSeq += 1;
            id = `wf${autoSeq}`;
            autoSeq += 1;
        }
        seenIds.add(id);
        worldFacts.push({ id, statement, registeredAtChapter: 1 });
    }
    return { premise, worldFacts };
}
/**
 * Generate a Foundation candidate for hosts that add seed/human fields before
 * their own final approval gate. This return value is not an approval or receipt.
 * Order: worldbuild → castDesign → genreProfileBind → foundationInit.
 */
export async function prepareBookFoundationCandidate(ctx, input) {
    // 3. genreProfileBind — fail fast before LLM spend on unknown genre.
    const registry = createGenreProfileRegistry();
    if (!registry.has(input.genre)) {
        throw new Error(`unsupported genre: ${input.genre}`);
    }
    const genreProfile = registry.get(input.genre);
    // 다국어 Phase 2A — 두 LLM 단계(worldbuild / castDesign)가 같은 계약을 본다.
    // 불일치(계약 언어 ≠ 요청 언어, 계약 분량 ≠ chapterWordCount)는 오류다.
    let promptLanguage = bookCreateLanguageContext(input);
    if (isExplicitFoundationNewContract(ctx, input)) {
        const mode = resolveDialogueBreakMode(promptLanguage, input.dialogueBreakMode ?? ctx.dialogueBreakMode ?? null);
        const contract = { ...promptLanguage.contract,
            formatPolicy: { ...promptLanguage.contract.formatPolicy, dialogueBreakMode: mode } };
        input = { ...input, workContract: contract };
        promptLanguage = bookCreateLanguageContext(input);
    }
    // 1. worldbuild
    const world = await llmWorldbuild(ctx, input, promptLanguage);
    // 2. castDesign
    const cast = await llmCastDesign(ctx, input, world, promptLanguage);
    // 4. foundationInit — T9.1: forward povMode so Foundation.povMode is seeded
    // for N3 cross-check (absent → POV layer falls back to 'limited-third').
    const foundation = foundationInit(ctx, {
        genre: input.genre,
        genreProfile,
        worldFacts: world.worldFacts,
        characters: cast.characters,
        ...(input.povMode ? { povMode: input.povMode } : {}),
    });
    const created = {
        foundation: {
            ...foundation,
            narrativeSalienceProfile: cast.salienceProfile,
            ...creationLanguageMetadata(input, promptLanguage),
        },
    };
    return created;
}

/** Generate and validate an activation-ready public Foundation. */
export async function performBookCreate(ctx, input) {
    const created = await prepareBookFoundationCandidate(ctx, input);
    const promptLanguage = created.foundation.workContract
        ? resolvePromptLanguageContext({ workContract: created.foundation.workContract })
        : bookCreateLanguageContext(input);
    const gateCtx = withGateContext(ctx, input);
    if (!isExplicitFoundationNewContract(gateCtx, input))
        return created;
    const checked = await checkFoundationApproval(gateCtx, {
        foundation: created.foundation,
        revision: 1,
        promptLanguage,
        workContract: input.workContract ?? promptLanguage.contract,
        language: input.language,
        planSource: {
            kind: 'foundation',
            title: input.title,
            genre: input.genre,
            brief: input.brief ?? '',
            revision: 1,
        },
        validationReceipt: input.validationReceipt,
        languageCompliance: input.languageCompliance,
    });
    return {
        foundation: checked.foundation,
        canonicalApprovalArtifact: checked.canonicalApprovalArtifact,
        validationReceipt: checked.validationReceipt,
    };
}
/**
 * 생성 시점의 언어 메타데이터.
 *
 * 명시된 `language`/`workContract` 가 후속 공개 단계(집필·요약·발행)까지 남도록
 * Foundation 에 함께 싣는다. 값의 출처는 하나(계약)이며 여기서 새 수용 계약을
 * 만들지 않는다 — 승인·영수증은 phase 3 소유다.
 *
 *   - `language` / `canonicalFormatVersion`: 정본 Markdown frontmatter 로 직렬화될
 *     최소 필드(phase 1 소유자 합의).
 *   - `length` / `workContract`: sidecar 속성으로 보존되는 계약 원문.
 *
 * **언어도 계약도 명시되지 않은 구형 호출은 키를 하나도 얻지 않는다** — 기존
 * 출력 shape 를 그대로 유지한다(암묵적 ko 를 새 메타데이터로 굳히지 않는다).
 */
function creationLanguageMetadata(input, promptLanguage) {
    const explicitLanguage = input.language !== undefined && input.language !== null;
    const explicitContract = input.workContract !== undefined && input.workContract !== null;
    if (!explicitLanguage && !explicitContract)
        return {};
    const contract = promptLanguage.contract;
    return {
        language: contract.language,
        canonicalFormatVersion: contract.formatPolicy.canonicalFormatVersion,
        length: { unit: contract.length.unit, target: contract.length.target },
        // 호출자가 승인된 계약을 넘겼으면 그 객체를 그대로 보존한다.
        workContract: explicitContract ? input.workContract : contract,
    };
}
