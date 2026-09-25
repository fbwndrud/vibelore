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
import { detectWorkingTreeDrift } from '../src/core/working-tree-sync.js';
import { approvalFixtureProvider } from './fixtures/approval-response.js';

const prose = 'The rain stopped before dawn. Beyond the courtyard, a door slowly opened into the quiet garden.';
function provider() {
  return { pending: [], async complete(req) {
    const content = req.messages.map((m) => m.content).join('\n');
    const hash = content.match(/contextHash: ([a-f0-9]{64})/)?.[1];
    if (req.step === 'continuity-extract') return { text: JSON.stringify({ newAddressEntries: [], relationshipOps: [], hookOps: [], mutableChanges: [], influenceEvents: [], trackedEntityOps: [], noInfluenceReason: 'No lasting change.', extractionValidation: { contextHash: hash } }) };
    if (req.step === 'continuity-check') {
      const ids = content.match(/(?:these invariants|판정한다): ([A-Z_, ]+)\./)?.[1]?.split(', ') ?? [];
      return { text: JSON.stringify({ semanticValidation: { contextHash: hash, verdicts: Object.fromEntries(ids.map((id) => [id, 'pass'])), evidence: [] } }) };
    }
    if (req.step === 'chapter-summary') return { text: JSON.stringify({ summary: 'A door opens.', plotBeat: 'arrival', sceneTags: [], povCharacter: '' }) };
    if (req.step === 'chapter-title') return { text: JSON.stringify({ title: 'The gate' }) };
    if (req.step === 'language-contract') return { text: JSON.stringify({ language: 'en', artifactHash: content.match(/artifactHash: ([a-f0-9]{64})/)?.[1], verdict: 'pass', evidence: [], allowedExceptions: [] }) };
    throw new Error(`Unexpected request ${req.step}`);
  } };
}
const noModel = { pending: [], async complete() { throw new Error('design sync must not call a model'); } };

async function publishedWork() {
  const root = await mkdtemp(join(tmpdir(), 'vibelore-sync-design-'));
  const store = new MarkdownStateStore(root);
  await runInit({ store, workId: 'w', genre: 'other', language: 'en', providers: approvalFixtureProvider(), worldFacts: ['A gate leads to the garden.'] });
  await store.saveStoryProfile('w', { status: 'active', revision: 1, language: 'en', format: { length: { unit: 'words', target: 10 }, dialogueBreakMode: 'natural' } });
  const checked = await runCheck({ store, workId: 'w', chapter: 1, prose, title: 'The gate', providers: provider(), issueReceipt: true });
  await runCommit({ store, workId: 'w', chapter: 1, prose, title: 'The gate', providers: provider(), checkId: checked.checkId });
  return { store, root, settingPath: join(root, 'world', 'setting.md') };
}

async function editSetting(path) {
  const text = await readFile(path, 'utf8');
  assert.ok(text.includes('A gate leads to the garden.'));
  await writeFile(path, text.replace('A gate leads to the garden.', 'A gate leads to the orchard.'));
}

test('a world edit is shown with its impact, approved and published without a model call', async () => {
  const { store, settingPath } = await publishedWork();
  await editSetting(settingPath);
  const inspected = await runSyncStatus({ store, workId: 'w', action: 'inspect' });
  assert.equal(inspected.classification, 'design_review_required');
  assert.match(inspected.nextAction, /action=validate/);
  const validated = await runSyncStatus({ store, workId: 'w', action: 'validate', providers: noModel });
  assert.equal(validated.status, 'awaiting_approval', JSON.stringify(validated));
  assert.deepEqual(validated.designDiff.worldFacts.changed.map((item) => item.after), ['A gate leads to the orchard.']);
  assert.ok(Array.isArray(validated.impact.plans));
  const applied = await runSyncStatus({ store, workId: 'w', action: 'apply', approvalId: validated.approvalId, providers: noModel });
  assert.equal(applied.status, 'completed');
  const published = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
  assert.deepEqual(published.value.tree.foundation.worldFacts.map((fact) => fact.statement), ['A gate leads to the orchard.']);
  assert.equal(published.value.tree.chapters[1].prose, prose);
  assert.equal((await detectWorkingTreeDrift({ store, sourceHead: published.value.head })).status, 'clean');
});

test('a design approval goes stale when the files change after validation', async () => {
  const { store, settingPath } = await publishedWork();
  await editSetting(settingPath);
  const validated = await runSyncStatus({ store, workId: 'w', action: 'validate', providers: noModel });
  const text = await readFile(settingPath, 'utf8');
  await writeFile(settingPath, text.replace('orchard', 'forest'));
  await assert.rejects(runSyncStatus({ store, workId: 'w', action: 'apply', approvalId: validated.approvalId, providers: noModel }), /STALE_SYNC_CANDIDATE/);
});

test('default-surface guidance names only tools the default surface exposes', async () => {
  const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const server = await read('src/server.js');
  const publicList = server.slice(server.indexOf('const PUBLIC_TOOL_NAMES'), server.indexOf(']);', server.indexOf('const PUBLIC_TOOL_NAMES')));
  const source = (await Promise.all(['src/tools/commit.js', 'src/tools/sync.js', 'src/prompts/ko.js', 'src/prompts/multilingual.js'].map(read))).join('\n');
  for (const hidden of ['lore_episode_plan', 'lore_episode_decide', 'lore_refold']) {
    assert.ok(publicList.length > 0 && !publicList.includes(`'${hidden}'`), `${hidden} is expected to be advanced-only`);
    assert.ok(!source.includes(hidden), `${hidden} must not be suggested to default-surface users`);
  }
});
