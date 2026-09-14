/**
 * ADR-0002 (issue #216) — Entity seed step.
 *
 * Book-create 의 foundationInit 후 호출. genre profile 의 slot 별 seedCount
 * 만큼 entity proposal LLM. cheap model (gpt-5.4-mini). JSON mode. fail-soft:
 * LLM throw / malformed → 빈 list (book-create 자체는 통과, 후속 entity-ops
 * sentinel 가 점진 채움).
 */
import { z } from '../../../core/mini-schema.js';
import { entityProfileFor, ENTITY_KINDS } from '../../../continuity/entity-profile.js';
const ENTITY_SEED_SYSTEM = [
    '당신은 한국어 웹소설 발의 단계의 entity 디자이너이다.',
    '작품의 brief 와 장르를 읽고 LLM 가 chapter 작성할 때 일관성 보장에 필요한 핵심 entity 들을 미리 등록.',
    '출력은 코드 블록 없이 순수 JSON 한 개:',
    '{ "entities": [ { "kind": "location|monster|item|skill|faction|lore|organization|event|concept", "canonicalName": "...", "aliases": ["..."], "attrs": { ... } } ] }',
    'canonicalName 은 한국어 명사 1-3 어절. aliases 는 1-3 개 (선택).',
    'attrs 는 kind 별 typed (location.tier/climate/owner, monster.species/level, item.type/rarity, skill.tier, etc).',
    'kind 의 분포는 slots 에서 제공된 seedCount 를 따른다.',
    '본문 외 추론 금지 — brief 안 명시되거나 합리적 추론 가능한 entity 만.',
].join(' ');
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
    const slotSpec = profile.slots
        .map((s) => `- ${s.kind}: ${s.seedCount}개`)
        .join('\n');
    const userPrompt = [
        `## 작품 정보`,
        `제목: ${input.title}`,
        `장르: ${input.genre}`,
        `언어: ${input.language}`,
        `brief: ${input.brief.slice(0, 4000)}`,
        ``,
        `## 요청 slots (kind: 갯수)`,
        slotSpec,
        ``,
        `위 분포로 entity 들을 propose. JSON 한 개로 출력.`,
    ].join('\n');
    const model = input.seedModel ?? input.writerModel;
    const req = {
        model,
        jsonMode: true,
        step: 'entity-seed',
        messages: [
            { role: 'system', content: ENTITY_SEED_SYSTEM },
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
