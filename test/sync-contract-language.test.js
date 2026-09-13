import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runInit } from '../src/tools/init.js';
import { runCheck } from '../src/tools/check.js';
import { runCommit } from '../src/tools/commit.js';
import { runSyncStatus } from '../src/tools/sync.js';
import { createPublicationUnit } from '../src/core/publication-unit.js';
import { approvalFixtureProvider } from './fixtures/approval-response.js';

const original = 'The rain stopped before dawn. Beyond the courtyard, a door slowly opened into the quiet garden.';
const edited = 'The rain stopped before dawn. Beyond the courtyard, a door opened and a stranger entered the garden.';
function provider({ language = 'en', uncertain = false, onLanguage } = {}) {
  const calls = [];
  return { calls, pending: [], async complete(req) {
    calls.push(req);
    const content = req.messages.map(m => m.content).join('\n');
    const hash = content.match(/contextHash: ([a-f0-9]{64})/)?.[1];
    if (req.step === 'continuity-extract') return { text: JSON.stringify({
      newAddressEntries: [], relationshipOps: [], hookOps: [], mutableChanges: [], influenceEvents: [], trackedEntityOps: [],
      noInfluenceReason: 'No lasting change.', extractionValidation: { contextHash: hash },
    }) };
    if (req.step === 'continuity-check') {
      const ids = content.match(/(?:these invariants|판정한다): ([A-Z_, ]+)\./)?.[1]?.split(', ') ?? [];
      return { text: JSON.stringify({ semanticValidation: { contextHash: hash,
        verdicts: Object.fromEntries(ids.map(id => [id, 'pass'])), evidence: [] } }) };
    }
    if (req.step === 'chapter-summary') return { text: JSON.stringify({ summary: 'A stranger enters the garden.', plotBeat: 'arrival', sceneTags: [], povCharacter: '' }) };
    if (req.step === 'chapter-title') return { text: JSON.stringify({ title: 'The stranger' }) };
    if (req.step === 'language-contract') {
      await onLanguage?.();
      return { text: JSON.stringify({ language, artifactHash: content.match(/artifactHash: ([a-f0-9]{64})/)?.[1],
        verdict: uncertain ? 'uncertain' : 'pass', evidence: [], allowedExceptions: [] }) };
    }
    throw new Error(`Unexpected request ${req.step}`);
  } };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'vibelore-sync-contract-'));
  const store = new MarkdownStateStore(root);
  await runInit({ store, workId: 'w', genre: 'other', language: 'en', providers: approvalFixtureProvider(), worldFacts: ['A gate leads to the garden.'] });
  await store.saveStoryProfile('w', { status: 'active', revision: 1, language: 'en', format: { length: { unit: 'words', target: 10 }, dialogueBreakMode: 'natural' } });
  const providers = provider();
  const checked = await runCheck({ store, workId: 'w', chapter: 1, prose: original, title: 'The gate', providers, issueReceipt: true });
  assert.equal(checked.validationComplete, true, JSON.stringify(checked));
  await runCommit({ store, workId: 'w', chapter: 1, prose: original, title: 'The gate', providers, checkId: checked.checkId });
  const chapterPath = join(root, 'chapters', '001.md');
  const before = await readFile(chapterPath, 'utf8');
  await writeFile(chapterPath, before.replace(original, edited));
  return { store, root, chapterPath };
}

test('sync validates the final bundle once and applies the original receipt without model calls', async () => {
  const { store } = await setup(); const providers = provider();
  const checked = await runSyncStatus({ store, workId: 'w', action: 'validate', providers });
  assert.equal(checked.status, 'awaiting_approval', JSON.stringify(checked));
  const candidate = await store.loadSyncCandidate('w');
  assert.equal(candidate.schemaVersion, 2);
  assert.equal(candidate.artifact.prose, edited);
  assert.equal(candidate.validationScope, 'sync-1');
  const receipt = await store.loadCheckReceipt('w', candidate.checkId);
  assert.equal(receipt.artifactHash, candidate.artifactHash);
  const count = providers.calls.length;
  const applied = await runSyncStatus({ store, workId: 'w', action: 'apply', approvalId: checked.approvalId,
    providers: { async complete() { throw new Error('Apply called a model'); } } });
  assert.equal(applied.status, 'completed');
  assert.equal(providers.calls.length, count);
  const published = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
  assert.equal(published.value.tree.chapters[1].prose, candidate.artifact.prose);
  assert.equal(published.value.tree.chapters[1].title, candidate.artifact.title);
  await assert.rejects(runSyncStatus({ store, workId: 'w', action: 'apply', approvalId: checked.approvalId }), /미사용 sync approvalId/);
});

test('sync never issues approval for uncertain output language', async () => {
  const { store } = await setup();
  const result = await runSyncStatus({ store, workId: 'w', action: 'validate', providers: provider({ uncertain: true }) });
  assert.equal(result.status, 'blocked');
  assert.equal(await store.loadSyncCandidate('w'), null);
});

test('a later Markdown edit permanently stales an approval even when its bytes are restored', async () => {
  const { store, chapterPath } = await setup();
  const checked = await runSyncStatus({ store, workId: 'w', action: 'validate', providers: provider() });
  assert.equal(checked.status, 'awaiting_approval', JSON.stringify(checked));
  const validated = await readFile(chapterPath, 'utf8');
  await writeFile(chapterPath, validated + '\nAn unvalidated ending.\n');
  await assert.rejects(runSyncStatus({ store, workId: 'w', action: 'apply', approvalId: checked.approvalId }), /STALE_SYNC_CANDIDATE/);
  await writeFile(chapterPath, validated);
  await assert.rejects(runSyncStatus({ store, workId: 'w', action: 'apply', approvalId: checked.approvalId }), /STALE_SYNC_CANDIDATE/);
  assert.equal((await store.loadSyncCandidate('w')).stale, true);
});

test('plan changes invalidate sync approval before publication even with identical Markdown', async () => {
  const { store } = await setup();
  const checked = await runSyncStatus({ store, workId: 'w', action: 'validate', providers: provider() });
  assert.equal(checked.status, 'awaiting_approval', JSON.stringify(checked));
  const before = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
  await store.saveStoryProfile('w', { status: 'active', revision: 2, language: 'en', readerPromise: 'A different promise.', format: { length: { unit: 'words', target: 10 }, dialogueBreakMode: 'natural' } });
  await assert.rejects(runSyncStatus({ store, workId: 'w', action: 'apply', approvalId: checked.approvalId }));
  const after = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
  assert.equal(before.value.head, after.value.head);
  assert.equal((await store.loadSyncCandidate('w')).stale, true);
});
