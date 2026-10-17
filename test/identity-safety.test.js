import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLoreRegistry, addLoreDefinitions } from '../engine/src/lore/registry.js';
import { planLoreDefinitionNeeds } from '../engine/src/lore/extend.js';
import { resolveEntityContext, renderEntityContext, EMPTY_SCENE } from '../engine/src/core/entity-context.js';
import { runPatternAnalysis } from '../src/tools/story-experience.js';
import { extractDelta } from '../engine/src/continuity/continuity-check.js';
import { emptyStoryState, reduceStoryState } from '../engine/src/continuity/story-state.js';
import { createGenreProfileRegistry } from '../engine/src/continuity/genre-profile.js';
import { contractResponse } from './fixtures/contract-response.js';

const definition = (id, key, meaning, aliases = []) => ({ schemaVersion: 1, kind: 'entityType', id, namespace: 'u1', key, label: key, aliases, definition: meaning, requiredCapabilities: [] });
const registry = (...definitions) => addLoreDefinitions(createLoreRegistry('u1'), { definitions, reason: 'Synthetic identity regression' }).registry;
const entity = (entityId, canonicalName, aliases = []) => ({ entityId, canonicalName, aliases, kind: 'location', status: 'active', attrs: {} });

describe('identity safety', () => {
  it('does not reuse a new meaning solely because its name and structure match', () => {
    const result = planLoreDefinitionNeeds(registry(definition('combat', 'rank', '전투 실력 등급')), [{ definition: definition('noble', 'rank', '귀족 신분 등급') }]);
    assert.equal(result.outcomes[0].outcome, 'needs_disambiguation');
    assert.deepEqual(result.outcomes[0].candidates.map(c => c.definitionId), ['combat']);
    assert.equal(result.additions.length, 0);
  });
  it('checks every alias candidate instead of silently selecting the first', () => {
    const result = planLoreDefinitionNeeds(registry(definition('combat', 'combat.rank', '등급', ['전투등급']), definition('noble', 'noble.rank', '등급', ['신분등급'])),
      [{ definition: definition('new-rank', 'rank', '등급', ['전투등급', '신분등급']) }]);
    assert.equal(result.outcomes[0].outcome, 'needs_disambiguation');
    assert.deepEqual(result.outcomes[0].candidates.map(c => c.definitionId), ['combat', 'noble']);
  });
  it('reuses matching meaning after NFC and whitespace normalization', () => {
    const result = planLoreDefinitionNeeds(registry(definition('combat', 'rank', '전투 실력 등급')), [{ definition: definition('copy', 'rank', ' 전투  실력 등급\n') }]);
    assert.equal(result.outcomes[0].outcome, 'reused');
    assert.equal(result.outcomes[0].definitionId, 'combat');
  });
  it('does not silently reuse an existing ID when new aliases would be discarded', () => {
    const result = planLoreDefinitionNeeds(registry(definition('combat', 'rank', '등급')), [{ definition: definition('combat', 'rank', '등급', ['실력']) }]);
    assert.equal(result.outcomes[0].outcome, 'migration_required');
  });
  it('reports ambiguous entity names and refuses to render an arbitrary context', () => {
    const result = resolveEntityContext({ scene: { ...EMPTY_SCENE, settings: ['백야'] }, snapshots: [entity('city', '백야'), entity('sword', '백야')] });
    assert.deepEqual(result.injected, []);
    assert.deepEqual(result.ambiguousRefs, [{ ref: '백야', candidateIds: ['city', 'sword'] }]);
    assert.throws(() => renderEntityContext(result), { code: 'AMBIGUOUS_ENTITY_REFERENCE' });
  });
  it('keeps an exact entity ID authoritative even if another entity uses it as a name', () => {
    const result = resolveEntityContext({ scene: { ...EMPTY_SCENE, settings: ['city'] }, snapshots: [entity('city', '백야'), entity('sword', 'city')] });
    assert.deepEqual(result.injected.map(e => e.entityId), ['city']);
  });
  it('does not assign ambiguous pattern observations to the last same-name character', async () => {
    await assert.rejects(runPatternAnalysis({ chapter: 1, prose: '백야 둘이 만났다.', foundation: { characters: [{ id: 'first', canonicalName: '백야', aliases: [] }, { id: 'second', canonicalName: '백야', aliases: [] }] },
      providers: { async complete() { return { text: JSON.stringify({ solutionPattern: '협상', supportingAgency: { 백야: '문을 열었다' } }) }; } } }), { code: 'AMBIGUOUS_CHARACTER_REFERENCE' });
  });
});

for (const language of [undefined, 'ko']) {
  const contract = language ? 'explicit' : 'legacy';
  const characters = [{ id: 'first', canonicalName: '백야', aliases: [] }, { id: 'second', canonicalName: '백야', aliases: [] }, { id: 'target', canonicalName: '대상', aliases: [] }];
  const foundation = { workId: 'w', genre: 'action', characters, worldFacts: [], genreProfile: createGenreProfileRegistry().get('action') };
  async function extractRelationships(relationshipOps, prevState) {
    return extractDelta({ chapterNumber: 1, prose: '백야 둘이 대상을 만났다.', castManifestRaw: '{}', foundation, prevState,
      ...(language ? { language } : {}), model: { provider: 'host', modelId: 'synthetic' }, providers: {
        async complete(request) {
          const payload = language ? JSON.parse(contractResponse(request).text) : {};
          return { text: JSON.stringify({ ...payload, relationshipOps, noInfluenceReason: '변화 없음' }) };
        },
      } });
  }
  for (const endpoint of ['from', 'to']) it(`${contract} extraction rejects an ambiguous relationship ${endpoint} without mutating state`, async () => {
    const prev = { ...emptyStoryState('w'), relationships: [{ to: 'target', kind: 'trust', state: 'neutral' }] };
    const result = await extractRelationships([{ from: 'first', to: 'target', [endpoint]: '백야', kind: 'trust', state: 'trusted' }], prev);
    assert.deepEqual(result.delta.relationshipOps, []);
    assert.deepEqual(reduceStoryState(prev, result.delta).relationships, prev.relationships);
    assert.equal(result.extractionValidation.status, 'invalid');
    assert.equal(result.extractionValidation.diagnostics.code, 'ambiguous_character_reference');
    assert.deepEqual(result.extractionValidation.diagnostics.references, [{ ref: '백야', candidateIds: ['first', 'second'] }]);
  });
  it(`${contract} extraction preserves a genuinely unscoped legacy relationship and exact IDs`, async () => {
    const result = await extractRelationships([{ to: 'target', kind: 'trust', state: 'neutral' }, { from: 'second', to: 'target', kind: 'trust', state: 'trusted' }], emptyStoryState('w'));
    assert.equal(result.extractionValidation.status, 'completed');
    assert.deepEqual(result.delta.relationshipOps, [{ to: 'target', kind: 'trust', state: 'neutral' }, { from: 'second', to: 'target', kind: 'trust', state: 'trusted' }]);
  });
}
