/**
 * revise — minimum-edit-distance partial rewrite triggered by HARD FAIL on
 * the continuity gate. Owned by T3.4's bounded revise loop in
 * `chapter-write-with-revise.ts`.
 *
 * Contract: legacy engine callers may still request full revised prose. The
 * plugin workflow enables patchMode, where the model returns bounded paragraph
 * replacements/insertions and code reconstructs the full prose. Both modes
 * return the same full-prose + cast-manifest shape to downstream checks.
 *
 */
import { resolveCharacter } from '../../../continuity/foundation.js';
import { languageSystemLines, resolveStepPromptLanguage } from '../../../core/prompt-language.js';
import { buildRevisePatchUserPrompt, buildReviseUserPrompt, reviseSystemFor, } from '../prompts/revise.js';
/**
 * Map a continuity-check violation into the prompt-facing ReviseViolation
 * shape. Severity is preserved verbatim; the prompt-level `ReviseViolation`
 * type only re-narrows to the two cases continuity uses.
 */
function toPromptViolation(v) {
    return {
        severity: v.severity === 'soft' ? 'soft' : 'hard',
        code: String(v.code),
        message: v.message,
        characterId: v.characterId,
        actualChars: Number.isFinite(v.actualChars) ? v.actualChars : undefined,
        minChars: Number.isFinite(v.minChars) ? v.minChars : undefined,
        targetChars: Number.isFinite(v.targetChars) ? v.targetChars : undefined,
        recommendedChars: Number.isFinite(v.recommendedChars) ? v.recommendedChars : undefined,
        // 다국어 Phase 2A — 계약 단위로 계측한 분량(`{unit, actual, min, recommended}`).
        // 검사기가 계약 단위로 재면 이 필드로 오고, 프롬프트는 그 단위로만 말한다.
        // 구형 `*Chars` 는 이름 그대로 legacyCodeUnits 계측값이다.
        lengthMeasurement: v.lengthMeasurement,
        span: v.span,
    };
}

function cleanJson(raw) {
    return String(raw ?? '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function paragraphsOf(prose) {
    return String(prose ?? '').replace(/\r\n/g, '\n').trim().split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

export function revisionOperationLimit(violations = []) {
    if (violations.some((violation) => violation.code === 'QUALITY_GATE_LENGTH')) return 12;
    if (violations.some((violation) => String(violation.code ?? '').startsWith('WEBNOVEL_'))) return 12;
    if (violations.some((violation) => violation.code === 'USER_REVISION_REQUEST')) return 12;
    return Math.min(8, Math.max(3, violations.length * 2));
}

export function applyRevisionPatch({ originalProse, patchRaw, castManifestRaw = '{"cast":[]}', maxOperations = 8 }) {
    let patch;
    try {
        patch = JSON.parse(cleanJson(patchRaw));
    }
    catch {
        throw new Error('REVISION_PATCH_INVALID_JSON: 수정 모델은 전체 원고가 아니라 JSON 패치를 반환해야 합니다.');
    }
    const replacements = Array.isArray(patch?.replacements) ? patch.replacements : [];
    const insertions = Array.isArray(patch?.insertions) ? patch.insertions : [];
    if (replacements.length + insertions.length > maxOperations) {
        throw new Error(`REVISION_PATCH_TOO_BROAD: 수정 작업 ${replacements.length + insertions.length}개가 허용 한도 ${maxOperations}개를 넘었습니다.`);
    }
    const paragraphs = paragraphsOf(originalProse);
    const replacementMap = new Map();
    for (const item of replacements) {
        const paragraph = Number(item?.paragraph);
        if (!Number.isInteger(paragraph) || paragraph < 1 || paragraph > paragraphs.length || replacementMap.has(paragraph) || typeof item?.text !== 'string') {
            throw new Error('REVISION_PATCH_INVALID_TARGET: replacement 문단 번호나 본문이 유효하지 않습니다.');
        }
        replacementMap.set(paragraph, item.text.trim());
    }
    const insertionMap = new Map();
    for (const item of insertions) {
        const afterParagraph = Number(item?.afterParagraph);
        if (!Number.isInteger(afterParagraph) || afterParagraph < 0 || afterParagraph > paragraphs.length || insertionMap.has(afterParagraph) || typeof item?.text !== 'string' || !item.text.trim()) {
            throw new Error('REVISION_PATCH_INVALID_TARGET: insertion 위치나 본문이 유효하지 않습니다.');
        }
        insertionMap.set(afterParagraph, item.text.trim());
    }
    const output = [];
    if (insertionMap.has(0)) output.push(insertionMap.get(0));
    for (let index = 0; index < paragraphs.length; index += 1) {
        const paragraphNumber = index + 1;
        const replacement = replacementMap.get(paragraphNumber);
        if (replacement !== '') output.push(replacement ?? paragraphs[index]);
        if (insertionMap.has(paragraphNumber)) output.push(insertionMap.get(paragraphNumber));
    }
    const manifest = patch?.castManifest && typeof patch.castManifest === 'object'
        ? JSON.stringify(patch.castManifest)
        : String(castManifestRaw || '{"cast":[]}').trim();
    if (output.some((paragraph) => paragraph.includes('⟦vle:'))) {
        throw new Error('REVISION_PATCH_SENTINEL_LEAK: 수정 문단 안에 내부 sentinel을 넣을 수 없습니다.');
    }
    return `${output.join('\n\n').trim()}\n\n⟦vle:cast-manifest ${manifest}⟧`;
}
/**
 * Build the compact Foundation slice the prompt needs. Includes only the
 * characters explicitly referenced by violations (avoids ballooning context on
 * a large cast). If no violation names a character, falls back to all
 * registered characters at this chapter — the model still needs *some*
 * canonical reference to anchor revisions.
 */
function buildFoundationContext(foundation, chapterNumber, violations) {
    const referencedCharacterIds = new Set();
    for (const v of violations) {
        if (v.characterId)
            referencedCharacterIds.add(v.characterId);
    }
    const characterIds = referencedCharacterIds.size > 0
        ? Array.from(referencedCharacterIds)
        : foundation.characters
            .filter((c) => c.registeredAtChapter <= chapterNumber)
            .map((c) => c.id);
    const characters = characterIds
        .map((id) => {
        try {
            const c = resolveCharacter(foundation, chapterNumber, id);
            return {
                id: c.id,
                canonicalName: c.canonicalName,
                aliases: [...c.aliases],
                intrinsic: {
                    gender: c.intrinsic.gender,
                    ageBand: c.intrinsic.ageBand,
                    role: c.intrinsic.role,
                    coreAppearance: [...c.intrinsic.coreAppearance],
                },
            };
        }
        catch {
            const raw = foundation.characters.find((c) => c.id === id);
            if (!raw)
                return null;
            return {
                id: raw.id,
                canonicalName: raw.canonicalName,
                aliases: [...raw.aliases],
                intrinsic: {
                    gender: raw.intrinsic.gender,
                    ageBand: raw.intrinsic.ageBand,
                    role: raw.intrinsic.role,
                    coreAppearance: [...raw.intrinsic.coreAppearance],
                },
            };
        }
    })
        .filter((x) => x !== null);
    // Invariants referenced by INVARIANT_VIOLATION codes; if none, surface the
    // genre profile's hard invariants so the reviser still has the canonical
    // rule set in front of it.
    const referencedInvariantIds = new Set();
    for (const v of violations) {
        // ContinuityViolation does not carry invariantId today; defer if added later.
        const anyV = v;
        if (anyV.invariantId)
            referencedInvariantIds.add(anyV.invariantId);
    }
    const invariantPool = foundation.genreProfile.invariants;
    const invariants = referencedInvariantIds.size > 0
        ? invariantPool
            .filter((inv) => referencedInvariantIds.has(inv.id))
            .map((inv) => ({
            id: inv.id,
            description: inv.description,
            severity: inv.severity,
        }))
        : invariantPool
            .filter((inv) => inv.severity === 'hard')
            .map((inv) => ({
            id: inv.id,
            description: inv.description,
            severity: inv.severity,
        }));
    return { characters, invariants };
}
/**
 * Run one revise LLM call. Returns full chapter prose with a trailing manifest;
 * in patchMode untouched paragraphs never pass through model generation.
 */
export async function runRevise(input) {
    if (input.violations.length === 0) {
        // Defensive: caller should not invoke revise without violations, but we
        // tolerate it by returning the prose unchanged.
        return { revisedProse: input.prose };
    }
    // 다국어 Phase 2A — system 과 user 가 같은 계약을 보도록 한 번만 해석한다.
    // 계약도 언어도 없으면 구형 ko 해석이라 프롬프트가 기존과 동일하다.
    const promptLanguage = resolveStepPromptLanguage(input);
    const promptInput = {
        chapterNumber: input.chapterNumber,
        promptLanguage,
        originalProse: input.prose,
        violations: input.violations.map(toPromptViolation),
        foundationContext: buildFoundationContext(input.foundation, input.chapterNumber, input.violations),
        styleContext: input.styleContext,
        castManifestRaw: input.castManifestRaw,
        maxOperations: revisionOperationLimit(input.violations),
    };
    const patchMode = input.patchMode === true;
    const userPrompt = patchMode ? buildRevisePatchUserPrompt(promptInput) : buildReviseUserPrompt(promptInput);
    const response = await input.providers.complete({
        model: input.model,
        ...(patchMode ? { jsonMode: true } : {}),
        step: 'revise',
        messages: [
            {
                role: 'system',
                content: [
                    reviseSystemFor(promptLanguage, {
                        // 승인된 포맷 정책(대사·문단 모드). 계약에 고정돼 있으면 계약이
                        // 이기고, 어긋난 값을 함께 넘기면 조용히 덮지 않고 오류다.
                        dialogueBreakMode: input.dialogueBreakMode ?? null,
                        patchMode,
                    }),
                    // 이 단계의 분량 기준은 위반이 지시한 **수정 목표**다. 회차 분량
                    // 목표 줄은 빼고 user 프롬프트의 분량 수정 계약만 말한다.
                    ...languageSystemLines(promptLanguage, { includeChapterLength: false }),
                ].join(' '),
            },
            { role: 'user', content: userPrompt },
        ],
    });
    if ((input.providers.pending?.length ?? 0) > 0) {
        return { revisedProse: input.prose };
    }
    return {
        revisedProse: patchMode
            ? applyRevisionPatch({ originalProse: input.prose, patchRaw: response.text, castManifestRaw: input.castManifestRaw, maxOperations: promptInput.maxOperations })
            : response.text,
    };
}
