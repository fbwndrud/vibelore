/**
 * HonorificLexicon — engine-shared knowledge resource backing the layer-1
 * deterministic continuity gate (`lexicon-scan.ts`).
 *
 * Korean honorific / address-term semantics encoded as lexical facts. A term
 * may carry:
 *   - `genderImplication` — the target's gender ('도련님' → male, '아가씨' → female)
 *   - `speakerGenderImplication` — the speaker's gender ('오라버니' = female speaker)
 *   - `statusImplication` — status/rank ('각하', '전하', '소저')
 *   - `registers[]` — settings the term belongs to (가문, 궁중, 무협, 현대) — used
 *     by some genre profiles to whitelist context-specific terms.
 *
 * Self-growing cache: when layer-2 LLM (T2.7) classifies a previously
 * unknown term, it appends with `confidence: 'llm-inferred'`. Next chapter
 * the term is on the deterministic fast-path.
 */
export class DefaultHonorificLexicon {
    entries;
    constructor(seed) {
        this.entries = new Map();
        const source = seed ?? KO_HONORIFIC_SEED;
        for (const entry of source) {
            this.entries.set(entry.term, entry);
        }
    }
    lookup(term) {
        return this.entries.get(term);
    }
    append(entry) {
        // last-write-wins on `term` — upsert semantics so layer-2 LLM (T2.7)
        // can refine an existing entry's implications without dedupe logic.
        this.entries.set(entry.term, entry);
    }
    all() {
        return Array.from(this.entries.values());
    }
}
/**
 * Korean honorific seed. Web-novel-canonical terms covering the four registers
 * that drive layer-1 gender/status conflict detection:
 *   가문 (도련님/아가씨/영애/주군) · 가족 (오라버니/언니/형/누님) ·
 *   궁중 (전하/폐하/마마/각하) · 무협 (소저/대협/사부/사형/사매) ·
 *   대명사 (그/그녀).
 * ko-native, no zh remnants.
 */
export const KO_HONORIFIC_SEED = [
    // Family / 가문 (상류귀족 register)
    {
        term: '도련님',
        genderImplication: 'male',
        statusImplication: '상류귀족',
        registers: ['가문', '귀족'],
        confidence: 'lexicon',
    },
    {
        term: '아가씨',
        genderImplication: 'female',
        statusImplication: '상류귀족',
        registers: ['가문', '귀족'],
        confidence: 'lexicon',
    },
    {
        term: '영애',
        genderImplication: 'female',
        statusImplication: '상류귀족',
        registers: ['가문', '귀족'],
        confidence: 'lexicon',
    },
    {
        term: '도련',
        genderImplication: 'male',
        registers: ['가문'],
        confidence: 'lexicon',
    },
    // Family kin terms (speaker-implicit)
    {
        term: '오라버니',
        genderImplication: 'male',
        speakerGenderImplication: 'female',
        registers: ['가족', '존중'],
        confidence: 'lexicon',
    },
    {
        term: '오빠',
        genderImplication: 'male',
        speakerGenderImplication: 'female',
        registers: ['가족'],
        confidence: 'lexicon',
    },
    {
        term: '언니',
        genderImplication: 'female',
        speakerGenderImplication: 'female',
        registers: ['가족'],
        confidence: 'lexicon',
    },
    {
        term: '누님',
        genderImplication: 'female',
        speakerGenderImplication: 'male',
        registers: ['가족', '존중'],
        confidence: 'lexicon',
    },
    {
        term: '누나',
        genderImplication: 'female',
        speakerGenderImplication: 'male',
        registers: ['가족'],
        confidence: 'lexicon',
    },
    {
        term: '형',
        genderImplication: 'male',
        speakerGenderImplication: 'male',
        registers: ['가족'],
        confidence: 'lexicon',
    },
    {
        term: '형님',
        genderImplication: 'male',
        speakerGenderImplication: 'male',
        registers: ['가족', '존중'],
        confidence: 'lexicon',
    },
    // Royalty / court (궁중 register)
    {
        term: '전하',
        statusImplication: '왕족',
        registers: ['궁중'],
        confidence: 'lexicon',
    },
    {
        term: '폐하',
        statusImplication: '황제급',
        registers: ['궁중'],
        confidence: 'lexicon',
    },
    {
        term: '마마',
        genderImplication: 'female',
        statusImplication: '왕족여성',
        registers: ['궁중'],
        confidence: 'lexicon',
    },
    {
        term: '각하',
        statusImplication: '귀족고위',
        registers: ['궁중', '관청'],
        confidence: 'lexicon',
    },
    // Wuxia / martial (무협 register)
    {
        term: '소저',
        genderImplication: 'female',
        statusImplication: '무림여성',
        registers: ['무협'],
        confidence: 'lexicon',
    },
    {
        term: '대협',
        genderImplication: 'male',
        statusImplication: '무림고수',
        registers: ['무협'],
        confidence: 'lexicon',
    },
    {
        term: '노협',
        genderImplication: 'male',
        registers: ['무협'],
        confidence: 'lexicon',
    },
    {
        term: '사부',
        statusImplication: '스승',
        registers: ['무협', '수련'],
        confidence: 'lexicon',
    },
    {
        term: '사형',
        genderImplication: 'male',
        registers: ['무협', '수련'],
        confidence: 'lexicon',
    },
    {
        term: '사매',
        genderImplication: 'female',
        registers: ['무협', '수련'],
        confidence: 'lexicon',
    },
    // Authority / 주군
    {
        term: '주군',
        genderImplication: 'male',
        statusImplication: '주군',
        registers: ['가문', '복종'],
        confidence: 'lexicon',
    },
    // Pronouns (gender markers)
    {
        term: '그',
        genderImplication: 'male',
        registers: ['대명사'],
        confidence: 'lexicon',
    },
    {
        term: '그녀',
        genderImplication: 'female',
        registers: ['대명사'],
        confidence: 'lexicon',
    },
];
