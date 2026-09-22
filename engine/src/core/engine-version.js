/**
 * ADR-0006 — Engine Versioning + Prompt Lock (issue #211).
 *
 * 작품 발의 시점의 prompt manifest 를 작품에 lock 해 mid-stream PR 머지가
 * 진행중 작품의 톤을 흔들지 않게 한다.
 *
 * Build-time constant `ENGINE_VERSION` 를 PR 의 engine source 변경마다 bump.
 * CI gate (.github/workflows/ci.yml `engine-version-gate`) 가 이를 강제.
 *
 * Manifest = static prompt 문자열들의 deterministic snapshot.
 * Runtime concat (Arc 박자별, ColdOpen 등) 은 manifest 에 포함 X — manifest
 * 가 자주 변경되면 hash 가 의미 잃음.
 */
import { createHash } from 'node:crypto';
import { CONTINUITY_CHECK_SYSTEM, EXTRACT_DELTA_SYSTEM } from '../continuity/continuity-check.js';
import { CHAPTER_PLAN_STATIC } from '../generators/text/steps/chapter-plan.js';
import { CAST_DESIGN_SYSTEM, DRAFT_SYSTEM, REVISE_SYSTEM, WORLDBUILD_SYSTEM, } from '../generators/text/prompts/index.js';
/**
 * 단일 build-time constant. PR 가 engine source 를 변경하면 반드시 bump.
 * 'endless-arc-vN' 패턴. 'v0' = Phase 0 baseline (Stage A merged, ChapterSummary 도입 전).
 */
export const ENGINE_VERSION = 'endless-arc-v12-compact-continuity';
/**
 * Static prompt snapshot. 동적 fragment (arc rule / cold-open / foundation
 * worldFact) 는 의도적으로 제외 — manifest hash 가 매 화 변경되면 lock 의 의미가
 * 사라진다.
 */
export function collectPromptManifest() {
    return {
        version: ENGINE_VERSION,
        prompts: {
            worldbuild: WORLDBUILD_SYSTEM,
            castDesign: CAST_DESIGN_SYSTEM,
            chapterPlan: CHAPTER_PLAN_STATIC,
            draft: DRAFT_SYSTEM,
            revise: REVISE_SYSTEM,
            continuityExtract: EXTRACT_DELTA_SYSTEM,
            continuityCheck: CONTINUITY_CHECK_SYSTEM,
        },
    };
}
/**
 * SHA-256 of canonical JSON (sorted keys). Same manifest = same hash across
 * runs / processes. Hash 변경 = engine prompt 변경 → drift-report 의 신호.
 */
export function computePromptManifestHash(manifest) {
    const sortedKeys = Object.keys(manifest.prompts).sort();
    const canonical = JSON.stringify({
        version: manifest.version,
        prompts: sortedKeys.map((k) => [k, manifest.prompts[k]]),
    });
    return createHash('sha256').update(canonical).digest('hex');
}
/** Convenience — manifest + hash in one call. */
export function collectPromptManifestWithHash() {
    const manifest = collectPromptManifest();
    return { ...manifest, hash: computePromptManifestHash(manifest) };
}
