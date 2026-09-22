/**
 * MemoryStateStore — in-memory implementation of the StateStore port.
 *
 * Mirrors `FileStateStore` (`./state-store.js`) contract + semantics without
 * touching disk:
 *   - Same `workId`/`jobId` validation (`/^[A-Za-z0-9_-]+$/`, throws on
 *     violation) as `FileStateStore`'s `assertSafeWorkId`/`assertSafeJobId`.
 *   - `load*` returns `null` when nothing has been written for that key
 *     (mirrors the ENOENT→null behavior of `FileStateStore`).
 *   - `loadStoryState`/`loadArtifact` are scoped exactly to
 *     `(workId, chapterNumber)` — an unwritten chapter on a known work
 *     returns `null`, never a neighbouring chapter.
 *   - `saveJob` requires both a safe `workId` and a safe `id` (matches
 *     `FileStateStore.saveJob`'s dual assert order).
 *   - `loadRecentChapterSummaries(workId, beforeChapter, limit)` returns
 *     summaries with `chapterNumber < beforeChapter`, newest-first, capped at
 *     `limit` (identical ordering/filter to `FileStateStore`'s directory
 *     scan + sort).
 *   - `loadEntitySnapshots(workId)` ignores `workId` entirely (no
 *     assertion, no filtering) — same as `FileStateStore`, which always
 *     returns `[]` regardless of the argument. Here it returns whatever was
 *     injected via the constructor's `entitySnapshots` option (default `[]`).
 *
 * Every stored/returned value is deep-cloned via a JSON round-trip so the
 * semantics (drops `undefined`/functions/symbols, no shared references)
 * match "write JSON to disk, read JSON back" exactly — external mutation of
 * a value passed to `save*` or returned from `load*` never reaches the
 * store's internal state.
 *
 * Intended for tests / ephemeral runs that want the StateStore contract
 * without filesystem I/O.
 */

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function assertSafeWorkId(workId) {
    if (typeof workId !== 'string' || workId.length === 0 || !SAFE_ID.test(workId)) {
        throw new Error(`MemoryStateStore: invalid workId ${JSON.stringify(workId)} (must match [A-Za-z0-9_-]+)`);
    }
}

function assertSafeJobId(jobId) {
    if (typeof jobId !== 'string' || jobId.length === 0 || !SAFE_ID.test(jobId)) {
        throw new Error(`MemoryStateStore: invalid jobId ${JSON.stringify(jobId)} (must match [A-Za-z0-9_-]+)`);
    }
}

/**
 * JSON-round-trip clone. Chosen over a hand-rolled structural clone so the
 * observable semantics match `FileStateStore` (which really does serialize
 * to JSON and parse it back) — e.g. `undefined` properties disappear,
 * functions/symbols are dropped, and every returned object is a fresh
 * reference.
 */
function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

export class MemoryStateStore {
    constructor(options = {}) {
        const { entitySnapshots = [] } = options ?? {};
        this._entitySnapshots = deepClone(entitySnapshots);
        this._foundations = new Map();
        this._storyStates = new Map();
        this._artifacts = new Map();
        this._jobs = new Map();
        this._summaries = new Map();
    }

    async loadFoundation(workId) {
        assertSafeWorkId(workId);
        const rec = this._foundations.get(workId);
        return rec === undefined ? null : deepClone(rec);
    }

    async saveFoundation(foundation) {
        assertSafeWorkId(foundation.workId);
        this._foundations.set(foundation.workId, deepClone(foundation));
    }

    /** Returns the snapshot committed *after* `chapterNumber` was written. */
    async loadStoryState(workId, chapterNumber) {
        assertSafeWorkId(workId);
        const perWork = this._storyStates.get(workId);
        if (!perWork) return null;
        const rec = perWork.get(chapterNumber);
        return rec === undefined ? null : deepClone(rec);
    }

    async saveStoryState(state) {
        assertSafeWorkId(state.workId);
        let perWork = this._storyStates.get(state.workId);
        if (!perWork) {
            perWork = new Map();
            this._storyStates.set(state.workId, perWork);
        }
        perWork.set(state.chapterNumber, deepClone(state));
    }

    async loadArtifact(workId, chapterNumber) {
        assertSafeWorkId(workId);
        const perWork = this._artifacts.get(workId);
        if (!perWork) return null;
        const rec = perWork.get(chapterNumber);
        return rec === undefined ? null : deepClone(rec);
    }

    async saveArtifact(artifact) {
        assertSafeWorkId(artifact.workId);
        let perWork = this._artifacts.get(artifact.workId);
        if (!perWork) {
            perWork = new Map();
            this._artifacts.set(artifact.workId, perWork);
        }
        perWork.set(artifact.chapterNumber, deepClone(artifact));
    }

    async loadJob(jobId) {
        assertSafeJobId(jobId);
        const rec = this._jobs.get(jobId);
        return rec === undefined ? null : deepClone(rec);
    }

    async saveJob(job) {
        assertSafeWorkId(job.workId);
        assertSafeJobId(job.id);
        this._jobs.set(job.id, deepClone(job));
    }

    // — ChapterSummary (ADR-0001 / #215) ————————————————————————————————

    /** ADR-0001 — upsert one summary row keyed by (workId, chapterNumber). */
    async saveChapterSummary(record) {
        assertSafeWorkId(record.workId);
        let perWork = this._summaries.get(record.workId);
        if (!perWork) {
            perWork = new Map();
            this._summaries.set(record.workId, perWork);
        }
        perWork.set(record.chapterNumber, deepClone(record));
    }

    /**
     * ADR-0001 — return the most recent N chapter summaries ordered by
     * chapterNumber DESC (newest first), with chapterNumber < beforeChapter,
     * capped at `limit`. Mirrors `FileStateStore.loadRecentChapterSummaries`.
     */
    async loadRecentChapterSummaries(workId, beforeChapter, limit) {
        assertSafeWorkId(workId);
        if (limit <= 0) return [];
        const perWork = this._summaries.get(workId);
        if (!perWork) return [];
        const numbers = [...perWork.keys()]
            .filter((n) => Number.isInteger(n) && n > 0 && n < beforeChapter)
            .sort((a, b) => b - a)
            .slice(0, limit);
        return numbers.map((n) => deepClone(perWork.get(n)));
    }

    /**
     * ADR-0002 / ADR-0004 (#216 / #217) — return all registered world-entity
     * snapshots. `workId` is accepted for interface parity but is not
     * validated or filtered on — same as `FileStateStore`, which always
     * returns `[]` regardless of the argument. Returns the array injected
     * via the constructor's `entitySnapshots` option (default `[]`).
     */
    async loadEntitySnapshots(_workId) {
        return deepClone(this._entitySnapshots);
    }
}
