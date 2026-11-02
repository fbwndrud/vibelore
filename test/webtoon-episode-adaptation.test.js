import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAdaptation, episodeCast, pageTexts, adaptationDigest, pageDigest, EPISODE_LIMITS, ADAPTATION_PROMPT } from '../src/core/webtoon-episode.js';
import { validateScenePlan, isVerbatimText } from '../src/core/webtoon-scene.js';
import { scenePlan } from './fixtures/webtoon-scene.js';
import { adaptationFor, dropUnit, omitDrawnBeat, withText, withExtraSpeaker, withSpeaker, withPanels, withTexts, withPages } from './fixtures/webtoon-episode.js';

const units = [{ id: 'u1', text: '"문 열어." 그녀가 말했다.' }, { id: 'u2', text: '대답은 없었다.' }, { id: 'u3', text: '손잡이가 차가웠다.' }];
const ctx = { units, cast: [{ id: 'c1', name: '윤', appearance: '짧은 머리' }, { id: 'c2', name: '해', appearance: '' }], maxPages: 6 };
const bad = (adaptation, code, context = ctx) => assert.throws(() => validateAdaptation(adaptation, context), new RegExp(`^Error: ${code}$`));
const mutate = (fn) => { const a = adaptationFor(units); fn(a); return a; };

test('a valid adaptation passes', () => { assert.equal(validateAdaptation(adaptationFor(units), ctx).pages.length, 1); });
test('an uncovered source unit fails', () => bad(dropUnit(adaptationFor(units)), 'EDITORIAL_SOURCE_UNCOVERED'));
test('a panel drawing an omitted beat fails', () => bad(omitDrawnBeat(adaptationFor(units)), 'EPISODE_EXCLUDED_BEAT_DRAWN'));
test('a non-verbatim text fails', () => bad(withText(adaptationFor(units), '바꾼 대사'), 'EPISODE_TEXT_NOT_VERBATIM'));

test('quote marks and emphasis around a text do not break the verbatim rule', () => {
  assert.ok(validateAdaptation(withText(adaptationFor(units), '"문 열어."'), ctx));
  assert.ok(validateAdaptation(withText(adaptationFor(units), '문 열어.'), ctx));
});

test('accepts an extras speaker and rejects an undeclared one', () => {
  assert.ok(validateAdaptation(withExtraSpeaker(adaptationFor(units), 'rider'), ctx));
  assert.throws(() => validateAdaptation(withSpeaker(adaptationFor(units), 'rider'), ctx), /EPISODE_TEXT_SPEAKER/);
});

test('speakers: cast ids and narrator pass; caption and sfx must be narrator; unknown kinds fail', () => {
  assert.ok(validateAdaptation(withSpeaker(adaptationFor(units), 'c2'), ctx));
  const caption = kind => mutate(a => Object.assign(a.pages[0].panels[0].texts[0], { kind, speaker: 'c1' }));
  bad(caption('caption'), 'EPISODE_TEXT_SPEAKER'); bad(caption('sfx'), 'EPISODE_TEXT_SPEAKER');
  assert.ok(validateAdaptation(mutate(a => Object.assign(a.pages[0].panels[0].texts[0], { kind: 'caption', speaker: 'narrator' })), ctx));
  bad(mutate(a => { a.pages[0].panels[0].texts[0].kind = 'shout'; }), 'EPISODE_TEXT_SPEAKER');
});

test('caps: 7 panels, 3 texts, too many pages, exact page count', () => {
  assert.throws(() => validateAdaptation(withPanels(adaptationFor(units), 7), ctx), /EPISODE_PANEL_COUNT/);
  assert.throws(() => validateAdaptation(withPanels(adaptationFor(units), 2), ctx), /EPISODE_PANEL_COUNT/);
  assert.ok(validateAdaptation(withPanels(adaptationFor(units), EPISODE_LIMITS.panelsMax), ctx));
  assert.throws(() => validateAdaptation(withTexts(adaptationFor(units), 3), ctx), /EPISODE_TEXT_LIMIT/);
  assert.ok(validateAdaptation(withTexts(adaptationFor(units), 2), ctx));
  assert.throws(() => validateAdaptation(withPages(adaptationFor(units), 3), { ...ctx, maxPages: 2 }), /EPISODE_PAGE_COUNT/);
  assert.equal(validateAdaptation(withPages(adaptationFor(units), 3), ctx).pages.length, 3);
  assert.throws(() => validateAdaptation(adaptationFor(units), { ...ctx, exactPages: 2 }), /EPISODE_PAGE_COUNT/);
  assert.ok(validateAdaptation(withPages(adaptationFor(units), 2), { ...ctx, exactPages: 2 }));
  bad(adaptationFor(units, { pages: [] }), 'EPISODE_PAGE_COUNT');
});

test('only one physical text per panel; the page count needs a reason', () => {
  const physical = mutate(a => { const [t] = a.pages[0].panels[0].texts; a.pages[0].panels[0].texts = [{ ...t, kind: 'physical' }, { ...t, id: 't1-2', kind: 'physical' }]; });
  bad(physical, 'EPISODE_TEXT_LIMIT');
  bad(adaptationFor(units, { pageCountReason: '  ' }), 'EPISODE_PAGE_COUNT_REASON_REQUIRED');
});

test('missing bridge fails; page opener allowed only first', () => {
  for (const field of ['shows', 'readerDelta', 'bridge']) bad(mutate(a => { a.pages[0].panels[1][field] = ' '; }), 'EPISODE_PANEL_FIELDS_REQUIRED');
  bad(mutate(a => { a.pages[0].panels[1].bridge = 'page opener'; }), 'EPISODE_PANEL_FIELDS_REQUIRED');
  assert.ok(validateAdaptation(withPages(adaptationFor(units), 2), ctx), 'each page may open with a page opener');
  assert.equal(adaptationFor(units).pages[0].panels[0].bridge, 'page opener');
});

test('beats and sources: a retained beat must be drawn and panel sources must belong to its beats', () => {
  bad(mutate(a => { a.editorial.beats.push({ ...a.editorial.beats[0], id: 'beat-2', sourceIds: [] }); }), 'EDITORIAL_SOURCE_REQUIRED');
  // u3 moves from beat-1 into a second retained beat, which no panel draws yet.
  const split = () => mutate(a => {
    const [beat] = a.editorial.beats, last = beat.sourceIds.pop();
    a.editorial.beats.push({ ...beat, id: 'beat-2', sourceIds: [last], decision: 'condense' });
    a.pages[0].panels[2].sourceIds = ['u2'];
  });
  bad(split(), 'EPISODE_RETAINED_BEAT_MISSING');
  const mismatch = split(); mismatch.pages[0].panels[0].sourceIds = ['u3'];
  bad(mismatch, 'EPISODE_PANEL_SOURCE_MISMATCH');
  bad(mutate(a => { a.pages[0].panels[0].beatIds = ['nope']; }), 'EPISODE_EXCLUDED_BEAT_DRAWN');
});

test('ids: duplicates, unsafe ids and extras colliding with the cast are rejected', () => {
  bad(mutate(a => { a.pages[0].panels[1].id = 'p1-1'; }), 'EPISODE_ID_DUPLICATE');
  bad(mutate(a => { a.pages[0].id = 'page 1'; }), 'EPISODE_ID_DUPLICATE');
  bad(withTexts(mutate(a => { a.pages[0].panels[1].texts = [{ ...a.pages[0].panels[0].texts[0] }]; }), 1), 'EPISODE_ID_DUPLICATE');
  bad(withExtraSpeaker(adaptationFor(units), 'c2'), 'EPISODE_ID_DUPLICATE');
  bad(withExtraSpeaker(adaptationFor(units), 'narrator'), 'EPISODE_ID_DUPLICATE');
  bad(mutate(a => { a.extras = [{ id: 'x', label: 'a', sourceIds: ['u1'] }, { id: 'x', label: 'b', sourceIds: ['u1'] }]; }), 'EPISODE_ID_DUPLICATE');
});

test('extras may only cite source units', () => {
  bad(mutate(a => { a.extras = [{ id: 'rider', label: '기수', sourceIds: ['nope'] }]; }), 'EPISODE_EXTRA_SOURCE');
  bad(mutate(a => { a.extras = [{ id: 'rider', label: '기수' }]; }), 'EPISODE_EXTRA_SOURCE');
});

test('episodeCast reads character frontmatter', () => {
  const doc = (id, name, appearance) => ({ id: `characters/${id}.md`, path: `characters/${id}.md`, raw: `---\nid: ${id}\nname: ${name}\nappearance: [${appearance}]\n---\n\n본문\n` });
  const sourceWithDocs = { documents: [doc('c1', '윤', '짧은 머리, 검은 코트'), { id: 'world/places/door.md', path: 'world/places/door.md', raw: '---\nid: door\n---\n' }, doc('c2', '해', '큰 키')] };
  assert.deepEqual(episodeCast(sourceWithDocs).map(c => c.id), ['c1', 'c2']);
  assert.deepEqual(episodeCast(sourceWithDocs)[0], { id: 'c1', name: '윤', appearance: '짧은 머리; 검은 코트' });
  assert.deepEqual(episodeCast({ cast: [{ id: 'x', name: 'X', appearance: '' }], documents: sourceWithDocs.documents }).map(c => c.id), ['x']);
  assert.deepEqual(episodeCast({}), []);
});

test('pageTexts flattens panel texts in order; digests follow content', () => {
  const page = withPages(withTexts(adaptationFor(units), 2), 1).pages[0];
  assert.deepEqual(pageTexts(page).map(t => t.id), ['t1-1-1', 't1-1-2']);
  const a = adaptationFor(units), b = withText(a, '문 열어.');
  assert.equal(adaptationDigest(a), adaptationDigest(structuredClone(a)));
  assert.notEqual(adaptationDigest(a), adaptationDigest(b));
  assert.notEqual(pageDigest(a.pages[0]), pageDigest(b.pages[0]));
  assert.match(ADAPTATION_PROMPT, /page opener/);
});

test('scene plan validation still uses the shared verbatim rule', () => {
  const sceneUnits = [{ id: 'u1', text: '"We don\'t need to spend anything there *yet*," Ellis said.' }];
  assert.equal(isVerbatimText("We don't need to spend anything there yet,", sceneUnits[0].text), true);
  assert.equal(isVerbatimText("We don't need to spend anything here yet,", sceneUnits[0].text), false);
  assert.equal(isVerbatimText('""', sceneUnits[0].text), false);
  const plan = scenePlan([{ id: 'u1', text: sceneUnits[0].text }]);
  assert.ok(validateScenePlan(plan, sceneUnits));
  plan.texts[0].text = '바꾼 대사';
  assert.throws(() => validateScenePlan(plan, sceneUnits), /SCENE_TEXT_NOT_VERBATIM/);
});
