/**
 * TextGenerator 공개 어댑터 — 언어 계약 전달 (다국어 Phase 2A).
 *
 * 어댑터는 계약을 정하지 않고 **잃지도 않는다**. 확인하는 계약:
 *   1. 명시된 `language`/`workContract`/`length`(+구형 분량)가 단계까지 전달된다.
 *   2. 적지 않은 속성은 `undefined` 로 주입되지 않고 키 자체가 없다 — 하위 단계가
 *      "명시 여부"로 구형/신규 동작을 가른다.
 *   3. 서로 어긋난 인자는 단계까지 내려가기 전에 거부한다.
 */
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { buildLanguageContract, LanguagePolicyError } from '../../src/core/language-policy.js';
import { TextGenerator } from '../../src/generators/text/text-generator.js';

function recordingSteps() {
    const seen = [];
    return {
        seen,
        steps: {
            async worldbuild(_ctx, input) {
                seen.push({ step: 'worldbuild', input });
                return { foundation: { workId: 'w', genre: 'action', characters: [{ id: 'c1' }] } };
            },
            async writeChapter(_ctx, input) {
                seen.push({ step: 'writeChapter', input });
                return { artifact: { workId: 'w', chapterNumber: input.chapterNumber, prose: 'prose' } };
            },
            async rewriteFromChapter(_ctx, input) {
                seen.push({ step: 'rewriteFromChapter', input });
                return { artifacts: [{ workId: 'w', chapterNumber: input.fromChapter, prose: 'prose' }] };
            },
        },
    };
}
async function runWith(input) {
    const { steps, seen } = recordingSteps();
    const generator = new TextGenerator(steps);
    const plan = await generator.plan({}, input);
    await generator.run({}, plan);
    return seen[0].input;
}

describe('TextGenerator — 언어 계약 전달', () => {
    it('book-create 의 명시 계약·분량·언어를 단계로 넘긴다', async () => {
        const contract = buildLanguageContract({ language: 'ja', length: { unit: 'graphemes', target: 2600 } });
        const forwarded = await runWith({
            kind: 'book-create',
            title: 't',
            genre: 'action',
            brief: 'b',
            targetChapters: 40,
            workContract: contract,
            language: 'ja',
            length: { unit: 'graphemes', target: 2600 },
        });
        expect(forwarded.workContract).toBe(contract);
        expect(forwarded.language).toBe('ja');
        expect(forwarded.length).toEqual({ unit: 'graphemes', target: 2600 });
    });
    it('구형 book-create 입력은 새 키를 주입하지 않는다', async () => {
        const forwarded = await runWith({
            kind: 'book-create',
            title: 't',
            genre: 'action',
            brief: 'b',
            targetChapters: 40,
            chapterWordCount: 4000,
        });
        expect(forwarded.chapterWordCount).toBe(4000);
        expect('language' in forwarded).toBe(false);
        expect('workContract' in forwarded).toBe(false);
        expect('length' in forwarded).toBe(false);
        expect('povMode' in forwarded).toBe(false);
    });
    it('chapter-write / chapter-rewrite 도 계약을 잃지 않는다', async () => {
        const contract = buildLanguageContract({ language: 'en', length: { unit: 'words', target: 900 } });
        const write = await runWith({ kind: 'chapter-write', chapterNumber: 3, workContract: contract });
        expect(write.chapterNumber).toBe(3);
        expect(write.workContract).toBe(contract);
        const legacyWrite = await runWith({ kind: 'chapter-write', chapterNumber: 3 });
        expect(legacyWrite).toEqual({ chapterNumber: 3 });
        const rewrite = await runWith({ kind: 'chapter-rewrite', fromChapter: 2, language: 'ja' });
        expect(rewrite.fromChapter).toBe(2);
        expect(rewrite.language).toBe('ja');
        const legacyRewrite = await runWith({ kind: 'chapter-rewrite', fromChapter: 2 });
        expect(legacyRewrite).toEqual({ fromChapter: 2 });
    });
    it('어긋난 인자는 단계에 도달하기 전에 거부한다', async () => {
        const { steps, seen } = recordingSteps();
        const generator = new TextGenerator(steps);
        const contract = buildLanguageContract({ language: 'ja', length: { unit: 'graphemes', target: 2600 } });
        const bad = {
            kind: 'book-create',
            title: 't',
            genre: 'action',
            brief: 'b',
            targetChapters: 40,
            workContract: contract,
            language: 'en',
        };
        const plan = await generator.plan({}, bad);
        await expect(generator.run({}, plan)).rejects.toThrow(LanguagePolicyError);
        // 구형 분량 인자가 계약 단위와 어긋나는 경우도 같다.
        const badLength = { ...bad, language: 'ja', chapterWordCount: 4000 };
        await expect(generator.run({}, await generator.plan({}, badLength))).rejects.toThrow(LanguagePolicyError);
        expect(seen).toHaveLength(0);
    });
});
