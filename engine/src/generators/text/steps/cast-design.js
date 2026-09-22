/**
 * Create the initial cast from the premise and world facts.
 *
 * Intrinsic attributes are recorded when a character is registered. Optional
 * visualHints provide descriptive detail; older records may omit them.
 * Parsing supplies defaults for missing optional fields.
 */
import {
    normalizeDramaticModel, normalizeIdentityIntrinsic, normalizeSalienceProfile, validateCharacterDesign,
} from '../../../continuity/character-design.js';
function asString(v, fallback = '') {
    return typeof v === 'string' ? v : fallback;
}
function asStringArray(v) {
    if (!Array.isArray(v))
        return [];
    return v.filter((s) => typeof s === 'string');
}
function parseVisualHints(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const obj = raw;
    const hair = asString(obj.hair).trim();
    const eyes = asString(obj.eyes).trim();
    const build = asString(obj.build).trim();
    const attire = asString(obj.attire).trim();
    const distinguishing = asStringArray(obj.distinguishing);
    const vibe = asString(obj.vibe).trim();
    if (hair.length === 0 &&
        eyes.length === 0 &&
        build.length === 0 &&
        attire.length === 0 &&
        distinguishing.length === 0 &&
        vibe.length === 0) {
        return undefined;
    }
    return { hair, eyes, build, attire, distinguishing, vibe };
}
function parseIntrinsic(raw) {
    const obj = (raw ?? {});
    const intrinsic = normalizeIdentityIntrinsic(obj);
    const visualHints = parseVisualHints(obj.visualHints);
    if (visualHints)
        intrinsic.visualHints = visualHints;
    return intrinsic;
}
function parseRelationships(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (typeof item !== 'object' || item === null)
            continue;
        const obj = item;
        const to = asString(obj.to);
        const kind = asString(obj.kind);
        const state = asString(obj.state);
        if (to.length === 0 || kind.length === 0 || state.length === 0)
            continue;
        out.push({ to, kind, state });
    }
    return out;
}
function parseSpeechProfile(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const obj = raw;
    const samples = typeof obj.samples === 'object' && obj.samples !== null ? obj.samples : {};
    const relationVariants = Array.isArray(obj.relationVariants) ? obj.relationVariants.flatMap((item) => {
        if (typeof item !== 'object' || item === null)
            return [];
        const row = item;
        const targetId = asString(row.targetId).trim();
        const adjustment = asString(row.adjustment).trim();
        const sample = asString(row.sample).trim();
        return targetId || adjustment || sample ? [{ targetId, adjustment, sample }] : [];
    }).slice(0, 6) : [];
    const profile = {
        defaultRegister: asString(obj.defaultRegister).trim(),
        sentenceShape: asString(obj.sentenceShape).trim(),
        logicHabit: asString(obj.logicHabit).trim(),
        emotionalLeak: asString(obj.emotionalLeak).trim(),
        samples: {
            everyday: asString(samples.everyday).trim(),
            underPressure: asString(samples.underPressure).trim(),
            lying: asString(samples.lying).trim(),
            intimate: asString(samples.intimate).trim(),
        },
        relationVariants,
    };
    const hasSample = Object.values(profile.samples).some((value) => value.length > 0);
    return profile.defaultRegister || profile.sentenceShape || profile.logicHabit || profile.emotionalLeak || hasSample || relationVariants.length
        ? profile
        : undefined;
}
function uniquifyId(seen, baseId) {
    if (!seen.has(baseId)) {
        seen.add(baseId);
        return baseId;
    }
    let n = 2;
    while (seen.has(`${baseId}-${n}`))
        n += 1;
    const next = `${baseId}-${n}`;
    seen.add(next);
    return next;
}
function buildCastPrompt(input, world) {
    const lang = input.language;
    const briefLine = input.brief && input.brief.length > 0 ? `브리프: ${input.brief}` : '';
    const worldFactBlock = world.worldFacts
        .map((wf, i) => `  ${i + 1}. ${wf.statement}`)
        .join('\n');
    return [
        `너는 ${lang} 소설의 초기 캐스트 디자이너다.`,
        '',
        `작품 정보:`,
        `- 제목: ${input.title}`,
        `- 장르: ${input.genre}`,
        `- 목표 화수: ${input.targetChapters}`,
        `- 화당 분량(어림): ${input.chapterWordCount} 단어`,
        briefLine,
        '',
        `전제: ${world.premise}`,
        '',
        `세계 사실:`,
        worldFactBlock,
        '',
        `과제: 1화에 등장(또는 즉시 등장 가능)할 핵심 인물 3~5명을 설계하라.`,
        '',
        `규칙 (핀고정 계약):`,
        `- identity 필드(gender, genderLabel, species, form, ageBand, birthOrder, role, coreAppearance, addressing)는 등록 시점에 핀고정된다.`,
        `- gender는 male|female|nonbinary|unknown|undisclosed|not_applicable|custom 중 하나다. custom/not_applicable이면 genderLabel로 작품 내 의미를 설명한다.`,
        `- species와 form은 gender와 별개다. 비인간·무형·변신 종족을 인간 성별 분류에 억지로 넣지 않는다.`,
        `- 따라서 intrinsic 은 작품 전체에서 일관되게 유지될 수 있는 값으로 선택하라 (모호한 표현 금지).`,
        `- coreAppearance 는 시각적으로 영구히 유지되는 특징만 (머리색, 흉터, 눈동자 색 등). 의상/소지품은 제외.`,
        `- visualHints 는 image 생성용 풍부한 시각 묘사 — coreAppearance(짧은 continuity 토큰) 와 의도적으로 분리된다.`,
        `  · hair / eyes / build / attire / vibe 는 한 줄 묘사 문자열, distinguishing 은 식별 가능한 특이점 배열.`,
        `  · 모든 필드 채워야 하며 빈 문자열/빈 배열 금지 (이미지 prompt 합성의 입력 일관성).`,
        `- aliases 는 별명/과거명/회귀전 이름 등. 없으면 빈 배열.`,
        `- contradiction 은 인물을 살아 있게 만드는 내적 모순 한 문장. 반드시 비우지 않는다.`,
        `- description 은 배경·동기 중심의 짧은 설명. 말투는 speechProfile에 구조화한다.`,
        `- speechProfile은 금지어가 아니라 해야 하는 발화 예시다. 각 샘플은 정보 전달문이 아니라 결핍·방어·관계 압력이 묻어나는 한 줄 대사로 쓴다.`,
        `- dramaticModel은 이 작품의 반복 선택을 바꾸는 항목만 만든다. valueOrder 3~6개, 비용이 있는 behaviorTraits 2~5개, 작품별 dimensionBaselines 2~7개를 채운다.`,
        `- genreDetails는 고정 프리셋이 아니라 이 작품에서 행동과 검증에 실제 쓰일 키만 만든다.`,
        `- mutable.status 는 'alive' | 'dead' | 'missing' 중 하나.`,
        `- relationships[].to 는 다른 character.id 를 참조해야 한다 (없는 id 참조 금지).`,
        '',
        `반드시 JSON 객체로만 응답하라. 마크다운 코드 펜스, 설명, 주석 금지.`,
        `스키마:`,
        `{`,
        `  "salienceProfile": { "dimensions": [{ "id":"작품별_축", "label":"표시명", "narrativeReason":"반복 선택을 바꾸는 이유", "positiveEvidence":["상승 행동 증거"], "negativeEvidence":["하락 행동 증거"], "nonEvidence":["변화로 세지 않을 것"], "saturationRisk":"과잉 적용 위험" }] },`,
        `  "characters": [`,
        `    {`,
        `      "id": "c1",`,
        `      "canonicalName": "...",`,
        `      "aliases": [],`,
        `      "contradiction": "죽는 게 무서워 불사를 원하지만 영원히 사는 것도 견디지 못한다.",`,
        `      "description": "배경, 동기, 말투.",`,
        `      "speechProfile": {`,
        `        "defaultRegister": "존댓말/반말/혼용 조건",`,
        `        "sentenceShape": "짧게 끊음/길게 누적/질문으로 압박 등",`,
        `        "logicHabit": "먼저 비용을 말함/정의를 확인함/농담으로 회피함",`,
        `        "emotionalLeak": "감정이 새는 방식",`,
        `        "samples": {`,
        `          "everyday": "평상시 한 줄 대사",`,
        `          "underPressure": "압박받을 때 한 줄 대사",`,
        `          "lying": "거짓말할 때 한 줄 대사",`,
        `          "intimate": "마음이 열린 상대에게 한 줄 대사"`,
        `        },`,
        `        "relationVariants": [{ "targetId": "c2", "adjustment": "이 사람 앞에서만 문장이 짧아진다", "sample": "관계별 대사 예시" }]`,
        `      },`,
        `      "registeredAtChapter": 1,`,
        `      "intrinsic": {`,
        `        "gender": "male|female|nonbinary|unknown|undisclosed|not_applicable|custom",`,
        `        "genderLabel": "custom/not_applicable일 때 설명",`,
        `        "species": "human 또는 작품 고유 종족",`,
        `        "form": "humanoid|amorphous|polymorphic 등",`,
        `        "ageBand": "20대초반",`,
        `        "birthOrder": "장남",`,
        `        "role": "주인공",`,
        `        "coreAppearance": ["은발", "왼쪽 뺨 흉터"],`,
        `        "visualHints": {`,
        `          "hair": "은발 단발, 비대칭 앞머리",`,
        `          "eyes": "청록색, 길게 트인 눈매",`,
        `          "build": "175cm, 마른 근육질",`,
        `          "attire": "검은 가죽 코트, 회색 셔츠",`,
        `          "distinguishing": ["왼쪽 뺨 사선 흉터", "오른쪽 손목 은팔찌"],`,
        `          "vibe": "냉정하지만 속에 분노가 끓는"`,
        `        }`,
        `      },`,
        `      "dramaticModel": {`,
        `        "valueOrder": ["우선 가치 1", "우선 가치 2", "우선 가치 3"],`,
        `        "behaviorTraits": [{"trigger":"압력","actionBias":"반복 행동","benefit":"즉시 효용","cost":"인물과 사건의 비용"}],`,
        `        "perception": {"seesFirst":["먼저 보는 것"],"missesFirst":["늦게 보는 것"]},`,
        `        "defense": {"public":"평상시 방어","underPressure":"압박 시 방어"},`,
        `        "repair": {"firstMove":"관계 회복 첫 행동","cannotDo":"쉽게 못 하는 행동"},`,
        `        "privateDelights": ["쓸모없는 사적 즐거움"],`,
        `        "unproductiveWant": "목적과 무관하게 원하는 것",`,
        `        "dimensionBaselines": {"작품별_동적축": 0},`,
        `        "genreDetails": {"작품에서_실제로_쓰는_키":"값"}`,
        `      },`,
        `      "mutable": { "status": "alive", "location": "...", "knownFacts": [] },`,
        `      "relationships": [{ "to": "c2", "kind": "라이벌", "state": "미해결갈등" }]`,
        `    }`,
        `  ]`,
        `}`,
    ]
        .filter((line) => line !== '')
        .join('\n');
}
export async function llmCastDesign(ctx, input, world) {
    const prompt = buildCastPrompt(input, world);
    const res = await ctx.providers.complete({
        model: ctx.model,
        step: 'cast-design',
        messages: [
            {
                role: 'system',
                content: '한국어 소설 초기 캐스트 디자이너. JSON 만 출력. intrinsic 핀고정 계약 준수.',
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
        throw new Error('castDesign parse failed');
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('castDesign parse failed');
    }
    const rawList = parsed.characters;
    if (rawList !== undefined && !Array.isArray(rawList)) {
        throw new Error('castDesign parse failed');
    }
    const list = Array.isArray(rawList) ? rawList : [];
    const seenIds = new Set();
    const characters = [];
    let autoIdSeq = 1;
    for (const item of list) {
        if (typeof item !== 'object' || item === null)
            continue;
        const obj = item;
        const canonicalName = asString(obj.canonicalName).trim();
        if (canonicalName.length === 0) {
            // Skip — a character without a canonical name is unusable.
            continue;
        }
        const rawId = asString(obj.id).trim();
        const baseId = rawId.length > 0 ? rawId : `c${autoIdSeq++}`;
        const id = uniquifyId(seenIds, baseId);
        const registeredAtRaw = obj.registeredAtChapter;
        const registeredAtChapter = typeof registeredAtRaw === 'number' && Number.isFinite(registeredAtRaw) && registeredAtRaw >= 1
            ? Math.floor(registeredAtRaw)
            : 1;
        const intrinsic = parseIntrinsic(obj.intrinsic);
        const mutableObj = (obj.mutable ?? {});
        const statusRaw = asString(mutableObj.status, 'alive');
        const locationRaw = asString(mutableObj.location);
        const character = {
            id,
            canonicalName,
            aliases: asStringArray(obj.aliases),
            registeredAtChapter,
            intrinsic,
            mutable: {
                status: statusRaw.length > 0 ? statusRaw : 'alive',
                knownFacts: asStringArray(mutableObj.knownFacts),
                ...(locationRaw.length > 0 ? { location: locationRaw } : {}),
            },
            relationships: parseRelationships(obj.relationships),
            contradiction: asString(obj.contradiction).trim() || '원하는 것을 얻을수록 가장 두려워하던 존재가 된다.',
            description: asString(obj.description).trim(),
        };
        const speechProfile = parseSpeechProfile(obj.speechProfile);
        if (speechProfile)
            character.speechProfile = speechProfile;
        character.dramaticModel = normalizeDramaticModel(obj.dramaticModel, character);
        character.designViolations = validateCharacterDesign(character, { strict: true });
        characters.push(character);
    }
    return { characters, salienceProfile: normalizeSalienceProfile(parsed.salienceProfile, characters) };
}
