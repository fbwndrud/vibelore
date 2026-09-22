/**
 * The loop the plugin exists to support: init -> context -> check -> commit ->
 * context, with chapter 1 visibly carried into chapter 2.
 *
 * Runs with no model at all (the relay answers nothing), which is the mode a
 * user gets before their host agent joins in -- so these tests also pin down
 * that the deterministic-only path is a real, useful mode rather than a
 * degraded one.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { runInit } from '../src/tools/init.js';
import { buildContext } from '../src/tools/context.js';
import { runCheck } from '../src/tools/check.js';
import { runCommit, runStatus } from '../src/tools/commit.js';

const WORK = 'tower';
const nullRelay = () => createHostRelay({});

const CH1 = [
  '리엘은 탑을 올려다보았다. 은발이 바람에 흩어졌다.',
  '',
  '"오늘은 오를 거야." 리엘이 말했다.',
  '',
  '카이는 대답하지 않았다. 그는 탑의 그림자만 바라보고 있었다.',
  '문은 잠겨 있었다. 백 년째 그랬듯이.',
].join('\n');

async function freshProject() {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-loop-')));
  await runInit({
    store, workId: WORK, genre: 'action', povMode: '3인칭제한', targetChapters: 40,
    worldFacts: ['검은 탑은 백 년째 아무도 오르지 못했다.', '마력은 피를 통해서만 유전된다.'],
  });
  const f = await store.loadFoundation(WORK);
  await store.saveFoundation({
    ...f,
    characters: [
      {
        id: 'riel', canonicalName: '리엘', aliases: ['리엘 아르덴'], registeredAtChapter: 1,
        contradiction: '탑을 증오하면서도 오르는 것이 유일한 꿈이다',
        intrinsic: { gender: 'female', ageBand: '20대초반', birthOrder: '장녀', role: '주인공', coreAppearance: ['은발', '벽안'] },
      },
      {
        id: 'kai', canonicalName: '카이', aliases: [], registeredAtChapter: 1,
        contradiction: '탑지기이면서 탑이 무너지기를 바란다',
        intrinsic: { gender: 'male', ageBand: '30대', birthOrder: '차남', role: '조력자', coreAppearance: ['흑발'] },
      },
    ],
  });
  return store;
}

describe('the writing loop', () => {
  let store;
  before(async () => { store = await freshProject(); });

  it('init is idempotent -- a second run adopts instead of overwriting', async () => {
    const again = await runInit({ store, workId: WORK, genre: 'action' });
    assert.equal(again.adopted, true);
    assert.equal(again.characters, 2);
  });

  it('rejects a genre the engine does not know, and says which it does', async () => {
    const s = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-genre-')));
    await assert.rejects(
      () => runInit({ store: s, workId: 'x', genre: 'not-a-genre' }),
      /사용 가능:/,
    );
  });

  it('context for chapter 1 carries the world and the pinned cast', async () => {
    const { context, meta } = await buildContext({ store, workId: WORK, chapter: 1, targetChapters: 40 });
    assert.match(context, /검은 탑은 백 년째/);
    assert.match(context, /리엘/);
    assert.match(context, /외형=은발·벽안/);
    assert.match(context, /탑을 증오하면서도/);
    assert.equal(meta.characterCount, 2);
    assert.equal(meta.worldFactCount, 2);
    assert.equal(meta.arcPosition, 'opening');
  });

  it('checks a draft with no model available and still returns real findings', async () => {
    const result = await runCheck({
      store, workId: WORK, chapter: 1, prose: CH1, providers: nullRelay(), targetChapters: 40,
    });
    assert.ok(['clean', 'soft-only', 'blocked'].includes(result.verdict));
    assert.equal(typeof result.prosody.score, 'number');
    assert.ok(result.prosody.score >= 0 && result.prosody.score <= 100);
    assert.ok(Array.isArray(result.violations));
    assert.equal(result.scanErrors, undefined, `scans threw: ${JSON.stringify(result.scanErrors)}`);
  });

  it('carries a manual check receipt and semantic delta into commit', async () => {
    const manualStore = await freshProject();
    const spine = {
      workId: WORK,
      status: 'active',
      dramaticQuestion: '리엘은 탑을 오를 수 있는가?',
    };
    await manualStore.saveStorySpine(WORK, spine);
    const providers = {
      pending: [],
      async complete(request) {
        if (request.step === 'continuity-extract') {
          return { text: JSON.stringify({
            influenceEvents: [],
            noInfluenceReason: '문장 표현만 바로잡아 인물의 선택과 관계 변화는 기존 장면과 동일하다.',
          }) };
        }
        if (request.step === 'continuity-check') {
          return { text: JSON.stringify({ intrinsicViolations: [], invariantViolations: [], unjustifiedMutable: [], lexiconAdditions: [] }) };
        }
        return { text: JSON.stringify({ findings: [] }) };
      },
    };
    const checked = await runCheck({
      store: manualStore,
      workId: WORK,
      chapter: 1,
      prose: CH1,
      providers,
      issueReceipt: true,
    });

    assert.match(checked.checkId, /^check-/);
    const committed = await runCommit({
      store: manualStore,
      workId: WORK,
      chapter: 1,
      prose: CH1,
      summary: '리엘이 탑 앞에 섰다.',
      providers,
      checkId: checked.checkId,
    });
    assert.equal(committed.committed, 1);
    assert.ok((await manualStore.loadCheckReceipt(WORK, checked.checkId)).consumedAt);
  });

  it('commits chapter 1 and writes files the writer can open', async () => {
    const res = await runCommit({
      store, workId: WORK, chapter: 1, prose: CH1, title: '탑 아래에서',
      summary: '리엘이 카이와 함께 탑 앞에 섰다. 문은 열리지 않았다.',
      providers: nullRelay(),
    });
    assert.equal(res.committed, 1);
    assert.deepEqual(await store.listChapters(), [1]);
    const back = await store.loadArtifact(WORK, 1);
    assert.equal(back.prose, CH1);
    assert.equal(back.title, '탑 아래에서');
  });

  it('strips internal cast metadata before canonical prose is written', async () => {
    const isolatedStore = await freshProject();
    const prose = `${CH1}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"riel","addressTermsUsed":[]}]}⟧`;
    await runCommit({
      store: isolatedStore, workId: WORK, chapter: 1, prose,
      summary: '리엘이 탑 앞에 섰다.', providers: nullRelay(),
    });
    const saved = await isolatedStore.loadArtifact(WORK, 1);
    assert.equal(saved.prose, CH1);
    assert.doesNotMatch(saved.prose, /⟦vle:/);
  });

  it('blocks a bare internal character ID even when its sentinel wrapper is gone', async () => {
    const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-id-leak-')));
    await runInit({ store, workId: 'id-leak', genre: 'other', povMode: '3인칭제한', targetChapters: 3, worldFacts: ['도윤은 코치다.'] });
    const foundation = await store.loadFoundation('id-leak');
    foundation.characters = [{ id: 'seo_doyun', canonicalName: '서도윤', aliases: [], contradiction: '', registeredAtChapter: 1, intrinsic: {}, mutable: { status: 'alive', knownFacts: [] }, relationships: [] }];
    await store.saveFoundation(foundation);
    await assert.rejects(() => runCommit({ store, workId: 'id-leak', chapter: 1, prose: '서도윤이 섰다.\nseo_doyun|서도윤', summary: '도윤이 섰다.', providers: createHostRelay({}) }), /내부 캐릭터 ID/);
    foundation.characters[0].id = 'seo-doyun';
    await store.saveFoundation(foundation);
    await assert.rejects(() => runCommit({ store, workId: 'id-leak', chapter: 1, prose: '서도윤이 섰다.\nseo-doyun|서도윤', summary: '도윤이 섰다.', providers: createHostRelay({}) }), /캐스트 이름 목록/);
    await assert.rejects(() => runCommit({ store, workId: 'id-leak', chapter: 1, prose: '서도윤이 섰다.\n\n- 서도윤', summary: '도윤이 섰다.', providers: createHostRelay({}) }), /캐스트 이름 목록/);
    foundation.characters.push(
      { id: 'han_jaehyuk', canonicalName: '한재혁', aliases: [], contradiction: '', registeredAtChapter: 1, intrinsic: {}, mutable: { status: 'alive', knownFacts: [] }, relationships: [] },
      { id: 'yoon_taeho', canonicalName: '윤태호', aliases: [], contradiction: '', registeredAtChapter: 1, intrinsic: {}, mutable: { status: 'alive', knownFacts: [] }, relationships: [] },
    );
    await store.saveFoundation(foundation);
    await assert.rejects(() => runCommit({ store, workId: 'id-leak', chapter: 1, prose: '서도윤이 섰다.\n\n- 서도윤\n- 한재혁\n- 윤태호', summary: '도윤이 섰다.', providers: createHostRelay({}) }), /캐스트 이름 목록/);
  });

  it('context for chapter 2 remembers chapter 1', async () => {
    const { context, meta } = await buildContext({ store, workId: WORK, chapter: 2, targetChapters: 40 });
    assert.match(context, /문은 열리지 않았다/);
    assert.match(context, /검은 탑은 백 년째/);
    assert.equal(meta.recentSummaries, 1);
  });

  it('generates a chapter summary through the host relay when omitted', async () => {
    const autoStore = await freshProject();
    const firstRelay = createHostRelay({});
    await runCommit({
      store: autoStore, workId: WORK, chapter: 1, prose: CH1, title: '자동 요약',
      providers: firstRelay,
    });

    const request = firstRelay.pending.find((item) => item.step === 'chapter-summary');
    assert.ok(request, 'chapter-summary 모델 요청이 생성되어야 합니다');

    const answer = JSON.stringify({
      summary: '리엘과 카이는 백 년째 잠긴 탑의 문 앞에 선다. 리엘은 오늘 탑을 오르겠다고 선언하지만 문은 여전히 열리지 않는다.',
      plotBeat: 'inciting',
      sceneTags: ['대화', '긴장'],
      povCharacter: 'riel',
    });
    const resumed = await runCommit({
      store: autoStore, workId: WORK, chapter: 1, prose: CH1, title: '자동 요약',
      providers: createHostRelay({ [request.id]: answer }),
    });

    assert.equal(resumed.summary.source, 'generated');
    assert.equal(resumed.summary.plotBeat, 'inciting');
    const saved = await autoStore.loadChapterSummary(WORK, 1);
    assert.match(saved.summary, /백 년째 잠긴 탑/);
    const { context, meta } = await buildContext({ store: autoStore, workId: WORK, chapter: 2 });
    assert.match(context, /리엘과 카이는 백 년째 잠긴 탑/);
    assert.equal(meta.recentSummaries, 1);
  });

  it('keeps a writer-provided summary and does not ask the model to replace it', async () => {
    const manualStore = await freshProject();
    const relay = createHostRelay({});
    const result = await runCommit({
      store: manualStore, workId: WORK, chapter: 1, prose: CH1,
      summary: '작가가 직접 고정한 요약이다.', providers: relay,
    });

    assert.equal(result.summary.source, 'provided');
    assert.equal(result.summary.text, '작가가 직접 고정한 요약이다.');
    assert.equal(relay.pending.some((item) => item.step === 'chapter-summary'), false);
  });

  it('status reports where the work stands', async () => {
    const s = await runStatus({ store, workId: WORK });
    assert.equal(s.initialized, true);
    assert.equal(s.nextChapter, 2);
    assert.equal(s.chapters.count, 1);
    assert.deepEqual(s.characters.map((c) => c.id), ['kai', 'riel']);
    assert.equal(s.runtime.contractVersion, 'readability-v1');
  });

  it('does not treat an unaccepted working-state edit as published canon', async () => {
    const state = await store.loadStoryState(WORK, 1);
    await store.saveStoryState({
      ...state,
      hooks: [{
        id: 'sealed-door',
        text: '백 년째 잠긴 탑의 문이 왜 열리지 않는지 밝혀지지 않았다.',
        plantedAtChapter: 1,
        phase: 'planted',
        horizon: 'arc',
        lastMovedChapter: 1,
      }],
    });

    const status = await runStatus({ store, workId: WORK });
    assert.deepEqual(status.openHooks, []);

    const { context } = await buildContext({ store, workId: WORK, chapter: 2, targetChapters: 40 });
    assert.doesNotMatch(context, /백 년째 잠긴 탑의 문이 왜 열리지 않는지/);
    assert.doesNotMatch(context, /undefined/);
  });
});

describe('catching what a model reading its own draft would miss', () => {
  it('flags an honorific that contradicts an established relationship', async () => {
    const store = await freshProject();
    // 리엘 is registered female; a male-only honorific applied to her is exactly
    // the kind of drift that survives a self-review and breaks a reader's trust.
    const prose = '리엘은 문 앞에 섰다.\n\n"형님, 저를 데려가 주십시오." 카이가 리엘에게 말했다.';
    const result = await runCheck({
      store, workId: WORK, chapter: 1, prose, providers: createHostRelay({}), targetChapters: 40,
    });
    assert.equal(result.scanErrors, undefined);
    assert.ok(result.violations.length > 0, '위반이 하나도 잡히지 않았습니다');
  });

  it('records what the model was asked, so the host can answer it', async () => {
    const store = await freshProject();
    const relay = createHostRelay({});
    await runCheck({ store, workId: WORK, chapter: 1, prose: CH1, providers: relay, targetChapters: 40 });
    const pending = relay.pending;
    assert.ok(pending.length >= 2, `기대: extract + check 최소 2건, 실제 ${pending.length}`);
    for (const p of pending) {
      assert.match(p.id, /^[0-9a-f]{64}$/);
      assert.ok(p.system.length > 0 && p.user.length > 0);
    }
    assert.ok(pending.some((p) => p.step === 'continuity-extract'));
    assert.ok(pending.some((p) => p.step === 'continuity-check'));
  });

  it('the same question gets the same id across passes, so answers stick', async () => {
    const store = await freshProject();
    const a = createHostRelay({});
    await runCheck({ store, workId: WORK, chapter: 1, prose: CH1, providers: a, targetChapters: 40 });
    const b = createHostRelay({});
    await runCheck({ store, workId: WORK, chapter: 1, prose: CH1, providers: b, targetChapters: 40 });
    assert.deepEqual(a.pending.map((p) => p.id).sort(), b.pending.map((p) => p.id).sort());
  });
});
