/**
 * ADR-0002 (issue #216) — Entity Ontology profile.
 *
 * Genre 별 entity seed template. 발의 시 entity-seed.ts 가 어떤 kind 의
 * entity 를 몇 개 LLM 로 propose 할지 결정. 본 PR scope =  minimal default
 * profile + 1 genre override (streaming-litrpg) — 후속 PR 가 16+ genre 채움.
 */
import { z } from '../core/mini-schema.js';
export const ENTITY_KINDS = [
    'location',
    'monster',
    'item',
    'skill',
    'faction',
    'lore',
    'organization',
    'event',
    'concept',
];
/**
 * Per-kind attrs schema — kind 별 typed attribute. zod passthrough 로 추가
 * 필드 허용 (LLM 가 임의 키 채워 보낼 수 있음).
 */
export const ATTRS_SCHEMAS = {
    location: z
        .object({
        tier: z.string().optional(),
        climate: z.string().optional(),
        owner: z.string().optional(),
    })
        .passthrough(),
    monster: z
        .object({
        species: z.string().optional(),
        level: z.number().optional(),
        affinity: z.string().optional(),
    })
        .passthrough(),
    item: z
        .object({
        type: z.string().optional(),
        rarity: z.string().optional(),
        owner: z.string().optional(),
    })
        .passthrough(),
    skill: z
        .object({
        type: z.string().optional(),
        tier: z.string().optional(),
    })
        .passthrough(),
    faction: z
        .object({
        side: z.string().optional(),
    })
        .passthrough(),
    lore: z.object({}).passthrough(),
    organization: z.object({}).passthrough(),
    event: z
        .object({
        occurredAtChapter: z.number().optional(),
    })
        .passthrough(),
    concept: z.object({}).passthrough(),
};
/**
 * Conservative default — 모든 genre 가 location/item/monster minimum.
 * genre-specific override 가 없는 경우 사용.
 */
export const DEFAULT_ENTITY_PROFILE = {
    genre: 'default',
    slots: [
        { kind: 'location', seedCount: 3, autoRegisterOnMention: true },
        { kind: 'item', seedCount: 3, autoRegisterOnMention: true },
        { kind: 'monster', seedCount: 2, autoRegisterOnMention: true },
        { kind: 'faction', seedCount: 1, autoRegisterOnMention: false },
    ],
};
/**
 * Streaming-litrpg specific — 시스템 / 스킬 / 던전 강조.
 */
export const STREAMING_LITRPG_PROFILE = {
    genre: 'streaming-litrpg',
    slots: [
        { kind: 'location', seedCount: 3, autoRegisterOnMention: true },
        { kind: 'faction', seedCount: 2, autoRegisterOnMention: false },
        { kind: 'item', seedCount: 5, autoRegisterOnMention: true },
        { kind: 'skill', seedCount: 4, autoRegisterOnMention: true },
        { kind: 'monster', seedCount: 3, autoRegisterOnMention: true },
    ],
};
const PROFILES_BY_GENRE = {
    'streaming-litrpg': STREAMING_LITRPG_PROFILE,
};
export function entityProfileFor(genre) {
    if (!genre)
        return DEFAULT_ENTITY_PROFILE;
    return PROFILES_BY_GENRE[genre] ?? DEFAULT_ENTITY_PROFILE;
}
