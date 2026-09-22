import { describe, expect, it, vi } from '../_support/vitest-shim.mjs';
import { SENTINEL_FAIL_POLICY, SENTINEL_KINDS, attemptSentinelRepair, extractAllSentinels, validateSentinelBlock, } from '../../src/core/sentinel-schema.js';
describe('SENTINEL_KINDS / SENTINEL_FAIL_POLICY', () => {
    it('contains the 4 ADR-0007 kinds', () => {
        expect(SENTINEL_KINDS).toEqual(['cast-manifest', 'entity-ops', 'arc-cursor-ops', 'hook-ops']);
    });
    it('cast-manifest = hard, others = soft', () => {
        expect(SENTINEL_FAIL_POLICY['cast-manifest']).toBe('hard');
        expect(SENTINEL_FAIL_POLICY['entity-ops']).toBe('soft');
        expect(SENTINEL_FAIL_POLICY['arc-cursor-ops']).toBe('soft');
        expect(SENTINEL_FAIL_POLICY['hook-ops']).toBe('soft');
    });
});
describe('validateSentinelBlock', () => {
    it('cast-manifest v1 valid → parsed + schemaVersion=1', () => {
        const raw = JSON.stringify({ schemaVersion: 1, cast: [{ characterId: 'c1' }] });
        const r = validateSentinelBlock('cast-manifest', raw);
        expect(r.status).toBe('parsed');
        expect(r.schemaVersion).toBe(1);
        expect(r.payload).toEqual({ schemaVersion: 1, cast: [{ characterId: 'c1' }] });
    });
    it('malformed JSON → parse-error', () => {
        const r = validateSentinelBlock('cast-manifest', '{not json}');
        expect(r.status).toBe('parse-error');
        expect(r.error).toBeDefined();
    });
    it('missing schemaVersion → schema-error', () => {
        const raw = JSON.stringify({ cast: [] });
        const r = validateSentinelBlock('cast-manifest', raw);
        expect(r.status).toBe('schema-error');
        expect(r.error).toMatch(/schemaVersion/);
    });
    it('unknown schemaVersion → schema-error with version in result', () => {
        const raw = JSON.stringify({ schemaVersion: 99, cast: [] });
        const r = validateSentinelBlock('cast-manifest', raw);
        expect(r.status).toBe('schema-error');
        expect(r.schemaVersion).toBe(99);
        expect(r.error).toMatch(/unknown_schema_version/);
    });
    it('entity-ops v1 valid register op → parsed', () => {
        const raw = JSON.stringify({
            schemaVersion: 1,
            ops: [{ op: 'register', entityId: 'e1', kind: 'item', name: 'sword' }],
        });
        const r = validateSentinelBlock('entity-ops', raw);
        expect(r.status).toBe('parsed');
    });
    it('entity-ops v1 invalid op → schema-error', () => {
        const raw = JSON.stringify({
            schemaVersion: 1,
            ops: [{ op: 'bogus', entityId: 'e1' }],
        });
        const r = validateSentinelBlock('entity-ops', raw);
        expect(r.status).toBe('schema-error');
    });
    it('arc-cursor-ops v1 valid → parsed', () => {
        const raw = JSON.stringify({
            schemaVersion: 1,
            ops: [{ characterId: 'c1', fromBeat: 'a', toBeat: 'b' }],
        });
        expect(validateSentinelBlock('arc-cursor-ops', raw).status).toBe('parsed');
    });
    it('hook-ops v1 valid open op → parsed', () => {
        const raw = JSON.stringify({
            schemaVersion: 1,
            ops: [{ op: 'open', id: 'h1', text: 'mystery' }],
        });
        expect(validateSentinelBlock('hook-ops', raw).status).toBe('parsed');
    });
});
describe('extractAllSentinels', () => {
    it('all 4 present + valid → 4 parsed results', () => {
        const blocks = [
            { tag: 'cast-manifest', body: JSON.stringify({ schemaVersion: 1, cast: [] }) },
            { tag: 'entity-ops', body: JSON.stringify({ schemaVersion: 1, ops: [] }) },
            { tag: 'arc-cursor-ops', body: JSON.stringify({ schemaVersion: 1, ops: [] }) },
            { tag: 'hook-ops', body: JSON.stringify({ schemaVersion: 1, ops: [] }) },
        ];
        const out = extractAllSentinels(blocks);
        expect(out.map((r) => r.status)).toEqual(['parsed', 'parsed', 'parsed', 'parsed']);
        expect(out.map((r) => r.kind)).toEqual(SENTINEL_KINDS);
    });
    it('missing kinds → missing status', () => {
        const out = extractAllSentinels([
            { tag: 'cast-manifest', body: JSON.stringify({ schemaVersion: 1, cast: [] }) },
        ]);
        expect(out[0].status).toBe('parsed');
        expect(out[1].status).toBe('missing');
        expect(out[2].status).toBe('missing');
        expect(out[3].status).toBe('missing');
    });
    it('partial fail isolation — one parse-error does not affect siblings', () => {
        const blocks = [
            { tag: 'cast-manifest', body: JSON.stringify({ schemaVersion: 1, cast: [] }) },
            { tag: 'entity-ops', body: '{bogus' },
            { tag: 'arc-cursor-ops', body: JSON.stringify({ schemaVersion: 1, ops: [] }) },
        ];
        const out = extractAllSentinels(blocks);
        expect(out[0].status).toBe('parsed');
        expect(out[1].status).toBe('parse-error');
        expect(out[2].status).toBe('parsed');
        expect(out[3].status).toBe('missing');
    });
    it('unknown tag ignored — only registered SENTINEL_KINDS counted', () => {
        const blocks = [
            { tag: 'random-tag', body: 'whatever' },
            { tag: 'cast-manifest', body: JSON.stringify({ schemaVersion: 1, cast: [] }) },
        ];
        const out = extractAllSentinels(blocks);
        expect(out[0].kind).toBe('cast-manifest');
        expect(out[0].status).toBe('parsed');
    });
    it('duplicate tag — first instance wins', () => {
        const blocks = [
            { tag: 'cast-manifest', body: JSON.stringify({ schemaVersion: 1, cast: [{ characterId: 'first' }] }) },
            { tag: 'cast-manifest', body: JSON.stringify({ schemaVersion: 1, cast: [{ characterId: 'second' }] }) },
        ];
        const out = extractAllSentinels(blocks);
        expect(out[0].payload.cast[0].characterId).toBe('first');
    });
});
describe('attemptSentinelRepair', () => {
    it('successful repair → status=repaired with parsed payload', async () => {
        const providers = {
            complete: vi.fn(async () => ({
                text: JSON.stringify({ schemaVersion: 1, ops: [] }),
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
            register: vi.fn(),
            has: vi.fn(),
        };
        const r = await attemptSentinelRepair({
            providers: providers,
            repairModel: { provider: 'openai', modelId: 'gpt-5.4-mini-2026-03-17' },
            malformedRaw: '{bogus',
            kind: 'entity-ops',
        });
        expect(r.status).toBe('repaired');
        expect(r.payload).toEqual({ schemaVersion: 1, ops: [] });
    });
    it('repair returns malformed → status=parse-error with repair_failed error', async () => {
        const providers = {
            complete: vi.fn(async () => ({
                text: '{still bogus',
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
            register: vi.fn(),
            has: vi.fn(),
        };
        const r = await attemptSentinelRepair({
            providers: providers,
            repairModel: { provider: 'openai', modelId: 'gpt-5.4-mini-2026-03-17' },
            malformedRaw: '{bogus',
            kind: 'entity-ops',
        });
        expect(r.status).toBe('parse-error');
        expect(r.error).toMatch(/repair_failed/);
    });
    it('provider throws → status=parse-error with repair_call_failed', async () => {
        const providers = {
            complete: vi.fn(async () => {
                throw new Error('rate limit');
            }),
            register: vi.fn(),
            has: vi.fn(),
        };
        const r = await attemptSentinelRepair({
            providers: providers,
            repairModel: { provider: 'openai', modelId: 'gpt-5.4-mini-2026-03-17' },
            malformedRaw: '{bogus',
            kind: 'entity-ops',
        });
        expect(r.status).toBe('parse-error');
        expect(r.error).toMatch(/repair_call_failed/);
    });
    it('repair includes step label for cost-logger', async () => {
        const providers = {
            complete: vi.fn(async () => ({
                text: JSON.stringify({ schemaVersion: 1, ops: [] }),
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
            register: vi.fn(),
            has: vi.fn(),
        };
        await attemptSentinelRepair({
            providers: providers,
            repairModel: { provider: 'openai', modelId: 'gpt-5.4-mini-2026-03-17' },
            malformedRaw: '{bogus',
            kind: 'entity-ops',
        });
        const req = providers.complete.mock.calls[0]?.[0];
        expect(req?.step).toBe('sentinel-repair:entity-ops');
    });
});
