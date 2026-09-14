/**
 * GenreContinuityProfile — registry of genre-driven tracked entities + invariants.
 *
 * The supported genre identifiers remain stable for saved works. Their
 * provenance is recorded in docs/PROVENANCE.md; labels do not select a
 * separate generation engine.
 *
 * The profile is *data*, not code branches. A new genre = add an
 * `ENGINE_GENRES` entry + register a profile. Implementation in T2.5.
 */
/**
 * Engine genre vocabulary. Each identifier maps to the tracked entities and
 * invariants defined in this registry.
 */
export const ENGINE_GENRES = [
    // Serialized identifiers; retain order for clients displaying this list.
    'streaming-litrpg',
    'regression-hunter',
    'villainess-isekai',
    'academy-fantasy',
    'noble-clan-regression',
    'banishment-revenge',
    'mystery-thriller',
    'action',
    'comedy',
    'historical',
    'litrpg',
    'progression',
    'system-apocalypse',
    'tower-climber',
    'isekai',
    'cultivation',
    'xianxia',
    'xuanhuan',
    'dungeon-core',
    'romantasy',
    'sci-fi',
    'horror',
    'cozy',
    'urban',
    'other',
];
/**
 * Build the canonical registry. Per T2.5:
 *   - All 25 ids registered (no gaps).
 *   - Priority depth: 회귀계열 (Timeline + RegressionKnowledge),
 *     로맨스계열 (RelationshipState), 수련/판타지계열 (PowerSystem + Artifact).
 *   - Remaining ids get the base profile (no extra tracked entities — just
 *     the always-on base: Character + AddressMap + HookState in StoryState).
 */
const ENGINE_GENRE_SET = new Set(ENGINE_GENRES);
const REGRESSION_FAMILY = new Set([
    'regression-hunter',
    'noble-clan-regression',
    'villainess-isekai',
    'isekai',
]);
const ROMANCE_FAMILY = new Set([
    'romantasy',
    'villainess-isekai',
]);
const POWER_FAMILY = new Set([
    'cultivation',
    'xianxia',
    'xuanhuan',
    'litrpg',
    'progression',
    'tower-climber',
    'system-apocalypse',
    'dungeon-core',
    'academy-fantasy',
    'streaming-litrpg',
]);
const MYSTERY_FAMILY = new Set([
    'mystery-thriller',
]);
// T11.2 — eraResearch=true 장르. 시대 고증 LLM cross-check 활성.
const ERA_RESEARCH_GENRES = new Set([
    'urban',
    'historical',
    'mystery-thriller',
]);
const REGRESSION_ENTITIES = [
    { kind: 'Timeline', description: '전생/현생 듀얼 타임라인 추적' },
    {
        kind: 'RegressionKnowledge',
        description: '회귀 시점 이전 사건 지식 — 회귀 이후 활용 제한',
    },
];
const REGRESSION_INVARIANTS = [
    {
        id: 'timeline-causality',
        severity: 'hard',
        description: '전생 사건은 현생 시점 이후로 위치 금지',
    },
    {
        id: 'regression-knowledge-bound',
        severity: 'hard',
        description: '회귀 지식은 회귀 시점 이전 발생 사실로만',
    },
];
const ROMANCE_ENTITIES = [
    {
        kind: 'RelationshipState',
        description: '관계 단계 머신 (모름→인지→호감→연인→…)',
    },
];
const ROMANCE_INVARIANTS = [
    {
        id: 'relationship-no-backwards',
        severity: 'soft',
        description: '관계 단계 역행은 명시 사건 동반 시만',
    },
];
const POWER_ENTITIES = [
    { kind: 'PowerSystem', description: '경지 / 스탯 / 레벨 상태 추적' },
    { kind: 'Artifact', description: '아이템/유물 소유자 및 속성 추적' },
];
const POWER_INVARIANTS = [
    {
        id: 'power-no-backwards',
        severity: 'hard',
        description: '경지 역행 금지 (서사 사건 동반 시 예외 허용)',
    },
    {
        id: 'artifact-owner-tracked',
        severity: 'soft',
        description: '아이템 소유자 이동은 명시 사건 동반 필요',
    },
];
const MYSTERY_ENTITIES = [
    { kind: 'Clue', description: '단서 공개/미공개 상태 추적' },
    {
        kind: 'KnowledgeMatrix',
        description: '캐릭터별 단서 인지 매트릭스 — 정보 비대칭',
    },
];
const MYSTERY_INVARIANTS = [
    {
        id: 'no-undisclosed-clue-leak',
        severity: 'hard',
        description: '미공개 단서를 무인지 캐릭터가 활용 금지',
    },
];
const DIALOGUE_RATIO_RANGE = {
    'streaming-litrpg': [0.15, 0.45],
    'regression-hunter': [0.2, 0.45],
    'villainess-isekai': [0.3, 0.55],
    'academy-fantasy': [0.25, 0.5],
    'noble-clan-regression': [0.2, 0.45],
    'banishment-revenge': [0.15, 0.4],
    'mystery-thriller': [0.2, 0.5],
    action: [0.1, 0.35],
    comedy: [0.35, 0.65],
    historical: [0.15, 0.4],
    litrpg: [0.15, 0.4],
    progression: [0.15, 0.4],
    'system-apocalypse': [0.15, 0.4],
    'tower-climber': [0.15, 0.4],
    isekai: [0.2, 0.5],
    cultivation: [0.1, 0.35],
    xianxia: [0.1, 0.35],
    xuanhuan: [0.1, 0.35],
    'dungeon-core': [0.1, 0.35],
    romantasy: [0.3, 0.6],
    'sci-fi': [0.2, 0.45],
    horror: [0.1, 0.35],
    cozy: [0.3, 0.55],
    urban: [0.2, 0.5],
    other: [0.15, 0.5],
};
function buildProfile(genre) {
    const trackedEntities = [];
    const invariants = [];
    const seenKinds = new Set();
    const seenInvariantIds = new Set();
    const pushEntities = (specs) => {
        for (const spec of specs) {
            if (seenKinds.has(spec.kind))
                continue;
            seenKinds.add(spec.kind);
            trackedEntities.push(spec);
        }
    };
    const pushInvariants = (rules) => {
        for (const rule of rules) {
            if (seenInvariantIds.has(rule.id))
                continue;
            seenInvariantIds.add(rule.id);
            invariants.push(rule);
        }
    };
    if (REGRESSION_FAMILY.has(genre)) {
        pushEntities(REGRESSION_ENTITIES);
        pushInvariants(REGRESSION_INVARIANTS);
    }
    if (ROMANCE_FAMILY.has(genre)) {
        pushEntities(ROMANCE_ENTITIES);
        pushInvariants(ROMANCE_INVARIANTS);
    }
    if (POWER_FAMILY.has(genre)) {
        pushEntities(POWER_ENTITIES);
        pushInvariants(POWER_INVARIANTS);
    }
    if (MYSTERY_FAMILY.has(genre)) {
        pushEntities(MYSTERY_ENTITIES);
        pushInvariants(MYSTERY_INVARIANTS);
    }
    return {
        genre,
        trackedEntities,
        invariants,
        dialogueRatioRange: DIALOGUE_RATIO_RANGE[genre],
        eraResearch: ERA_RESEARCH_GENRES.has(genre),
    };
}
export function createGenreProfileRegistry() {
    const profiles = new Map();
    for (const genre of ENGINE_GENRES) {
        profiles.set(genre, buildProfile(genre));
    }
    return {
        get(genre) {
            const profile = profiles.get(genre);
            if (!profile) {
                throw new Error(`GenreProfileRegistry: 등록되지 않은 genre "${genre}" — ENGINE_GENRES 와 동기화 깨짐`);
            }
            return profile;
        },
        has(genre) {
            return ENGINE_GENRE_SET.has(genre);
        },
        all() {
            return Array.from(profiles.values());
        },
    };
}
