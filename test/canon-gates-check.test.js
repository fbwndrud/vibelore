import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { runCheck } from '../src/tools/check.js';
import { runInit } from '../src/tools/init.js';
import { legacyWorkFixture } from './fixtures/legacy-work.js';
import { approvalFixtureProvider } from './fixtures/approval-response.js';

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
