import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { legacyWorkFixture } from './fixtures/legacy-work.js';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runStatus } from '../src/tools/commit.js';
import { buildContext } from '../src/tools/context.js';
import { characterFidelityContext } from '../src/tools/character-fidelity.js';
import { renderCheckSections } from '../src/core/prompt-sections.js';
import { emptyStoryState } from '../engine/src/continuity/story-state.js';
import { promptKit } from '../src/prompts/index.js';
import { buildLanguageContract } from '../engine/src/core/language-policy.js';

const workId = 'reader-work';
const kit = promptKit({ contract: buildLanguageContract({ language: 'ko' }) });
const foundation = {
  genre: 'other', intrinsicChanges: [], worldFacts: [],
  characters: [
    { id: 'c1', canonicalName: '리아', registeredAtChapter: 1, intrinsic: { gender: 'female' }, mutable: {} },
    { id: 'c2', canonicalName: '도윤', registeredAtChapter: 1, intrinsic: { gender: 'male' }, mutable: {} },
  ],
};
const hooks = [
  { id: 'open', text: 'OPEN_HOOK', status: 'open', plantedAtChapter: 1 },
  { id: 'parked', text: 'DORMANT_HOOK', status: 'dormant', plantedAtChapter: 1 },
  { id: 'done', text: 'PAID_HOOK', phase: 'paid', plantedAtChapter: 1 },
];
const ledgerState = (chapterNumber) => ({
  ...emptyStoryState(workId), chapterNumber, hooks,
  ledger: { records: [
    { id: 'o1', feature: 'objects', label: '물건', name: '구겨진 쪽지', aliases: [], status: 'active', fields: { holder: 'c2' }, registeredAt: 1, lastEventAt: chapterNumber, recent: [] },
    { id: 'k1', feature: 'knowledge', label: '비밀', name: 'KNOWLEDGE_SECRET', aliases: [], status: 'secret', fields: { knower: 'c1' }, registeredAt: 1, lastEventAt: chapterNumber, recent: [] },
  ] },
});

async function workWithHooks() {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-readers-')));
  await legacyWorkFixture({ store, workId, genre: 'other', povMode: '3인칭제한', targetChapters: 10 });
  await store.saveArtifact({ workId, chapterNumber: 1, prose: '가', delta: { chapterNumber: 1 } });
  await store.saveStoryState(ledgerState(1));
  return store;
}

test('status lists only open hooks as open', async () => {
  const store = await workWithHooks();
  const status = await runStatus({ store, workId });
  assert.deepEqual(status.openHooks, ['OPEN_HOOK']);
});

test('context counts only open hooks', async () => {
  const store = await workWithHooks();
  const built = await buildContext({ store, workId, chapter: 2 });
  assert.equal(built.meta.openHooks, 1);
  assert.match(built.context, /OPEN_HOOK/);
  assert.doesNotMatch(built.context, /PAID_HOOK|DORMANT_HOOK/);
});

test('the fidelity context leaves out records of a feature the author turned off', () => {
  const prevState = ledgerState(3);
  const input = { foundation, chapter: 4, episodePlan: { cast: ['c1', 'c2'] }, prevState, kit };
  assert.match(characterFidelityContext(input), /KNOWLEDGE_SECRET/);
  const off = characterFidelityContext({ ...input, config: { tracking: { knowledge: false } } });
  assert.match(off, /구겨진 쪽지/);
  assert.doesNotMatch(off, /KNOWLEDGE_SECRET/);
});

test('the check shows ledger ops and the prior value of each touched record', () => {
  const prevState = ledgerState(3);
  const delta = { appearedCharacterIds: ['c1'], ledgerOps: [
    { op: 'event', id: 'o1', event: 'changed', set: { holder: 'c1' }, note: '넘겨받음' },
    { op: 'register', feature: 'objects', label: '물건', name: '새 열쇠', fields: { holder: 'c1' } },
    { op: 'event', id: 'k1', event: 'status', status: 'public' },
  ] };
  const sections = renderCheckSections({ foundation, prevState, delta, kit, focusText: '', config: { tracking: { knowledge: false } } });
  assert.match(sections.delta, /\[delta\.ledgerOps\[0\]\][^\n]*구겨진 쪽지[^\n]*리아[^\n]*넘겨받음/);
  assert.match(sections.delta, /\[delta\.ledgerOps\[1\]\][^\n]*새 열쇠[^\n]*리아/);
  assert.match(sections.prev, /구겨진 쪽지[^\n]*도윤/);
  assert.doesNotMatch(sections.delta + sections.prev, /KNOWLEDGE_SECRET|ledgerOps\[2\]/);
});
