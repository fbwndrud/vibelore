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
import { termOccursInText } from '../core/mention-scan.js';

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

export function trackingEnabled(config, feature) {
    return config?.tracking?.[feature] !== false;
}
function customItem(config, ref) {
    return (config?.customTracking ?? []).find((item) => item.id === ref || ledgerNameKey(item.name) === ledgerNameKey(ref)) ?? null;
}
function clone(state) {
    return {
        ledger: { records: (state?.ledger?.records ?? []).map((record) => ({ ...record, aliases: [...(record.aliases ?? [])], fields: { ...(record.fields ?? {}) }, recent: [...(record.recent ?? [])] })) },
        hooks: (state?.hooks ?? []).map((hook) => ({ ...hook, recent: [...(hook.recent ?? [])] })),
    };
}
function remember(target, event, chapter) {
    const { target: _target, id: _id, ...kept } = event;
    target.recent = [...(target.recent ?? []), kept].slice(-RECENT_EVENTS);
    target.lastEventAt = chapter;
}
function aliasOf(value, chapter) {
    if (typeof value === 'string')
        return value.trim() ? { text: value.trim() } : null;
    if (typeof value?.text !== 'string' || !value.text.trim())
        return null;
    return { text: value.text.trim(), ...(typeof value.by === 'string' && value.by ? { by: value.by, since: value.since ?? chapter } : {}) };
}
function firstNumber(value) {
    const match = /-?\d+(?:\.\d+)?/.exec(String(value ?? '').replace(/,/g, ''));
    return match ? Number(match[0]) : null;
}
function ruleFindings(record, before, event, config) {
    const item = customItem(config, record.id);
    const findings = [];
    for (const rule of item?.rules ?? []) {
        const severity = rule.severity === 'hard' ? 'hard' : 'soft';
        if (rule.type === 'monotonic' && event.set && rule.field in event.set) {
            const prior = firstNumber(before.fields?.[rule.field]);
            const next = firstNumber(event.set[rule.field]);
            const excused = rule.unless && String(event.note ?? '').includes(rule.unless);
            const wrong = prior !== null && next !== null && (rule.direction === 'down' ? next > prior : next < prior);
            if (wrong && !excused)
                findings.push({ severity, code: 'CUSTOM_RULE_MONOTONIC', ledgerId: record.id, message: `${item.name}: ${rule.field} ${prior} → ${next} (${rule.direction})` });
        }
        if (rule.type === 'frozenAfter' && before.status === rule.status && (event.event === 'changed' || event.event === 'status'))
            findings.push({ severity, code: 'CUSTOM_RULE_FROZEN', ledgerId: record.id, message: `${item.name}: ${rule.status} 이후 변경` });
    }
    return findings;
}
/**
 * Apply one chapter's ledger ops. Pure: returns new containers, the event
 * lines for the history log and the findings. Ops of a feature the user turned
 * off are ignored without a finding.
 */
export function applyLedgerOps(state, ops, { chapter, config = {} } = {}) {
    const next = clone(state);
    const events = [];
    const violations = [];
    const emit = (target, holder, event) => {
        const line = { chapter, target, id: holder.id, ...event };
        events.push(line);
        remember(holder, line, chapter);
    };
    for (const op of ops ?? []) {
        if (op?.op === 'register') {
            if (!LEDGER_FEATURES.includes(op.feature) || !trackingEnabled(config, op.feature) || typeof op.name !== 'string' || !op.name.trim())
                continue;
            const existing = findRecord(next.ledger, op.name, op.feature);
            if (existing) {
                const set = op.fields && Object.keys(op.fields).length ? { ...op.fields } : null;
                if (set)
                    existing.fields = { ...existing.fields, ...set };
                emit('record', existing, { event: set ? 'changed' : 'mentioned', ...(op.note ? { note: op.note } : {}), ...(set ? { set } : {}) });
                continue;
            }
            const similar = similarRecord(next.ledger, op.feature, op.name);
            const custom = customItem(config, op.name);
            const record = {
                id: custom?.id ?? nextLedgerId(next, op.feature), feature: op.feature, label: String(op.label ?? ''), name: op.name.trim(),
                aliases: (op.aliases ?? []).map((alias) => aliasOf(alias, chapter)).filter(Boolean),
                status: INITIAL_STATUS[op.feature], fields: { ...(op.fields ?? {}) }, registeredAt: chapter, recent: [],
                ...(similar ? { possibleDuplicateOf: similar.id } : {}),
            };
            next.ledger.records.push(record);
            emit('record', record, { event: 'registered', ...(op.note ? { note: op.note } : {}), ...(Object.keys(record.fields).length ? { set: { ...record.fields } } : {}) });
            if (similar)
                violations.push({ severity: 'soft', code: 'LEDGER_POSSIBLE_DUPLICATE', ledgerId: record.id, duplicateOf: similar.id, message: `"${record.name}" may be "${similar.name}" (${similar.id})` });
            continue;
        }
        if (op?.op === 'event' || op?.op === 'alias') {
            let record = findRecord(next.ledger, op.id);
            const custom = !record ? customItem(config, op.id) : null;
            if (!record && custom && trackingEnabled(config, custom.feature)) {
                record = { id: custom.id, feature: custom.feature, label: '', name: custom.name, aliases: [], status: INITIAL_STATUS[custom.feature], fields: {}, registeredAt: chapter, recent: [] };
                next.ledger.records.push(record);
            }
            if (!record) {
                violations.push({ severity: 'soft', code: 'LEDGER_UNKNOWN_ID', ledgerId: op.id, message: `unknown ledger id "${op.id}"` });
                continue;
            }
            if (!trackingEnabled(config, record.feature))
                continue;
            if (op.op === 'alias') {
                const alias = aliasOf({ text: op.alias, by: op.by }, chapter);
                if (alias && !recordNames(record).some((name) => ledgerNameKey(name) === ledgerNameKey(alias.text))) {
                    record.aliases.push(alias);
                    emit('record', record, { event: 'alias', alias: alias.text, ...(alias.by ? { by: alias.by } : {}) });
                }
                continue;
            }
            const before = { status: record.status, fields: { ...record.fields } };
            const note = op.note ? { note: op.note } : {};
            if (op.event === 'restored') {
                if (!['destroyed', 'lost', 'retired'].includes(record.status))
                    continue;
                if (!op.note) {
                    violations.push({ severity: 'hard', code: 'LEDGER_RESTORE_NOTE_REQUIRED', ledgerId: record.id, message: `"${record.name}" was ${record.status}; restoring it needs a reason` });
                    continue;
                }
                record.status = INITIAL_STATUS[record.feature];
                emit('record', record, { event: 'restored', ...note, status: record.status });
                continue;
            }
            if (record.status === 'destroyed' && (op.event === 'changed' || op.event === 'status')) {
                violations.push({ severity: 'hard', code: 'LEDGER_UPDATE_AFTER_DESTROY', ledgerId: record.id, message: `update attempted on destroyed "${record.name}" (${record.id})` });
                continue;
            }
            if (op.event === 'status') {
                if (!RECORD_STATUSES[record.feature].includes(op.status)) {
                    violations.push({ severity: 'soft', code: 'LEDGER_INVALID_STATUS', ledgerId: record.id, message: `"${op.status}" is not a ${record.feature} status` });
                    continue;
                }
                if (record.feature === 'scheduled' && op.status === 'pending' && ['happened', 'prevented'].includes(record.status))
                    violations.push({ severity: 'soft', code: 'LEDGER_SCHEDULED_REOPENED', ledgerId: record.id, message: `"${record.name}" was ${record.status} and is pending again` });
                violations.push(...ruleFindings(record, before, op, config));
                record.status = op.status;
                emit('record', record, { event: 'status', ...note, status: op.status });
                continue;
            }
            if (op.event === 'changed' && op.set && Object.keys(op.set).length) {
                violations.push(...ruleFindings(record, before, op, config));
                record.fields = { ...record.fields, ...op.set };
                emit('record', record, { event: 'changed', ...note, set: { ...op.set } });
                continue;
            }
            emit('record', record, { event: 'mentioned', ...note });
            continue;
        }
        if (op?.op === 'plant') {
            if (!trackingEnabled(config, 'hooks') || typeof op.text !== 'string' || !op.text.trim())
                continue;
            const hook = { id: nextLedgerId(next, 'hooks'), text: op.text.trim(), status: 'open', ...(op.horizon ? { horizon: op.horizon } : {}), plantedAtChapter: chapter, lastMovedChapter: chapter, recent: [] };
            next.hooks.push(hook);
            emit('hook', hook, { event: 'planted', ...(op.note ? { note: op.note } : {}) });
            hook.lastMovedChapter = chapter;
            continue;
        }
        if (op?.op === 'hook') {
            if (!trackingEnabled(config, 'hooks'))
                continue;
            const hook = next.hooks.find((item) => item.id === op.id);
            if (!hook || !HOOK_EVENTS.includes(op.event) || op.event === 'planted') {
                violations.push({ severity: 'soft', code: 'LEDGER_UNKNOWN_ID', ledgerId: op.id, message: `unknown hook "${op.id}" or event "${op.event}"` });
                continue;
            }
            const note = op.note ? { note: op.note } : {};
            if (hook.status === 'closed' && op.event !== 'reopened') {
                violations.push({ severity: 'soft', code: 'LEDGER_CLOSED_HOOK_EVENT', ledgerId: hook.id, message: `closed hook "${hook.id}" used again` });
                emit('hook', hook, { event: 'mentioned', ...note });
                continue;
            }
            const status = { advanced: 'open', reopened: 'open', paid: 'paid', parked: 'dormant', closed: 'closed' }[op.event];
            if (status)
                hook.status = status;
            emit('hook', hook, { event: op.event, ...note, ...(op.evidence ? { evidence: op.evidence } : {}) });
            hook.lastMovedChapter = chapter;
        }
    }
    return { ledger: next.ledger, hooks: next.hooks, events, violations };
}
/** Fold approved merges ({from, into}) whose source still exists. Idempotent. */
export function applyMerges(ledger, merges, chapter) {
    const records = (ledger?.records ?? []).map((record) => ({ ...record }));
    const events = [];
    for (const merge of merges ?? []) {
        const fromIndex = records.findIndex((record) => record.id === merge.from);
        const into = records.find((record) => record.id === merge.into);
        if (fromIndex < 0 || !into || merge.from === merge.into)
            continue;
        const from = records[fromIndex];
        const known = new Set(recordNames(into).map(ledgerNameKey));
        const aliases = [...(into.aliases ?? [])];
        for (const alias of [{ text: from.name }, ...(from.aliases ?? [])]) {
            if (alias?.text && !known.has(ledgerNameKey(alias.text))) {
                aliases.push(alias.by ? alias : { text: alias.text });
                known.add(ledgerNameKey(alias.text));
            }
        }
        const merged = { ...into, aliases, fields: { ...(from.fields ?? {}), ...(into.fields ?? {}) }, mergedIds: [...(into.mergedIds ?? []), from.id, ...(from.mergedIds ?? [])] };
        delete merged.possibleDuplicateOf;
        records[records.indexOf(into)] = merged;
        records.splice(fromIndex, 1);
        events.push({ chapter, target: 'record', id: from.id, event: 'merged', into: into.id });
    }
    return { ledger: { records }, events };
}

const squash = (text) => String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
/**
 * Check ops against the chapter text before they are stored: a paid hook must
 * quote the prose (otherwise it is stored as advanced), a changed or mentioned
 * record should be named, a speaker-only alias needs its speaker on the page,
 * and a destroyed record named again is reported (it may be a memory).
 */
export function reviewLedgerOps({ state, ops = [], prose = '', cast = [], config = {} } = {}) {
    const violations = [];
    const text = squash(prose);
    const reviewed = (ops ?? []).map((op) => {
        if (op?.op === 'hook' && op.event === 'paid') {
            const evidence = squash(op.evidence);
            if (!evidence || !text.includes(evidence)) {
                violations.push({ severity: 'soft', code: 'HOOK_PAID_WITHOUT_EVIDENCE', ledgerId: op.id, message: `hook "${op.id}" marked paid without a quote from the chapter; kept open as advanced` });
                return { ...op, event: 'advanced' };
            }
        }
        if (op?.op === 'event' && (op.event === 'changed' || op.event === 'mentioned')) {
            const record = findRecord(state?.ledger, op.id);
            if (record && !recordNames(record).some((name) => termOccursInText(prose, name)))
                violations.push({ severity: 'soft', code: 'LEDGER_NAME_NOT_IN_PROSE', ledgerId: record.id, message: `"${record.name}" is ${op.event} but not named in the chapter` });
        }
        return op;
    });
    const present = new Set(cast ?? []);
    const speakerAliases = [
        ...(state?.ledger?.records ?? []).flatMap((record) => (record.aliases ?? []).filter((alias) => alias.by).map((alias) => ({ id: record.id, text: alias.text, by: alias.by }))),
        ...(config?.customTracking ?? []).flatMap((item) => (item.rules ?? []).filter((rule) => rule.type === 'speakerOnly').map((rule) => ({ id: item.id, text: rule.alias, by: rule.by }))),
    ];
    for (const alias of speakerAliases) {
        if (present.size && !present.has(alias.by) && termOccursInText(prose, alias.text))
            violations.push({ severity: 'soft', code: 'LEDGER_ALIAS_OWNER_ABSENT', ledgerId: alias.id, message: `"${alias.text}" is ${alias.by}'s word, but ${alias.by} is not in this chapter` });
    }
    for (const record of state?.ledger?.records ?? []) {
        if (record.status !== 'destroyed')
            continue;
        const name = recordNames(record).find((item) => termOccursInText(prose, item));
        if (name)
            violations.push({ severity: 'soft', code: 'DESTROYED_ENTITY_MENTION', ledgerId: record.id, entityId: record.id, message: `destroyed "${record.name}" (matched "${name}") is named again` });
    }
    return { ops: reviewed, violations };
}
