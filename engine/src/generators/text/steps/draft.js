/**
 * Draft step — request chapter prose and a structured cast manifest.
 *
 * The manifest records which characters appeared and which address terms they
 * used. Metadata uses the reserved ⟦vle:tag …⟧ syntax. OutputSanitizer removes
 * complete blocks and rejects residual machine annotations before persistence.
 */
import { resolveCharacter } from '../../../continuity/foundation.js';
import { arcPositionLabel } from '../../../core/arc-context.js';
import { renderCustomPromptOverride } from '../../../core/custom-prompt-override.js';
import { formatLengthTarget, pickByFamily, promptFamilyCaptureContext, resolveDialogueBreakMode, resolvePromptLanguageContext, resolveStepPromptLanguage, resolveWorkPromptLanguage, } from '../../../core/prompt-language.js';
import { DRAFT_FEWSHOT, DRAFT_FEWSHOT_MULTILINGUAL } from '../prompts/draft.js';
import { isHookActive } from '../../../continuity/story-state.js';
/**
 * Default target word count when the foundation does not record one.
 *
 * 다국어 Phase 2A: 이름과 무관하게 **legacyCodeUnits** 로만 해석한다
 * (`LEGACY_LENGTH_FIELDS` 계약). 언어 계약이 함께 오면 계약의 length 가 원천이며
 * 이 상수는 계약도 언어도 없는 구형 호출에서만 쓰인다.
 */
export const DEFAULT_TARGET_WORD_COUNT = 3500;
/**
 * draft 입력에서 프롬프트 언어 컨텍스트를 만든다.
 *
 * - `workContract` 가 오면 그대로 쓴다(재해석·override 금지).
 * - 계약이 없고 `language` 만 오면 계약을 조립한다. 분량은 `length`(신규 단위 지정)
 *   또는 구형 `targetWordCount`(= legacyCodeUnits)로만 정해지며, 둘 다 없으면
 *   `resolveLengthContract` 의 계열 기본값을 따른다.
 * - 계약도 언어도 없으면 구형 ko 해석 + 기존 3500 기본값이라 프롬프트가 변하지 않는다.
 */
function draftLanguageContext(input) {
    // 호출자가 **실제로 적은** 구형 목표만 중복 지정으로 본다. 생략된 기본값
    // (DEFAULT_TARGET_WORD_COUNT)은 중복이 아니다.
    const hasLegacyTarget = input.targetWordCount !== undefined && input.targetWordCount !== null;
    const legacyLength = hasLegacyTarget ? { chapterWordCount: input.targetWordCount } : null;
    const foundation = input.foundation ?? null;
    if (input.promptLanguage) {
        const supplied = resolvePromptLanguageContext(input.promptLanguage);
        if (supplied.explicit) {
            // 이미 확정된 계약과 함께 구형 목표가 오면 조용히 버리지 않고 같은
            // legacyCodeUnits 목표인지 확인한다(어긋나면 LENGTH_CONTRACT_CONFLICT).
            // 저장된 Foundation 메타데이터도 같은 계약인지 함께 확인한다.
            return resolveStepPromptLanguage({
                promptLanguage: supplied,
                foundation,
                ...(legacyLength === null ? {} : { legacyLength }),
            });
        }
        // 암묵적 ko 컨텍스트는 아직 분량 계약을 확정하지 않은 상태다. 구형
        // targetWordCount(= legacyCodeUnits)로 다시 해석해 기존 기본값을 지킨다.
        return resolvePromptLanguageContext({
            legacyLength: { chapterWordCount: input.targetWordCount ?? DEFAULT_TARGET_WORD_COUNT },
        });
    }
    const hasContract = input.workContract !== undefined && input.workContract !== null;
    const hasLanguage = input.language !== undefined && input.language !== null;
    // 저장된 작품 언어 메타데이터(Foundation)도 계약 원천이다 — 단독 호출이 언어를
    // 다시 넘기지 않아도 작품 언어가 구형 ko 로 떨어지지 않는다.
    const hasStored = (foundation?.workContract ?? null) !== null || (foundation?.language ?? null) !== null;
    if (hasContract || hasLanguage || hasStored) {
        // 저장된 계약/언어가 원천이고 함께 온 language/length/targetWordCount 는
        // 전부 확인용이며 하나라도 어긋나면 조용히 덮이는 대신 오류가 난다.
        return resolveWorkPromptLanguage({
            foundation,
            workContract: input.workContract ?? null,
            language: input.language ?? null,
            length: input.length ?? null,
            legacyLength,
        });
    }
    return resolvePromptLanguageContext({
        legacyLength: legacyLength
            ?? (input.length ? null : { chapterWordCount: DEFAULT_TARGET_WORD_COUNT }),
        length: input.length ?? null,
    });
}
/**
 * Arc-aware draft system prompt builder.
 *
 * Arc Flow Stage A (EPIC #191) 변경 — 화 단위 self-contained 강제 제거.
 *   기존: "한 회차에 갈등 1개, 진행 1개, 다음 회차 훅 1개" — 매 화 인위적 마무리 +
 *         새로 열기 (카카오페 절단신공). Arc 가 "큰 이야기" 라는 의도와 충돌.
 *   변경: Arc 5-구간 (opening/rising/midpoint/falling/closing) 별 박자 instruction.
 *         '한 회차' 추상화 → '한 박자' 로 reframe. closing 만 강한 break 요구.
 *   미지정 (legacy): 기존 instruction 유지.
 */
function arcPositionInstructionKo(position) {
    switch (position) {
        case 'opening':
            return [
                '- 이번 화는 Arc 의 도입 박자. 사건 trigger + 호기심 끌기에 집중하고 무리하게 마무리하지 말 것.',
                '- 끝은 다음 박자로 자연스럽게 흘러가는 미완 형태가 좋다. 강한 cliffhanger 없어도 됨.',
            ].join('\n');
        case 'rising':
            return [
                '- 이번 화는 Arc 의 상승 박자. 갈등 누적 + 인물 압력 증대.',
                '- 일직선 진행이 자연스럽다. 매 화 self-contained 마무리·재출발 패턴 금지 — 한 호흡으로 이어 쓴다.',
            ].join('\n');
        case 'midpoint':
            return [
                '- 이번 화는 Arc 의 중간 박자. 작은 반전 1 또는 인물 자각 1 — Arc 방향이 살짝 굽는 지점.',
                '- 마무리 형태로 닫지 말 것. 반전이 다음 박자로 이어지는 형태로 끝낸다.',
            ].join('\n');
        case 'falling':
            return [
                '- 이번 화는 Arc 의 하강 박자. 떡밥 회수 + 결론 향한 수렴.',
                '- 일직선 진행. 인위적 cliffhanger 없이 다음 박자로 흘러가는 형태가 좋다.',
            ].join('\n');
        case 'closing':
            return [
                '- 이번 화는 Arc 의 종결 박자. Arc Promise 를 정산한다 — 약속한 변화/사건의 완결.',
                '- 마지막 단락에 강한 cliffhanger 또는 다음 Arc 훅 1개 (의문문/미완 사건/반전 marker 중 하나).',
            ].join('\n');
        default:
            return '';
    }
}
/**
 * 다국어 계열의 arc 박자 지시. ko 규칙의 번역이 아니라 같은 의도를 영어 집필
 * 지시로 쓴 별도 계열이다. 구간 키는 기계 enum 이라 그대로 둔다.
 */
function arcPositionInstructionMultilingual(position) {
    switch (position) {
        case 'opening':
            return [
                '- This chapter is the arc\'s opening beat. Trigger the event and open curiosity; do not force a tidy ending.',
                '- Ending on an unresolved motion into the next beat is good. A hard cliffhanger is not required.',
            ].join('\n');
        case 'rising':
            return [
                '- This chapter is a rising beat. Accumulate conflict and increase pressure on the characters.',
                '- Move in a straight line. Do not close and re-open a self-contained episode each chapter — write it as one continuous breath.',
            ].join('\n');
        case 'midpoint':
            return [
                '- This chapter is the arc\'s midpoint beat. One small reversal or one moment of self-recognition — the point where the arc bends.',
                '- Do not close it off. End so that the reversal carries into the next beat.',
            ].join('\n');
        case 'falling':
            return [
                '- This chapter is a falling beat. Pay off planted setups and converge toward the conclusion.',
                '- Move in a straight line. Flowing into the next beat without an artificial cliffhanger is good.',
            ].join('\n');
        case 'closing':
            return [
                '- This chapter is the arc\'s closing beat. Settle the Arc Promise — complete the change or event that was promised.',
                '- In the final paragraph, land one strong cliffhanger or one hook into the next arc (an open question, an unfinished event, or a reversal marker).',
            ].join('\n');
        default:
            return '';
    }
}
function arcPositionInstruction(position, context) {
    return pickByFamily(context, {
        ko: () => arcPositionInstructionKo(position),
        multilingual: () => arcPositionInstructionMultilingual(position),
    });
}
/**
 * 분량 규칙 한 줄. counter 가 세는 단위와 지시가 어긋나지 않도록 계약 단위를
 * 그대로 부른다(구형 legacyCodeUnits ko 는 기존 '목표 글자 수' 문구 유지).
 */
function lengthRuleLine(context) {
    return pickByFamily(context, {
        ko: (ctx) => ctx.length.unit === 'legacyCodeUnits'
            ? '- 분량은 목표 글자 수 ±15% 내.'
            : `- 분량은 목표 분량(${ctx.length.unit}) ±15% 내.`,
        multilingual: (ctx) => `- Stay within ±15% of the length target, measured in ${ctx.length.unit}.`,
    });
}
function draftRulesBase(context) {
    return pickByFamily(context, {
        ko: (ctx) => [
            '본문 작성 규칙:',
            '- 본문은 자연스러운 한국어 prose. 부제목/장 번호/메타 주석/내부 메모는 금지.',
            '- 캐릭터 intrinsic(성별, 연령대, 역할) 은 Foundation 기준. 본문이 이와 모순되면 안 된다.',
            '- 호칭은 화자→대상 관계와 캐릭터 성별을 고려해 선택한다.',
            lengthRuleLine(ctx),
        ].join('\n'),
        multilingual: (ctx) => [
            'Chapter writing rules:',
            '- Write natural prose in the target work language. No subtitles, chapter numbers, meta commentary, or internal notes.',
            '- Character intrinsics (gender, age band, role) follow the Foundation. The prose must not contradict them.',
            '- Choose forms of address from the speaker-to-listener relationship and the conventions of the target language, not from Korean honorific rules.',
            lengthRuleLine(ctx),
        ].join('\n'),
    });
}
/** Legacy '한 회차에 갈등1+진행1+훅1' 규칙 — Arc 미연결 작품 호환용. */
const DRAFT_RULES_LEGACY_FALLBACK = '- 한 회차에 갈등 1개, 진행 1개, 다음 회차 훅 1개.';
const DRAFT_RULES_LEGACY_FALLBACK_MULTILINGUAL = '- One conflict, one step of progress, and one hook into the next chapter.';
function draftRulesLegacyFallback(context) {
    return pickByFamily(context, {
        ko: DRAFT_RULES_LEGACY_FALLBACK,
        multilingual: DRAFT_RULES_LEGACY_FALLBACK_MULTILINGUAL,
    });
}
/**
 * EPIC #364 S4 (#368) — '생략의 마법' 문체 규칙. plan §3.2.
 * showing/subtext 강제 — 감정 직접진술 억제 + info-dump 억제 + 추론 가능 사실 생략.
 * arc 박자와 무관하게 매 화 적용 (DRAFT_RULES_BASE 와 동급 상시 규칙).
 */
const DRAFT_SHOWING_RULES_HEAD_KO = [
    '서술과 독자 이해 규칙:',
    '- 감정은 행동·감각·대사로 먼저 체감시키되, 장면 이해에 필요한 감정명이나 짧은 명시는 자연스럽게 쓸 수 있다.',
    '- 세계 정보는 현재 선택과 결과에 닿는 만큼 장면·대사·행동에 연결한다. 처음 등장한 핵심 개념은 독자가 표면 뜻을 놓치지 않도록 한 번은 명료하게 잡아 준다.',
];
/**
 * 대사 문단 규칙은 계열이 아니라 **포맷 정책**이 정한다(`dialogueBreakMode`).
 *   - `strict`  : ko 기본. 모바일 웹소설 관습 — 기존 문구 그대로.
 *   - `relaxed` : 서술 문단 안 대사는 허용, 긴 서술 뒤 파묻기만 금지(기존 검사기 의미).
 *   - `natural` : 비ko 기본. 목표 언어 산문 관습을 따르며 한국어식 밀도/고립 제한 없음.
 */
const DIALOGUE_FORMAT_RULE_KO = {
    strict: '- 대사와 서술은 모바일에서 구분하되, 하나의 원인·반응·결과로 이어지는 짧은 서술은 한 문단에 묶어 호흡을 만든다.',
    relaxed: '- 대사는 서술 문단 안에 놓을 수 있지만 긴 서술 뒤에 파묻지 않는다. 하나의 원인·반응·결과로 이어지는 짧은 서술은 한 문단에 묶어 호흡을 만든다.',
    natural: '- 대사와 서술의 배치는 목표 독자의 산문 관습에 맞춘다. 대사 독립 문단이나 문단 밀도 상한을 강제하지 않는다.',
};
const DIALOGUE_FORMAT_RULE_MULTILINGUAL = {
    strict: '- Give each line of dialogue its own paragraph, and keep paragraphs short enough to read comfortably on a phone.',
    relaxed: '- Dialogue may sit inside a narrative paragraph, but do not bury it at the end of a long stretch of narration.',
    natural: '- Follow the dialogue and paragraph conventions of the target language: inline speech attribution and dialogue inside a narrative paragraph are both fine. Do not impose paragraph-density caps or one-line-per-utterance layout from another market.',
};
const DRAFT_SHOWING_RULES = [...DRAFT_SHOWING_RULES_HEAD_KO, DIALOGUE_FORMAT_RULE_KO.strict].join('\n');
const DRAFT_VOICE_RULES = [
    '인물 음성 규칙:',
    '- speechProfile 과 이번 화 말투 목표의 sampleLine 은 복사할 문장이 아니라 말투·압력·숨은 목적의 기준 예시다.',
    '- 대사는 독자가 숨은 맥락을 몰라도 표면의 질문·반응·결과를 따라갈 수 있게 쓴다. 모든 발화에 복선이나 권력 싸움을 싣지 말고 반응, 오해, 일상적 말, 침묵도 섞는다.',
    '- 이름을 가려도 누가 말했는지 구분되도록 문장 길이, 존대/반말 조건, 논리 습관, 감정 누출 방식을 다르게 쓴다.',
    '- 같은 인물도 관계와 아크 압력에 따라 말투가 변한다. 변화는 갑작스러운 문체 변경이 아니라 선택 비용의 결과여야 한다.',
    '- 분 단위 시각, 정밀 수치, 코드, 전문어는 문서·화면·작전처럼 그 정밀성이 실제 결정을 바꿀 때 자연스럽다. 일상 대화와 서술에서는 인물과 상황에 맞는 생활 표현을 우선한다.',
].join('\n');
/**
 * 다국어 계열의 서술·음성 규칙. ko 규칙과 같은 작법 의도를 영어 지시로 쓴 별도
 * 계열이며, 한국어 존대/반말 같은 ko 전용 장치는 목표 언어의 등가 장치로 바꿔
 * 말한다.
 */
const DRAFT_SHOWING_RULES_HEAD_MULTILINGUAL = [
    'Narration and reader comprehension rules:',
    '- Let emotion land through action, sensation and dialogue first, but a short, plain naming of the feeling is allowed where the scene needs it to be understood.',
    '- Connect world information to the present choice and its consequence through scene, dialogue and action. The first time a core concept appears, make its surface meaning clear once so the reader does not lose it.',
];
/** 서술 규칙 + 포맷 정책이 정한 대사 문단 한 줄. */
function draftShowingRules(context, dialogueBreakMode) {
    return pickByFamily(context, {
        ko: [...DRAFT_SHOWING_RULES_HEAD_KO, DIALOGUE_FORMAT_RULE_KO[dialogueBreakMode]].join('\n'),
        multilingual: [...DRAFT_SHOWING_RULES_HEAD_MULTILINGUAL, DIALOGUE_FORMAT_RULE_MULTILINGUAL[dialogueBreakMode]].join('\n'),
    });
}
const DRAFT_VOICE_RULES_MULTILINGUAL = [
    'Character voice rules:',
    '- The speechProfile and this chapter\'s sampleLine are reference examples of register, pressure and hidden intent — not sentences to copy.',
    '- Write dialogue so a reader who does not yet know the hidden context can still follow the surface question, reaction and result. Do not load every line with foreshadowing or a power struggle; mix in reaction, misunderstanding, ordinary talk and silence.',
    '- Make speakers distinguishable with names hidden: vary sentence length, the politeness or register conventions of the target language, habits of reasoning, and how feeling leaks out.',
    '- The same character speaks differently under different relationships and arc pressure. That change must read as the cost of a choice, not as an abrupt shift of style.',
    '- Minute-level times, precise figures, code and jargon are natural where that precision actually changes a decision (documents, screens, operations). In ordinary conversation and narration, prefer everyday expression that fits the character and the situation.',
].join('\n');
const DRAFT_MANIFEST_RULES = [
    '회차 종료 시 반드시 다음 sentinel 블록을 본문 마지막 줄에 추가한다 — 단 한 줄, 본문 뒤에 빈 줄 한 개:',
    '⟦vle:cast-manifest {"cast":[{"characterId":"<id>","addressTermsUsed":["<호칭1>","<호칭2>"]},...]}⟧',
    '',
    'manifest 규칙:',
    '- 이번 회차에 실제로 등장한 (대사/행동/시점) 캐릭터만 포함.',
    '- characterId 는 Foundation 의 id 그대로 사용.',
    '- addressTermsUsed 는 해당 캐릭터가 본문에서 다른 캐릭터를 향해 사용한 호칭들의 집합.',
    '- 본문에 `⟦vle:…⟧` 패턴은 cast-manifest 외에 다른 어떤 것도 출력하지 말 것.',
].join('\n');
/** sentinel 문법과 JSON 키는 기계 계약이므로 두 계열에서 동일하다. */
const DRAFT_MANIFEST_RULES_MULTILINGUAL = [
    'At the end of the chapter you must append the following sentinel block as the last line — exactly one line, with one blank line between the prose and it:',
    '⟦vle:cast-manifest {"cast":[{"characterId":"<id>","addressTermsUsed":["<address-term-1>","<address-term-2>"]},...]}⟧',
    '',
    'Manifest rules:',
    '- Include only characters who actually appear in this chapter (speech, action, or viewpoint).',
    '- Use the Foundation id verbatim as characterId. Do not translate ids, JSON keys or the sentinel tag.',
    '- addressTermsUsed is the set of address terms that character used toward other characters in the prose, written in the target work language exactly as they appear in the text.',
    '- Do not emit any `⟦vle:…⟧` pattern other than the cast-manifest block.',
].join('\n');
function buildDraftSystem(arc, customPromptOverride, context, options = {}) {
    const ctx = resolvePromptLanguageContext(context ?? {});
    // 계약에 고정된 포맷 정책이 있으면 그것이, 없으면 호스트가 승인해 넘긴 모드가,
    // 둘 다 없으면 계열 기본값(ko=strict / 비ko=natural)이 적용된다.
    const dialogueBreakMode = resolveDialogueBreakMode(ctx, options.dialogueBreakMode ?? null);
    const header = pickByFamily(ctx, {
        ko: '당신은 한국어 웹소설 작가이다. 제공된 Foundation, 이전 상태 요약, 회차 기획을 읽고 다음 회차를 작성한다.',
        multilingual: 'You are a serial-fiction novelist writing in the target work language. Read the Foundation, the previous state summary and the chapter plan below, and write the next chapter.',
    });
    const arcLines = arc ? arcPositionInstruction(arc.currentPosition, ctx) : draftRulesLegacyFallback(ctx);
    // Engine Version Management Phase J (§11.2) — author override block appended
    // AFTER the base rules + manifest rules so structural/sentinel rules can't be
    // displaced. Empty string when no usable override → byte-identical to legacy.
    const overrideBlock = renderCustomPromptOverride(customPromptOverride, ctx);
    // EPIC #364 S4 (#368) — showing/subtext 규칙 + few-shot exemplar 를 base 규칙 뒤,
    // manifest 규칙 앞에 둔다. 매 화 적용 (arc 박자 무관). exemplar 는 추상 규칙을
    // 모델이 일반화하도록 "보여주는" 보강 — system 레벨이라 user prompt token 과 무관.
    const parts = [header];
    // 다국어 Phase 2A — 검증된 값만으로 조립된 언어 계약 지시문. 계약 없는 구형
    // 호출에서는 빈 배열이라 기존 ko 프롬프트가 그대로 유지된다.
    if (ctx.systemLines.length > 0) {
        parts.push('', ...ctx.systemLines);
    }
    parts.push('', draftRulesBase(ctx), arcLines, '', draftShowingRules(ctx, dialogueBreakMode), '', pickByFamily(ctx, { ko: DRAFT_VOICE_RULES, multilingual: DRAFT_VOICE_RULES_MULTILINGUAL }), '', pickByFamily(ctx, { ko: DRAFT_FEWSHOT, multilingual: DRAFT_FEWSHOT_MULTILINGUAL }), '', pickByFamily(ctx, { ko: DRAFT_MANIFEST_RULES, multilingual: DRAFT_MANIFEST_RULES_MULTILINGUAL }));
    if (overrideBlock.length > 0) {
        parts.push('', overrideBlock);
    }
    return parts.join('\n');
}
function summariseCharacterForPrompt(foundation, chapterNumber, id) {
    // resolveCharacter throws if not registered at/before chapterNumber — fall back to raw.
    try {
        const c = resolveCharacter(foundation, chapterNumber, id);
        return {
            id: c.id,
            canonicalName: c.canonicalName,
            aliases: c.aliases,
            intrinsic: c.intrinsic,
            mutable: c.mutable,
            // P4b (#516) — 내적 모순/한 줄 소개. Codex 'Add a Fact' 가 채우는 필드라
            // prompt 에 도달해야 모순 방지가 작동. 빈 캐릭터는 키 생략 (legacy
            // byte-identical).
            ...(typeof c.contradiction === 'string' && c.contradiction.trim().length > 0
                ? { contradiction: c.contradiction }
                : {}),
            ...(c.speechProfile ? { speechProfile: c.speechProfile } : {}),
        };
    }
    catch {
        const raw = foundation.characters.find((c) => c.id === id);
        if (!raw)
            return { id };
        return {
            id: raw.id,
            canonicalName: raw.canonicalName,
            aliases: raw.aliases,
            intrinsic: raw.intrinsic,
            mutable: raw.mutable,
            ...(typeof raw.contradiction === 'string' && raw.contradiction.trim().length > 0
                ? { contradiction: raw.contradiction }
                : {}),
            ...(raw.speechProfile ? { speechProfile: raw.speechProfile } : {}),
        };
    }
}
/**
 * Format active Arc as a prompt header section. Returns empty string when no
 * arc is bound — the buildUserPrompt caller drops the section entirely so the
 * legacy / arc-less prompt remains byte-identical (test fixture stability).
 *
 * Promise 는 작가/엔진이 공유하는 일관성 기둥. 회차 위치는 5-구간 자동 산출
 * (arcPositionFromRatio) — Opening/Rising/Midpoint/Falling/Closing 라벨 + 진행도.
 */
export function formatArcHeader(arc, context) {
    const ctx = resolvePromptLanguageContext(context ?? {});
    const positionLabel = arcPositionLabel(arc.currentPosition, ctx);
    const labels = pickByFamily(ctx, { ko: ARC_HEADER_LABELS_KO, multilingual: ARC_HEADER_LABELS_EN });
    // arc.promise / arc.title / arc.summary 는 작품 데이터다 — 계열과 무관하게 원문 그대로.
    const promiseLine = arc.promise && arc.promise.length > 0 ? arc.promise : labels.promiseMissing;
    return [
        `## Arc Promise`,
        `Arc #${arc.arcNumber} "${arc.title}" — type=${arc.type}`,
        promiseLine,
        ``,
        labels.positionHeading,
        labels.position(arc, positionLabel),
        arc.summary && arc.summary.length > 0 ? labels.summary(arc.summary) : '',
    ]
        .filter((line) => line.length > 0)
        .join('\n');
}
const ARC_HEADER_LABELS_KO = {
    promiseMissing: '(약속 미설정 — Arc#1 promise 가 비어있다. 일관된 방향성 유지 우선)',
    positionHeading: '## 회차 위치',
    position: (arc, label) => `Arc 안 ${arc.currentChapterInArc}/${arc.estimatedEpisodes} — ${label}`,
    summary: (summary) => `(Arc 요약: ${summary})`,
};
const ARC_HEADER_LABELS_EN = {
    promiseMissing: '(No promise set — the arc promise is empty. Prioritise keeping a consistent direction.)',
    positionHeading: '## Position in the arc',
    position: (arc, label) => `Chapter ${arc.currentChapterInArc} of ${arc.estimatedEpisodes} in the arc — ${label}`,
    summary: (summary) => `(Arc summary: ${summary})`,
};
function buildUserPrompt(input) {
    const { foundation, prevState, chapterNumber, plan, tension, openingContract, arc, slidingWindowRender, entityContextRender } = input;
    const ctx = draftLanguageContext(input);
    const labels = pickByFamily(ctx, { ko: USER_LABELS_KO, multilingual: USER_LABELS_EN });
    // P4b (#516) — Codex 에서 비활성(disabled)된 캐릭터는 prompt 에서 제외.
    const activeCast = Array.isArray(input.activeCastIds) && input.activeCastIds.length
        ? new Set(input.activeCastIds)
        : null;
    const eligibleCharacters = foundation.characters
        .filter((c) => c.registeredAtChapter <= chapterNumber && c.disabled !== true && (!activeCast || activeCast.has(c.id)))
        .map((c) => summariseCharacterForPrompt(foundation, chapterNumber, c.id));
    const foundationSummary = {
        genre: foundation.genre,
        worldFacts: foundation.worldFacts.map((f) => f.statement),
        characters: eligibleCharacters,
        invariants: foundation.genreProfile.invariants.map((inv) => ({
            id: inv.id,
            severity: inv.severity,
            description: inv.description,
        })),
    };
    const prevSummary = {
        chapterNumber: prevState.chapterNumber,
        addressMap: prevState.addressMap.entries,
        openHooks: (prevState.hooks ?? [])
            .filter(isHookActive)
            .map((h) => ({ id: h.id, text: h.text, phase: h.phase })),
        relationships: prevState.relationships,
        trackedEntities: prevState.trackedEntities,
        // Arc Flow Stage A (EPIC #191) — per-character arc 진행도. legacy state =
        // {} fallback. 작가 prompt 안에 노출되어 LLM 이 인물별 6-beat 위치 인식.
        arcCursor: prevState.arcCursor ?? {},
    };
    const sections = [
        labels.chapterNumber,
        String(chapterNumber),
        ``,
        labels.lengthHeading(ctx),
        formatLengthTarget(ctx),
        ``,
    ];
    // Arc Flow Stage A (EPIC #191) — Foundation 위 위치에 Arc 헤더 주입.
    // Foundation 보다 먼저 와야 LLM 이 "이 화는 Arc 의 어디" 를 먼저 인식한다.
    if (arc) {
        sections.push(formatArcHeader(arc, ctx), ``);
    }
    sections.push(labels.foundation, JSON.stringify(foundationSummary, null, 2), ``);
    // ADR-0001 (#215) — sliding window 묶음 (있으면). prevState carry-forward
    // 앞에 두 — 작가가 시간 순서로 읽음. NULL 이면 기존 path 그대로.
    if (slidingWindowRender && slidingWindowRender.length > 0) {
        sections.push(slidingWindowRender, ``);
    }
    // ADR-0004 (#217) — entity context (이번 화 무대 entity 만). sliding window
    // 뒤, 이전 상태 요약 앞에 두 — entity 가 화 컨텍스트 핵심.
    if (entityContextRender && entityContextRender.length > 0) {
        sections.push(entityContextRender, ``);
    }
    sections.push(labels.prevState, JSON.stringify(prevSummary, null, 2), ``, labels.plan, plan && plan.length > 0 ? plan : labels.planMissing, ``);
    const openingContractRender = renderOpeningContract(openingContract, chapterNumber, ctx);
    if (openingContractRender.length > 0) {
        sections.push(openingContractRender, ``);
    }
    // EPIC #364 S3 (#367) — tension 슬롯 직렬화. 채워진 필드만 노출, 전부 비면
    // 섹션 생략 (legacy 호환). draft LLM 이 ticking/stake/escalation 을 본문에
    // 장면으로 구현하도록 명시 지시.
    const tensionRender = renderTension(tension, ctx);
    if (tensionRender.length > 0) {
        sections.push(tensionRender, ``);
    }
    sections.push(...labels.output, ``, '⟦vle:cast-manifest {"cast":[...]}⟧');
    return sections.join('\n');
}
const USER_LABELS_KO = {
    chapterNumber: '## 회차 번호',
    lengthHeading: (ctx) => ctx.length.unit === 'legacyCodeUnits' ? '## 목표 글자 수' : '## 목표 분량',
    foundation: '## Foundation 요약',
    prevState: '## 이전 상태 요약 (StoryState N-1)',
    plan: '## 회차 기획',
    planMissing: '(기획 미제공 — Foundation·이전 상태만 참고해 자연스럽게 전개)',
    output: ['## 출력', '아래 형식으로 출력한다:', '<본문 한국어 prose>'],
};
const USER_LABELS_EN = {
    chapterNumber: '## Chapter number',
    lengthHeading: () => '## Length target',
    foundation: '## Foundation summary',
    prevState: '## Previous state summary (StoryState N-1)',
    plan: '## Chapter plan',
    planMissing: '(No plan supplied — develop the chapter naturally from the Foundation and the previous state.)',
    output: ['## Output', 'Output in the following form:', '<chapter prose in the target work language>'],
};
function renderOpeningContract(contract, chapterNumber, context) {
    if (chapterNumber !== 1 || !contract)
        return '';
    const ctx = resolvePromptLanguageContext(context ?? {});
    const labels = pickByFamily(ctx, { ko: OPENING_LABELS_KO, multilingual: OPENING_LABELS_EN });
    const lines = [];
    // 키 순서는 기계 계약. 값은 계획 단계가 목표 언어로 만든 작품 데이터다.
    for (const key of OPENING_CONTRACT_KEYS) {
        const value = contract[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            lines.push(`- ${labels.field[key]}: ${value.trim()}`);
        }
    }
    if (lines.length === 0)
        return '';
    return [labels.heading, labels.intro, ...lines].join('\n');
}
const OPENING_CONTRACT_KEYS = [
    'surfaceEvent',
    'worldPressure',
    'characterWound',
    'misbelief',
    'firstIrreversibleChoice',
    'withheldContext',
    'viewpointReason',
];
const OPENING_LABELS_KO = {
    heading: '## 1화 오프닝 계약',
    intro: '아래 항목을 설명표가 아니라 첫 장면의 선택·압력·누락된 정보로 구현한다. 사건 해결보다 독자가 세계와 시점 인물의 충돌을 먼저 체감하게 한다:',
    field: {
        surfaceEvent: '겉 사건',
        worldPressure: '세계·제도·관계의 압력',
        characterWound: '인물의 결핍',
        misbelief: '첫 장면의 오해',
        firstIrreversibleChoice: '되돌릴 수 없는 첫 선택',
        withheldContext: '뒤로 미룰 설명',
        viewpointReason: '이 시점으로 시작해야 하는 이유',
    },
};
const OPENING_LABELS_EN = {
    heading: '## Opening contract for chapter 1',
    intro: 'Realise the items below as the choices, pressures and withheld information of the first scene, not as an explanatory table. Before resolving the event, let the reader feel the collision between the world and the viewpoint character:',
    field: {
        surfaceEvent: 'Surface event',
        worldPressure: 'Pressure from the world, its institutions and relationships',
        characterWound: 'The character\'s lack or wound',
        misbelief: 'What the character wrongly believes in the first scene',
        firstIrreversibleChoice: 'The first irreversible choice',
        withheldContext: 'Context to withhold for later',
        viewpointReason: 'Why the story must start from this viewpoint',
    },
};
/**
 * EPIC #364 S3 — tension 슬롯을 draft prompt 섹션으로 직렬화. 채워진 필드만
 * 줄 단위로 노출. 전부 비었으면 빈 string (caller 가 섹션 자체를 생략).
 *
 * 슬롯 이름(ticking/stake/escalation)은 기계 키라 두 계열에서 그대로 노출한다.
 */
function renderTension(tension, context) {
    if (!tension)
        return '';
    const ctx = resolvePromptLanguageContext(context ?? {});
    const labels = pickByFamily(ctx, { ko: TENSION_LABELS_KO, multilingual: TENSION_LABELS_EN });
    const lines = [];
    if (tension.ticking && tension.ticking.length > 0) {
        lines.push(`- ${labels.field.ticking}: ${tension.ticking}`);
    }
    if (tension.stake && tension.stake.length > 0) {
        lines.push(`- ${labels.field.stake}: ${tension.stake}`);
    }
    if (tension.escalation && tension.escalation.length > 0) {
        lines.push(`- ${labels.field.escalation}: ${tension.escalation}`);
    }
    if (lines.length === 0)
        return '';
    return [labels.heading, labels.intro, ...lines].join('\n');
}
const TENSION_LABELS_KO = {
    heading: '## 이번 화 긴장 설계',
    intro: '아래 긴장 요소를 설명이 아니라 장면·행동·대사로 본문에 구현한다:',
    field: {
        ticking: '시간·외부 압박(ticking)',
        stake: '주인공이 잃을 수 있는 것(stake)',
        escalation: '이전 화 대비 위협 증대(escalation)',
    },
};
const TENSION_LABELS_EN = {
    heading: '## Tension design for this chapter',
    intro: 'Realise the tension elements below in the prose as scene, action and dialogue, not as explanation:',
    field: {
        ticking: 'Time or external pressure (ticking)',
        stake: 'What the protagonist can lose (stake)',
        escalation: 'How the threat grows against the previous chapter (escalation)',
    },
};
/** Exposed for tests — buildUserPrompt is module-private otherwise. */
export const __buildUserPromptForTest = buildUserPrompt;
/** Exposed for tests — buildDraftSystem is module-private otherwise. */
export const __buildDraftSystemForTest = buildDraftSystem;
/**
 * ADR-0006 promptManifest 수집용 계열 정적 캡처. arc·작가 override·작품 데이터가
 * 없는 상태의 system 프롬프트이며, 계열 대표 컨텍스트라 목표 언어 태그나 작품별
 * 분량 수치가 들어가지 않는다. ko 캡처는 구형 `buildDraftSystem()` 과 동일하다.
 *
 * 수집 주체는 `engine-version.js`(다른 소유자)다. 이 모듈은 값만 노출한다.
 */
export function draftSystemStatic(family) {
    return buildDraftSystem(null, undefined, promptFamilyCaptureContext(family));
}
export async function runDraft(input) {
    // system 과 user 가 **같은** 계약을 보도록 한 번만 해석한다.
    const promptLanguage = draftLanguageContext(input);
    const userPrompt = buildUserPrompt({ ...input, promptLanguage });
    const systemPrompt = buildDraftSystem(input.arc, input.customPromptOverride, promptLanguage, {
        dialogueBreakMode: input.dialogueBreakMode ?? null,
    });
    const response = await input.providers.complete({
        model: input.model,
        // No jsonMode — draft is prose with a single trailing sentinel block.
        step: 'draft',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
    });
    return { raw: response.text };
}
