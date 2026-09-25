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
import { pickByFamily } from './prompt-language.js';
import { budgetEstimator } from './token-units.js';
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
/** Rough char/2 estimate consistent with sliding-window.ts (ko / legacy). */
function approxTokens(text) {
    return Math.ceil(text.length / 2);
}
function entityCost(e, estimate) {
    const attrs = JSON.stringify(e.attrs);
    return estimate(e.canonicalName) + estimate(attrs) + 8;
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
    // `promptFamily` 미지정·'ko' 는 기존 chars/2 그대로(ko 프롬프트 byte-identical),
    // 'multilingual' 만 스크립트 인지 tokenUnits() 로 잰다.
    const estimate = budgetEstimator(input.promptFamily, approxTokens);
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
        const cost = entityCost(e, estimate);
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
 * Render the injected entity set as a prompt section.
 *
 * `context` 는 선택 인자다(구형 호출 = ko 계열, byte-identical). entity 의
 * `kind`/`status`/`entityId`/`attrs` 는 기계 값, `canonicalName`/`aliases` 는
 * 작품 데이터이므로 계열과 무관하게 그대로 싣는다. 라벨만 두 계열로 관리한다.
 */
export function renderEntityContext(result, context) {
    const labels = context === undefined || context === null
        ? ENTITY_LABELS_KO
        : pickByFamily(context, { ko: ENTITY_LABELS_KO, multilingual: ENTITY_LABELS_EN });
    if (result.injected.length === 0 && result.missingIds.length === 0) {
        return labels.empty;
    }
    const lines = [];
    lines.push(labels.heading(result));
    if (result.trimmedCount > 0) {
        lines.push(labels.trimmed(result.trimmedCount));
    }
    for (const e of result.injected) {
        const attrsStr = Object.keys(e.attrs).length > 0 ? ` attrs=${JSON.stringify(e.attrs)}` : '';
        const aliasStr = e.aliases.length > 0 ? ` aliases=[${e.aliases.join(',')}]` : '';
        lines.push(`- [${e.kind}] ${e.canonicalName} (${e.entityId}) status=${e.status}${aliasStr}${attrsStr}`);
    }
    if (result.missingIds.length > 0) {
        lines.push(labels.missing(result.missingIds));
    }
    return lines.join('\n');
}
const ENTITY_LABELS_KO = {
    empty: '(이번 화 무대 entity 미지정)',
    heading: (result) => `## 이번 화 무대 entity (${result.injected.length}개, budget ${result.tokenBudget}t, used ~${result.estimatedTokens}t)`,
    trimmed: (count) => `(token budget 으로 ${count} 개 생략)`,
    missing: (ids) => `(scene 에 명시됐지만 미등록: ${ids.join(', ')} — entity-ops 로 register 권장)`,
};
const ENTITY_LABELS_EN = {
    empty: '(No staged entities declared for this chapter.)',
    heading: (result) => `## Entities on stage this chapter (${result.injected.length}, budget ${result.tokenBudget}t, used ~${result.estimatedTokens}t)`,
    trimmed: (count) => `(${count} entities omitted for the context token budget.)`,
    missing: (ids) => `(Declared in the scene but not registered: ${ids.join(', ')} — register them via entity-ops.)`,
};
