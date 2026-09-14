/**
 * The store is where a writer's trust is won or lost: they will open these
 * files in their own editor, change things, and expect the engine to notice
 * rather than clobber. These tests are mostly about that.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { createFoundation, registerCharacter } from '../engine/src/continuity/foundation.js';
import { createGenreProfileRegistry } from '../engine/src/continuity/genre-profile.js';
import { emptyStoryState } from '../engine/src/continuity/story-state.js';

const registry = createGenreProfileRegistry();
const newStore = async () => new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-')));

function sampleFoundation() {
  let f = createFoundation({
    workId: 'my-novel',
    genre: 'action',
    genreProfile: registry.get('action'),
    povMode: '3인칭제한',
  });
  f = { ...f, worldFacts: [
    { id: 'w1', statement: '검은 탑은 백 년째 아무도 오르지 못했다.', registeredAtChapter: 1 },
    { id: 'w2', statement: '마력은 피를 통해서만 유전된다.', registeredAtChapter: 2 },
  ] };
  f = registerCharacter(f, {
    id: 'riel',
    canonicalName: '리엘',
    aliases: ['리엘 아르덴'],
    registeredAtChapter: 1,
    contradiction: '탑을 증오하면서도 탑에 오르는 것이 유일한 꿈이다',
    intrinsic: {
      gender: 'female', species: 'human', form: 'humanoid', ageBand: '20대초반', birthOrder: '장녀',
      role: '주인공', coreAppearance: ['은발', '벽안'],
      addressing: { acceptedPronouns: [], acceptedGenderedTerms: ['아가씨'], forbiddenGenderedTerms: [] },
    },
    dramaticModel: { valueOrder: ['선택권', '명예', '성취'], behaviorTraits: [{ trigger: '동료의 위험', actionBias: '먼저 막는다', benefit: '위기를 줄인다', cost: '선택권을 빼앗는다' }], perception: { seesFirst: ['책임'], missesFirst: ['호의'] }, defense: { public: '업무로 말한다', underPressure: '선택지를 줄인다' }, repair: { firstMove: '권한을 돌려준다', cannotDo: '상처를 말한다' }, privateDelights: ['낙서'], unproductiveWant: '저녁을 먹는다', dimensionBaselines: { control: 3, reciprocity: 1 }, genreDetails: {} },
  });
  return f;
}

describe('MarkdownStateStore -- Foundation', () => {
  it('round-trips a foundation without loss', async () => {
    const store = await newStore();
    const f = sampleFoundation();
    await store.saveFoundation(f);
    const back = await store.loadFoundation('my-novel');
    assert.deepEqual(back.worldFacts, f.worldFacts);
    assert.deepEqual(back.characters, f.characters);
    assert.equal(back.genre, f.genre);
    assert.equal(back.povMode, f.povMode);
    assert.deepEqual(back.genreProfile, f.genreProfile);
  });

  it('returns null for a directory that holds no work', async () => {
    const store = await newStore();
    assert.equal(await store.loadFoundation('my-novel'), null);
  });

  it('writes files a human can actually read', async () => {
    const store = await newStore();
    await store.saveFoundation(sampleFoundation());
    const setting = await readFile(store.settingPath, 'utf8');
    assert.match(setting, /genre: action/);
    assert.match(setting, /## 세계 사실/);
    assert.match(setting, /검은 탑은 백 년째/);
    const char = await readFile(store.characterPath('riel'), 'utf8');
    assert.match(char, /name: 리엘/);
    assert.match(char, /appearance: \[은발, 벽안\]/);
    assert.match(char, /## 모순/);
    assert.match(char, /species: human/);
    assert.match(char, /## 극적 모델/);
  });

  it('takes a hand edit as the truth', async () => {
    const store = await newStore();
    await store.saveFoundation(sampleFoundation());

    const path = store.characterPath('riel');
    const edited = (await readFile(path, 'utf8'))
      .replace('appearance: [은발, 벽안]', 'appearance: [흑발, 벽안]')
      .replace('name: 리엘', 'name: 리엘 아르덴');
    await writeFile(path, edited, 'utf8');

    const back = await store.loadFoundation('my-novel');
    const riel = back.characters.find((c) => c.id === 'riel');
    assert.deepEqual(riel.intrinsic.coreAppearance, ['흑발', '벽안']);
    assert.equal(riel.canonicalName, '리엘 아르덴');
  });

  it('does not clobber a hand edit when the engine saves again', async () => {
    const store = await newStore();
    await store.saveFoundation(sampleFoundation());
    const path = store.characterPath('riel');
    await writeFile(path, (await readFile(path, 'utf8'))
      .replace('appearance: [은발, 벽안]', 'appearance: [흑발, 벽안]'), 'utf8');

    // The engine's normal cycle: load, change something unrelated, save.
    const loaded = await store.loadFoundation('my-novel');
    await store.saveFoundation({
      ...loaded,
      worldFacts: [...loaded.worldFacts, { id: 'w3', statement: '탑의 문은 만월에만 열린다.', registeredAtChapter: 3 }],
    });

    const back = await store.loadFoundation('my-novel');
    assert.deepEqual(back.characters.find((c) => c.id === 'riel').intrinsic.coreAppearance, ['흑발', '벽안']);
    assert.equal(back.worldFacts.length, 3);
  });

  it("keeps the writer's own frontmatter keys and sections", async () => {
    const store = await newStore();
    await store.saveFoundation(sampleFoundation());
    const path = store.characterPath('riel');
    const withNotes = `${await readFile(path, 'utf8')}\n## 메모\n작가 전용 메모. 엔진은 건드리지 말 것.\n`
      .replace('id: riel', 'id: riel\nplaylist: 겨울 노래');
    await writeFile(path, withNotes, 'utf8');

    const loaded = await store.loadFoundation('my-novel');
    await store.saveFoundation(loaded);

    const after = await readFile(path, 'utf8');
    assert.match(after, /## 메모/);
    assert.match(after, /작가 전용 메모/);
    assert.match(after, /playlist: 겨울 노래/);
  });
});

describe('MarkdownStateStore -- chapters, summaries, state', () => {
  it('round-trips an artifact with the prose in the markdown body', async () => {
    const store = await newStore();
    const artifact = {
      workId: 'my-novel', chapterNumber: 1, title: '탑 아래에서',
      prose: '리엘은 탑을 올려다보았다.\n\n바람이 불었다.',
      delta: { appearedCharacterIds: ['riel'] },
    };
    await store.saveArtifact(artifact);
    const back = await store.loadArtifact('my-novel', 1);
    assert.equal(back.prose, artifact.prose);
    assert.equal(back.title, artifact.title);
    assert.deepEqual(back.delta, artifact.delta);

    const raw = await readFile(store.chapterPath(1), 'utf8');
    assert.match(raw, /^---\nchapter: 1\ntitle: 탑 아래에서\n---\n\n리엘은/);
  });

  it('takes a hand-edited chapter as the truth', async () => {
    const store = await newStore();
    await store.saveArtifact({ workId: 'my-novel', chapterNumber: 1, prose: '초고.' });
    const path = store.chapterPath(1);
    await writeFile(path, (await readFile(path, 'utf8')).replace('초고.', '작가가 직접 고친 문장.'), 'utf8');
    assert.equal((await store.loadArtifact('my-novel', 1)).prose, '작가가 직접 고친 문장.');
  });

  it('round-trips story state', async () => {
    const store = await newStore();
    const state = { ...emptyStoryState('my-novel'), chapterNumber: 3, hooks: [{ id: 'h1', text: '탑의 문', phase: 'planted' }] };
    await store.saveStoryState(state);
    assert.deepEqual(await store.loadStoryState('my-novel', 3), state);
    assert.equal(await store.loadStoryState('my-novel', 9), null);
  });

  it('normalizes hook records written by earlier builds', async () => {
    const store = await newStore();
    const legacy = { ...emptyStoryState('my-novel'), chapterNumber: 4, hooks: [{ hookId: 'h1', description: '탑의 문', startChapter: 1, status: 'progressing', payoffTiming: 'slow-burn', lastAdvancedChapter: 3 }] };
    await store.saveStoryState(legacy);
    const loaded = await store.loadStoryState('my-novel', 4);
    assert.deepEqual(loaded.hooks, [{ id: 'h1', text: '탑의 문', plantedAtChapter: 1, phase: 'advancing', horizon: 'long', lastMovedChapter: 3 }]);
  });

  it('returns recent summaries newest first, bounded by limit', async () => {
    const store = await newStore();
    for (const n of [1, 2, 3, 4]) {
      await store.saveChapterSummary({ workId: 'my-novel', chapterNumber: n, summary: `${n}화 요약` });
    }
    const recent = await store.loadRecentChapterSummaries('my-novel', 4, 2);
    assert.deepEqual(recent.map((r) => r.chapterNumber), [3, 2]);
    assert.equal(recent[0].summary, '3화 요약');
    assert.deepEqual(await store.loadRecentChapterSummaries('my-novel', 4, 0), []);
    assert.deepEqual(await store.loadRecentChapterSummaries('my-novel', 1, 5), []);
  });

  it('lists chapters in order', async () => {
    const store = await newStore();
    for (const n of [2, 10, 1]) {
      await store.saveArtifact({ workId: 'my-novel', chapterNumber: n, prose: `${n}` });
    }
    assert.deepEqual(await store.listChapters(), [1, 2, 10]);
  });

  it('rejects ids that would escape the project directory', async () => {
    const store = await newStore();
    await assert.rejects(() => store.loadFoundation('../etc'), /invalid workId/);
    await assert.rejects(() => store.saveJob({ workId: 'ok', id: '../x' }), /invalid jobId/);
  });

  it('persists workflow state, append-only events, and check receipts', async () => {
    const store = await newStore();
    const workflow = { workflowId: 'wf-abc', workId: 'my-novel', chapter: 1, stage: 'drafting' };
    await store.saveWorkflow('my-novel', workflow);
    await store.appendWorkflowEvent('my-novel', 'wf-abc', { at: '2026-01-01', event: 'started' });
    await store.appendWorkflowEvent('my-novel', 'wf-abc', { at: '2026-01-02', event: 'checked' });
    const receipt = { checkId: 'check-abc', workId: 'my-novel', chapter: 1, proseHash: 'sha256:x', verdict: 'passed' };
    await store.saveCheckReceipt('my-novel', receipt);
    assert.deepEqual(await store.loadWorkflow('my-novel'), workflow);
    assert.deepEqual((await store.loadWorkflowEvents('my-novel', 'wf-abc')).map((e) => e.event), ['started', 'checked']);
    assert.deepEqual(await store.loadCheckReceipt('my-novel', 'check-abc'), receipt);
  });
});
