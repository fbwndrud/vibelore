/**
 * 동적 컨텍스트 렌더러의 계열 분리 — sliding window / entity context / arc 라벨.
 *
 * 이 세 렌더러는 draft user prompt 안에 **그대로** 삽입되므로, 비ko 경로에서
 * 여기 남은 한국어 라벨이나 fallback 문구가 최종 요청까지 흘러간다. 인자를
 * 생략한 구형 호출은 기존 문자열 그대로여야 한다(byte-identical).
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { arcPositionLabel, ARC_POSITION_LABEL_KO } from '../../src/core/arc-context.js';
import { renderEntityContext } from '../../src/core/entity-context.js';
import { renderSlidingWindow } from '../../src/core/sliding-window.js';

const JA = { language: 'ja' };
const HANGUL = /[가-힣]/;

function window(overrides = {}) {
    return {
        recentSummaries: [
            { chapterNumber: 7, summary: 'SUMMARY_TOKEN 서준이 탑에 오른다', plotBeat: 'rising', sceneTags: ['전투'] },
        ],
        lastStoryState: null,
        estimatedTokens: 40,
        tokenBudget: 12000,
        trimmedCount: 0,
        ...overrides,
    };
}
function entityResult(overrides = {}) {
    return {
        injected: [
            { entityId: 'e1', canonicalName: '검은 탑', kind: 'setting', status: 'active', aliases: ['탑'], attrs: { height: '300m' } },
        ],
        missingIds: [],
        trimmedCount: 0,
        estimatedTokens: 30,
        tokenBudget: 2000,
        ...overrides,
    };
}

describe('renderSlidingWindow — 계열 분리', () => {
    it('인자 생략은 기존 한국어 렌더 그대로다', () => {
        expect(renderSlidingWindow(window())).toContain('## 최근 1 화 요약');
        expect(renderSlidingWindow(window({ recentSummaries: [] })))
            .toBe('(이전 화 요약 없음 — 1화 또는 신규 작품)');
    });
    it('비ko 는 영어 라벨을 쓰고 요약 데이터는 원문 그대로 싣는다', () => {
        const out = renderSlidingWindow(window({ trimmedCount: 2 }), JA);
        expect(out).toContain('## Recent 1 chapter summaries');
        expect(out).toContain('- Chapter 7 (beat=rising) [전투]: SUMMARY_TOKEN 서준이 탑에 오른다');
        expect(out).toContain('2 older chapter summaries omitted');
        expect(out).not.toContain('## 최근');
    });
    it('비ko fallback 문구에도 한국어가 남지 않는다', () => {
        const out = renderSlidingWindow(window({ recentSummaries: [] }), JA);
        expect(HANGUL.test(out)).toBe(false);
    });
});

describe('renderEntityContext — 계열 분리', () => {
    it('인자 생략은 기존 한국어 렌더 그대로다', () => {
        expect(renderEntityContext(entityResult())).toContain('## 이번 화 무대 entity');
        expect(renderEntityContext(entityResult({ injected: [], missingIds: [] })))
            .toBe('(이번 화 무대 entity 미지정)');
    });
    it('비ko 는 영어 라벨 + 기계 값/작품 데이터 보존', () => {
        const out = renderEntityContext(entityResult({ missingIds: ['e9'] }), JA);
        expect(out).toContain('## Entities on stage this chapter');
        expect(out).toContain('- [setting] 검은 탑 (e1) status=active aliases=[탑] attrs={"height":"300m"}');
        expect(out).toContain('Declared in the scene but not registered: e9');
        expect(out).not.toContain('무대 entity');
    });
    it('비ko 의 빈 결과 fallback 에도 한국어가 남지 않는다', () => {
        const out = renderEntityContext(entityResult({ injected: [], missingIds: [] }), JA);
        expect(HANGUL.test(out)).toBe(false);
    });
});

describe('arcPositionLabel — 계열 분리', () => {
    it('인자 생략은 기존 한국어 라벨 표를 그대로 쓴다', () => {
        expect(arcPositionLabel('midpoint')).toBe(ARC_POSITION_LABEL_KO.midpoint);
    });
    it('계열별 라벨을 고르고 구간 enum 키는 그대로 둔다', () => {
        expect(arcPositionLabel('closing', { language: 'ko-KR' })).toBe('종결 (Closing)');
        expect(arcPositionLabel('closing', JA)).toBe('Closing');
        // 알 수 없는 값은 위조하지 않고 원본 그대로 돌려준다.
        expect(arcPositionLabel('unknown-beat', JA)).toBe('unknown-beat');
    });
});
