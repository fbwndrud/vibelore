/**
 * 회차 형태 코드 표. 아크 계획·회차 계획·프롬프트가 같은 어휘를 쓰도록 한곳에 둔다.
 * 코드는 선택 필드이며 없어도 계획은 유효하다. 알 수 없는 값은 버린다.
 */
import { HOOK_EVENTS } from '../../engine/src/continuity/ledger.js';

export const NARRATIVE_CODES_VERSION = 1;

const deepFreeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const v of Object.values(value)) deepFreeze(v);
    }
    return value;
};

export const EPISODE_ROLES = deepFreeze(['setup', 'escalation', 'peak', 'breather']);
export const TENSION_ROLES = deepFreeze(['escalation', 'peak']);
export const TWIST_LEVELS = deepFreeze([0, 1, 2, 3]);
export const EXPECTATION_HANDLING = deepFreeze(['fulfill', 'delay', 'twist', 'invert']);
export const HOOK_TYPES = deepFreeze(['result', 'reinterpretation', 'relationship', 'ability', 'moral', 'identity', 'none']);
// Ledger hook event names: an arc plan may only declare these three.
export const ARC_HOOK_OPS = deepFreeze(['planted', 'advanced', 'paid']);

// breatherAfterTension is the longest run of consecutive TENSION_ROLES episodes
// before a breather or payoff is due.
export const RHYTHM_CADENCE = deepFreeze({
    'light-webnovel': { unitMin: 2, unitMax: 4, breatherAfterTension: 2 },
    'commercial-dramatic': { unitMin: 3, unitMax: 5, breatherAfterTension: 3 },
    'deep-world-driven': { unitMin: 4, unitMax: 6, breatherAfterTension: 3 },
});
export const DEFAULT_DEPTH_MODE = 'commercial-dramatic';

const MAX_HOOK_OPS = 4;
const MAX_LABEL = 200;

export function rhythmModeOf(depthMode) {
    return typeof depthMode === 'string' && Object.hasOwn(RHYTHM_CADENCE, depthMode) ? depthMode : DEFAULT_DEPTH_MODE;
}

function twistLevelOf(v) {
    // Number() would turn null, '', true and [] into 0 or 1, so gate on the input type first.
    if (!(typeof v === 'number' || (typeof v === 'string' && v !== ''))) return undefined;
    const n = Number(v);
    return TWIST_LEVELS.includes(n) ? n : undefined;
}

function hookOpsOf(v) {
    if (!Array.isArray(v)) return [];
    const ops = [];
    for (const item of v) {
        if (!item || typeof item !== 'object' || !ARC_HOOK_OPS.includes(item.op)) continue;
        const label = typeof item.label === 'string' ? item.label.trim().slice(0, MAX_LABEL) : '';
        if (label) ops.push({ op: item.op, label });
        if (ops.length >= MAX_HOOK_OPS) break;
    }
    return ops;
}

/** Keeps only valid shape codes from untrusted model or stored input; empty keys are omitted. */
export function normalizeEpisodeShape(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    if (EPISODE_ROLES.includes(src.role)) out.role = src.role;
    const twistLevel = twistLevelOf(src.twistLevel);
    if (twistLevel !== undefined) out.twistLevel = twistLevel;
    if (EXPECTATION_HANDLING.includes(src.expectationHandling)) out.expectationHandling = src.expectationHandling;
    if (HOOK_TYPES.includes(src.hookType)) out.hookType = src.hookType;
    const hookOps = hookOpsOf(src.hookOps);
    if (hookOps.length) out.hookOps = hookOps;
    return out;
}
