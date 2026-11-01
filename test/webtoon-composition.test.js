import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sceneSetup, scenePlan, scenePreflight } from './fixtures/webtoon-scene.js';
import { workId, otherPixel } from './fixtures/webtoon.js';
import { runWebtoonStyleTool } from '../src/tools/webtoon-style.js';
import { runWebtoonSceneTool } from '../src/tools/webtoon-scene.js';
import { WebtoonStore } from '../src/store/webtoon-store.js';
import { isEnglish, RETRY_FRAMING } from '../src/core/webtoon-scene.js';
import {
  COMPOSITION_VOCAB, COMPOSITION_VOCAB_VERSION, COMPOSITION_LIMITS, REQUIRED_KINDS, SCENE_TYPES,
  validateCompositionLabel, compositionFingerprint, migrateCompositionLabel, framingPhrase, splitCompositionDirection,
} from '../src/core/webtoon-composition.js';

const label = () => ({
  shot: 'WS', angle: 'high', focal: 'space', background: 'detailed',
  subjects: [{ id: 'harry', visibility: 'face', side: 'L', facing: 'R', expression: 'tired' },
    { id: 'ron', visibility: 'partial', side: 'R', facing: 'L', expression: 'neutral' }],
  directed: true, required: [{ kind: 'prop', id: 'mirror', sourceIds: ['u12'] }], note: 'Harry waits by the mirror',
});
const rejects = (value, opts, code = /INVALID_SCENE_COMPOSITION/) => assert.throws(() => validateCompositionLabel(value, opts), code);

test('vocabulary values, limits and kinds are fixed and frozen', () => {
  assert.equal(COMPOSITION_VOCAB_VERSION, 1);
  assert.deepEqual(Object.keys(COMPOSITION_VOCAB), ['shot', 'angle', 'visibility', 'side', 'facing', 'expression', 'focal', 'background', 'layout']);
  assert.deepEqual(COMPOSITION_VOCAB.shot, ['ECU', 'CU', 'MCU', 'MS', 'FS', 'WS', 'EST', 'INSERT']);
  assert.deepEqual(COMPOSITION_VOCAB.angle, ['eye', 'high', 'low', 'top', 'worm', 'dutch', 'ots', 'pov']);
  assert.deepEqual(COMPOSITION_VOCAB.visibility, ['face', 'partial', 'back', 'hand', 'silhouette']);
  assert.deepEqual(COMPOSITION_VOCAB.side, ['L', 'C', 'R']);
  assert.deepEqual(COMPOSITION_VOCAB.facing, ['L', 'R', 'front', 'back', 'down']);
  assert.deepEqual(COMPOSITION_VOCAB.expression, ['neutral', 'scowl', 'smirk', 'shock', 'laugh', 'soft', 'tired', 'other']);
  assert.deepEqual(COMPOSITION_VOCAB.focal, ['face', 'hands', 'prop', 'space', 'text', 'two-face']);
  assert.deepEqual(COMPOSITION_VOCAB.background, ['detailed', 'bokeh', 'flat', 'white', 'fx', 'silhouette']);
  assert.deepEqual(COMPOSITION_VOCAB.layout, ['strip-stack', 'split-row', 'tall-panel', 'bleed', 'grid', 'single-splash']);
  assert.deepEqual(REQUIRED_KINDS, ['character', 'prop', 'action', 'location', 'text', 'state']);
  assert.deepEqual(SCENE_TYPES, ['dialogue', 'action', 'reveal', 'quiet']);
  assert.deepEqual(COMPOSITION_LIMITS, { directedPerPage: 2, noteWords: 12 });
  for (const list of Object.values(COMPOSITION_VOCAB)) assert.equal(Object.isFrozen(list), true);
});

test('validateCompositionLabel accepts a full label and returns it', () => {
  const l = label();
  assert.equal(validateCompositionLabel(l, { castIds: ['harry', 'ron'] }), l);
  const bare = { shot: 'CU', angle: 'eye', focal: 'face', background: 'flat', subjects: [] };
  assert.equal(validateCompositionLabel(bare), bare);
  validateCompositionLabel({ ...label(), vocabVersion: 1 });
});

test('validateCompositionLabel rejects off-vocabulary values, gaps, bad subjects and long notes', () => {
  rejects({ ...label(), shot: 'XL' });
  rejects({ ...label(), angle: 'sideways' });
  rejects({ ...label(), focal: 'elbow' });
  rejects({ ...label(), background: 'neon' });
  for (const key of ['shot', 'angle', 'focal', 'background']) { const l = label(); delete l[key]; rejects(l); }
  rejects({ ...label(), subjects: 'harry' });
  rejects({ ...label(), subjects: undefined });
  rejects({ ...label(), subjects: [{ id: 'ghost', visibility: 'face', side: 'L' }] }, { castIds: ['harry'] });
  rejects({ ...label(), subjects: [{ id: '../x', visibility: 'face', side: 'L' }] });
  rejects({ ...label(), subjects: [{ id: 'harry', visibility: 'gone', side: 'L' }] });
  rejects({ ...label(), subjects: [{ id: 'harry', visibility: 'face', side: 'M' }] });
  rejects({ ...label(), subjects: [{ id: 'harry', facing: 'up' }] });
  rejects({ ...label(), subjects: [{ id: 'harry', expression: 'wry' }] });
  rejects({ ...label(), note: 'one two three four five six seven eight nine ten eleven twelve thirteen' });
  rejects({ ...label(), required: [{ kind: 'mood', id: 'x', sourceIds: ['u1'] }] });
  rejects(null); rejects('WS');
  validateCompositionLabel({ ...label(), note: 'one two three four five six seven eight nine ten eleven twelve' });
  assert.throws(() => validateCompositionLabel({ ...label(), vocabVersion: COMPOSITION_VOCAB_VERSION + 1 }), /UNMAPPED_COMPOSITION/);
});

test('compositionFingerprint ignores subject order and notes but not framing', () => {
  const a = label(), b = { ...label(), subjects: [...label().subjects].reverse(), note: 'other words', directed: false };
  assert.equal(compositionFingerprint(a), compositionFingerprint(b));
  assert.match(compositionFingerprint(a), /^sha256:/);
  assert.notEqual(compositionFingerprint(a), compositionFingerprint({ ...a, shot: 'CU' }));
  assert.notEqual(compositionFingerprint(a), compositionFingerprint({ ...a, subjects: [{ ...a.subjects[0], side: 'R' }, a.subjects[1]] }));
});

test('migrateCompositionLabel is the identity for the current version and unmapped otherwise', () => {
  const l = label();
  assert.equal(migrateCompositionLabel(l, COMPOSITION_VOCAB_VERSION), l);
  assert.equal(migrateCompositionLabel(l, 0), 'unmapped');
  assert.equal(migrateCompositionLabel(l, COMPOSITION_VOCAB_VERSION + 1), 'unmapped');
});

test('framingPhrase is positive English of at most 12 words for every shot and angle', () => {
  const nameOf = id => ({ harry: 'Harry' })[id] ?? id;
  for (const shot of COMPOSITION_VOCAB.shot) for (const angle of COMPOSITION_VOCAB.angle) for (const focal of COMPOSITION_VOCAB.focal) {
    const phrase = framingPhrase({ ...label(), shot, angle, focal }, nameOf);
    assert.equal(isEnglish(phrase), true, phrase);
    assert.ok(phrase.split(/\s+/).length <= 12, phrase);
    assert.equal(RETRY_FRAMING.test(phrase), false, phrase);
  }
  assert.equal(framingPhrase({ ...label(), subjects: [] }, nameOf), 'wide high-angle view');
});

test('framingPhrase drops a name that would break the phrase rules', () => {
  const l = { ...label(), shot: 'CU', angle: 'eye', focal: 'face' };
  assert.match(framingPhrase(l, () => 'Harry'), /Harry/);
  for (const bad of ['No Name', '해리', 'one two three four five six seven eight nine ten']) {
    const phrase = framingPhrase(l, () => bad);
    assert.equal(isEnglish(phrase) && !RETRY_FRAMING.test(phrase) && phrase.split(/\s+/).length <= 12, true, bad);
    assert.equal(phrase.includes(bad), false, bad);
  }
});

test('splitCompositionDirection moves composition sentences out of the style direction', () => {
  assert.deepEqual(splitCompositionDirection('Full color comic. Varied face and hand framing. Single-column vertical scroll.'),
    { direction: 'Full color comic.', compositionDefaults: ['Varied face and hand framing.', 'Single-column vertical scroll.'] });
  assert.deepEqual(splitCompositionDirection('Muted ink wash. Close-ups on hands! Camera stays low?'),
    { direction: 'Muted ink wash.', compositionDefaults: ['Close-ups on hands!', 'Camera stays low?'] });
  assert.deepEqual(splitCompositionDirection('Full color comic with soft shading'), { direction: 'Full color comic with soft shading', compositionDefaults: [] });
});

test('an all-composition direction is kept unchanged', () => {
  const only = 'Varied framing. AI chooses layout.';
  assert.deepEqual(splitCompositionDirection(only), { direction: only, compositionDefaults: [] });
});

function capture() {
  const seen = {};
  return { seen, provenance: { kind: 'fixture' }, async complete(r) {
    const d = JSON.parse(r.messages.at(-1).content); seen[r.step] = d;
    if (r.step === 'webtoon-scene-plan') return { text: JSON.stringify(scenePlan(d.source)) };
    if (r.step === 'webtoon-scene-preflight') {
      const answer = scenePreflight(d); if (d.styleBasis) answer.renderBrief.style = d.styleBasis.profile.style;
      return { text: JSON.stringify(answer) };
    }
    throw new Error('unexpected step ' + r.step);
  } };
}

test('a new scene keeps composition sentences out of the style direction and passes them only to scene_generate', async () => {
  const { store, args } = await sceneSetup(), providers = capture();
  const r = await runWebtoonSceneTool({ store, args, providers });
  assert.deepEqual(r.compositionDefaults, ['AI chooses layout.']);
  const w = await new WebtoonStore(store).load();
  assert.equal(w.compositionVersion, COMPOSITION_VOCAB_VERSION);
  assert.equal(w.direction, 'Full color comic. Original Korean lettering.');
  assert.deepEqual(w.compositionDefaults, ['AI chooses layout.']);
  assert.deepEqual(providers.seen['webtoon-scene-plan'].seriesComposition, ['AI chooses layout.']);
  assert.equal(providers.seen['webtoon-scene-plan'].direction, 'Full color comic. Original Korean lettering.');
  assert.equal(providers.seen['webtoon-scene-preflight'].direction.includes('layout'), false);
  assert.equal('seriesComposition' in providers.seen['webtoon-scene-preflight'], false);
});

test('a scene without composition sentences sends no seriesComposition', async () => {
  const { store, args } = await sceneSetup(), providers = capture();
  await runWebtoonSceneTool({ store, args: { ...args, direction: 'Full color comic. Original Korean lettering.' }, providers });
  assert.equal('seriesComposition' in providers.seen['webtoon-scene-plan'], false);
  assert.deepEqual((await new WebtoonStore(store).load()).compositionDefaults, []);
});

async function adoptStyle(store, direction, file) {
  const imagePath = join(store.rootDir, file); await writeFile(imagePath, otherPixel);
  const c = await runWebtoonStyleTool({ store, args: { workId, action: 'propose', brief: 'look', direction, imagePath } });
  return (await runWebtoonStyleTool({ store, args: { workId, action: 'approve', proposalId: c.proposalId, feedback: 'use it', applyToWorkflows: [] } })).style;
}
async function restyleFlow({ mutate }) {
  const { store, args } = await sceneSetup(), repo = new WebtoonStore(store);
  await adoptStyle(store, 'Monochrome ink. Close-ups on hands.', 'a.png');
  const { direction, ...rest } = args;
  const first = await runWebtoonSceneTool({ store, args: rest, providers: capture() });
  if (mutate) { const w = await repo.load(); mutate(w); await repo.save(w); }
  const next = await adoptStyle(store, 'Soft watercolor. Wide shots of the street.', 'b.png');
  await runWebtoonSceneTool({ store, args: { workId, action: 'revise', styleRevisionId: next.revisionId, feedback: 'new style' }, providers: capture() });
  return { first, workflow: await repo.load() };
}

test('restyle keeps following the style direction after the composition split', async () => {
  const { first, workflow } = await restyleFlow({});
  assert.deepEqual(first.compositionDefaults, ['Close-ups on hands.']);
  assert.equal(workflow.direction, 'Soft watercolor.');
  assert.deepEqual(workflow.compositionDefaults, ['Wide shots of the street.']);
});

test('a workflow saved before the composition split restyles exactly as it did before', async () => {
  const { workflow } = await restyleFlow({ mutate: w => {
    delete w.compositionVersion; delete w.compositionDefaults; w.direction = w.styleSnapshot.profile.style;
  } });
  assert.equal(workflow.direction, 'Soft watercolor. Wide shots of the street.');
  assert.equal(workflow.compositionVersion, undefined);
  assert.equal(workflow.compositionDefaults, undefined);
});
