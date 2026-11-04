import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runCheck } from '../src/tools/check.js';
import { runInit } from '../src/tools/init.js';
import { legacyWorkFixture } from './fixtures/legacy-work.js';
import { approvalFixtureProvider } from './fixtures/approval-response.js';
import { registerCharacter } from '../engine/src/continuity/foundation.js';
import { runReviseTool, runRewriteTool } from '../src/tools/generate.js';

const prose = 'The rain stopped before dawn. Beyond the courtyard, a door slowly opened into the quiet garden.';

function recordingProvider(requests) {
  return { pending: [], async complete(req) {
    requests.push(req);
    const content = req.messages.map((m) => m.content).join('\n');
    const hash = content.match(/contextHash: ([a-f0-9]{64})/)?.[1];
    if (req.step === 'continuity-extract') return { text: JSON.stringify({ newAddressEntries: [], relationshipOps: [], hookOps: [], mutableChanges: [], influenceEvents: [], ledgerOps: [], noInfluenceReason: 'No lasting change.', extractionValidation: { contextHash: hash } }) };
    if (req.step === 'continuity-check') {
      const ids = content.match(/(?:these invariants|판정한다): ([A-Z_, ]+)\./)?.[1]?.split(', ') ?? [];
      return { text: JSON.stringify({ semanticValidation: { contextHash: hash, verdicts: Object.fromEntries(ids.map((id) => [id, 'pass'])), evidence: [] } }) };
    }
    throw new Error(`Unexpected request ${req.step}`);
  } };
}

async function hideFirstFact(root) {
  const settingPath = join(root, 'world', 'setting.md');
  const setting = await readFile(settingPath, 'utf8');
  assert.match(setting, /^- \(w1\) PLAIN_FACT\.$/m);
  await writeFile(settingPath, setting.replace(/^- \(w1\) PLAIN_FACT\.$/m, '- (w1) [from chapter 5] HIDDEN_FACT.\n- (w2) PLAIN_FACT.'));
}

async function continuityRequestText(store) {
  const requests = [];
  await runCheck({ store, workId: 'w', chapter: 1, prose, title: 'The gate', providers: recordingProvider(requests), issueReceipt: true });
  const request = requests.find((r) => r.step === 'continuity-check');
  assert.ok(request, 'the semantic continuity check ran');
  return request.messages.map((m) => m.content).join('\n');
}

test('a legacy check request shows only world facts open at the checked chapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibelore-canon-gates-check-'));
  const store = new MarkdownStateStore(root);
  await legacyWorkFixture({ store, workId: 'w', genre: 'other', worldFacts: ['PLAIN_FACT.'] });
  await hideFirstFact(root);
  const text = await continuityRequestText(store);
  assert.ok(text.includes('PLAIN_FACT.'), text);
  assert.doesNotMatch(text, /HIDDEN_FACT/);
});

test('a contract check request lists only world facts open at the checked chapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibelore-canon-gates-check-'));
  const store = new MarkdownStateStore(root);
  await runInit({ store, workId: 'w', genre: 'other', language: 'en', providers: approvalFixtureProvider(), worldFacts: ['PLAIN_FACT.'] });
  await store.saveStoryProfile('w', { status: 'active', revision: 1, language: 'en', format: { length: { unit: 'words', target: 10 }, dialogueBreakMode: 'natural' } });
  await hideFirstFact(root);
  const text = await continuityRequestText(store);
  assert.ok(text.includes('[foundation.worldFacts[0]] PLAIN_FACT.'), text);
  assert.doesNotMatch(text, /HIDDEN_FACT/);
});

async function characterCanonFixture(t, mode, language = 'en') {
  const root = await mkdtemp(join(tmpdir(), 'vibelore-character-canon-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MarkdownStateStore(root);
  if (mode === 'legacy') await legacyWorkFixture({ store, workId: 'w' });
  else {
    await runInit({ store, workId: 'w', genre: 'other', language, providers: approvalFixtureProvider() });
    await store.saveStoryProfile('w', { status: 'active', revision: 1, language, format: { length: { unit: 'words', target: 10 }, dialogueBreakMode: 'natural' } });
  }
  let foundation = await store.loadFoundation('w');
  for (const [id, canonicalName, description] of [
    ['aaron', 'Aaron', 'Rival.\n### from chapter 12\nUNRELATED_CHARACTER_TOKEN'],
    ['kai', 'Kai', 'Apprentice.\n### from chapter 12\nCHARACTER_ARM_TOKEN\nSecond canon line.\n### from chapter 20\nFUTURE_HEIR_TOKEN'],
  ]) {
    foundation = registerCharacter(foundation, { id, canonicalName, description, aliases: [], registeredAtChapter: 1,
      intrinsic: { gender: 'male', ageBand: 'adult', coreAppearance: [] } });
  }
  await store.saveFoundation({ ...foundation, worldFacts: [
    { id: 'w1', statement: 'PLAIN_WORLD_TOKEN', registeredAtChapter: 1 },
    { id: 'w12', statement: 'WORLD_ARM_TOKEN', registeredAtChapter: 12 },
    { id: 'w20', statement: 'FUTURE_WORLD_TOKEN', registeredAtChapter: 20 },
  ] });
  return store;
}

const kaiProse = 'Kai crossed the courtyard and opened the old wooden door. The rain stopped before dawn.';
const requestText = (req) => req.messages.map((m) => m.content).join('\n');

for (const [mode, language] of [['legacy', 'ko'], ['contract', 'ko'], ['contract', 'en']]) {
  for (const chapter of [11, 12]) {
    test(`${mode} ${language} continuity request carries only character canon open at chapter ${chapter}`, async (t) => {
      const store = await characterCanonFixture(t, mode, language);
      const before = await store.loadFoundation('w');
      const requests = [];
      await runCheck({ store, workId: 'w', chapter, prose: kaiProse, title: 'The gate', summary: 'Kai enters.',
        includeProfileCheck: false, providers: recordingProvider(requests) });
      const req = requests.find((r) => r.step === 'continuity-check');
      assert.ok(req, 'the real check reaches its semantic model boundary');
      const text = requestText(req);
      assert.doesNotMatch(text, /FUTURE_HEIR_TOKEN|FUTURE_WORLD_TOKEN/);
      assert.equal(text.includes('CHARACTER_ARM_TOKEN'), chapter === 12, text);
      assert.equal(text.includes('WORLD_ARM_TOKEN'), chapter === 12, text);
      if (chapter === 12 && mode === 'contract') {
        assert.match(text, /\[foundation\.characters\[1\]\.progressions\[0\]\.text\]/);
        assert.ok(text.includes(language === 'ko' ? '12화부터' : 'from chapter 12'), text);
      }
      assert.deepEqual(await store.loadFoundation('w'), before, 'checking must not rewrite the canon');
    });

    test(`${mode} ${language} revision preserves relevant character canon at chapter ${chapter}`, async (t) => {
      const store = await characterCanonFixture(t, mode, language);
      const requests = [];
      await runReviseTool({ store, workId: 'w', chapter, prose: kaiProse,
        violations: [{ severity: 'hard', code: 'USER_REVISION_REQUEST', message: 'Improve the opening.', characterId: 'kai' }],
        providers: { async complete(req) { requests.push(req); return { text: '{"replacements":[],"insertions":[]}' }; } } });
      assert.equal(requests[0]?.step, 'revise');
      const text = requestText(requests[0]);
      assert.doesNotMatch(text, /FUTURE_HEIR_TOKEN|FUTURE_WORLD_TOKEN|UNRELATED_CHARACTER_TOKEN/);
      assert.equal(text.includes('CHARACTER_ARM_TOKEN'), chapter === 12, text);
      if (language !== 'ko') assert.doesNotMatch(text, /[가-힣]/, 'multilingual prompts must not acquire Korean labels');
    });

    test(`${mode} ${language} rewrite keeps character canon gated at chapter ${chapter}`, async (t) => {
      const store = await characterCanonFixture(t, mode, language);
      await store.saveArtifact({ workId: 'w', chapterNumber: chapter, title: 'The gate', summary: 'Kai enters.', prose: kaiProse,
        delta: { chapterNumber: chapter, newAddressEntries: [], relationshipOps: [], hookOps: [], mutableChanges: [], ledgerOps: [] } });
      const requests = [];
      await runRewriteTool({ store, workId: 'w', chapter, intent: 'Polish Kai opening.',
        providers: { async complete(req) { requests.push(req); return { text: `${kaiProse}\n\n⟦vle:cast-manifest {"cast":[]}⟧` }; } } });
      assert.equal(requests[0]?.step, 'rewrite');
      const text = requestText(requests[0]);
      assert.doesNotMatch(text, /FUTURE_HEIR_TOKEN|FUTURE_WORLD_TOKEN/);
      assert.equal(text.includes('CHARACTER_ARM_TOKEN'), chapter === 12, text);
    });
  }
}

test('contract semantic evidence can cite the displayed progression text at its Foundation path', async (t) => {
  const store = await characterCanonFixture(t, 'contract', 'en');
  const requests = [];
  const provider = recordingProvider(requests);
  const baseComplete = provider.complete;
  provider.complete = async (req) => {
    if (req.step !== 'continuity-check') return baseComplete(req);
    requests.push(req);
    const text = requestText(req);
    const hash = text.match(/contextHash: ([a-f0-9]{64})/)[1];
    const ids = text.match(/these invariants: ([A-Z_, ]+)\./)[1].split(', ');
    return { text: JSON.stringify({ semanticValidation: { contextHash: hash,
      verdicts: Object.fromEntries(ids.map((id) => [id, id === 'INTRINSIC' ? 'fail' : 'pass'])),
      evidence: [{ invariantId: 'INTRINSIC', fieldPath: 'foundation.characters[1].progressions[0].text',
        quote: 'CHARACTER_ARM_TOKEN\nSecond canon line.', reason: 'The current action conflicts with the character condition recorded from chapter twelve.' }] } }) };
  };
  const result = await runCheck({ store, workId: 'w', chapter: 12, prose: kaiProse, title: 'The gate', summary: 'Kai enters.',
    includeProfileCheck: false, providers: provider });
  assert.match(requestText(requests.find((req) => req.step === 'continuity-check')), /\[foundation\.characters\[1\]\.progressions\[0\]\.text\]/);
  assert.equal(result.semanticValidation?.status, 'completed');
  assert.equal(result.semanticValidation.verdicts.INTRINSIC, 'fail');
  assert.equal(result.semanticValidation.evidence[0].fieldPath, 'foundation.characters[1].progressions[0].text');
});
