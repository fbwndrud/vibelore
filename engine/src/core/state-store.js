/**
 * StateStore — persistence for Foundation, StoryState, ChapterArtifact and job records.
 *
 * FileStateStore provides a filesystem implementation for standalone use and
 * fixtures. Hosts can supply other implementations without adding a database
 * dependency to this package.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeStoryState } from '../continuity/story-state.js';
/**
 * Filesystem-backed impl. Layout under `rootDir`:
 *   `<workId>/foundation.json`
 *   `<workId>/story-state/<chapter>.json`
 *   `<workId>/artifacts/<chapter>.json`
 *   `<workId>/jobs/<jobId>.json`
 */
/**
 * Filesystem-safe identifier pattern. Restricts to characters that survive
 * round-tripping through path components without escaping concerns. The same
 * pattern guards `jobId` to keep `<workId>/jobs/<jobId>.json` predictable.
 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
function assertSafeWorkId(workId) {
    if (typeof workId !== 'string' || workId.length === 0 || !SAFE_ID.test(workId)) {
        throw new Error(`FileStateStore: invalid workId ${JSON.stringify(workId)} (must match [A-Za-z0-9_-]+)`);
    }
}
function assertSafeJobId(jobId) {
    if (typeof jobId !== 'string' || jobId.length === 0 || !SAFE_ID.test(jobId)) {
        throw new Error(`FileStateStore: invalid jobId ${JSON.stringify(jobId)} (must match [A-Za-z0-9_-]+)`);
    }
}
async function readJsonOrNull(path) {
    try {
        const raw = await readFile(path, 'utf8');
        return JSON.parse(raw);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return null;
        throw err;
    }
}
/**
 * Atomic-ish write: serialize → write to `<path>.tmp` → rename. POSIX rename
 * over the same filesystem is atomic, so a partially written `.tmp` never
 * leaves a half-written `path`. Parent dir is created on demand.
 */
async function writeJsonAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, path);
}
export class FileStateStore {
    rootDir;
    constructor(rootDir) {
        this.rootDir = rootDir;
    }
    foundationPath(workId) {
        return join(this.rootDir, workId, 'foundation.json');
    }
    storyStatePath(workId, chapterNumber) {
        return join(this.rootDir, workId, 'story-state', `${chapterNumber}.json`);
    }
    artifactPath(workId, chapterNumber) {
        return join(this.rootDir, workId, 'artifacts', `${chapterNumber}.json`);
    }
    jobPath(workId, jobId) {
        return join(this.rootDir, workId, 'jobs', `${jobId}.json`);
    }
    async loadFoundation(workId) {
        assertSafeWorkId(workId);
        return readJsonOrNull(this.foundationPath(workId));
    }
    async saveFoundation(foundation) {
        assertSafeWorkId(foundation.workId);
        await writeJsonAtomic(this.foundationPath(foundation.workId), foundation);
    }
    async loadStoryState(workId, chapterNumber) {
        assertSafeWorkId(workId);
        return normalizeStoryState(await readJsonOrNull(this.storyStatePath(workId, chapterNumber)));
    }
    async saveStoryState(state) {
        assertSafeWorkId(state.workId);
        await writeJsonAtomic(this.storyStatePath(state.workId, state.chapterNumber), state);
    }
    async loadArtifact(workId, chapterNumber) {
        assertSafeWorkId(workId);
        return readJsonOrNull(this.artifactPath(workId, chapterNumber));
    }
    async saveArtifact(artifact) {
        assertSafeWorkId(artifact.workId);
        await writeJsonAtomic(this.artifactPath(artifact.workId, artifact.chapterNumber), artifact);
    }
    async loadJob(jobId) {
        assertSafeJobId(jobId);
        // jobs are scoped under `<workId>/jobs/<jobId>.json`; without an index the
        // file layout is read by scanning known work dirs. For T1.2 the convention
        // is "the caller knows the workId because saveJob stores it"; we therefore
        // keep a flat side-index under `<rootDir>/.jobs/<jobId>.json` that mirrors
        // the canonical record. That keeps load by jobId O(1) without requiring a
        // workId argument.
        return readJsonOrNull(this.jobIndexPath(jobId));
    }
    async saveJob(job) {
        assertSafeWorkId(job.workId);
        assertSafeJobId(job.id);
        await writeJsonAtomic(this.jobPath(job.workId, job.id), job);
        // Mirror under the flat index so `loadJob(jobId)` works without workId.
        await writeJsonAtomic(this.jobIndexPath(job.id), job);
    }
    jobIndexPath(jobId) {
        return join(this.rootDir, '.jobs', `${jobId}.json`);
    }
    // — ChapterSummary (ADR-0001 / #215) ————————————————————————————————
    summaryPath(workId, chapterNumber) {
        return join(this.rootDir, workId, 'summaries', `${chapterNumber}.json`);
    }
    summariesDir(workId) {
        return join(this.rootDir, workId, 'summaries');
    }
    async saveChapterSummary(record) {
        assertSafeWorkId(record.workId);
        await writeJsonAtomic(this.summaryPath(record.workId, record.chapterNumber), record);
    }
    async loadEntitySnapshots(_workId) {
        // FileStateStore 는 entity persistence layer 가 없음 — 기본 빈 list 반환.
        // 통합 테스트에서 fixture 추가 시 별도 mock impl 사용.
        return [];
    }
    async loadRecentChapterSummaries(workId, beforeChapter, limit) {
        assertSafeWorkId(workId);
        if (limit <= 0)
            return [];
        const dir = this.summariesDir(workId);
        let entries;
        try {
            const { readdir } = await import('node:fs/promises');
            entries = await readdir(dir);
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return [];
            throw err;
        }
        const numbers = entries
            .map((name) => Number(name.replace(/\.json$/, '')))
            .filter((n) => Number.isInteger(n) && n > 0 && n < beforeChapter)
            .sort((a, b) => b - a)
            .slice(0, limit);
        const out = [];
        for (const n of numbers) {
            const rec = await readJsonOrNull(this.summaryPath(workId, n));
            if (rec)
                out.push(rec);
        }
        return out;
    }
}
