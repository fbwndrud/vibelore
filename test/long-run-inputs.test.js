import test from 'node:test';
import assert from 'node:assert/strict';

import { renderCurrentState, renderCheckSections, renderCastBrief, planningCast } from '../src/core/prompt-sections.js';
import { promptKit } from '../src/prompts/index.js';
import { buildLanguageContract } from '../engine/src/core/language-policy.js';
import { longRunHistory, longRunWork } from './fixtures/long-run-state.js';

/**
 * Per-chapter inputs must not grow with the length of the work. Each render
 * is taken at chapter 300 and chapter 1000 of the same synthetic work; the
 * later one may be at most 20% larger and must stay under an absolute cap,
 * and every needle the prose or plan touches must still be there.
 */
const kit = promptKit({ contract: buildLanguageContract({ language: 'ko' }) });
const GROWTH = 1.2;

function both(render) {
  return [300, 1000].map((n) => render(longRunWork(n)));
}

function bounded(label, [small, large], cap) {
  assert.ok(large.length <= small.length * GROWTH, `${label}: ${small.length} at 300 → ${large.length} at 1000`);
  assert.ok(large.length <= cap, `${label}: ${large.length} > ${cap}`);
}

test('extraction state stays bounded and keeps what the prose touches', () => {
  const texts = both((w) => renderCurrentState(w.state, w.foundation, { kit, mode: 'extract', focusText: w.prose, cast: w.cast }));
  bounded('extract', texts, 8000);
  for (const text of texts) {
    assert.match(text, /`silver-key` \[Artifact\] 은빛 열쇠/, 'the item the prose uses keeps its id');
    assert.match(text, /`red-lamp`/, 'the hook the prose pays keeps its id');
    assert.match(text, /조연5 \(x5\)/, 'the speaking supporting character');
  }
});

test('writer state stays bounded and keeps the dead character and old hook the plan names', () => {
  const texts = both((w) => renderCurrentState(w.state, w.foundation, { kit, mode: 'writer', focusText: w.plan, cast: w.cast }));
  bounded('writer', texts, 5000);
  for (const text of texts) {
    assert.match(text, /조연0 \(x0\).*사망/);
    assert.match(text, /붉은 등불은 누가 껐는가/);
  }
});

test('writer state with the whole event log stays under the writer cap and gives a returning record a short history', () => {
  const w = longRunWork(1000);
  const history = longRunHistory(1000, 5000);
  const text = renderCurrentState(w.state, w.foundation, { kit, mode: 'writer', focusText: w.plan, cast: w.cast, history });
  assert.ok(text.length <= 5000, `writer with history: ${text.length}`);
  // 은빛 열쇠 last moved in chapter 4: named in the focus, it comes back with at most five history items.
  const returning = renderCurrentState(w.state, w.foundation, { kit, mode: 'writer', focusText: `${w.plan} 은빛 열쇠를 꺼낸다.`, cast: w.cast, history });
  assert.ok(returning.length <= 5000, `returning record: ${returning.length}`);
  const line = returning.split('\n').find((item) => item.includes('이력:'));
  assert.ok(line, 'a history line');
  assert.equal(line.split(', ').length, 5);
  assert.match(line, /11화 변경 열쇠 7$/, 'the latest events');
  // Thirty chapters of silence is past the gap too.
  const state = structuredClone(w.state);
  state.ledger.records[0].lastEventAt = 970;
  assert.match(renderCurrentState(state, w.foundation, { kit, mode: 'writer', focusText: '은빛 열쇠를 꺼낸다.', cast: w.cast, history }), /이력:/);
});

test('planning state and cast list stay bounded', () => {
  bounded('plan state', both((w) => renderCurrentState(w.state, w.foundation, { kit, mode: 'planner', focusText: w.plan, cast: planningCast(w.foundation, { focusText: w.plan, chapter: w.state.chapterNumber + 1 }) })), 6000);
  bounded('cast brief', both((w) => renderCastBrief(w.foundation, kit, { focusText: w.plan, chapter: w.state.chapterNumber + 1 })), 3000);
});

test('check sections stay bounded and keep the characters the prose shows', () => {
  const texts = both((w) => Object.values(renderCheckSections({ foundation: w.foundation, prevState: w.state, kit, focusText: w.prose,
    delta: { appearedCharacterIds: ['c1', 'c2', 'x5'], newAddressEntries: [], mutableChanges: [], trackedEntityOps: [] } })).join('\n'));
  bounded('check', texts, 6000);
  for (const text of texts) assert.match(text, /foundation\.characters\[\d+\]\S* 조연5/);
});

test('review fixes: selection keeps what the plan or prose names even under the caps', () => {
  const w = longRunWork(300);
  // Hooks the plan touches are never cut by the cap.
  const touched = w.state.hooks.slice(1, 16).map((h) => h.id);
  const withTouched = renderCurrentState(w.state, w.foundation, { kit, mode: 'extract', focusText: w.prose, cast: w.cast, hookIds: touched });
  for (const id of touched) assert.match(withTouched, new RegExp(`\`${id}\``), id);
  // An item the prose names by name beats 35 recent items sharing a state word.
  const state = structuredClone(w.state);
  state.ledger.records.push(...Array.from({ length: 35 }, (_, i) => ({ id: `glow${i}`, feature: 'objects', label: 'Artifact', name: `빛${i}`, aliases: [],
    status: 'active', fields: { holder: 'x9', state: '빛난다' }, lastEventAt: 300, recent: [] })));
  const named = renderCurrentState(state, w.foundation, { kit, mode: 'extract', focusText: `${w.prose} 방패가 빛난다.`, cast: w.cast });
  assert.match(named, /`silver-key`/);
  // Known facts the focus names survive the three-fact limit.
  state.characterStates.c1.knownFacts = ['OLD_FACT 등불의 주인', 'n1', 'n2', 'n3', 'n4'];
  assert.match(renderCurrentState(state, w.foundation, { kit, mode: 'writer', focusText: '등불의 주인을 찾는다', cast: w.cast }), /OLD_FACT/);
  // A relationship between two focused characters beats newer one-sided ones.
  state.relationships.push({ from: 'c1', to: 'c2', kind: 'CORE_BOND', state: '믿음' }, ...Array.from({ length: 8 }, (_, i) => ({ from: `x${i}`, to: 'c1', kind: '경계', state: `새 ${i}` })));
  assert.match(renderCurrentState(state, w.foundation, { kit, mode: 'writer', focusText: w.plan, cast: w.cast }), /CORE_BOND/);
});

test('review fixes: names match as words, and future characters stay out of the planning list', async () => {
  const { namedCharacters } = await import('../src/core/prompt-sections.js');
  const w = longRunWork(1000);
  const ids = namedCharacters(w.foundation, '조연50가 말했다.');
  assert.ok(ids.has('x50'));
  assert.ok(!ids.has('x5'), '조연5 is not 조연50');
  const brief = renderCastBrief(w.foundation, kit, { focusText: '', chapter: 20 });
  assert.doesNotMatch(brief, /조연100\(/, 'registered at chapter 808');
});

test('review fixes: the check sees the previous value of a tracked item this chapter changes', () => {
  const w = longRunWork(100);
  const prevState = { ...w.state, ledger: { records: [{ id: 'silver-key', feature: 'objects', label: 'Artifact', name: '은빛 열쇠', aliases: [], status: 'active', fields: { holder: 'x5', state: '녹슨 채 보관' }, lastEventAt: 4, recent: [] }] } };
  const sections = renderCheckSections({ foundation: w.foundation, prevState, kit, focusText: w.prose,
    delta: { appearedCharacterIds: ['c1'], ledgerOps: [{ op: 'event', id: 'silver-key', event: 'changed', set: { holder: 'c1' } }] } });
  assert.match(sections.prev, /은빛 열쇠[^\n]*조연5/);
});
