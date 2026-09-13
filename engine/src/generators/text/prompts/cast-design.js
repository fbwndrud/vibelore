/**
 * Cast design prompt — second BookCreate step.
 *
 * Produces the initial cast (3–5 characters) with **full intrinsic** committed
 * at registration time. The whole point of the engine's Character model is
 * that intrinsic is pinned at register chapter and can only change through an
 * append-only IntrinsicChangeEvent with a narrative cause — so the model must
 * decide gender / ageBand / role / coreAppearance up front rather than letting
 * later chapters drift them.
 *
 * A later description must not silently replace registered attributes.
 * The prompt makes that constraint explicit before any prose is written.
 *
 * 실행 경로 주의: 실제 book-create 는 `steps/cast-design.js` 의 자체 builder 를
 * 쓴다. 이 모듈은 공개 export 표면이며 다국어 Phase 2A 에서 계열이 둘이 됐다.
 */
import { pickByFamily, promptFamilyCaptureContext, resolveStepPromptLanguage, } from '../../../core/prompt-language.js';
export const CAST_DESIGN_SYSTEM = [
    '당신은 한국어 웹소설의 캐스팅 디자이너이다.',
    '제공된 premise·worldFacts 를 읽고 첫 화 등장할 핵심 캐릭터 3~5명을 설계한다.',
    '각 캐릭터의 intrinsic(gender·ageBand·role·coreAppearance) 는 회차가 진행돼도 절대 자동 변경되지 않는다 — **intrinsic 는 핀고정**.',
    '회귀/빙의/변신 같은 서사적 사건이 발생할 때만 별도 이벤트로 갱신되며, 본 단계에서는 그 가능성을 의식하되 초기 intrinsic 은 작품 시작 시점의 사실로 확정한다.',
    'coreAppearance 는 머리색·눈동자·흉터·체형 등 시각적으로 깨지면 안 되는 특징만 3~6개 나열. 의상·표정 같은 가변 묘사는 mutable 영역이므로 제외.',
    'role 은 "주인공" | "조연" | "적대자" | "조력자" 등의 명확한 서사 역할.',
    '출력은 코드 블록 없이 순수 JSON 한 개. 한국어 키/값 사용 무방, 스키마 키는 영문 유지.',
].join(' ');
/**
 * 다국어 계열. **intrinsic 핀고정** 계약은 그대로 두고 사람이 읽는 값만 목표 작품
 * 언어로 요구한다. gender enum·스키마 키·id 는 기계 계약이라 동일하다.
 */
export const CAST_DESIGN_SYSTEM_MULTILINGUAL = [
    'You are the casting designer for a serial-fiction work written in the target work language.',
    'Read the premise and worldFacts, then design the 3-5 core characters who appear in chapter 1.',
    'Each character\'s intrinsic (gender, ageBand, role, coreAppearance) never changes automatically as chapters progress — **intrinsic is pinned**.',
    'It is updated only by an explicit event for a narrative cause (regression, possession, transformation). At this stage, fix the initial intrinsic as fact at the story\'s starting point while staying aware of that possibility.',
    'coreAppearance lists 3-6 visual traits that must not break — hair colour, eyes, scars, build. Variable description such as clothing or expression belongs to the mutable layer and is excluded.',
    'role is a clear narrative role: protagonist, supporting character, antagonist, ally, and so on.',
    'Output one pure JSON object with no code fence. Write the values in the target work language and keep the schema keys, ids and enum values verbatim.',
].join(' ');
/** 이번 호출에 쓸 공개 cast-design system. 계약이 없으면 구형 ko 문자열 그대로다. */
export function castDesignSystemFor(context) {
    return pickByFamily(context, { ko: CAST_DESIGN_SYSTEM, multilingual: CAST_DESIGN_SYSTEM_MULTILINGUAL });
}
/** ADR-0006 promptManifest 수집용 계열 정적 표면(공개 표면). */
export function publicCastDesignSystemStatic(family) {
    return castDesignSystemFor(promptFamilyCaptureContext(family));
}
/**
 * Adapter so callers that hold a `WorldbuildPromptInput` can extend it cleanly.
 *
 * 언어 계약도 함께 넘긴다 — 두 단계가 서로 다른 언어를 보지 않게 한다. 구형
 * 입력(언어 키 없음)은 새 키를 얻지 않는다.
 */
export function castDesignInputFrom(base, premise, worldFacts) {
    return {
        title: base.title,
        genre: base.genre,
        brief: base.brief,
        language: base.language,
        targetChapters: base.targetChapters,
        ...(base.workContract === undefined ? {} : { workContract: base.workContract }),
        ...(base.promptLanguage === undefined ? {} : { promptLanguage: base.promptLanguage }),
        premise,
        worldFacts,
    };
}
const CAST_DESIGN_LABELS_KO = {
    title: '## 제목',
    genre: '## 장르',
    language: '## 언어',
    brief: '## 작가 brief',
    briefMissing: '(없음)',
    targetChapters: '## 목표 회차 수',
    premise: '## premise',
    worldFacts: '## worldFacts',
    task: '## 작업',
    taskLines: [
        '- 3~5명. 주인공 1명을 반드시 포함, 적대자 또는 강한 라이벌 1명 권장.',
        '- 각 캐릭터에 안정 id ("c1", "c2", ...) 와 canonicalName 부여. aliases 는 별명/과거명/회귀전 이름 등.',
        '- intrinsic.coreAppearance 는 3~6개의 시각 특징.',
        '- mutable.status 는 시작 시점 기준 — 통상 "alive". location 은 1화 시점 위치.',
        '- relationships 는 다른 캐릭터 id 를 참조. kind/state 명시.',
    ],
    schema: '## 출력 스키마 (이 JSON 한 개만 출력)',
    placeholders: {
        canonicalName: '이름',
        alias: '별명',
        ageBand: '20대초반',
        birthOrder: '장남',
        role: '주인공',
        coreAppearance: '"은발", "왼쪽 눈가 흉터"',
        location: '황궁 동궁',
        relationshipKind: '라이벌',
        relationshipState: '미해결갈등',
    },
};
const CAST_DESIGN_LABELS_EN = {
    title: '## Title',
    genre: '## Genre',
    language: '## Target work language (BCP 47)',
    brief: '## Author brief',
    briefMissing: '(none)',
    targetChapters: '## Target chapter count',
    premise: '## premise',
    worldFacts: '## worldFacts',
    task: '## Task',
    taskLines: [
        '- 3-5 characters. Include exactly one protagonist; one antagonist or strong rival is recommended.',
        '- Give every character a stable id ("c1", "c2", …) and a canonicalName. aliases holds nicknames, former names, pre-regression names.',
        '- intrinsic.coreAppearance holds 3-6 visual traits.',
        '- mutable.status is as of the starting point — usually "alive". location is where they are in chapter 1.',
        '- relationships reference another character id. State kind and state.',
    ],
    schema: '## Output schema (emit this one JSON object only)',
    placeholders: {
        canonicalName: 'name',
        alias: 'nickname',
        ageBand: 'early twenties',
        birthOrder: 'eldest son',
        role: 'protagonist',
        coreAppearance: '"silver hair", "scar at the left eye"',
        location: 'the eastern palace',
        relationshipKind: 'rival',
        relationshipState: 'unresolved conflict',
    },
};
export function buildCastDesignUserPrompt(input) {
    const ctx = resolveStepPromptLanguage(input);
    const labels = pickByFamily(ctx, { ko: CAST_DESIGN_LABELS_KO, multilingual: CAST_DESIGN_LABELS_EN });
    const p = labels.placeholders;
    return [
        labels.title,
        input.title,
        ``,
        labels.genre,
        input.genre,
        ``,
        labels.language,
        ctx.language,
        ``,
        labels.brief,
        input.brief && input.brief.trim().length > 0 ? input.brief : labels.briefMissing,
        ``,
        labels.targetChapters,
        String(input.targetChapters),
        ``,
        labels.premise,
        input.premise,
        ``,
        labels.worldFacts,
        JSON.stringify(input.worldFacts, null, 2),
        ``,
        labels.task,
        ...labels.taskLines,
        ``,
        labels.schema,
        '{',
        '  "characters": [',
        '    {',
        '      "id": "c1",',
        `      "canonicalName": "${p.canonicalName}",`,
        `      "aliases": ["${p.alias}"],`,
        '      "intrinsic": {',
        '        "gender": "male|female|nonbinary|unspecified",',
        `        "ageBand": "${p.ageBand}",`,
        `        "birthOrder": "${p.birthOrder}",`,
        `        "role": "${p.role}",`,
        `        "coreAppearance": [${p.coreAppearance}]`,
        '      },',
        '      "mutable": {',
        `        "location": "${p.location}",`,
        '        "status": "alive",',
        '        "knownFacts": []',
        '      },',
        '      "relationships": [',
        `        { "to": "c2", "kind": "${p.relationshipKind}", "state": "${p.relationshipState}" }`,
        '      ]',
        '    }',
        '  ]',
        '}',
    ].join('\n');
}
