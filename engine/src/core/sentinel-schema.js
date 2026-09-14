/**
 * ADR-0007 — Sentinel Manifest Contract + Failure Isolation (issue #212).
 *
 * Engine 이 chapter 본문 끝에 첨부하는 4-종 sentinel 의 단일 스키마 레지스트리.
 *
 * - cast-manifest : 등장 인물 manifest (기존)
 * - entity-ops    : entity update ops (#216 / ADR-0002 에서 producer/consumer 추가)
 * - arc-cursor-ops: character arc cursor 갱신 (Pillar 10.9 후속)
 * - hook-ops      : hook open/progress/close (Pillar 10.8 후속)
 *
 * 본 PR scope = schema 정의 + extract & validate 유틸 + repair retry 인프라.
 * sentinel emission (writer prompt 변경) 과 commit-side consumer 는 ops 가
 * 들어오는 후속 PR (#216 등) 가 배선한다.
 */
import { z } from './mini-schema.js';
export const SENTINEL_KINDS = [
    'cast-manifest',
    'entity-ops',
    'arc-cursor-ops',
    'hook-ops',
];
/**
 * Wire-level shape: 모든 sentinel 의 JSON payload 가 `schemaVersion` (Int) 를
 * 최상위 키로 갖는다. parser 가 version 별 schema 선택.
 */
export const sentinelEnvelopeSchema = z
    .object({
    schemaVersion: z.number().int().min(1),
})
    .passthrough();
// ─── cast-manifest v1 ───────────────────────────────────────────────────────
// 기존 extractDelta 가 사용하는 cast 구조의 zod 미러. 본 PR 에서는 schema 만
// 등록 (extractDelta 의 ad-hoc parsing 은 유지). 후속 PR 가 unify.
export const castManifestV1Schema = z.object({
    schemaVersion: z.literal(1),
    cast: z.array(z.object({
        characterId: z.string().min(1),
        name: z.string().optional(),
        role: z.string().optional(),
    })),
});
// ─── entity-ops v1 ──────────────────────────────────────────────────────────
// ADR-0002 (entity ontology) 의 minimal ops 표현. 본 PR 은 schema 등록만 —
// writer 의 emission + consumer 의 reduce 는 #216 가 구현.
export const entityOpV1Schema = z.discriminatedUnion('op', [
    z.object({
        op: z.literal('register'),
        entityId: z.string().min(1),
        kind: z.string().min(1),
        name: z.string().min(1),
    }),
    z.object({
        op: z.literal('update'),
        entityId: z.string().min(1),
        fields: z.record(z.string(), z.unknown()),
    }),
    z.object({
        op: z.literal('retire'),
        entityId: z.string().min(1),
        reason: z.string().optional(),
    }),
]);
export const entityOpsV1Schema = z.object({
    schemaVersion: z.literal(1),
    ops: z.array(entityOpV1Schema),
});
// ─── arc-cursor-ops v1 ──────────────────────────────────────────────────────
export const arcCursorOpV1Schema = z.object({
    characterId: z.string().min(1),
    fromBeat: z.string().min(1),
    toBeat: z.string().min(1),
});
export const arcCursorOpsV1Schema = z.object({
    schemaVersion: z.literal(1),
    ops: z.array(arcCursorOpV1Schema),
});
// ─── hook-ops v1 ────────────────────────────────────────────────────────────
export const hookOpV1Schema = z.discriminatedUnion('op', [
    z.object({
        op: z.literal('open'),
        id: z.string().min(1),
        text: z.string().min(1),
    }),
    z.object({
        op: z.literal('progress'),
        id: z.string().min(1),
        note: z.string().optional(),
    }),
    z.object({
        op: z.literal('close'),
        id: z.string().min(1),
        resolution: z.string().optional(),
    }),
]);
export const hookOpsV1Schema = z.object({
    schemaVersion: z.literal(1),
    ops: z.array(hookOpV1Schema),
});
export const SENTINEL_SCHEMAS = {
    'cast-manifest': { v1: castManifestV1Schema },
    'entity-ops': { v1: entityOpsV1Schema },
    'arc-cursor-ops': { v1: arcCursorOpsV1Schema },
    'hook-ops': { v1: hookOpsV1Schema },
};
export const SENTINEL_FAIL_POLICY = {
    'cast-manifest': 'hard',
    'entity-ops': 'soft',
    'arc-cursor-ops': 'soft',
    'hook-ops': 'soft',
};
/**
 * 단일 sentinel block 의 rawText 를 JSON parse → schemaVersion lookup →
 * 해당 schema 로 validate. 각 단계 fail 시 status + error 보존.
 */
export function validateSentinelBlock(kind, rawText) {
    let parsed;
    try {
        parsed = JSON.parse(rawText);
    }
    catch (err) {
        return {
            kind,
            status: 'parse-error',
            rawText,
            error: err instanceof Error ? err.message.slice(0, 200) : 'parse_failed',
        };
    }
    const envelope = sentinelEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
        return {
            kind,
            status: 'schema-error',
            rawText,
            error: 'missing_or_invalid_schemaVersion',
        };
    }
    const version = envelope.data.schemaVersion;
    const versionKey = `v${version}`;
    const schemaSet = SENTINEL_SCHEMAS[kind];
    const schema = schemaSet?.[versionKey];
    if (!schema) {
        return {
            kind,
            status: 'schema-error',
            rawText,
            schemaVersion: version,
            error: `unknown_schema_version:${version}`,
        };
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
        return {
            kind,
            status: 'schema-error',
            rawText,
            schemaVersion: version,
            error: validated.error.issues
                .map((i) => `${i.path.join('.')}:${i.message}`)
                .join('|')
                .slice(0, 400),
        };
    }
    return {
        kind,
        status: 'parsed',
        payload: validated.data,
        rawText,
        schemaVersion: version,
    };
}
/**
 * 4-종 sentinel 모두 시도. 각 kind 결과를 반환. blocks 에 같은 kind 가 두 번
 * 등장하면 첫 번째만 사용 (writer prompt 가 단일 보장).
 */
export function extractAllSentinels(blocks) {
    const seen = new Map();
    for (const b of blocks) {
        const kind = b.tag;
        if (SENTINEL_KINDS.includes(kind) && !seen.has(kind)) {
            seen.set(kind, b);
        }
    }
    return SENTINEL_KINDS.map((kind) => {
        const block = seen.get(kind);
        if (!block) {
            return { kind, status: 'missing' };
        }
        return validateSentinelBlock(kind, block.body);
    });
}
const REPAIR_SYSTEM = 'You repair malformed JSON for a sentinel manifest. Output ONLY valid JSON with the same intent — no commentary, no code fence.';
/**
 * parse-error / schema-error sentinel 의 1회 LLM repair attempt. cast-manifest
 * (HARD) 는 caller 에서 skip — 본 helper 는 kind 와 무관하게 시도하나, 정책상
 * SOFT kind 만 호출하길 권장.
 */
export async function attemptSentinelRepair(args) {
    let response;
    try {
        response = await args.providers.complete({
            model: args.repairModel,
            jsonMode: true,
            step: `sentinel-repair:${args.kind}`,
            messages: [
                { role: 'system', content: REPAIR_SYSTEM },
                {
                    role: 'user',
                    content: `kind=${args.kind}\nmalformed:\n${args.malformedRaw}\n\nReturn the repaired JSON only.`,
                },
            ],
        });
    }
    catch (err) {
        return {
            kind: args.kind,
            status: 'parse-error',
            rawText: args.malformedRaw,
            error: `repair_call_failed:${err instanceof Error ? err.message.slice(0, 100) : 'unknown'}`,
        };
    }
    const repaired = validateSentinelBlock(args.kind, response.text.trim());
    if (repaired.status === 'parsed') {
        return { ...repaired, status: 'repaired' };
    }
    return { ...repaired, error: `repair_failed:${repaired.error ?? 'unknown'}` };
}
