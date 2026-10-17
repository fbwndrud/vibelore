import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { captureWorkingTreeFingerprint, detectWorkingTreeDrift } from '../src/core/working-tree-sync.js';
import { createPublicationUnit } from '../src/core/publication-unit.js';
import { runSyncStatus } from '../src/tools/sync.js';
import { runStoryProfile } from '../src/tools/story-profile.js';
import { approvalResponse } from './fixtures/approval-response.js';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';

async function temporaryStore(t) {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-boundaries-')));
  t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  return store;
}

const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
for (const [before, after] of [
  ['The hostage is now here.', 'The hostage is nowhere.'],
  ['아버지가 방에 있다.', '아버지 가방에 있다.'],
  ['{"password":"a  b"}', '{"password":"a b"}'],
]) test(`word boundaries and literal whitespace remain author edits: ${before}`, async t => {
  const store = await temporaryStore(t);
  await mkdir(join(store.rootDir, 'world'));
  const path = join(store.rootDir, 'world', 'setting.md');
  await writeFile(path, before);
  const captured = await captureWorkingTreeFingerprint({ store, sourceHead: 'head' });
  // Old fingerprints also contain a raw digest; migrating must not bless an edit.
  await store.saveWorkingTreeFingerprint({ ...captured, inventory: captured.inventory.map(item => ({
    ...item, contentDigest: digest(before.normalize('NFC').replace(/\s+/gu, '')),
  })) });
  assert.equal((await detectWorkingTreeDrift({ store, sourceHead: 'head' })).status, 'clean');
  await writeFile(path, after);
  assert.deepEqual((await detectWorkingTreeDrift({ store, sourceHead: 'head' })).changed, ['world/setting.md']);
});

test('a managed plan save cannot erase a word-boundary edit or update its sidecar', async t => {
  const store = await temporaryStore(t), spine = { status: 'active', dramaticQuestion: 'Is the hostage now here?' };
  await store.saveStorySpine('book', spine);
  await captureWorkingTreeFingerprint({ store, sourceHead: 'head' });
  const original = await readFile(store.storySpinePath, 'utf8');
  const edited = original.replace('now here', 'nowhere');
  await writeFile(store.storySpinePath, edited);
  await assert.rejects(store.saveStorySpine('book', { ...spine, status: 'pending' }), { code: 'WORKING_TREE_DRIFT' });
  assert.equal(await readFile(store.storySpinePath, 'utf8'), edited);
  assert.deepEqual(await store.loadStorySpine('book'), spine);
});

async function publishedStore(t) {
  const store = await qualityStore();
  t.after(() => rm(store.rootDir, { recursive: true, force: true }));
  const written = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: {
    async complete(req) { return contractResponse(req) ?? { text: outputs[req.step] ?? '{}' }; },
  } });
  assert.equal(written.status, 'completed');
  return store;
}

for (const name of ['story-spine', 'writer-skill']) test(`sync preserves unsupported ${name} edits without accepting a baseline`, async t => {
  const store = await publishedStore(t), path = join(store.rootDir, 'world', `${name}.md`);
  const unit = createPublicationUnit({ rootDir: store.rootDir });
  const head = (await unit.readPublished()).value.head;
  const fingerprint = await store.loadWorkingTreeFingerprint();
  const before = name === 'story-spine' ? await store.loadStorySpine(workId) : await store.loadWriterSkill(workId);
  const edited = `${await readFile(path, 'utf8')}\nThe author changed this plan.\n`;
  await writeFile(path, edited);
  const inspected = await runSyncStatus({ store, workId });
  assert.equal(inspected.classification, 'plan_review_required');
  const validated = await runSyncStatus({ store, workId, action: 'validate' });
  assert.equal(validated.status, 'blocked');
  assert.equal(validated.code, 'PLAN_DOCUMENT_SYNC_UNSUPPORTED');
  assert.equal(validated.approvalId, undefined);
  assert.equal((await unit.readPublished()).value.head, head);
  assert.deepEqual(await store.loadWorkingTreeFingerprint(), fingerprint);
  assert.deepEqual(name === 'story-spine' ? await store.loadStorySpine(workId) : await store.loadWriterSkill(workId), before);
  assert.equal(await readFile(path, 'utf8'), edited);
  await assert.rejects(name === 'story-spine' ? store.saveStorySpine(workId, before) : store.saveWriterSkill(workId, before), { code: 'WORKING_TREE_DRIFT' });
  assert.ok((await detectWorkingTreeDrift({ store, sourceHead: head })).changed.includes(`world/${name}.md`));
});

test('a pending design approval cannot bless a later plan edit', async t => {
  const store = await publishedStore(t);
  const text = await readFile(store.settingPath, 'utf8');
  await writeFile(store.settingPath, text.replace('탑은 세금을 걷는다.', '탑은 세금을 걷지 않는다.'));
  const validation = await runSyncStatus({ store, workId, action: 'validate' });
  assert.equal(validation.status, 'awaiting_approval');
  const unit = createPublicationUnit({ rootDir: store.rootDir }), head = (await unit.readPublished()).value.head;
  await writeFile(store.writerSkillPath, `${await readFile(store.writerSkillPath, 'utf8')}\nChanged voice.\n`);
  const applied = await runSyncStatus({ store, workId, action: 'apply', approvalId: validation.approvalId });
  assert.equal(applied.status, 'blocked');
  assert.equal(applied.code, 'PLAN_DOCUMENT_SYNC_UNSUPPORTED');
  assert.equal((await unit.readPublished()).value.head, head);
});

for (const name of ['story-spine', 'writer-skill']) test(`untracked legacy sync does not bless an edited ${name} document`, async t => {
  const store = await publishedStore(t), path = join(store.rootDir, 'world', `${name}.md`);
  const before = name === 'story-spine' ? await store.loadStorySpine(workId) : await store.loadWriterSkill(workId);
  const head = (await createPublicationUnit({ rootDir: store.rootDir }).readPublished()).value.head;
  await store.saveWorkingTreeFingerprint(null);
  const edited = `${await readFile(path, 'utf8')}\nAuthor changed this plan.\n`;
  await writeFile(path, edited);
  for (const action of ['inspect', 'validate']) {
    const result = await runSyncStatus({ store, workId, action });
    assert.equal(result.classification, 'plan_review_required');
    assert.deepEqual(result.planChanges, [`world/${name}.md`]);
  }
  assert.equal(await store.loadWorkingTreeFingerprint(), null);
  assert.equal((await createPublicationUnit({ rootDir: store.rootDir }).readPublished()).value.head, head);
  assert.deepEqual(name === 'story-spine' ? await store.loadStorySpine(workId) : await store.loadWriterSkill(workId), before);
  assert.equal(await readFile(path, 'utf8'), edited);
});

test('untracked legacy sync captures unchanged plan documents but refuses unparsed world documents', async t => {
  const store = await publishedStore(t);
  await store.saveWorkingTreeFingerprint(null);
  assert.equal((await runSyncStatus({ store, workId })).status, 'baseline_captured');
  assert.equal((await runSyncStatus({ store, workId })).status, 'clean');
  await store.saveWorkingTreeFingerprint(null);
  await writeFile(join(store.rootDir, 'world', 'notes.md'), 'Unparsed author notes.\n');
  const result = await runSyncStatus({ store, workId });
  assert.equal(result.classification, 'unsupported_change');
  assert.deepEqual(result.unknownChanges, ['world/notes.md']);
  assert.equal(await store.loadWorkingTreeFingerprint(), null);
});

const answer = '문장은 쉽게 읽히게, 새 개념은 천천히, 추론 부담은 명확하게, 초반은 쉽게 시작해주세요.';
const readability = { surfaceEase: 'easy', conceptPacing: 'slow', inferenceLoad: 'explicit', complexityRamp: 'onboarding-first', confirmedByUser: true };
test('a confirmed reading contract survives an unrelated interview round, but new choices need evidence', async t => {
  const store = await temporaryStore(t);
  const value = { genreLabel: '가족 이야기', discovery: { depth: 'quick', userAnswer: '필수만 정하고 시작해요.' }, readabilityContract: { ...readability } };
  const providers = { pending: [], async complete(req) { return approvalResponse(req) ?? { text: JSON.stringify(value) }; } };
  const args = { store, workId: 'book', brief: '가족 이야기. 필수만 정하고 시작해요.', providers };
  const first = await runStoryProfile({ ...args, feedback: answer });
  assert.equal(first.profile.readabilityContract.confirmedByUser, true);
  // The model flag cannot undo an already verified, unchanged selection either.
  value.readabilityContract.confirmedByUser = false;
  const next = await runStoryProfile({ ...args, feedback: '아버지와 딸은 가까운 사이입니다.' });
  assert.equal(next.profile.readabilityContract.confirmedByUser, true);
  assert.ok(!next.profile.designReview.openQuestions.some(q => q.id === 'reading-experience-contract'));
  value.readabilityContract = { ...readability, surfaceEase: 'dense' };
  const changed = await runStoryProfile({ ...args, feedback: '아버지와 딸은 가까운 사이입니다.' });
  assert.equal(changed.profile.readabilityContract.confirmedByUser, false);
  assert.ok(changed.profile.designReview.openQuestions.some(q => q.id === 'reading-experience-contract'));
});

test('quoted reading answers survive new rounds, while a work-language change requires new confirmation', async t => {
  const store = await temporaryStore(t);
  const quotes = {
    surfaceEase: 'Use easy sentences', conceptPacing: 'Introduce concepts slowly',
    inferenceLoad: 'Make meaning explicit', complexityRamp: 'Start with familiar situations',
  };
  const evidence = Object.fromEntries(Object.entries(quotes).map(([axis, quote]) => [axis, {
    quote, selected: readability[axis], questionId: 'reading-experience-contract',
  }]));
  const value = { genreLabel: 'Family story', readabilityContract: { ...readability, userAnswerEvidence: evidence } };
  const providers = { pending: [], async complete(req) { return approvalResponse(req) ?? { text: JSON.stringify(value) }; } };
  const args = { store, workId: 'book', brief: 'A family story', language: 'en', providers };
  const first = await runStoryProfile({ ...args, feedback: Object.values(quotes).join('. ') });
  assert.equal(first.profile.readabilityContract.confirmedByUser, true);
  const next = await runStoryProfile({ ...args, feedback: 'The father and daughter are close.' });
  assert.equal(next.profile.readabilityContract.confirmedByUser, true);
  assert.deepEqual(next.profile.readabilityContract.userAnswerEvidence, evidence);
  const changed = await runStoryProfile({ ...args, language: 'ja', feedback: 'The father and daughter are close.' });
  assert.equal(changed.profile.readabilityContract.confirmedByUser, false);
});

test('a repeated original brief cannot confirm a changed reading selection or new work language', async t => {
  const store = await temporaryStore(t);
  const value = { genreLabel: '가족 이야기', discovery: { depth: 'quick', userAnswer: '필수만 정하고 시작해요.' }, readabilityContract: { ...readability } };
  const providers = { pending: [], async complete(req) { return approvalResponse(req) ?? { text: JSON.stringify(value) }; } };
  const args = { store, workId: 'book', brief: `가족 이야기. 필수만 정하고 시작해요. ${answer}`, providers };
  assert.equal((await runStoryProfile(args)).profile.readabilityContract.confirmedByUser, true);
  value.readabilityContract.surfaceEase = 'dense';
  const changed = await runStoryProfile({ ...args, feedback: '아버지와 딸은 가까운 사이입니다.' });
  assert.equal(changed.profile.readabilityContract.confirmedByUser, false);
  assert.ok(changed.profile.designReview.openQuestions.some(q => q.id === 'reading-experience-contract'));
  const fresh = await runStoryProfile({ ...args, feedback: '문장 난도는 높게, 새 개념은 천천히, 추론 부담은 명확하게, 초반은 쉽게 시작해주세요.' });
  assert.equal(fresh.profile.readabilityContract.confirmedByUser, true);
  const languageChange = await runStoryProfile({ ...args, language: 'ja', feedback: 'The father and daughter are close.' });
  assert.equal(languageChange.profile.readabilityContract.confirmedByUser, false);
});
