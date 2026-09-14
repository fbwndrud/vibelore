/**
 * SensitiveLexicon — Korean content-sensitivity dictionary for layer-1
 * sensitive-content scan. Supports a youth-protection mode toggle that
 * tightens thresholds for sexual / violent / minor-adjacent terms.
 *
 * Categories map cleanly onto Stripe / age-rating policy requirements.
 * Layer-1 emits structured violations; downstream policy can decide
 * HARD vs SOFT per category × mode.
 */
export class DefaultSensitiveLexicon {
    entries;
    byCategoryMap;
    constructor(seed) {
        this.entries = new Map();
        this.byCategoryMap = new Map();
        const source = seed ?? KO_SENSITIVE_SEED;
        for (const entry of source) {
            this.entries.set(entry.term, entry);
            const arr = this.byCategoryMap.get(entry.category) ?? [];
            arr.push(entry);
            this.byCategoryMap.set(entry.category, arr);
        }
    }
    lookup(term) {
        return this.entries.get(term);
    }
    byCategory(c) {
        return this.byCategoryMap.get(c) ?? [];
    }
    all() {
        return [...this.entries.values()];
    }
}
// notFollowedBy 문맥 가드 (NEP-S5): 용어 등장 위치들 중, 직후가 제외 접미(공백
// 허용) 중 하나가 아닌 등장이 하나라도 있어야 위반. 동사 활용형과 substring
// 충돌하는 항목('보지' 등)의 오탐을 막는다 — 실검증에서 "더는 보지 않겠다"가
// sexual-explicit hard로 오탐된 실사례 기반.
function hasUnguardedOccurrence(prose, term, notFollowedBy) {
    let from = 0;
    for (;;) {
        const i = prose.indexOf(term, from);
        if (i < 0)
            return false;
        const rest = prose.slice(i + term.length).replace(/^\s+/, '');
        if (!notFollowedBy.some((suffix) => rest.startsWith(suffix)))
            return true;
        from = i + term.length;
    }
}
export function scanSensitive(input) {
    const { prose, chapterNumber, lexicon, mode } = input;
    if (!prose || prose.length === 0)
        return { violations: [] };
    const out = [];
    for (const entry of lexicon.all()) {
        if (!prose.includes(entry.term))
            continue;
        if (entry.notFollowedBy &&
            !hasUnguardedOccurrence(prose, entry.term, entry.notFollowedBy))
            continue;
        const severity = mode === 'youth' ? entry.youthSeverity : entry.adultSeverity;
        if (severity === 'allow')
            continue;
        out.push({
            severity,
            code: `SENSITIVE_${entry.category.toUpperCase().replace(/-/g, '_')}`,
            chapterNumber,
            message: `검열 사전 '${entry.term}' (${entry.category}) — mode=${mode}`,
        });
    }
    return { violations: out };
}
export const KO_SENSITIVE_SEED = [
    // === profanity ===
    { term: '시발', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '씨발', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '씨발놈', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '씨발년', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '좆', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '좃', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '좆같', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '개새끼', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '개자식', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '미친놈', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '미친년', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '새끼야', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '닥쳐', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    // '꺼져'는 자동사 '꺼지다'(불·등불이 꺼지다)의 활용형과 substring 충돌한다.
    // 보조용언 '있/가/간/들'과 어미 '도록/서'가 직결하면 사물 주어 서술이다.
    // 욕설 용법("꺼져!", "꺼져라", "꺼져 버려")은 이 접미가 붙지 않으므로 계속 잡힌다.
    // '버'는 일부러 뺐다 — 넣으면 "꺼져 버려"가 빠져나간다(미탐 > 오탐).
    { term: '꺼져', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard',
      notFollowedBy: ['있', '가', '간', '들', '도록', '서'] },
    { term: '빌어먹을', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '제기랄', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '젠장', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '호로새끼', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '후레자식', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard' },
    // '병신'은 육십갑자 '병신년(丙申年)'과 substring 충돌한다. 간지는 연도 조사가
    // 직결하는 형태('병신년에/의/까지/부터')로만 쓰이고, 욕설은 그 자리에 호격·주격
    // 조사가 온다("병신년아", "병신년이"). '년 '(공백)은 일부러 뺐다 — 넣으면
    // "병신년 저리 가"가 빠져나간다.
    { term: '병신', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard',
      notFollowedBy: ['년에', '년의', '년까지', '년부터'] },
    // '지랄'은 지명 '지랄산'과 substring 충돌한다.
    { term: '지랄', category: 'profanity', adultSeverity: 'soft', youthSeverity: 'hard',
      notFollowedBy: ['산'] },
    // === sexual-explicit ===
    { term: '정사', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '섹스', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '자위', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '발정', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '음란', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '음경', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard' },
    // '자지'는 '보지'와 같은 충돌 — 동사 '자다'의 활용형('자지 않/못/말…')이다.
    // 명사 용법은 조사가 직결하므로('자지가/를/에') 계속 잡힌다.
    { term: '자지', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard',
      notFollowedBy: ['않', '못', '말', '마', '맙', '도', '만', '조차', '요'] },
    // '보지'는 동사 '보다'의 극히 흔한 활용형(보지 않/못/말…)과 충돌 —
    // 어미·보조용언 직결 등장은 제외(notFollowedBy), 명사 문맥(조사 직결)만 탐지.
    { term: '보지', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard',
      notFollowedBy: ['않', '못', '말', '마', '맙', '도', '만', '조차', '요'] },
    { term: '가슴을 빨았다', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '옷을 벗겼다', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '몸을 더듬었다', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '절정에 달했다', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '신음', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '헐떡이며', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '알몸', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '나체', category: 'sexual-explicit', adultSeverity: 'soft', youthSeverity: 'hard' },
    // === sexual-suggestive ===
    { term: '입맞춤', category: 'sexual-suggestive', adultSeverity: 'allow', youthSeverity: 'soft' },
    { term: '키스', category: 'sexual-suggestive', adultSeverity: 'allow', youthSeverity: 'soft' },
    { term: '입술이 닿았다', category: 'sexual-suggestive', adultSeverity: 'allow', youthSeverity: 'soft' },
    { term: '살결', category: 'sexual-suggestive', adultSeverity: 'allow', youthSeverity: 'soft' },
    { term: '살갗', category: 'sexual-suggestive', adultSeverity: 'allow', youthSeverity: 'soft' },
    { term: '체온', category: 'sexual-suggestive', adultSeverity: 'allow', youthSeverity: 'soft' },
    { term: '숨결', category: 'sexual-suggestive', adultSeverity: 'allow', youthSeverity: 'soft' },
    { term: '허리를 감싸안았다', category: 'sexual-suggestive', adultSeverity: 'allow', youthSeverity: 'soft' },
    { term: '옷자락이', category: 'sexual-suggestive', adultSeverity: 'allow', youthSeverity: 'soft' },
    { term: '옷매무새', category: 'sexual-suggestive', adultSeverity: 'allow', youthSeverity: 'soft' },
    { term: '가슴이 두근', category: 'sexual-suggestive', adultSeverity: 'allow', youthSeverity: 'soft' },
    { term: '야릇한 미소', category: 'sexual-suggestive', adultSeverity: 'allow', youthSeverity: 'soft' },
    { term: '뜨거운 시선', category: 'sexual-suggestive', adultSeverity: 'allow', youthSeverity: 'soft' },
    // === violence-graphic ===
    { term: '피가 솟구쳤다', category: 'violence-graphic', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '내장이', category: 'violence-graphic', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '뼈가 으스러졌다', category: 'violence-graphic', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '살점이', category: 'violence-graphic', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '머리가 잘렸다', category: 'violence-graphic', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '목이 잘렸다', category: 'violence-graphic', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '가죽이 벗겨졌다', category: 'violence-graphic', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '사지가 찢겼다', category: 'violence-graphic', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '비명을 지르며 죽었다', category: 'violence-graphic', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '토막', category: 'violence-graphic', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '도륙', category: 'violence-graphic', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '학살', category: 'violence-graphic', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '시체더미', category: 'violence-graphic', adultSeverity: 'soft', youthSeverity: 'hard' },
    // === drug-substance ===
    { term: '마약', category: 'drug-substance', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '헤로인', category: 'drug-substance', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '코카인', category: 'drug-substance', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '필로폰', category: 'drug-substance', adultSeverity: 'soft', youthSeverity: 'hard' },
    // '대마'는 지명 '대마도(對馬島)'와 substring 충돌한다. 약물 용법은 '대마초',
    // '대마를/대마가'처럼 '도'가 직결하지 않는다.
    { term: '대마', category: 'drug-substance', adultSeverity: 'soft', youthSeverity: 'hard',
      notFollowedBy: ['도'] },
    { term: '환각제', category: 'drug-substance', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '약쟁이', category: 'drug-substance', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '마약을 투여', category: 'drug-substance', adultSeverity: 'soft', youthSeverity: 'hard' },
    // === minor-adjacent (정상 어휘, sexual cross-check 는 후속 layer)
    { term: '어린이', category: 'minor-adjacent', adultSeverity: 'allow', youthSeverity: 'allow' },
    { term: '아이', category: 'minor-adjacent', adultSeverity: 'allow', youthSeverity: 'allow' },
    { term: '소년', category: 'minor-adjacent', adultSeverity: 'allow', youthSeverity: 'allow' },
    { term: '소녀', category: 'minor-adjacent', adultSeverity: 'allow', youthSeverity: 'allow' },
    { term: '학생', category: 'minor-adjacent', adultSeverity: 'allow', youthSeverity: 'allow' },
    { term: '미성년', category: 'minor-adjacent', adultSeverity: 'allow', youthSeverity: 'allow' },
    { term: '청소년', category: 'minor-adjacent', adultSeverity: 'allow', youthSeverity: 'allow' },
    { term: '중학생', category: 'minor-adjacent', adultSeverity: 'allow', youthSeverity: 'allow' },
    // === self-harm ===
    { term: '자살', category: 'self-harm', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '목을 매', category: 'self-harm', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '손목을 그었다', category: 'self-harm', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '옥상에서 뛰어내렸다', category: 'self-harm', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '약을 삼켰다', category: 'self-harm', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '자해', category: 'self-harm', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '죽고 싶다', category: 'self-harm', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '죽어버리고 싶다', category: 'self-harm', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '사라지고 싶다', category: 'self-harm', adultSeverity: 'soft', youthSeverity: 'hard' },
    { term: '살 가치가 없다', category: 'self-harm', adultSeverity: 'soft', youthSeverity: 'hard' },
];
