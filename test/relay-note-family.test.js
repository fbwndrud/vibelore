/**
 * 2026-09-24 en acceptance: the first en profile attempt came back in Korean. The only
 * Korean in that request was the relay execution note. The relay scaffolding follows
 * the work's prompt family: ko stays byte-identical, every other family gets English.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HOST_EXECUTION_NOTE, JSON_EXECUTION_NOTE, layoutRelayRequests } from '../src/core/relay-prompt-layout.js';
import { runRelayedTool } from '../src/relay-runner.js';
import { MarkdownStateStore } from '../src/store/markdown-store.js';
import { createHostRelay } from '../src/provider/host-relay.js';

const HANGUL = /[ㄱ-ㆎ가-힣]/;
const PROSE = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}: Mara counted the boards twice and said nothing.`).join('\n\n');
const batch = () => ['editorial-quality', 'character-fidelity', 'reader-hook'].map((step, index) => ({
  id: `req-${index}`, step, jsonMode: true, system: `${step} role`, user: `${step} data\nProse:\n${PROSE}\nJSON: {}`,
}));

test('ko layout stays byte-identical to the legacy Korean scaffolding', () => {
  const [solo] = layoutRelayRequests([{ id: 'a', step: 'x', jsonMode: true, system: 's', user: 'u' }]);
  assert.equal(solo.system, `s\n\n${HOST_EXECUTION_NOTE} ${JSON_EXECUTION_NOTE}`);
  assert.deepEqual(layoutRelayRequests(batch(), [{ id: 'chapter-prose', label: 'Chapter 1 prose', text: PROSE }], { promptFamily: 'ko' }),
    layoutRelayRequests(batch(), [{ id: 'chapter-prose', label: 'Chapter 1 prose', text: PROSE }]));
  assert.match(HOST_EXECUTION_NOTE, HANGUL);
});

test('a multilingual layout carries no Korean scaffolding and keeps one shared prefix per batch', () => {
  const [solo] = layoutRelayRequests([{ id: 'a', step: 'x', jsonMode: true, system: 's', user: 'u' }], [], { promptFamily: 'multilingual' });
  assert.doesNotMatch(solo.system, HANGUL);
  assert.ok(solo.system.startsWith('s\n\n'));
  const laid = layoutRelayRequests(batch(), [{ id: 'chapter-prose', label: 'Chapter 1 prose', text: PROSE }], { promptFamily: 'multilingual' });
  for (const request of laid) {
    assert.doesNotMatch(request.system, HANGUL);
    assert.doesNotMatch(request.user, HANGUL);
  }
  assert.equal(new Set(laid.map(r => r.system)).size, 1);
  assert.equal(new Set(laid.map(r => r.promptCache.sharedPrefixId)).size, 1);
  const marker = laid[0].promptCache.sharedPrefixEndMarker;
  assert.equal(new Set(laid.map(r => r.user.slice(0, r.user.indexOf(marker) + marker.length))).size, 1);
  assert.deepEqual(laid.map(r => r.promptCache.warmFirst), [true, false, false]);
});

async function parkProfile(args) {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'relay-family-')));
  return runRelayedTool({
    store, toolName: 'lore_profile', args,
    providerForTool: () => createHostRelay({}),
    executeTool: async (_store, _tool, _args, relay) => {
      await relay.complete({ model: { provider: 'host', modelId: 'host-agent' }, step: 'story-profile', jsonMode: true, messages: [{ role: 'system', content: 'Profile compiler.' }, { role: 'user', content: 'Brief.' }] }).catch(() => {});
      return { preview: true };
    },
  });
}

test('relayed requests of a non-ko work get the English execution note; ko and legacy works keep the Korean one', async () => {
  for (const language of ['en', 'ar', 'zh-Hant']) {
    const parked = await parkProfile({ workId: 'book', brief: 'x', language });
    assert.equal(parked.status, 'needs_model');
    assert.doesNotMatch(parked.requests[0].system, HANGUL, language);
  }
  for (const args of [{ workId: 'book', brief: 'x', language: 'ko' }, { workId: 'book', brief: 'x' }]) {
    const parked = await parkProfile(args);
    assert.equal(parked.requests[0].system, `Profile compiler.\n\n${HOST_EXECUTION_NOTE} ${JSON_EXECUTION_NOTE}`);
  }
});

test('the shared chapter-prose label follows the prompt family (ko label unchanged)', async () => {
  const { promptKit } = await import('../src/prompts/index.js');
  const { buildLanguageContract } = await import('../engine/src/core/language-policy.js');
  assert.equal(promptKit({ contract: buildLanguageContract({ language: 'ko' }) }).phrases.common.chapterProseLabel(5), '5화 본문');
  const label = promptKit({ contract: buildLanguageContract({ language: 'th' }) }).phrases.common.chapterProseLabel(5);
  assert.doesNotMatch(label, HANGUL);
  const laid = layoutRelayRequests(batch(), [{ id: 'chapter-prose', label, text: PROSE }], { promptFamily: 'multilingual' });
  assert.ok(laid.every(r => !HANGUL.test(r.user)));
});
