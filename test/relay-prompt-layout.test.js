import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  HOST_EXECUTION_NOTE, JSON_EXECUTION_NOTE, MIN_SHARED_PREFIX_TOKENS,
  estimateTokensLowerBound, layoutRelayRequests,
} from '../src/core/relay-prompt-layout.js';
import { createHostRelay } from '../src/provider/host-relay.js';
import { qualityStore, outputs as qualityOutputs, workId as qualityWorkId } from './fixtures/quality-workflow.js';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const REVIEW_STEPS = ['continuity-extract', 'story-profile-check', 'coherence-judge', 'editorial-quality', 'character-fidelity', 'reader-hook', 'pattern-ledger'];

// A 4000-character chapter, the default serialized length.
const PROSE = Array.from({ length: 80 }, (_, i) => `${i + 1}번째 문단에서 리아는 무너진 길 위에 작은 방패를 놓고 숨을 골랐다.`).join('\n\n').slice(0, 4000);

function reviewBatch(prose = PROSE) {
  return REVIEW_STEPS.map((step, index) => ({
    id: `req-${index}`, step, jsonMode: true,
    system: `${step} 역할 지시`,
    user: `${step} 앞 자료 ${index}\n본문:\n${prose}\nJSON: {"step":"${step}"}`,
  }));
}

function sharedPrefix(request) {
  const marker = request.promptCache.sharedPrefixEndMarker;
  return request.user.slice(0, request.user.indexOf(marker) + marker.length);
}

describe('relay prompt layout', () => {
  it('gives every request in a shared batch the same system and the same user prefix up to the end marker', () => {
    const shared = [{ id: 'chapter-prose', label: '5화 본문', text: PROSE }];
    const laid = layoutRelayRequests(reviewBatch(), shared);
    assert.deepEqual(laid.map((request) => request.id), REVIEW_STEPS.map((_, index) => `req-${index}`));
    assert.equal(new Set(laid.map((request) => request.system)).size, 1);
    assert.equal(laid[0].system, HOST_EXECUTION_NOTE);
    const prefixes = new Set(laid.map(sharedPrefix));
    assert.equal(prefixes.size, 1);
    const [prefix] = prefixes;
    assert.equal(prefix.length, laid[0].promptCache.sharedPrefixChars);
    assert.ok(prefix.includes(PROSE));
    assert.equal(new Set(laid.map((request) => request.promptCache.sharedPrefixId)).size, 1);
    assert.ok(estimateTokensLowerBound(prefix) >= MIN_SHARED_PREFIX_TOKENS, `${estimateTokensLowerBound(prefix)} tokens`);
    assert.deepEqual(laid.map((request) => request.promptCache.warmFirst), [true, false, false, false, false, false, false]);
    assert.ok(laid.every((request) => request.promptCache.groupSize === REVIEW_STEPS.length));
  });

  it('keeps each request\'s role, data and JSON note after the shared block and the prose exactly once', () => {
    const original = reviewBatch();
    const laid = layoutRelayRequests(original, [{ id: 'chapter-prose', label: '5화 본문', text: PROSE }]);
    laid.forEach((request, index) => {
      const tail = request.user.slice(request.promptCache.sharedPrefixChars);
      assert.ok(tail.startsWith(`[이번 요청 역할]\n${original[index].system}\n\n[이번 요청 자료]\n`));
      assert.ok(tail.includes(`${original[index].step} 앞 자료 ${index}`));
      assert.ok(tail.includes('(위 [공통 자료 · chapter-prose]의 「5화 본문」 전문)'));
      assert.ok(tail.endsWith(`JSON: {"step":"${original[index].step}"}\n\n${JSON_EXECUTION_NOTE}`));
      assert.equal(request.user.split(PROSE).length - 1, 1);
    });
  });

  it('is deterministic and leaves requests without the shared text in the legacy layout', () => {
    const batch = [...reviewBatch(), { id: 'draft', step: 'draft', jsonMode: false, system: 'S', user: 'no prose' }];
    const shared = [{ id: 'chapter-prose', label: '5화 본문', text: PROSE }];
    assert.equal(JSON.stringify(layoutRelayRequests(batch, shared)), JSON.stringify(layoutRelayRequests(structuredClone(batch), structuredClone(shared))));
    const draft = layoutRelayRequests(batch, shared).at(-1);
    assert.equal(draft.system, `S\n\n${HOST_EXECUTION_NOTE}`);
    assert.equal(draft.user, 'no prose');
    assert.equal(draft.promptCache, undefined);
  });

  it('does not group a lone request, a repeated occurrence, or an undeclared batch', () => {
    const [one] = reviewBatch();
    assert.equal(layoutRelayRequests([one], [{ id: 'p', label: 'l', text: PROSE }])[0].promptCache, undefined);
    const twice = reviewBatch().map((request) => ({ ...request, user: `${request.user}\n${PROSE}` }));
    assert.ok(layoutRelayRequests(twice, [{ id: 'p', label: 'l', text: PROSE }]).every((request) => !request.promptCache));
    assert.ok(layoutRelayRequests(reviewBatch(), []).every((request) => !request.promptCache));
  });

  it('skips warm-first when the shared block is below the cache minimum', () => {
    const short = '짧은 본문.';
    const laid = layoutRelayRequests(reviewBatch(short), [{ id: 'p', label: 'l', text: short }]);
    assert.ok(laid.every((request) => request.promptCache && request.promptCache.warmFirst === false));
  });

  it('collects shared contexts on the host relay without changing request fingerprints', async () => {
    const relay = createHostRelay({});
    relay.shareContext({ id: 'chapter-prose', label: '1화 본문', text: PROSE });
    relay.shareContext({ id: 'chapter-prose', label: '1화 본문', text: PROSE });
    await relay.complete({ step: 'pattern-ledger', model: { provider: 'host', modelId: 'host-agent' }, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: PROSE }] }).catch(() => {});
    assert.equal(relay.sharedContexts.length, 1);
    const [pending] = relay.pending;
    assert.equal(pending.user, PROSE);
    assert.equal(pending.system, 'S');
  });
});

function mcp(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, VIBELORE_MCP_SURFACE: '' } });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    const timer = setTimeout(() => { child.kill(); reject(new Error('server timed out')); }, 20000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n').slice(0, -1)) {
        const message = JSON.parse(line);
        if (message.id !== 2) continue;
        clearTimeout(timer);
        child.kill();
        resolve(JSON.parse(message.result.content[0].text));
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
}

describe('lore_write review batch layout', () => {
  it('parks the extraction, profile check and reviews behind one shared prose prefix', async () => {
    const store = await qualityStore();
    const args = { project: store.rootDir, workId: qualityWorkId };
    let result = await mcp('lore_write', { ...args, autonomy: 'auto' });
    let batch = null;
    for (let pass = 0; result.status === 'needs_model' && pass < 30; pass++) {
      if (result.requests.some((request) => request.step === 'editorial-quality')) { batch = result.requests; break; }
      const answers = Object.fromEntries(result.requests.map((request) => [request.id, qualityOutputs[request.step] ?? '{}']));
      result = await mcp('lore_resume', { ...args, runId: result.runId, answers });
    }
    assert.ok(batch, 'review batch not reached');
    assert.ok(batch.length >= 5);
    assert.ok(batch.every((request) => request.promptCache?.layout === 'shared-prefix-v1'), JSON.stringify(batch.map((request) => request.step)));
    assert.equal(new Set(batch.map((request) => request.system)).size, 1);
    assert.equal(new Set(batch.map(sharedPrefix)).size, 1);
    assert.equal(batch.filter((request) => request.promptCache.warmFirst).length <= 1, true);
  });
});
