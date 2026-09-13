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
import { CONTINUITY_STATIC_PROMPT_CAPTURES } from '../continuity/continuity-check.js';
import { captureStaticPromptManifest, capturePublicPromptManifest } from '../generators/text/steps/static-prompt-manifest.js';
import { PUBLIC_CHAPTER_PROMPT_SYSTEMS } from '../generators/text/chapter-validation.js';
import { PUBLIC_FOUNDATION_PROMPT_SYSTEMS } from '../generators/text/foundation-validation.js';
/**
 * 단일 build-time constant. PR 가 engine source 를 변경하면 반드시 bump.
 * 'endless-arc-vN' 패턴. 'v0' = Phase 0 baseline (Stage A merged, ChapterSummary 도입 전).
 */
export const ENGINE_VERSION = 'endless-arc-v13-multilingual-contract';
/**
 * Static prompt snapshot. 동적 fragment (arc rule / cold-open / foundation
 * worldFact) 는 의도적으로 제외 — manifest hash 가 매 화 변경되면 lock 의 의미가
 * 사라진다.
 */
export function collectPromptManifest() {
    const prompts = {};
    const add = (namespace, captures) => {
        for (const [step, families] of Object.entries(captures))
            for (const family of ['ko', 'multilingual'])
                prompts[`${namespace}/${step}/${family}`] = families[family];
    };
    add('live', captureStaticPromptManifest());
    add('public', capturePublicPromptManifest());
    add('validation', { ...PUBLIC_CHAPTER_PROMPT_SYSTEMS, ...PUBLIC_FOUNDATION_PROMPT_SYSTEMS });
    for (const [step, capture] of Object.entries(CONTINUITY_STATIC_PROMPT_CAPTURES))
        for (const family of ['ko', 'multilingual']) prompts[`live/${step}/${family}`] = capture(family);
    return { version: ENGINE_VERSION, prompts };
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
