import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer } from 'node:http';
import { normalizeModelProfile, resolveModel, stageForStep, withModelProfile } from '../src/core/model-profile.js';
import { createHostRelay, PendingModelWork } from '../src/provider/host-relay.js';
import { createLocalOpenAIProvider } from '../src/provider/local-openai.js';
import { validateToolInput } from '../src/core/tool-input.js';

describe('model profile', () => {
  it('maps steps to stages and leaves unknown steps unrouted', () => {
    assert.equal(stageForStep('story-identity'), 'identity');
    assert.equal(stageForStep('episode-plan'), 'planning');
    assert.equal(stageForStep('draft'), 'draft');
    assert.equal(stageForStep('reader-hook'), 'quality');
    assert.equal(stageForStep('chapter-summary'), 'final');
    assert.equal(stageForStep('something-new'), null);
  });

  it('explicit stage > light > default, and reasoning effort layers on the inherited model', () => {
    const profile = normalizeModelProfile({
      default: { modelId: 'strong', reasoningEffort: 'high' },
      light: 'fast',
      quality: { reasoningEffort: 'low' },
      final: { provider: 'local', modelId: 'careful' },
    });
    assert.deepEqual(resolveModel(profile, 'story-identity'), { provider: 'host', modelId: 'strong', reasoningEffort: 'high', stage: 'identity' });
    assert.deepEqual(resolveModel(profile, 'draft'), { provider: 'host', modelId: 'fast', reasoningEffort: 'high', stage: 'draft' });
    assert.deepEqual(resolveModel(profile, 'editorial-quality'), { provider: 'host', modelId: 'fast', reasoningEffort: 'low', stage: 'quality' });
    assert.deepEqual(resolveModel(profile, 'chapter-summary'), { provider: 'local', modelId: 'careful', reasoningEffort: 'high', stage: 'final' });
    assert.deepEqual(resolveModel(profile, 'unknown-step'), { provider: 'host', modelId: 'strong', reasoningEffort: 'high', stage: 'default' });
  });

  it('rejects unusable input and returns null for an empty profile', () => {
    assert.equal(normalizeModelProfile(undefined), null);
    assert.equal(normalizeModelProfile({ draft: '  ', quality: { reasoningEffort: 'ultra' } }), null);
    assert.equal(normalizeModelProfile({ draft: 'bad id with spaces' }), null);
    assert.deepEqual(normalizeModelProfile('gpt-x'), { default: { provider: 'host', modelId: 'gpt-x' } });
  });

  it('an empty profile leaves the provider untouched', () => {
    const relay = createHostRelay({});
    assert.equal(withModelProfile(relay, null), relay);
    assert.equal(withModelProfile(relay, {}), relay);
  });

  it('routed host-relay requests surface the model hint and stage to the host', async () => {
    const relay = withModelProfile(createHostRelay({}), { default: 'strong', light: { modelId: 'fast', reasoningEffort: 'low' } });
    const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
    await assert.rejects(relay.complete({ step: 'draft', model: { provider: 'host', modelId: 'host-agent' }, messages }), PendingModelWork);
    await assert.rejects(relay.complete({ step: 'story-identity', model: { provider: 'host', modelId: 'host-agent' }, messages }), PendingModelWork);
    const [draft, identity] = relay.pending;
    assert.deepEqual({ stage: draft.stage, model: draft.model, reasoningEffort: draft.reasoningEffort }, { stage: 'draft', model: { provider: 'host', modelId: 'fast' }, reasoningEffort: 'low' });
    assert.deepEqual({ stage: identity.stage, model: identity.model, reasoningEffort: identity.reasoningEffort }, { stage: 'identity', model: { provider: 'host', modelId: 'strong' }, reasoningEffort: undefined });
    assert.notEqual(draft.id, identity.id);
  });

  it('unrouted host-relay requests keep the previous pending shape', async () => {
    const relay = createHostRelay({});
    await assert.rejects(relay.complete({ step: 'draft', model: { provider: 'host', modelId: 'host-agent' }, messages: [{ role: 'user', content: 'u' }] }), PendingModelWork);
    assert.deepEqual(Object.keys(relay.pending[0]), ['id', 'step', 'jsonMode', 'system', 'user']);
  });

  it('the local provider switches model only for provider "local" and forwards reasoning effort', async (t) => {
    const bodies = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => { bodies.push(JSON.parse(raw)); res.setHeader('content-type', 'application/json'); res.end('{"choices":[{"message":{"content":"ok"}}]}'); });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const provider = createLocalOpenAIProvider({ baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'configured' });
    const messages = [{ role: 'user', content: 'u' }];
    await provider.complete({ step: 'draft', model: { provider: 'host', modelId: 'elsewhere' }, messages });
    await provider.complete({ step: 'draft', model: { provider: 'local', modelId: 'qwen-small', reasoningEffort: 'low' }, messages });
    assert.equal(bodies[0].model, 'configured');
    assert.equal(bodies[0].reasoning_effort, undefined);
    assert.equal(bodies[1].model, 'qwen-small');
    assert.equal(bodies[1].reasoning_effort, 'low');
  });

  it('tool input accepts string or object entries and rejects unknown shapes', () => {
    const schema = { type: 'object', properties: { modelProfile: { type: 'object', additionalProperties: false, properties: { draft: { anyOf: [
      { type: 'string', minLength: 1 }, { type: 'object', additionalProperties: false, properties: { modelId: { type: 'string' } } },
    ] } } } } };
    validateToolInput(schema, { modelProfile: { draft: 'fast' } });
    validateToolInput(schema, { modelProfile: { draft: { modelId: 'fast' } } });
    assert.throws(() => validateToolInput(schema, { modelProfile: { draft: 3 } }), /does not match any allowed shape/);
    assert.throws(() => validateToolInput(schema, { modelProfile: { draft: { nope: 1 } } }), /does not match any allowed shape/);
    assert.throws(() => validateToolInput(schema, { modelProfile: { other: 'x' } }), /unknown property/);
  });
});
