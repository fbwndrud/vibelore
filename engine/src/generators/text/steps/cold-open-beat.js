/**
 * cold-open-beat — Arc Flow Stage A (EPIC #191 / Stage A #192).
 *
 * 1화의 독자 견인은 특정 사건 단어가 아니라 인물의 상태 변화와 선택에서 나온다.
 * 기존 6종 사건 카탈로그는 관측용 텔레메트리로만 유지하고 계획 제약으로 쓰지 않는다.
 *
 * 본 모듈은 두 surface 를 제공:
 *
 *   1. `STRONG_EVENT_CATALOG` — 과거 데이터와 호환되는 관측용 catalog.
 *
 *   2. `detectStrongEventInColdOpen(prose)` — 1화 첫 `COLD_OPEN_WINDOW_CHARS`
 *      범위 안 강력 사건 키워드 등장을 lint. Stage A = telemetry only
 *      (runAuxScans 가 결과 log 출력, hard fail X).
 *
 * 한국어 web-novel 도메인 휴리스틱 — 정밀 NLP 없이 키워드 매칭 + 컨텍스트
 * window 만으로 baseline 측정. Stage B 가 LLM-based 정밀 분석 검토.
 */
import { resolvePromptLanguageContext } from '../../../core/prompt-language.js';
/**
 * 첫 N 자 — 카카오페 web-novel 상 통상 1화 sample 길이 (열람 결정 임계).
 * 한국어 본문 lint 용 **코드 단위** 창이며 작품 분량 계약의 단위가 아니다.
 */
export const COLD_OPEN_WINDOW_CHARS = 1200;
/**
 * 6 카탈로그 — 본문 첫 1,200자 안 1선택. 키워드는 한국어 web-novel 표본에서
 * 추출. archetype 당 정확도보다 recall 우선 (baseline 측정 → false-negative 적게).
 */
export const STRONG_EVENT_CATALOG = [
    {
        id: 'death',
        label: '사망',
        keywords: ['죽었', '죽는다', '숨을 거두', '사망', '시신', '주검', '심장이 멈'],
        hint: '가족·동료·라이벌 중 1인의 사망 (목격 또는 직접 통보).',
    },
    {
        id: 'betrayal',
        label: '배신',
        keywords: ['배신', '저버', '뒤통수', '등을 돌', '버려졌', '나를 팔'],
        hint: '신뢰하던 인물의 배신 발각 (회상 + 현재).',
    },
    {
        id: 'promise',
        label: '약속',
        keywords: ['약속한다', '약속해', '맹세', '서약', '반드시'],
        hint: '주인공의 강력 결심 + 행동 trigger.',
    },
    {
        id: 'last-request',
        label: '최후의 부탁',
        keywords: ['마지막 부탁', '부디', '제발', '한 가지만'],
        hint: '죽어가는 인물 / 헤어지는 인물의 유언적 부탁.',
    },
    {
        id: 'last-message',
        label: '마지막 메시지',
        keywords: ['마지막 편지', '유서', '메모', '음성 메시지', '문자'],
        hint: '발신자 부재 후 도착한 메시지 (미스터리 + 동기).',
    },
    {
        id: 'fated-encounter',
        label: '운명적 만남',
        keywords: ['처음 본', '낯선', '이상한 사람', '운명', '눈이 마주', '시선이 부딪'],
        hint: '주인공 인생을 바꿀 인물과의 첫 조우 (1화 hook).',
    },
];
/**
 * 1화 cold-open lint. 첫 `COLD_OPEN_WINDOW_CHARS` 윈도우 안 강력 사건 키워드
 * 존재 여부 + 어느 archetype 인지 반환.
 *
 *   - chapterNumber === 1 이외 호출은 의미 없음 (caller 가 가드).
 *   - 키워드 매칭은 substring (단순 indexOf). 정밀 NLP 없음.
 *
 * Stage A 는 runAuxScans 가 결과 log 만 출력 — present=false 여도 chapter 통과.
 * Stage B 가 hard fail / revise loop 검토.
 */
export function detectStrongEventInColdOpen(prose) {
    const window = prose.slice(0, COLD_OPEN_WINDOW_CHARS);
    const matched = [];
    let firstMatchAt = -1;
    for (const archetype of STRONG_EVENT_CATALOG) {
        for (const kw of archetype.keywords) {
            const idx = window.indexOf(kw);
            if (idx >= 0) {
                matched.push(archetype.id);
                if (firstMatchAt === -1 || idx < firstMatchAt) {
                    firstMatchAt = idx;
                }
                break; // archetype 별 첫 매칭만 기록
            }
        }
    }
    return {
        present: matched.length > 0,
        matched,
        firstMatchAt,
    };
}

export function evaluateOpeningContract(contract) {
    const obj = contract && typeof contract === 'object' && !Array.isArray(contract) ? contract : {};
    const required = [
        'surfaceEvent',
        'worldPressure',
        'characterWound',
        'misbelief',
        'firstIrreversibleChoice',
        'withheldContext',
        'viewpointReason',
    ];
    const missing = required.filter((key) => typeof obj[key] !== 'string' || obj[key].trim().length === 0);
    const depthFields = ['worldPressure', 'characterWound', 'misbelief', 'viewpointReason'];
    const shallow = depthFields.filter((key) => {
        const value = typeof obj[key] === 'string' ? obj[key].trim() : '';
        return value.length > 0 && value.length < 12;
    });
    return {
        pass: missing.length === 0 && shallow.length === 0,
        missing,
        shallow,
    };
}
/**
 * 다국어 계열의 catalog 표시 문구. `id` 는 기계 값이라 그대로 두고 **지시문에
 * 쓰이는 label/hint 만** 계열별로 고른다. `keywords` 는 한국어 본문 lint 용
 * 휴리스틱이라 계열 라우팅 대상이 아니다(비ko 탐지는 Stage B 소유).
 */
const STRONG_EVENT_LABELS_EN = {
    death: { label: 'Death', hint: 'The death of a family member, comrade or rival (witnessed or reported).' },
    betrayal: { label: 'Betrayal', hint: 'A trusted figure\'s betrayal comes to light (memory plus present).' },
    promise: { label: 'A promise', hint: 'The protagonist\'s hard resolve plus the action it triggers.' },
    'last-request': { label: 'A last request', hint: 'A dying or departing character\'s final request.' },
    'last-message': { label: 'A last message', hint: 'A message that arrives after its sender is gone (mystery plus motive).' },
    'fated-encounter': { label: 'A fated encounter', hint: 'The first meeting with the person who will change the protagonist\'s life (chapter 1 hook).' },
};
/** 계열별 catalog 표시값. id 는 두 계열에서 동일하다. */
function coldOpenCatalogEntry(archetype, isKo) {
    if (isKo)
        return { label: archetype.label, hint: archetype.hint };
    const en = STRONG_EVENT_LABELS_EN[archetype.id];
    return en ?? { label: archetype.id, hint: archetype.hint };
}
/**
 * chapter-plan prompt 가 1화일 때 append 하는 기능 중심 계약.
 * 사건 카탈로그는 선택 가능한 예일 뿐 키워드나 유형을 강제하지 않는다.
 *
 * 다국어 Phase 2A — 인자는 선택적 언어 컨텍스트다. 없으면 구형 ko 해석이라 기존
 * 지시문이 byte-identical 로 유지된다. openingContract 키는 기계 계약이라 두
 * 계열에서 같고 설명만 계열을 따른다.
 */
export function buildColdOpenInstruction(context) {
    const isKo = resolvePromptLanguageContext(context ?? {}).isKo;
    const lines = isKo
        ? [
            '', '## 1화 독자 계약', '',
            `첫 ${COLD_OPEN_WINDOW_CHARS}자 안에서 설정을 설명하기보다 다음 기능을 장면으로 수행한다:`,
            '- 주인공이 잃은 것 또는 현재의 결핍을 구체적 행동에 연결한다.',
            '- 주인공만의 판단이나 기술을 보여 주되 첫 판단을 완벽한 정답으로 만들지 않는다.',
            '- 실패·반론·오차 중 하나를 겪고 즉시 수정하거나 대가를 감수한다.',
            '- 조연은 정보를 전달하는 도구가 아니라 자기 목적에서 독립적인 선택을 한다.',
            '- 끝에는 주인공이 되돌릴 수 없는 선택을 하여 다음 화의 질문을 만든다.', '',
            '추가로 openingContract 를 반드시 설계한다:',
            '- surfaceEvent: 겉으로 벌어지는 사건.',
            '- worldPressure: 세계·제도·관계가 인물을 누르는 압력.',
            '- characterWound: 인물이 이미 가진 결핍 또는 약점.',
            '- misbelief: 첫 장면에서 인물이 틀리게 믿는 것.',
            '- firstIrreversibleChoice: 되돌릴 수 없는 첫 선택.',
            '- withheldContext: 설명하지 않고 뒤로 미룰 정보.',
            '- viewpointReason: 이 시점으로 시작해야만 하는 이유.', '',
            '아래 사건 유형은 필요할 때만 쓸 수 있는 예시이며, 선택·키워드 등장을 강제하지 않는다:',
        ]
        : [
            '', '## Reader contract for chapter 1', '',
            // COLD_OPEN_WINDOW_CHARS 는 한국어 lint 용 코드 단위 창이다. 다른 측정
            // 단위의 작품에 그 숫자를 그대로 지시하지 않는다 — 위치로만 말한다.
            'In the opening stretch of the chapter — the part a reader samples before deciding to continue — perform the following as scene rather than explaining the setting:',
            '- Tie what the protagonist has lost, or lacks right now, to a concrete action.',
            '- Show the protagonist\'s own judgement or skill, but do not make that first judgement a perfect answer.',
            '- Let them hit one failure, objection or miscalculation, and either correct it at once or pay for it.',
            '- Supporting characters make independent choices from their own goals; they are not devices for delivering information.',
            '- End with the protagonist making an irreversible choice that raises the question for the next chapter.', '',
            'Also design openingContract (keep these keys verbatim, write the values in the target work language):',
            '- surfaceEvent: the event happening on the surface.',
            '- worldPressure: the pressure the world, its institutions and relationships put on the character.',
            '- characterWound: the lack or weakness the character already carries.',
            '- misbelief: what the character wrongly believes in the first scene.',
            '- firstIrreversibleChoice: the first irreversible choice.',
            '- withheldContext: the information to withhold and pay off later.',
            '- viewpointReason: why the story must start from this viewpoint.', '',
            'The event types below are optional examples only; neither the choice nor any keyword is required:',
        ];
    for (const a of STRONG_EVENT_CATALOG) {
        const { label, hint } = coldOpenCatalogEntry(a, isKo);
        lines.push(`  - ${label}: ${hint}`);
    }
    lines.push('', isKo
        ? '위 유형보다 작품의 StoryIdentity와 인물 선택이 우선이다. 자극적 사건을 억지로 삽입하지 않는다.'
        : 'The work\'s StoryIdentity and the characters\' choices outrank these types. Do not force a sensational event into the opening.');
    return lines.join('\n');
}
