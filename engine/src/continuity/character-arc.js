/**
 * character-arc — Arc Flow Stage A (EPIC #191 / Stage A #192).
 *
 * 좌담 통찰 #03 (individuation). 한 작품 안에서 동시에 깊이 다뤄지는 인물 arc 는
 * 최대 2명. 그 이상이면 각 인물의 회복/변화 beat 가 묽어진다 (= "내 아내" 도달률 ↓).
 *
 * arcCursor = 각 캐릭터의 6-beat 진행 트래커.
 *
 *   wound          상처 / 사건이 인물에 남긴 흔적
 *   attempt        회복 시도
 *   collapse       시도 실패 + 더 깊은 절망
 *   companion      동행 등장 / 외부 도움
 *   self-choice    스스로 선택 / 능동 행위
 *   echo           잔향 / 이 인물이 작품 끝까지 남기는 흔적
 *
 * StoryState (EngineStoryState.data JSON) 안에 `arcCursor` 로 carry-forward.
 * draft.ts prompt 가 prevState.arcCursor 로 작가 인물별 진행도를 인식.
 * reduceStoryState 가 sentinel manifest 의 `arcCursorOps` 로 갱신.
 *
 * Stage A 정책: helper API + active arc quota 검증만 export.
 * sentinel 스키마 통합 + reduceStoryState 자동 갱신은 Stage B (deferred).
 */
/** 6-beat (좌담 통찰 #04 salvation arc 와 동일 셋). */
export const CHARACTER_ARC_BEATS = [
    'wound',
    'attempt',
    'collapse',
    'companion',
    'self-choice',
    'echo',
];
/** active arc quota — 한 작품 안 동시 깊이 다룰 인물 최대 수. */
export const MAX_ACTIVE_CHARACTER_ARCS = 2;
/**
 * cursor 에 등록된 character 중 echo 가 아닌 (아직 진행 중인) 캐릭터 수.
 * echo = "다 끝났음, 잔향만". active 로 안 친다.
 */
export function activeArcCount(cursor) {
    return Object.values(cursor).filter((e) => e.beat !== 'echo').length;
}
/** 이 캐릭터가 이미 cursor 에 있나 (== 이미 active 또는 echo). */
export function isCharacterTracked(cursor, characterId) {
    return Object.prototype.hasOwnProperty.call(cursor, characterId);
}
function advanceError(code, message) {
    return Object.assign(new Error(message), { code });
}
export function advanceCursor(cursor, args) {
    const { characterId, nextBeat, chapterNumber, note } = args;
    const existing = cursor[characterId];
    if (!existing) {
        if (nextBeat !== 'wound') {
            throw advanceError('ARC_MUST_START_AT_WOUND', `Character arc "${characterId}" first beat must be 'wound', got '${nextBeat}'`);
        }
        if (activeArcCount(cursor) >= MAX_ACTIVE_CHARACTER_ARCS) {
            throw advanceError('ACTIVE_ARC_QUOTA_EXCEEDED', `Cannot start arc for "${characterId}": ${activeArcCount(cursor)} active arcs already (quota=${MAX_ACTIVE_CHARACTER_ARCS})`);
        }
    }
    else {
        if (existing.beat === 'echo') {
            throw advanceError('CHARACTER_ARC_ECHOED', `Character arc "${characterId}" already echoed — cannot advance further (Stage B regression handling deferred)`);
        }
        const currentIdx = CHARACTER_ARC_BEATS.indexOf(existing.beat);
        const nextIdx = CHARACTER_ARC_BEATS.indexOf(nextBeat);
        // 같은 beat 재진입 허용 (note 갱신 의도). 뒤로 가기 reject. 한 칸 이상 점프 reject.
        if (nextIdx < currentIdx) {
            throw advanceError('ARC_BEAT_OUT_OF_ORDER', `Character arc "${characterId}" cannot regress from '${existing.beat}' to '${nextBeat}'`);
        }
        if (nextIdx > currentIdx + 1) {
            throw advanceError('ARC_BEAT_OUT_OF_ORDER', `Character arc "${characterId}" cannot skip beats: from '${existing.beat}' to '${nextBeat}' (must traverse 6-beat in order)`);
        }
    }
    return {
        ...cursor,
        [characterId]: {
            beat: nextBeat,
            enteredAtChapter: chapterNumber,
            ...(note ? { note } : {}),
        },
    };
}
/**
 * Initial promise placeholder generator — synopsis 첫 의미 단위 (max 120자) 를
 * Arc#1 의 promise 로 시드. 작가 onboarding 모달이 LLM 호출로 갱신 가능
 * (proposeInitialArcPromise — Stage B).
 *
 * 빈 synopsis → '(약속 미설정)' return. detect 가 작가에게 안내 노출.
 */
export function seedInitialArcPromiseFromSynopsis(synopsis) {
    const trimmed = (synopsis ?? '').trim();
    if (trimmed.length === 0)
        return '(약속 미설정)';
    // 첫 문장 또는 첫 120자 (whichever shorter). 종결부호 + 줄바꿈 으로 분할.
    const firstUnit = trimmed.split(/(?<=[.!?。…])\s+|\n+/)[0] ?? trimmed;
    const clamped = firstUnit.length > 120 ? firstUnit.slice(0, 117) + '...' : firstUnit;
    return clamped;
}
