/**
 * MemoryStateStore round-trip + safety tests (T1.2 port).
 *
 * Mirrors `test/core/state-store.test.js` (FileStateStore) semantics —
 * round-trip equality, chapter scoping, null-on-unwritten, unsafe-id
 * rejection — plus MemoryStateStore-specific coverage: constructor-injected
 * `entitySnapshots`, deep-clone isolation (save-side and load-side), and
 * `loadRecentChapterSummaries` ordering/limit. Uses node:test + node:assert
 * directly — no vitest shim needed for an in-memory store with no build
 * step to gate on.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryStateStore } from '../../src/core/memory-state-store.js';

const SAMPLE_PROFILE = {
    genre: 'streaming-litrpg',
    trackedEntities: [],
    invariants: [],
};

function makeFoundation(workId) {
    return {
        workId,
        genre: 'streaming-litrpg',
        worldFacts: [
            { id: 'wf1', statement: '세계는 마나로 돌아간다', registeredAtChapter: 1 },
        ],
        characters: [
            {
                id: 'c1',
                canonicalName: '주인공',
                aliases: ['mc'],
                registeredAtChapter: 1,
                intrinsic: {
                    gender: 'male',
                    ageBand: '20대초반',
                    role: '주인공',
                    coreAppearance: ['검은머리'],
                },
                mutable: { status: 'alive', knownFacts: [] },
                relationships: [],
            },
        ],
        intrinsicChanges: [],
        genreProfile: SAMPLE_PROFILE,
    };
}

function makeStoryState(workId, chapter) {
    return {
        workId,
        chapterNumber: chapter,
        addressMap: {
            entries: {
                'c1->c2': { term: `term-${chapter}`, sinceChapter: chapter, register: 'formal' },
            },
        },
        relationships: [{ to: 'c2', kind: '동료', state: '동맹' }],
        hooks: [
            {
                id: `hook-${chapter}`,
                text: '복선',
                plantedAtChapter: chapter,
                phase: 'planted',
                lastMovedChapter: chapter,
            },
        ],
        trackedEntities: [{ kind: 'Timeline', data: { era: 'now' } }],
    };
}

function makeArtifact(workId, chapter) {
    return {
        workId,
        chapterNumber: chapter,
        prose: `chapter ${chapter} prose line 1\n다음 줄`,
        delta: {
            chapterNumber: chapter,
            appearedCharacterIds: ['c1'],
            newAddressEntries: [
                { speakerId: 'c1', targetId: 'c2', term: '도련님', register: 'formal' },
            ],
            relationshipOps: [],
            hookChanges: [],
            mutableChanges: [{ characterId: 'c1', location: '수도', knownFactsAdded: ['진실'] }],
            trackedEntityOps: [],
        },
    };
}

function makeJob(workId, jobId) {
    return {
        id: jobId,
        workId,
        kind: 'chapter-write',
        status: 'completed',
        phase: 'done',
        createdAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:01.000Z',
    };
}

function makeSummary(workId, chapter) {
    return {
        workId,
        chapterNumber: chapter,
        summary: `요약 ${chapter}`,
        plotBeat: chapter % 2 === 0 ? 'rising' : null,
        sceneTags: ['대화'],
        povCharacter: 'c1',
        registeredEntities: [],
    };
}

describe('MemoryStateStore', () => {
    it('Foundation round-trips with full deep equality', async () => {
        const store = new MemoryStateStore();
        const foundation = makeFoundation('work_abc-123');
        await store.saveFoundation(foundation);
        const loaded = await store.loadFoundation('work_abc-123');
        assert.deepStrictEqual(loaded, foundation);
    });

    it('StoryState round-trips per chapter and isolates chapters', async () => {
        const store = new MemoryStateStore();
        const workId = 'work_xyz';
        const s1 = makeStoryState(workId, 1);
        const s2 = makeStoryState(workId, 2);

        await store.saveStoryState(s1);
        await store.saveStoryState(s2);

        const loaded1 = await store.loadStoryState(workId, 1);
        const loaded2 = await store.loadStoryState(workId, 2);
        assert.deepStrictEqual(loaded1, s1);
        assert.deepStrictEqual(loaded2, s2);
        // 기록되지 않은 챕터는 근접값이 아닌 null — 챕터 스코핑은 정확히 일치해야 함.
        const loaded3 = await store.loadStoryState(workId, 3);
        assert.strictEqual(loaded3, null);
    });

    it('ChapterArtifact round-trip preserves prose + structured delta', async () => {
        const store = new MemoryStateStore();
        const workId = 'work_artifact';
        const artifact = makeArtifact(workId, 5);
        await store.saveArtifact(artifact);

        const loaded = await store.loadArtifact(workId, 5);
        assert.deepStrictEqual(loaded, artifact);
        assert.strictEqual(loaded?.prose, artifact.prose);
        assert.deepStrictEqual(loaded?.delta, artifact.delta);
    });

    it('EngineJob round-trip preserves status, phase, and timestamps as strings', async () => {
        const store = new MemoryStateStore();
        const job = makeJob('work_job', 'job_42');
        await store.saveJob(job);
        const loaded = await store.loadJob('job_42');
        assert.deepStrictEqual(loaded, job);
        assert.strictEqual(typeof loaded?.createdAt, 'string');
        assert.strictEqual(typeof loaded?.updatedAt, 'string');
    });

    it('load* returns null when nothing has been written (no throw)', async () => {
        const store = new MemoryStateStore();
        assert.strictEqual(await store.loadFoundation('work_missing'), null);
        assert.strictEqual(await store.loadStoryState('work_missing', 1), null);
        assert.strictEqual(await store.loadArtifact('work_missing', 1), null);
        assert.strictEqual(await store.loadJob('job_missing'), null);
    });

    it('rejects workId with unsafe filesystem-style characters on load', async () => {
        const store = new MemoryStateStore();
        // Each of these would either escape rootDir or produce ambiguous paths
        // in FileStateStore — MemoryStateStore rejects the same set for parity.
        const bad = ['../escape', 'work/with/slash', 'work\\back', '..', '', 'a b', 'work '];
        for (const workId of bad) {
            await assert.rejects(() => store.loadFoundation(workId), /invalid workId/);
        }
    });

    it('rejects jobId with unsafe characters on load', async () => {
        const store = new MemoryStateStore();
        await assert.rejects(() => store.loadJob('../escape'), /invalid jobId/);
        await assert.rejects(() => store.loadJob(''), /invalid jobId/);
    });

    it('rejects unsafe workId on every save* method', async () => {
        const store = new MemoryStateStore();
        await assert.rejects(() => store.saveFoundation({ workId: '..' }), /invalid workId/);
        await assert.rejects(
            () => store.saveStoryState({ workId: '..', chapterNumber: 1 }),
            /invalid workId/,
        );
        await assert.rejects(
            () => store.saveArtifact({ workId: '..', chapterNumber: 1 }),
            /invalid workId/,
        );
        await assert.rejects(() => store.saveJob({ workId: '..', id: 'job_1' }), /invalid workId/);
        await assert.rejects(
            () => store.saveChapterSummary({ workId: '..', chapterNumber: 1 }),
            /invalid workId/,
        );
    });

    it('saveJob rejects unsafe jobId even with a safe workId', async () => {
        const store = new MemoryStateStore();
        await assert.rejects(
            () => store.saveJob({ workId: 'work_ok', id: '../escape' }),
            /invalid jobId/,
        );
    });

    it('save* deep-clones input — mutating the original after save leaves stored state untouched', async () => {
        const store = new MemoryStateStore();
        const workId = 'work_mutate_in';
        const foundation = makeFoundation(workId);
        await store.saveFoundation(foundation);
        foundation.worldFacts.push({ id: 'wf2', statement: '나중에 추가', registeredAtChapter: 9 });

        const loaded = await store.loadFoundation(workId);
        assert.strictEqual(loaded.worldFacts.length, 1);
    });

    it('load* deep-clones output — mutating a loaded object leaves stored state untouched', async () => {
        const store = new MemoryStateStore();
        const workId = 'work_mutate_out';
        const foundation = makeFoundation(workId);
        await store.saveFoundation(foundation);

        const loaded = await store.loadFoundation(workId);
        loaded.worldFacts.push({ id: 'wf2', statement: '오염', registeredAtChapter: 9 });

        const loadedAgain = await store.loadFoundation(workId);
        assert.strictEqual(loadedAgain.worldFacts.length, 1);
    });

    it('loadEntitySnapshots defaults to [] and returns the constructor-injected array', async () => {
        const empty = new MemoryStateStore();
        assert.deepStrictEqual(await empty.loadEntitySnapshots('work_any'), []);

        const seeded = [
            {
                entityId: 'e1',
                kind: 'Character',
                canonicalName: '주인공',
                aliases: ['mc'],
                status: 'active',
                attrs: {},
            },
        ];
        const store = new MemoryStateStore({ entitySnapshots: seeded });
        const loaded = await store.loadEntitySnapshots('work_any');
        assert.deepStrictEqual(loaded, seeded);
        // FileStateStore 시맨틱과 동일: workId 는 필터링에 쓰이지 않음 — 다른 workId 를
        // 넘겨도 동일한 배열을 그대로 반환.
        assert.deepStrictEqual(await store.loadEntitySnapshots('work_other'), seeded);
    });

    it('loadEntitySnapshots is deep-clone isolated on both the injected input and the returned output', async () => {
        const seeded = [
            { entityId: 'e1', kind: 'Character', canonicalName: 'X', aliases: [], status: 'active', attrs: {} },
        ];
        const store = new MemoryStateStore({ entitySnapshots: seeded });
        // Mutating the array passed into the constructor after construction
        // must not leak into the store.
        seeded.push({ entityId: 'e2', kind: 'Character', canonicalName: 'Y', aliases: [], status: 'active', attrs: {} });

        const loaded = await store.loadEntitySnapshots('work_any');
        assert.strictEqual(loaded.length, 1);

        // Mutating a returned snapshot list must not leak into the next load.
        loaded.push({ entityId: 'e3', kind: 'Character', canonicalName: 'Z', aliases: [], status: 'active', attrs: {} });
        const loadedAgain = await store.loadEntitySnapshots('work_any');
        assert.strictEqual(loadedAgain.length, 1);
    });

    it('loadRecentChapterSummaries returns newest-first, strictly before beforeChapter, capped at limit', async () => {
        const store = new MemoryStateStore();
        const workId = 'work_summaries';
        for (const chapter of [1, 2, 3, 4, 5]) {
            await store.saveChapterSummary(makeSummary(workId, chapter));
        }

        const recent = await store.loadRecentChapterSummaries(workId, 5, 2);
        assert.deepStrictEqual(recent.map((r) => r.chapterNumber), [4, 3]);

        const all = await store.loadRecentChapterSummaries(workId, 100, 10);
        assert.deepStrictEqual(all.map((r) => r.chapterNumber), [5, 4, 3, 2, 1]);

        const none = await store.loadRecentChapterSummaries(workId, 1, 10);
        assert.deepStrictEqual(none, []);
    });

    it('loadRecentChapterSummaries returns [] for limit<=0 and for an unknown work', async () => {
        const store = new MemoryStateStore();
        await store.saveChapterSummary(makeSummary('work_has_data', 1));
        assert.deepStrictEqual(await store.loadRecentChapterSummaries('work_has_data', 5, 0), []);
        assert.deepStrictEqual(await store.loadRecentChapterSummaries('work_has_data', 5, -1), []);
        assert.deepStrictEqual(await store.loadRecentChapterSummaries('work_no_data', 5, 10), []);
    });

    it('saveChapterSummary upserts by (workId, chapterNumber)', async () => {
        const store = new MemoryStateStore();
        const workId = 'work_upsert';
        await store.saveChapterSummary(makeSummary(workId, 1));
        const updated = { ...makeSummary(workId, 1), summary: '갱신된 요약' };
        await store.saveChapterSummary(updated);

        const recent = await store.loadRecentChapterSummaries(workId, 2, 10);
        assert.strictEqual(recent.length, 1);
        assert.strictEqual(recent[0].summary, '갱신된 요약');
    });
});
