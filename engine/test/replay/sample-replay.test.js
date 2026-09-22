/**
 * Demonstration replay test — fixture-driven, deterministic, cost=0.
 *
 * Real 30-chapter fixture 는 후속 PR 에서 record (Phase 1 머지 후).
 * 본 테스트 = RecordingProvider 의 replay path 가 end-to-end 동작함을 증명.
 */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { ENGINE_VERSION } from '../../src/core/engine-version.js';
import { createRecordingProvider, deriveFixtureKey, } from '../recording-provider.js';
const SAMPLE_REQUEST = {
    step: 'chapter-plan',
    model: { provider: 'openai', modelId: 'gpt-5.4-mini-2026-03-17' },
    jsonMode: false,
    messages: [
        { role: 'system', content: 'replay demo system prompt' },
        { role: 'user', content: 'replay demo user prompt' },
    ],
};
describe('replay sample', () => {
    it('roundtrip — derive key for SAMPLE_REQUEST, write fixture, replay returns canned text', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'eaf-213-replay-'));
        const fixturePath = join(dir, 'sample.fixture.jsonl');
        const key = deriveFixtureKey(SAMPLE_REQUEST);
        const fixtureRow = {
            key,
            step: SAMPLE_REQUEST.step,
            modelProvider: SAMPLE_REQUEST.model.provider,
            modelId: SAMPLE_REQUEST.model.modelId,
            promptDigest: 'sample',
            responseText: '{"plan":"replayed sample"}',
            usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
            recordedAt: '2026-05-26T00:00:00.000Z',
        };
        writeFileSync(fixturePath, JSON.stringify(fixtureRow) + '\n');
        const provider = createRecordingProvider({ mode: 'replay', fixturePath });
        const res = await provider.complete(SAMPLE_REQUEST);
        expect(res.text).toBe('{"plan":"replayed sample"}');
        expect(res.usage.totalTokens).toBe(70);
    });
    it('ENGINE_VERSION is bound at replay time — fixture validity tied to version snapshot', () => {
        // 후속 PR 가 ENGINE_VERSION 별 fixture 디렉터리 분리. 본 테스트는 단순
        // 현재 version 이 fixture 와 함께 변경되어야 함을 documentation 으로 명시.
        expect(typeof ENGINE_VERSION).toBe('string');
        expect(ENGINE_VERSION.length).toBeGreaterThan(0);
    });
});
