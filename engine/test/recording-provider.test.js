import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from './_support/vitest-shim.mjs';
import { FixtureMissError, createRecordingProvider, deriveFixtureKey, } from './recording-provider.js';
function tmpFixturePath() {
    const dir = mkdtempSync(join(tmpdir(), 'recording-provider-'));
    return join(dir, 'fixture.jsonl');
}
const req1 = {
    model: { provider: 'openai', modelId: 'gpt-5.4-mini-2026-03-17' },
    step: 'chapter-plan',
    messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u1' },
    ],
};
const req2 = {
    ...req1,
    step: 'draft',
    messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u2' },
    ],
};
describe('deriveFixtureKey', () => {
    it('same request → same key', () => {
        expect(deriveFixtureKey(req1)).toBe(deriveFixtureKey(req1));
    });
    it('different step → different key', () => {
        expect(deriveFixtureKey(req1)).not.toBe(deriveFixtureKey(req2));
    });
    it('64-char hex sha256', () => {
        expect(deriveFixtureKey(req1)).toMatch(/^[0-9a-f]{64}$/);
    });
    it('changing system prompt → different key', () => {
        const altered = {
            ...req1,
            messages: [
                { role: 'system', content: 'sys-CHANGED' },
                { role: 'user', content: 'u1' },
            ],
        };
        expect(deriveFixtureKey(req1)).not.toBe(deriveFixtureKey(altered));
    });
});
describe('createRecordingProvider mode=record', () => {
    it('throws when inner registry is missing', () => {
        expect(() => createRecordingProvider({ mode: 'record', fixturePath: tmpFixturePath() })).toThrow(/requires inner registry/);
    });
    it('delegates to inner and appends JSONL fixture row per call', async () => {
        const path = tmpFixturePath();
        const inner = {
            register: () => undefined,
            has: () => true,
            complete: vi.fn(async (req) => ({
                text: `response:${req.step}`,
                usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
            })),
        };
        const rec = createRecordingProvider({ mode: 'record', fixturePath: path, inner });
        const r1 = await rec.complete(req1);
        const r2 = await rec.complete(req2);
        expect(r1.text).toBe('response:chapter-plan');
        expect(r2.text).toBe('response:draft');
        expect(inner.complete).toHaveBeenCalledTimes(2);
        const lines = readFileSync(path, 'utf-8').trim().split('\n');
        expect(lines).toHaveLength(2);
        const row1 = JSON.parse(lines[0]);
        expect(row1.step).toBe('chapter-plan');
        expect(row1.modelProvider).toBe('openai');
        expect(row1.responseText).toBe('response:chapter-plan');
        expect(row1.usage).toEqual({ promptTokens: 100, completionTokens: 200, totalTokens: 300 });
        expect(row1.key).toBe(deriveFixtureKey(req1));
    });
    it('truncates existing fixture at session start', async () => {
        const path = tmpFixturePath();
        writeFileSync(path, '{"key":"stale","step":"old"}\n');
        const inner = {
            register: () => undefined,
            has: () => true,
            complete: vi.fn(async () => ({
                text: 'new',
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
        };
        const rec = createRecordingProvider({ mode: 'record', fixturePath: path, inner });
        await rec.complete(req1);
        const lines = readFileSync(path, 'utf-8').trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]).step).toBe('chapter-plan');
    });
});
describe('createRecordingProvider mode=replay', () => {
    it('returns recorded response without calling inner', async () => {
        const path = tmpFixturePath();
        const key = deriveFixtureKey(req1);
        writeFileSync(path, JSON.stringify({
            key,
            step: 'chapter-plan',
            modelProvider: 'openai',
            modelId: 'gpt-5.4-mini-2026-03-17',
            promptDigest: 'abc',
            responseText: 'replayed!',
            usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
            recordedAt: '2026-05-25T00:00:00Z',
        }) + '\n');
        const rec = createRecordingProvider({ mode: 'replay', fixturePath: path });
        const r = await rec.complete(req1);
        expect(r.text).toBe('replayed!');
        expect(r.usage.totalTokens).toBe(30);
        expect(rec.recordedKeys).toContain(key);
    });
    it('FixtureMissError when key not found', async () => {
        const path = tmpFixturePath();
        writeFileSync(path, '');
        const rec = createRecordingProvider({ mode: 'replay', fixturePath: path });
        await expect(rec.complete(req1)).rejects.toBeInstanceOf(FixtureMissError);
    });
    it('handles missing fixture file as empty (no entries)', async () => {
        const path = join(tmpdir(), `non-existent-${Date.now()}.jsonl`);
        expect(existsSync(path)).toBe(false);
        const rec = createRecordingProvider({ mode: 'replay', fixturePath: path });
        await expect(rec.complete(req1)).rejects.toBeInstanceOf(FixtureMissError);
    });
});
describe('end-to-end record → replay round trip', () => {
    it('record writes fixture; replay reproduces same responses without inner', async () => {
        const path = tmpFixturePath();
        let callIdx = 0;
        const realResponses = ['plan1', 'draft1'];
        const inner = {
            register: () => undefined,
            has: () => true,
            complete: vi.fn(async () => ({
                text: realResponses[callIdx++],
                usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
            })),
        };
        const recorder = createRecordingProvider({ mode: 'record', fixturePath: path, inner });
        const a = await recorder.complete(req1);
        const b = await recorder.complete(req2);
        expect(a.text).toBe('plan1');
        expect(b.text).toBe('draft1');
        // Now replay — inner should never be called.
        const replayer = createRecordingProvider({ mode: 'replay', fixturePath: path });
        const a2 = await replayer.complete(req1);
        const b2 = await replayer.complete(req2);
        expect(a2.text).toBe('plan1');
        expect(b2.text).toBe('draft1');
    });
});
describe('FixtureMissError message', () => {
    it('includes step and truncated key with refresh hint', () => {
        const err = new FixtureMissError('a'.repeat(64), 'draft');
        expect(err.message).toMatch(/step="draft"/);
        expect(err.message).toMatch(/aaaaaaaa/);
        expect(err.message).toMatch(/mode='record'/);
    });
});
let originalConsole;
beforeEach(() => {
    originalConsole = console.warn;
    console.warn = vi.fn();
});
afterEach(() => {
    if (originalConsole)
        console.warn = originalConsole;
});
