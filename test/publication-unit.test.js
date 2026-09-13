import { legacyWorkFixture } from './fixtures/legacy-work.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createPublicationUnit } from '../src/core/publication-unit.js';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { runInit } from '../src/tools/init.js';
import { runCommit } from '../src/tools/commit.js';

const validContext = (overrides = {}) => ({
  snapshotId: 'snapshot-0', expectedHead: null,
  storyTimeScope: { worldline: 'main', from: 1, to: 1 }, publicationOrder: 1,
  transactionTime: '2026-08-26T00:00:00.000Z', policyRevision: 'policy-1',
  semanticGeneration: 'semantic-1', fencingToken: 1, ...overrides,
});

const candidate = (chapter = 1) => ({
  tree: { chapters: { [chapter]: `chapter-${chapter}` }, canonClaims: [`claim-${chapter}`] },
  projections: {
    characterState: { hero: { want: 'survive' } },
    audienceState: { knownClaims: [`claim-${chapter}`] },
    planImpact: { invalidated: [] },
  },
  impactClosure: [],
});

describe('PublicationUnit', () => {
  it('rejects an incomplete ExecutionContext as a typed failure', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'vibelore-publication-'));
    const unit = createPublicationUnit({ rootDir });
    const result = await unit.publish({ context: { snapshotId: 'x' }, candidate: candidate() });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_EXECUTION_CONTEXT');
    assert.ok(result.error.missing.includes('expectedHead'));
    const malformed = await unit.publish({
      context: validContext({ publicationOrder: 0, storyTimeScope: { worldline: '' }, fencingToken: -1 }),
      candidate: candidate(),
    });
    assert.equal(malformed.error.code, 'INVALID_EXECUTION_CONTEXT');
    assert.deepEqual(malformed.error.invalid.sort(), ['fencingToken', 'publicationOrder', 'storyTimeScope']);
  });

  it('seals one immutable generation and exposes matching projection watermarks through HEAD', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'vibelore-publication-'));
    const unit = createPublicationUnit({ rootDir });
    const lease = await unit.issueFencingToken();
    assert.deepEqual(lease, { ok: true, value: { fencingToken: 1 } });

    const published = await unit.publish({
      context: validContext({ fencingToken: lease.value.fencingToken }),
      candidate: candidate(),
    });
    assert.equal(published.ok, true);
    assert.equal(published.value.previousHead, null);
    assert.match(published.value.head, /^sha256:[0-9a-f]{64}$/);

    const visible = await unit.readPublished();
    assert.equal(visible.ok, true);
    assert.equal(visible.value.head, published.value.head);
    assert.deepEqual(visible.value.tree.canonClaims, ['claim-1']);
    assert.equal(visible.value.manifest.sealed, true);
    assert.deepEqual(
      Object.values(visible.value.projectionWatermarks),
      [published.value.head, published.value.head, published.value.head],
    );
  });

  it('makes retry idempotent and rejects stale HEAD and fencing authority', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'vibelore-publication-'));
    const unit = createPublicationUnit({ rootDir });
    const firstLease = await unit.issueFencingToken();
    const context = validContext({ fencingToken: firstLease.value.fencingToken });
    const first = await unit.publish({ context, candidate: candidate() });
    const retry = await unit.publish({ context, candidate: candidate() });
    assert.equal(retry.ok, true);
    assert.equal(retry.value.head, first.value.head);
    assert.equal(retry.value.idempotent, true);

    const nextLease = await unit.issueFencingToken();
    const staleFence = await unit.publish({
      context: validContext({ expectedHead: first.value.head, fencingToken: firstLease.value.fencingToken, publicationOrder: 2 }),
      candidate: candidate(2),
    });
    assert.equal(staleFence.error.code, 'STALE_FENCING_TOKEN');
    const staleHead = await unit.publish({
      context: validContext({ expectedHead: null, fencingToken: nextLease.value.fencingToken, publicationOrder: 2 }),
      candidate: candidate(2),
    });
    assert.equal(staleHead.error.code, 'STALE_HEAD');
  });

  it('inherits the parent full canon tree while replacing only the supplied chapter and summary', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'vibelore-publication-'));
    const unit = createPublicationUnit({ rootDir });
    const firstLease = await unit.issueFencingToken();
    const firstCandidate = {
      ...candidate(1),
      tree: { foundation: { title: '연재물' }, plans: { spine: { question: '살아남나?' } }, chapters: { 1: 'old-one' }, summaries: { 1: 'sum-one' } },
    };
    const first = await unit.publish({ context: validContext({ fencingToken: firstLease.value.fencingToken }), candidate: firstCandidate });
    const nextLease = await unit.issueFencingToken();
    await unit.publish({
      context: validContext({ expectedHead: first.value.head, fencingToken: nextLease.value.fencingToken, publicationOrder: 2 }),
      candidate: { ...candidate(2), tree: { chapters: { 1: 'replaced-one', 2: 'two' }, summaries: { 2: 'sum-two' } } },
    });
    const visible = (await unit.readPublished()).value;
    assert.deepEqual(visible.tree.foundation, { title: '연재물' });
    assert.deepEqual(visible.tree.plans, { spine: { question: '살아남나?' } });
    assert.deepEqual(visible.tree.chapters, { 1: 'replaced-one', 2: 'two' });
    assert.deepEqual(visible.tree.summaries, { 1: 'sum-one', 2: 'sum-two' });
  });

  it('recovers an authority lock whose owner is dead or lease is expired', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'vibelore-publication-'));
    const lockDir = join(rootDir, '.vibelore', 'publication', 'authority.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: 99999999, expiresAt: 1 }));
    const lease = await createPublicationUnit({ rootDir }).issueFencingToken();
    assert.deepEqual(lease, { ok: true, value: { fencingToken: 1 } });
  });

  it('blocks unresolved hard dependencies and forbids grandfathering semantic truth', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'vibelore-publication-'));
    const unit = createPublicationUnit({ rootDir });
    const lease = await unit.issueFencingToken();
    for (const impactClosure of [
      [{ id: 'knowledge-4', dependencyKind: 'character_knowledge', status: 'unresolved' }],
      [{ id: 'alive-7', dependencyKind: 'life_status', status: 'explicitly_grandfathered' }],
    ]) {
      const blocked = await unit.publish({
        context: validContext({ fencingToken: lease.value.fencingToken }),
        candidate: { ...candidate(), impactClosure },
      });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.error.code, 'UNSATISFIED_DEPENDENCY_CLOSURE');
    }
    const allowed = await unit.publish({
      context: validContext({ fencingToken: lease.value.fencingToken }),
      candidate: { ...candidate(), impactClosure: [{ id: 'summary-1', dependencyKind: 'summary', status: 'explicitly_grandfathered' }] },
    });
    assert.equal(allowed.ok, true);
  });

  it('never exposes a mixed generation when restarted at every named failpoint', async () => {
    const beforeHead = ['afterBlob', 'afterTree', 'afterEachProjection', 'afterManifestFsync', 'beforeHeadCAS'];
    for (const failAt of [...beforeHead, 'afterHeadCAS']) {
      const rootDir = await mkdtemp(join(tmpdir(), `vibelore-${failAt}-`));
      const setup = createPublicationUnit({ rootDir });
      const firstLease = await setup.issueFencingToken();
      const old = await setup.publish({ context: validContext({ fencingToken: firstLease.value.fencingToken }), candidate: candidate(1) });
      const nextLease = await setup.issueFencingToken();
      const nextContext = validContext({
        snapshotId: 'snapshot-1', expectedHead: old.value.head, publicationOrder: 2,
        storyTimeScope: { worldline: 'main', from: 2, to: 2 }, fencingToken: nextLease.value.fencingToken,
      });
      const nextCandidate = candidate(2);
      nextCandidate.tree.chapters[1] = 'chapter-1';
      nextCandidate.tree.canonClaims.unshift('claim-1');
      const crashing = createPublicationUnit({ rootDir, failAt });
      await assert.rejects(
        () => crashing.publish({ context: nextContext, candidate: nextCandidate }),
        (error) => error.name === 'PublicationCrash' && error.failpoint === failAt,
      );

      const restarted = createPublicationUnit({ rootDir });
      const visible = await restarted.readPublished();
      assert.equal(visible.ok, true);
      assert.equal(visible.value.tree.chapters[1], 'chapter-1');
      if (beforeHead.includes(failAt)) {
        assert.equal(visible.value.head, old.value.head);
        assert.equal(visible.value.tree.chapters[2], undefined);
      } else {
        assert.equal(visible.value.tree.chapters[2], 'chapter-2');
        assert.deepEqual(Object.values(visible.value.projectionWatermarks), [visible.value.head, visible.value.head, visible.value.head]);
      }

      const retried = await restarted.publish({ context: nextContext, candidate: nextCandidate });
      assert.equal(retried.ok, true);
      assert.equal((await restarted.readPublished()).value.tree.chapters[2], 'chapter-2');
    }
  });

  it('keeps sealed HEAD authoritative when live Markdown materialization fails after publication', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'vibelore-integrated-publication-'));
    const store = new MarkdownStateStore(rootDir);
    await legacyWorkFixture({ store, workId: 'serial', genre: 'other', worldFacts: ['탑은 닫혀 있다.'] });
    const delta = { chapterNumber: 1, appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], hookChanges: [], mutableChanges: [], trackedEntityOps: [] };
    await assert.rejects(
      () => runCommit({
        store, workId: 'serial', chapter: 1, prose: '문은 여전히 닫혀 있었다.',
        summary: '문은 열리지 않았다.', delta, providers: createHostRelay({}),
        commitFault: 'afterPublicationBeforeMaterialization',
      }),
      /materialization failure/,
    );
    assert.equal(await store.loadArtifact('serial', 1), null);
    const published = await createPublicationUnit({ rootDir }).readPublished();
    assert.equal(published.ok, true);
    assert.equal(published.value.tree.foundation.workId, 'serial');
    assert.equal(published.value.tree.chapters[1].prose, '문은 여전히 닫혀 있었다.');
    assert.equal(published.value.tree.summaries[1], '문은 열리지 않았다.');
    assert.equal(published.value.manifest.sealed, true);
  });
});
