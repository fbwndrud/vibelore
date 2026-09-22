import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { advanceWorkingTreeFingerprint, captureWorkingTreeFingerprint, detectWorkingTreeDrift } from '../src/core/working-tree-sync.js';
import { loadCurrentExperienceLedger, saveExperienceLedgerForHead } from '../src/core/experience-ledger.js';
import { createPublicationUnit } from '../src/core/publication-unit.js';
import { runSyncStatus } from '../src/tools/sync.js';
import { runConfigureStatus } from '../src/tools/configure.js';
import { runCommit } from '../src/tools/commit.js';

describe('working tree and experience generations', () => {
  it('detects a hand edit without overwriting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibelore-drift-'));
    const store = new MarkdownStateStore(root);
    await mkdir(join(root, 'world'), { recursive: true });
    await writeFile(join(root, 'world', 'setting.md'), '# 원본\n', 'utf8');
    await captureWorkingTreeFingerprint({ store, sourceHead: 'sha256:head-a' });
    assert.equal((await detectWorkingTreeDrift({ store, sourceHead: 'sha256:head-a' })).status, 'clean');
    await writeFile(join(root, 'world', 'setting.md'), '# 손수정\n', 'utf8');
    const drift = await detectWorkingTreeDrift({ store, sourceHead: 'sha256:head-a' });
    assert.equal(drift.status, 'modified');
    assert.deepEqual(drift.changed, ['world/setting.md']);
  });

  it('advances a clean fingerprint across a metadata-only publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibelore-fingerprint-head-'));
    const store = new MarkdownStateStore(root);
    await mkdir(join(root, 'world'), { recursive: true });
    await writeFile(join(root, 'world', 'setting.md'), '# unchanged\n', 'utf8');
    await captureWorkingTreeFingerprint({ store, sourceHead: 'sha256:head-a' });

    const advanced = await advanceWorkingTreeFingerprint({
      store, previousHead: 'sha256:head-a', sourceHead: 'sha256:head-b',
    });

    assert.equal(advanced.advanced, true);
    assert.equal((await detectWorkingTreeDrift({ store, sourceHead: 'sha256:head-b' })).status, 'clean');
  });

  it('does not bless a hand edit while advancing a publication head', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibelore-fingerprint-drift-'));
    const store = new MarkdownStateStore(root);
    await mkdir(join(root, 'world'), { recursive: true });
    const path = join(root, 'world', 'setting.md');
    await writeFile(path, '# original\n', 'utf8');
    await captureWorkingTreeFingerprint({ store, sourceHead: 'sha256:head-a' });
    await writeFile(path, '# hand edit\n', 'utf8');

    const advanced = await advanceWorkingTreeFingerprint({
      store, previousHead: 'sha256:head-a', sourceHead: 'sha256:head-b',
    });

    assert.equal(advanced.advanced, false);
    assert.equal((await detectWorkingTreeDrift({ store, sourceHead: 'sha256:head-b' })).status, 'stale_fingerprint');
  });

  it('recovers a stale metadata-only head through sync inspection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibelore-sync-head-'));
    const store = new MarkdownStateStore(root);
    await mkdir(join(root, 'world'), { recursive: true });
    await writeFile(join(root, 'world', 'setting.md'), '# unchanged\n', 'utf8');
    const publication = createPublicationUnit({ rootDir: root });
    const firstToken = await publication.issueFencingToken();
    const first = await publication.publish({
      context: { snapshotId: 'genesis', expectedHead: null, storyTimeScope: { worldline: 'main', through: 0 }, publicationOrder: 1, transactionTime: new Date().toISOString(), policyRevision: 'test', semanticGeneration: 'test', fencingToken: firstToken.value.fencingToken },
      candidate: { tree: { workId: 'work', chapters: {} }, projections: {}, impactClosure: [] },
    });
    await captureWorkingTreeFingerprint({ store, sourceHead: first.value.head });
    const secondToken = await publication.issueFencingToken();
    const second = await publication.publish({
      context: { snapshotId: first.value.head, expectedHead: first.value.head, storyTimeScope: { worldline: 'main', through: 0 }, publicationOrder: 1, transactionTime: new Date().toISOString(), policyRevision: 'test', semanticGeneration: 'test', fencingToken: secondToken.value.fencingToken },
      candidate: { tree: { plans: { episodePlans: { 1: { status: 'active' } } } }, projections: {}, impactClosure: [] },
    });

    const result = await runSyncStatus({ store, workId: 'work', action: 'inspect' });

    assert.equal(result.status, 'baseline_captured');
    assert.equal((await detectWorkingTreeDrift({ store, sourceHead: second.value.head })).status, 'clean');
  });

  it('excludes telemetry produced from a stale Published HEAD', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibelore-ledger-'));
    const store = new MarkdownStateStore(root);
    const publication = createPublicationUnit({ rootDir: root });
    const token = await publication.issueFencingToken();
    const published = await publication.publish({
      context: { snapshotId: 'genesis', expectedHead: null, storyTimeScope: { worldline: 'main', through: 1 }, publicationOrder: 1, transactionTime: new Date().toISOString(), policyRevision: 'test', semanticGeneration: 'test', fencingToken: token.value.fencingToken },
      candidate: { tree: { workId: 'work' }, projections: {}, impactClosure: [] },
    });
    await saveExperienceLedgerForHead({ store, workId: 'work', sourceHead: 'sha256:stale', entries: [{ chapter: 1, sceneMode: '전투' }] });
    const stale = await loadCurrentExperienceLedger({ store, workId: 'work' });
    assert.equal(stale.currentHead, published.value.head);
    assert.equal(stale.status, 'stale');
    assert.deepEqual(stale.entries, []);
  });

  it('classifies a hand-edited design without overwriting or accepting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibelore-sync-'));
    const store = new MarkdownStateStore(root);
    await mkdir(join(root, 'world'), { recursive: true });
    await writeFile(join(root, 'world', 'setting.md'), '# 원본\n', 'utf8');
    const publication = createPublicationUnit({ rootDir: root });
    const token = await publication.issueFencingToken();
    const published = await publication.publish({
      context: { snapshotId: 'genesis', expectedHead: null, storyTimeScope: { worldline: 'main', through: 1 }, publicationOrder: 1, transactionTime: new Date().toISOString(), policyRevision: 'test', semanticGeneration: 'test', fencingToken: token.value.fencingToken },
      candidate: { tree: { workId: 'work', chapters: {} }, projections: {}, impactClosure: [] },
    });
    await captureWorkingTreeFingerprint({ store, sourceHead: published.value.head });
    await writeFile(join(root, 'world', 'setting.md'), '# 손수정\n', 'utf8');
    const result = await runSyncStatus({ store, workId: 'work' });
    assert.equal(result.status, 'needs_review');
    assert.equal(result.classification, 'design_review_required');
    assert.deepEqual(result.changed, ['world/setting.md']);
  });

  it('shows one unified configuration compiled from legacy objects', async () => {
    const store = {
      async loadFoundation() { return { workId: 'work' }; },
      async loadStoryProfile() { return { status: 'active', revision: 1, storyEngines: ['성장'] }; },
      async loadStoryIdentity() { return { readerPromise: '선택의 대가' }; },
      async loadWriterSkill() { return { status: 'active', revision: 2, authorCraft: { judgments: ['결과를 본다'] } }; },
      async loadStorySpine() { return { status: 'active', revision: 3, dramaticQuestion: '통제를 놓을 수 있는가' }; },
      async loadArcPlan() { return null; }, async listChapters() { return []; }, async loadEpisodePlan() { return null; },
    };
    const result = await runConfigureStatus({ store, workId: 'work' });
    assert.equal(result.status, 'ready');
    assert.equal(result.narrativeContract.schemaVersion, 2);
    assert.equal(result.storySpine.revision, 3);
  });

  it('validates and republishes a hand-edited latest chapter with a single-use approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vibelore-sync-apply-'));
    const store = new MarkdownStateStore(root);
    await store.saveFoundation({ workId: 'work', genre: 'fantasy', worldFacts: [], characters: [], intrinsicChanges: [], genreProfile: { invariants: [] } });
    const delta = { chapterNumber: 1, appearedCharacterIds: [], mutableChanges: [], newAddressEntries: [], relationshipOps: [], hookChanges: [], trackedEntityOps: [], entityOps: [], lexiconAdditions: [] };
    const providers = {
      get pending() { return []; },
      async complete(request) {
        if (request.step === 'chapter-summary') return { text: '{"summary":"손수정 요약","plotBeat":"opening","sceneTags":[],"povCharacter":null}' };
        return { text: '{}' };
      },
    };
    const committed = await runCommit({ store, workId: 'work', chapter: 1, prose: '원본 본문이다.', summary: '원본 요약', delta, providers });
    const chapterPath = join(root, 'chapters', '001.md');
    const original = await readFile(chapterPath, 'utf8');
    await writeFile(chapterPath, original.replace('원본 본문이다.', '사람이 직접 고친 본문이다.'), 'utf8');
    const validated = await runSyncStatus({ store, workId: 'work', action: 'validate', providers });
    assert.equal(validated.status, 'awaiting_approval');
    const applied = await runSyncStatus({ store, workId: 'work', action: 'apply', approvalId: validated.approvalId, providers });
    assert.equal(applied.status, 'completed');
    assert.notEqual(applied.publication.head, committed.publication.head);
    assert.match((await store.loadArtifact('work', 1)).prose, /직접 고친/);
    assert.equal((await detectWorkingTreeDrift({ store, sourceHead: applied.publication.head })).status, 'clean');
    await assert.rejects(
      runSyncStatus({ store, workId: 'work', action: 'apply', approvalId: validated.approvalId, providers }),
      /미사용 sync approvalId/,
    );
  });
});
