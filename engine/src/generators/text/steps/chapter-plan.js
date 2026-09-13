/**
 * chapterPlan — single-pass LLM call producing a 1-paragraph chapter plan.
 *
 * Why a separate plan step (engine design §4.3):
 *   The draft prompt is large (foundation + prev state + manifest schema +
 *   sentinel format). Folding "what should this chapter be about" into draft
 *   forces the writer to plan and write in one breath, which empirically
 *   produces meandering openings. A separated plan call costs ~$0.001 against
 *   a small model and dramatically tightens the draft's first paragraph.
 *
 * The result is a JSON envelope with plan, scene, and tension fields.
 */
import { EMPTY_SCENE } from '../../../core/entity-context.js';
import { languageSystemLines, pickByFamily, promptFamilyCaptureContext, resolvePromptLanguageContext, resolveStepPromptLanguage, } from '../../../core/prompt-language.js';
import { buildColdOpenInstruction } from './cold-open-beat.js';
import { isHookActive } from '../../../continuity/story-state.js';
// Exported (PLAN_HEADER / PLAN_OUTPUT_RULE / PLAN_RULE_LEGACY_FALLBACK) for
// ADR-0006 promptManifest collection. CHAPTER_PLAN_STATIC = arc-free legacy
// system prompt; manifest hashing uses this single fragment.
export const PLAN_HEADER = [
    '당신은 한국어 웹소설 회차 기획자이다.',
    '제공된 Foundation 요약과 이전 회차 상태를 읽고, 이번 회차에서 일어날 일을 한 문단으로 설계한다.',
].join(' ');
export const PLAN_OUTPUT_RULE = [
    '분량은 한 문단(3~5문장) 한국어. 출력은 코드 블록 없이 순수 JSON 한 개.',
    '키 plan 에 한국어 문장. 키 scene 에 { settings, characters, items, antagonists, additionalRefs } 5개 string array',
    '— 각 값 = registered entity 의 entityId 또는 canonicalName (Foundation/WorldEntity 에 있는 것 우선; 없으면 신규 mention 으로 인정).',
    'scene 의 각 array 가 비어도 그 키는 반드시 출력한다 (skip 금지).',
    '키 tension 에 { ticking, stake, escalation } 객체 — 각 값은 짧은 한국어 한 문장 또는 빈 string. tension 키는 반드시 출력한다.',
    '1화에서는 키 openingContract 도 출력한다: { surfaceEvent, worldPressure, characterWound, misbelief, firstIrreversibleChoice, withheldContext, viewpointReason }. 1화가 아니면 생략 가능.',
].join(' ');
/**
 * EPIC #364 S3 (#367) — plan §3.1. 구조화 tension 3 슬롯 산출 지시.
 * Q2: 3 슬롯 모두 optional (해당 없으면 빈 string). 모든 화에 ticking 강제 금지.
 *   - ticking: 이번 화에 작동하는 시간/외부 압박 (없으면 빈 string).
 *   - stake: 이 화에서 주인공이 잃을 수 있는 것.
 *   - escalation: 이전 화 대비 장애/위협이 어떻게 더 커지는가.
 */
export const PLAN_TENSION_RULE = [
    'tension 3 슬롯을 설계한다:',
    'ticking(시간/외부 압박), stake(주인공이 잃을 수 있는 것), escalation(이전 화 대비 장애/위협 증대).',
    '셋 다 강제는 아니다 — 이번 화에 해당이 없는 슬롯은 빈 string 으로 둔다 (억지로 ticking clock 을 만들지 말 것).',
].join(' ');
/** Legacy '한 회차에 갈등1+진행/해결1+훅1' — Arc 미연결 작품. */
export const PLAN_RULE_LEGACY_FALLBACK = '회차는 명확한 갈등 1개 + 진행/해결 1개 + 다음 회차 훅 1개를 가진다.';
/**
 * 다국어 계열 계획 지시. ko 문장의 번역이 아니라 같은 기획 의도를 영어 지시로 쓴
 * 별도 계열이다. **지시는 영어, 산출되는 산문 값(plan/tension/openingContract)은
 * 목표 작품 언어** 이며 JSON 키·enum·entityId 는 기계 계약이라 그대로다.
 */
export const PLAN_HEADER_MULTILINGUAL = [
    'You are a serial-fiction chapter planner.',
    'Read the Foundation summary and the previous chapter state, and design what happens in this chapter as a single paragraph.',
].join(' ');
export const PLAN_OUTPUT_RULE_MULTILINGUAL = [
    'The plan is one paragraph (3-5 sentences) written in the target work language. Output exactly one JSON object with no code fence.',
    'Key plan holds that paragraph. Key scene holds { settings, characters, items, antagonists, additionalRefs }, five string arrays',
    '— each value is a registered entity\'s entityId or canonicalName (prefer ones already in the Foundation/WorldEntity; otherwise it counts as a new mention).',
    'Emit every key of scene even when its array is empty (never skip a key).',
    'Key tension holds { ticking, stake, escalation } — each value is one short sentence in the target work language, or an empty string. The tension key is always emitted.',
    'For chapter 1 also emit openingContract: { surfaceEvent, worldPressure, characterWound, misbelief, firstIrreversibleChoice, withheldContext, viewpointReason }. It may be omitted for later chapters.',
    'Do not translate JSON keys, enum values or entity ids.',
].join(' ');
export const PLAN_TENSION_RULE_MULTILINGUAL = [
    'Design the three tension slots:',
    'ticking (a clock or outside pressure), stake (what the protagonist can lose), escalation (how the obstacle or threat grows against the previous chapter).',
    'None of the three is mandatory — leave a slot as an empty string when this chapter has none (do not manufacture a ticking clock).',
].join(' ');
export const PLAN_RULE_LEGACY_FALLBACK_MULTILINGUAL = 'The chapter carries one clear conflict, one step of progress or resolution, and one hook into the next chapter.';
/**
 * ADR-0006 (issue #211) — arc-free static plan system prompt used for
 * promptManifest hash input. Arc-aware variants 는 runtime concat 이라
 * static manifest 에 포함 X.
 *
 * 계열이 둘이므로 정적 표면도 둘이다. 기존 ko 값은 hash 입력이라 **그대로** 두고
 * 다국어 계열은 별도 상수로 노출한다 — 수집(engine-version.js)은 다른 소유자다.
 */
export const CHAPTER_PLAN_STATIC = [
    PLAN_HEADER,
    PLAN_RULE_LEGACY_FALLBACK,
    PLAN_TENSION_RULE,
    PLAN_OUTPUT_RULE,
].join(' ');
export const CHAPTER_PLAN_STATIC_MULTILINGUAL = [
    PLAN_HEADER_MULTILINGUAL,
    PLAN_RULE_LEGACY_FALLBACK_MULTILINGUAL,
    PLAN_TENSION_RULE_MULTILINGUAL,
    PLAN_OUTPUT_RULE_MULTILINGUAL,
].join(' ');
/**
 * EPIC #364 S3 (#367) — arc position 별 tension 강조 차등 (plan §3.1).
 *   - rising/midpoint → escalation 강제 강조 (상승/중간 박자엔 위협이 자라야 함).
 *   - closing → stake 정산 강조 (종결 박자엔 약속한 대가/상실 결판).
 *   - 나머지(opening/falling) → 모두 optional, 추가 강조 없음.
 * arc 없으면 빈 string (legacy — tension 자체는 PLAN_TENSION_RULE 로 여전히 요청).
 */
export function planTensionEmphasis(position, context) {
    return pickByFamily(context ?? {}, {
        ko: () => {
            switch (position) {
                case 'rising':
                case 'midpoint':
                    return 'tension.escalation 은 이 박자에서 반드시 채운다 — 이전 화 대비 위협/장애가 한 단계 더 커지는 지점을 명시.';
                case 'closing':
                    return 'tension.stake 는 이 박자에서 반드시 채운다 — 주인공이 무엇을 잃거나 지키는지(대가)를 정산.';
                default:
                    return '';
            }
        },
        multilingual: () => {
            switch (position) {
                case 'rising':
                case 'midpoint':
                    return 'tension.escalation must be filled on this beat — name the point where the threat or obstacle grows one step beyond the previous chapter.';
                case 'closing':
                    return 'tension.stake must be filled on this beat — settle what the protagonist loses or keeps, and at what cost.';
                default:
                    return '';
            }
        },
    });
}
/**
 * Arc-aware plan rule. 화 단위 self-contained 강제 제거. arc 5-구간 별 박자
 * instruction — closing 만 강한 break (Arc Promise 정산 + 훅). 구간 키는 기계
 * enum 이라 두 계열에서 동일하다.
 */
function planArcRule(position, context) {
    return pickByFamily(context, {
        ko: () => {
            switch (position) {
                case 'opening':
                    return '이번 화는 Arc 도입 박자. 사건 trigger + 호기심 1 — 무리한 마무리 X, 다음 박자로 흐름이 자연스럽게 이어지는 형태.';
                case 'rising':
                    return '이번 화는 Arc 상승 박자. 갈등 누적 1 + 인물 압력 증대 — 일직선 진행, 매 화 self-contained 마무리·재출발 패턴 금지.';
                case 'midpoint':
                    return '이번 화는 Arc 중간 박자. 작은 반전 1 또는 인물 자각 1 — Arc 방향이 살짝 굽는 지점, 마무리 형태로 닫지 말 것.';
                case 'falling':
                    return '이번 화는 Arc 하강 박자. 떡밥 회수 1 + 결론 향한 수렴 — 일직선 진행, 인위적 cliffhanger 없이 다음 박자로 흐름.';
                case 'closing':
                    return '이번 화는 Arc 종결 박자. Arc Promise 정산 (약속한 변화/사건 완결) + 다음 Arc 훅 1.';
                default:
                    return PLAN_RULE_LEGACY_FALLBACK;
            }
        },
        multilingual: () => {
            switch (position) {
                case 'opening':
                    return 'This chapter is the arc\'s opening beat. One event trigger plus one open curiosity — no forced ending; let it flow into the next beat.';
                case 'rising':
                    return 'This chapter is a rising beat. One accumulation of conflict plus rising pressure on the characters — move in a straight line, no self-contained close-and-restart pattern.';
                case 'midpoint':
                    return 'This chapter is the arc\'s midpoint beat. One small reversal or one moment of self-recognition — the arc bends here; do not close it off.';
                case 'falling':
                    return 'This chapter is a falling beat. Pay off one planted setup and converge toward the conclusion — a straight line, flowing into the next beat without an artificial cliffhanger.';
                case 'closing':
                    return 'This chapter is the arc\'s closing beat. Settle the Arc Promise (complete the promised change or event) plus one hook into the next arc.';
                default:
                    return PLAN_RULE_LEGACY_FALLBACK_MULTILINGUAL;
            }
        },
    });
}
/**
 * Arc Flow Stage A (EPIC #191) — system prompt builder.
 *   - 1화 일 때: buildColdOpenInstruction (좌담 #02 cold-open) append.
 *   - arc 있으면: Arc 박자별 instruction.
 *   - arc 없으면: legacy '갈등1+진행/해결1+훅1' 강제.
 *
 * 다국어 Phase 2A — 3번째 인자는 선택적 언어 컨텍스트다. 없으면 구형 ko 해석이라
 * 기존 프롬프트가 byte-identical 로 유지된다. 언어 지시문에서 **회차 분량 줄은
 * 뺀다** — 기획의 출력 분량은 한 문단이지 회차 분량이 아니다.
 */
export function systemPromptFor(chapterNumber, arc, context) {
    const ctx = resolvePromptLanguageContext(context ?? {});
    const header = pickByFamily(ctx, { ko: PLAN_HEADER, multilingual: PLAN_HEADER_MULTILINGUAL });
    const legacyRule = pickByFamily(ctx, {
        ko: PLAN_RULE_LEGACY_FALLBACK,
        multilingual: PLAN_RULE_LEGACY_FALLBACK_MULTILINGUAL,
    });
    const arcRule = arc ? planArcRule(arc.currentPosition, ctx) : legacyRule;
    // EPIC #364 S3 (#367) — tension rule + arc position emphasis.
    const tensionEmphasis = planTensionEmphasis(arc?.currentPosition, ctx);
    const baseTensionRule = pickByFamily(ctx, {
        ko: PLAN_TENSION_RULE,
        multilingual: PLAN_TENSION_RULE_MULTILINGUAL,
    });
    const tensionRule = tensionEmphasis ? `${baseTensionRule} ${tensionEmphasis}` : baseTensionRule;
    const outputRule = pickByFamily(ctx, { ko: PLAN_OUTPUT_RULE, multilingual: PLAN_OUTPUT_RULE_MULTILINGUAL });
    const directive = languageSystemLines(ctx, { includeChapterLength: false });
    const base = [header, ...directive, arcRule, tensionRule, outputRule].join(' ');
    if (chapterNumber === 1) {
        return base + '\n' + buildColdOpenInstruction(ctx);
    }
    return base;
}
/** ADR-0006 promptManifest 수집용 계열 정적 표면. */
export function chapterPlanStatic(family) {
    return systemPromptFor(2, null, promptFamilyCaptureContext(family));
}
function buildUserPrompt(input) {
    const { foundation, prevState, chapterNumber } = input;
    const ctx = resolveStepPromptLanguage(input);
    const labels = pickByFamily(ctx, { ko: PLAN_USER_LABELS_KO, multilingual: PLAN_USER_LABELS_EN });
    const foundationSummary = {
        genre: foundation.genre,
        characters: foundation.characters.map((c) => ({
            id: c.id,
            canonicalName: c.canonicalName,
            role: c.intrinsic.role,
        })),
        worldFacts: foundation.worldFacts.map((f) => f.statement),
    };
    const prevSummary = {
        chapterNumber: prevState.chapterNumber,
        openHooks: (prevState.hooks ?? [])
            .filter(isHookActive)
            .map((h) => ({ id: h.id, text: h.text, phase: h.phase })),
    };
    return [
        labels.chapterNumber,
        String(chapterNumber),
        ``,
        labels.foundation,
        JSON.stringify(foundationSummary, null, 2),
        ``,
        labels.prevState,
        JSON.stringify(prevSummary, null, 2),
        ``,
        labels.schemaHeading,
        chapterNumber === 1 ? labels.schemaChapterOne : labels.schema,
    ].join('\n');
}
/**
 * JSON 키는 두 계열에서 동일한 기계 계약이다. 계열이 바꾸는 것은 **라벨과 스키마
 * 설명 문자열**뿐이며, 비ko 설명은 영어 지시로 쓰되 산출될 산문 값은 목표 작품
 * 언어로 요구한다.
 */
const PLAN_USER_LABELS_KO = {
    chapterNumber: '## 회차 번호',
    foundation: '## Foundation 요약',
    prevState: '## 이전 상태 요약 (StoryState N-1)',
    schemaHeading: '## 출력 스키마 (이 JSON 한 개만 출력)',
    schema: '{ "plan": "이번 회차 전개 한 문단 한국어 요약", "scene": { "settings": [], "characters": [], "items": [], "antagonists": [], "additionalRefs": [] }, "tension": { "ticking": "", "stake": "", "escalation": "" } }',
    schemaChapterOne: '{ "plan": "이번 회차 전개 한 문단 한국어 요약", "scene": { "settings": [], "characters": [], "items": [], "antagonists": [], "additionalRefs": [] }, "tension": { "ticking": "", "stake": "", "escalation": "" }, "openingContract": { "surfaceEvent": "", "worldPressure": "", "characterWound": "", "misbelief": "", "firstIrreversibleChoice": "", "withheldContext": "", "viewpointReason": "" } }',
};
const PLAN_USER_LABELS_EN = {
    chapterNumber: '## Chapter number',
    foundation: '## Foundation summary',
    prevState: '## Previous state summary (StoryState N-1)',
    schemaHeading: '## Output schema (emit this one JSON object only)',
    schema: '{ "plan": "<one paragraph in the target work language describing what happens in this chapter>", "scene": { "settings": [], "characters": [], "items": [], "antagonists": [], "additionalRefs": [] }, "tension": { "ticking": "", "stake": "", "escalation": "" } }',
    schemaChapterOne: '{ "plan": "<one paragraph in the target work language describing what happens in this chapter>", "scene": { "settings": [], "characters": [], "items": [], "antagonists": [], "additionalRefs": [] }, "tension": { "ticking": "", "stake": "", "escalation": "" }, "openingContract": { "surfaceEvent": "", "worldPressure": "", "characterWound": "", "misbelief": "", "firstIrreversibleChoice": "", "withheldContext": "", "viewpointReason": "" } }',
};
/** Strip optional ```json fences and trim. Defensive against models that wrap output. */
function stripJsonFence(text) {
    let t = text.trim();
    if (t.startsWith('```')) {
        const firstNl = t.indexOf('\n');
        if (firstNl >= 0)
            t = t.slice(firstNl + 1);
        if (t.endsWith('```'))
            t = t.slice(0, -3);
    }
    return t.trim();
}
export function parsePlanPayload(text) {
    const empty = { plan: text.trim(), scene: { ...EMPTY_SCENE }, tension: {}, openingContract: {} };
    if (!text)
        return { plan: '', scene: { ...EMPTY_SCENE }, tension: {}, openingContract: {} };
    try {
        const parsed = JSON.parse(stripJsonFence(text));
        if (parsed && typeof parsed === 'object') {
            const obj = parsed;
            const plan = typeof obj.plan === 'string' ? obj.plan.trim() : text.trim();
            const scene = coerceScene(obj.scene);
            const tension = coerceTension(obj.tension);
            const openingContract = coerceOpeningContract(obj.openingContract);
            return { plan, scene, tension, openingContract };
        }
    }
    catch {
        // fallthrough — return raw text trimmed so caller still has *something*.
    }
    return empty;
}
function coerceScene(raw) {
    if (!raw || typeof raw !== 'object')
        return { ...EMPTY_SCENE };
    const obj = raw;
    const arr = (v) => Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0).slice(0, 30) : [];
    return {
        settings: arr(obj.settings),
        characters: arr(obj.characters),
        items: arr(obj.items),
        antagonists: arr(obj.antagonists),
        additionalRefs: arr(obj.additionalRefs),
    };
}
/**
 * EPIC #364 S3 (#367) — tension coercion. legacy 호환 필수:
 * tension 없거나 malformed (object 아님) → 빈 객체 {}.
 * 각 필드는 non-empty string 일 때만 채우고, 빈 string/비-string 은 undefined
 * 로 떨궈 ChapterTension 의 optional 의미를 보존 (draft 가 "채워졌으면" 분기).
 */
export function coerceTension(raw) {
    if (!raw || typeof raw !== 'object')
        return {};
    const obj = raw;
    const str = (v) => {
        if (typeof v !== 'string')
            return undefined;
        const t = v.trim();
        return t.length > 0 ? t : undefined;
    };
    const result = {};
    const ticking = str(obj.ticking);
    const stake = str(obj.stake);
    const escalation = str(obj.escalation);
    if (ticking !== undefined)
        result.ticking = ticking;
    if (stake !== undefined)
        result.stake = stake;
    if (escalation !== undefined)
        result.escalation = escalation;
    return result;
}

export function coerceOpeningContract(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return {};
    const obj = raw;
    const result = {};
    for (const key of [
        'surfaceEvent',
        'worldPressure',
        'characterWound',
        'misbelief',
        'firstIrreversibleChoice',
        'withheldContext',
        'viewpointReason',
    ]) {
        const value = obj[key];
        if (typeof value !== 'string')
            continue;
        const trimmed = value.trim();
        if (trimmed.length > 0)
            result[key] = trimmed;
    }
    return result;
}
export async function runChapterPlan(input) {
    // system 과 user 가 같은 계약을 보도록 한 번만 해석한다. 계약이 없으면 구형 ko.
    const promptLanguage = resolveStepPromptLanguage(input);
    const userPrompt = buildUserPrompt({ ...input, promptLanguage });
    let text = '';
    try {
        const response = await input.providers.complete({
            model: input.model,
            jsonMode: true,
            step: 'chapter-plan',
            messages: [
                { role: 'system', content: systemPromptFor(input.chapterNumber, input.arc, promptLanguage) },
                { role: 'user', content: userPrompt },
            ],
        });
        text = response.text;
    }
    catch {
        // Provider failure → degrade to empty plan; draft still runs with foundation/state context.
        text = '';
    }
    return parsePlanPayload(text);
}
