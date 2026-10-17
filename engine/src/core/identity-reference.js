/** Names are a candidate index, never an identity. Exact IDs take precedence. */
export function createIdentityResolver(records, { idOf = record => record.id, namesOf = record => [record.canonicalName, ...(record.aliases ?? [])], normalize = value => value.normalize('NFC').trim() } = {}) {
    const ids = new Set(), byName = new Map();
    for (const record of records) {
        const id = idOf(record);
        ids.add(id);
        for (const name of namesOf(record)) {
            if (typeof name !== 'string' || !name.trim()) continue;
            const key = normalize(name), candidates = byName.get(key) ?? new Set();
            candidates.add(id);
            byName.set(key, candidates);
        }
    }
    return ref => {
        if (typeof ref !== 'string') return { status: 'unknown', candidateIds: [] };
        if (ids.has(ref)) return { status: 'resolved', id: ref };
        const candidateIds = [...(byName.get(normalize(ref)) ?? [])];
        if (candidateIds.length === 1) return { status: 'resolved', id: candidateIds[0] };
        return { status: candidateIds.length ? 'ambiguous' : 'unknown', candidateIds };
    };
}
export function resolveIdentityReference(ref, records, options) {
    return createIdentityResolver(records, options)(ref);
}
