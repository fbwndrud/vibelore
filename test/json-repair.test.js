import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withJsonRepair } from '../src/provider/json-repair.js';
import { createHostRelay, createPreflightRelay, PendingModelWork } from '../src/provider/host-relay.js';

function scripted(texts) {
  const requests = [];
  return { requests, register() {}, has() { return true; }, get pending() { return []; }, provenance: { kind: 'test' },
    async complete(req) { requests.push(req); return { text: texts[requests.length - 1] }; } };
}

test('re-requests a malformed JSON answer once with the parser detail and returns the repaired one', async () => {
  const base = scripted(['{"premise": "x" "worldFacts": []}', '{"premise": "x", "worldFacts": []}']);
  const providers = withJsonRepair(base);
  const out = await providers.complete({ step: 'worldbuild', jsonMode: true, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] });
  assert.equal(out.text, '{"premise": "x", "worldFacts": []}');
  assert.equal(base.requests.length, 2);
  const repair = base.requests[1];
  assert.equal(repair.step, 'worldbuild');
  assert.equal(repair.jsonRepairAttempt, 1);
  assert.equal(repair.messages.length, 4);
  assert.equal(repair.messages[2].role, 'assistant');
  assert.match(repair.messages[3].content, /Parser error: /);
  assert.match(repair.messages[3].content, /«[^»]*"x" "worldFacts"[^»]*»/);
  assert.deepEqual(providers.repairs.map(r => r.step), ['worldbuild']);
});

test('accepts fenced JSON without a re-request and leaves non-JSON steps alone', async () => {
  const fenced = scripted(['```json\n{"ok": true}\n```']);
  assert.equal((await withJsonRepair(fenced).complete({ step: 's', jsonMode: true, messages: [] })).text.includes('"ok"'), true);
  assert.equal(fenced.requests.length, 1);
  const prose = scripted(['not json at all']);
  assert.equal((await withJsonRepair(prose).complete({ step: 'draft', messages: [] })).text, 'not json at all');
  assert.equal(prose.requests.length, 1);
});

test('returns the last answer unchanged when the repair is still malformed so the tool fails as before', async () => {
  const base = scripted(['{bad', '{still bad']);
  const out = await withJsonRepair(base).complete({ step: 'cast-design', jsonMode: true, messages: [] });
  assert.equal(out.text, '{still bad');
  assert.equal(base.requests.length, 2);
});

test('keeps relay getters and leaves pending host work alone', async () => {
  const request = { model: { provider: 'host', modelId: 'host-agent' }, step: 'story-profile', jsonMode: true, messages: [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }] };
  const relay = withJsonRepair(createHostRelay({}));
  await assert.rejects(relay.complete(request), PendingModelWork);
  assert.equal(relay.pending.length, 1);
  assert.equal(relay.provenance.kind, 'host-relay');
  assert.equal(withJsonRepair(relay), relay);
  // preflight relay 는 자리표시 JSON 을 돌려주며 pending 을 남긴다 — 수정 재요청 대상이 아니다.
  const preflight = withJsonRepair(createPreflightRelay({}));
  const out = await preflight.complete(request);
  assert.equal(preflight.pending.length, 1);
  assert.equal(preflight.repairs.length, 0);
  assert.equal(JSON.parse(out.text).genreLabel, 'preflight');
});
