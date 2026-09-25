/**
 * Length counter for a produced MeasurementPolicy (Phase 2B).
 *
 * Does not resolve language or invent a policy. Callers pass the object from
 * `resolveMeasurementPolicy`. Faithfulness checks the pin against this runtime;
 * there is no silent locale fallback.
 */
import { DefaultOutputSanitizer } from './output-sanitizer.js';
import {
    LANGUAGE_ERROR_CODES,
    LanguagePolicyError,
    computeMeasurementPolicyHash,
} from './language-policy.js';

const sanitizer = new DefaultOutputSanitizer();

function fail(code, details) {
    throw new LanguagePolicyError(code, details);
}

function currentRuntime() {
    const versions = typeof process !== 'undefined' && process.versions ? process.versions : {};
    return Object.freeze({
        name: 'node',
        version: versions.node ?? null,
        icu: versions.icu ?? null,
        unicode: versions.unicode ?? null,
    });
}

/** Sentinel-stripped, trimmed published prose. */
export function publishedProse(text) {
    const raw = String(text ?? '');
    return sanitizer.sanitize(raw).clean.trim();
}

function assertFaithfulPolicy(policy) {
    if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
        fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_MEASUREMENT, { reason: 'policy_not_an_object' });
    }
    const unit = policy.unit;
    if (unit !== 'legacyCodeUnits' && unit !== 'graphemes' && unit !== 'words') {
        fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_MEASUREMENT, { reason: 'unknown_unit', unit: unit ?? null });
    }
    const pinned = policy.runtime;
    if (pinned === null || typeof pinned !== 'object' || Array.isArray(pinned)) {
        fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, { reason: 'missing_runtime_pin' });
    }
    const current = currentRuntime();
    if (pinned.name !== current.name
        || pinned.version !== current.version
        || pinned.icu !== current.icu
        || pinned.unicode !== current.unicode) {
        fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
            reason: 'runtime_pin_mismatch',
            pinned: { ...pinned },
            current,
        });
    }
    if (policy.scope != null && policy.scope !== 'published-prose') {
        fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
            reason: 'scope_unsupported',
            scope: policy.scope,
            expected: 'published-prose',
        });
    }
    if (policy.measurementPolicyVersion != null && policy.measurementPolicyVersion !== 1) {
        fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
            reason: 'measurement_policy_version_unsupported',
            measurementPolicyVersion: policy.measurementPolicyVersion,
        });
    }
    if (unit === 'legacyCodeUnits') {
        if (policy.countsWhitespace !== true
            || policy.countsPunctuation !== true
            || policy.countsWordLikeOnly === true
            || policy.segmenterGranularity != null) {
            fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
                reason: 'count_semantics_mismatch',
                unit,
                countsWhitespace: policy.countsWhitespace ?? null,
                countsPunctuation: policy.countsPunctuation ?? null,
                countsWordLikeOnly: policy.countsWordLikeOnly ?? null,
                segmenterGranularity: policy.segmenterGranularity ?? null,
            });
        }
        return;
    }
    if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
        fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
            reason: 'segmenter_unavailable',
            unit,
        });
    }
    const granularity = policy.segmenterGranularity;
    const resolvedLocale = policy.resolvedLocale;
    if (granularity !== (unit === 'words' ? 'word' : 'grapheme') || typeof resolvedLocale !== 'string' || resolvedLocale === '') {
        fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
            reason: 'incomplete_segmenter_pin',
            unit,
            segmenterGranularity: granularity ?? null,
            resolvedLocale: resolvedLocale ?? null,
        });
    }
    let resolvedNow;
    try {
        resolvedNow = new Intl.Segmenter(resolvedLocale, { granularity }).resolvedOptions().locale;
    } catch (err) {
        fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
            reason: 'segmenter_construct_failed',
            unit,
            resolvedLocale,
            message: err instanceof Error ? err.message : String(err),
        });
    }
    if (resolvedNow !== resolvedLocale) {
        fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
            reason: 'resolved_locale_unstable',
            unit,
            pinned: resolvedLocale,
            resolvedNow,
        });
    }
    if (unit === 'graphemes') {
        if (policy.countsWhitespace !== true
            || policy.countsPunctuation !== true
            || policy.countsWordLikeOnly !== false) {
            fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
                reason: 'count_semantics_mismatch',
                unit,
                countsWhitespace: policy.countsWhitespace ?? null,
                countsPunctuation: policy.countsPunctuation ?? null,
                countsWordLikeOnly: policy.countsWordLikeOnly ?? null,
            });
        }
    }
    if (unit === 'words') {
        if (policy.countsWordLikeOnly !== true
            || policy.countsWhitespace === true
            || policy.countsPunctuation === true) {
            fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
                reason: 'count_semantics_mismatch',
                unit,
                countsWhitespace: policy.countsWhitespace ?? null,
                countsPunctuation: policy.countsPunctuation ?? null,
                countsWordLikeOnly: policy.countsWordLikeOnly ?? null,
            });
        }
    }
    if (unit === 'words') {
        const requested = policy.requestedLocale;
        if (typeof requested !== 'string' || requested === '') {
            fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
                reason: 'missing_requested_locale',
                unit,
            });
        }
        const supported = Intl.Segmenter.supportedLocalesOf([requested], { granularity: 'word' });
        if (supported.length === 0) {
            fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
                reason: 'word_segmentation_unsupported',
                unit,
                requestedLocale: requested,
                resolvedLocale,
                supportedLocales: supported,
                guidance: 'graphemes',
            });
        }
        let fromRequested;
        try {
            fromRequested = new Intl.Segmenter(requested, { granularity: 'word' }).resolvedOptions().locale;
        } catch (err) {
            fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
                reason: 'word_segmenter_construct_failed',
                requestedLocale: requested,
                message: err instanceof Error ? err.message : String(err),
            });
        }
        if (fromRequested !== resolvedLocale) {
            fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
                reason: 'word_locale_fallback',
                requestedLocale: requested,
                pinnedResolved: resolvedLocale,
                resolvedNow: fromRequested,
                guidance: 'graphemes',
            });
        }
    }
}

function countGraphemes(text, locale) {
    let n = 0;
    const seg = new Intl.Segmenter(locale, { granularity: 'grapheme' });
    // for-of on the segmenter iterator avoids materialising the whole array.
    for (const _ of seg.segment(text))
        n += 1;
    return n;
}

function countWords(text, locale) {
    let n = 0;
    const seg = new Intl.Segmenter(locale, { granularity: 'word' });
    for (const part of seg.segment(text)) {
        if (part.isWordLike)
            n += 1;
    }
    return n;
}

/**
 * @param {string} text
 * @param {object} policy MeasurementPolicy from resolveMeasurementPolicy
 * @returns {{ unit: string, count: number, measurementPolicyHash: string }}
 */
function countPublished(body, policy) {
    if (policy.unit === 'legacyCodeUnits')
        return body.length;
    if (policy.unit === 'graphemes')
        return countGraphemes(body, policy.resolvedLocale);
    return countWords(body, policy.resolvedLocale);
}

/**
 * @param {string} text
 * @param {object} policy MeasurementPolicy from resolveMeasurementPolicy
 * @returns {{ unit: string, count: number, measurementPolicyHash: string }}
 */
export function countLength(text, policy) {
    assertFaithfulPolicy(policy);
    const body = publishedProse(text);
    return Object.freeze({
        unit: policy.unit,
        count: countPublished(body, policy),
        measurementPolicyHash: computeMeasurementPolicyHash(policy),
    });
}

function prefixUnits(body, policy, budget) {
    if (budget <= 0)
        return '';
    if (policy.unit === 'legacyCodeUnits') {
        let out = '';
        for (const ch of body) {
            if (out.length + ch.length > budget)
                break;
            out += ch;
        }
        return out;
    }
    if (policy.unit === 'graphemes') {
        let out = '';
        let n = 0;
        const seg = new Intl.Segmenter(policy.resolvedLocale, { granularity: 'grapheme' });
        for (const part of seg.segment(body)) {
            if (n + 1 > budget)
                break;
            out += part.segment;
            n += 1;
        }
        return out;
    }
    let out = '';
    const seg = new Intl.Segmenter(policy.resolvedLocale, { granularity: 'word' });
    for (const part of seg.segment(body)) {
        const next = out + part.segment;
        const nextCount = countWords(next, policy.resolvedLocale);
        if (nextCount > budget) {
            if (part.isWordLike)
                break;
            break;
        }
        out = next;
    }
    return out;
}

/**
 * Truncate published prose so countLength(result, policy).count <= maxCount.
 * Never splits graphemes or surrogate pairs; never emits a partial word.
 * Ellipsis is included in the counted total when appended.
 */
export function truncateLength(text, policy, maxCount, { ellipsis = '…' } = {}) {
    assertFaithfulPolicy(policy);
    if (typeof maxCount !== 'number' || !Number.isInteger(maxCount) || maxCount <= 0 || !Number.isFinite(maxCount)) {
        fail(LANGUAGE_ERROR_CODES.INVALID_LENGTH_MEASUREMENT, { reason: 'max_count_not_positive_integer', maxCount });
    }
    const body = publishedProse(text);
    if (countPublished(body, policy) <= maxCount)
        return body;
    const mark = String(ellipsis);
    const markCount = countPublished(publishedProse(mark), policy);
    if (markCount > maxCount) {
        fail(LANGUAGE_ERROR_CODES.UNSUPPORTED_LENGTH_MEASUREMENT, {
            reason: 'ellipsis_exceeds_max_count',
            maxCount,
            ellipsisCount: markCount,
        });
    }
    const prefix = prefixUnits(body, policy, maxCount - markCount);
    return `${prefix}${mark}`;
}
