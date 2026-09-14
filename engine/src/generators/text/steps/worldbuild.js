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
import { llmCastDesign } from './cast-design.js';
import { foundationInit } from './foundation-init.js';
function asString(v, fallback = '') {
    return typeof v === 'string' ? v : fallback;
}
function buildWorldbuildPrompt(input) {
    const briefLine = input.brief && input.brief.length > 0 ? `브리프: ${input.brief}` : '';
    return [
        `너는 ${input.language} 소설의 월드빌더다.`,
        '',
        `작품 정보:`,
        `- 제목: ${input.title}`,
        `- 장르: ${input.genre}`,
        `- 목표 화수: ${input.targetChapters}`,
        `- 화당 분량(어림): ${input.chapterWordCount} 단어`,
        briefLine,
        '',
        `과제: 1화 집필을 시작할 수 있도록 작품의 토대를 설계하라.`,
        '',
        `요구사항:`,
        `- premise: 작품 전제 1~2문장. 인물 이름은 아직 등장하지 않아도 된다 (캐스트는 별도 단계).`,
        `- worldFacts: 작품 세계의 영구적 사실 5~10개. 각 사실은 한 문장.`,
        `  - 시간/공간 배경, 마법/시스템 규칙, 정치/조직 구조, 핵심 갈등의 배경 등을 포함.`,
        `  - 인물 개인사보다는 세계 단위 사실 위주로.`,
        `  - 앞으로 추가 등장 인물이 있어도 깨지지 않을 일반적 사실로.`,
        '',
        `반드시 JSON 객체로만 응답하라. 마크다운 코드 펜스, 설명, 주석 금지.`,
        `스키마:`,
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
async function llmWorldbuild(ctx, input) {
    const prompt = buildWorldbuildPrompt(input);
    const res = await ctx.providers.complete({
        model: ctx.model,
        step: 'worldbuild',
        messages: [
            {
                role: 'system',
                content: '한국어 소설 월드빌더. JSON 만 출력. 세계 단위 사실 위주.',
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
 * BookCreate composer matching `TextGeneratorSteps.worldbuild(ctx, input)`.
 *
 * Order: worldbuild → castDesign → genreProfileBind → foundationInit.
 */
export async function performBookCreate(ctx, input) {
    // 3. genreProfileBind — fail fast before LLM spend on unknown genre.
    const registry = createGenreProfileRegistry();
    if (!registry.has(input.genre)) {
        throw new Error(`unsupported genre: ${input.genre}`);
    }
    const genreProfile = registry.get(input.genre);
    // 1. worldbuild
    const world = await llmWorldbuild(ctx, input);
    // 2. castDesign
    const cast = await llmCastDesign(ctx, input, world);
    // 4. foundationInit — T9.1: forward povMode so Foundation.povMode is seeded
    // for N3 cross-check (absent → POV layer falls back to 'limited-third').
    const foundation = foundationInit(ctx, {
        genre: input.genre,
        genreProfile,
        worldFacts: world.worldFacts,
        characters: cast.characters,
        ...(input.povMode ? { povMode: input.povMode } : {}),
    });
    return { foundation: { ...foundation, narrativeSalienceProfile: cast.salienceProfile } };
}
