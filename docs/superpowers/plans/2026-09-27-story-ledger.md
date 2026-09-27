# Story Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `trackedEntities` + `entities.json` + phase-only hooks with one ledger of records (stable id, aliases, status, fields, recent events) and hooks in the same shape, with a rebuildable chapter event log, feature toggles instead of genre branches, author-defined tracking items, and duplicate detection against the whole ledger.

**Architecture:** A pure engine module (`engine/src/continuity/ledger.js`) owns the data model, legacy conversion, op application and prose review. `reduceStoryState` folds `delta.ledgerOps` (and converts legacy delta fields) through it. The chapter deltas already stored per chapter stay the source of truth; `.vibelore/ledger/events.jsonl` is a history file rebuilt from them (after commit, rollback, sync). Plugin code (`src/`) renders bounded views, stores the per-work config (`review-policy.json`: `tracking`, `customTracking`, `merges`) and wires checks.

**Tech Stack:** Node ESM JavaScript, `node --test` (engine tests use `engine/test/_support/vitest-shim.mjs`), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-27-story-ledger-design.md`

## Global Constraints

- No genre name may appear in new code paths; behaviour depends only on the four features `objects`, `knowledge`, `scheduled`, `hooks` and the per-work config.
- All tracking features are on by default. A feature turned off is not requested from the extractor, not checked, and never counted as a failure.
- Model inputs stay bounded: records and hooks go through focus selection and caps; exceptions are `pinned` custom items and hooks the plan touches. History summaries are capped at 5 events.
- `.vibelore/` history is text (JSONL); no SQLite for the ledger.
- Chapter deltas are the source of truth; `events.jsonl` must be reproducible from them byte-for-byte.
- Ambiguous duplicates are never merged automatically; exact normalized-name matches are.
- Engine files use 4-space indent and the style of `engine/src/continuity/story-state.js`; `src/` files use 2-space indent.
- ko (`src/prompts/ko.js`) and multilingual (`src/prompts/multilingual.js`) phrase tables must stay in step.
- Tests: `npm test` and `npm run test:engine` must pass after every task (`test/server.test.js` can be flaky under load; rerun alone).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push, no PR. Never touch the real `works/` directory.

## Design adjustments found while planning (reported to the user)

1. Rollback **does** restore `entities.json` (it is in `machineEntries`, `src/tools/snapshots.js:9`); the spec's claim otherwise was wrong. It does **not** restore `review-policy.json` or `arc-summaries/` (both deleted on rollback) — fixed in Task 1.
2. Approved merges are stored as configuration (`review-policy.json` → `merges`) and applied by the reducer, set through `lore_configure(mergeRecords=[...])`, instead of a new `lore_decide` action. This avoids changing a delta after its check receipt was issued and serves both the chapter approval and the migration.
3. Canon readers keep the entity snapshot shape (`projections.entities`, entity context, mention activation); commit derives those snapshots from the ledger (`ledgerEntitySnapshots`) instead of the unused `entityOps`.
4. `genreProfile.invariants` stays this round (stored per work, read by prompts, compared by the approval gate); only the unused genre `trackedEntities` lists go. Turning genre invariants into default author rules is a follow-up.
5. Speaker-only aliases are checked two ways: deterministically when the alias appears while its owner is absent from the chapter cast, and semantically by listing them in the check's address section (the existing `REGISTRATION` invariant). Who speaks a line cannot be determined deterministically.

## File Structure

| File | Responsibility |
|---|---|
| Create `engine/src/continuity/ledger.js` | Data model constants, name keys, id assignment, lookup, legacy conversion, `applyLedgerOps`, `reviewLedgerOps`, `applyMerges` |
| Create `engine/test/continuity/ledger.test.js` | Unit tests for the above |
| Modify `engine/src/continuity/story-state.js` | `hooks` get `status`/`recent`; `ledger` in state; reduce folds `ledgerOps` and converts legacy fields; `trackedEntities` no longer produced |
| Modify `engine/src/continuity/continuity-check.js` | Extraction schema/parse/validation for `ledgerOps`, tracking-aware schema, hash version bump |
| Create `src/tools/ledger-log.js` | Rebuild/read `events.jsonl`, history per id |
| Modify `src/store/markdown-store.js` | `loadLedgerEvents`/`saveLedgerEvents` |
| Modify `src/tools/snapshots.js` | Restore `review-policy.json`, `arc-summaries`; rebuild the log after rollback |
| Modify `src/tools/commit.js` | Save log after commit; stop writing `entities.json`; state counts |
| Modify `src/core/review-policy.js`, `src/tools/configure.js`, `src/server.js` | `tracking`, `customTracking`, `mergeRecords` |
| Modify `src/core/prompt-sections.js`, `src/prompts/ko.js`, `src/prompts/multilingual.js` | Ledger renders (extract/writer/check/planner), recent-event rule, history summary |
| Modify `src/tools/check-contract.js` | Review ops, destroyed scan from ledger, custom rule and alias violations |
| Modify `engine/src/generators/text/steps/coherence-judge.js`, `src/tools/workflow.js` | Author natural-language rules as advisory findings |
| Modify `src/tools/memory-index.js`, `src/tools/context.js` | Index records and event notes; hooks by status |
| Modify phase consumers | `engine/src/generators/text/steps/{draft,rewrite,chapter-plan}.js`, `continuity-check.js:451` |
| Modify `test/long-run-inputs.test.js`, `test/fixtures/long-run-state.js` | Ledger guard |
| Create `test/ledger-migration.test.js` | Legacy replay and merge candidates |
| Modify docs | `docs/TOOLS.md`, `docs/TOOLS.en.md`, `docs/OPERATIONS.md`, `CHANGELOG.md` |

---

### Task 1: Keep user settings and arc summaries across rollback

**Files:**
- Modify: `src/tools/snapshots.js:9`
- Test: `test/snapshots.test.js` (existing; add a case)

**Interfaces:**
- Produces: `machineEntries` includes `'review-policy.json'` and `'arc-summaries'`.

- [ ] **Step 1: Write the failing test** — append to `test/snapshots.test.js` (reuse its existing helpers for creating a work with two committed chapters; read the top of the file first and use the same setup function it uses for the existing rollback case):

```js
test('rollback keeps review policy and arc summaries', async () => {
  const { store, workId } = await committedWorkWithChapters(2); // existing helper name in this file; adapt if it differs
  await store.saveReviewPolicy(workId, { disabled: ['reader-hook'], draftSectionsOff: [] });
  await createChapterSnapshot({ store, workId, chapter: 1 });
  await store.saveArcSummary?.(workId, 1, { arcNumber: 1, summary: '첫 아크 요약' });
  await createChapterSnapshot({ store, workId, chapter: 2 });
  await rollbackToSnapshot({ store, workId, chapter: 2 });
  assert.deepEqual((await store.loadReviewPolicy(workId)).disabled, ['reader-hook']);
});
```

- [ ] **Step 2: Run** `node --test test/snapshots.test.js` — Expected: FAIL (`loadReviewPolicy` returns null after rollback).

- [ ] **Step 3: Implement** — in `src/tools/snapshots.js:9` add the two entries to `machineEntries`:

```js
const machineEntries = ['foundation.json', 'story-profile.json', 'story-spine.json', 'writer-skill.json', 'story-identity.json', 'pilot-contract.json', 'arc-plan.json', 'arcs', 'arc-reviews', 'arc-summaries', 'episode-plans', 'artifacts', 'story-state', 'summaries', 'entities.json', 'pattern-ledger.json', 'experience-ledger.json', 'style-anchor.json', 'review-policy.json'];
```

- [ ] **Step 4: Run** `node --test test/snapshots.test.js` — Expected: PASS. Then `npm test`.

- [ ] **Step 5: Commit** — `fix(rollback): keep the review policy and arc summaries`.

---

### Task 2: Ledger data model, lookup and legacy conversion (engine)

**Files:**
- Create: `engine/src/continuity/ledger.js`
- Test: `engine/test/continuity/ledger.test.js`

**Interfaces:**
- Produces (exact exports):
  - `LEDGER_FEATURES` = `['objects','knowledge','scheduled']`, `TRACKING_FEATURES` = `[...LEDGER_FEATURES,'hooks']`
  - `RECORD_STATUSES`, `HOOK_STATUSES`, `RECORD_EVENTS`, `HOOK_EVENTS`, `RECENT_EVENTS` (=3)
  - `emptyLedger(): {records: []}`
  - `ledgerNameKey(value: string): string`
  - `recordNames(record): string[]`
  - `findRecord(ledger, ref: string, feature?: string|null): record|null`
  - `similarRecord(ledger, feature: string, name: string): record|null`
  - `nextLedgerId(state, feature: string): string` (`o1`, `k1`, `s1`, `h1` …)
  - `hookStatusOf(raw): 'open'|'dormant'|'paid'|'closed'`
  - `ledgerFromLegacy({ trackedEntities, entities }): {records}`

- [ ] **Step 1: Write the failing test** `engine/test/continuity/ledger.test.js`:

```js
import { describe, expect, it } from '../_support/vitest-shim.mjs';
import { emptyLedger, findRecord, hookStatusOf, ledgerFromLegacy, ledgerNameKey, nextLedgerId, similarRecord } from '../../src/continuity/ledger.js';

const note = { id: 'o1', feature: 'objects', label: '물건', name: '서명 쪽지', aliases: [{ text: '그 쪽지' }], status: 'active', fields: {}, recent: [] };

describe('ledger lookup', () => {
    it('normalizes names: case, quotes, spaces and a trailing particle', () => {
        expect(ledgerNameKey('「서명 쪽지」를')).toBe('서명 쪽지');
        expect(ledgerNameKey('  Silver  Key ')).toBe('silver key');
    });
    it('finds a record by id, merged id, name or alias', () => {
        const ledger = { records: [{ ...note, mergedIds: ['o9'] }] };
        expect(findRecord(ledger, 'o1')?.id).toBe('o1');
        expect(findRecord(ledger, 'o9')?.id).toBe('o1');
        expect(findRecord(ledger, '서명 쪽지는')?.id).toBe('o1');
        expect(findRecord(ledger, '그 쪽지')?.id).toBe('o1');
        expect(findRecord(ledger, '그 쪽지', 'knowledge')).toBe(null);
    });
    it('reports a similar record without treating it as the same', () => {
        const ledger = { records: [note] };
        expect(similarRecord(ledger, 'objects', '재서명된 쪽지')?.id).toBe('o1');
        expect(similarRecord(ledger, 'objects', '은빛 열쇠')).toBe(null);
    });
    it('assigns the next id per feature prefix', () => {
        expect(nextLedgerId({ ledger: { records: [note, { ...note, id: 'o7' }] }, hooks: [] }, 'objects')).toBe('o8');
        expect(nextLedgerId({ ledger: emptyLedger(), hooks: [{ id: 'h2' }, { id: 'legacy-hook' }] }, 'hooks')).toBe('h3');
    });
});

describe('legacy conversion', () => {
    it('maps legacy hook phases and statuses to the four statuses', () => {
        expect(hookStatusOf({ phase: 'planted' })).toBe('open');
        expect(hookStatusOf({ phase: 'advancing' })).toBe('open');
        expect(hookStatusOf({ phase: 'parked' })).toBe('dormant');
        expect(hookStatusOf({ phase: 'paid' })).toBe('paid');
        expect(hookStatusOf({ status: 'resolved' })).toBe('paid');
        expect(hookStatusOf({ status: 'closed' })).toBe('closed');
    });
    it('turns tracked entities and entity snapshots into records, dropping Timeline logs', () => {
        const ledger = ledgerFromLegacy({
            trackedEntities: [
                { kind: 'Artifact', data: { name: '서명 쪽지', holder: 'c2' }, updatedChapter: 5 },
                { kind: 'KnowledgeMatrix', data: { fact: '리아 손목 부상', knownBy: ['c1'] }, updatedChapter: 4 },
                { kind: 'Timeline', data: { chapter: 5, events: ['…'] }, updatedChapter: 5 },
            ],
            entities: [{ entityId: 'seed-1', kind: 'location', canonicalName: '계곡 다리', aliases: ['다리'], status: 'active', attrs: { tier: '길목' } },
                { entityId: 'seed-2', kind: 'item', canonicalName: '서명 쪽지', aliases: [], status: 'destroyed', attrs: {} }],
        });
        expect(ledger.records.map((r) => [r.id, r.feature, r.name, r.status])).toEqual([
            ['seed-1', 'objects', '계곡 다리', 'active'],
            ['seed-2', 'objects', '서명 쪽지', 'destroyed'],
            ['k1', 'knowledge', '리아 손목 부상', 'secret'],
        ]);
        expect(ledger.records[1].fields).toEqual({ holder: 'c2' });
        expect(ledger.records[0].aliases).toEqual([{ text: '다리' }]);
    });
});
```

- [ ] **Step 2: Run** `cd engine && node --test test/continuity/ledger.test.js` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `engine/src/continuity/ledger.js`:

```js
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
```

- [ ] **Step 4: Run** `cd engine && node --test test/continuity/ledger.test.js` — Expected: PASS.

- [ ] **Step 5: Commit** — `feat(ledger): add the record model, name keys and legacy conversion`.

---

### Task 3: Applying ledger ops with transition and author rules (engine)

**Files:**
- Modify: `engine/src/continuity/ledger.js` (append)
- Test: `engine/test/continuity/ledger.test.js` (append)

**Interfaces:**
- Consumes: Task 2 exports.
- Produces:
  - `applyLedgerOps(state, ops, { chapter, config = {} }) → { ledger, hooks, events, violations }` — pure; `state` has `ledger` and `hooks`. `config = { tracking?: {objects?:bool, knowledge?:bool, scheduled?:bool, hooks?:bool}, customTracking?: CustomItem[] }`.
  - `applyMerges(ledger, merges, chapter) → { ledger, events }`
  - `trackingEnabled(config, feature): boolean`
  - Op shapes (the only accepted ones):
    - `{op:'register', feature, label, name, aliases?: (string|{text,by?})[], fields?: object, note?}`
    - `{op:'event', id, event: 'mentioned'|'changed'|'status'|'restored', note?, set?: object, status?}`
    - `{op:'alias', id, alias: string, by?: string}`
    - `{op:'plant', text, horizon?, note?}`
    - `{op:'hook', id, event: 'mentioned'|'advanced'|'paid'|'reopened'|'parked'|'closed', note?, evidence?}`
  - Event line: `{chapter, target:'record'|'hook', id, event, note?, set?, status?, evidence?, alias?, by?, into?}`
  - CustomItem: `{id:'u1', name, feature, pinned?: boolean, rules?: Rule[], note?: string}`; Rule: `{type:'monotonic', field, direction:'up'|'down', unless?: string, severity?: 'soft'|'hard'} | {type:'frozenAfter', status, severity?} | {type:'speakerOnly', alias, by, severity?}`
  - Violation codes: `LEDGER_UNKNOWN_ID`, `LEDGER_POSSIBLE_DUPLICATE`, `LEDGER_UPDATE_AFTER_DESTROY` (hard), `LEDGER_RESTORE_NOTE_REQUIRED` (hard), `LEDGER_INVALID_STATUS`, `LEDGER_SCHEDULED_REOPENED`, `LEDGER_CLOSED_HOOK_EVENT`, `CUSTOM_RULE_MONOTONIC`, `CUSTOM_RULE_FROZEN`. All soft unless stated; custom rules use the rule's `severity` (default soft).

- [ ] **Step 1: Write the failing tests** (append):

```js
import { applyLedgerOps, applyMerges } from '../../src/continuity/ledger.js';

const base = () => ({ ledger: { records: [
    { id: 'o1', feature: 'objects', label: '물건', name: '서명 쪽지', aliases: [], status: 'active', fields: { holder: 'c1' }, registeredAt: 4, lastEventAt: 4, recent: [] },
    { id: 'o2', feature: 'objects', label: '물건', name: '낡은 검', aliases: [], status: 'destroyed', fields: {}, registeredAt: 2, lastEventAt: 6, recent: [] },
] }, hooks: [{ id: 'h1', text: '손목의 비밀', status: 'paid', plantedAtChapter: 2, lastMovedChapter: 5, recent: [] }] });

describe('applyLedgerOps', () => {
    it('adds a changed event and keeps the last three events', () => {
        let state = base();
        for (let chapter = 5; chapter <= 8; chapter += 1) {
            state = { ...state, ...applyLedgerOps(state, [{ op: 'event', id: 'o1', event: 'changed', set: { holder: `c${chapter}` }, note: `${chapter}화` }], { chapter }) };
        }
        const record = state.ledger.records[0];
        expect(record.fields.holder).toBe('c8');
        expect(record.recent.map((e) => e.chapter)).toEqual([6, 7, 8]);
        expect(record.lastEventAt).toBe(8);
    });
    it('turns a register with an existing name into an event on that record', () => {
        const out = applyLedgerOps(base(), [{ op: 'register', feature: 'objects', label: '물건', name: '서명 쪽지를', fields: { state: '재서명' } }], { chapter: 7 });
        expect(out.ledger.records).toHaveLength(2);
        expect(out.events).toEqual([{ chapter: 7, target: 'record', id: 'o1', event: 'changed', set: { state: '재서명' } }]);
    });
    it('registers a similar name but marks it as a possible duplicate', () => {
        const out = applyLedgerOps(base(), [{ op: 'register', feature: 'objects', label: '물건', name: '재서명된 쪽지' }], { chapter: 7 });
        const added = out.ledger.records.at(-1);
        expect(added.id).toBe('o3');
        expect(added.possibleDuplicateOf).toBe('o1');
        expect(out.violations.map((v) => v.code)).toEqual(['LEDGER_POSSIBLE_DUPLICATE']);
    });
    it('rejects a change to a destroyed record but allows a mention', () => {
        const out = applyLedgerOps(base(), [
            { op: 'event', id: 'o2', event: 'changed', set: { state: '수리됨' } },
            { op: 'event', id: 'o2', event: 'mentioned', note: '회상' },
        ], { chapter: 7 });
        expect(out.violations.map((v) => [v.code, v.severity])).toEqual([['LEDGER_UPDATE_AFTER_DESTROY', 'hard']]);
        expect(out.ledger.records[1].fields).toEqual({});
        expect(out.ledger.records[1].recent.map((e) => e.event)).toEqual(['mentioned']);
    });
    it('restores a destroyed record only with a note', () => {
        const without = applyLedgerOps(base(), [{ op: 'event', id: 'o2', event: 'restored' }], { chapter: 7 });
        expect(without.violations[0].code).toBe('LEDGER_RESTORE_NOTE_REQUIRED');
        const withNote = applyLedgerOps(base(), [{ op: 'event', id: 'o2', event: 'restored', note: '대장장이가 다시 벼림' }], { chapter: 7 });
        expect(withNote.ledger.records[1].status).toBe('active');
    });
    it('reopens a paid hook and plants a new one with the next id', () => {
        const out = applyLedgerOps(base(), [
            { op: 'hook', id: 'h1', event: 'reopened', note: '다시 아픔' },
            { op: 'plant', text: '누가 사슬을 박았나', horizon: 'arc' },
        ], { chapter: 7 });
        expect(out.hooks.map((h) => [h.id, h.status])).toEqual([['h1', 'open'], ['h2', 'open']]);
        expect(out.hooks[1].plantedAtChapter).toBe(7);
    });
    it('does not apply ops of a feature the user turned off', () => {
        const out = applyLedgerOps(base(), [{ op: 'register', feature: 'knowledge', label: '비밀', name: '손목 부상' }], { chapter: 7, config: { tracking: { knowledge: false } } });
        expect(out.ledger.records).toHaveLength(2);
        expect(out.violations).toEqual([]);
    });
    it('drops an unknown id with a soft finding', () => {
        const out = applyLedgerOps(base(), [{ op: 'event', id: 'o99', event: 'mentioned' }], { chapter: 7 });
        expect(out.violations.map((v) => v.code)).toEqual(['LEDGER_UNKNOWN_ID']);
    });
    it('checks author rules on the custom item', () => {
        const config = { customTracking: [{ id: 'u1', name: '금화', feature: 'objects', rules: [{ type: 'monotonic', field: 'amount', direction: 'down', unless: '벌었' }] }] };
        let state = { ...base(), ...applyLedgerOps(base(), [{ op: 'event', id: 'u1', event: 'changed', set: { amount: '금화 10닢' } }], { chapter: 5, config }) };
        const up = applyLedgerOps(state, [{ op: 'event', id: 'u1', event: 'changed', set: { amount: '금화 12닢' } }], { chapter: 6, config });
        expect(up.violations.map((v) => v.code)).toEqual(['CUSTOM_RULE_MONOTONIC']);
        const earned = applyLedgerOps(state, [{ op: 'event', id: 'u1', event: 'changed', set: { amount: '금화 12닢' }, note: '품삯을 벌었다' }], { chapter: 6, config });
        expect(earned.violations).toEqual([]);
    });
});

describe('applyMerges', () => {
    it('folds a record into another and keeps its id and name as aliases', () => {
        const ledger = { records: [...base().ledger.records, { id: 'o3', feature: 'objects', label: '물건', name: '재서명된 쪽지', aliases: [], status: 'active', fields: { state: '재서명' }, recent: [] }] };
        const out = applyMerges(ledger, [{ from: 'o3', into: 'o1' }], 8);
        expect(out.ledger.records.map((r) => r.id)).toEqual(['o1', 'o2']);
        expect(out.ledger.records[0].mergedIds).toEqual(['o3']);
        expect(out.ledger.records[0].aliases).toEqual([{ text: '재서명된 쪽지' }]);
        expect(out.ledger.records[0].fields).toEqual({ holder: 'c1', state: '재서명' });
        expect(out.events).toEqual([{ chapter: 8, target: 'record', id: 'o3', event: 'merged', into: 'o1' }]);
        expect(applyMerges(out.ledger, [{ from: 'o3', into: 'o1' }], 9).events).toEqual([]);
    });
});
```

- [ ] **Step 2: Run** `cd engine && node --test test/continuity/ledger.test.js` — Expected: FAIL (`applyLedgerOps` not exported).

- [ ] **Step 3: Implement** (append to `ledger.js`):

```js
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
```

Note on `applyMerges` field precedence: the test expects `{ holder: 'c1', state: '재서명' }` — the kept record's values win and the absorbed record fills gaps.

- [ ] **Step 4: Run** `cd engine && node --test test/continuity/ledger.test.js` — Expected: PASS.

- [ ] **Step 5: Commit** — `feat(ledger): apply ops with transition and author rules`.

---

### Task 4: Prose review of ledger ops (engine)

**Files:**
- Modify: `engine/src/continuity/ledger.js` (append)
- Test: `engine/test/continuity/ledger.test.js` (append)

**Interfaces:**
- Consumes: `findRecord`, `recordNames`, `termOccursInText` from `engine/src/core/mention-scan.js`.
- Produces: `reviewLedgerOps({ state, ops, prose, cast = [], config = {} }) → { ops, violations }`. Codes: `LEDGER_NAME_NOT_IN_PROSE`, `HOOK_PAID_WITHOUT_EVIDENCE` (op downgraded to `advanced`), `LEDGER_ALIAS_OWNER_ABSENT`, `DESTROYED_ENTITY_MENTION` (same code the old scan used). All soft.

- [ ] **Step 1: Write the failing tests** (append):

```js
import { reviewLedgerOps } from '../../src/continuity/ledger.js';

describe('reviewLedgerOps', () => {
    const state = () => ({ ...base(), ledger: { records: [
        ...base().ledger.records,
        { id: 'o3', feature: 'objects', label: '물건', name: '통행 장부', aliases: [{ text: '그 종이 쪼가리', by: 'c4', since: 5 }], status: 'active', fields: {}, recent: [] },
    ] }, hooks: [{ id: 'h2', text: '누가 사슬을 박았나', status: 'open', recent: [] }] });
    it('downgrades a paid hook whose evidence is not in the prose', () => {
        const out = reviewLedgerOps({ state: state(), prose: '도윤은 사슬을 풀었다.', ops: [{ op: 'hook', id: 'h2', event: 'paid', evidence: '마렌이 사슬을 박았다' }] });
        expect(out.ops).toEqual([{ op: 'hook', id: 'h2', event: 'advanced', evidence: '마렌이 사슬을 박았다' }]);
        expect(out.violations.map((v) => v.code)).toEqual(['HOOK_PAID_WITHOUT_EVIDENCE']);
    });
    it('keeps a paid hook whose evidence is quoted from the prose', () => {
        const out = reviewLedgerOps({ state: state(), prose: '그날 밤, 마렌이   사슬을 박았다고 털어놓았다.', ops: [{ op: 'hook', id: 'h2', event: 'paid', evidence: '마렌이 사슬을 박았다' }] });
        expect(out.ops[0].event).toBe('paid');
        expect(out.violations).toEqual([]);
    });
    it('flags a change to a record the prose never names', () => {
        const out = reviewLedgerOps({ state: state(), prose: '리아는 걸었다.', ops: [{ op: 'event', id: 'o1', event: 'changed', set: { holder: 'c3' } }] });
        expect(out.violations.map((v) => v.code)).toEqual(['LEDGER_NAME_NOT_IN_PROSE']);
    });
    it('flags a speaker-only alias when its owner is absent, and a destroyed record named again', () => {
        const out = reviewLedgerOps({ state: state(), prose: '"그 종이 쪼가리 어디 뒀어?" 낡은 검이 벽에 걸려 있었다.', cast: ['c1', 'c2'], ops: [] });
        expect(out.violations.map((v) => v.code).sort()).toEqual(['DESTROYED_ENTITY_MENTION', 'LEDGER_ALIAS_OWNER_ABSENT']);
    });
});
```

- [ ] **Step 2: Run** — Expected: FAIL (`reviewLedgerOps` not exported).

- [ ] **Step 3: Implement** (append; add `import { termOccursInText } from '../core/mention-scan.js';` at the top of `ledger.js`):

```js
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
```

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** — `feat(ledger): review ops against the chapter text`.

---

### Task 5: StoryState carries the ledger; hooks get status (engine)

**Files:**
- Modify: `engine/src/continuity/story-state.js`
- Modify: `engine/src/continuity/continuity-check.js:451` (hook summary), `engine/src/generators/text/steps/draft.js:420`, `rewrite.js:86`, `chapter-plan.js:218` (`phase: h.phase` → `status: h.status`)
- Modify: `src/tools/memory-index.js:36` — `if (hook.phase === 'paid') continue;` becomes `if (normalizeHook(hook).status === 'paid' || normalizeHook(hook).status === 'closed') continue;` (dormant hooks stay searchable: they may come back)
- Test: `engine/test/continuity/story-state.test.js`

**Interfaces:**
- Consumes: `applyLedgerOps`, `applyMerges`, `ledgerFromLegacy`, `hookStatusOf`, `emptyLedger` (Tasks 2–3).
- Produces:
  - `emptyStoryState(workId)` now has `ledger: {records: []}` and still `trackedEntities: []` (kept empty for readers during migration).
  - `normalizeHook(raw)` returns `{...rest, id, text, status, horizon?, plantedAtChapter?, lastMovedChapter?, recent: []}` — no `phase`.
  - `isHookActive(hook)` → `status === 'open' || status === 'dormant'` is **not** used; active means `open` only, and `dormant` hooks are listed separately by planners. Keep the signature.
  - `normalizeStoryState(state, { entities } = {})` → state with `ledger` (built by `ledgerFromLegacy` when absent) and normalized hooks.
  - `reduceStoryState(prev, delta, { config } = {})` → folds `delta.ledgerOps`, legacy `hookChanges`/`trackedEntityOps`/`entityOps` (converted by `legacyLedgerOps`), then `config.merges`. Returns state without `trackedEntities` data (always `[]`).
  - `ledgerStep(prev, delta, { config }) → { ledger, hooks, events, violations }` — what reduce uses; exported for the commit log and the check.
  - `legacyLedgerOps(prev, delta) → op[]` exported for the log rebuild tests.

- [ ] **Step 1: Write the failing tests** (append to `engine/test/continuity/story-state.test.js`):

```js
import { ledgerStep, legacyLedgerOps, normalizeStoryState, isHookActive } from '../../src/continuity/story-state.js';

describe('ledger in StoryState', () => {
    it('folds ledger ops and merges from the config', () => {
        const prev = { ...emptyStoryState('w'), chapterNumber: 1 };
        const delta = { ...emptyDelta(2), ledgerOps: [
            { op: 'register', feature: 'objects', label: '물건', name: '서명 쪽지' },
            { op: 'register', feature: 'objects', label: '물건', name: '재서명된 쪽지' },
            { op: 'plant', text: '누가 사슬을 박았나' },
        ] };
        const next = reduceStoryState(prev, delta, { config: { merges: [{ from: 'o2', into: 'o1' }] } });
        expect(next.ledger.records.map((r) => r.id)).toEqual(['o1']);
        expect(next.hooks.map((h) => [h.id, h.status])).toEqual([['h1', 'open']]);
        expect(next.trackedEntities).toEqual([]);
    });
    it('converts legacy hook changes and tracked entity ops into ledger ops', () => {
        const prev = { ...emptyStoryState('w'), chapterNumber: 4, hooks: [{ id: 'wrist', text: '손목', phase: 'planted', plantedAtChapter: 2 }] };
        const delta = { ...emptyDelta(5),
            hookChanges: [{ id: 'wrist', text: '손목', phase: 'advancing', plantedAtChapter: 2, lastMovedChapter: 5 }, { id: 'chain', text: '사슬', phase: 'planted' }],
            trackedEntityOps: [{ kind: 'Artifact', data: { name: '서명 쪽지', holder: 'c2' } }, { kind: 'Timeline', data: { chapter: 5, events: ['수레가 멈춤'] } }] };
        expect(legacyLedgerOps(normalizeStoryState(prev), delta)).toEqual([
            { op: 'hook', id: 'wrist', event: 'advanced' },
            { op: 'plant', text: '사슬', id: 'chain' },
            { op: 'register', feature: 'objects', label: 'Artifact', name: '서명 쪽지', fields: { holder: 'c2' } },
            { op: 'chapter-note', note: '수레가 멈춤' },
        ]);
        const next = reduceStoryState(prev, delta);
        expect(next.hooks.map((h) => [h.id, h.status])).toEqual([['wrist', 'open'], ['chain', 'open']]);
        expect(next.ledger.records.map((r) => r.name)).toEqual(['서명 쪽지']);
    });
    it('reads a legacy state: hooks by status, tracked entities as records', () => {
        const state = normalizeStoryState({ ...emptyStoryState('w'), ledger: undefined, hooks: [{ id: 'a', text: 'x', phase: 'parked' }], trackedEntities: [{ kind: 'Clue', data: { name: '표식' } }] },
            { entities: [{ entityId: 'seed-1', kind: 'location', canonicalName: '다리', aliases: [], status: 'active', attrs: {} }] });
        expect(state.hooks[0].status).toBe('dormant');
        expect(isHookActive(state.hooks[0])).toBe(false);
        expect(state.ledger.records.map((r) => r.id)).toEqual(['seed-1', 'o1']);
    });
});
```

The `plant` op converted from a legacy hook carries the legacy `id`; `applyLedgerOps` must use `op.id` for `plant` when given and not already taken. Add that to Task 3's `plant` branch in this task: `id: (op.id && !next.hooks.some((h) => h.id === op.id)) ? op.id : nextLedgerId(next, 'hooks')`. A `chapter-note` op emits `{chapter, target:'chapter', event:'note', note}` and changes nothing else; add that branch to `applyLedgerOps` too (with a test in `ledger.test.js`: `applyLedgerOps(base(), [{ op: 'chapter-note', note: 'x' }], { chapter: 3 }).events` equals `[{ chapter: 3, target: 'chapter', event: 'note', note: 'x' }]`).

- [ ] **Step 2: Run** `cd engine && node --test test/continuity/story-state.test.js test/continuity/ledger.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement** in `story-state.js`:

1. Replace the hook lifecycle block (lines 10–58) with:

```js
import { applyLedgerOps, applyMerges, emptyLedger, hookStatusOf, HOOK_STATUSES, ledgerFromLegacy } from './ledger.js';
/**
 * Hook lifecycle. A hook is a narrative promise to the reader.
 *   open    — the reader is waiting on it
 *   dormant — set aside for now; planners may bring it back
 *   paid    — answered on the page; may be reopened
 *   closed  — no longer used
 */
export { HOOK_STATUSES };
/** How soon the reader expects the payoff. Semantic, never a chapter count. */
export const HOOK_HORIZONS = ['next', 'soon', 'arc', 'long', 'finale'];
const LEGACY_HORIZON = { immediate: 'next', 'near-term': 'soon', 'mid-arc': 'arc', 'slow-burn': 'long', endgame: 'finale' };
/** True while the hook is open. */
export function isHookActive(hook) {
    return hookStatusOf(hook) === 'open';
}
/** Normalize a hook record, including those written by earlier vibelore builds. */
export function normalizeHook(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const id = raw.id ?? raw.hookId;
    if (typeof id !== 'string' || id.length === 0)
        return null;
    const text = raw.text ?? raw.description ?? '';
    const plantedAtChapter = raw.plantedAtChapter ?? raw.startChapter;
    let horizon = raw.horizon ?? LEGACY_HORIZON[raw.payoffTiming];
    if (!HOOK_HORIZONS.includes(horizon))
        horizon = undefined;
    const lastMovedChapter = raw.lastMovedChapter ?? raw.lastAdvancedChapter ?? plantedAtChapter;
    const status = hookStatusOf(raw);
    const { hookId, description, startChapter, phase, payoffTiming, lastAdvancedChapter, ...rest } = raw;
    return {
        ...rest,
        id,
        text,
        status,
        ...(plantedAtChapter !== undefined ? { plantedAtChapter } : {}),
        ...(horizon ? { horizon } : {}),
        ...(lastMovedChapter !== undefined ? { lastMovedChapter } : {}),
        recent: Array.isArray(raw.recent) ? raw.recent : [],
    };
}
/** Normalize a persisted StoryState (or null). A state written before the ledger gets one from its tracked entities and the entity snapshots. */
export function normalizeStoryState(state, { entities = [] } = {}) {
    if (!state || typeof state !== 'object')
        return state;
    const hooks = Array.isArray(state.hooks) ? state.hooks.map(normalizeHook).filter(Boolean) : [];
    const ledger = state.ledger?.records ? state.ledger : ledgerFromLegacy({ trackedEntities: state.trackedEntities, entities });
    return { ...state, hooks, ledger };
}
```

2. Add, before `reduceStoryState`:

```js
const LEGACY_EVENT = { planted: 'mentioned', advancing: 'advanced', paid: 'paid', parked: 'parked' };
function legacyName(data) {
    for (const field of ['name', 'item', 'ability', 'title', 'subject', 'fact', 'clue', 'event', 'key', 'id', 'label']) {
        if (typeof data?.[field] === 'string' && data[field].trim())
            return data[field].trim();
    }
    return typeof data?.from === 'string' && typeof data?.to === 'string' ? `${data.from}→${data.to}` : '';
}
/** Ledger ops equivalent to a delta written before the ledger. */
export function legacyLedgerOps(prev, delta) {
    const ops = [];
    const known = new Map((prev.hooks ?? []).map((hook) => [hook.id, hook]));
    for (const raw of delta.hookChanges ?? delta.hookOps ?? []) {
        const hook = normalizeHook(raw);
        if (!hook)
            continue;
        const phase = raw.phase ?? { open: 'planted', progressing: 'advancing', resolved: 'paid', deferred: 'parked' }[raw.status] ?? 'planted';
        if (!known.has(hook.id)) {
            ops.push({ op: 'plant', text: hook.text, id: hook.id, ...(hook.horizon ? { horizon: hook.horizon } : {}) });
            continue;
        }
        const before = known.get(hook.id);
        const event = before.status === 'paid' && phase !== 'paid' ? 'reopened' : LEGACY_EVENT[phase] ?? 'mentioned';
        ops.push({ op: 'hook', id: hook.id, event });
    }
    for (const op of delta.trackedEntityOps ?? []) {
        if (op.kind === 'Timeline') {
            const events = Array.isArray(op.data?.events) ? op.data.events : [op.data?.event].filter(Boolean);
            for (const note of events)
                ops.push({ op: 'chapter-note', note: String(note) });
            continue;
        }
        const name = legacyName(op.data);
        if (!name)
            continue;
        const { name: _name, ...fields } = op.data ?? {};
        const feature = op.kind === 'KnowledgeMatrix' || op.kind === 'RegressionKnowledge' ? 'knowledge' : 'objects';
        ops.push({ op: 'register', feature, label: op.kind, name, ...(Object.keys(fields).length ? { fields } : {}) });
    }
    for (const op of delta.entityOps ?? []) {
        if (op.op === 'register')
            ops.push({ op: 'register', feature: 'objects', label: op.kind, name: op.name });
        else if (op.op === 'update')
            ops.push({ op: 'event', id: op.entityId, event: 'changed', set: op.fields });
        else if (op.op === 'retire')
            ops.push({ op: 'event', id: op.entityId, event: 'status', status: op.cause === 'destroyed' ? 'destroyed' : 'retired' });
    }
    return ops;
}
/** The ledger part of a reduce, with the history lines and findings it produced. */
export function ledgerStep(prev, delta, { config = {} } = {}) {
    const state = normalizeStoryState(prev);
    const ops = [...legacyLedgerOps(state, delta), ...(delta.ledgerOps ?? [])];
    const applied = applyLedgerOps(state, ops, { chapter: delta.chapterNumber, config });
    const merged = applyMerges(applied.ledger, config.merges, delta.chapterNumber);
    return { ledger: merged.ledger, hooks: applied.hooks, events: [...applied.events, ...merged.events], violations: applied.violations };
}
```

In the `legacyLedgerOps` test above, the expected first op is `{ op: 'hook', id: 'wrist', event: 'advanced' }` and a legacy phase `planted` on a known hook becomes `mentioned`.

3. In `reduceStoryState(prev, delta, { config } = {})`: delete the hooks loop (old lines 147–158) and the `nextTracked` loop (159–171); after `nextCharacterStates`, add `const ledger = ledgerStep(prev, delta, { config });` and return `hooks: ledger.hooks, ledger: ledger.ledger, trackedEntities: []`. Update the doc comment rules 3–4 to describe `ledgerOps`, legacy conversion and merges.

4. `emptyStoryState` adds `ledger: emptyLedger()`.

5. Update the four `phase: h.phase` sites to `status: h.status`, and `continuity-check.js:451` to `status: hookStatusOf(h)` (import from `./ledger.js`). Update `src/tools/memory-index.js:36`.

- [ ] **Step 4: Run** `npm run test:engine` then `npm test`. Existing tests that assert `phase` on reduced hooks or `trackedEntities` contents will fail; update each assertion to the new shape (`status` instead of `phase`, `ledger.records` instead of `trackedEntities`). Record the list of touched test files in the commit message body.

- [ ] **Step 5: Commit** — `feat(state): carry the ledger in StoryState and give hooks a status`.

---

### Task 6: History log (`events.jsonl`) rebuilt from chapter deltas

**Files:**
- Create: `src/tools/ledger-log.js`
- Modify: `src/store/markdown-store.js` (store methods), `src/tools/commit.js`, `src/tools/snapshots.js` (after restore), `src/tools/sync.js` (rebuild on drift), `src/tools/commit.js` `runStatus` (report)
- Test: `test/ledger-log.test.js`

**Interfaces:**
- Consumes: `ledgerStep`, `normalizeStoryState`, `emptyStoryState` (Task 5); `loadLedgerConfig` (Task 8 — until then pass `{}`; Task 8 wires it).
- Produces:
  - store: `loadLedgerEvents(workId) → object[]` (reads `.vibelore/ledger/events.jsonl`, `[]` when absent), `saveLedgerEvents(workId, events)` (atomic write, one compact JSON per line, trailing newline).
  - `rebuildLedgerLog({ store, workId, config = {} }) → { events, chapters }` — replays committed chapters in order from `loadArtifact(workId, n).delta`, starting from `emptyStoryState` seeded with the entity snapshots when the first state has no ledger.
  - `ledgerHistory(events, id, limit = 5) → event[]` — events of that id (and ids merged into it), most recent last.
  - `ledgerLogStatus({ store, workId }) → { ok: boolean, lastChapter: number|null, committed: number|null }`.

- [ ] **Step 1: Write the failing test** `test/ledger-log.test.js` (follow the fixture helpers used by `test/arc-summary.test.js` to create a temp work with committed chapters — read that file first; it creates a store under a temp dir and saves artifacts directly with `store.saveArtifact`):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuildLedgerLog, ledgerHistory } from '../src/tools/ledger-log.js';
import { tempWork } from './helpers/temp-work.js'; // use the helper the repo already has; see test/arc-summary.test.js for the exact import

test('rebuilds the event log from committed chapter deltas, legacy and new', async () => {
  const { store, workId } = await tempWork();
  await store.saveArtifact({ workId, chapterNumber: 1, prose: '가', delta: { chapterNumber: 1, appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], mutableChanges: [],
    hookChanges: [{ id: 'wrist', text: '손목', phase: 'planted' }], trackedEntityOps: [{ kind: 'Artifact', data: { name: '서명 쪽지', holder: 'c1' } }] } });
  await store.saveArtifact({ workId, chapterNumber: 2, prose: '나', delta: { chapterNumber: 2, appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], mutableChanges: [],
    ledgerOps: [{ op: 'event', id: 'o1', event: 'changed', set: { holder: 'c2' }, note: '넘김' }, { op: 'hook', id: 'wrist', event: 'advanced' }] } });
  const { events } = await rebuildLedgerLog({ store, workId });
  assert.deepEqual(events.map((e) => [e.chapter, e.target, e.id, e.event]), [
    [1, 'hook', 'wrist', 'planted'], [1, 'record', 'o1', 'registered'],
    [2, 'record', 'o1', 'changed'], [2, 'hook', 'wrist', 'advanced'],
  ]);
  assert.deepEqual(await store.loadLedgerEvents(workId), events);
  assert.deepEqual(ledgerHistory(events, 'o1').map((e) => e.event), ['registered', 'changed']);
});
```

- [ ] **Step 2: Run** `node --test test/ledger-log.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement**

Store (`src/store/markdown-store.js`, next to `loadReviewPolicy`):

```js
  /** Chapter event history of the ledger, rebuilt from the chapter deltas. */
  async loadLedgerEvents(workId) {
    assertSafeId('workId', workId);
    const text = await readTextOrNull(this.sidecar('ledger', 'events.jsonl'));
    return text ? text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  }

  async saveLedgerEvents(workId, events) {
    assertSafeId('workId', workId);
    await writeAtomic(this.sidecar('ledger', 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''));
  }
```

`src/tools/ledger-log.js`:

```js
/**
 * The ledger's chapter history. The chapter deltas are the source of truth;
 * this file is rebuilt from them, so it follows commits, rollbacks and syncs
 * without its own bookkeeping.
 */
import { emptyStoryState, ledgerStep, normalizeStoryState } from '../../engine/src/continuity/story-state.js';

export async function rebuildLedgerLog({ store, workId, config = {} }) {
  const chapters = await store.listChapters();
  const entities = await store.loadEntitySnapshots(workId);
  let state = normalizeStoryState({ ...emptyStoryState(workId), ledger: undefined }, { entities: entities.filter((e) => (e.registeredAtChapter ?? 0) === 0) });
  const events = [];
  for (const chapter of chapters) {
    const artifact = await store.loadArtifact(workId, chapter);
    if (!artifact?.delta) continue;
    const step = ledgerStep(state, { ...artifact.delta, chapterNumber: chapter }, { config });
    events.push(...step.events);
    state = { ...state, chapterNumber: chapter, ledger: step.ledger, hooks: step.hooks };
  }
  await store.saveLedgerEvents(workId, events);
  return { events, chapters: chapters.length };
}

export function ledgerHistory(events, id, limit = 5) {
  const ids = new Set([id, ...events.filter((e) => e.event === 'merged' && e.into === id).map((e) => e.id)]);
  return events.filter((e) => ids.has(e.id)).slice(-limit);
}

export async function ledgerLogStatus({ store, workId }) {
  const events = await store.loadLedgerEvents(workId);
  const chapters = await store.listChapters();
  const lastChapter = events.length ? events.at(-1).chapter : null;
  const committed = chapters.at(-1) ?? null;
  return { ok: committed === null || lastChapter === null || lastChapter <= committed, lastChapter, committed };
}
```

Commit (`src/tools/commit.js`), after `await store.saveStoryState(next);`:

```js
  try { await rebuildLedgerLog({ store, workId, config: await loadLedgerConfig(store, workId) }); }
  catch { /* the log is rebuilt from the deltas; a failure here never loses the chapter */ }
```

and replace the `applyEntityOps` block: canon readers (`src/core/canon-repository.js:18` → `projections.entities`, entity context in `src/tools/context.js:72`, `engine/src/generators/text/steps/chapter-write.js:245-280`, `chapter-rewrite-with-revise.js:86-100`) keep reading entity snapshots, so derive them from the ledger: `const entities = ledgerEntitySnapshots(next.ledger);` (publish as `projections.entities` and save with `saveEntitySnapshots` as today). Add to `engine/src/continuity/ledger.js` (with a unit test in `ledger.test.js`: an `objects` record `{id:'o1', label:'물건', name:'서명 쪽지', aliases:[{text:'그 쪽지'}], status:'lost', fields:{holder:'c2'}, registeredAt:4}` becomes `{entityId:'o1', kind:'물건', canonicalName:'서명 쪽지', aliases:['그 쪽지'], status:'active', attrs:{holder:'c2'}, registeredAtChapter:4}`, a `destroyed` one keeps `destroyed`, `retired` keeps `retired`, `knowledge`/`scheduled` records are skipped):

```js
/** Entity snapshots derived from the ledger, for readers that still take the snapshot shape. */
export function ledgerEntitySnapshots(ledger) {
    return (ledger?.records ?? []).filter((record) => record.feature === 'objects').map((record) => ({
        entityId: record.id, kind: record.label || 'object', canonicalName: record.name,
        aliases: (record.aliases ?? []).map((alias) => alias.text),
        status: record.status === 'destroyed' || record.status === 'retired' ? record.status : 'active',
        attrs: { ...(record.fields ?? {}) }, registeredAtChapter: record.registeredAt ?? 0,
        ...(record.lastEventAt !== undefined ? { updatedAtChapter: record.lastEventAt } : {}),
    }));
}
```

Replace `trackedEntities: entities.length` in the result with `records: next.ledger.records.length, openHooks: next.hooks.filter(isHookActive).length`.

Refold (`src/tools/generate.js` `runRefold` L467-513) replays `entityOps` from `[]`: replace that replay with the reduced state's `ledgerEntitySnapshots(state.ledger)` and call `rebuildLedgerLog` after it saves. Pass `{ config: await loadLedgerConfig(store, workId) }` as the third argument to `reduceStoryState`. Seed the ledger for a legacy previous state: `const prev = normalizeStoryState(loaded ?? emptyStoryState(workId), { entities: await canonicalStore.loadEntitySnapshots(workId) });`.

Rollback (`src/tools/snapshots.js`, in `resumePendingRollback` after the experience ledger is restored): `await rebuildLedgerLog({ store, workId: journal.workId, config: await loadLedgerConfig(store, journal.workId) });`. Do not add `ledger` to `machineEntries` (the log is derived and would grow snapshots quadratically).

Status/sync: `runStatus` adds `ledgerLog: await ledgerLogStatus({ store, workId })`; `lore_sync` calls `rebuildLedgerLog` when `ledgerLog.ok` is false or the file is absent.

Until Task 8 lands, define in `src/core/review-policy.js`: `export async function loadLedgerConfig(store, workId) { const policy = (await store.loadReviewPolicy?.(workId)) ?? {}; return { tracking: policy.tracking ?? {}, customTracking: policy.customTracking ?? [], merges: policy.merges ?? [] }; }`.

- [ ] **Step 4: Run** `node --test test/ledger-log.test.js`, then `npm test` and `npm run test:engine`.

- [ ] **Step 5: Commit** — `feat(ledger): rebuild the chapter event log after commit, rollback and sync`.

---

### Task 7: Extraction asks for `ledgerOps`

**Files:**
- Modify: `engine/src/continuity/continuity-check.js` (schema lines 459–477, `EXTRACT_ARRAY_KEYS` 525, validators 623–675, parse 723–852, `EXTRACTION_CONTEXT_HASH_VERSION` 196, `extractionHashPayload` 244 to include `tracking`)
- Modify: `src/tools/check-contract.js:157-161` (pass `tracking`)
- Test: `engine/test/continuity/continuity-check.test.js`

**Interfaces:**
- Consumes: `LEDGER_FEATURES`, `trackingEnabled` (Task 3).
- Produces: `extractDelta(input)` accepts `input.tracking` (`{objects?, knowledge?, scheduled?, hooks?}`); the parsed delta has `ledgerOps` (validated shapes from Task 3) and no longer requests `hookChanges`/`trackedEntityOps`/`entityOps` (parsing them stays, for replay of old answers). `EXTRACTION_CONTEXT_HASH_VERSION = 2`.

- [ ] **Step 1: Write the failing tests** (append to `continuity-check.test.js`; reuse its existing fake provider helper that returns a canned JSON answer):

```js
it('asks for ledgerOps of enabled features only and parses them', async () => {
    const answer = { newAddressEntries: [], relationshipOps: [], mutableChanges: [], influenceEvents: [], noInfluenceReason: '변화 없음',
        ledgerOps: [{ op: 'register', feature: 'objects', label: '물건', name: '서명 쪽지' }, { op: 'hook', id: 'h1', event: 'paid', evidence: '…' }, { op: 'bogus' }] };
    const { delta, prompt } = await extractWithAnswer(answer, { tracking: { knowledge: false, scheduled: false } }); // helper: runs extractDelta with a provider returning `answer`, returns the delta and the user prompt it saw
    expect(prompt).toContain('"ledgerOps"');
    expect(prompt).toContain('objects');
    expect(prompt).not.toContain('knowledge|');
    expect(prompt).not.toContain('trackedEntityOps');
    expect(delta.ledgerOps).toEqual([{ op: 'register', feature: 'objects', label: '물건', name: '서명 쪽지' }, { op: 'hook', id: 'h1', event: 'paid', evidence: '…' }]);
});
```

- [ ] **Step 2: Run** `cd engine && node --test test/continuity/continuity-check.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement**

Schema (replace the `hookChanges`, `entityOps` and `trackedEntityOps` lines in `extractDeltaSchemaLines(labels, bindHash, tracking)`):

```js
    const features = LEDGER_FEATURES.filter((feature) => trackingEnabled({ tracking }, feature));
    const ledgerLines = [
        ...(features.length ? [
            `    { "op": "register", "feature": "${features.join('|')}", "label": "${labels.ledgerLabel}", "name": "...", "aliases": [{ "text": "...", "by": "characterId (only if one character uses it)" }], "fields": {}, "note": "${labels.ledgerNote}" },`,
            `    { "op": "event", "id": "existing record id", "event": "mentioned|changed|status|restored", "set": {}, "status": "...", "note": "${labels.ledgerNote}" },`,
            '    { "op": "alias", "id": "existing record id", "alias": "...", "by": "characterId or omit" },',
        ] : []),
        ...(trackingEnabled({ tracking }, 'hooks') ? [
            `    { "op": "plant", "text": "${labels.hookText}", "horizon": "next|soon|arc|long|finale" },`,
            `    { "op": "hook", "id": "existing hook id", "event": "mentioned|advanced|paid|reopened|parked|closed", "evidence": "${labels.hookEvidence}", "note": "${labels.ledgerNote}" }`,
        ] : []),
    ];
```

and emit `'  "ledgerOps": [', ...ledgerLines, '  ],'` in place of the removed lines. Add to both label tables: `ledgerLabel` (ko: `'물건·장소·단서·능력·비밀·예정된 일 등 자유 분류'`, en: `'free label: item, place, clue, ability, secret, scheduled event…'`), `ledgerNote` (ko: `'이번 화에서 일어난 일 한 줄'`, en: `'one line on what happened in this chapter'`), `hookEvidence` (ko: `'paid일 때만: 본문에서 그대로 옮긴 인용'`, en: `'only for paid: a quote copied from the chapter text'`). Add one system line to both `EXTRACT_DELTA_SYSTEM*`: ko `'이미 목록에 있는 기록과 떡밥은 그 id로 event/hook 을 쓰고, 목록에 없을 때만 register/plant 한다.'`, en `'Use event/hook with the listed id for anything already listed; register or plant only what is not listed.'`

`EXTRACT_ARRAY_KEYS` becomes `['newAddressEntries', 'relationshipOps', 'mutableChanges', 'influenceEvents', 'ledgerOps']`. Add validator:

```js
function isCompleteLedgerOp(raw) {
    if (!isRecord(raw) || !isNonEmptyString(raw.op))
        return false;
    if (raw.op === 'register')
        return isNonEmptyString(raw.feature) && isNonEmptyString(raw.name) && (!('fields' in raw) || isRecord(raw.fields));
    if (raw.op === 'event')
        return isNonEmptyString(raw.id) && isNonEmptyString(raw.event) && (!('set' in raw) || isRecord(raw.set));
    if (raw.op === 'alias')
        return isNonEmptyString(raw.id) && isNonEmptyString(raw.alias);
    if (raw.op === 'plant')
        return isNonEmptyString(raw.text);
    if (raw.op === 'hook')
        return isNonEmptyString(raw.id) && isNonEmptyString(raw.event);
    return false;
}
```

Register it in `NEW_CONTRACT_ENTRY_VALIDATORS` as `ledgerOps: (raw) => isCompleteLedgerOp(raw)`. Note: the whole answer fails completeness if one op is malformed; that is the existing contract for every other array (the retry path already handles it). In `parseChapterDeltaPayload`, add a lenient parse that keeps only ops passing `isCompleteLedgerOp` and copies only known keys (`op, feature, label, name, aliases, fields, note, id, event, set, status, alias, by, text, horizon, evidence`), and include `ledgerOps` in the returned delta. Keep parsing `hookChanges`/`trackedEntityOps`/`entityOps` when present.

Also update the two other schema readers:
- `engine/src/generators/text/chapter-validation.js:567` requires `delta.hookChanges` to be an array. Accept either: `Array.isArray(delta.hookChanges) || Array.isArray(delta.ledgerOps)`.
- `engine/src/core/validation-contract.js`: in `MACHINE_CONTRACT_FIELD_NAMES` (L78) add `op`, `feature`, `event`, `status`, `by`, `into`; in `classifyLeafPath` (L801-820) treat `ledgerOps[].fields` and `ledgerOps[].set` as open records like `trackedEntityOps.data`; `ledgerOps[].name`, `label`, `note`, `text`, `alias`, `aliases[].text`, `evidence` are generated natural-language values (language-checked). Add a case to `engine/test/core/validation-contract.test.js` that a Korean `note` in `ledgerOps` passes for a `ko` work and an English `feature` value is not language-checked.

Pass `tracking` through: `buildExtractDeltaUserPrompt` → `extractDeltaSchemaLines(labels, Boolean(bindHash), input.tracking)`; `extractionHashPayload` includes `tracking: input.tracking ?? null`; bump `EXTRACTION_CONTEXT_HASH_VERSION` to 2. In `src/tools/check-contract.js` add `tracking: ledgerConfig.tracking` to `extractionInput` (load `const ledgerConfig = await loadLedgerConfig(store, workId);` near `entities`).

- [ ] **Step 4: Run** `npm run test:engine` and `npm test`. Update prompt snapshot tests (`test/request-inputs.test.js` and any engine snapshot of the extraction prompt) to the new schema.

- [ ] **Step 5: Commit** — `feat(extract): ask for ledger ops of the enabled features`.

---

### Task 8: Tracking config and author items (`lore_configure`)

**Files:**
- Modify: `src/core/review-policy.js`, `src/tools/configure.js`, `src/server.js` (tool schema near line 137 and dispatch)
- Modify: `docs/TOOLS.md`, `docs/TOOLS.en.md`
- Test: `test/review-policy.test.js` (exists? if not, create) and `test/configure.test.js` (existing lore_configure tests — find them with `grep -rl runConfigureStatus test`)

**Interfaces:**
- Produces:
  - `saveWriterSupportPolicy(store, workId, { disabledReviews, disabledDraftSections, tracking, customTracking, mergeRecords })`
  - `loadLedgerConfig(store, workId) → { tracking, customTracking, merges }` (replaces the Task 6 stub; same shape)
  - `tracking`: object with boolean values for keys in `TRACKING_FEATURES`; unknown key → `INVALID_TRACKING_FEATURE`.
  - `customTracking`: array of `{ name, feature, pinned?, rules?, note? }`; ids assigned `u1…` in order, kept stable for names already present; invalid feature or rule type → `INVALID_CUSTOM_TRACKING`.
  - `mergeRecords`: array of `{ from, into }` appended to `merges` (deduplicated).
  - `lore_configure` args: `tracking`, `customTracking`, `mergeRecords`; result adds `tracking: { enabled, available }`, `customTracking`, `merges`.

- [ ] **Step 1: Write the failing test** (`test/review-policy.test.js`):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLedgerConfig, saveWriterSupportPolicy } from '../src/core/review-policy.js';

function memoryStore() {
  let policy = null;
  return { loadReviewPolicy: async () => policy, saveReviewPolicy: async (_w, next) => { policy = next; } };
}

test('stores tracking switches, author items with stable ids, and merges', async () => {
  const store = memoryStore();
  await saveWriterSupportPolicy(store, 'w', { tracking: { scheduled: false }, customTracking: [{ name: '금화', feature: 'objects', pinned: true, rules: [{ type: 'monotonic', field: 'amount', direction: 'down' }] }] });
  await saveWriterSupportPolicy(store, 'w', { customTracking: [{ name: '계절', feature: 'objects', pinned: true }, { name: '금화', feature: 'objects', pinned: true }], mergeRecords: [{ from: 'o3', into: 'o1' }] });
  const config = await loadLedgerConfig(store, 'w');
  assert.deepEqual(config.tracking, { scheduled: false });
  assert.deepEqual(config.customTracking.map((item) => [item.id, item.name]), [['u2', '계절'], ['u1', '금화']]);
  assert.deepEqual(config.merges, [{ from: 'o3', into: 'o1' }]);
  await assert.rejects(saveWriterSupportPolicy(store, 'w', { tracking: { genre: true } }), /INVALID_TRACKING_FEATURE/);
  await assert.rejects(saveWriterSupportPolicy(store, 'w', { customTracking: [{ name: 'x', feature: 'objects', rules: [{ type: 'magic' }] }] }), /INVALID_CUSTOM_TRACKING/);
});
```

- [ ] **Step 2: Run** `node --test test/review-policy.test.js` — Expected: FAIL.

- [ ] **Step 3: Implement** in `src/core/review-policy.js`:

```js
import { LEDGER_FEATURES, TRACKING_FEATURES } from '../../engine/src/continuity/ledger.js';

const RULE_TYPES = new Set(['monotonic', 'frozenAfter', 'speakerOnly']);

function checkedTracking(tracking) {
  const unknown = Object.keys(tracking).filter((key) => !TRACKING_FEATURES.includes(key));
  if (unknown.length) throw new Error(`INVALID_TRACKING_FEATURE: ${unknown.join(', ')} — 가능한 항목: ${TRACKING_FEATURES.join(', ')}`);
  return Object.fromEntries(Object.entries(tracking).map(([key, value]) => [key, value !== false]));
}

function checkedCustom(items, previous) {
  const taken = new Map((previous ?? []).map((item) => [item.name, item.id]));
  let next = Math.max(0, ...(previous ?? []).map((item) => Number(/^u(\d+)$/.exec(item.id)?.[1] ?? 0)));
  return items.map((item) => {
    if (typeof item?.name !== 'string' || !item.name.trim() || !LEDGER_FEATURES.includes(item.feature)
      || (item.rules ?? []).some((rule) => !RULE_TYPES.has(rule?.type))) {
      throw new Error(`INVALID_CUSTOM_TRACKING: ${JSON.stringify(item)} — feature는 ${LEDGER_FEATURES.join('|')}, rules.type은 ${[...RULE_TYPES].join('|')}`);
    }
    const id = taken.get(item.name.trim()) ?? `u${++next}`;
    return { id, name: item.name.trim(), feature: item.feature, ...(item.pinned ? { pinned: true } : {}),
      ...(item.rules?.length ? { rules: item.rules } : {}), ...(item.note ? { note: String(item.note) } : {}) };
  });
}

export async function loadLedgerConfig(store, workId) {
  const policy = await loadPolicy(store, workId);
  return { tracking: policy.tracking ?? {}, customTracking: policy.customTracking ?? [], merges: policy.merges ?? [] };
}
```

and extend `saveWriterSupportPolicy`:

```js
export async function saveWriterSupportPolicy(store, workId, { disabledReviews, disabledDraftSections, tracking, customTracking, mergeRecords } = {}) {
  const current = await loadPolicy(store, workId);
  const merges = [...(current.merges ?? [])];
  for (const merge of mergeRecords ?? []) {
    if (typeof merge?.from !== 'string' || typeof merge?.into !== 'string') throw new Error('INVALID_MERGE: {from, into} 기록 id가 필요합니다.');
    if (!merges.some((item) => item.from === merge.from && item.into === merge.into)) merges.push({ from: merge.from, into: merge.into });
  }
  const next = {
    disabled: disabledReviews === undefined ? (current.disabled ?? []) : checked(disabledReviews, OPTIONAL_REVIEWS, 'REVIEW'),
    draftSectionsOff: disabledDraftSections === undefined ? (current.draftSectionsOff ?? []) : checked(disabledDraftSections, OPTIONAL_DRAFT_SECTIONS, 'DRAFT_SECTION'),
    tracking: tracking === undefined ? (current.tracking ?? {}) : checkedTracking(tracking),
    customTracking: customTracking === undefined ? (current.customTracking ?? []) : checkedCustom(customTracking, current.customTracking),
    merges,
    updatedAt: new Date().toISOString(),
  };
  await store.saveReviewPolicy(workId, next);
  return next;
}
```

Remove the Task 6 stub. In `configure.js`, accept and forward `tracking`, `customTracking`, `mergeRecords` (call save when any is defined) and add to the result:

```js
    tracking: { enabled: Object.fromEntries(TRACKING_FEATURES.map((feature) => [feature, ledgerConfig.tracking[feature] !== false])), available: TRACKING_FEATURES },
    customTracking: ledgerConfig.customTracking,
    merges: ledgerConfig.merges,
```

In `src/server.js` `lore_configure` input schema add:

```js
      tracking: { type: 'object', properties: { objects: { type: 'boolean' }, knowledge: { type: 'boolean' }, scheduled: { type: 'boolean' }, hooks: { type: 'boolean' } }, additionalProperties: false,
        description: '추적 기능 켜기/끄기. 기본은 모두 켜짐. objects=물건·장소·단서·능력, knowledge=누가 무엇을 아는가, scheduled=일어나기로 된 일(회귀 전생 사건·예언·예약), hooks=떡밥.' },
      customTracking: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' }, feature: { type: 'string', enum: ['objects', 'knowledge', 'scheduled'] }, pinned: { type: 'boolean' },
        rules: { type: 'array', items: { type: 'object' } }, note: { type: 'string' } }, required: ['name', 'feature'] },
        description: '작가 정의 추적 항목 전체 목록(교체). pinned=매 화 입력에 항상 포함. rules: monotonic{field,direction:up|down,unless?}, frozenAfter{status}, speakerOnly{alias,by}; severity soft(기본)|hard. note=검토 모델에 보여줄 자연어 규칙(advisory).' },
      mergeRecords: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, into: { type: 'string' } }, required: ['from', 'into'] },
        description: '같은 대상으로 확인된 기록 병합(from을 into에 흡수). 다음 커밋부터 반영.' },
```

Document all three in `docs/TOOLS.md`/`docs/TOOLS.en.md` next to `disabledReviews`.

- [ ] **Step 4: Run** `node --test test/review-policy.test.js`, then `npm test`.

- [ ] **Step 5: Commit** — `feat(configure): tracking switches, author tracking items and record merges`.

---

### Task 9: Ledger renders for extract, writer, check and planner

**Files:**
- Modify: `src/core/prompt-sections.js` (`renderCurrentState`, `selectHooks`, `selectTracked` → `selectRecords`, `renderCheckSections`), `src/prompts/ko.js` & `src/prompts/multilingual.js` (`sections` phrases), `src/tools/episode-plan.js` (planner call), `src/tools/generate.js` and rewrite callers (pass history), `src/tools/context.js:167-183`
- Test: `test/prompt-sections.test.js` (existing — find with `grep -rl renderCurrentState test`), `test/long-run-inputs.test.js`, `test/fixtures/long-run-state.js`

**Interfaces:**
- Consumes: `recordNames`, `ledgerNameKey` (Task 2); `ledgerHistory` (Task 6); config (Task 8).
- Produces: `renderCurrentState(state, foundation, { cast, kit, mode, focusText, entities, hookIds, oldestHooks, config = {}, history = [] })`:
  - Records are selected by `selectRecords(records, focus, named, limit, { pinnedIds, now })`: rank 4 pinned custom item, 3 named by name or alias in focus, 2 held/known by a named character (any field value equal to a named id or `knownBy` containing it), 1 `lastEventAt >= now - 2`; caps: extract 30, writer 12, same `omitted`/`capped` lines.
  - Hooks: `selectHooks` adds `recent = Number(hook.lastMovedChapter) >= now - RECENT_HOOK_CHAPTERS + 1` (in addition to planted); only `open` hooks are listed; mode `planner` (new) also lists `dormant` hooks older than 10 chapters under a `dormantHooksHeading`, and `scheduled` records with status `pending`.
  - extract lines: `t.recordKeyed(id, label, name, aliasesText, status, fieldsText, lastEvent)`; `possibleDuplicateOf` adds `t.duplicateOf(id)`.
  - writer lines: `t.record(label, name, status, fieldsText)`; when `lastEventAt <= now - 20` and the record is selected, append `t.recordHistory(history events)` with `ledgerHistory(history, id, 5)`.
  - check mode: in the address section, speaker-only aliases `t.speakerAlias(name(by), text, recordName)`.
- New phrase keys in `sections` (ko / multilingual):
  - `recordsHeadingKeyed`: `'기록 (id로 갱신하세요):'` / `'Records (update them by id):'`
  - `recordKeyed`: `(id, label, name, aliases, status, fields, last) => \`- \\\`${id}\\\` [${label}] ${name}${aliases ? \` (별칭: ${aliases})\` : ''} · ${status}${fields ? \` · ${fields}\` : ''}${last ? \` · 최근: ${last}\` : ''}\`` / English equivalent with `aliases:` and `last:`
  - `duplicateOf`: `(id) => \`  (중복 후보: ${id})\`` / `(id) => \`  (possible duplicate of ${id})\``
  - `recordsHeading`: `'추적 중인 것:'` / `'Tracked:'`
  - `record`: `(label, name, status, fields) => \`- [${label}] ${name} · ${status}${fields ? \` · ${fields}\` : ''}\``
  - `recordHistory`: `(items) => \`  이력: ${items}\`` / `(items) => \`  history: ${items}\``
  - `historyItem`: `(chapter, event, note) => \`${chapter}화 ${event}${note ? \` ${note}\` : ''}\`` / `(chapter, event, note) => \`ch.${chapter} ${event}${note ? \` ${note}\` : ''}\``
  - `dormantHooksHeading`: `'잠복한 떡밥 (다시 꺼낼 수 있음):'` / `'Dormant hooks (may return):'`
  - `pendingHeading`: `'아직 일어나지 않은 예정 사건:'` / `'Scheduled events still pending:'`
  - `speakerAlias`: `(speaker, alias, name) => \`- "${alias}"는 ${speaker}만 쓰는 ${name}의 별칭\`` / `(speaker, alias, name) => \`- "${alias}" is ${speaker}'s own word for ${name}\``
  - `hookKeyed` changes its second argument from phase to status.

- [ ] **Step 1: Write the failing tests** (append to the prompt-sections test file):

```js
test('extract render lists records by id with aliases and a duplicate marker', () => {
  const state = { chapterNumber: 7, addressMap: { entries: {} }, relationships: [], hooks: [
    { id: 'h1', text: '누가 사슬을 박았나', status: 'open', plantedAtChapter: 2, lastMovedChapter: 6 },
    { id: 'h9', text: '다른 이야기', status: 'open', plantedAtChapter: 1, lastMovedChapter: 1 },
  ], ledger: { records: [
    { id: 'o1', feature: 'objects', label: '물건', name: '서명 쪽지', aliases: [{ text: '그 쪽지' }], status: 'active', fields: { holder: 'c2' }, lastEventAt: 5, recent: [{ chapter: 5, event: 'changed', note: '재서명' }] },
    { id: 'o3', feature: 'objects', label: '물건', name: '재서명된 쪽지', aliases: [], status: 'active', fields: {}, lastEventAt: 6, possibleDuplicateOf: 'o1', recent: [] },
  ] } };
  const text = renderCurrentState(state, foundation, { kit, mode: 'extract', focusText: '리아는 그 쪽지를 펼쳤다.' });
  assert.match(text, /`o1` \[물건\] 서명 쪽지 \(별칭: 그 쪽지\) · active/);
  assert.match(text, /`o3`.*\n  \(중복 후보: o1\)/);
  assert.match(text, /`h1`/); // moved in chapter 6: recent
  assert.doesNotMatch(text, /`h9`/);
});

test('writer render adds a short history for a record back after a long gap', () => {
  const state = { chapterNumber: 40, addressMap: { entries: {} }, relationships: [], hooks: [], ledger: { records: [
    { id: 'o1', feature: 'objects', label: '물건', name: '서명 쪽지', aliases: [], status: 'active', fields: {}, lastEventAt: 7, recent: [] },
  ] } };
  const history = [{ chapter: 4, target: 'record', id: 'o1', event: 'registered' }, { chapter: 5, target: 'record', id: 'o1', event: 'changed', note: '재서명' }];
  const text = renderCurrentState(state, foundation, { kit, mode: 'writer', focusText: '서명 쪽지를 다시 꺼낸다', history });
  assert.match(text, /이력: 4화 registered, 5화 changed 재서명/);
});

test('pinned author items are always listed', () => {
  const state = { chapterNumber: 9, addressMap: { entries: {} }, relationships: [], hooks: [], ledger: { records: [
    { id: 'u1', feature: 'objects', label: '', name: '금화', aliases: [], status: 'active', fields: { amount: '10닢' }, lastEventAt: 1, recent: [] },
  ] } };
  const config = { customTracking: [{ id: 'u1', name: '금화', feature: 'objects', pinned: true }] };
  assert.match(renderCurrentState(state, foundation, { kit, mode: 'writer', focusText: '아무 관련 없는 문장', config }), /금화/);
});
```

(`foundation` and `kit` are the fixtures the existing test file already builds; reuse them.)

- [ ] **Step 2: Run** the prompt-sections test file — Expected: FAIL.

- [ ] **Step 3: Implement** in `src/core/prompt-sections.js`:

```js
const RECENT_RECORD_CHAPTERS = 3;
const HISTORY_GAP = 20;
const DORMANT_AFTER = 10;

function recordText(record, name) {
  return Object.entries(record.fields ?? {}).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.map(name).join(', ') : name(String(value))}`).join('; ').slice(0, 160);
}

/** Pinned author items, then records the focus names, then records a named character holds or knows, then records with a recent event. */
function selectRecords(records, text, ids, limit, { pinnedIds = new Set(), now = NaN } = {}) {
  const ranked = records.map((record, index) => {
    const named = text && recordNames(record).some((name) => name.length >= 2 && text.includes(name));
    const held = Object.values(record.fields ?? {}).some((value) => (Array.isArray(value) ? value : [value]).some((item) => ids.has(item)));
    const recent = Number.isFinite(now) && Number(record.lastEventAt) >= now - RECENT_RECORD_CHAPTERS + 1;
    return { record, index, rank: pinnedIds.has(record.id) ? 4 : named ? 3 : held ? 2 : recent ? 1 : 0 };
  }).filter((item) => item.rank > 0)
    .sort((a, b) => b.rank - a.rank || (b.record.lastEventAt ?? 0) - (a.record.lastEventAt ?? 0) || b.index - a.index);
  const pinned = ranked.filter((item) => item.rank === 4);
  const others = ranked.filter((item) => item.rank < 4);
  const kept = [...pinned, ...others.slice(0, Math.max(0, limit - pinned.length))];
  return { shown: kept.map((item) => item.record), omitted: records.length - ranked.length, capped: ranked.length - kept.length };
}
```

In `renderCurrentState`, replace the tracked block with:

```js
    const records = asArray(state.ledger?.records).filter((record) => record.feature !== 'scheduled' || mode !== 'writer' || record.status === 'pending');
    const pinnedIds = new Set(asArray(config.customTracking).filter((item) => item.pinned).map((item) => item.id));
    const recordIds = mode === 'extract' ? named : castIds;
    const { shown, omitted, capped } = selectRecords(records, focus, recordIds, mode === 'extract' ? EXTRACT_TRACKED_LIMIT : WRITER_TRACKED_LIMIT, { pinnedIds, now });
    if (shown.length && mode === 'extract') {
      lines.push(t.recordsHeadingKeyed, ...shown.flatMap((record) => [
        t.recordKeyed(record.id, record.label || record.feature, record.name, asArray(record.aliases).map((alias) => alias.text).join(', '), record.status, recordText(record, name),
          record.recent?.length ? `${record.recent.at(-1).chapter} ${record.recent.at(-1).event}` : ''),
        ...(record.possibleDuplicateOf ? [t.duplicateOf(record.possibleDuplicateOf)] : []),
      ]));
    } else if (shown.length) {
      lines.push(t.recordsHeading, ...shown.flatMap((record) => {
        const past = Number(record.lastEventAt) <= now - HISTORY_GAP ? ledgerHistory(asArray(history), record.id, 5) : [];
        return [t.record(record.label || record.feature, record.name, record.status, recordText(record, name)),
          ...(past.length ? [t.recordHistory(past.map((event) => t.historyItem(event.chapter, event.event, event.note ?? '')).join(', '))] : [])];
      }));
    }
    if (capped > 0) lines.push(t.capped(capped));
    if (omitted - capped > 0) lines.push(t.omitted(omitted - capped));
```

Import `ledgerHistory` from `../tools/ledger-log.js` (pure function; if the import direction feels wrong, move `ledgerHistory` into `engine/src/continuity/ledger.js` and re-export it from `ledger-log.js` — do this, the engine owns ledger logic). Update `selectHooks` to mark `recent` by `lastMovedChapter` as specified, and filter hooks with `isHookActive`. Add mode `'planner'` to `MODES`: it behaves like `writer` and additionally pushes dormant hooks (`status === 'dormant' && now - lastMovedChapter >= DORMANT_AFTER`) and pending scheduled records under their headings. Remove the old `entities` block (`entitiesHeading`) — entity snapshots are records now; drop the `entities` option from callers (`check-contract.js:160`).

`renderCheckSections` — in the address section, append speaker-only aliases from `prevState.ledger.records` and `config.customTracking` `speakerOnly` rules (signature gains `config = {}`), using `t.speakerAlias`.

`src/tools/context.js:167-183`: `openHooks` stays `filter(isHookActive)`; `hookDebt` unchanged (uses `isHookActive`).

Callers: `episode-plan.js` passes `mode: 'planner'`; draft/rewrite callers in `generate.js` pass `history: await store.loadLedgerEvents(workId)` and `config: await loadLedgerConfig(store, workId)`; extract caller passes `config`.

Long-run guard: in `test/fixtures/long-run-state.js` build `ledger.records` instead of `trackedEntities` (three records per chapter with `lastEventAt: c`), keep the id `silver-key` record with name `은빛 열쇠`, and in `test/long-run-inputs.test.js` keep the existing needles (`은빛 열쇠`, `red-lamp`) and add: writer render at 1000 chapters with `history` of 5000 events stays under the same absolute cap as today, and a record named in focus with `lastEventAt` 30 chapters ago shows `이력:` with at most 5 items.

- [ ] **Step 4: Run** the prompt-sections tests, `node --test test/long-run-inputs.test.js`, `npm test`.

- [ ] **Step 5: Commit** — `feat(render): ledger records, recent hooks and history for returning records`.

---

### Task 10: Checks use the ledger

**Files:**
- Modify: `src/tools/check-contract.js:82-85, 156-176`
- Test: `test/check-contract.test.js` (existing — find the file that tests `DESTROYED_ENTITY_MENTION` with `grep -rl DESTROYED_ENTITY_MENTION test`)

**Interfaces:**
- Consumes: `reviewLedgerOps`, `ledgerStep` (engine), `loadLedgerConfig`.
- Produces: check result violations include `reviewLedgerOps` findings and `ledgerStep` findings; `base.delta.ledgerOps` is the reviewed op list (paid downgraded); `scanDestroyedEntityMentions` is no longer called here (the review covers it from the ledger).

- [ ] **Step 1: Write the failing test** (in the found check test file, reuse its work fixture and fake extraction answer helper):

```js
test('a paid hook without a quote is stored as advanced and reported', async () => {
  const result = await checkWithExtraction({ // existing helper in this test file that runs runContractCheck with a canned extraction answer
    ledgerOps: [{ op: 'hook', id: 'h1', event: 'paid', evidence: '본문에 없는 문장' }],
  }, { prevState: { hooks: [{ id: 'h1', text: '누가', status: 'open' }] } });
  assert.equal(result.delta.ledgerOps[0].event, 'advanced');
  assert.ok(result.violations.some((v) => v.code === 'HOOK_PAID_WITHOUT_EVIDENCE' && v.severity === 'soft'));
});

test('changing a destroyed record is a hard violation', async () => {
  const result = await checkWithExtraction({ ledgerOps: [{ op: 'event', id: 'o2', event: 'changed', set: { state: '수리' } }] },
    { prevState: { ledger: { records: [{ id: 'o2', feature: 'objects', label: '물건', name: '낡은 검', aliases: [], status: 'destroyed', fields: {}, recent: [] }] } } });
  assert.ok(result.violations.some((v) => v.code === 'LEDGER_UPDATE_AFTER_DESTROY' && v.severity === 'hard'));
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement** in `check-contract.js`:
  - Near line 82: `const ledgerConfig = await loadLedgerConfig(store, workId);` and `const prevState = normalizeStoryState(loaded ?? emptyStoryState(workId), { entities })` (move the `prevState` load up; keep `entities` only for seeding).
  - Remove `scan.violations.push(...scanDestroyedEntityMentions(...))`.
  - After `state.extracted` is set (line ~172, before `base.delta = ...`), once per extraction:

```js
      const reviewed = reviewLedgerOps({ state: prevState, ops: extracted.delta.ledgerOps ?? [], prose: input.prose,
        cast: extracted.delta.appearedCharacterIds ?? [], config: ledgerConfig });
      extracted.delta = { ...extracted.delta, ledgerOps: reviewed.ops };
      extracted.ledgerFindings = [...reviewed.violations, ...ledgerStep(prevState, extracted.delta, { config: ledgerConfig }).violations];
```

  - After `base.delta = state.extracted.delta;` add `base.violations.push(...(state.extracted.ledgerFindings ?? []).map((v) => ({ ...v, chapterNumber: chapter })));`
  - `renderCheckSections(...)` gets `config: ledgerConfig`.

- [ ] **Step 4: Run** the check test file, `npm test`.

- [ ] **Step 5: Commit** — `feat(check): ledger transition, evidence and alias findings`.

---

### Task 11: Author natural-language rules as advisory (coherence review)

**Files:**
- Modify: `engine/src/generators/text/steps/coherence-judge.js`, `src/tools/workflow.js:587-591`, the receipt/advisory mapping where `coherence` is reported (`grep -n "coherence" src/tools/workflow.js`)
- Test: `engine/test/generators/coherence-judge.test.js` (existing or create next to other step tests)

**Interfaces:**
- Produces: `runCoherenceJudge(input)` accepts `authorRules: string[]`; when non-empty, the prompt adds a section and the output JSON may contain `authorRules: [{ rule, verdict: 'pass'|'warn'|'fail', evidence }]`; the result is `{ score, reason, authorRules? }`. In the workflow, each `warn|fail` becomes an advisory `{ severity: 'soft', code: 'AUTHOR_RULE', message: `${rule}: ${evidence}` }`. Turning off `coherence-judge` turns these off.

- [ ] **Step 1: Write the failing test**:

```js
it('asks about author rules and returns their verdicts', async () => {
    let seen = '';
    const providers = { complete: async (req) => { seen = req.messages.at(-1).content; return { text: JSON.stringify({ score: 80, reason: 'ok', authorRules: [{ rule: '리아는 어머니 이야기를 먼저 꺼내지 않는다', verdict: 'fail', evidence: '"엄마가…"' }] }) }; } };
    const out = await runCoherenceJudge({ prose: '본문', chapterNumber: 3, plan: '', prevSummary: '', writerModel: {}, providers, authorRules: ['리아는 어머니 이야기를 먼저 꺼내지 않는다'] });
    expect(seen).toContain('리아는 어머니 이야기를 먼저 꺼내지 않는다');
    expect(out.authorRules[0].verdict).toBe('fail');
});
```

(Match the provider response shape the existing step tests use — read one of them first.)

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**: add labels `authorRules` (ko `'## 작가 점검 규칙 (각각 pass|warn|fail과 본문 근거)'`, en `'## Author rules (pass|warn|fail each, with evidence from the chapter)'`); when `input.authorRules?.length`, push the heading and `- ${rule}` lines before `request`, and extend the output instruction with `, "authorRules": [{ "rule": "...", "verdict": "pass|warn|fail", "evidence": "..." }]`. Parse: keep entries whose `verdict` is one of the three. In `workflow.js` pass `authorRules: ledgerConfig.customTracking.map((item) => item.note).filter(Boolean)` and push advisories as specified.

- [ ] **Step 4: Run** engine tests and `npm test`.

- [ ] **Step 5: Commit** — `feat(review): author rules as advisory findings of the coherence review`.

---

### Task 12: Memory index and the remaining readers

**Files:**
- Modify: `src/tools/memory-index.js:30-40`, any file listed by the consumer inventory (below) that still reads `trackedEntities`, `phase`, or `loadEntitySnapshots` for content.
- Test: `test/memory-index.test.js` (existing)

**Interfaces:**
- Produces: memory documents of scope `record` (text = name, aliases, label, fields) and scope `event` (text = note) from `store.loadLedgerEvents`; no `entity` scope reading `entities.json`.

- [ ] **Step 1: Write the failing test** — a work whose ledger has `서명 쪽지` and an event note `새벽 재서명`; `retrieveMemory` for the query `재서명` returns an item with `scope: 'event'` and `ref: 'o1'`.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement** in `rebuildMemoryIndex`: replace the entity loop (line 39) with:

```js
    const latest = normalizeStoryState(await store.loadStoryState(workId, chapters.at(-1) ?? 0), { entities: await store.loadEntitySnapshots(workId) });
    for (const record of latest?.ledger?.records ?? []) {
      insert.run('record', record.id, record.registeredAt ?? 0, [record.name, ...(record.aliases ?? []).map((a) => a.text), record.label, JSON.stringify(record.fields ?? {})].join(' '));
    }
    for (const event of await store.loadLedgerEvents(workId)) {
      if (event.note) insert.run('event', event.id ?? `chapter-${event.chapter}`, event.chapter, event.note);
    }
```

(Use the variable names `rebuildMemoryIndex` already has for the chapter list and the statement.) Bump the index revision constant if the file has one so old indexes rebuild.

Then convert the remaining readers (from the consumer inventory):
- `src/tools/commit.js` `runStatus` L359: `openHooks: state.hooks.filter(isHookActive).map((h) => h.text || h.id)` (it listed paid and parked hooks as open); read the state through `normalizeStoryState`.
- `src/tools/context.js` L102 (mandatory promises), L166-173, L214 (`openHooks` meta must count `isHookActive` only), L270: read through `normalizeStoryState`; no other change.
- `engine/src/core/planning-authority.js` L133-135: unchanged logic, but it receives a normalized state; confirm with its test.
- `engine/src/continuity/continuity-check.js` `continuityStateSummary` L444-457 (used when no `prevStateRender` is given): replace `trackedEntities` / `knownEntities` with `records: state.ledger.records.slice(-30).map(({ id, feature, label, name, status }) => ({ id, feature, label, name, status }))` and hooks `{ id, text, status }`; delete `recentTrackedEntities`.
- `engine/src/generators/text/steps/draft.js` L423 `recentTrackedRecords(prevState.trackedEntities)` → the last 12 ledger records by `lastEventAt` as `{ id, label, name, status, fields }`.
- `src/core/prompt-sections.js` `renderCheckSections` L433-439: `deltaTracked` over `delta.ledgerOps` (register/event ops) and prior values of touched records by id via `findRecord`; rename phrase keys `deltaTracked` → `deltaLedger` in both phrase tables.
- `engine/src/core/sentinel-schema.js` `hookOpsV1Schema`/`entityOpsV1Schema` are unused but publicly exported from `engine/src/index.js`; leave them (public interface) and note them for the user.

- [ ] **Step 4: Run** `npm test`, `npm run test:engine`; `grep -rn "trackedEntities\|\.phase\b\|loadEntitySnapshots" src engine/src` must show only: story-state legacy conversion, ledger legacy conversion, `rebuildLedgerLog`/commit/check seeding, memory index seeding, snapshots `machineEntries`.

- [ ] **Step 5: Commit** — `refactor: read records and hooks from the ledger everywhere`.

---

### Task 13: Genre tracked kinds removed

Scope note: `genreProfile.invariants` stays this round. Stored foundations carry them, the writer/check/revise prompts read them (`prompt-sections.js:90,435`, `continuity-check.js:1144,1529`, `steps/draft.js:409`, `rewrite.js:72`, `revise.js:161-176`) and `src/core/approval-language-gate.js:196-197` requires the stored profile to equal the registry entry, so emptying them would break approval of existing works. Turning genre invariants into default author rules is a follow-up to raise with the user. `genreProfile.trackedEntities` is read by nothing (inventory), so it goes now.

**Files:**
- Modify: `engine/src/continuity/genre-profile.js`, `engine/src/continuity/genre-facets.js`, `src/core/approval-language-gate.js:196-197`
- Test: `engine/test/continuity/genre-profile.test.js`, `genre-facets.test.js`, the approval gate test (`grep -rl "genreProfile" test | xargs grep -l approval`)

**Interfaces:**
- Produces: registry profiles have `trackedEntities: []`; `GENRE_FACETS[*].trackedAxes` removed. The approval gate compares the profile ignoring `trackedEntities` so foundations stored with the old lists still pass.

- [ ] **Step 1: Update tests first**: assertions expecting regression/romance/power/mystery entity lists now expect `[]`; `trackedAxes` assertions are removed; add a gate test: a stored foundation whose `genreProfile.trackedEntities` holds the old regression list still passes the approval gate.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**: delete `REGRESSION_ENTITIES`, `ROMANCE_ENTITIES`, `POWER_ENTITIES`, `MYSTERY_ENTITIES` and set `trackedEntities: []` in every profile (keep the invariant constants and families); remove `trackedAxes` and the POWER/REGRESSION/ROMANCE/MYSTERY axis constants from `genre-facets.js`; in the approval gate compare `{ ...stored, trackedEntities: [] }` with the registry entry.

- [ ] **Step 4: Run** `npm run test:engine`, `npm test`.

- [ ] **Step 5: Commit** — `refactor(genre): tracking no longer depends on the genre`.

---

### Task 14: Migration of existing works and merge candidates

**Files:**
- Create: `src/tools/ledger-migration.js`
- Modify: `src/prompts/ko.js`, `src/prompts/multilingual.js` (step `'ledger-merge'`), `src/core/model-profile.js` (map `ledger-merge` → `review`), `src/tools/workflow.js` (call before planning, like `ensureArcSummaries`), `src/tools/configure.js` (show candidates)
- Test: `test/ledger-migration.test.js`

**Interfaces:**
- Consumes: `rebuildLedgerLog`, `normalizeStoryState`, `loadLedgerConfig`, `saveWriterSupportPolicy`.
- Produces:
  - `ensureLedgerLog({ store, workId })` — rebuilds the log when absent or stale (deterministic, no model).
  - `proposeLedgerMerges({ store, workId, providers, kit }) → { status: 'pending'|'done'|'none', candidates: [{ into, from: string[], reason }] }` — one model request with the latest ledger (id, label, name, aliases, status, 2 fields) per feature; answers are validated (ids must exist, same feature, `into ∉ from`); saved to `.vibelore/ledger/merge-candidates.json` (store methods `loadMergeCandidates`/`saveMergeCandidates`); asked once per ledger digest (sha256 of record ids+names) so the same ledger is not asked twice.
  - `lore_configure` result shows `mergeCandidates`; the user approves with `mergeRecords`.

- [ ] **Step 1: Write the failing test**:

```js
test('proposes merges once per ledger and keeps only valid groups', async () => {
  const { store, workId } = await legacyWorkWithDuplicates(); // fixture: two chapters whose tracked ops name '서명 쪽지' and '재서명된 쪽지', plus '은빛 열쇠' as knowledge
  let asked = 0;
  const providers = { complete: async () => { asked += 1; return { text: JSON.stringify({ groups: [
    { into: 'o1', from: ['o2'], reason: '같은 쪽지' },
    { into: 'o1', from: ['k1'], reason: '기능이 다름' },
    { into: 'o9', from: ['o1'], reason: '없는 id' } ] }) }; } };
  const first = await proposeLedgerMerges({ store, workId, providers, kit });
  assert.deepEqual(first.candidates, [{ into: 'o1', from: ['o2'], reason: '같은 쪽지' }]);
  await proposeLedgerMerges({ store, workId, providers, kit });
  assert.equal(asked, 1);
});
```

(`legacyWorkWithDuplicates` goes in `test/fixtures/ledger-works.js`; build it with the same temp-work helper used in Task 6, saving legacy deltas with `trackedEntityOps` and a matching `story-state` file without `ledger`.)

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement** `src/tools/ledger-migration.js` with the two functions above. Prompt step `'ledger-merge'` in both families: system ko `'이야기 기록 목록에서 같은 대상을 다른 이름으로 적은 기록끼리 묶는다. 확실한 것만 묶고, 같은 기능(feature) 안에서만 묶는다. 순수 JSON만 출력한다.'` (multilingual equivalent), user `기록:\n${recordsText}\nJSON: {"groups":[{"into":"id","from":["id"],"reason":""}]}`. In `workflow.js`, before planning (where `ensureArcSummaries` runs) call `ensureLedgerLog`; call `proposeLedgerMerges` only in `guided` mode and only when the ledger has a `possibleDuplicateOf` record or the log was just built from a legacy work; its pending request joins the same host round trip; failure never blocks the chapter (record `long_memory_incomplete`-style event `ledger_merge_incomplete`).

- [ ] **Step 4: Run** `node --test test/ledger-migration.test.js`, `npm test`.

- [ ] **Step 5: Scratch dry run (no commit of works)**: copy `works/thundertrail`, `works/verdict-live`, `works/executionprincess` to the scratchpad with the same `rsync` excludes used for the recall measurement (webtoon, model-exchanges, publication, snapshots, rollback-archives, production*, output, *.zip), run `rebuildLedgerLog` on each copy, and write a short report: records per feature, hooks per status, `possibleDuplicateOf` count, and 5 example histories. Show it to the user before any real work is touched.

- [ ] **Step 6: Commit** — `feat(ledger): migrate existing works and propose record merges`.

---

### Task 15: Docs, changelog, review

**Files:**
- Modify: `docs/OPERATIONS.md` (+`.en.md`): ledger, history log, tracking switches, author items, merges, what counts as hard.
- Modify: `docs/ARCHITECTURE.md` (+`.en.md`): StoryState section (ledger replaces trackedEntities/entities.json).
- Modify: `CHANGELOG.md` `## Unreleased` (python anchor insert at the top of the section, as before).
- Modify: the spec — correct the rollback claim about `entities.json`, note merges via `lore_configure(mergeRecords)`, the two-way speaker alias check, and that the chapter deltas are the source and `events.jsonl` is rebuilt from them.

- [ ] **Step 1:** Write the docs and changelog entries (user-facing: what the writer can now do and configure; no internal jargon beyond tool arguments).
- [ ] **Step 2:** Run `npm test`, `npm run test:engine`, `npm run check:source`.
- [ ] **Step 3:** Commit — `docs: story ledger, history and tracking settings`.
- [ ] **Step 4:** Codex review from both angles, as last time: `codex exec -m gpt-6-sol -c model_reasoning_effort=high -s workspace-write -C /Users/lyoojk/vibelore -o <out> - < prompt` for a prompt-engineer review and a developer review of the range from the spec commit to HEAD; triage, fix accepted items, report to the user.
