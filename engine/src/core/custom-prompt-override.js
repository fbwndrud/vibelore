/**
 * Validate and render the supported per-work prompt overrides.
 *
 * Only the documented slots are accepted. Unknown keys are ignored and field
 * lengths are bounded before producing a deterministic instruction block.
 */
/** Defensive length caps — mirror the host Zod schema (plan §11.3). */
const SLOT_CAPS = {
    genrePolicy: 500,
    toneGuideline: 500,
    freeNotes: 1000,
};
/** Human-readable label per preset, injected so the LLM has concrete guidance. */
const WORLD_STYLE_LABEL_KO = {
    modern: '현대 배경. 동시대 감각의 어휘와 디테일.',
    'classic-fantasy': '고전 판타지 배경. 검과 마법, 중세풍 분위기.',
    'sci-fi': 'SF 배경. 미래/과학 기술 기반 세계관.',
    romance: '로맨스 중심. 인물 간 감정선과 관계 묘사에 무게.',
    horror: '호러/공포 분위기. 긴장감과 불안의 결을 유지.',
};
const VALID_PRESETS = new Set(Object.keys(WORLD_STYLE_LABEL_KO));
/**
 * Coerce an arbitrary JSON value (the persisted `Work.customPrompt`) into a
 * sanitized `CustomPromptOverride`. Unknown keys dropped, strings trimmed +
 * length-clamped, invalid preset dropped. Returns `undefined` when nothing
 * usable remains — callers can then skip the override block entirely so the
 * legacy / no-custom prompt stays byte-identical.
 */
export function normalizeCustomPromptOverride(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    const src = raw;
    const out = {};
    const clampString = (value, cap) => {
        if (typeof value !== 'string')
            return undefined;
        const trimmed = value.trim();
        if (trimmed.length === 0)
            return undefined;
        return trimmed.slice(0, cap);
    };
    const genrePolicy = clampString(src.genrePolicy, SLOT_CAPS.genrePolicy);
    if (genrePolicy)
        out.genrePolicy = genrePolicy;
    const toneGuideline = clampString(src.toneGuideline, SLOT_CAPS.toneGuideline);
    if (toneGuideline)
        out.toneGuideline = toneGuideline;
    const freeNotes = clampString(src.freeNotes, SLOT_CAPS.freeNotes);
    if (freeNotes)
        out.freeNotes = freeNotes;
    if (typeof src.worldStylePreset === 'string' && VALID_PRESETS.has(src.worldStylePreset)) {
        out.worldStylePreset = src.worldStylePreset;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
/**
 * Render the override into a deterministic Korean instruction block that is
 * appended to the draft system prompt. Returns empty string when the override
 * has no usable slots — the draft builder then drops the section so prompt
 * stability for non-custom works is preserved.
 *
 * The block is framed as *author directives layered on top of* the system
 * rules. It deliberately does NOT grant the override authority to relax the
 * engine's structural rules (sentinel format, continuity), only to steer
 * genre/tone/world/notes — consistent with the whitelist's intent.
 */
export function renderCustomPromptOverride(override) {
    if (!override)
        return '';
    const lines = [];
    if (override.genrePolicy) {
        lines.push(`- 장르/콘텐츠 정책: ${override.genrePolicy}`);
    }
    if (override.toneGuideline) {
        lines.push(`- 톤/문체 가이드: ${override.toneGuideline}`);
    }
    if (override.worldStylePreset) {
        lines.push(`- 세계관 스타일: ${WORLD_STYLE_LABEL_KO[override.worldStylePreset]}`);
    }
    if (override.freeNotes) {
        lines.push(`- 작가 메모: ${override.freeNotes}`);
    }
    if (lines.length === 0)
        return '';
    return [
        '## 작가 커스텀 지침 (작품 단위)',
        '아래 지침은 작가가 이 작품에 지정한 방향이다. 위의 본문 작성 규칙(구조/sentinel/연속성)을 위반하지 않는 범위에서 우선 반영한다.',
        ...lines,
    ].join('\n');
}
