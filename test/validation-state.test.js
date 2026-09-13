import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { resolveWorkLanguage, executionFoundationSnapshot } from '../src/core/work-language.js';

test('approval validation persists independently by work and stage, rejecting path traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibelore-validation-state-'));
  const store = new MarkdownStateStore(dir);
  await store.saveApprovalValidation('a', 'profile', { epoch: 2, attempts: 3, status: 'clean_fail' });
  await store.saveApprovalValidation('b', 'profile', { epoch: 1 });
  const reopened = new MarkdownStateStore(dir);
  assert.equal((await reopened.loadApprovalValidation('a', 'profile')).attempts, 3);
  assert.equal((await reopened.loadApprovalValidation('b', 'profile')).epoch, 1);
  assert.equal(await reopened.loadApprovalValidation('a', 'arc'), null);
  await assert.rejects(() => store.saveApprovalValidation('a', '../outside', {}));
});

test('accepted-work resolution pins default and approved explicit modes without rewriting legacy metadata', async () => {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-validation-mode-')));
  assert.equal((await resolveWorkLanguage({ store, workId: 'w', requested: 'ja' })).contract.formatPolicy.dialogueBreakMode, 'natural');
  await store.saveStoryProfile('w', { language: 'ko', status: 'active', format: { dialogueBreakMode: 'relaxed' } });
  const resolution = await resolveWorkLanguage({ store, workId: 'w' });
  assert.equal(resolution.contract.formatPolicy.dialogueBreakMode, 'relaxed');
  const original = { workId: 'w', length: { unit: 'legacyCodeUnits', target: 900 } };
  const snapshot = executionFoundationSnapshot(original, resolution.contract);
  assert.equal(snapshot.length.target, resolution.contract.length.target);
  assert.equal(original.length.target, 900);
  assert.equal(Object.hasOwn(original, 'language'), false);
});
