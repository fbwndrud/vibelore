/**
 * Draft step — request chapter prose and a structured cast manifest.
 *
 * The manifest records which characters appeared and which address terms they
 * used. Metadata uses the reserved ⟦vle:tag …⟧ syntax. OutputSanitizer removes
 * complete blocks and rejects residual machine annotations before persistence.
 */
import { resolveCharacter } from '../../../continuity/foundation.js';
import { ARC_POSITION_LABEL_KO } from '../../../core/arc-context.js';
import { renderCustomPromptOverride } from '../../../core/custom-prompt-override.js';
import { DRAFT_FEWSHOT } from '../prompts/draft.js';
import { isHookActive } from '../../../continuity/story-state.js';
/** Default target word count when the foundation does not record one. */
export const DEFAULT_TARGET_WORD_COUNT = 3500;
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
function arcPositionInstruction(position) {
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
const DRAFT_RULES_BASE = [
    '본문 작성 규칙:',
    '- 본문은 자연스러운 한국어 prose. 부제목/장 번호/메타 주석/내부 메모는 금지.',
    '- 캐릭터 intrinsic(성별, 연령대, 역할) 은 Foundation 기준. 본문이 이와 모순되면 안 된다.',
    '- 호칭은 화자→대상 관계와 캐릭터 성별을 고려해 선택한다.',
    '- 분량은 목표 글자 수 ±15% 내.',
].join('\n');
/** Legacy '한 회차에 갈등1+진행1+훅1' 규칙 — Arc 미연결 작품 호환용. */
const DRAFT_RULES_LEGACY_FALLBACK = '- 한 회차에 갈등 1개, 진행 1개, 다음 회차 훅 1개.';
/**
 * EPIC #364 S4 (#368) — '생략의 마법' 문체 규칙. plan §3.2.
 * showing/subtext 강제 — 감정 직접진술 억제 + info-dump 억제 + 추론 가능 사실 생략.
 * arc 박자와 무관하게 매 화 적용 (DRAFT_RULES_BASE 와 동급 상시 규칙).
 */
const DRAFT_SHOWING_RULES = [
    '서술과 독자 이해 규칙:',
    '- 감정은 행동·감각·대사로 먼저 체감시키되, 장면 이해에 필요한 감정명이나 짧은 명시는 자연스럽게 쓸 수 있다.',
    '- 세계 정보는 현재 선택과 결과에 닿는 만큼 장면·대사·행동에 연결한다. 처음 등장한 핵심 개념은 독자가 표면 뜻을 놓치지 않도록 한 번은 명료하게 잡아 준다.',
    '- 대사와 서술은 모바일에서 구분하되, 하나의 원인·반응·결과로 이어지는 짧은 서술은 한 문단에 묶어 호흡을 만든다.',
].join('\n');
const DRAFT_VOICE_RULES = [
    '인물 음성 규칙:',
    '- speechProfile 과 이번 화 말투 목표의 sampleLine 은 복사할 문장이 아니라 말투·압력·숨은 목적의 기준 예시다.',
    '- 대사는 독자가 숨은 맥락을 몰라도 표면의 질문·반응·결과를 따라갈 수 있게 쓴다. 모든 발화에 복선이나 권력 싸움을 싣지 말고 반응, 오해, 일상적 말, 침묵도 섞는다.',
    '- 이름을 가려도 누가 말했는지 구분되도록 문장 길이, 존대/반말 조건, 논리 습관, 감정 누출 방식을 다르게 쓴다.',
    '- 같은 인물도 관계와 아크 압력에 따라 말투가 변한다. 변화는 갑작스러운 문체 변경이 아니라 선택 비용의 결과여야 한다.',
    '- 분 단위 시각, 정밀 수치, 코드, 전문어는 문서·화면·작전처럼 그 정밀성이 실제 결정을 바꿀 때 자연스럽다. 일상 대화와 서술에서는 인물과 상황에 맞는 생활 표현을 우선한다.',
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
function buildDraftSystem(arc, customPromptOverride) {
    const header = '당신은 한국어 웹소설 작가이다. 제공된 Foundation, 이전 상태 요약, 회차 기획을 읽고 다음 회차를 작성한다.';
    const arcLines = arc ? arcPositionInstruction(arc.currentPosition) : DRAFT_RULES_LEGACY_FALLBACK;
    // Engine Version Management Phase J (§11.2) — author override block appended
    // AFTER the base rules + manifest rules so structural/sentinel rules can't be
    // displaced. Empty string when no usable override → byte-identical to legacy.
    const overrideBlock = renderCustomPromptOverride(customPromptOverride);
    // EPIC #364 S4 (#368) — showing/subtext 규칙 + few-shot exemplar 를 base 규칙 뒤,
    // manifest 규칙 앞에 둔다. 매 화 적용 (arc 박자 무관). exemplar 는 추상 규칙을
    // 모델이 일반화하도록 "보여주는" 보강 — system 레벨이라 user prompt token 과 무관.
    const parts = [
        header,
        '',
        DRAFT_RULES_BASE,
        arcLines,
        '',
        DRAFT_SHOWING_RULES,
        '',
        DRAFT_VOICE_RULES,
        '',
        DRAFT_FEWSHOT,
        '',
        DRAFT_MANIFEST_RULES,
    ];
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
export function formatArcHeader(arc) {
    const positionLabel = ARC_POSITION_LABEL_KO[arc.currentPosition] ?? arc.currentPosition;
    const promiseLine = arc.promise && arc.promise.length > 0
        ? arc.promise
        : '(약속 미설정 — Arc#1 promise 가 비어있다. 일관된 방향성 유지 우선)';
    return [
        `## Arc Promise`,
        `Arc #${arc.arcNumber} "${arc.title}" — type=${arc.type}`,
        promiseLine,
        ``,
        `## 회차 위치`,
        `Arc 안 ${arc.currentChapterInArc}/${arc.estimatedEpisodes} — ${positionLabel}`,
        arc.summary && arc.summary.length > 0 ? `(Arc 요약: ${arc.summary})` : '',
    ]
        .filter((line) => line.length > 0)
        .join('\n');
}
function buildUserPrompt(input) {
    const { foundation, prevState, chapterNumber, plan, tension, openingContract, arc, slidingWindowRender, entityContextRender } = input;
    const target = input.targetWordCount ?? DEFAULT_TARGET_WORD_COUNT;
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
        `## 회차 번호`,
        String(chapterNumber),
        ``,
        `## 목표 글자 수`,
        String(target),
        ``,
    ];
    // Arc Flow Stage A (EPIC #191) — Foundation 위 위치에 Arc 헤더 주입.
    // Foundation 보다 먼저 와야 LLM 이 "이 화는 Arc 의 어디" 를 먼저 인식한다.
    if (arc) {
        sections.push(formatArcHeader(arc), ``);
    }
    sections.push(`## Foundation 요약`, JSON.stringify(foundationSummary, null, 2), ``);
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
    sections.push(`## 이전 상태 요약 (StoryState N-1)`, JSON.stringify(prevSummary, null, 2), ``, `## 회차 기획`, plan && plan.length > 0 ? plan : '(기획 미제공 — Foundation·이전 상태만 참고해 자연스럽게 전개)', ``);
    const openingContractRender = renderOpeningContract(openingContract, chapterNumber);
    if (openingContractRender.length > 0) {
        sections.push(openingContractRender, ``);
    }
    // EPIC #364 S3 (#367) — tension 슬롯 직렬화. 채워진 필드만 노출, 전부 비면
    // 섹션 생략 (legacy 호환). draft LLM 이 ticking/stake/escalation 을 본문에
    // 장면으로 구현하도록 명시 지시.
    const tensionRender = renderTension(tension);
    if (tensionRender.length > 0) {
        sections.push(tensionRender, ``);
    }
    sections.push(`## 출력`, '아래 형식으로 출력한다:', '<본문 한국어 prose>', ``, '⟦vle:cast-manifest {"cast":[...]}⟧');
    return sections.join('\n');
}

function renderOpeningContract(contract, chapterNumber) {
    if (chapterNumber !== 1 || !contract)
        return '';
    const label = {
        surfaceEvent: '겉 사건',
        worldPressure: '세계·제도·관계의 압력',
        characterWound: '인물의 결핍',
        misbelief: '첫 장면의 오해',
        firstIrreversibleChoice: '되돌릴 수 없는 첫 선택',
        withheldContext: '뒤로 미룰 설명',
        viewpointReason: '이 시점으로 시작해야 하는 이유',
    };
    const lines = [];
    for (const key of Object.keys(label)) {
        const value = contract[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            lines.push(`- ${label[key]}: ${value.trim()}`);
        }
    }
    if (lines.length === 0)
        return '';
    return [
        '## 1화 오프닝 계약',
        '아래 항목을 설명표가 아니라 첫 장면의 선택·압력·누락된 정보로 구현한다. 사건 해결보다 독자가 세계와 시점 인물의 충돌을 먼저 체감하게 한다:',
        ...lines,
    ].join('\n');
}
/**
 * EPIC #364 S3 — tension 슬롯을 draft prompt 섹션으로 직렬화. 채워진 필드만
 * 줄 단위로 노출. 전부 비었으면 빈 string (caller 가 섹션 자체를 생략).
 */
function renderTension(tension) {
    if (!tension)
        return '';
    const lines = [];
    if (tension.ticking && tension.ticking.length > 0) {
        lines.push(`- 시간·외부 압박(ticking): ${tension.ticking}`);
    }
    if (tension.stake && tension.stake.length > 0) {
        lines.push(`- 주인공이 잃을 수 있는 것(stake): ${tension.stake}`);
    }
    if (tension.escalation && tension.escalation.length > 0) {
        lines.push(`- 이전 화 대비 위협 증대(escalation): ${tension.escalation}`);
    }
    if (lines.length === 0)
        return '';
    return [
        `## 이번 화 긴장 설계`,
        '아래 긴장 요소를 설명이 아니라 장면·행동·대사로 본문에 구현한다:',
        ...lines,
    ].join('\n');
}
/** Exposed for tests — buildUserPrompt is module-private otherwise. */
export const __buildUserPromptForTest = buildUserPrompt;
/** Exposed for tests — buildDraftSystem is module-private otherwise. */
export const __buildDraftSystemForTest = buildDraftSystem;
export async function runDraft(input) {
    const userPrompt = buildUserPrompt(input);
    const systemPrompt = buildDraftSystem(input.arc, input.customPromptOverride);
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
