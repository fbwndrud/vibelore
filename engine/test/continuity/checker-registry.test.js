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
    skipKoLexical,
} from '../../src/continuity/checker-registry.js';
import { LanguagePolicyError } from '../../src/core/language-policy.js';
import { checkPov } from '../../src/continuity/pov-check.js';
import { scanQuality } from '../../src/continuity/quality-scan.js';
import { scanInfoRestate } from '../../src/continuity/info-restate-detector.js';
import { scanSentenceStats } from '../../src/continuity/sentence-stats.js';
import { runProsodyScan } from '../../src/continuity/prosody-scan.js';
import { DefaultEmotionVerbLexicon } from '../../src/continuity/emotion-verb-lexicon.js';
import { DefaultSimileMarkerLexicon } from '../../src/continuity/simile-marker-lexicon.js';
import { DefaultOnomatopoeiaLexicon } from '../../src/continuity/onomatopoeia-lexicon.js';
import { KO_SENSITIVE_SEED, scanSensitive, DefaultSensitiveLexicon } from '../../src/continuity/sensitive-lexicon.js';
import { createFoundation, registerCharacter } from '../../src/continuity/foundation.js';
import { createGenreProfileRegistry } from '../../src/continuity/genre-profile.js';
import { scanWebnovelFormat } from '../../../src/tools/webnovel-format.js';

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
        expect(fail.violations.every((v) => v.severity === 'hard' && v.code === 'POV_VIOLATION')).toBe(true);
        const failCoverage = aggregateCheckerCoverage(describeCheckerPlan({ language: 'ko', foundation: f }), [fail]);
        expect(failCoverage.invariants.POV.coverage).toBe('failed');
        expect(failCoverage.failedRequired).toContain('POV');
        expect(failCoverage.blocked).toBe(true);
        const failWithSemantic = aggregateCheckerCoverage(
            describeCheckerPlan({ language: 'ko', foundation: f }),
            [fail],
            { POV: 'pass' },
        );
        expect(failWithSemantic.invariants.POV.coverage).toBe('failed');
        expect(failWithSemantic.failedRequired).toContain('POV');

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

    it('does not treat soft detector findings or advisory FORMAT rows as required failures', () => {
        const worldFoundation = { povMode: 'none', characters: [], worldFacts: [{ statement: '세금징수탑이 있다' }] };
        const restateInput = {
            language: 'ko',
            foundation: worldFoundation,
            prose: '세금징수탑 세금징수탑 세금징수탑 세금징수탑 세금징수탑',
            chapterNumber: 1,
        };
        const restate = runDetector('scanInfoRestate', scanInfoRestate, restateInput);
        expect(restate.checkerId).toBe('scanInfoRestate');
        expect(restate.status).toBe('failed');
        expect(restate.violations.length).toBeGreaterThan(0);
        expect(restate.violations.every((v) => v.severity === 'soft' && v.code === 'INFO_RESTATED')).toBe(true);

        const legacyRestate = runDetector('scanInfoRestate', scanInfoRestate, {
            foundation: worldFoundation,
            prose: restateInput.prose,
            chapterNumber: 1,
        });
        expect(legacyRestate.checkerId).toBeUndefined();
        expect(legacyRestate.status).toBeUndefined();
        expect(legacyRestate.violations.every((v) => v.severity === 'soft' && v.code === 'INFO_RESTATED')).toBe(true);

        const worldPlan = describeCheckerPlan({ language: 'ko', foundation: worldFoundation });
        const worldSoft = aggregateCheckerCoverage(worldPlan, [restate]);
        expect(worldSoft.invariants.WORLD.coverage).toBe('unvalidated');
        expect(worldSoft.failedRequired).not.toContain('WORLD');
        expect(worldSoft.unvalidatedRequired).toContain('WORLD');

        const worldSemanticPass = aggregateCheckerCoverage(worldPlan, [restate], { WORLD: 'pass' });
        expect(worldSemanticPass.invariants.WORLD.coverage).toBe('validated');
        expect(worldSemanticPass.failedRequired).not.toContain('WORLD');

        const worldSemanticFail = aggregateCheckerCoverage(worldPlan, [restate], { WORLD: 'fail' });
        expect(worldSemanticFail.invariants.WORLD.coverage).toBe('failed');
        expect(worldSemanticFail.failedRequired).toContain('WORLD');

        const worldUncertain = aggregateCheckerCoverage(worldPlan, [restate], { WORLD: 'uncertain' });
        expect(worldUncertain.invariants.WORLD.coverage).toBe('unvalidated');
        expect(worldUncertain.failedRequired).not.toContain('WORLD');
        expect(worldUncertain.unvalidatedRequired).toContain('WORLD');

        const worldError = runDetector('scanInfoRestate', () => {
            throw new Error('world-scan-error');
        }, restateInput);
        expect(worldError.status).toBe('error');
        const worldErrorCoverage = aggregateCheckerCoverage(worldPlan, [worldError], { WORLD: 'pass' });
        expect(worldErrorCoverage.invariants.WORLD.coverage).toBe('unvalidated');
        expect(worldErrorCoverage.failedRequired).not.toContain('WORLD');
        expect(worldErrorCoverage.unvalidatedRequired).toContain('WORLD');

        const monotone = '오늘은. '.repeat(12);
        const stats = runDetector('scanSentenceStats', scanSentenceStats, {
            language: 'ko',
            prose: monotone,
            chapterNumber: 1,
        });
        expect(stats.status).toBe('failed');
        expect(stats.violations.some((v) => v.severity === 'soft' && v.code === 'SENTENCE_MONOTONY')).toBe(true);

        const prosody = runDetector('runProsodyScan', (input) => runProsodyScan(input.prose, input), {
            language: 'ko',
            prose: monotone,
            chapterNumber: 1,
        });
        expect(prosody.checkerId).toBe('runProsodyScan');
        expect(typeof prosody.score).toBe('number');

        const formatPlan = describeCheckerPlan({ language: 'ko' });
        const advisoryFormat = aggregateCheckerCoverage(formatPlan, [stats, prosody]);
        expect(advisoryFormat.invariants.FORMAT.coverage).toBe('unvalidated');
        expect(advisoryFormat.failedRequired).not.toContain('FORMAT');
        expect(advisoryFormat.unvalidatedRequired).toContain('FORMAT');

        const advisoryFormatPass = aggregateCheckerCoverage(formatPlan, [stats, prosody], { FORMAT: 'pass' });
        expect(advisoryFormatPass.invariants.FORMAT.coverage).toBe('validated');
        expect(advisoryFormatPass.failedRequired).not.toContain('FORMAT');

        const dense = runDetector('scanWebnovelFormat', scanWebnovelFormat, {
            language: 'ko',
            prose: Array.from({ length: 14 }, (_, index) => `이것은 독자가 모바일 화면에서 읽기에는 지나치게 조밀하여 별도 문단으로 나눠야 하는 ${index + 1}번째 문장이다.`).join(' '),
            chapterNumber: 1,
        });
        expect(dense.status).toBe('failed');
        expect(dense.violations.some((v) => v.severity === 'soft' && v.code === 'WEBNOVEL_DENSE_PARAGRAPH')).toBe(true);
        expect(dense.violations.every((v) => v.severity !== 'hard')).toBe(true);
        const denseCoverage = aggregateCheckerCoverage(formatPlan, [stats, dense], { FORMAT: 'pass' });
        expect(denseCoverage.invariants.FORMAT.coverage).toBe('validated');
        expect(denseCoverage.failedRequired).not.toContain('FORMAT');

        const isolated = runDetector('scanWebnovelFormat', scanWebnovelFormat, {
            language: 'ko',
            prose: '“너, 받침 짐 이리 줘.” 그녀가 짐꾼 하나를 불렀다.',
            chapterNumber: 1,
        });
        expect(isolated.status).toBe('failed');
        expect(isolated.violations.some((v) => v.severity === 'soft' && v.code === 'WEBNOVEL_DIALOGUE_NOT_ISOLATED')).toBe(true);
        const layoutCoverage = aggregateCheckerCoverage(formatPlan, [stats, isolated], { FORMAT: 'pass' });
        expect(layoutCoverage.invariants.FORMAT.coverage).toBe('failed');
        expect(layoutCoverage.failedRequired).toContain('FORMAT');

        const lex = new DefaultSensitiveLexicon();
        const suggestive = KO_SENSITIVE_SEED.find((entry) => entry.category === 'sexual-suggestive' && entry.youthSeverity === 'soft');
        const profane = KO_SENSITIVE_SEED.find((entry) => entry.category === 'profanity' && entry.youthSeverity === 'hard');
        expect(suggestive).toBeDefined();
        expect(profane).toBeDefined();

        const youthSoft = runDetector('scanSensitive', scanSensitive, {
            language: 'ko',
            prose: `텍스트 ${suggestive.term}`,
            chapterNumber: 1,
            lexicon: lex,
            mode: 'youth',
            sensitiveMode: 'youth',
        });
        expect(youthSoft.status).toBe('failed');
        expect(youthSoft.violations.length).toBeGreaterThan(0);
        expect(youthSoft.violations.every((v) => v.severity === 'soft')).toBe(true);
        const youthPlan = describeCheckerPlan({ language: 'ko', mode: 'youth', sensitiveMode: 'youth' });
        const youthSoftCoverage = aggregateCheckerCoverage(youthPlan, [youthSoft]);
        expect(youthSoftCoverage.invariants.SENSITIVE.required).toBe(true);
        expect(youthSoftCoverage.invariants.SENSITIVE.coverage).toBe('unvalidated');
        expect(youthSoftCoverage.failedRequired).not.toContain('SENSITIVE');

        const youthHard = runDetector('scanSensitive', scanSensitive, {
            language: 'ko',
            prose: `텍스트 ${profane.term}`,
            chapterNumber: 1,
            lexicon: lex,
            mode: 'youth',
            sensitiveMode: 'youth',
        });
        expect(youthHard.status).toBe('failed');
        expect(youthHard.violations.some((v) => v.severity === 'hard' && v.code === 'SENSITIVE_PROFANITY')).toBe(true);
        const youthHardCoverage = aggregateCheckerCoverage(youthPlan, [youthHard], { SENSITIVE: 'pass' });
        expect(youthHardCoverage.invariants.SENSITIVE.coverage).toBe('failed');
        expect(youthHardCoverage.failedRequired).toContain('SENSITIVE');
    });
});


// 2026-09-15 fr 표본: 한국어 n-gram 기반 INFO_RESTATED 가 프랑스어 불용어('pour', 'de l', 'encore')를 세계 사실 명사구로 잡았다.
describe('multilingual WORLD restate detector', () => {
    it('skips the Korean-lexical restate scan and leaves WORLD to the semantic verdict', () => {
        const plan = describeCheckerPlan({ language: 'fr', foundation: { characters: [], worldFacts: [{ statement: 'Le quai est encore fermé pour la fête' }] } });
        const row = plan.rows.find((item) => item.checkerId === 'scanInfoRestate');
        expect(row.runDetector).toBe(false);
        expect(row.skipReason).toBe('ko_lexical_unsupported');
        expect(row.requiresSemantic).toBe(true);
        const skipped = skipKoLexical({ language: 'fr' }, 'scanInfoRestate');
        expect(skipped.status).toBe('skipped');
        expect(skipped.invariantCoverage).toBe('unvalidated');
        expect(skipped.requiresSemantic).toBe(true);
        const unvalidated = aggregateCheckerCoverage(plan, [skipped], {});
        expect(unvalidated.invariants.WORLD.coverage).toBe('unvalidated');
        const validated = aggregateCheckerCoverage(plan, [skipped], { WORLD: 'pass' });
        expect(validated.invariants.WORLD.coverage).toBe('validated');
    });
    it('keeps running the restate scan for Korean works', () => {
        const row = describeCheckerPlan({ language: 'ko' }).rows.find((item) => item.checkerId === 'scanInfoRestate');
        expect(row.runDetector).toBe(true);
        expect(row.skipReason).toBe(null);
    });
});

describe('multilingual required FORMAT coverage', () => {
    for (const language of ['en', 'ja', 'ar', 'fr', 'th']) {
        it(`${language} cannot count a clean or skipped quote parser as format proof`, () => {
            const plan = describeCheckerPlan({ language });
            const row = plan.rows.find((item) => item.checkerId === 'scanWebnovelFormat');
            expect(row.requiresSemantic).toBe(true);
            expect(row.ifSkipped).toBe('semantic_required');
            const result = runDetector('scanWebnovelFormat', () => ({ violations: [] }), { language });
            const missing = aggregateCheckerCoverage(plan, [result], {});
            expect(missing.invariants.FORMAT.coverage).toBe('unvalidated');
            const passed = aggregateCheckerCoverage(plan, [result], { FORMAT: 'pass' });
            expect(passed.invariants.FORMAT.coverage).toBe('validated');
            const failed = aggregateCheckerCoverage(plan, [result], { FORMAT: 'fail' });
            expect(failed.invariants.FORMAT.coverage).toBe('failed');
        });
    }
    it('preserves Korean deterministic format behavior', () => {
        const row = describeCheckerPlan({ language: 'ko' }).rows.find((item) => item.checkerId === 'scanWebnovelFormat');
        expect(row.requiresSemantic).toBe(false);
        expect(row.ifSkipped).toBe('none');
    });
});
