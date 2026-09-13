import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { checkPov } from '../../src/continuity/pov-check.js';
import { scanSentenceStats } from '../../src/continuity/sentence-stats.js';
import { scanDestroyedEntityMentions } from '../../src/continuity/entity-ops.js';
import { detectGapSkip } from '../../src/continuity/gap-skip-detector.js';
import { detectCliffhanger } from '../../src/continuity/cliffhanger-detector.js';
import { DefaultEmotionVerbLexicon } from '../../src/continuity/emotion-verb-lexicon.js';
import { createFoundation, registerCharacter } from '../../src/continuity/foundation.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';

const registry = createGenreProfileRegistry();
const emotion = new DefaultEmotionVerbLexicon();

function char(id, canonicalName, extra = {}) {
    return {
        id,
        canonicalName,
        aliases: extra.aliases ?? [],
        registeredAtChapter: 1,
        intrinsic: { gender: 'male', ageBand: '20대초반', role: extra.role ?? '주연', coreAppearance: [] },
        mutable: { status: 'alive', knownFacts: [] },
        relationships: [],
    };
}

function foundation(chars) {
    let f = createFoundation({ workId: 'w1', genre: 'action', genreProfile: registry.get('action'), povMode: 'limited-third' });
    for (const c of chars)
        f = registerCharacter(f, c);
    return f;
}

describe('multilingual scanner fixtures', () => {
    it('keeps KO particle POV hard fail', () => {
        const r = checkPov({
            prose: '주인공A는 거리에서 걸었다. 라이덴은 슬펐다.',
            chapterNumber: 1,
            foundation: foundation([char('a', '주인공A', { role: '주인공' }), char('b', '라이덴')]),
            narratorId: 'a',
            emotionLexicon: emotion,
            language: 'ko',
        });
        expect(r.violations.some((v) => v.code === 'POV_VIOLATION' && v.severity === 'hard')).toBe(true);
        expect(r.status).toBe('failed');
    });

    it('does not let Don\'t apostrophes mask narrative POV', () => {
        const input = {
            chapterNumber: 1,
            foundation: foundation([char('a', '주인공A', { role: '주인공' }), char('b', '라이덴')]),
            narratorId: 'a',
            emotionLexicon: emotion,
        };
        const masked = checkPov({ ...input, prose: "Don't look. 라이덴은 슬펐다." });
        expect(masked.violations.some((v) => v.code === 'POV_VIOLATION')).toBe(true);
        const quoted = checkPov({ ...input, prose: '주인공A는 중얼거렸다. "라이덴은 슬펐다, 라고 나는 추측했다."' });
        expect(quoted.violations).toEqual([]);
    });

    it('JA/ZH no-space sentences get real stats without KO rhythm fails', () => {
        const ja = scanSentenceStats({
            prose: '短い文だ。短い文だ。短い文だ。短い文だ。短い文だ。短い文だ。短い文だ。短い文だ。短い文だ。短い文だ。短い文だ。短い文だ。',
            chapterNumber: 1,
            language: 'ja',
        });
        expect(ja.stats.sentenceCount).toBe(12);
        expect(ja.violations).toEqual([]);
        expect(ja.status).toBe('skipped');
        expect(ja.stats.meanLength).toBeGreaterThan(0);
        const zh = scanSentenceStats({
            prose: '短句。短句。短句。短句。短句。短句。短句。短句。短句。短句。短句。短句。',
            chapterNumber: 1,
            language: 'zh-Hant',
        });
        expect(zh.stats.sentenceCount).toBe(12);
        expect(zh.violations).toEqual([]);
    });

    it('destroyed-entity mentions share Ann/banner matching and keep soft severity', () => {
        const v = scanDestroyedEntityMentions({
            prose: 'The banner fell.',
            snapshots: [{ entityId: 'ann', kind: 'character', canonicalName: 'Ann', aliases: [], status: 'destroyed', attrs: {} }],
            chapterNumber: 1,
        });
        expect(v).toEqual([]);
        const hit = scanDestroyedEntityMentions({
            prose: 'Ann walked in.',
            snapshots: [{ entityId: 'ann', kind: 'character', canonicalName: 'Ann', aliases: [], status: 'destroyed', attrs: {} }],
            chapterNumber: 1,
        });
        expect(hit).toHaveLength(1);
        expect(hit[0].severity).toBe('soft');
        expect(hit[0].code).toBe('DESTROYED_ENTITY_MENTION');
    });

    it('does not emit KO time-skip/cliffhanger taste fails on English when language is set', () => {
        const gap = detectGapSkip({ prose: 'He walked all day and then slept. Morning came.', chapterNumber: 1, language: 'en' });
        expect(gap.status).toBe('skipped');
        expect(gap.violations).toEqual([]);
        const cliff = detectCliffhanger({
            prose: 'He closed the door and went to bed.',
            chapterNumber: 1,
            arcPosition: 'closing',
            language: 'en',
        });
        expect(cliff.status).toBe('skipped');
        expect(cliff.violations).toEqual([]);
    });
});
