/**
 * Story ledger — what the story keeps track of, as records with a stable id,
 * aliases, a status and the latest events, plus hooks in the same shape.
 *
 * Behaviour depends on the feature (objects, knowledge, scheduled, hooks),
 * never on the genre. Labels such as "item" or "clue" are free text the
 * extractor writes. The chapter deltas stay the source of truth: StoryState
 * keeps current values and the last RECENT_EVENTS events, and the full
 * history is rebuilt from the deltas.
 */

export const LEDGER_FEATURES = Object.freeze(['objects', 'knowledge', 'scheduled']);
export const TRACKING_FEATURES = Object.freeze([...LEDGER_FEATURES, 'hooks']);
export const RECORD_STATUSES = Object.freeze({
    objects: Object.freeze(['active', 'lost', 'destroyed', 'retired']),
    knowledge: Object.freeze(['secret', 'partial', 'public', 'retired']),
    scheduled: Object.freeze(['pending', 'prevented', 'happened', 'altered', 'retired']),
});
export const INITIAL_STATUS = Object.freeze({ objects: 'active', knowledge: 'secret', scheduled: 'pending' });
export const HOOK_STATUSES = Object.freeze(['open', 'dormant', 'paid', 'closed']);
export const RECORD_EVENTS = Object.freeze(['registered', 'mentioned', 'changed', 'status', 'restored', 'alias', 'merged']);
export const HOOK_EVENTS = Object.freeze(['planted', 'mentioned', 'advanced', 'paid', 'reopened', 'parked', 'closed']);
export const RECENT_EVENTS = 3;
const ID_PREFIX = Object.freeze({ objects: 'o', knowledge: 'k', scheduled: 's', hooks: 'h' });
// Legacy vocabulary: phases of 0.3.x hooks and the statuses before them.
const LEGACY_HOOK_STATUS = Object.freeze({
    planted: 'open', advancing: 'open', open: 'open', progressing: 'open',
    paid: 'paid', resolved: 'paid', parked: 'dormant', deferred: 'dormant',
});
const LEGACY_KNOWLEDGE_KINDS = new Set(['KnowledgeMatrix', 'RegressionKnowledge']);
// Kinds that were used as a per-chapter event list; the event log replaces them.
const LEGACY_LOG_KINDS = new Set(['Timeline']);
const LEGACY_NAME_FIELDS = ['name', 'item', 'ability', 'title', 'subject', 'fact', 'clue', 'event', 'key', 'id', 'label', 'canonicalName'];
const PARTICLES = ['에게서', '에서는', '으로는', '에서', '에게', '한테', '으로', '까지', '부터', '처럼', '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '로', '만'];
const QUOTES = /["'“”‘’「」『』《》〈〉()[\]{}]/g;

export function emptyLedger() {
    return { records: [] };
}
/** The comparable form of a name: NFC, lower case, no quotes, single spaces, no trailing Korean particle. */
export function ledgerNameKey(value) {
    let text = String(value ?? '').normalize('NFC').toLocaleLowerCase().replace(QUOTES, '').replace(/\s+/g, ' ').trim();
    if (/^[가-힣 ]+$/.test(text)) {
        const particle = PARTICLES.find((item) => text.endsWith(item) && [...text].length - [...item].length >= 2);
        if (particle)
            text = text.slice(0, -particle.length).trim();
    }
    return text;
}
export function recordNames(record) {
    return [record?.name, ...(record?.aliases ?? []).map((alias) => alias?.text)].filter((name) => typeof name === 'string' && name.trim());
}
/** A record by id, by an id merged into it, or by name or alias (normalized). */
export function findRecord(ledger, ref, feature = null) {
    if (typeof ref !== 'string' || !ref.trim())
        return null;
    const records = (ledger?.records ?? []).filter((record) => !feature || record.feature === feature);
    const byId = records.find((record) => record.id === ref || (record.mergedIds ?? []).includes(ref));
    if (byId)
        return byId;
    const key = ledgerNameKey(ref);
    if (!key)
        return null;
    return records.find((record) => recordNames(record).some((name) => ledgerNameKey(name) === key)) ?? null;
}
function words(key) {
    return key.split(' ').filter((word) => [...word].length >= 2);
}
/**
 * A record whose name contains, or is contained in, this name, or shares at
 * least half of the longer name's words. Only a candidate for the user.
 */
export function similarRecord(ledger, feature, name) {
    const key = ledgerNameKey(name);
    if ([...key].length < 2)
        return null;
    const mine = new Set(words(key));
    return (ledger?.records ?? []).find((record) => record.feature === feature && recordNames(record).some((other) => {
        const theirs = ledgerNameKey(other);
        if ([...theirs].length < 2)
            return false;
        if (theirs.includes(key) || key.includes(theirs))
            return true;
        const list = words(theirs);
        const shared = list.filter((word) => mine.has(word)).length;
        return shared > 0 && shared * 2 >= Math.max(mine.size, list.length);
    })) ?? null;
}
export function nextLedgerId(state, feature) {
    const prefix = ID_PREFIX[feature];
    const ids = feature === 'hooks'
        ? (state?.hooks ?? []).map((hook) => hook.id)
        : (state?.ledger?.records ?? []).flatMap((record) => [record.id, ...(record.mergedIds ?? [])]);
    const pattern = new RegExp(`^${prefix}(\\d+)$`);
    const max = ids.reduce((top, id) => Math.max(top, Number(pattern.exec(String(id))?.[1] ?? 0)), 0);
    return `${prefix}${max + 1}`;
}
export function hookStatusOf(raw) {
    if (HOOK_STATUSES.includes(raw?.status) && !LEGACY_HOOK_STATUS[raw.status])
        return raw.status;
    return LEGACY_HOOK_STATUS[raw?.phase] ?? LEGACY_HOOK_STATUS[raw?.status] ?? 'open';
}
function legacyName(data) {
    for (const field of LEGACY_NAME_FIELDS) {
        if (typeof data?.[field] === 'string' && data[field].trim())
            return data[field].trim();
    }
    if (typeof data?.from === 'string' && typeof data?.to === 'string')
        return `${data.from}→${data.to}`;
    return '';
}
function legacyEntityStatus(status) {
    return RECORD_STATUSES.objects.includes(status) ? status : 'active';
}
/**
 * Records for a state written before the ledger: entity snapshots first (their
 * ids are kept), then tracked entities that name something new. Tracked
 * entities that repeat an entity's name update its fields. Timeline records
 * were per-chapter event lists and are not records.
 */
export function ledgerFromLegacy({ trackedEntities = [], entities = [] } = {}) {
    const state = { ledger: emptyLedger(), hooks: [] };
    for (const entity of entities ?? []) {
        if (!entity?.entityId || !entity.canonicalName)
            continue;
        state.ledger.records.push({
            id: entity.entityId, feature: 'objects', label: entity.kind ?? '', name: entity.canonicalName,
            aliases: (entity.aliases ?? []).filter(Boolean).map((text) => ({ text })),
            status: legacyEntityStatus(entity.status), fields: { ...(entity.attrs ?? {}) },
            registeredAt: entity.registeredAtChapter ?? 0, lastEventAt: entity.updatedAtChapter ?? entity.registeredAtChapter ?? 0, recent: [],
        });
    }
    for (const tracked of trackedEntities ?? []) {
        if (!tracked?.kind || LEGACY_LOG_KINDS.has(tracked.kind))
            continue;
        const feature = LEGACY_KNOWLEDGE_KINDS.has(tracked.kind) ? 'knowledge' : 'objects';
        const name = legacyName(tracked.data);
        if (!name)
            continue;
        const { name: _name, ...fields } = tracked.data ?? {};
        const existing = findRecord(state.ledger, name, feature);
        if (existing) {
            existing.fields = { ...existing.fields, ...fields };
            existing.lastEventAt = Math.max(existing.lastEventAt ?? 0, tracked.updatedChapter ?? 0);
            continue;
        }
        state.ledger.records.push({
            id: nextLedgerId(state, feature), feature, label: tracked.kind, name, aliases: [],
            status: INITIAL_STATUS[feature], fields,
            registeredAt: tracked.updatedChapter ?? 0, lastEventAt: tracked.updatedChapter ?? 0, recent: [],
        });
    }
    return state.ledger;
}
