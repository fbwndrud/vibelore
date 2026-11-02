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
    if (req.step === 'continuity-extract') return { text: JSON.stringify({ newAddressEntries: [], relationshipOps: [], hookOps: [], mutableChanges: [], influenceEvents: [], ledgerOps: [], noInfluenceReason: 'No lasting change.', extractionValidation: { contextHash: hash } }) };
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

const kaiDoc = (descriptionBody, extra = '') => `---\nid: kai\nname: Kai\nlanguage: en\ncanonicalFormatVersion: 2\n---\n\n## Description\n${descriptionBody}\n${extra}`;
const validate = (store) => runSyncStatus({ store, workId: 'w', action: 'validate', providers: noModel });

test('a fact gate moved past the last published chapter is a tag-only change and not retroactive', async () => {
  const { store, settingPath } = await publishedWork();
  const text = await readFile(settingPath, 'utf8');
  await writeFile(settingPath, text.replace('A gate leads to the garden.', '[from chapter 12] A gate leads to the garden.'));
  const validated = await validate(store);
  assert.equal(validated.status, 'awaiting_approval', JSON.stringify(validated));
  assert.deepEqual(validated.designDiff.worldFacts.changed, [{ id: 'w1', beforeFromChapter: 1, afterFromChapter: 12 }]);
  assert.equal(validated.canonGates, undefined);
});

async function commitSecondChapter(store) {
  const second = `${prose} Later, the courtyard lay still beneath a pale sky.`;
  const checked = await runCheck({ store, workId: 'w', chapter: 2, prose: second, title: 'The gate', providers: provider(), issueReceipt: true });
  await runCommit({ store, workId: 'w', chapter: 2, prose: second, title: 'The gate', providers: provider(), checkId: checked.checkId });
}

test('a fact gate at or before the last published chapter is retroactive; a default tag alone is not a gate change', async () => {
  const { store, settingPath } = await publishedWork();
  await commitSecondChapter(store);
  const original = await readFile(settingPath, 'utf8');
  await writeFile(settingPath, original.replace('A gate leads to the garden.', 'A gate leads to the garden.\n- (w2) [from chapter 2] Two moons rise.\n- (w3) [from chapter 9] A third moon rises.'));
  const added = await validate(store);
  assert.equal(added.status, 'awaiting_approval', JSON.stringify(added));
  assert.deepEqual(added.canonGates.retroactive, [{ target: 'fact:w2', fromChapter: 2 }]);
  assert.match(added.nextAction, /fact:w2/);
  assert.match(added.nextAction, /2화/);
  await writeFile(settingPath, original.replace('A gate leads to the garden.', '[from chapter 1] A gate leads to the garden.'));
  const plainTag = await validate(store);
  assert.equal(plainTag.canonGates, undefined);
  assert.deepEqual(plainTag.designDiff.worldFacts.changed, []);
  await writeFile(settingPath, original.replace('A gate leads to the garden.', '[from chapter 2] A gate leads to the garden.'));
  const moved = await validate(store);
  assert.deepEqual(moved.designDiff.worldFacts.changed, [{ id: 'w1', beforeFromChapter: 1, afterFromChapter: 2 }]);
  assert.deepEqual(moved.canonGates.retroactive, [{ target: 'fact:w1', fromChapter: 2 }]);
});

test('a published fact gate lowered to the first chapter by removing its tag is retroactive', async () => {
  const { store, settingPath } = await publishedWork();
  await commitSecondChapter(store);
  const original = await readFile(settingPath, 'utf8');
  await writeFile(settingPath, original.replace('A gate leads to the garden.', '[from chapter 12] A gate leads to the garden.'));
  const gated = await validate(store);
  assert.equal(gated.status, 'awaiting_approval', JSON.stringify(gated));
  assert.equal(gated.canonGates, undefined);
  const applied = await runSyncStatus({ store, workId: 'w', action: 'apply', approvalId: gated.approvalId, providers: noModel });
  assert.equal(applied.status, 'completed', JSON.stringify(applied));
  await writeFile(settingPath, original);
  const lowered = await validate(store);
  assert.equal(lowered.status, 'awaiting_approval', JSON.stringify(lowered));
  assert.deepEqual(lowered.designDiff.worldFacts.changed, [{ id: 'w1', beforeFromChapter: 12, afterFromChapter: 1 }]);
  assert.deepEqual(lowered.canonGates.retroactive, [{ target: 'fact:w1', fromChapter: 1 }]);
  assert.match(lowered.nextAction, /fact:w1\(1~2화\)/);
  await writeFile(settingPath, original.replace('A gate leads to the garden.', '[from chapter 30] A gate leads to the garden.'));
  const later = await validate(store);
  assert.equal(later.canonGates, undefined);
});

test('a new character block opened at a published chapter is retroactive; a later one is not', async () => {
  const { store, root, settingPath } = await publishedWork();
  assert.ok(settingPath);
  await writeFile(join(root, 'characters', 'kai.md'), kaiDoc('### from chapter 1\nLost an arm.'));
  const retro = await validate(store);
  assert.equal(retro.status, 'awaiting_approval', JSON.stringify(retro));
  assert.deepEqual(retro.canonGates.retroactive, [{ target: 'character:kai', fromChapter: 1 }]);
  assert.match(retro.nextAction, /character:kai/);
  assert.match(retro.nextAction, /1화/);
  assert.match(retro.nextAction, /구간의 발행된 화는 이 게이트 없이 쓰였고 다시 검사하지 않습니다\./);
  await writeFile(join(root, 'characters', 'kai.md'), kaiDoc('### from chapter 12\nLost an arm.'));
  const later = await validate(store);
  assert.equal(later.status, 'awaiting_approval', JSON.stringify(later));
  assert.equal(later.canonGates, undefined);
  assert.doesNotMatch(later.nextAction, /character:kai/);
});

test('a retroactive gate is listed once per target and chapter and does not block apply', async () => {
  const { store, root } = await publishedWork();
  await writeFile(join(root, 'characters', 'kai.md'), kaiDoc('Apprentice.\n\n### from chapter 1\nLost an arm.\n\n### 1화부터\nLost an arm.'));
  const validated = await validate(store);
  assert.equal(validated.status, 'awaiting_approval', JSON.stringify(validated));
  assert.deepEqual(validated.canonGates.retroactive, [{ target: 'character:kai', fromChapter: 1 }]);
  const applied = await runSyncStatus({ store, workId: 'w', action: 'apply', approvalId: validated.approvalId, providers: noModel });
  assert.equal(applied.status, 'completed');
});

test('a gate-only edit after validate makes apply return STALE_SYNC_CANDIDATE', async () => {
  const { store, settingPath } = await publishedWork();
  const original = await readFile(settingPath, 'utf8');
  await writeFile(settingPath, original.replace('A gate leads to the garden.', '[from chapter 12] A gate leads to the garden.'));
  const validated = await validate(store);
  assert.equal(validated.status, 'awaiting_approval', JSON.stringify(validated));
  await writeFile(settingPath, original.replace('A gate leads to the garden.', '[from chapter 20] A gate leads to the garden.'));
  await assert.rejects(runSyncStatus({ store, workId: 'w', action: 'apply', approvalId: validated.approvalId, providers: noModel }), /STALE_SYNC_CANDIDATE/);
});

test('a gate marker outside a Description section is advised but does not block approval', async () => {
  const { store, root } = await publishedWork();
  await writeFile(join(root, 'characters', 'kai.md'), kaiDoc('Apprentice.', '\n## Contradiction\n### 5화부터\nSecret.'));
  const validated = await validate(store);
  assert.equal(validated.status, 'awaiting_approval', JSON.stringify(validated));
  const file = await readFile(join(root, 'characters', 'kai.md'), 'utf8');
  const line = file.split('\n').findIndex((row) => row === '### 5화부터') + 1;
  assert.deepEqual(validated.canonGates.ignoredMarkers, [{ path: 'characters/kai.md', line }]);
  assert.equal(validated.canonGates.retroactive, undefined);
  const applied = await runSyncStatus({ store, workId: 'w', action: 'apply', approvalId: validated.approvalId, providers: noModel });
  assert.equal(applied.status, 'completed');
});

test('an invalid gate marker blocks validation and leaves the Markdown files untouched', async () => {
  const { store, root, settingPath } = await publishedWork();
  const kaiPath = join(root, 'characters', 'kai.md');
  await writeFile(kaiPath, kaiDoc('Apprentice.\n\n### 0화부터\nBroken.'));
  const settingBefore = await readFile(settingPath, 'utf8');
  const kaiBefore = await readFile(kaiPath, 'utf8');
  const blocked = await validate(store);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'FOUNDATION_PARSE_FAILED');
  assert.match(blocked.reason, /CANON_GATE_INVALID/);
  assert.equal(await readFile(settingPath, 'utf8'), settingBefore);
  assert.equal(await readFile(kaiPath, 'utf8'), kaiBefore);
});

test('the published foundation keeps the raw gated text after apply', async () => {
  const { store, root, settingPath } = await publishedWork();
  const description = 'Apprentice.\n\n### 12화부터\nLost an arm.';
  await writeFile(join(root, 'characters', 'kai.md'), kaiDoc(description));
  const text = await readFile(settingPath, 'utf8');
  await writeFile(settingPath, text.replace('A gate leads to the garden.', '[from chapter 12] A gate leads to the garden.'));
  const validated = await validate(store);
  const applied = await runSyncStatus({ store, workId: 'w', action: 'apply', approvalId: validated.approvalId, providers: noModel });
  assert.equal(applied.status, 'completed', JSON.stringify(applied));
  const { foundation } = (await createPublicationUnit({ rootDir: store.rootDir }).readPublished()).value.tree;
  assert.equal(foundation.characters.find((c) => c.id === 'kai').description, description);
  const fact = foundation.worldFacts.find((f) => f.id === 'w1');
  assert.equal(fact.registeredAtChapter, 12);
  assert.equal(fact.statement, 'A gate leads to the garden.');
  assert.doesNotMatch(fact.statement, /\[/);
});

test('a document without gates validates with no canonGates key and the existing diff shape', async () => {
  const { store, settingPath } = await publishedWork();
  await editSetting(settingPath);
  const validated = await validate(store);
  assert.equal(validated.status, 'awaiting_approval', JSON.stringify(validated));
  assert.equal('canonGates' in validated, false);
  assert.deepEqual(validated.designDiff.worldFacts.changed, [{ id: 'w1', before: 'A gate leads to the garden.', after: 'A gate leads to the orchard.' }]);
  assert.doesNotMatch(validated.nextAction, /처음부터|게이트/);
});
