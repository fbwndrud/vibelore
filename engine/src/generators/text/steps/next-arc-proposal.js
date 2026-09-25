/**
 * ADR-0003 (issue #219) — Multi-Arc Auto Proposal.
 *
 * closing-2 시점에 자동 trigger 되는 LLM call — 다음 Arc 의 promise / type /
 * estimatedEpisodes / scopedEntities / carryOverCharacters / transitionHook
 * 을 JSON 으로 propose. host (handler) 가 결과를 Arc.metadata.nextArcProposal
 * 에 저장 + 작가 승인 flow trigger.
 *
 * cheap model 권장. fail-soft — LLM throw / malformed 시 null proposal 반환.
 */
import { languageSystemLines, pickByFamily, promptFamilyCaptureContext, resolveStepPromptLanguage, } from '../../../core/prompt-language.js';
export const NEXT_ARC_PROPOSAL_SYSTEM = [
    '당신은 한국어 웹소설 Arc 기획자다.',
    '현재 Arc 종료 직전 — 다음 Arc 의 promise + 신규 무대 + carry-over 인물 + 신규 인물 + 현 Arc 마지막 화 transition hook 을 JSON 으로 propose.',
    '출력 스키마:',
    '{ "arcNumber": <int>, "title": "...", "promise": "...", "type": "small|standard|volume", "estimatedEpisodes": 5-50, "scopedEntities": [{"kind":"...","canonicalName":"...","reason":"..."}], "carryOverCharacters": [<characterId[]>], "newCharacterSeeds": [{"canonicalName":"...","role":"...","contradiction":"..."}], "transitionHook": "..." }',
    '출력은 코드 블록 없이 순수 JSON 한 개.',
    'promise = 새 Arc 의 약속 (한 줄 한국어, 일관성 기둥).',
    'estimatedEpisodes = 5-50 사이 현실 범위.',
    'carryOverCharacters 는 input characters 의 id 만 사용. 신규 인물은 newCharacterSeeds 로.',
    '누적 인물 서사 후보는 의무가 아니다. 다음 사건과 자연스럽게 충돌할 때만 carryOverCharacters에 선택하고, dormant/complicated의 남은 압력을 발전시키며 resolved 질문은 반복하지 않는다.',
    'transitionHook 은 현 Arc 마지막 화에 자연스럽게 심을 한 줄 — 다음 Arc 의 사건 trigger.',
].join(' ');
/**
 * 다국어 계열. `type` enum(small|standard|volume), characterId, JSON 키는 기계
 * 계약이라 동일하고 promise/title/transitionHook 같은 산문 값만 목표 작품 언어다.
 */
export const NEXT_ARC_PROPOSAL_SYSTEM_MULTILINGUAL = [
    'You plan arcs for serial fiction.',
    'The current arc is about to end — propose the next arc\'s promise, its new stage entities, carry-over characters, new characters, and a transition hook to plant in the current arc\'s final chapter, as JSON.',
    'Output schema:',
    '{ "arcNumber": <int>, "title": "...", "promise": "...", "type": "small|standard|volume", "estimatedEpisodes": 5-50, "scopedEntities": [{"kind":"...","canonicalName":"...","reason":"..."}], "carryOverCharacters": [<characterId[]>], "newCharacterSeeds": [{"canonicalName":"...","role":"...","contradiction":"..."}], "transitionHook": "..." }',
    'Output one pure JSON object with no code fence. Keep JSON keys, the type enum and character ids verbatim; write title, promise, reason, role, contradiction and transitionHook in the target work language.',
    'promise = the new arc\'s promise (one line, the pillar of its consistency).',
    'estimatedEpisodes = a realistic number between 5 and 50.',
    'carryOverCharacters uses only ids from the input characters. New people go in newCharacterSeeds.',
    'Accumulated character-thread candidates are not an obligation. Choose them into carryOverCharacters only when they collide naturally with the coming events, develop the remaining pressure of dormant/complicated ones, and do not repeat resolved questions.',
    'transitionHook is one line that can be planted naturally in the current arc\'s last chapter — the event trigger for the next arc.',
].join(' ');
/** ADR-0006 promptManifest 수집용 계열 정적 표면. */
export function nextArcProposalStatic(family) {
    return pickByFamily(promptFamilyCaptureContext(family), {
        ko: NEXT_ARC_PROPOSAL_SYSTEM,
        multilingual: NEXT_ARC_PROPOSAL_SYSTEM_MULTILINGUAL,
    });
}
const PROPOSAL_LABELS_KO = {
    currentArc: (n) => `## 현재 Arc ${n}`,
    promise: (v) => `promise: ${v}`,
    type: (v) => `type: ${v}`,
    progress: (cur, total) => `진행: ${cur}/${total} 화`,
    stateHeading: '## 작품 현재 상태',
    genre: (v) => `genre: ${v}`,
    targetChapters: (v) => `목표 화수: ${v}`,
    totalChapters: (v) => `전체 작성 화수: ${v}`,
    charactersHeading: '## 활성 인물 (id / canonicalName / role)',
    entitiesHeading: '## 현 Arc 무대 entity (kind / canonicalName)',
    summaryHeading: '## 작품 요약 (누적)',
    seedsHeading: '## 누적 인물 서사 후보 (선택적 기획 근거)',
    request: (n) => `위 정보로 다음 Arc ${n} 의 proposal JSON 한 개 출력.`,
    unset: '(미설정)',
    none: '(없음)',
};
const PROPOSAL_LABELS_EN = {
    currentArc: (n) => `## Current arc ${n}`,
    promise: (v) => `promise: ${v}`,
    type: (v) => `type: ${v}`,
    progress: (cur, total) => `Progress: chapter ${cur} of ${total}`,
    stateHeading: '## Current state of the work',
    genre: (v) => `genre: ${v}`,
    targetChapters: (v) => `Target chapter count: ${v}`,
    totalChapters: (v) => `Chapters written so far: ${v}`,
    charactersHeading: '## Active characters (id / canonicalName / role)',
    entitiesHeading: '## Stage entities of the current arc (kind / canonicalName)',
    summaryHeading: '## Work summary (cumulative)',
    seedsHeading: '## Accumulated character-thread candidates (optional planning input)',
    request: (n) => `Using the information above, output one proposal JSON object for arc ${n}.`,
    unset: '(not set)',
    none: '(none)',
};
function tryParse(raw) {
    const fenced = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();
    try {
        return JSON.parse(fenced);
    }
    catch {
        return null;
    }
}
function clampType(v) {
    if (v === 'small' || v === 'standard' || v === 'volume')
        return v;
    return 'standard';
}
function clampEpisodes(v) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 5 && v <= 50) {
        return Math.round(v);
    }
    return 12;
}
function coerceProposal(parsed, fallbackArcNumber) {
    if (!parsed || typeof parsed !== 'object')
        return null;
    const obj = parsed;
    const title = typeof obj.title === 'string' && obj.title.length > 0 ? obj.title.slice(0, 200) : null;
    const promise = typeof obj.promise === 'string' && obj.promise.length > 0 ? obj.promise.slice(0, 400) : null;
    if (!title || !promise)
        return null;
    const scopedRaw = Array.isArray(obj.scopedEntities) ? obj.scopedEntities : [];
    const scopedEntities = scopedRaw
        .filter((e) => e !== null && typeof e === 'object')
        .map((e) => ({
        kind: typeof e.kind === 'string' ? e.kind : 'concept',
        canonicalName: typeof e.canonicalName === 'string' ? e.canonicalName : '',
        reason: typeof e.reason === 'string' ? e.reason : undefined,
    }))
        .filter((e) => e.canonicalName.length > 0)
        .slice(0, 20);
    const carryRaw = Array.isArray(obj.carryOverCharacters) ? obj.carryOverCharacters : [];
    const carryOverCharacters = carryRaw.filter((x) => typeof x === 'string').slice(0, 30);
    const newCharRaw = Array.isArray(obj.newCharacterSeeds) ? obj.newCharacterSeeds : [];
    const newCharacterSeeds = newCharRaw
        .filter((e) => e !== null && typeof e === 'object')
        .map((e) => ({
        canonicalName: typeof e.canonicalName === 'string' ? e.canonicalName : '',
        role: typeof e.role === 'string' ? e.role : undefined,
        contradiction: typeof e.contradiction === 'string' ? e.contradiction : undefined,
    }))
        .filter((e) => e.canonicalName.length > 0)
        .slice(0, 10);
    return {
        arcNumber: typeof obj.arcNumber === 'number' ? Math.round(obj.arcNumber) : fallbackArcNumber,
        title,
        promise,
        type: clampType(obj.type),
        estimatedEpisodes: clampEpisodes(obj.estimatedEpisodes),
        scopedEntities,
        carryOverCharacters,
        newCharacterSeeds,
        transitionHook: typeof obj.transitionHook === 'string' ? obj.transitionHook.slice(0, 200) : '',
    };
}
export async function runNextArcProposal(input) {
    const ctx = resolveStepPromptLanguage(input);
    const labels = pickByFamily(ctx, { ko: PROPOSAL_LABELS_KO, multilingual: PROPOSAL_LABELS_EN });
    // 구형 ko 는 '미설정'(라벨 안 괄호 없음)을 그대로 쓴다 — 기존 문자열 유지.
    const targetChapters = input.workMeta.targetChapters
        ?? (ctx.isKo ? '미설정' : labels.unset);
    const userPrompt = [
        labels.currentArc(input.currentArc.arcNumber),
        labels.promise(input.currentArc.promise || labels.unset),
        labels.type(input.currentArc.type),
        labels.progress(input.currentArc.currentChapterInArc, input.currentArc.estimatedEpisodes),
        ``,
        labels.stateHeading,
        labels.genre(input.workMeta.genre),
        labels.targetChapters(targetChapters),
        labels.totalChapters(input.workMeta.totalChaptersSoFar),
        ``,
        labels.charactersHeading,
        input.characters.map((c) => `- ${c.id} / ${c.canonicalName} / ${c.role ?? ''}`).join('\n'),
        ``,
        labels.entitiesHeading,
        input.entities.map((e) => `- ${e.kind} / ${e.canonicalName}`).join('\n'),
        ``,
        labels.summaryHeading,
        input.workSummary.slice(0, 3000),
        ``,
        labels.seedsHeading,
        input.characterArcSeeds || labels.none,
        ``,
        labels.request(input.currentArc.arcNumber + 1),
    ].join('\n');
    const req = {
        model: input.proposalModel ?? input.writerModel,
        jsonMode: true,
        step: 'next-arc-proposal',
        messages: [
            {
                role: 'system',
                // Arc 기획 산출물은 회차 본문이 아니다 — 계약 지시문에서 분량 줄은 뺀다.
                content: [
                    pickByFamily(ctx, { ko: NEXT_ARC_PROPOSAL_SYSTEM, multilingual: NEXT_ARC_PROPOSAL_SYSTEM_MULTILINGUAL }),
                    ...languageSystemLines(ctx, { includeChapterLength: false }),
                ].join(' '),
            },
            { role: 'user', content: userPrompt },
        ],
    };
    let text = '';
    try {
        const res = await input.providers.complete(req);
        text = res.text;
    }
    catch {
        return null;
    }
    return coerceProposal(tryParse(text), input.currentArc.arcNumber + 1);
}
