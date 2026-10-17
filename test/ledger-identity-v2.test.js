import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyLedgerOps } from '../engine/src/continuity/ledger.js';
import { emptyStoryState, ledgerStep, reduceStoryState } from '../engine/src/continuity/story-state.js';
import { extractDelta } from '../engine/src/continuity/continuity-check.js';
import { createGenreProfileRegistry } from '../engine/src/continuity/genre-profile.js';
import { DefaultSensitiveLexicon } from '../engine/src/continuity/sensitive-lexicon.js';
import { DefaultEmotionVerbLexicon } from '../engine/src/continuity/emotion-verb-lexicon.js';
import { DefaultOnomatopoeiaLexicon } from '../engine/src/continuity/onomatopoeia-lexicon.js';
const register = (label, fields, id) => ({ op: 'register', feature: 'objects', name: '백야', label, fields, ...(id ? { id } : {}) });
const delta = (chapterNumber, ops, version) => ({ chapterNumber, appearedCharacterIds: [], newAddressEntries: [], relationshipOps: [], hookChanges: [], mutableChanges: [], trackedEntityOps: [], entityOps: [], ledgerOps: ops, ...(version ? { ledgerIdentityVersion: version } : {}) });

describe('versioned ledger identities', () => {
  it('keeps new homonymous records distinct through the actual state reducer', () => {
    const first = reduceStoryState(emptyStoryState('w'), delta(1, [register('지명', { region: '북부' }, 'city')], 2));
    const second = reduceStoryState(first, delta(2, [register('무기', { owner: 'hero' }, 'sword')], 2));
    assert.deepEqual(second.ledger.records.map(r => ({ id: r.id, fields: r.fields })), [
      { id: 'city', fields: { region: '북부' } }, { id: 'sword', fields: { owner: 'hero' } },
    ]);
  });
  it('preserves historical unmarked name-based replay', () => {
    const first = reduceStoryState(emptyStoryState('w'), delta(1, [register('지명', { region: '북부' })]));
    const second = reduceStoryState(first, delta(2, [register('무기', { owner: 'hero' })]));
    assert.equal(second.ledger.records.length, 1);
    assert.deepEqual(second.ledger.records[0].fields, { region: '북부', owner: 'hero' });
  });
  it('does not mutate either record on an ambiguous name-only update', () => {
    const state = { ...emptyStoryState('w'), ledger: { records: ['city', 'sword'].map(id => ({ id, feature: 'objects', name: '백야', aliases: [], fields: {}, status: 'active', recent: [] })) } };
    const step = ledgerStep(state, delta(1, [{ op: 'event', id: '백야', event: 'changed', set: { owner: 'wrong' } }], 2));
    assert.deepEqual(step.ledger.records.map(r => r.fields), [{}, {}]);
    assert.equal(step.violations[0].code, 'LEDGER_AMBIGUOUS_REFERENCE');
    assert.equal(step.violations[0].severity, 'hard');
  });
  it('does not reassign a duplicate registration ID to a generated ID', () => {
    const state = { ledger: { records: [{ id: 'city', feature: 'objects', name: '도시', aliases: [], fields: {}, status: 'active', recent: [] }] }, hooks: [] };
    const step = applyLedgerOps(state, [register('검', {}, 'city')], { chapter: 1, identityVersion: 2 });
    assert.equal(step.ledger.records.length, 1);
    assert.equal(step.violations[0].code, 'LEDGER_ID_CONFLICT');
  });
  it('marks real extraction with version 2 and preserves explicitly supplied register IDs', async () => {
    const result = await extractDelta({ chapterNumber: 1, prose: '백야가 보였다.', castManifestRaw: '{}',
      foundation: { workId: 'w', genre: 'action', characters: [], worldFacts: [], genreProfile: createGenreProfileRegistry().get('action') }, prevState: emptyStoryState('w'),
      model: { provider: 'host', modelId: 'synthetic' }, providers: { async complete() { return { text: JSON.stringify({ ledgerOps: [register('검', {}, 'sword')] }) }; } } });
    assert.equal(result.delta.ledgerIdentityVersion, 2);
    assert.equal(result.delta.ledgerOps[0].id, 'sword');
  });
});

for (const [name, Lexicon, seed] of [
  ['sensitive', DefaultSensitiveLexicon, [{ term: '검사', category: 'profanity' }, { term: '검사', category: 'sexual-explicit' }]],
  ['emotion', DefaultEmotionVerbLexicon, [{ verb: '웃었다', emotion: 'joy' }, { verb: '웃었다', emotion: 'anger' }]],
  ['onomatopoeia', DefaultOnomatopoeiaLexicon, [{ word: '쿵', category: 'sound' }, { word: '쿵', category: 'motion' }]],
]) it(`${name} rejects duplicate surface keys instead of silently dropping entries`, () => {
  assert.throws(() => new Lexicon(seed), { code: 'DUPLICATE_LEXICON_KEY' });
});
