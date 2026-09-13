import { describe, expect, it } from '../_support/vitest-shim.mjs';
import {
    CHECKER_REGISTRY_VERSION,
    REQUIRED_INVARIANTS,
    SENSITIVE_CATEGORY_POLICY,
    aggregateCheckerCoverage,
    describeCheckerPlan,
    hasAddressingContract,
    hardSensitiveCategories,
    promptFamilyFrom,
    runDetector,
} from '../../src/continuity/checker-registry.js';
import { LanguagePolicyError } from '../../src/core/language-policy.js';
import { checkPov } from '../../src/continuity/pov-check.js';
import { scanQuality } from '../../src/continuity/quality-scan.js';
import { DefaultEmotionVerbLexicon } from '../../src/continuity/emotion-verb-lexicon.js';
import { DefaultSimileMarkerLexicon } from '../../src/continuity/simile-marker-lexicon.js';
import { DefaultOnomatopoeiaLexicon } from '../../src/continuity/onomatopoeia-lexicon.js';
import { KO_SENSITIVE_SEED, scanSensitive, DefaultSensitiveLexicon } from '../../src/continuity/sensitive-lexicon.js';
import { createFoundation, registerCharacter } from '../../src/continuity/foundation.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';

const registry = createGenreProfileRegistry();
const emotion = new DefaultEmotionVerbLexicon();

function char(id, canonicalName, extra = {}) {
    return {
        id,
        canonicalName,
        aliases: [],
        registeredAtChapter: 1,
        intrinsic: { gender: 'male', ageBand: '20대초반', role: extra.role ?? '주연', coreAppearance: [] },
        mutable: { status: 'alive', knownFacts: [] },
        relationships: [],
    };
}

function foundation(povMode, chars) {
    let f = createFoundation({ workId: 'w1', genre: 'action', genreProfile: registry.get('action'), ...(povMode ? { povMode } : {}) });
    for (const c of chars)
        f = registerCharacter(f, c);
    return f;
}

describe('checker registry', () => {
    it('pins registry version 1 and lists required invariants', () => {
        expect(CHECKER_REGISTRY_VERSION).toBe(1);
        expect(REQUIRED_INVARIANTS.POV.koHard).toBe(true);
        expect(REQUIRED_INVARIANTS.SENSITIVE.preserveSeverity).toBe(true);
        expect(REQUIRED_INVARIANTS.REGISTRATION.exhaustive).toBe(false);
    });

    it('promptFamilyFrom uses Claude normalization, not a second resolver', () => {
        expect(promptFamilyFrom({ language: 'ko-KR' })).toBe('ko');
        expect(promptFamilyFrom({ language: 'en-US' })).toBe('multilingual');
        expect(promptFamilyFrom({})).toBe(null);
        expect(promptFamilyFrom({ workContract: { promptFamily: 'multilingual' } })).toBe('multilingual');
    });

    it('multi-pov and omniscient stay required; only unrestricted/no-pov is not_applicable', () => {
        const omni = describeCheckerPlan({ language: 'en', foundation: foundation('omniscient', [char('a', 'Ann')]) });
        const povOmni = omni.rows.find((r) => r.checkerId === 'checkPov');
        expect(povOmni.applicability).toBe('run');
        expect(povOmni.invariant).toBe('required');
        expect(povOmni.requiresSemantic).toBe(true);

        const multi = describeCheckerPlan({ language: 'en', foundation: foundation('multi-pov', [char('a', 'Ann')]) });
        expect(multi.rows.find((r) => r.checkerId === 'checkPov').invariant).toBe('required');

        const none = describeCheckerPlan({ language: 'en', foundation: foundation('no-pov', [char('a', 'Ann')]) });
        const povNone = none.rows.find((r) => r.checkerId === 'checkPov');
        expect(povNone.applicability).toBe('not_applicable');
        expect(povNone.invariant).toBe('not_applicable');

        const skipped = runDetector('checkPov', checkPov, {
            prose: 'Ben was sad.',
            chapterNumber: 1,
            foundation: foundation('limited-third', [char('a', 'Ann', { role: '주인공' }), char('b', 'Ben')]),
            narratorId: null,
            emotionLexicon: emotion,
            language: 'en',
            povMode: 'limited-third',
        });
        expect(skipped.checkerId).toBe('checkPov');
        expect(skipped.status).toBe('skipped');
        expect(skipped.invariantCoverage).toBe('unvalidated');
        expect(skipped.skipReason).toBe('ko_lexical_unsupported');

        const unresolvedKo = runDetector('checkPov', checkPov, {
            prose: '라이덴은 슬펐다.',
            chapterNumber: 1,
            foundation: foundation('limited-third', [char('a', '주인공A', { role: '주인공' }), char('b', '라이덴')]),
            narratorId: null,
            emotionLexicon: emotion,
            language: 'ko',
            povMode: 'limited-third',
        });
        expect(unresolvedKo.checkerId).toBe('checkPov');
        expect(unresolvedKo.status).toBe('skipped');
        expect(unresolvedKo.skipReason).toBe('unresolved_narrator');
        expect(unresolvedKo.invariantCoverage).toBe('unvalidated');

        const omniScan = runDetector('checkPov', checkPov, {
            prose: 'Anyone knew everything.',
            chapterNumber: 1,
            foundation: foundation('omniscient', [char('a', 'Ann'), char('b', 'Ben')]),
            narratorId: null,
            emotionLexicon: emotion,
            language: 'en',
            povMode: 'omniscient',
        });
        expect(omniScan.status).toBe('skipped');
        expect(omniScan.invariantCoverage).toBe('unvalidated');
        expect(omniScan.requiresSemantic).toBe(true);
    });

    it('English quality scan skips instead of SIMILE_TOO_SPARSE', () => {
        const emo = new DefaultEmotionVerbLexicon();
        const sim = new DefaultSimileMarkerLexicon();
        const ono = new DefaultOnomatopoeiaLexicon();
        const prose = '평범한 글을 쓴다. '.repeat(120);
        const legacy = scanQuality({ prose, chapterNumber: 1, emotionLexicon: emo, simileLexicon: sim, onomatopoeiaLexicon: ono });
        expect(legacy.violations.some((v) => v.code === 'SIMILE_TOO_SPARSE')).toBe(true);
        const en = scanQuality({
            prose: 'The old man walked down the long empty road. He felt nothing particular. Birds flew. More words here.',
            chapterNumber: 1,
            emotionLexicon: emo, simileLexicon: sim, onomatopoeiaLexicon: ono,
            language: 'en',
        });
        expect(en.status).toBe('skipped');
        expect(en.violations).toEqual([]);
        expect(en.stats).toBe(null);
        expect(en.score).toBe(null);
    });

    it('heuristic pass does not validate required POV; detector failure stays failed', () => {
        const f = foundation('limited-third', [char('a', '주인공A', { role: '주인공' }), char('b', '라이덴')]);
        const pass = runDetector('checkPov', checkPov, {
            prose: '주인공A는 슬펐다. 그는 창밖을 바라보았다.',
            chapterNumber: 1,
            foundation: f,
            narratorId: 'a',
            emotionLexicon: emotion,
            language: 'ko',
        });
        expect(pass.checkerId).toBe('checkPov');
        expect(pass.status).toBe('passed');
        expect(pass.invariantCoverage).toBe('unvalidated');
        const passCoverage = aggregateCheckerCoverage(describeCheckerPlan({ language: 'ko', foundation: f }), [pass]);
        expect(passCoverage.invariants.POV.coverage).toBe('unvalidated');
        expect(passCoverage.unvalidatedRequired).toContain('POV');
        expect(passCoverage.blocked).toBe(true);

        const fail = runDetector('checkPov', checkPov, {
            prose: '주인공A는 거리에서 걸었다. 라이덴은 슬펐다.',
            chapterNumber: 1,
            foundation: f,
            narratorId: 'a',
            emotionLexicon: emotion,
            language: 'ko',
        });
        expect(fail.status).toBe('failed');
        expect(fail.invariantCoverage).toBe('failed');
        const failCoverage = aggregateCheckerCoverage(describeCheckerPlan({ language: 'ko', foundation: f }), [fail]);
        expect(failCoverage.invariants.POV.coverage).toBe('failed');
        expect(failCoverage.failedRequired).toContain('POV');
        expect(failCoverage.blocked).toBe(true);

        const skipped = runDetector('checkPov', checkPov, {
            prose: 'Ben was sad.',
            chapterNumber: 1,
            foundation: foundation('limited-third', [char('a', 'Ann'), char('b', 'Ben')]),
            narratorId: 'a',
            emotionLexicon: emotion,
            language: 'en',
        });
        const skippedCoverage = aggregateCheckerCoverage(
            describeCheckerPlan({ language: 'en', foundation: foundation('limited-third', [char('a', 'Ann'), char('b', 'Ben')]) }),
            [skipped],
        );
        expect(skippedCoverage.invariants.POV.coverage).toBe('unvalidated');
        const withSemantic = aggregateCheckerCoverage(
            describeCheckerPlan({ language: 'en', foundation: foundation('limited-third', [char('a', 'Ann'), char('b', 'Ben')]) }),
            [skipped],
            { POV: 'pass' },
        );
        expect(withSemantic.invariants.POV.coverage).toBe('validated');
        expect(withSemantic.failedRequired).not.toContain('POV');
    });

    it('rejects empty language and conflicting language/promptFamily', () => {
        expect(() => promptFamilyFrom({ language: '' })).toThrow(LanguagePolicyError);
        expect(() => promptFamilyFrom({ language: 'en', promptFamily: 'ko' })).toThrow(LanguagePolicyError);
        expect(() => promptFamilyFrom({ language: 'en', workContract: { language: 'ja' } })).toThrow(LanguagePolicyError);
        expect(promptFamilyFrom({})).toBe(null);
        expect(promptFamilyFrom({ workContract: { promptFamily: 'multilingual' } })).toBe('multilingual');
    });

    it('reads canonical intrinsic.addressing, not custom foundation keys', () => {
        const empty = foundation('limited-third', [char('a', 'Ann')]);
        expect(hasAddressingContract({ foundation: empty })).toBe(false);
        const fake = { foundation: { ...empty, addressingContract: true, characters: empty.characters } };
        expect(hasAddressingContract(fake)).toBe(false);
        const real = foundation('limited-third', [{
            ...char('a', 'Ann'),
            intrinsic: {
                ...char('a', 'Ann').intrinsic,
                addressing: { acceptedPronouns: [], acceptedGenderedTerms: ['Miss'], forbiddenGenderedTerms: [] },
            },
        }]);
        expect(hasAddressingContract({ foundation: real })).toBe(true);
        const plan = describeCheckerPlan({ language: 'en', foundation: real });
        const addressing = plan.rows.find((r) => r.checkerId === 'scanLexicon');
        expect(addressing.invariant).toBe('required');
        expect(addressing.requiresSemantic).toBe(true);
        const waived = describeCheckerPlan({ language: 'en', foundation: empty });
        expect(waived.rows.find((r) => r.checkerId === 'scanLexicon').invariant).toBe('not_applicable');
    });

    it('adult sensitive skip is advisory; youth hard categories require semantic replacement', () => {
        for (const entry of KO_SENSITIVE_SEED) {
            expect(SENSITIVE_CATEGORY_POLICY[entry.category].adult).toBe(entry.adultSeverity);
            expect(SENSITIVE_CATEGORY_POLICY[entry.category].youth).toBe(entry.youthSeverity);
        }
        expect(KO_SENSITIVE_SEED.every((entry) => entry.adultSeverity !== 'hard')).toBe(true);
        expect(hardSensitiveCategories('adult')).toEqual([]);
        expect(hardSensitiveCategories('youth').length).toBeGreaterThan(0);
        expect(SENSITIVE_CATEGORY_POLICY.profanity.adult).toBe('soft');
        expect(SENSITIVE_CATEGORY_POLICY.profanity.youth).toBe('hard');
        const adultSkip = runDetector('scanSensitive', scanSensitive, {
            prose: '시발',
            chapterNumber: 1,
            lexicon: new DefaultSensitiveLexicon(),
            mode: 'adult',
            language: 'en',
        });
        expect(adultSkip.status).toBe('skipped');
        expect(adultSkip.requiresSemantic).toBe(false);
        const youthSkip = runDetector('scanSensitive', scanSensitive, {
            prose: '시발',
            chapterNumber: 1,
            lexicon: new DefaultSensitiveLexicon(),
            sensitiveMode: 'youth',
            language: 'en',
        });
        expect(youthSkip.requiresSemantic).toBe(true);
        const adult = describeCheckerPlan({ language: 'en', mode: 'adult' });
        const adultRow = adult.rows.find((r) => r.checkerId === 'scanSensitive');
        expect(adultRow.invariant).toBe('advisory');
        expect(adultRow.requiresSemantic).toBe(false);
        const youth = describeCheckerPlan({ language: 'en', sensitiveMode: 'youth' });
        const youthRow = youth.rows.find((r) => r.checkerId === 'scanSensitive');
        expect(youthRow.invariant).toBe('required');
        expect(youthRow.requiresSemantic).toBe(true);
        expect(youthRow.hardCategories).toContain('profanity');
    });

    it('does not fabricate SCHEMA/LENGTH/OUTPUT_LANGUAGE validation', () => {
        const plan = describeCheckerPlan({ language: 'en' });
        const coverage = aggregateCheckerCoverage(plan, []);
        expect(coverage.invariants.SCHEMA.coverage).toBe('unvalidated');
        expect(coverage.invariants.LENGTH.coverage).toBe('unvalidated');
        expect(coverage.invariants.OUTPUT_LANGUAGE.coverage).toBe('unvalidated');
        expect(coverage.unvalidatedRequired).toEqual(expect.arrayContaining(['SCHEMA', 'LENGTH', 'OUTPUT_LANGUAGE']));
    });
});
