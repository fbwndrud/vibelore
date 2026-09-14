/**
 * Create the initial cast from the premise and world facts.
 *
 * Intrinsic attributes are recorded when a character is registered. Optional
 * visualHints provide descriptive detail; older records may omit them.
 * Parsing supplies defaults for missing optional fields.
 */
import { parseJsonCompletion } from '../../../core/json-completion.js';
import {
    normalizeDramaticModel, normalizeIdentityIntrinsic, normalizeSalienceProfile, validateCharacterDesign,
} from '../../../continuity/character-design.js';
import {
    formatLengthTarget, languageSystemLines, pickByFamily, promptFamilyCaptureContext,
    resolvePromptLanguageContext, resolveStepPromptLanguage,
} from '../../../core/prompt-language.js';
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
const CAST_LABELS_KO = {
    header: (ctx) => `너는 ${ctx.language} 소설의 초기 캐스트 디자이너다.`,
    workHeading: `작품 정보:`,
    title: (v) => `- 제목: ${v}`,
    genre: (v) => `- 장르: ${v}`,
    targetChapters: (v) => `- 목표 화수: ${v}`,
    length: (ctx) => ctx.length.unit === 'legacyCodeUnits'
        ? `- 화당 분량(어림): ${formatLengthTarget(ctx)} 단어`
        : `- 화당 분량(어림): ${formatLengthTarget(ctx)}`,
    brief: (v) => `브리프: ${v}`,
    premise: (v) => `전제: ${v}`,
    worldFactsHeading: `세계 사실:`,
    task: `과제: 1화에 등장(또는 즉시 등장 가능)할 핵심 인물 3~5명을 설계하라.`,
    rules: [
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
    ],
    output: `반드시 JSON 객체로만 응답하라. 마크다운 코드 펜스, 설명, 주석 금지.`,
    schema: `스키마:`,
    repairHeading: `이전 응답 수정 요청:`,
    repairParse: `- 이전 응답은 유효한 JSON 이 아니었다. 같은 스키마의 JSON 객체 하나만, 쉼표·괄호를 빠뜨리지 말고 완전하게 다시 출력하라.`,
    repairViolation: (id, codes) => `- ${id}: ${codes.join(', ')}`,
    repairCodes: `- 코드 요구: DRAMATIC_VALUE_ORDER_THIN=valueOrder 3개 이상, DRAMATIC_BEHAVIOR_TRAITS_THIN=비용이 있는 behaviorTraits 2개 이상, DRAMATIC_DIMENSIONS_THIN=dimensionBaselines 2개 이상, DRAMATIC_PERCEPTION_SEES_EMPTY/MISSES_EMPTY=seesFirst/missesFirst 각 1개 이상, DRAMATIC_DEFENSE_EMPTY=defense.underPressure, DRAMATIC_REPAIR_EMPTY=repair.firstMove, DRAMATIC_CONTRADICTION_REQUIRED=contradiction, IDENTITY_*=gender enum·genderLabel·species.`,
    repairInstruction: `지목된 인물만 보완하고 나머지 인물·id·값은 유지한 채 전체 JSON 을 다시 완전하게 출력하라.`,
    repairPrevious: `이전 응답:`,
};
/**
 * 다국어 계열. 인물 값(이름·외형·대사 샘플)은 **목표 작품 언어**로 요구하고,
 * 스키마 키와 enum(`male|female|...`, `alive|dead|missing`)은 기계 계약이라
 * 그대로 둔다. 한국어 존대/반말 전제(defaultRegister 예시 등)는 목표 언어의
 * 등가 장치로 바꿔 말한다.
 */
const CAST_LABELS_EN = {
    header: () => 'You are the initial cast designer for a novel written in the target work language.',
    workHeading: 'Work information:',
    title: (v) => `- Title: ${v}`,
    genre: (v) => `- Genre: ${v}`,
    targetChapters: (v) => `- Target chapter count: ${v}`,
    length: (ctx) => `- Approximate length per chapter: ${formatLengthTarget(ctx)}`,
    brief: (v) => `Brief: ${v}`,
    premise: (v) => `Premise: ${v}`,
    worldFactsHeading: 'World facts:',
    task: 'Task: design the 3-5 core characters who appear in chapter 1 (or could appear immediately).',
    rules: [
        'Rules (pin-on-register contract):',
        '- The identity fields (gender, genderLabel, species, form, ageBand, birthOrder, role, coreAppearance, addressing) are pinned at registration time.',
        '- gender is one of male|female|nonbinary|unknown|undisclosed|not_applicable|custom. Keep these enum values verbatim; for custom/not_applicable explain the in-work meaning in genderLabel.',
        '- species and form are independent of gender. Do not force non-human, formless or shapeshifting kinds into a human gender category.',
        '- Choose intrinsic values that can hold for the whole work (no vague hedging).',
        '- coreAppearance holds only permanently visible traits (hair colour, scars, eye colour). Clothing and carried items do not belong here.',
        '- visualHints is the richer visual description used for image prompts — deliberately separate from coreAppearance (short continuity tokens).',
        '  · hair / eyes / build / attire / vibe are one-line description strings; distinguishing is an array of identifiable specifics.',
        '  · Fill every field; no empty strings or empty arrays (image prompt synthesis needs consistent input).',
        '- aliases holds nicknames, former names, pre-regression names. Use an empty array if there are none.',
        '- contradiction is one sentence of inner contradiction that keeps the character alive. Never leave it empty.',
        '- description is a short background-and-motivation note. Speech habits belong in speechProfile.',
        '- speechProfile is a set of lines the character would actually say, not a list of banned words. Each sample is one line of dialogue carrying a lack, a defence or relational pressure — not an information dump.',
        '- dramaticModel contains only the items that change this character\'s repeated choices: 3-6 valueOrder entries, 2-5 behaviorTraits that each carry a cost, and 2-7 work-specific dimensionBaselines.',
        '- genreDetails is not a fixed preset: create only the keys this work actually uses for behaviour and validation.',
        '- mutable.status is one of \'alive\' | \'dead\' | \'missing\' (verbatim).',
        '- relationships[].to must reference another character.id (never an id that does not exist).',
        '- Write every human-readable value (names, appearance, description, dialogue samples) in the target work language. Do not translate JSON keys, ids or enum values.',
    ],
    output: 'Respond with a single JSON object only. No markdown code fence, no explanation, no comments.',
    schema: 'Schema:',
    repairHeading: 'Repair request for the previous answer:',
    repairParse: '- The previous answer was not valid JSON. Return exactly one complete JSON object in the same schema, with no missing commas or brackets.',
    repairViolation: (id, codes) => `- ${id}: ${codes.join(', ')}`,
    repairCodes: '- Code requirements: DRAMATIC_VALUE_ORDER_THIN = at least 3 valueOrder entries; DRAMATIC_BEHAVIOR_TRAITS_THIN = at least 2 behaviorTraits, each with a cost; DRAMATIC_DIMENSIONS_THIN = at least 2 dimensionBaselines; DRAMATIC_PERCEPTION_SEES_EMPTY / MISSES_EMPTY = at least one seesFirst / missesFirst; DRAMATIC_DEFENSE_EMPTY = defense.underPressure; DRAMATIC_REPAIR_EMPTY = repair.firstMove; DRAMATIC_CONTRADICTION_REQUIRED = contradiction; IDENTITY_* = gender enum, genderLabel, species.',
    repairInstruction: 'Complete only the characters named above, keep every other character, id and value unchanged, and output the whole JSON object again in full.',
    repairPrevious: 'Previous answer:',
};
/** 스키마 예시의 **값**(자리표시자)만 계열을 따른다. 키는 기계 계약이다. */
const CAST_SCHEMA_PLACEHOLDERS_KO = {
    salienceAxis: '작품별_축',
    salienceLabel: '표시명',
    salienceReason: '반복 선택을 바꾸는 이유',
    saliencePositive: '상승 행동 증거',
    salienceNegative: '하락 행동 증거',
    salienceNonEvidence: '변화로 세지 않을 것',
    salienceRisk: '과잉 적용 위험',
    contradiction: '죽는 게 무서워 불사를 원하지만 영원히 사는 것도 견디지 못한다.',
    description: '배경, 동기, 말투.',
    defaultRegister: '존댓말/반말/혼용 조건',
    sentenceShape: '짧게 끊음/길게 누적/질문으로 압박 등',
    logicHabit: '먼저 비용을 말함/정의를 확인함/농담으로 회피함',
    emotionalLeak: '감정이 새는 방식',
    everyday: '평상시 한 줄 대사',
    underPressure: '압박받을 때 한 줄 대사',
    lying: '거짓말할 때 한 줄 대사',
    intimate: '마음이 열린 상대에게 한 줄 대사',
    relationAdjustment: '이 사람 앞에서만 문장이 짧아진다',
    relationSample: '관계별 대사 예시',
    genderLabel: 'custom/not_applicable일 때 설명',
    species: 'human 또는 작품 고유 종족',
    form: 'humanoid|amorphous|polymorphic 등',
    ageBand: '20대초반',
    birthOrder: '장남',
    role: '주인공',
    coreAppearance: '"은발", "왼쪽 뺨 흉터"',
    hair: '은발 단발, 비대칭 앞머리',
    eyes: '청록색, 길게 트인 눈매',
    build: '175cm, 마른 근육질',
    attire: '검은 가죽 코트, 회색 셔츠',
    distinguishing: '"왼쪽 뺨 사선 흉터", "오른쪽 손목 은팔찌"',
    vibe: '냉정하지만 속에 분노가 끓는',
    valueOrder: '"우선 가치 1", "우선 가치 2", "우선 가치 3"',
    trigger: '압력',
    actionBias: '반복 행동',
    benefit: '즉시 효용',
    cost: '인물과 사건의 비용',
    seesFirst: '먼저 보는 것',
    missesFirst: '늦게 보는 것',
    defensePublic: '평상시 방어',
    defenseUnderPressure: '압박 시 방어',
    repairFirstMove: '관계 회복 첫 행동',
    repairCannotDo: '쉽게 못 하는 행동',
    privateDelights: '쓸모없는 사적 즐거움',
    unproductiveWant: '목적과 무관하게 원하는 것',
    dimensionKey: '작품별_동적축',
    genreDetailKey: '작품에서_실제로_쓰는_키',
    genreDetailValue: '값',
    relationshipKind: '라이벌',
    relationshipState: '미해결갈등',
    location: '...',
};
const CAST_SCHEMA_PLACEHOLDERS_EN = {
    salienceAxis: 'work_specific_axis',
    salienceLabel: 'display label',
    salienceReason: 'why this changes repeated choices',
    saliencePositive: 'evidence of a rise in behaviour',
    salienceNegative: 'evidence of a fall in behaviour',
    salienceNonEvidence: 'what does not count as change',
    salienceRisk: 'risk of over-applying this axis',
    contradiction: 'He wants to be immortal because he fears dying, and cannot bear the thought of living forever.',
    description: 'Background, motivation, manner of speech.',
    defaultRegister: 'when this character is formal, casual, or switches',
    sentenceShape: 'clipped / accumulating / pressing with questions',
    logicHabit: 'names the cost first / checks definitions / deflects with a joke',
    emotionalLeak: 'how feeling leaks out',
    everyday: 'one line of ordinary dialogue',
    underPressure: 'one line said under pressure',
    lying: 'one line said while lying',
    intimate: 'one line said to someone they trust',
    relationAdjustment: 'sentences get shorter only in front of this person',
    relationSample: 'a line specific to this relationship',
    genderLabel: 'explanation when gender is custom or not_applicable',
    species: 'human, or a species specific to this work',
    form: 'humanoid|amorphous|polymorphic, etc.',
    ageBand: 'early twenties',
    birthOrder: 'eldest son',
    role: 'protagonist',
    coreAppearance: '"silver hair", "scar on the left cheek"',
    hair: 'silver bob, asymmetric fringe',
    eyes: 'teal, long-cut eyes',
    build: '175cm, lean and muscular',
    attire: 'black leather coat, grey shirt',
    distinguishing: '"diagonal scar on the left cheek", "silver bracelet on the right wrist"',
    vibe: 'cold on the surface, anger boiling underneath',
    valueOrder: '"first value", "second value", "third value"',
    trigger: 'the pressure',
    actionBias: 'the repeated action',
    benefit: 'the immediate payoff',
    cost: 'the cost to the character and the story',
    seesFirst: 'what they notice first',
    missesFirst: 'what they notice too late',
    defensePublic: 'everyday defence',
    defenseUnderPressure: 'defence under pressure',
    repairFirstMove: 'first move toward repairing a relationship',
    repairCannotDo: 'what they cannot bring themselves to do',
    privateDelights: 'a useless private pleasure',
    unproductiveWant: 'something wanted regardless of the goal',
    dimensionKey: 'work_specific_dynamic_axis',
    genreDetailKey: 'key_this_work_actually_uses',
    genreDetailValue: 'value',
    relationshipKind: 'rival',
    relationshipState: 'unresolved conflict',
    location: '...',
};
function castSchemaLines(p) {
    return [
        `{`,
        `  "salienceProfile": { "dimensions": [{ "id":"${p.salienceAxis}", "label":"${p.salienceLabel}", "narrativeReason":"${p.salienceReason}", "positiveEvidence":["${p.saliencePositive}"], "negativeEvidence":["${p.salienceNegative}"], "nonEvidence":["${p.salienceNonEvidence}"], "saturationRisk":"${p.salienceRisk}" }] },`,
        `  "characters": [`,
        `    {`,
        `      "id": "c1",`,
        `      "canonicalName": "...",`,
        `      "aliases": [],`,
        `      "contradiction": "${p.contradiction}",`,
        `      "description": "${p.description}",`,
        `      "speechProfile": {`,
        `        "defaultRegister": "${p.defaultRegister}",`,
        `        "sentenceShape": "${p.sentenceShape}",`,
        `        "logicHabit": "${p.logicHabit}",`,
        `        "emotionalLeak": "${p.emotionalLeak}",`,
        `        "samples": {`,
        `          "everyday": "${p.everyday}",`,
        `          "underPressure": "${p.underPressure}",`,
        `          "lying": "${p.lying}",`,
        `          "intimate": "${p.intimate}"`,
        `        },`,
        `        "relationVariants": [{ "targetId": "c2", "adjustment": "${p.relationAdjustment}", "sample": "${p.relationSample}" }]`,
        `      },`,
        `      "registeredAtChapter": 1,`,
        `      "intrinsic": {`,
        `        "gender": "male|female|nonbinary|unknown|undisclosed|not_applicable|custom",`,
        `        "genderLabel": "${p.genderLabel}",`,
        `        "species": "${p.species}",`,
        `        "form": "${p.form}",`,
        `        "ageBand": "${p.ageBand}",`,
        `        "birthOrder": "${p.birthOrder}",`,
        `        "role": "${p.role}",`,
        `        "coreAppearance": [${p.coreAppearance}],`,
        `        "visualHints": {`,
        `          "hair": "${p.hair}",`,
        `          "eyes": "${p.eyes}",`,
        `          "build": "${p.build}",`,
        `          "attire": "${p.attire}",`,
        `          "distinguishing": [${p.distinguishing}],`,
        `          "vibe": "${p.vibe}"`,
        `        }`,
        `      },`,
        `      "dramaticModel": {`,
        `        "valueOrder": [${p.valueOrder}],`,
        `        "behaviorTraits": [{"trigger":"${p.trigger}","actionBias":"${p.actionBias}","benefit":"${p.benefit}","cost":"${p.cost}"}],`,
        `        "perception": {"seesFirst":["${p.seesFirst}"],"missesFirst":["${p.missesFirst}"]},`,
        `        "defense": {"public":"${p.defensePublic}","underPressure":"${p.defenseUnderPressure}"},`,
        `        "repair": {"firstMove":"${p.repairFirstMove}","cannotDo":"${p.repairCannotDo}"},`,
        `        "privateDelights": ["${p.privateDelights}"],`,
        `        "unproductiveWant": "${p.unproductiveWant}",`,
        `        "dimensionBaselines": {"${p.dimensionKey}": 0},`,
        `        "genreDetails": {"${p.genreDetailKey}":"${p.genreDetailValue}"}`,
        `      },`,
        `      "mutable": { "status": "alive", "location": "${p.location}", "knownFacts": [] },`,
        `      "relationships": [{ "to": "c2", "kind": "${p.relationshipKind}", "state": "${p.relationshipState}" }]`,
        `    }`,
        `  ]`,
        `}`,
    ];
}
function buildCastPrompt(input, world, context, repair = null) {
    const ctx = resolvePromptLanguageContext(context ?? {});
    const labels = pickByFamily(ctx, { ko: CAST_LABELS_KO, multilingual: CAST_LABELS_EN });
    const placeholders = pickByFamily(ctx, {
        ko: CAST_SCHEMA_PLACEHOLDERS_KO,
        multilingual: CAST_SCHEMA_PLACEHOLDERS_EN,
    });
    const briefLine = input.brief && input.brief.length > 0 ? labels.brief(input.brief) : '';
    const worldFactBlock = world.worldFacts
        .map((wf, i) => `  ${i + 1}. ${wf.statement}`)
        .join('\n');
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
        labels.premise(world.premise),
        '',
        labels.worldFactsHeading,
        worldFactBlock,
        '',
        labels.task,
        '',
        ...labels.rules,
        '',
        labels.output,
        labels.schema,
        ...castSchemaLines(placeholders),
        ...castRepairLines(labels, repair),
    ]
        .filter((line) => line !== '')
        .join('\n');
}
/**
 * 수정 재요청 절. 파싱 실패는 형식만, 설계 위반은 인물별 코드와 코드의 요구를 적는다.
 * 이전 응답을 그대로 붙여 지목되지 않은 인물·값을 유지하도록 한다.
 */
function castRepairLines(labels, repair) {
    if (!repair)
        return [];
    const lines = ['', labels.repairHeading];
    if (repair.kind === 'parse') {
        lines.push(labels.repairParse);
    }
    else {
        const byCharacter = new Map();
        for (const violation of repair.violations) {
            const list = byCharacter.get(violation.characterId) ?? [];
            list.push(violation.code);
            byCharacter.set(violation.characterId, list);
        }
        for (const [id, codes] of byCharacter)
            lines.push(labels.repairViolation(id, codes));
        lines.push(labels.repairCodes);
    }
    lines.push(labels.repairInstruction, '', labels.repairPrevious, repair.previous);
    return lines;
}
/** 계열별 cast-design system. ko 값은 기존 문자열과 동일하다. */
export const CAST_DESIGN_STEP_SYSTEM = '한국어 소설 초기 캐스트 디자이너. JSON 만 출력. intrinsic 핀고정 계약 준수.';
export const CAST_DESIGN_STEP_SYSTEM_MULTILINGUAL = 'Initial cast designer for a novel in the target work language. Output JSON only. Honour the pin-on-register intrinsic contract, and keep JSON keys, ids and enum values verbatim.';
/** ADR-0006 promptManifest 수집용 계열 정적 표면. */
export function castDesignSystemStatic(family) {
    return pickByFamily(promptFamilyCaptureContext(family), {
        ko: CAST_DESIGN_STEP_SYSTEM,
        multilingual: CAST_DESIGN_STEP_SYSTEM_MULTILINGUAL,
    });
}
/**
 * @param {object} ctx
 * @param {object} input book-create 입력(`language`/`workContract`/`length`/`chapterWordCount` 포함 가능)
 * @param {object} world worldbuild 산출물
 * @param {object} [promptLanguage] 상위 composer 가 이미 해석한 언어 컨텍스트(선택).
 *
 * 4번째 인자는 **선택**이다. 공개 3-인자 호출에서도 `input.language`/`input.workContract`
 * (또는 `input.foundation` 의 저장 메타데이터)로 계열을 정한다 — 그래야 `language:'ja'`
 * 로 부른 공개 호출이 한국어 system 을 받지 않는다. 4번째 인자가 함께 오면 input 의
 * 명시 값과 일치하는지 확인하고, 어긋나면 조용히 한쪽을 고르지 않고 거부한다.
 */
export async function llmCastDesign(ctx, input, world, promptLanguage) {
    const hasLegacyTarget = input.chapterWordCount !== undefined && input.chapterWordCount !== null;
    // 계약도 언어도 없으면 구형 ko 해석이라 프롬프트가 기존과 동일하다.
    const language = resolveStepPromptLanguage({
        ...(promptLanguage === undefined || promptLanguage === null ? {} : { promptLanguage }),
        workContract: input.workContract ?? null,
        language: input.language ?? null,
        length: input.length ?? null,
        ...(hasLegacyTarget ? { legacyLength: { chapterWordCount: input.chapterWordCount } } : {}),
        foundation: input.foundation ?? null,
    });
    // 수정 재요청 예산. 기본 0 = 기존과 동일하게 단발 요청. 호스트(플러그인)가 1 을 넘기면
    // JSON 파싱 실패 또는 strict 설계 위반을 한 번 더 같은 계열 프롬프트로 고쳐 받는다.
    const repairBudget = Number.isInteger(input.castDesignRepairAttempts) && input.castDesignRepairAttempts > 0
        ? input.castDesignRepairAttempts
        : 0;
    let repair = null;
    for (let request = 1;; request++) {
        const prompt = buildCastPrompt(input, world, language, repair);
        const res = await ctx.providers.complete({
            model: ctx.model,
            step: 'cast-design',
            messages: [
                {
                    role: 'system',
                    content: [
                        pickByFamily(language, {
                            ko: CAST_DESIGN_STEP_SYSTEM,
                            multilingual: CAST_DESIGN_STEP_SYSTEM_MULTILINGUAL,
                        }),
                        // 인물 설계는 회차 분량 산출물이 아니다 — 분량 목표 줄은 뺀다.
                        ...languageSystemLines(language, { includeChapterLength: false }),
                    ].join(' '),
                },
                { role: 'user', content: prompt },
            ],
            jsonMode: true,
        });
        const outcome = parseCastDesignResponse(res.text);
        if (outcome.error) {
            if (request <= repairBudget) {
                repair = { kind: 'parse', previous: String(res.text ?? '') };
                continue;
            }
            throw new Error('castDesign parse failed');
        }
        const violations = outcome.characters.flatMap((character) => (character.designViolations ?? []).map((code) => ({ characterId: character.id, code })));
        if (violations.length > 0 && request <= repairBudget) {
            repair = { kind: 'design', violations, previous: String(res.text) };
            continue;
        }
        return outcome.result;
    }
}
/**
 * 응답 하나를 파싱·정규화한다. 형식 오류는 `{ error: true }` 로 돌려 호출자가 수정 재요청
 * 예산 안에서 처리하게 하고, 인물별 strict 설계 위반은 `designViolations` 에 남긴다.
 */
function parseCastDesignResponse(text) {
    const res = { text };
    // 펜스만 벗긴다. 형식 오류는 수정하지 않는다.
    const parsed = parseJsonCompletion(res.text);
    if (parsed === undefined) {
        return { error: true };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { error: true };
    }
    const rawList = parsed.characters;
    if (rawList !== undefined && !Array.isArray(rawList)) {
        return { error: true };
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
    return { error: false, characters, result: { characters, salienceProfile: normalizeSalienceProfile(parsed.salienceProfile, characters) } };
}
