/**
 * SimileMarkerLexicon — Korean simile/metaphor markers for layer-1
 * quality scans (N1 show-not-tell, N10 simile ratio).
 *
 * Each entry carries a regex `pattern` (safely escaped for variable parts;
 * suffix attaches to a substring). Scanner counts matches across prose and
 * compares against word-count threshold.
 */
export class DefaultSimileMarkerLexicon {
    entries;
    constructor(seed) {
        this.entries = seed ?? KO_SIMILE_MARKER_SEED;
    }
    all() {
        return [...this.entries];
    }
    byKind(kind) {
        return this.entries.filter((e) => e.kind === kind);
    }
}
export const KO_SIMILE_MARKER_SEED = [
    // === simile (직유) — 어미/접사형 ===
    { marker: '~듯', patternSource: '듯(?:이|한|하다|싶다)?', kind: 'simile' },
    { marker: '~듯이', patternSource: '듯이', kind: 'simile' },
    { marker: '~듯한', patternSource: '듯한', kind: 'simile' },
    { marker: '~듯하다', patternSource: '듯하다', kind: 'simile' },
    { marker: '~듯싶다', patternSource: '듯싶다', kind: 'simile' },
    { marker: '~처럼', patternSource: '처럼', kind: 'simile' },
    { marker: '~같이', patternSource: '같이', kind: 'simile' },
    { marker: '~과도 같이', patternSource: '(?:과|와)도\\s?같이', kind: 'simile' },
    { marker: '~만 같다', patternSource: '만\\s?같(?:다|은|이|았)', kind: 'simile' },
    { marker: '~와 같은', patternSource: '(?:과|와)\\s?같(?:은|이|다)', kind: 'simile' },
    { marker: '~과 다름없다', patternSource: '(?:과|와)\\s?다름(?:없|없는|없이|없다)', kind: 'simile' },
    { marker: '~인 양', patternSource: '인\\s?양', kind: 'simile' },
    { marker: '~인 듯', patternSource: '인\\s?듯', kind: 'simile' },
    { marker: '~인 것마냥', patternSource: '인\\s?것\\s?마냥', kind: 'simile' },
    { marker: '~마냥', patternSource: '마냥', kind: 'simile' },
    { marker: '~에 견주면', patternSource: '에\\s?견주(?:면|어|어서)', kind: 'simile' },
    { marker: '~과 흡사하다', patternSource: '(?:과|와)\\s?흡사(?:하다|한|해|했)', kind: 'simile' },
    // === simile — 도입어 ===
    { marker: '마치', patternSource: '마치', kind: 'simile' },
    { marker: '흡사', patternSource: '흡사', kind: 'simile' },
    { marker: '비유하자면', patternSource: '비유하자면', kind: 'simile' },
    { marker: '비유컨대', patternSource: '비유컨대', kind: 'simile' },
    { marker: '견주어', patternSource: '견주어', kind: 'simile' },
    { marker: '말하자면', patternSource: '말하자면', kind: 'simile' },
    { marker: '이를테면', patternSource: '이를테면', kind: 'simile' },
    // === metaphor (은유) — noun + 같은/같이/같다 패턴 ===
    {
        marker: '자연물 같은',
        patternSource: '(?:불|얼음|폭풍|천둥|벼락|꽃|별|달|해|바람|돌|재|물|불꽃|눈|서리|안개|이슬)\\s?같(?:은|이|다|았)',
        kind: 'metaphor',
    },
    {
        marker: '동물 비유',
        patternSource: '(?:사자|호랑이|늑대|여우|토끼|뱀|매|독수리|곰)\\s?같(?:은|이|다|았)',
        kind: 'metaphor',
    },
    {
        marker: '추상 비유',
        patternSource: '(?:죽음|어둠|악몽|지옥|천국|꿈|운명|숙명)\\s?같(?:은|이|다|았)',
        kind: 'metaphor',
    },
    {
        marker: '~빛났다',
        patternSource: '(?:별|보석|진주|유리|얼음|칼날)\\s?(?:처럼|같이)?\\s?빛났',
        kind: 'metaphor',
    },
    {
        marker: '~타올랐다',
        patternSource: '(?:불|불꽃|화염|분노|증오)\\s?(?:처럼|같이)?\\s?타올랐',
        kind: 'metaphor',
    },
    {
        marker: '~얼어붙었다',
        patternSource: '(?:얼음|서리|돌)\\s?(?:처럼|같이)?\\s?얼어붙',
        kind: 'metaphor',
    },
    {
        marker: '~로 변했다',
        patternSource: '(?:불꽃|얼음|돌|재|먼지)(?:으로|로)\\s?변(?:했|하)',
        kind: 'metaphor',
    },
    {
        marker: '~을 삼켰다',
        patternSource: '(?:어둠|침묵|적막|공포|두려움)(?:이|은)\\s?[^\\s]+(?:을|를)\\s?삼켰',
        kind: 'metaphor',
    },
];
