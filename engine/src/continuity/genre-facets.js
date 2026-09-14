/**
 * GenreFacets — 장르 → worldview facet preset 매핑 (Worldview Surface W-A, #374).
 *
 * Worldview studio (작성 전 세계관 빌드) 가 worldFact 입력 폼을 장르별로 다르게
 * 그리기 위한 데이터. facet 라벨은 hardcode enum 이 아니라 genre-driven —
 * 장르 전환 시 카테고리·축 폼이 통째로 바뀐다 (worldview-studio.plan §3.6).
 *
 * 두 축:
 *   - `facets` — 작가가 채우는 worldFact 카테고리 (key + 한국어 라벨). worldFact.facetKey
 *     가 이 key 로 분류된다. 작가 자유 facet 추가는 별도 (preset 외 임의 key).
 *   - `trackedAxes` — 그 장르가 StoryState 에서 추적하는 축. `GenreProfile.trackedEntities`
 *     의 `kind` 와 1:1 정합해야 한다 (genre-profile.ts 의 family 매핑 참조).
 *
 * 25 장르 (`ENGINE_GENRES`) 전부 키를 가진다. 대표 장르는 plan §3.6 표 14행 그대로,
 * 나머지는 범용 facet (`GENERIC_FACETS`) 로 채운다 (action / comedy / other 등).
 */
import { ENGINE_GENRES } from './genre-profile.js';
// 공통 / 범용 facet — preset 표에 없는 장르 (action/comedy/other 등) 의 기본 골격.
const GENERIC_FACETS = [
    { key: 'setting', label: '세계 배경' },
    { key: 'factions', label: '세력' },
    { key: 'characters', label: '인물' },
    { key: 'rules', label: '세계 규칙' },
];
// trackedAxes 상수 — genre-profile.ts 의 family entity kind 와 동일 문자열.
const POWER = ['PowerSystem', 'Artifact'];
const REGRESSION = ['Timeline', 'RegressionKnowledge'];
const ROMANCE = ['RelationshipState'];
const MYSTERY = ['Clue', 'KnowledgeMatrix'];
/**
 * 25 장르 전부 매핑. 대표 장르는 plan §3.6 표대로, 나머지는 GENERIC_FACETS.
 * trackedAxes 는 해당 장르의 GenreProfile family 와 일치해야 한다.
 */
export const GENRE_FACETS = {
    'streaming-litrpg': {
        facets: [
            { key: 'system-rules', label: '시스템 규칙' },
            { key: 'stat-skill', label: '스탯·스킬 체계' },
            { key: 'dungeon-structure', label: '던전·층 구조' },
            { key: 'guilds', label: '길드·세력' },
        ],
        trackedAxes: POWER,
    },
    'regression-hunter': {
        facets: [
            { key: 'pre-regression-world', label: '회귀 전 세계' },
            { key: 'post-regression-change', label: '회귀 후 변화' },
            { key: 'faction-map', label: '세력 구도' },
            { key: 'revenge-targets', label: '복수 대상' },
            { key: 'geography', label: '지리' },
        ],
        trackedAxes: REGRESSION,
    },
    'villainess-isekai': {
        facets: [
            { key: 'original-setting', label: '원작 설정' },
            { key: 'possession-point', label: '빙의 시점' },
            { key: 'factions', label: '등장 세력' },
            { key: 'status-house', label: '신분·가문' },
        ],
        // villainess-isekai 는 REGRESSION + ROMANCE family 양쪽 (genre-profile.ts).
        trackedAxes: [...REGRESSION, ...ROMANCE],
    },
    'academy-fantasy': {
        facets: [
            { key: 'academy-system', label: '학원 체계' },
            { key: 'magic-system', label: '마법·능력 체계' },
            { key: 'cliques', label: '학파·파벌' },
            { key: 'campus-rules', label: '교내 규칙' },
        ],
        trackedAxes: POWER,
    },
    'noble-clan-regression': {
        facets: [
            { key: 'pre-regression-world', label: '회귀 전 세계' },
            { key: 'post-regression-change', label: '회귀 후 변화' },
            { key: 'faction-map', label: '세력 구도' },
            { key: 'revenge-targets', label: '복수 대상' },
            { key: 'geography', label: '지리' },
        ],
        trackedAxes: REGRESSION,
    },
    'banishment-revenge': {
        facets: [
            { key: 'pre-regression-world', label: '회귀 전 세계' },
            { key: 'post-regression-change', label: '회귀 후 변화' },
            { key: 'faction-map', label: '세력 구도' },
            { key: 'revenge-targets', label: '복수 대상' },
            { key: 'geography', label: '지리' },
        ],
        // banishment-revenge 는 genre-profile.ts REGRESSION_FAMILY 미포함 → 추적 축 없음
        // (회귀 facet 라벨은 노출하되 Timeline/RegressionKnowledge 자동 추적은 안 함).
        trackedAxes: [],
    },
    'mystery-thriller': {
        facets: [
            { key: 'case-structure', label: '사건 구조' },
            { key: 'character-relations', label: '인물 관계' },
            { key: 'clues', label: '단서' },
            { key: 'locations', label: '배경 장소' },
            { key: 'rules', label: '규칙' },
        ],
        trackedAxes: MYSTERY,
    },
    action: { facets: GENERIC_FACETS, trackedAxes: [] },
    comedy: { facets: GENERIC_FACETS, trackedAxes: [] },
    historical: {
        facets: [
            { key: 'era', label: '시대 배경' },
            { key: 'power-structure', label: '권력 구도' },
            { key: 'status-system', label: '신분·제도' },
            { key: 'geography', label: '지리' },
            { key: 'customs', label: '풍습' },
        ],
        // historical 은 eraResearch=true (시대 고증) — 추적 entity 는 base only.
        trackedAxes: [],
    },
    litrpg: {
        facets: [
            { key: 'system-rules', label: '시스템 규칙' },
            { key: 'stat-skill', label: '스탯·스킬 체계' },
            { key: 'dungeon-structure', label: '던전·층 구조' },
            { key: 'guilds', label: '길드·세력' },
        ],
        trackedAxes: POWER,
    },
    progression: {
        facets: [
            { key: 'system-rules', label: '시스템 규칙' },
            { key: 'stat-skill', label: '스탯·스킬 체계' },
            { key: 'dungeon-structure', label: '던전·층 구조' },
            { key: 'guilds', label: '길드·세력' },
        ],
        trackedAxes: POWER,
    },
    'system-apocalypse': {
        facets: [
            { key: 'system-descent', label: '시스템 강림 규칙' },
            { key: 'mutants-monsters', label: '변이·몬스터' },
            { key: 'survivor-factions', label: '생존 세력' },
            { key: 'ruined-geography', label: '폐허 지리' },
        ],
        trackedAxes: POWER,
    },
    'tower-climber': {
        facets: [
            { key: 'system-rules', label: '시스템 규칙' },
            { key: 'stat-skill', label: '스탯·스킬 체계' },
            { key: 'dungeon-structure', label: '던전·층 구조' },
            { key: 'guilds', label: '길드·세력' },
        ],
        trackedAxes: POWER,
    },
    isekai: {
        facets: [
            { key: 'original-setting', label: '원작 설정' },
            { key: 'possession-point', label: '빙의 시점' },
            { key: 'factions', label: '등장 세력' },
            { key: 'status-house', label: '신분·가문' },
        ],
        trackedAxes: REGRESSION,
    },
    cultivation: {
        facets: [
            { key: 'cultivation-system', label: '수련체계' },
            { key: 'sects', label: '문파·세력' },
            { key: 'elixirs-treasures', label: '영약·법보' },
            { key: 'jianghu-geography', label: '강호 지리' },
            { key: 'martial-rules', label: '무림 규칙' },
        ],
        trackedAxes: POWER,
    },
    xianxia: {
        facets: [
            { key: 'cultivation-system', label: '수련체계' },
            { key: 'sects', label: '문파·세력' },
            { key: 'elixirs-treasures', label: '영약·법보' },
            { key: 'jianghu-geography', label: '강호 지리' },
            { key: 'martial-rules', label: '무림 규칙' },
        ],
        trackedAxes: POWER,
    },
    xuanhuan: {
        facets: [
            { key: 'cultivation-system', label: '수련체계' },
            { key: 'sects', label: '문파·세력' },
            { key: 'elixirs-treasures', label: '영약·법보' },
            { key: 'jianghu-geography', label: '강호 지리' },
            { key: 'martial-rules', label: '무림 규칙' },
        ],
        trackedAxes: POWER,
    },
    'dungeon-core': {
        facets: [
            { key: 'system-rules', label: '시스템 규칙' },
            { key: 'stat-skill', label: '스탯·스킬 체계' },
            { key: 'dungeon-structure', label: '던전·층 구조' },
            { key: 'guilds', label: '길드·세력' },
        ],
        trackedAxes: POWER,
    },
    romantasy: {
        facets: [
            { key: 'setting', label: '세계 배경' },
            { key: 'houses-nobility', label: '가문·귀족' },
            { key: 'relationship-map', label: '관계 구도' },
            { key: 'society-rules', label: '사교계 규칙' },
        ],
        trackedAxes: ROMANCE,
    },
    'sci-fi': {
        facets: [
            { key: 'tech-system', label: '기술체계' },
            { key: 'factions', label: '세력·진영' },
            { key: 'planets-stations', label: '행성·정거장' },
            { key: 'society-system', label: '사회체제' },
            { key: 'alien-species', label: '외계 종족' },
        ],
        // sci-fi 는 PowerSystem 있으면 추적, 기본은 base only (genre-profile family 미지정).
        trackedAxes: [],
    },
    horror: {
        facets: [
            { key: 'horror-source', label: '공포 근원' },
            { key: 'rules-taboos', label: '규칙·금기' },
            { key: 'spaces', label: '공간' },
            { key: 'characters', label: '인물' },
        ],
        // horror 는 Clue 골격 (단서) — family 미지정이라 base 추적, facet 으로만 노출.
        trackedAxes: [],
    },
    cozy: {
        facets: [
            { key: 'community', label: '공동체' },
            { key: 'daily-spaces', label: '일상 공간' },
            { key: 'character-relations', label: '인물 관계' },
            { key: 'season-rhythm', label: '계절·리듬' },
        ],
        // cozy 는 관계 중심 facet 이나 GenreProfile romance family 미포함 → base 추적.
        trackedAxes: [],
    },
    urban: {
        facets: [
            { key: 'jobs-orgs', label: '직업·조직' },
            { key: 'city-geography', label: '도시 지리' },
            { key: 'modern-rules', label: '현대 규칙' },
            { key: 'character-network', label: '인물 네트워크' },
            { key: 'event-background', label: '사건 배경' },
        ],
        // urban 은 eraResearch=true, KnowledgeMatrix 있으면 — family 미지정이라 base only.
        trackedAxes: [],
    },
    other: { facets: GENERIC_FACETS, trackedAxes: [] },
};
/**
 * 장르의 facet preset 반환. 등록되지 않은(혹은 부분 미정의) 장르는 GENERIC_FACETS
 * + 빈 trackedAxes 로 fallback — worldview studio 폼이 항상 골격을 갖도록 보장.
 */
export function facetsForGenre(genre) {
    const preset = GENRE_FACETS[genre];
    if (preset)
        return preset;
    return { facets: GENERIC_FACETS, trackedAxes: [] };
}
/** 모든 ENGINE_GENRES 가 GENRE_FACETS 키를 가지는지 (테스트/부트스트랩 가드). */
export function allGenresCovered() {
    return ENGINE_GENRES.every((g) => GENRE_FACETS[g] !== undefined && GENRE_FACETS[g].facets.length > 0);
}
