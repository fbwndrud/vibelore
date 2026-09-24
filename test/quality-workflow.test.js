import { contractResponse } from './fixtures/contract-response.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runWriteWorkflow, runWorkflowDecide, runWorkflowHistory, proseHash } from '../src/tools/workflow.js';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { layoutRelayRequests } from '../src/core/relay-prompt-layout.js';

describe('first-draft quality through the writing workflow', () => {
  it('does not publish a resumed legacy ready draft without a completed review', async () => {
    const store = await qualityStore();
    let calls = 0;
    const providers = { async complete(req) { const contract = contractResponse(req); if (contract) return contract; calls++; return { text: outputs[req.step] ?? '{}' }; } };
    await runWriteWorkflow({ store, workId, autonomy: 'guided', providers });
    const workflow = await store.loadWorkflow(workId);
    const receipt = await store.loadCheckReceipt(workId, workflow.checkId);
    delete receipt.review;
    await store.saveCheckReceipt(workId, receipt);
    workflow.stage = 'ready_to_commit';
    await store.saveWorkflow(workId, workflow);
    const before = calls;
    const resumed = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers });
    assert.equal(resumed.status, 'awaiting_approval');
    assert.equal(resumed.degraded.code, 'CRITIC_INCOMPLETE');
    assert.equal(calls, before);
    assert.deepEqual(await store.listChapters(), []);
  });

  it('delivers approved voice and prior knowledge, preserves high-score findings and replays exact exchanges', async () => {
    const store = await qualityStore();
    const requests = [];
    const finding = { code: 'OVERLONG_DENSITY', message: '현장 설명이 길다', evidence: '문', confidence: 0.81, scope: 'chapter' };
    const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: {
      provenance: { kind: 'test', contextIsolation: 'request-messages-only' },
      async complete(req) { const contract = contractResponse(req); if (contract) return contract;
        requests.push(req);
        return { text: req.step === 'editorial-quality' ? JSON.stringify({ score: 87, dimensions: { density: 80 }, findings: [finding] }) : outputs[req.step] ?? '{}' };
      },
    } });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const draft = requests.find((req) => req.step === 'draft');
    const text = draft.messages.map((m) => m.content).join('\n');
    assert.match(text, /놀이를 실제로 즐기는 약속/);
    assert.match(text, /능청스럽게/);
    assert.match(text, /2006.*2026/);
    assert.match(text, /지도 확대는 이미 배웠다/);
    assert.match(text, /지도는 배웠다. 이제 바다/);
    assert.match(text, /세상은 구했으니/);
    const editorialText = requests.find((req) => req.step === 'editorial-quality').messages.map((m) => m.content).join('\n');
    assert.doesNotMatch(editorialText, /EpisodePlan|놀이를 실제로 즐기는 약속/);
    assert.equal(requests.filter((req) => req.step === 'revise').length, 0);
    assert.ok(result.quality.advisories.some((item) => item.code === 'OVERLONG_DENSITY'));
    assert.equal(result.quality.review.status, 'completed');
    const workflow = await store.loadWorkflow(workId);
    const receipt = await store.loadCheckReceipt(workId, workflow.checkId);
    assert.equal(receipt.review.proseHash, receipt.proseHash);
    assert.equal(receipt.review.records.find((r) => r.step === 'editorial-quality').findings[0].message, finding.message);
    const concise = await runWorkflowHistory({ store, workId });
    assert.equal(concise.modelExchanges, undefined);
    const history = await runWorkflowHistory({ store, workId, includeModelExchanges: true });
    assert.ok(history.events.some((e) => e.event === 'runtime_identified' && e.runtime.sourceTreeHash.startsWith('sha256:')));
    const saved = history.modelExchanges.find((item) => item.exchange.request.step === 'draft');
    assert.deepEqual(saved.exchange.request, draft);
    assert.equal(history.events.filter((e) => e.event === 'reviews_completed').length, 1);
  });

  for (const failure of ['malformed', 'missing', 'exception']) {
    it(`preserves the auto draft for guided approval after a ${failure} review`, async () => {
      const store = await qualityStore();
      let calls = 0;
      const providers = { async complete(req) { const contract = contractResponse(req); if (contract) return contract;
        calls++;
        if (req.step === 'editorial-quality') {
          if (failure === 'exception') throw new Error('provider unavailable');
          return { text: failure === 'malformed' ? '{no json' : '{}' };
        }
        return { text: outputs[req.step] ?? '{}' };
      } };
      const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers });
      assert.equal(result.status, 'awaiting_approval');
      assert.equal(result.degraded.code, 'CRITIC_INCOMPLETE');
      assert.equal(result.quality.review.status, 'failed');
      assert.deepEqual(await store.listChapters(), []);
      const count = calls;
      const again = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers });
      assert.equal(calls, count);
      assert.equal(again.approvalId, result.approvalId);
      assert.equal(again.degraded.code, result.degraded.code);
      const approved = await runWorkflowDecide({ store, workId, approvalId: result.approvalId, action: 'approve', providers });
      assert.equal(approved.status, 'completed');
      const workflow = await store.loadWorkflow(workId);
      const receipt = await store.loadCheckReceipt(workId, workflow.checkId);
      assert.equal(receipt.proseHash, proseHash(result.prose));
      assert.equal(receipt.review.status, 'failed');
      assert.ok(receipt.consumedAt);
    });
  }
});

describe('host round trips are batched by dependency', () => {
  async function replayWithRelay(store, autonomy = 'auto', { repeatEachPass = false } = {}) {
    const { createPreflightRelay } = await import('../src/provider/host-relay.js');
    const answers = {};
    const passes = [];
    const ids = [];
    const layouts = [];
    let result;
    for (let pass = 0; pass < 20; pass += 1) {
      let relay = createPreflightRelay(answers);
      result = await runWriteWorkflow({ store, workId, autonomy, providers: relay });
      if (repeatEachPass && relay.pending.length) {
        // A host that calls lore_resume again before answering must see the
        // exact same questions, not a fresh set of request IDs.
        const first = relay.pending.map((req) => req.id);
        relay = createPreflightRelay(answers);
        result = await runWriteWorkflow({ store, workId, autonomy, providers: relay });
        assert.deepEqual(relay.pending.map((req) => req.id), first, `pass ${pass} is idempotent`);
      }
      const steps = relay.pending.map((req) => req.step);
      if (!steps.length) break;
      passes.push(steps);
      ids.push(relay.pending.map((req) => req.id));
      layouts.push(layoutRelayRequests(relay.pending, relay.sharedContexts));
      for (const req of relay.pending) {
        const contract = contractResponse({ step: req.step, messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }] });
        answers[req.id] = contract?.text ?? outputs[req.step] ?? '{}';
      }
    }
    return { result, passes, ids, layouts };
  }

  it('collects every independent review in one pass and defers dependent checks', async () => {
    const store = await qualityStore();
    const { result, passes, layouts } = await replayWithRelay(store);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    // The draft prompt takes its plan from the approved EpisodePlan packet, so
    // no separate engine chapter-plan round trip precedes it.
    assert.deepEqual(passes[0], ['draft']);
    const batch = passes[1];
    // The advisory story-profile-check rides in the same round trip as the
    // extraction and every independent review.
    for (const step of ['continuity-extract', 'story-profile-check', 'coherence-judge', 'editorial-quality', 'character-fidelity', 'reader-hook', 'pattern-ledger']) {
      assert.ok(batch.includes(step), `${step} in first review batch: ${batch}`);
    }
    assert.ok(!batch.includes('continuity-check'), 'continuity-check waits for the extracted delta');
    assert.ok(!batch.includes('continuity-extract-repair'), 'no repair request on a placeholder delta');
    assert.deepEqual(passes[2], ['continuity-check']);
    // Title, summary and the boundary judge read the same checked prose in one
    // round trip; the language proof checks the title and summary, so it follows.
    assert.deepEqual([...passes[3]].sort(), ['chapter-summary', 'chapter-title', 'narrative-boundary']);
    assert.deepEqual(passes[4], ['language-contract']);
    assert.equal(passes.length, 5, JSON.stringify(passes));
    // The three prose readers share one cacheable prose prefix, warmed once.
    const metadata = layouts[3];
    assert.equal(new Set(metadata.map((req) => req.promptCache?.sharedPrefixId)).size, 1);
    assert.ok(metadata.every((req) => req.promptCache?.groupSize === 3), JSON.stringify(metadata.map((req) => req.promptCache)));
    assert.equal(metadata.filter((req) => req.promptCache.warmFirst).length, 1);
  });

  it('never re-asks an answered request and repeats identical IDs on an unanswered resume', async () => {
    const store = await qualityStore();
    const { result, passes, ids } = await replayWithRelay(store, 'auto', { repeatEachPass: true });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(passes.length, 5, JSON.stringify(passes));
    const all = ids.flat();
    assert.equal(new Set(all).size, all.length, 'no request ID is asked in two passes');
  });

  it('keeps summary and boundary together when the plan already names the chapter', async () => {
    const store = await qualityStore();
    const plan = await store.loadEpisodePlan(workId, 1);
    await store.saveEpisodePlan(workId, { ...plan, title: '첫 문' });
    const { result, passes } = await replayWithRelay(store);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual([...passes[3]].sort(), ['chapter-summary', 'narrative-boundary']);
    assert.deepEqual(passes[4], ['language-contract']);
    assert.equal(passes.length, 5, JSON.stringify(passes));
  });

  it('records one quality policy evaluation per attempt across resumed passes', async () => {
    const store = await qualityStore();
    await replayWithRelay(store);
    const history = await runWorkflowHistory({ store, workId });
    assert.equal(history.events.filter((e) => e.event === 'quality_policy_evaluated').length, 1);
    assert.equal(history.events.filter((e) => e.event === 'reviews_completed').length, 1);
  });

  it('shows reviewers a plan view without bookkeeping fields', async () => {
    const store = await qualityStore();
    const plan = await store.loadEpisodePlan(workId, 1);
    await store.saveEpisodePlan(workId, { ...plan, workId, contractVersion: 'mcp-test', createdAt: '2026-01-01T00:00:00.000Z' });
    const requests = [];
    await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: { async complete(req) { requests.push(req); const contract = contractResponse(req); if (contract) return contract; return { text: outputs[req.step] ?? '{}' }; } } });
    for (const step of ['story-profile-check', 'reader-hook']) {
      const text = requests.find((req) => req.step === step).messages.map((m) => m.content).join('\n');
      assert.doesNotMatch(text, /contractVersion|createdAt/, step);
      assert.match(text, /닫힌 문 앞에 선다/, step);
    }
  });
});

// 2026-09-15 en 표본: episode 승인 gate 가 clean_fail 했는데 workflow 가 계획 없이 초안으로 넘어가
// "승인된 상세 EpisodePlan이 없습니다" 로 끝났다. gate 결과를 그대로 돌려줘야 한다.
describe('episode plan gate failure', () => {
  it('returns the gate result instead of drafting without an approved plan', async () => {
    const store = await qualityStore();
    const foundation = await store.loadFoundation(workId);
    await store.saveFoundation({ ...foundation, language: 'ko' });
    const plan = await store.loadEpisodePlan(workId, 1);
    await store.saveEpisodePlan(workId, { ...plan, status: 'rejected' });
    const requests = [];
    const episodePlan = JSON.stringify({ title: '첫 문', premise: '지도에서 본 길을 찾는다', readerBridge: '문 앞에서 길을 고른다', povCharacter: 'hero', cast: ['hero'], foregroundCharacters: ['hero'],
      locations: ['탑 입구'], openingState: '문 앞', closingState: '안에 들어감', immediateGoal: '입장', obstacle: '잠긴 문', choice: '문을 민다', outcome: '문이 열린다', nextQuestion: '안에는 무엇이 있나',
      readerLoad: { phase: 'onboarding', newConcepts: ['탑의 세금'] }, scenes: [{ location: '탑 입구', characters: ['hero'], situation: '닫힌 문 앞에 선다', choice: '문을 민다', change: '문이 열린다' }, { location: '탑 안', characters: ['hero'], situation: '길이 보인다', choice: '앞으로 간다', change: '안에 들어간다' }] });
    const result = await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: {
      provenance: { kind: 'test', contextIsolation: 'request-messages-only' },
      async complete(req) {
        requests.push(req);
        if (req.step === 'approval-language-contract') {
          const payload = JSON.parse(req.messages.find((m) => m.role === 'user').content);
          const verdict = payload.artifact.approvalKind === 'episode' ? 'uncertain' : 'pass';
          return { text: JSON.stringify({ language: 'ko', artifactHash: payload.artifactHash, verdict, evidence: [], allowedExceptions: [] }) };
        }
        const contract = contractResponse(req); if (contract) return contract;
        if (req.step === 'episode-plan') return { text: episodePlan };
        return { text: outputs[req.step] ?? '{}' };
      },
    } });
    assert.equal(result.status, 'clean_fail', JSON.stringify(result));
    assert.equal(result.operation, 'chapter_plan');
    assert.equal(result.code, 'VALIDATION_INCOMPLETE');
    assert.equal(requests.filter((req) => req.step === 'draft').length, 0);
    assert.equal(requests.filter((req) => req.step === 'episode-plan').length, 1);
  });
});
