import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { DEFAULT_QUALITY_THRESHOLD, PROSODY_LEVELS, prosodyThresholdForLevel, QualityGateFailure, evaluateChapterQuality, failsToViolations, } from '../../src/continuity/quality-gate.js';
describe('DEFAULT_QUALITY_THRESHOLD', () => {
    // prosody 50 was the pre-#253 value, on the pre-#253 scale — where real Korean
    // prose scored 34-41 and 50 passed 0 of 7 measured chapters. QA-Z4-04-E1
    // recalibrated the scale and re-derived the default as 보통 (55), which passes
    // 6 of the same 7. coherence 60 is untouched: #253 covered the prosody axis only.
    it('prosody = 보통 / coherence 60 (ADR-0009 default, re-derived by #253)', () => {
        expect(DEFAULT_QUALITY_THRESHOLD).toEqual({ prosody: 55, coherence: 60 });
        expect(DEFAULT_QUALITY_THRESHOLD.prosody).toBe(PROSODY_LEVELS.normal);
    });
});
describe('PROSODY_LEVELS', () => {
    // The three named levels users pick from (voice-tone.md §4-4). Pinned as VALUES,
    // not just as an ordering: they are the calibration output, and a silent nudge
    // would move the gate for every job without any test noticing.
    it('느슨 45 / 보통 55 / 엄격 70', () => {
        expect(PROSODY_LEVELS).toEqual({ loose: 45, normal: 55, strict: 70 });
    });
    it('is ordered loose < normal < strict', () => {
        expect(PROSODY_LEVELS.loose < PROSODY_LEVELS.normal).toBe(true);
        expect(PROSODY_LEVELS.normal < PROSODY_LEVELS.strict).toBe(true);
    });
    it('maps a name to its number', () => {
        expect(prosodyThresholdForLevel('normal')).toBe(55);
    });
    it('returns null for an unknown name — never a silent fallback to the default', () => {
        // A typo must surface as a rejected request, not as "the gate quietly ran at
        // some other strength than the one asked for".
        expect(prosodyThresholdForLevel('strictest')).toBe(null);
        expect(prosodyThresholdForLevel('')).toBe(null);
    });
    it('does not resolve inherited Object.prototype keys', () => {
        expect(prosodyThresholdForLevel('toString')).toBe(null);
        expect(prosodyThresholdForLevel('constructor')).toBe(null);
    });
});
describe('evaluateChapterQuality', () => {
    it('both above threshold → pass', () => {
        const r = evaluateChapterQuality({
            chapterNumber: 1,
            prosodyScore: 70,
            coherenceScore: 80,
        });
        expect(r.pass).toBe(true);
        expect(r.fails).toEqual([]);
    });
    it('prosody below threshold → fail with prosody axis', () => {
        const r = evaluateChapterQuality({
            chapterNumber: 5,
            prosodyScore: 30,
            coherenceScore: 80,
        });
        expect(r.pass).toBe(false);
        expect(r.fails).toEqual([{ axis: 'prosody', score: 30, threshold: 55 }]);
    });
    it('coherence below threshold → fail with coherence axis', () => {
        const r = evaluateChapterQuality({
            chapterNumber: 5,
            prosodyScore: 70,
            coherenceScore: 40,
        });
        expect(r.fails).toEqual([{ axis: 'coherence', score: 40, threshold: 60 }]);
    });
    it('coherenceScore=null → axis skipped (only prosody enforced)', () => {
        const r = evaluateChapterQuality({
            chapterNumber: 5,
            prosodyScore: 70,
            coherenceScore: null,
        });
        expect(r.pass).toBe(true);
    });
    it('threshold.coherence=null → coherence axis disabled', () => {
        const r = evaluateChapterQuality({
            chapterNumber: 5,
            prosodyScore: 70,
            coherenceScore: 10,
            threshold: { coherence: null },
        });
        expect(r.pass).toBe(true);
    });
    it('Work-level override prosody=80 → fail at 70', () => {
        const r = evaluateChapterQuality({
            chapterNumber: 5,
            prosodyScore: 70,
            coherenceScore: 80,
            threshold: { prosody: 80 },
        });
        expect(r.pass).toBe(false);
        expect(r.fails[0]).toMatchObject({ axis: 'prosody', threshold: 80 });
    });
    it('both axes fail → 2 fails', () => {
        const r = evaluateChapterQuality({
            chapterNumber: 5,
            prosodyScore: 30,
            coherenceScore: 40,
        });
        expect(r.fails).toHaveLength(2);
    });
});
describe('failsToViolations', () => {
    it('maps prosody fail → soft QUALITY_GATE_PROSODY', () => {
        const v = failsToViolations(5, [
            { axis: 'prosody', score: 30, threshold: 50 },
        ]);
        expect(v[0]).toMatchObject({
            severity: 'soft',
            code: 'QUALITY_GATE_PROSODY',
            chapterNumber: 5,
        });
        expect(v[0].message).toMatch(/30.*50/);
    });
    it('maps coherence fail → soft QUALITY_GATE_COHERENCE', () => {
        const v = failsToViolations(5, [
            { axis: 'coherence', score: 40, threshold: 60 },
        ]);
        expect(v[0].code).toBe('QUALITY_GATE_COHERENCE');
    });
});
describe('QualityGateFailure', () => {
    it('error message lists axis=score/threshold pairs', () => {
        const e = new QualityGateFailure(5, [
            { axis: 'prosody', score: 30, threshold: 50 },
            { axis: 'coherence', score: 40, threshold: 60 },
        ]);
        expect(e.message).toMatch(/prosody=30\/50/);
        expect(e.message).toMatch(/coherence=40\/60/);
        expect(e.name).toBe('QualityGateFailure');
    });
});
