import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runStoryProfileStatus } from '../src/tools/story-profile.js';

const emptyStore = async () => new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'profile-decisions-')));

test('lore_profile_status shows stored decisions without changing the profile file', async () => {
  const store = await emptyStore();
  const saved = { workId: 'w', status: 'active', revision: 3, language: 'en', approvedAt: '2026-10-28T01:00:00.000Z',
    discovery: { depth: 'deep', focus: [], authority: 'user', userAnswer: 'Let us decide everything together.' },
    worldbuilding: { scope: 'story', focus: [], authority: 'user' } };
  await store.saveStoryProfile('w', saved);
  const status = await runStoryProfileStatus({ store, workId: 'w' });
  assert.deepEqual(status.decisions.map(d => [d.topic, d.authority]),
    [['preparation-depth', 'user'], ['worldbuilding-scope', 'legacy'], ['story-profile', 'approval']]);
  assert.ok(status.decisions.every(d => d.target.revision === 3));
  assert.deepEqual(await store.loadStoryProfile('w'), saved);
});

test('lore_profile_status without a profile has no decisions field', async () => {
  const status = await runStoryProfileStatus({ store: await emptyStore(), workId: 'w' });
  assert.equal(status.profiled, false);
  assert.equal(status.decisions, undefined);
});
