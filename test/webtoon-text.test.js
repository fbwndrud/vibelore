import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, validateWebtoonPlan } from '../src/core/webtoon-contract.js';
import { imageText } from '../src/core/webtoon-text.js';
import { letteringBinding, solveLettering, validateVisualMap } from '../src/core/webtoon-lettering.js';
import { composeWebtoonBoard } from '../src/core/webtoon-board.js';
import { shotJobs, imagePolicyFor } from '../src/core/webtoon-images.js';
import { plan, pixel, webtoonStore, provider, answers, workId } from './fixtures/webtoon.js';
import { runLegacyWebtoonTool as runWebtoonTool } from './fixtures/legacy-webtoon.js';
import { WebtoonStore } from '../src/store/webtoon-store.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { segmentCommon } from '../src/core/webtoon-segments.js';
import { scriptText } from '../src/core/webtoon-text.js';

const source = { hash: 'source', units: [{ id: 'p1' }], foundation: { characters: [{ id: 'hero' }] }, chapters: [] };
const image = { mime: 'image/png', base64: pixel.toString('base64'), hash: digest(pixel) };
const physical = { kind: 'ui', speaker: 'system', text: '2021년 피해 구역', render: 'image', surface: '공원 안내판 앞면' };
const make = () => { const p = plan(source); p.sequences[0].shots[0].height = 760; return p; };
const errors = p => validateWebtoonPlan(p, source, { maxShots: 40, textPolicyVersion: 1 }).map(e => e.code);
const visualMap = shot => ({ inputHash: letteringBinding(shot, image), inspectedImages: true, evidence: 'Synthetic fixture, not real artwork', protected: [],
  entries: shot.texts.map((t, textIndex) => imageText(t)
    ? { textIndex, observedText: t.text, surfaceBounds: [.2, .7, .6, .1], confidence: 1, reason: 'Fixture sign' }
    : { textIndex, anchor: [.5, .7], candidates: [[.5, .22]], confidence: 1, reason: 'Fixture speaker' }) });

test('new plan policy separates thought, narration, physical writing and source-grounded minor speakers', () => {
  const p = make(), s = p.sequences[0].shots[0];
  s.voices = [{ id: 'staff', description: '상담 직원', sourceIds: ['p1'] }];
  s.texts = [physical, { kind: 'thought', speaker: 'hero', text: '주소는 맞았다.' },
    { kind: 'dialogue', speaker: 'staff', text: '아직 확인 중입니다.', delivery: 'offscreen' }];
  assert.deepEqual(errors(p), []);
  s.texts[0] = { ...physical, render: 'overlay' };
  assert.ok(errors(p).includes('PHYSICAL_TEXT_RENDER_REQUIRED'));
  s.texts[0] = { ...physical, surface: '' };
  assert.ok(errors(p).includes('PHYSICAL_TEXT_SURFACE_REQUIRED'));
  s.texts[0] = { ...physical, kind: 'dialogue', speaker: 'hero' };
  assert.ok(errors(p).includes('PHYSICAL_TEXT_SURFACE_REQUIRED'));
  s.texts = [{ kind: 'thought', speaker: 'narrator', text: '마음의 소리' }];
  assert.ok(errors(p).includes('DIALOGUE_SPEAKER_NOT_IN_SHOT'));
  s.voices[0].sourceIds = ['invented'];
  assert.ok(errors(p).includes('INVALID_SHOT_VOICE'));
  delete p.textPolicyVersion;
  assert.ok(errors(p).includes('TEXT_POLICY_VERSION_REQUIRED'));
});

test('old UI plans retain old validation behavior without being silently migrated', () => {
  const p = make(); delete p.textPolicyVersion;
  p.sequences[0].shots[0].texts = [{ kind: 'ui', speaker: 'system', text: '주소' }];
  assert.deepEqual(validateWebtoonPlan(p, source, { maxShots: 40 }), []);
});

test('split drafting and review share the policy; old workflow packets remain unversioned', () => {
  const w = { decisions: {}, contract: { digest: 'contract' }, source };
  assert.equal(segmentCommon(w).textInstructions, undefined);
  assert.match(segmentCommon({ ...w, textPolicyVersion: 1 }).textInstructions, /thought/);
  assert.match(scriptText(physical, {}, 1), /그림에 포함 · 공원 안내판 앞면/);
  assert.equal(scriptText(physical, {}, undefined), 'system: 2021년 피해 구역');
});

test('surface writing enters actual generation prompt/hash; overlay wording does not invalidate art', () => {
  const p = make(), s = p.sequences[0].shots[0]; s.texts = [physical, { kind: 'thought', speaker: 'hero', text: '맞나?' }];
  const w = { plan: p, source, decisions: {}, images: {}, referenceSpecs: [], references: {}, imagePolicy: imagePolicyFor('gpt-image-2') };
  const a = shotJobs(w)[0];
  assert.match(a.prompt, /2021년 피해 구역/); assert.match(a.prompt, /공원 안내판 앞면/);
  assert.doesNotMatch(a.prompt, /맞나\?/);
  s.texts[1].text = '주소는 맞았다.';
  assert.equal(shotJobs(w)[0].inputHash, a.inputHash);
  s.texts[0] = { ...physical, text: '2022년 피해 구역' };
  assert.notEqual(shotJobs(w)[0].inputHash, a.inputHash);
  s.texts[0] = { ...physical, surface: '모니터 화면' };
  assert.notEqual(shotJobs(w)[0].inputHash, a.inputHash);
  s.voices = [{ id: 'staff', description: '회색 카디건의 직원', sourceIds: ['p1'] }];
  s.texts = [{ kind: 'dialogue', speaker: 'staff', text: '확인 중입니다.', delivery: 'offscreen' }];
  assert.doesNotMatch(shotJobs(w)[0].prompt, /회색 카디건/);
  s.texts[0].delivery = 'onscreen';
  assert.match(shotJobs(w)[0].prompt, /회색 카디건/);
});

test('physical text requires exact observed wording and surface evidence, not an overlay fallback', () => {
  const s = { ...make().sequences[0].shots[0], texts: [physical] }, m = visualMap(s);
  const l = solveLettering(s, image, m);
  assert.equal(l.status, 'passed'); assert.deepEqual(l.candidates[0].items, []);
  const board = composeWebtoonBoard({ title: '검사', sequences: [{ shots: [s] }] }, { shot1: image }, { shot1: l });
  assert.doesNotMatch(board.svg, /data-kind="ui"|data-text="2021/);
  m.entries[0].observedText = '2027년 피해 구역';
  assert.ok(solveLettering(s, image, m).issues.includes('PHYSICAL_TEXT_MISMATCH'));
  m.entries[0].observedText = physical.text; delete m.entries[0].surfaceBounds;
  assert.ok(validateVisualMap(s, image, m).includes('PHYSICAL_TEXT_BOUNDS_REQUIRED'));
  m.entries[0].surfaceBounds = [.2, .7, .6, .1]; m.entries[0].candidates = [[.5, .5]];
  assert.ok(validateVisualMap(s, image, m).includes('PHYSICAL_TEXT_IS_NOT_OVERLAY'));
  assert.throws(() => composeWebtoonBoard({ title: '검사', sequences: [{ shots: [s] }] }, { shot1: image }), /VERIFIED_LAYOUT/);
});

test('other lettering cannot cover the verified physical text region', () => {
  const s = { ...make().sequences[0].shots[0], texts: [physical, { kind: 'caption', speaker: 'narrator', text: '다음날' }] }, m = visualMap(s);
  m.entries[1].candidates = [[.5, .75]];
  assert.match(solveLettering(s, image, m).issues[0], /NO_FEASIBLE_LAYOUT/);
  m.entries[1].candidates = [[.5, .2]];
  assert.equal(solveLettering(s, image, m).status, 'passed');
});

test('thought has its own tail-free treatment; offscreen speech must point to an edge', () => {
  const s = { ...make().sequences[0].shots[0], texts: [{ kind: 'thought', speaker: 'hero', text: '집이 없었다.' }] }, m = visualMap(s);
  const l = solveLettering(s, image, m); assert.equal(l.status, 'passed');
  assert.equal(l.candidates[0].items[0].tail, null);
  const board = composeWebtoonBoard({ title: '검사', sequences: [{ shots: [s] }] }, { shot1: image }, { shot1: l });
  assert.match(board.svg, /data-kind="thought"/); assert.match(board.svg, /fill="#26332e"/); assert.match(board.svg, /fill="#fff"/);
  s.texts = [{ kind: 'dialogue', speaker: 'staff', text: '확인 중입니다.', delivery: 'offscreen' }];
  const off = visualMap(s);
  assert.ok(validateVisualMap(s, image, off).includes('OFFSCREEN_ANCHOR_MUST_BE_EDGE'));
  off.entries[0].anchor = [1, .3]; off.entries[0].candidates = [[.7, .3]];
  assert.deepEqual(validateVisualMap(s, image, off), []);
  assert.equal(solveLettering(s, image, off).status, 'passed');
});

test('MCP workflow forwards physical-text evidence, blocks mismatches and retains approval gates', async () => {
  const store = await webtoonStore(); let mismatch = true;
  const p = provider({ response: (request, data) => {
    if (request.step === 'webtoon-plan') {
      const result = plan(data.source);
      result.sequences[0].shots[0].texts = [physical];
      return result;
    }
    if (request.step === 'webtoon-layout-analyze') {
      assert.match(data.textInstructions, /observedText/);
      return { maps: data.shots.map(i => ({ shotId: i.shot.id, inputHash: i.inputHash, inspectedImages: true,
        evidence: 'Synthetic fixture only', protected: [], entries: i.shot.texts.map((t, textIndex) => imageText(t)
          ? { textIndex, observedText: mismatch ? '틀린 연도' : t.text, surfaceBounds: [.2, .6, .6, .2], confidence: 1, reason: 'Fixture observation' }
          : { textIndex, anchor: [.5, .7], candidates: [[.5, .25]], confidence: 1, reason: 'Fixture mouth' }) })) };
    }
  } });
  const invoke = (name, args = {}) => runWebtoonTool({ store, toolName: `lore_webtoon_${name}`, args: { workId, ...args }, providers: p });
  const approve = r => invoke('decide', { workflowId: r.workflowId, approvalId: r.approvalId, action: 'approve' });
  const profile = await invoke('plan', { responses: answers, imageModel: 'gpt-image-2' });
  assert.equal(profile.textPolicyVersion, 1);
  const candidate = await approve(profile); assert.equal(candidate.approval.kind, 'plan');
  assert.match(JSON.parse(p.requests.find(r => r.step === 'webtoon-plan').messages.at(-1).content).textInstructions, /thought/);
  await approve(candidate);
  const workflowId = candidate.workflowId;
  const refs = await invoke('render', { workflowId });
  const path = join(store.rootDir, 'synthetic.png'); await writeFile(path, pixel);
  const refGate = await invoke('render', { workflowId, references: refs.jobs.map(j => ({ referenceId: j.referenceId, inputHash: j.inputHash, path })) });
  await approve(refGate);
  const jobs = await invoke('render', { workflowId });
  assert.match(jobs.jobs[0].prompt, /2021년 피해 구역/);
  const blocked = await invoke('render', { workflowId, assets: jobs.jobs.map(j => ({ shotId: j.shotId, inputHash: j.inputHash, path })) });
  assert.equal(blocked.status, 'layout_blocked');
  assert.ok(blocked.lettering.issues.some(i => i.code === 'PHYSICAL_TEXT_MISMATCH'));
  assert.equal(blocked.approval, null);
  // The fixture changes reported evidence, not an assertion about real images.
  mismatch = false;
  const look = await invoke('render', { workflowId, quality: 'preview', revisionTarget: { kind: 'lettering', shotIds: ['shot1', 'shot2'] }, feedback: 'Synthetic fixture evidence correction' });
  assert.equal(look.approval.kind, 'look');
  assert.equal(look.lettering.technicalStatus, 'passed');
  const saved = await new WebtoonStore(store).load(workflowId);
  assert.deepEqual(saved.lettering.shot1.candidates[0].items, []);
  assert.equal(saved.plan.sequences[0].shots[0].texts[0].text, physical.text);
});
