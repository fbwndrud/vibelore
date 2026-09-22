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
const NEXT_ARC_PROPOSAL_SYSTEM = [
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
    const userPrompt = [
        `## 현재 Arc ${input.currentArc.arcNumber}`,
        `promise: ${input.currentArc.promise || '(미설정)'}`,
        `type: ${input.currentArc.type}`,
        `진행: ${input.currentArc.currentChapterInArc}/${input.currentArc.estimatedEpisodes} 화`,
        ``,
        `## 작품 현재 상태`,
        `genre: ${input.workMeta.genre}`,
        `목표 화수: ${input.workMeta.targetChapters ?? '미설정'}`,
        `전체 작성 화수: ${input.workMeta.totalChaptersSoFar}`,
        ``,
        `## 활성 인물 (id / canonicalName / role)`,
        input.characters.map((c) => `- ${c.id} / ${c.canonicalName} / ${c.role ?? ''}`).join('\n'),
        ``,
        `## 현 Arc 무대 entity (kind / canonicalName)`,
        input.entities.map((e) => `- ${e.kind} / ${e.canonicalName}`).join('\n'),
        ``,
        `## 작품 요약 (누적)`,
        input.workSummary.slice(0, 3000),
        ``,
        `## 누적 인물 서사 후보 (선택적 기획 근거)`,
        input.characterArcSeeds || '(없음)',
        ``,
        `위 정보로 다음 Arc ${input.currentArc.arcNumber + 1} 의 proposal JSON 한 개 출력.`,
    ].join('\n');
    const req = {
        model: input.proposalModel ?? input.writerModel,
        jsonMode: true,
        step: 'next-arc-proposal',
        messages: [
            { role: 'system', content: NEXT_ARC_PROPOSAL_SYSTEM },
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
