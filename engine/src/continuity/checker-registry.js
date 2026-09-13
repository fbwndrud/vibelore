/**
 * Pure checker registry and coverage helper (Phase 2B).
 *
 * Consumes Claude's language-policy (`promptFamilyFor` / `normalizeLanguageTag`)
 * plus foundation/approved format. Does not invent a second language resolver.
 * Phase 3 maps these results onto receipts; this module never writes receipts.
 */
import {
    LANGUAGE_ERROR_CODES,
    LanguagePolicyError,
    normalizeLanguageTag,
    promptFamilyFor,
} from '../core/language-policy.js';

export const CHECKER_REGISTRY_VERSION = 1;

export const DETECTOR_STATUS = Object.freeze(['passed', 'failed', 'skipped', 'error']);
export const INVARIANT_COVERAGE = Object.freeze(['validated', 'unvalidated', 'not_applicable', 'failed']);

/** Explicit unrestricted/no-POV contracts only. omniscient and multi-pov still require semantic POV. */
export const UNRESTRICTED_POV_MODES = new Set(['none', 'no-pov', 'unrestricted']);
/** @deprecated use UNRESTRICTED_POV_MODES — kept as alias for the waiver set only. */
export const NO_POV_MODES = UNRESTRICTED_POV_MODES;

/**
 * KO_SENSITIVE_SEED category × mode severities. Adult has no hard rows.
 * Only hard rows under the explicit mode require semantic replacement when skipped.
 */
export const SENSITIVE_CATEGORY_POLICY = Object.freeze({
    profanity: Object.freeze({ adult: 'soft', youth: 'hard' }),
    'sexual-explicit': Object.freeze({ adult: 'soft', youth: 'hard' }),
    'sexual-suggestive': Object.freeze({ adult: 'allow', youth: 'soft' }),
    'violence-graphic': Object.freeze({ adult: 'soft', youth: 'hard' }),
    'drug-substance': Object.freeze({ adult: 'soft', youth: 'hard' }),
    'minor-adjacent': Object.freeze({ adult: 'allow', youth: 'allow' }),
    'self-harm': Object.freeze({ adult: 'soft', youth: 'hard' }),
});

export const REQUIRED_INVARIANTS = Object.freeze({
    SCHEMA: Object.freeze({
        id: 'SCHEMA',
        required: true,
        detectorIds: Object.freeze([]),
        exhaustive: true,
        notes: 'JSON keys, IDs, sentinels, machine enums. Phase 3 / schema validators. 2B does not fabricate a pass.',
    }),
    INTRINSIC: Object.freeze({
        id: 'INTRINSIC',
        required: true,
        detectorIds: Object.freeze([]),
        exhaustive: false,
        notes: 'Registered character intrinsic conflicts. Structural continuityCheck + semantic.',
    }),
    WORLD: Object.freeze({
        id: 'WORLD',
        required: true,
        detectorIds: Object.freeze(['scanInfoRestate', 'scanWorldGroupConflict', 'scanFanficLeak']),
        exhaustive: false,
        notes: 'World-fact heuristics are not exhaustive semantic world coverage.',
    }),
    REGISTRATION: Object.freeze({
        id: 'REGISTRATION',
        required: true,
        detectorIds: Object.freeze(['scanEntityMentions']),
        exhaustive: false,
        notes: 'Mention-scan activates context. CJK short names are observed, not NER.',
    }),
    POV: Object.freeze({
        id: 'POV',
        required: true,
        detectorIds: Object.freeze(['checkPov']),
        exhaustive: false,
        koHard: true,
        notes: 'KO lexical POV. Heuristic pass is not POV validated. omniscient/multi-pov still need semantic unless unrestricted/no-pov.',
    }),
    ADDRESSING: Object.freeze({
        id: 'ADDRESSING',
        required: 'conditional',
        detectorIds: Object.freeze(['scanLexicon']),
        exhaustive: false,
        koHard: true,
        notes: 'Required only when canonical intrinsic.addressing has non-empty term lists.',
    }),
    OUTPUT_LANGUAGE: Object.freeze({
        id: 'OUTPUT_LANGUAGE',
        required: true,
        detectorIds: Object.freeze([]),
        exhaustive: true,
        notes: 'languageCompliance semantic bundle. 2B does not judge or fabricate a pass.',
    }),
    LENGTH: Object.freeze({
        id: 'LENGTH',
        required: true,
        detectorIds: Object.freeze(['countLength']),
        exhaustive: true,
        notes: 'countLength measures; Phase 3 compares to target. A count is not a length-gate pass.',
    }),
    FORMAT: Object.freeze({
        id: 'FORMAT',
        required: true,
        detectorIds: Object.freeze(['scanWebnovelFormat']),
        exhaustive: false,
        notes: 'Approved dialogue/layout only. Unsupported quote conventions skip isolation, they do not pass it.',
    }),
    SENSITIVE: Object.freeze({
        id: 'SENSITIVE',
        required: 'conditional',
        detectorIds: Object.freeze(['scanSensitive']),
        exhaustive: false,
        preserveSeverity: true,
        notes: 'Adult seed rows are soft/allow (advisory). Youth hard categories require semantic replacement when skipped.',
    }),
});

const KO_LEXICAL_ADVISORY = Object.freeze([
    'scanQuality',
    'scanStyle',
    'scanSentenceStats',
    'runProsodyScan',
    'scanDialogueMarkerVariety',
    'detectGapSkip',
    'detectCliffhanger',
    'scanDialogueRatio',
]);

export const CHECKER_IDS = Object.freeze([
    'checkPov',
    'scanLexicon',
    'scanSensitive',
    'scanQuality',
    'scanStyle',
    'scanDialogueRatio',
    'scanDialogueMarkerVariety',
    'scanInfoRestate',
    'detectGapSkip',
    'detectCliffhanger',
    'scanSentenceStats',
    'runProsodyScan',
    'scanFanficLeak',
    'scanWorldGroupConflict',
    'scanWebnovelFormat',
    'scanEntityMentions',
    'countLength',
]);

function hasOwn(obj, key) {
    return obj != null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

function isEmptyLanguageValue(value) {
    return value === '';
}

/**
 * `null` when every language slot is omitted (legacy KO path).
 * Explicit empty string or contradictory language/family slots fail via LanguagePolicyError.
 */
export function promptFamilyFrom(input) {
    if (input == null)
        return null;
    if (typeof input === 'string') {
        if (isEmptyLanguageValue(input))
            throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, { reason: 'empty' });
        if (input === 'ko' || input === 'multilingual')
            return input;
        return promptFamilyFor(input);
    }

    const languageSlots = [];
    const familySlots = [];
    const pushLang = (path, value) => {
        languageSlots.push({ path, value });
    };
    const pushFam = (path, value) => {
        familySlots.push({ path, value });
    };

    if (hasOwn(input, 'language') && input.language !== undefined)
        pushLang('language', input.language);
    if (hasOwn(input.workContract, 'language') && input.workContract.language !== undefined)
        pushLang('workContract.language', input.workContract.language);
    if (hasOwn(input.languagePolicy, 'language') && input.languagePolicy.language !== undefined)
        pushLang('languagePolicy.language', input.languagePolicy.language);
    if (hasOwn(input.languagePolicy, 'tag') && input.languagePolicy.tag !== undefined)
        pushLang('languagePolicy.tag', input.languagePolicy.tag);

    if (hasOwn(input, 'promptFamily') && input.promptFamily !== undefined)
        pushFam('promptFamily', input.promptFamily);
    if (hasOwn(input.workContract, 'promptFamily') && input.workContract.promptFamily !== undefined)
        pushFam('workContract.promptFamily', input.workContract.promptFamily);
    if (hasOwn(input.languagePolicy, 'promptFamily') && input.languagePolicy.promptFamily !== undefined)
        pushFam('languagePolicy.promptFamily', input.languagePolicy.promptFamily);

    if (languageSlots.length === 0 && familySlots.length === 0)
        return null;

    for (const slot of [...languageSlots, ...familySlots]) {
        if (slot.value === undefined || slot.value === null || isEmptyLanguageValue(slot.value))
            throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, { reason: 'empty', path: slot.path });
    }

    const resolved = [];
    for (const slot of languageSlots) {
        const tag = normalizeLanguageTag(slot.value);
        resolved.push({ path: slot.path, family: tag.promptFamily, tag: tag.tag });
    }
    for (const slot of familySlots) {
        if (slot.value !== 'ko' && slot.value !== 'multilingual')
            throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.INVALID_LANGUAGE_TAG, {
                reason: 'invalid_prompt_family',
                path: slot.path,
                received: slot.value,
            });
        resolved.push({ path: slot.path, family: slot.value, tag: null });
    }

    const families = [...new Set(resolved.map((item) => item.family))];
    if (families.length > 1)
        throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LANGUAGE_SELECTION_REQUIRED, {
            requested: resolved.map((item) => [item.path, item.family]),
        });
    const tags = [...new Set(resolved.map((item) => item.tag).filter(Boolean))];
    if (tags.length > 1)
        throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.LANGUAGE_SELECTION_REQUIRED, { requested: tags });
    return families[0];
}

export function isLegacyCaller(input) {
    return promptFamilyFrom(input) === null;
}

export function isPolicyAwareInput(input) {
    if (input == null || typeof input !== 'object')
        return false;
    return hasOwn(input, 'language')
        || hasOwn(input, 'promptFamily')
        || hasOwn(input, 'languagePolicy')
        || hasOwn(input, 'workContract');
}

function povModeOf(input) {
    const mode = input?.povMode
        ?? input?.foundation?.povMode
        ?? input?.formatPolicy?.pov
        ?? input?.workContract?.formatPolicy?.pov
        ?? null;
    return typeof mode === 'string' ? mode.trim() : mode;
}

function nonEmptyTerms(value) {
    return Array.isArray(value) && value.some((term) => typeof term === 'string' && term.trim() !== '');
}

/** Canonical addressing contract: intrinsic.addressing term lists, not custom foundation keys. */
export function hasAddressingContract(input) {
    const chars = input?.foundation?.characters ?? [];
    return chars.some((character) => {
        const addressing = character?.intrinsic?.addressing;
        if (!addressing || typeof addressing !== 'object')
            return false;
        return nonEmptyTerms(addressing.acceptedPronouns)
            || nonEmptyTerms(addressing.acceptedGenderedTerms)
            || nonEmptyTerms(addressing.forbiddenGenderedTerms);
    });
}

function hasWorldGroup(input) {
    return Boolean(input?.foundation?.worldGroup);
}

export function sensitiveModeFrom(input) {
    const mode = input?.sensitiveMode ?? input?.mode;
    return mode === 'youth' ? 'youth' : 'adult';
}

export function hardSensitiveCategories(mode) {
    const resolved = mode === 'youth' ? 'youth' : 'adult';
    return Object.entries(SENSITIVE_CATEGORY_POLICY)
        .filter(([, row]) => row[resolved] === 'hard')
        .map(([category]) => category);
}

/**
 * Applicability plan for one check pass. Phase 3 runs detectors with
 * `runDetector: true` and combines semantic evidence for `requiresSemantic`.
 */
export function describeCheckerPlan(input = {}) {
    const family = promptFamilyFrom(input);
    const legacy = family === null;
    const multilingual = family === 'multilingual';
    const povMode = povModeOf(input);
    const unrestrictedPov = typeof povMode === 'string' && UNRESTRICTED_POV_MODES.has(povMode);
    const addressing = hasAddressingContract(input);
    const sensitiveMode = sensitiveModeFrom(input);
    const sensitiveHard = hardSensitiveCategories(sensitiveMode);
    const sensitiveRequired = sensitiveHard.length > 0;
    const formatMode = input.formatPolicy?.dialogueBreakMode
        ?? input.workContract?.formatPolicy?.dialogueBreakMode
        ?? input.dialogueBreakMode
        ?? null;

    const rows = [];
    const push = (row) => {
        rows.push(Object.freeze(row));
    };

    push({
        checkerId: 'checkPov',
        invariantId: 'POV',
        runDetector: !multilingual && !unrestrictedPov,
        applicability: unrestrictedPov ? 'not_applicable' : 'run',
        invariant: unrestrictedPov ? 'not_applicable' : 'required',
        ifSkipped: unrestrictedPov ? 'none' : 'semantic_required',
        skipReason: unrestrictedPov
            ? 'explicit_no_pov_contract'
            : (multilingual ? 'ko_lexical_unsupported' : null),
        requiresSemantic: !unrestrictedPov,
        exhaustive: false,
        koHard: true,
    });

    push({
        checkerId: 'scanLexicon',
        invariantId: 'ADDRESSING',
        runDetector: !multilingual && addressing,
        applicability: addressing ? 'run' : 'not_applicable',
        invariant: addressing ? 'required' : 'not_applicable',
        ifSkipped: addressing ? 'semantic_required' : 'none',
        skipReason: addressing
            ? (multilingual ? 'ko_lexical_unsupported' : null)
            : 'no_addressing_contract',
        requiresSemantic: addressing && multilingual,
        exhaustive: false,
        koHard: true,
    });

    push({
        checkerId: 'scanSensitive',
        invariantId: 'SENSITIVE',
        runDetector: !multilingual,
        applicability: 'run',
        invariant: sensitiveRequired ? 'required' : 'advisory',
        ifSkipped: sensitiveRequired ? 'semantic_required' : 'none',
        skipReason: multilingual ? 'ko_lexical_unsupported' : null,
        requiresSemantic: multilingual && sensitiveRequired,
        exhaustive: false,
        preserveSeverity: true,
        sensitiveMode,
        hardCategories: Object.freeze(sensitiveHard),
    });

    for (const checkerId of KO_LEXICAL_ADVISORY) {
        push({
            checkerId,
            invariantId: checkerId === 'scanSentenceStats' || checkerId === 'runProsodyScan' ? 'FORMAT' : null,
            runDetector: !multilingual,
            applicability: multilingual ? 'not_applicable' : 'run',
            invariant: 'advisory',
            ifSkipped: 'none',
            skipReason: multilingual ? 'ko_lexical_unsupported' : null,
            requiresSemantic: false,
            exhaustive: false,
        });
    }

    push({
        checkerId: 'scanInfoRestate',
        invariantId: 'WORLD',
        runDetector: true,
        applicability: 'run',
        invariant: 'required',
        ifSkipped: 'semantic_required',
        skipReason: null,
        requiresSemantic: true,
        exhaustive: false,
    });

    push({
        checkerId: 'scanFanficLeak',
        invariantId: 'WORLD',
        runDetector: Boolean(input?.foundation?.fanficSource),
        applicability: input?.foundation?.fanficSource ? 'run' : 'not_applicable',
        invariant: input?.foundation?.fanficSource ? 'required' : 'not_applicable',
        ifSkipped: 'none',
        skipReason: input?.foundation?.fanficSource ? null : 'no_fanfic_source',
        requiresSemantic: false,
        exhaustive: false,
    });

    push({
        checkerId: 'scanWorldGroupConflict',
        invariantId: 'WORLD',
        runDetector: !multilingual && hasWorldGroup(input),
        applicability: hasWorldGroup(input) ? 'run' : 'not_applicable',
        invariant: hasWorldGroup(input) ? 'required' : 'not_applicable',
        ifSkipped: hasWorldGroup(input) ? 'semantic_required' : 'none',
        skipReason: !hasWorldGroup(input)
            ? 'no_world_group'
            : (multilingual ? 'ko_lexical_unsupported' : null),
        requiresSemantic: hasWorldGroup(input),
        exhaustive: false,
    });

    push({
        checkerId: 'scanWebnovelFormat',
        invariantId: 'FORMAT',
        runDetector: true,
        applicability: 'run',
        invariant: 'required',
        ifSkipped: 'none',
        skipReason: null,
        requiresSemantic: false,
        exhaustive: false,
        formatMode,
        notes: 'Isolation follows approved dialogueBreakMode; non-KO default is natural.',
    });

    push({
        checkerId: 'scanEntityMentions',
        invariantId: 'REGISTRATION',
        runDetector: true,
        applicability: 'run',
        invariant: 'required',
        ifSkipped: 'semantic_required',
        skipReason: null,
        requiresSemantic: true,
        exhaustive: false,
    });

    push({
        checkerId: 'countLength',
        invariantId: 'LENGTH',
        runDetector: true,
        applicability: 'run',
        invariant: 'required',
        ifSkipped: 'none',
        skipReason: null,
        requiresSemantic: false,
        exhaustive: true,
        notes: 'Measurement only; target comparison is Phase 3.',
    });

    for (const id of ['SCHEMA', 'INTRINSIC', 'OUTPUT_LANGUAGE']) {
        push({
            checkerId: null,
            invariantId: id,
            runDetector: false,
            applicability: 'run',
            invariant: 'required',
            ifSkipped: 'semantic_required',
            skipReason: 'owned_outside_2b',
            requiresSemantic: true,
            exhaustive: REQUIRED_INVARIANTS[id].exhaustive,
        });
    }

    return Object.freeze({
        checkerPolicyVersion: CHECKER_REGISTRY_VERSION,
        promptFamily: family,
        legacy,
        povMode,
        rows,
    });
}

/**
 * Skip payload for KO-lexical scanners on multilingual works.
 * Legacy callers (no language) get `null` and must run as today.
 */
export function skipKoLexical(input, checkerId) {
    const family = promptFamilyFrom(input);
    if (family !== 'multilingual')
        return null;
    if (checkerId === 'scanSensitive') {
        const mode = sensitiveModeFrom(input);
        const hard = hardSensitiveCategories(mode);
        const required = hard.length > 0;
        return {
            violations: [],
            stats: null,
            score: null,
            status: 'skipped',
            skipReason: 'ko_lexical_unsupported',
            checkerId,
            invariantCoverage: required ? 'unvalidated' : 'not_applicable',
            requiresSemantic: required,
            sensitiveMode: mode,
            hardCategories: hard,
        };
    }
    if (checkerId === 'scanLexicon') {
        const addressing = hasAddressingContract(input);
        return {
            violations: [],
            stats: null,
            score: null,
            status: 'skipped',
            skipReason: addressing ? 'ko_lexical_unsupported' : 'no_addressing_contract',
            checkerId,
            invariantCoverage: addressing ? 'unvalidated' : 'not_applicable',
            requiresSemantic: addressing,
        };
    }
    const required = checkerId === 'checkPov' || checkerId === 'scanWorldGroupConflict';
    const advisory = KO_LEXICAL_ADVISORY.includes(checkerId);
    return {
        violations: [],
        stats: null,
        score: null,
        status: 'skipped',
        skipReason: 'ko_lexical_unsupported',
        checkerId,
        invariantCoverage: required ? 'unvalidated' : (advisory ? 'not_applicable' : 'unvalidated'),
        requiresSemantic: required,
    };
}

export function normalizeDetectorEnvelope(checkerId, raw) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        const violations = Array.isArray(raw) ? raw : [];
        const status = violations.length > 0 ? 'failed' : 'passed';
        return {
            checkerId,
            status,
            violations,
            stats: null,
            score: null,
        };
    }
    const violations = raw.violations ?? [];
    const status = raw.status ?? (violations.length > 0 ? 'failed' : 'passed');
    return {
        ...raw,
        checkerId: raw.checkerId ?? checkerId,
        status,
        violations,
    };
}

/**
 * Policy-aware runner. Legacy (no language slots) returns the detector's raw
 * object unchanged. Policy-aware results always include checkerId + status.
 */
export function runDetector(checkerId, detectorFn, input) {
    const policyAware = isPolicyAwareInput(input);
    try {
        const raw = detectorFn(input);
        if (!policyAware)
            return raw;
        return normalizeDetectorEnvelope(checkerId, raw);
    }
    catch (err) {
        if (!policyAware)
            throw err;
        return {
            checkerId,
            status: 'error',
            violations: [],
            stats: null,
            score: null,
            error: err instanceof Error ? err.message : String(err),
            skipReason: null,
        };
    }
}

function coverageForPlanRow(row, result, semanticEvidence) {
    if (row.applicability === 'not_applicable' || row.invariant === 'not_applicable')
        return 'not_applicable';

    const semantic = semanticEvidence?.[row.invariantId];
    const failedEvidence = result?.status === 'failed' || ((result?.violations?.length ?? 0) > 0 && result?.status !== 'skipped');
    if (failedEvidence)
        return 'failed';

    if (semantic === 'fail')
        return 'failed';
    if (semantic === 'pass') {
        if (row.requiresSemantic || row.ifSkipped === 'semantic_required' || row.exhaustive === false)
            return 'validated';
        return 'validated';
    }

    if (!result || result.status === 'error' || result.status === 'unrun') {
        if (row.invariant === 'advisory')
            return 'not_applicable';
        return 'unvalidated';
    }
    if (result.status === 'skipped') {
        if (row.invariant === 'advisory' && row.ifSkipped === 'none')
            return 'not_applicable';
        if (row.ifSkipped === 'semantic_required' || row.requiresSemantic)
            return 'unvalidated';
        if (row.invariant === 'advisory')
            return 'not_applicable';
        return 'unvalidated';
    }
    // Heuristic or non-gate detector finished without violations.
    // That is not exhaustive invariant validation.
    return 'unvalidated';
}

function isRequiredRow(row) {
    return row.invariant === 'required';
}

/**
 * Combine plan rows + detector envelopes.
 * `semanticEvidence` is optional Phase 3 input: { [invariantId]: 'pass'|'fail'|'uncertain' }.
 * 2B never fabricates SCHEMA/LENGTH/OUTPUT_LANGUAGE passes.
 */
export function aggregateCheckerCoverage(plan, detectorResults = [], semanticEvidence = {}) {
    const byId = new Map();
    for (const result of detectorResults) {
        if (result?.checkerId)
            byId.set(result.checkerId, result);
    }
    const detectors = [];
    const invariants = {};
    for (const row of plan.rows) {
        const result = row.checkerId ? byId.get(row.checkerId) : null;
        const invariantCoverage = coverageForPlanRow(row, result, semanticEvidence);
        if (row.checkerId) {
            detectors.push(Object.freeze({
                checkerId: row.checkerId,
                status: result?.status ?? (row.runDetector ? 'unrun' : 'skipped'),
                skipReason: result?.skipReason ?? row.skipReason,
                invariantId: row.invariantId,
                invariantCoverage,
                requiresSemantic: row.requiresSemantic,
                exhaustive: row.exhaustive,
            }));
        }
        if (row.invariantId) {
            const prev = invariants[row.invariantId];
            const next = {
                id: row.invariantId,
                coverage: invariantCoverage,
                required: isRequiredRow(row) || Boolean(prev?.required),
                requiresSemantic: Boolean(row.requiresSemantic || prev?.requiresSemantic),
            };
            if (!prev) {
                invariants[row.invariantId] = next;
            }
            else if (prev.coverage === 'failed' || next.coverage === 'failed') {
                invariants[row.invariantId] = { ...next, coverage: 'failed' };
            }
            else if (prev.coverage === 'unvalidated' || next.coverage === 'unvalidated') {
                invariants[row.invariantId] = { ...next, coverage: 'unvalidated' };
            }
            else if (prev.coverage === 'not_applicable' && next.coverage !== 'not_applicable') {
                invariants[row.invariantId] = next;
            }
            else {
                invariants[row.invariantId] = { ...prev, ...next, coverage: prev.coverage };
            }
        }
    }
    const unvalidatedRequired = Object.values(invariants)
        .filter((inv) => inv.required && inv.coverage === 'unvalidated')
        .map((inv) => inv.id);
    const failedRequired = Object.values(invariants)
        .filter((inv) => inv.required && inv.coverage === 'failed')
        .map((inv) => inv.id);
    return Object.freeze({
        checkerPolicyVersion: plan.checkerPolicyVersion,
        promptFamily: plan.promptFamily,
        detectors,
        invariants,
        unvalidatedRequired,
        failedRequired,
        blocked: unvalidatedRequired.length > 0 || failedRequired.length > 0,
    });
}

export function detectorPassedOrFailed(violations) {
    return (violations?.length ?? 0) > 0 ? 'failed' : 'passed';
}
