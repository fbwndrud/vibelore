// The contract check path used by lore_write must keep main's advisory
// story-profile-check: same host round trip as the extraction, soft findings
// that never block, ko prompt byte-identical to main, and an English-kit
// prompt with the target-language directive for every other work.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runInit } from '../src/tools/init.js';
import { runCheck } from '../src/tools/check.js';
import { runWriteWorkflow } from '../src/tools/workflow.js';
import { createPreflightRelay } from '../src/provider/host-relay.js';
import { episodeForChapter } from '../src/tools/arc.js';
import { episodePlanReviewView } from '../src/core/episode-plan-view.js';
import { approvalFixtureProvider } from './fixtures/approval-response.js';
import { contractResponse } from './fixtures/contract-response.js';
import { qualityStore, outputs, workId as koWorkId } from './fixtures/quality-workflow.js';

function chapterProvider({ badLanguage = false, invalidSemantic = false, onLanguage } = {}) {
  const requests = [];
  return { requests, pending: [], async complete(req) {
    requests.push(req);
    const text = req.messages.map(m=>m.content).join('\n');
    const hash = text.match(/contextHash: ([a-f0-9]{64})/)?.[1];
    if (req.step === 'continuity-extract') return { text: JSON.stringify({ appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], hookOps: [], mutableChanges: [], influenceEvents: [], trackedEntityOps: [], noInfluenceReason: 'No lasting change.', extractionValidation: { contextHash: hash } }) };
    if (req.step === 'continuity-check') {
      const ids = text.match(/these invariants: ([A-Z_, ]+)\./)?.[1]?.split(', ') ?? text.match(/판정한다: ([A-Z_, ]+)\./)?.[1]?.split(', ') ?? [];
      return { text: JSON.stringify({ violations: [], semanticValidation: { contextHash: invalidSemantic ? 'invalid' : hash, verdicts: Object.fromEntries(ids.map(id=>[id,'pass'])), evidence: [] } }) };
    }
    if (req.step === 'chapter-summary') return { text: JSON.stringify({ summary: 'A door opens.', plotBeat: 'A door opens.', sceneTags: [], povCharacter: '' }) };
    if (req.step === 'language-contract') {
      await onLanguage?.();
      return { text: JSON.stringify({ language: 'en', artifactHash: text.match(/artifactHash: ([a-f0-9]{64})/)?.[1], verdict: badLanguage ? 'uncertain' : 'pass', evidence: [], allowedExceptions: [] }) };
    }
    throw new Error(`Unexpected model request ${req.step}`);
  } };
}
async function chapterStore() {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'contract-chapter-')));
  await runInit({ store, workId: 'w', genre: 'other', language: 'en', worldFacts: ['The door is closed.'], providers: approvalFixtureProvider() });
  await store.saveStoryProfile('w', { status: 'active', revision: 1, language: 'en', format: { length: { unit: 'words', target: 10 }, dialogueBreakMode: 'natural' } });
  return store;
}

const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
const prose = 'The rain stopped before dawn. Beyond the courtyard, a door slowly opened into the quiet garden.';
const input = (store) => ({ store, workId: 'w', chapter: 1, prose, title: 'The door', castManifestRaw: '', issueReceipt: true });

test('non-ko work: story-profile-check rides in the extraction round trip with an English prompt', async () => {
  const store = await chapterStore();
  const relay = createPreflightRelay({});
  await runCheck({ ...input(store), providers: relay });
  const steps = relay.pending.map((req) => req.step);
  assert.ok(steps.includes('continuity-extract'), steps.join(','));
  assert.ok(steps.includes('story-profile-check'), steps.join(','));
  const request = relay.pending.find((req) => req.step === 'story-profile-check');
  assert.doesNotMatch(request.system, HANGUL);
  assert.doesNotMatch(request.user, HANGUL);
  assert.match(request.system, /\ben\b|English/, 'carries the target-language directive');
});

test('non-ko work: profile findings are soft advisories and never block the receipt', async () => {
  const store = await chapterStore();
  const base = chapterProvider();
  const providers = { ...base, pending: [], async complete(req) {
    if (req.step === 'story-profile-check') {
      base.requests.push(req);
      return { text: JSON.stringify({ findings: [{ code: 'PROFILE_TONE_DRIFT', message: 'The ending turns grim against the light tone.' }] }) };
    }
    return base.complete(req);
  } };
  const checked = await runCheck({ ...input(store), providers });
  assert.equal(checked.validationComplete, true, JSON.stringify(checked));
  assert.ok(checked.checkId);
  assert.equal(checked.verdict, 'soft-only');
  const drift = checked.violations.find((v) => v.code === 'PROFILE_TONE_DRIFT');
  assert.equal(drift?.severity, 'soft');
  assert.equal(base.requests.filter((req) => req.step === 'story-profile-check').length, 1);
});

test('no StoryProfile: the contract check skips story-profile-check', async () => {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'contract-no-profile-')));
  await runInit({ store, workId: 'w', genre: 'other', language: 'en', worldFacts: ['The door is closed.'], providers: approvalFixtureProvider() });
  const relay = createPreflightRelay({});
  await runCheck({ ...input(store), providers: relay });
  assert.ok(!relay.pending.some((req) => req.step === 'story-profile-check'), relay.pending.map((req) => req.step).join(','));
});

test('ko work: story-profile-check messages are byte-identical to main', async () => {
  const store = await qualityStore();
  // Read what main read at check time, before the commit advances the arc.
  const storyProfile = await store.loadStoryProfile(koWorkId);
  const arcEpisode = episodeForChapter(await store.loadArcPlan(koWorkId), 1);
  const episodePlan = await store.loadEpisodePlan(koWorkId, 1);
  const requests = [];
  await runWriteWorkflow({ store, workId: koWorkId, autonomy: 'auto', providers: { async complete(req) {
    requests.push(req); const contract = contractResponse(req); if (contract) return contract; return { text: outputs[req.step] ?? '{}' };
  } } });
  const request = requests.find((req) => req.step === 'story-profile-check');
  assert.ok(request, requests.map((req) => req.step).join(','));
  const chapterProse = request.messages[1].content.split('\n\n본문:\n')[1].split('\n\nJSON: ')[0];
  assert.deepEqual(request.messages, [
    { role: 'system', content: '승인된 작품 StoryProfile과 회차 본문을 비교한다. 명백하고 구체적인 이탈만 findings에 넣는다. 취향 차이와 장면상 의도는 지적하지 않는다. 모든 finding은 soft다. 순수 JSON만 출력한다.' },
    { role: 'user', content: `StoryProfile:\n${JSON.stringify(storyProfile)}\n\n회차 비트:\n${JSON.stringify(arcEpisode)}\n\nEpisodePlan:\n${JSON.stringify(episodePlanReviewView(episodePlan))}\n\n본문:\n${chapterProse}\n\nJSON: {"findings":[{"code":"PROFILE_TONE_DRIFT|PROFILE_ENGINE_DRIFT|PROFILE_BEAT_DRIFT","message":"구체적 근거"}]}` },
  ]);
  assert.ok(chapterProse.length > 100);
});
