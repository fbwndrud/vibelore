/**
 * Tests for createUsageTrackingRegistry — NEP-S2.
 *
 * Wraps an inner ProviderRegistry, tallies token usage per step, and enforces
 * a logical-call budget before delegating. register()/has() pass straight
 * through to inner. snapshot() returns an immutable copy.
 */
import { describe, it, expect } from '../_support/vitest-shim.mjs';
import {
  createUsageTrackingRegistry,
  ProviderCallBudgetError,
} from '../../src/core/usage-tracking-registry.js';

function makeInner(replies = []) {
  let i = 0;
  return {
    completeCalls: [],
    registerCalls: [],
    hasCalls: [],
    async complete(req) {
      this.completeCalls.push(req);
      return replies[i++];
    },
    register(adapter) {
      this.registerCalls.push(adapter);
    },
    has(provider) {
      this.hasCalls.push(provider);
      return true;
    },
  };
}

function req(step) {
  return {
    model: { provider: 'openai', modelId: 'gpt-x' },
    messages: [{ role: 'user', content: 'ping' }],
    ...(step !== undefined ? { step } : {}),
  };
}

function usage(p, c, t) {
  return { promptTokens: p, completionTokens: c, totalTokens: t };
}

describe('createUsageTrackingRegistry', () => {
  // (12) 2회 호출 후 snapshot 합산 · byStep 정확 (in/out 분리)
  it('aggregates usage across calls with per-step in/out separation', async () => {
    const inner = makeInner([
      { text: 'a', usage: usage(10, 4, 14) },
      { text: 'b', usage: usage(20, 6, 26) },
    ]);
    const reg = createUsageTrackingRegistry(inner);

    const r1 = await reg.complete(req('draft'));
    expect(r1.text).toBe('a');
    await reg.complete(req('revise'));

    const snap = reg.snapshot();
    expect(snap.inputTokens).toBe(30);
    expect(snap.outputTokens).toBe(10);
    expect(snap.totalTokens).toBe(40);
    expect(snap.logicalCalls).toBe(2);
    expect(snap.byStep.draft).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      calls: 1,
    });
    expect(snap.byStep.revise).toEqual({
      inputTokens: 20,
      outputTokens: 6,
      totalTokens: 26,
      calls: 1,
    });
  });

  // (12b) same-step accumulation + undefined step → 'unknown' bucket
  it('accumulates repeated steps and buckets stepless calls under "unknown"', async () => {
    const inner = makeInner([
      { text: '', usage: usage(5, 1, 6) },
      { text: '', usage: usage(7, 2, 9) },
      { text: '', usage: usage(3, 3, 6) },
    ]);
    const reg = createUsageTrackingRegistry(inner);

    await reg.complete(req('draft'));
    await reg.complete(req('draft'));
    await reg.complete(req(undefined));

    const snap = reg.snapshot();
    expect(snap.byStep.draft).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      calls: 2,
    });
    expect(snap.byStep.unknown).toEqual({
      inputTokens: 3,
      outputTokens: 3,
      totalTokens: 6,
      calls: 1,
    });
    expect(snap.logicalCalls).toBe(3);
  });

  // (13) maxLogicalCalls 초과 → ProviderCallBudgetError + inner 미호출
  it('throws ProviderCallBudgetError past the budget without calling inner', async () => {
    const inner = makeInner([
      { text: '', usage: usage(1, 1, 2) },
      { text: '', usage: usage(1, 1, 2) },
    ]);
    const reg = createUsageTrackingRegistry(inner, { maxLogicalCalls: 2 });

    await reg.complete(req('draft'));
    await reg.complete(req('draft'));

    let caught;
    try {
      await reg.complete(req('draft'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderCallBudgetError);
    expect(caught.code).toBe('PROVIDER_CALL_BUDGET_EXCEEDED');
    expect(caught.calls).toBe(3);
    // inner.complete was only reached for the first two calls
    expect(inner.completeCalls).toHaveLength(2);
  });

  // (13b) 기본 예산은 12 — 12회 성공 후 13번째에서 초과
  it('defaults the budget to 12 logical calls', async () => {
    const inner = makeInner(Array.from({ length: 12 }, () => ({ text: '', usage: usage(1, 1, 2) })));
    const reg = createUsageTrackingRegistry(inner);

    for (let i = 0; i < 12; i++) {
      await reg.complete(req('draft'));
    }
    expect(reg.snapshot().logicalCalls).toBe(12);

    let caught;
    try {
      await reg.complete(req('draft'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderCallBudgetError);
    expect(caught.calls).toBe(13);
    expect(inner.completeCalls).toHaveLength(12);
  });

  // (13c) 예산 초과 호출은 usage/byStep 를 적립하지 않음 (inner 미호출)
  it('does not fold usage or a step bucket for a budget-rejected call', async () => {
    const inner = makeInner([
      { text: '', usage: usage(4, 2, 6) },
      { text: '', usage: usage(4, 2, 6) },
    ]);
    const reg = createUsageTrackingRegistry(inner, { maxLogicalCalls: 2 });

    await reg.complete(req('draft'));
    await reg.complete(req('draft'));
    const before = reg.snapshot();

    try {
      await reg.complete(req('draft'));
    } catch {
      /* budget error expected */
    }

    const after = reg.snapshot();
    expect(after.inputTokens).toBe(before.inputTokens);
    expect(after.outputTokens).toBe(before.outputTokens);
    expect(after.totalTokens).toBe(before.totalTokens);
    expect(after.byStep.draft.calls).toBe(2);
  });

  // (14) register/has 위임
  it('delegates register() and has() to the inner registry', () => {
    const inner = makeInner();
    const reg = createUsageTrackingRegistry(inner);

    const adapter = { provider: 'openai', complete: async () => ({}) };
    reg.register(adapter);
    expect(inner.registerCalls).toContain(adapter);

    expect(reg.has('openai')).toBe(true);
    expect(inner.hasCalls).toContain('openai');
  });

  // (15) snapshot 불변성 — 반환 객체 변조가 내부 상태에 영향 없음
  it('returns an immutable snapshot (mutations do not affect internal state)', async () => {
    const inner = makeInner([{ text: '', usage: usage(5, 3, 8) }]);
    const reg = createUsageTrackingRegistry(inner);

    await reg.complete(req('draft'));

    const snap1 = reg.snapshot();
    snap1.inputTokens = 9999;
    snap1.logicalCalls = 9999;
    snap1.byStep.draft.inputTokens = 8888;
    snap1.byStep.hacked = { inputTokens: 1, outputTokens: 1, totalTokens: 2, calls: 1 };

    const snap2 = reg.snapshot();
    expect(snap2.inputTokens).toBe(5);
    expect(snap2.logicalCalls).toBe(1);
    expect(snap2.byStep.draft.inputTokens).toBe(5);
    expect(snap2.byStep.hacked).toBeUndefined();
  });
});
