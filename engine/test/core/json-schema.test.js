// NEP-S1: src/core/json-schema.test.js 에서 이전. toGeminiSchema 케이스는
// 기능 자체가 이식 제외(google 어댑터 전용, D2)라 함께 제거 — 단언 약화 아님.
import { describe, it, expect } from '../_support/vitest-shim.mjs';
import { addAdditionalProperties } from '../../src/core/json-schema.js';
describe('addAdditionalProperties (OpenAI strict)', () => {
    it('object 에 additionalProperties:false + required=모든 키 추가 (재귀)', () => {
        const out = addAdditionalProperties({
            type: 'object',
            properties: {
                a: { type: 'string' },
                nested: { type: 'object', properties: { b: { type: 'number' } } },
            },
        });
        expect(out.additionalProperties).toBe(false);
        expect(out.required).toEqual(['a', 'nested']);
        const nested = out.properties.nested;
        expect(nested.additionalProperties).toBe(false);
        expect(nested.required).toEqual(['b']);
    });
    it('array items 도 재귀', () => {
        const out = addAdditionalProperties({
            type: 'array',
            items: { type: 'object', properties: { x: { type: 'string' } } },
        });
        const items = out.items;
        expect(items.additionalProperties).toBe(false);
        expect(items.required).toEqual(['x']);
    });
    it('원본 불변 (순수 함수)', () => {
        const input = { type: 'object', properties: { a: { type: 'string' } } };
        addAdditionalProperties(input);
        expect(input).not.toHaveProperty('additionalProperties');
    });
});
