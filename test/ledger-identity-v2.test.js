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

const customRecord = (id, name = '백야') => ({ id, feature: 'objects', label: '물건', name, aliases: [], fields: { amount: 1 }, status: 'active', recent: [] });
const customRule = (id, direction = 'down') => ({ id, feature: 'objects', name: '백야', rules: [{ type: 'monotonic', field: 'amount', direction, severity: 'hard' }] });

it('preserves explicit registration IDs when custom tracking uses the same name', () => {
  const result = applyLedgerOps({ ledger: { records: [] }, hooks: [] }, [register('도시', {}, 'city'), register('검', {}, 'sword'), { op: 'event', id: 'sword', event: 'changed', set: { holder: 'hero' } }],
    { chapter: 1, identityVersion: 2, config: { customTracking: [customRule('custom-sword')] } });
  assert.deepEqual(result.ledger.records.map(r => r.id), ['city', 'sword']);
  assert.equal(result.ledger.records[1].fields.holder, 'hero');
  assert.equal(result.violations.some(v => v.code === 'LEDGER_UNKNOWN_ID'), false);
});
it('does not assign an occupied custom tracking ID to a distinct unnamed registration', () => {
  const result = applyLedgerOps({ ledger: { records: [] }, hooks: [] }, [register('도시', {}), register('검', {})],
    { chapter: 1, identityVersion: 2, config: { customTracking: [customRule('custom-sword')] } });
  assert.equal(result.ledger.records.length, 2);
  assert.equal(new Set(result.ledger.records.map(r => r.id)).size, 2);
});
it('applies the exact ID rule rather than the first homonymous rule', () => {
  const result = applyLedgerOps({ ledger: { records: [customRecord('a'), customRecord('b')] }, hooks: [] }, [{ op: 'event', id: 'b', event: 'changed', set: { amount: 2 } }],
    { chapter: 1, identityVersion: 2, config: { customTracking: [customRule('a'), customRule('b', 'up')] } });
  assert.equal(result.violations.some(v => v.code === 'CUSTOM_RULE_MONOTONIC'), false);
  assert.equal(result.ledger.records[1].fields.amount, 2);
});
it('does not apply another exact-ID owners rule through a shared name', () => {
  const result = applyLedgerOps({ ledger: { records: [customRecord('a'), customRecord('b')] }, hooks: [] }, [{ op: 'event', id: 'b', event: 'changed', set: { amount: 2 } }],
    { chapter: 1, identityVersion: 2, config: { customTracking: [customRule('a')] } });
  assert.deepEqual(result.violations, []);
});
it('keeps late name-based rule attachment only when the record and custom candidates are both unique', () => {
  const ops = [{ op: 'event', id: 'a', event: 'changed', set: { amount: 2 } }], config = { customTracking: [customRule('custom')] };
  const single = applyLedgerOps({ ledger: { records: [customRecord('a')] }, hooks: [] }, ops, { chapter: 1, identityVersion: 2, config });
  assert.equal(single.violations[0].code, 'CUSTOM_RULE_MONOTONIC');
  const ambiguous = applyLedgerOps({ ledger: { records: [customRecord('a'), customRecord('b')] }, hooks: [] }, ops, { chapter: 1, identityVersion: 2, config });
  assert.deepEqual(ambiguous.violations, []);
});
it('creates an unregistered explicit custom ID instead of redirecting its event to another record', () => {
  const result = applyLedgerOps({ ledger: { records: [customRecord('existing')] }, hooks: [] }, [{ op: 'event', id: 'custom', event: 'changed', set: { holder: 'hero' } }],
    { chapter: 1, identityVersion: 2, config: { customTracking: [customRule('custom')] } });
  assert.equal(result.ledger.records[0].fields.holder, undefined);
  assert.equal(result.ledger.records.find(r => r.id === 'custom').fields.holder, 'hero');
});
it('retains historical first-name custom-rule interpretation in v1', () => {
  const result = applyLedgerOps({ ledger: { records: [customRecord('a'), customRecord('b')] }, hooks: [] }, [{ op: 'event', id: 'b', event: 'changed', set: { amount: 2 } }],
    { chapter: 1, identityVersion: 1, config: { customTracking: [customRule('a'), customRule('b', 'up')] } });
  assert.equal(result.violations[0].code, 'CUSTOM_RULE_MONOTONIC');
});

it('pins only the exact custom owner in the writer context when names overlap', async () => {
  const { renderCurrentState } = await import('../src/core/prompt-sections.js');
  const { promptKit } = await import('../src/prompts/index.js');
  const { buildLanguageContract } = await import('../engine/src/core/language-policy.js');
  const state = { ...emptyStoryState('w'), chapterNumber: 20, ledger: { records: [
    { ...customRecord('a'), lastEventAt: 1, fields: { note: 'ONLY_A_TOKEN' } },
    { ...customRecord('b'), lastEventAt: 1, fields: { note: 'ONLY_B_TOKEN' } },
  ] } };
  const rendered = renderCurrentState(state, { characters: [] }, { mode: 'writer',
    kit: promptKit({ contract: buildLanguageContract({ language: 'ko' }) }), config: { customTracking: [{ ...customRule('a'), pinned: true }] } });
  assert.match(rendered, /ONLY_A_TOKEN/);
  assert.doesNotMatch(rendered, /ONLY_B_TOKEN/);
});

it('prioritizes an unregistered custom ID over another records name', () => {
  const result = applyLedgerOps({ ledger: { records: [customRecord('existing', 'custom')] }, hooks: [] }, [{ op: 'event', id: 'custom', event: 'changed', set: { holder: 'hero' } }],
    { chapter: 1, identityVersion: 2, config: { customTracking: [customRule('custom')] } });
  assert.equal(result.ledger.records[0].fields.holder, undefined);
  assert.equal(result.ledger.records.find(r => r.id === 'custom').fields.holder, 'hero');
});
