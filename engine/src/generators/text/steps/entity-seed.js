/**
 * ADR-0002 (issue #216) — Entity seed step.
 *
 * Book-create 의 foundationInit 후 호출. genre profile 의 slot 별 seedCount
 * 만큼 entity proposal LLM. cheap model (gpt-5.4-mini). JSON mode. fail-soft:
 * LLM throw / malformed → 빈 list (book-create 자체는 통과, 후속 entity-ops
 * sentinel 가 점진 채움).
 */
import { z } from '../../../core/mini-schema.js';
import { languageSystemLines, pickByFamily, promptFamilyCaptureContext, resolveStepPromptLanguage, } from '../../../core/prompt-language.js';
import { entityProfileFor, ENTITY_KINDS } from '../../../continuity/entity-profile.js';
export const ENTITY_SEED_SYSTEM = [
    '당신은 한국어 웹소설 발의 단계의 entity 디자이너이다.',
    '작품의 brief 와 장르를 읽고 LLM 가 chapter 작성할 때 일관성 보장에 필요한 핵심 entity 들을 미리 등록.',
    '출력은 코드 블록 없이 순수 JSON 한 개:',
    '{ "entities": [ { "kind": "location|monster|item|skill|faction|lore|organization|event|concept", "canonicalName": "...", "aliases": ["..."], "attrs": { ... } } ] }',
    'canonicalName 은 한국어 명사 1-3 어절. aliases 는 1-3 개 (선택).',
    'attrs 는 kind 별 typed (location.tier/climate/owner, monster.species/level, item.type/rarity, skill.tier, etc).',
    'kind 의 분포는 slots 에서 제공된 seedCount 를 따른다.',
    '본문 외 추론 금지 — brief 안 명시되거나 합리적 추론 가능한 entity 만.',
].join(' ');
/**
 * 다국어 계열. `kind` enum·JSON 키·attrs 키는 기계 계약이라 그대로 두고,
 * `canonicalName`/`aliases` 같은 작품 데이터만 목표 작품 언어로 요구한다.
 */
export const ENTITY_SEED_SYSTEM_MULTILINGUAL = [
    'You design the entities registered at a serial-fiction work\'s founding stage.',
    'Read the work\'s brief and genre, and pre-register the core entities a writer needs in order to stay consistent across chapters.',
    'Output one pure JSON object with no code fence:',
    '{ "entities": [ { "kind": "location|monster|item|skill|faction|lore|organization|event|concept", "canonicalName": "...", "aliases": ["..."], "attrs": { ... } } ] }',
    'canonicalName is a short noun phrase (1-3 words) in the target work language. aliases holds 1-3 entries (optional).',
    'attrs is typed per kind (location.tier/climate/owner, monster.species/level, item.type/rarity, skill.tier, etc). Keep kind values and attr keys verbatim; do not translate them.',
    'Follow the seedCount given per kind in slots.',
    'Infer nothing beyond the brief — only entities it states or that follow reasonably from it.',
].join(' ');
/** ADR-0006 promptManifest 수집용 계열 정적 표면. */
export function entitySeedStatic(family) {
    return pickByFamily(promptFamilyCaptureContext(family), {
        ko: ENTITY_SEED_SYSTEM,
        multilingual: ENTITY_SEED_SYSTEM_MULTILINGUAL,
    });
}
/**
 * `input.language` 는 이 단계의 **목표 언어 선택**이다(표시용이 아니다). 검증은
 * `normalizeLanguageTag` 가 하며 허용 목록은 없다 — 식별 가능한 태그면 된다.
 * 승인된 계약(`workContract`/`promptLanguage`)이 함께 오면 계약이 원천이고,
 * `language` 는 일치 확인용이라 어긋나면 조용히 한쪽을 고르지 않고 거부한다.
 */
const SEED_LABELS_KO = {
    workHeading: '## 작품 정보',
    title: (v) => `제목: ${v}`,
    genre: (v) => `장르: ${v}`,
    language: (v) => `언어: ${v}`,
    brief: (v) => `brief: ${v}`,
    slotsHeading: '## 요청 slots (kind: 갯수)',
    slot: (kind, count) => `- ${kind}: ${count}개`,
    request: '위 분포로 entity 들을 propose. JSON 한 개로 출력.',
};
const SEED_LABELS_EN = {
    workHeading: '## Work information',
    title: (v) => `Title: ${v}`,
    genre: (v) => `Genre: ${v}`,
    language: (v) => `Language: ${v}`,
    brief: (v) => `Brief: ${v}`,
    slotsHeading: '## Requested slots (kind: count)',
    slot: (kind, count) => `- ${kind}: ${count}`,
    request: 'Propose entities in that distribution. Output one JSON object.',
};
const seededEntitySchema = z.object({
    kind: z.enum(ENTITY_KINDS),
    canonicalName: z.string().min(1).max(120),
    aliases: z.array(z.string().min(1).max(120)).max(5).default([]),
    attrs: z.record(z.string(), z.unknown()).default({}),
});
const seedResultSchema = z.object({
    entities: z.array(seededEntitySchema).max(50),
});
function tryParse(raw) {
    const fenced = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();
    try {
        return JSON.parse(fenced);
    }
    catch {
        return null;
    }
}
export async function runEntitySeed(input) {
    const profile = entityProfileFor(input.genre);
    if (profile.slots.length === 0)
        return { entities: [] };
    const ctx = resolveStepPromptLanguage(input);
    const labels = pickByFamily(ctx, { ko: SEED_LABELS_KO, multilingual: SEED_LABELS_EN });
    const slotSpec = profile.slots
        .map((s) => labels.slot(s.kind, s.seedCount))
        .join('\n');
    const userPrompt = [
        labels.workHeading,
        labels.title(input.title),
        labels.genre(input.genre),
        // 계약이 정한 목표 언어 태그를 그대로 적는다 — 프롬프트 본문이 지시문과
        // 다른 언어를 말하는 상황을 만들지 않는다.
        labels.language(ctx.language),
        labels.brief(input.brief.slice(0, 4000)),
        ``,
        labels.slotsHeading,
        slotSpec,
        ``,
        labels.request,
    ].join('\n');
    const model = input.seedModel ?? input.writerModel;
    const req = {
        model,
        jsonMode: true,
        step: 'entity-seed',
        messages: [
            {
                role: 'system',
                // entity 이름은 회차 분량과 무관하다 — 계약 지시문에서 분량 줄은 뺀다.
                content: [
                    pickByFamily(ctx, { ko: ENTITY_SEED_SYSTEM, multilingual: ENTITY_SEED_SYSTEM_MULTILINGUAL }),
                    ...languageSystemLines(ctx, { includeChapterLength: false }),
                ].join(' '),
            },
            { role: 'user', content: userPrompt },
        ],
    };
    let text = '';
    try {
        const res = await input.providers.complete(req);
        text = res.text;
    }
    catch {
        return { entities: [] };
    }
    const parsed = tryParse(text);
    if (!parsed)
        return { entities: [] };
    const validated = seedResultSchema.safeParse(parsed);
    if (!validated.success)
        return { entities: [] };
    // Dedupe by canonicalName — LLM 가 종종 같은 이름 중복 propose.
    const seen = new Set();
    const entities = [];
    for (const e of validated.data.entities) {
        if (seen.has(e.canonicalName))
            continue;
        seen.add(e.canonicalName);
        entities.push({
            kind: e.kind,
            canonicalName: e.canonicalName,
            aliases: e.aliases,
            attrs: e.attrs,
        });
    }
    return { entities };
}
