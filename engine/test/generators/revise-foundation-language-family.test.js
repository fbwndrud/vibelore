/**
 * reviseFoundation — 다국어 Phase 2A 계열 (최종 provider messages 기준).
 *
 * 확인하는 계약:
 *   1. 계약 없는 구형 호출은 기존 한국어 편집 프롬프트 그대로다.
 *   2. 비ko 는 영어 편집 지시 계열 + 검증된 목표 언어 지시문이며, 정체성 고정
 *      필드·스키마 키·인물 id 는 두 계열에서 같다.
 *   3. 발의자 피드백은 작가 데이터라 번역·요약 없이 원문 그대로 실린다.
 *   4. 저장된 작품 언어(`current.language`/`current.workContract`)를 쓰고, 호출
 *      인자가 어긋나면 조용히 한쪽을 고르지 않고 거부한다.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { buildLanguageContract, LanguagePolicyError } from '../../src/core/language-policy.js';
import { reviseFoundation } from '../../src/generators/foundation/revise-foundation.js';
import { REVISE_FOUNDATION_SYSTEM } from '../../src/generators/text/prompts/revise-foundation.js';

const registry = createGenreProfileRegistry();
const HANGUL = /[가-힣]/;
const MODEL = { provider: 'openai', modelId: 'gpt-4o' };
const PATCH = JSON.stringify({
    worldFacts: [{ id: 'wf1', statement: '탑은 무너지지 않는다.' }],
    updatedCharacters: [{ id: 'c1', role: '주인공' }],
    newCharacters: [],
});

function currentFoundation(extra = {}) {
    return {
        workId: 'work-rf-lang',
        genre: 'action',
        worldFacts: [{ id: 'wf1', statement: 'WORLDFACT_TOKEN 검은 탑은 무너지지 않는다.' }],
        characters: [
            {
                id: 'c1',
                canonicalName: '이서준',
                aliases: ['강철왕'],
                registeredAtChapter: 1,
                contradiction: 'CONTRADICTION_TOKEN 앞뒤가 다르다.',
                intrinsic: { gender: 'male', ageBand: '20대초반', role: '주인공', coreAppearance: [] },
                mutable: { status: 'alive', knownFacts: [] },
                relationships: [],
            },
        ],
        intrinsicChanges: [],
        genreProfile: registry.get('action'),
        ...extra,
    };
}
function capturingProvider() {
    const requests = [];
    return {
        requests,
        providers: {
            async complete(req) {
                requests.push(req);
                return { text: PATCH, model: req.model };
            },
        },
    };
}
async function capture({ current = currentFoundation(), ...extra } = {}) {
    const { providers, requests } = capturingProvider();
    const result = await reviseFoundation({
        current,
        feedback: 'FEEDBACK_TOKEN 주인공을 더 나이 들게 해 주세요.',
        providers,
        model: MODEL,
        ...extra,
    });
    const req = requests[0];
    return {
        result,
        step: req.step,
        system: req.messages.find((m) => m.role === 'system').content,
        user: req.messages.find((m) => m.role === 'user').content,
    };
}

describe('reviseFoundation — 계열', () => {
    it('구형 호출은 기존 한국어 토대 편집 프롬프트 그대로다', async () => {
        const { system, user, step } = await capture();
        expect(step).toBe('revise-foundation');
        expect(system).toBe(REVISE_FOUNDATION_SYSTEM);
        expect(user).toContain('## 작품 장르');
        expect(user).toContain('## 현재 인물 (삭제 금지 — 모두 출력에 포함되어야 한다)');
        expect(user).toContain('| 모순: CONTRADICTION_TOKEN 앞뒤가 다르다.');
        expect(user).toContain('## 발의자 피드백');
        expect(user).toContain('FEEDBACK_TOKEN 주인공을 더 나이 들게 해 주세요.');
    });
    it('비ko 는 영어 편집 지시 + 목표 언어 지시문이며 고정 필드는 그대로다', async () => {
        const { system, user } = await capture({ language: 'ja' });
        expect(HANGUL.test(system)).toBe(false);
        expect(system).toContain('You edit the Foundation of a serial-fiction work written in the target work language.');
        expect(system).toContain('Target work language (BCP 47): ja.');
        // 정체성 고정 필드·스키마 키·enum 은 기계 계약이라 동일하다.
        expect(system).toContain('id, canonicalName, gender, ageBand and registeredAtChapter are pinned');
        expect(user).toContain('## Current characters (no removals — every one must appear in your output)');
        expect(user).toContain('"updatedCharacters"');
        expect(user).toContain('"gender": "male|female|nonbinary|unknown|undisclosed|not_applicable|custom"');
        // 작품 데이터와 작가 피드백은 원문 그대로다.
        expect(user).toContain('[c1] 이서준 | role: 주인공 | gender: male | ageBand: 20대초반');
        expect(user).toContain('FEEDBACK_TOKEN 주인공을 더 나이 들게 해 주세요.');
        expect(user).toContain('| contradiction: CONTRADICTION_TOKEN 앞뒤가 다르다.');
        // 토대 수정은 회차 산출물이 아니다 — 회차 분량 목표를 싣지 않는다.
        expect(system).not.toContain('Chapter length target');
    });
    it('저장된 작품 계약이 계열을 정한다', async () => {
        const contract = buildLanguageContract({ language: 'de' });
        const { system } = await capture({ current: currentFoundation({ workContract: contract, language: 'de' }) });
        expect(system).toContain('Target work language (BCP 47): de.');
        expect(HANGUL.test(system)).toBe(false);
    });
    it('저장된 언어와 어긋난 호출 인자는 거부한다', async () => {
        await expect(capture({
            current: currentFoundation({ language: 'de' }),
            language: 'ja',
        })).rejects.toThrow(LanguagePolicyError);
        await expect(capture({
            current: currentFoundation({ workContract: buildLanguageContract({ language: 'de' }), language: 'ja' }),
        })).rejects.toThrow(LanguagePolicyError);
    });
    it('Foundation 접기 동작은 계열과 무관하게 유지된다', async () => {
        const { result } = await capture({ language: 'ja' });
        expect(result.foundation.characters).toHaveLength(1);
        expect(result.foundation.characters[0].id).toBe('c1');
        expect(result.foundation.worldFacts[0].id).toBe('wf1');
    });
});
