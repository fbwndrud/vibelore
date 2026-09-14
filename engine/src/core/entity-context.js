/**
 * ADR-0004 (issue #217) — Entity-aware context injection.
 *
 * chapter-plan 단계가 출력한 scene declaration (settings/characters/items/
 * antagonists/additionalRefs) 을 기반으로 EntitySnapshotRecord 들을 filter +
 * budget 안에서 render.
 *
 * "registered 된 모든 entity dump" 의 token 폭증 방지 — 이번 화 무대 entity 만
 * inject. 100화 작품 token ~70% 감소가 목표.
 */
export const EMPTY_SCENE = {
    settings: [],
    characters: [],
    items: [],
    antagonists: [],
    additionalRefs: [],
};
const DEFAULT_BUDGET = 2000;
function envBudget() {
    const raw = process.env.ENTITY_CONTEXT_TOKEN_BUDGET;
    if (!raw)
        return DEFAULT_BUDGET;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET;
}
/** Rough char/2 estimate consistent with sliding-window.ts. */
function approxTokens(text) {
    return Math.ceil(text.length / 2);
}
function entityCost(e) {
    const attrs = JSON.stringify(e.attrs);
    return approxTokens(e.canonicalName) + approxTokens(attrs) + 8;
}
function collectSceneIds(scene) {
    const out = [];
    out.push(...scene.settings);
    out.push(...scene.characters);
    out.push(...scene.items);
    out.push(...scene.antagonists);
    out.push(...scene.additionalRefs);
    return out;
}
/**
 * scene 의 명시 id 또는 canonicalName 매치로 filter. canonicalName 매치는
 * LLM 가 plan 단계에서 id 가 아닌 이름으로 declare 한 경우 (one-shot mention) 대응.
 */
export function resolveEntityContext(input) {
    const tokenBudget = input.tokenBudget ?? envBudget();
    const scene = input.scene ?? EMPTY_SCENE;
    const requested = collectSceneIds(scene);
    if (requested.length === 0) {
        return {
            injected: [],
            missingIds: [],
            trimmedCount: 0,
            estimatedTokens: 0,
            tokenBudget,
        };
    }
    const byId = new Map(input.snapshots.map((s) => [s.entityId, s]));
    const byName = new Map(input.snapshots.map((s) => [s.canonicalName, s]));
    const seenIds = new Set();
    const matched = [];
    const missingIds = [];
    for (const ref of requested) {
        const direct = byId.get(ref);
        if (direct) {
            if (!seenIds.has(direct.entityId) && direct.status !== 'retired' && direct.status !== 'destroyed') {
                seenIds.add(direct.entityId);
                matched.push(direct);
            }
            continue;
        }
        const named = byName.get(ref);
        if (named) {
            if (!seenIds.has(named.entityId) && named.status !== 'retired' && named.status !== 'destroyed') {
                seenIds.add(named.entityId);
                matched.push(named);
            }
            continue;
        }
        missingIds.push(ref);
    }
    // greedy fill by stable order (matches request order).
    const kept = [];
    let used = 0;
    for (const e of matched) {
        const cost = entityCost(e);
        if (used + cost > tokenBudget)
            break;
        kept.push(e);
        used += cost;
    }
    return {
        injected: kept,
        missingIds,
        trimmedCount: matched.length - kept.length,
        estimatedTokens: used,
        tokenBudget,
    };
}
/**
 * Render the injected entity set as a prompt section. Stable Korean format
 * for draft.ts inclusion.
 */
export function renderEntityContext(result) {
    if (result.injected.length === 0 && result.missingIds.length === 0) {
        return '(이번 화 무대 entity 미지정)';
    }
    const lines = [];
    lines.push(`## 이번 화 무대 entity (${result.injected.length}개, budget ${result.tokenBudget}t, used ~${result.estimatedTokens}t)`);
    if (result.trimmedCount > 0) {
        lines.push(`(token budget 으로 ${result.trimmedCount} 개 생략)`);
    }
    for (const e of result.injected) {
        const attrsStr = Object.keys(e.attrs).length > 0 ? ` attrs=${JSON.stringify(e.attrs)}` : '';
        const aliasStr = e.aliases.length > 0 ? ` aliases=[${e.aliases.join(',')}]` : '';
        lines.push(`- [${e.kind}] ${e.canonicalName} (${e.entityId}) status=${e.status}${aliasStr}${attrsStr}`);
    }
    if (result.missingIds.length > 0) {
        lines.push(`(scene 에 명시됐지만 미등록: ${result.missingIds.join(', ')} — entity-ops 로 register 권장)`);
    }
    return lines.join('\n');
}
