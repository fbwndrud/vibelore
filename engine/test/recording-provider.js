/**
 * ADR Plan Pillar 8.6 / issue #213 — Deterministic replay test infrastructure.
 *
 * RecordingProvider — ProviderRegistry 의 두 모드 wrapper:
 *   1. mode='record' — inner registry 로 위임 + 응답을 fixture 에 append.
 *      실 LLM 호출 비용 발생. 한 번 돌려 fixture 갱신용.
 *   2. mode='replay' — fixture 에서 key 매칭으로 응답 lookup. inner 없음.
 *      cost=0 + deterministic. CI regression suite default.
 *
 * Key derivation = sha256({ step, model, messages }) — request 의 의미적 동일성.
 * Engine 코드 변경으로 step 라벨 / 모델 / system prompt 변경 시 hash mismatch →
 * fixture 재기록 강제. ENGINE_VERSION (ADR-0006) 와 통합 가능 (별 후속).
 *
 * Fixture format: JSONL (one record per line). diff-friendly for PR review.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { deriveRequestFingerprint } from '../src/core/request-fingerprint.js';
/**
 * Canonical key — same request must yield same key across processes / OS.
 * Sorted JSON, excludes optional fields that have no semantic effect.
 */
export const deriveFixtureKey = deriveRequestFingerprint;
function digestPrompt(req) {
    const concat = req.messages.map((m) => `${m.role}:${m.content}`).join('\n---\n');
    return createHash('sha256').update(concat).digest('hex').slice(0, 16);
}
/**
 * Replay mode — load fixture into an in-memory Map.
 * record mode — fixture file 은 append-only, 시작 시 기존 내용 truncate.
 */
function loadFixture(path) {
    if (!existsSync(path))
        return new Map();
    const out = new Map();
    const lines = readFileSync(path, 'utf-8').split('\n');
    for (const line of lines) {
        if (line.trim().length === 0)
            continue;
        const record = JSON.parse(line);
        out.set(record.key, record);
    }
    return out;
}
export class FixtureMissError extends Error {
    key;
    step;
    constructor(key, step) {
        super(`RecordingProvider: no fixture entry for step="${step}" key=${key.slice(0, 16)}…. ` +
            `Run with mode='record' to refresh.`);
        this.key = key;
        this.step = step;
    }
}
export function createRecordingProvider(args) {
    const { mode, fixturePath, inner } = args;
    const keyFn = args.keyFn ?? deriveFixtureKey;
    const recordedKeys = [];
    if (mode === 'record') {
        if (!inner) {
            throw new Error("RecordingProvider mode='record' requires inner registry");
        }
        // truncate fixture at session start so consecutive runs replace, not append.
        writeFileSync(fixturePath, '');
    }
    const replayMap = mode === 'replay' ? loadFixture(fixturePath) : new Map();
    return {
        mode,
        recordedKeys,
        register: () => undefined,
        has: () => true,
        async complete(req) {
            const key = keyFn(req);
            const step = req.step ?? 'unknown';
            if (mode === 'replay') {
                const rec = replayMap.get(key);
                if (!rec)
                    throw new FixtureMissError(key, step);
                recordedKeys.push(key);
                return { text: rec.responseText, usage: rec.usage };
            }
            // record mode — call real provider, append result.
            const res = await inner.complete(req);
            const record = {
                key,
                step,
                modelProvider: req.model.provider,
                modelId: req.model.modelId,
                promptDigest: digestPrompt(req),
                responseText: res.text,
                usage: res.usage,
                recordedAt: new Date().toISOString(),
            };
            appendFileSync(fixturePath, JSON.stringify(record) + '\n');
            recordedKeys.push(key);
            return res;
        },
    };
}
