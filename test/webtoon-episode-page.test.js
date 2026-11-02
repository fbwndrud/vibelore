import assert from 'node:assert/strict';
import test from 'node:test';
import { PAGE_BRIEF_CHECKS, PAGE_BRIEF_PROMPT, pageBriefBinding, pageBriefSchema, pageImagePrompt, pageTexts, pageView, previousPageState, validatePageBrief } from '../src/core/webtoon-episode.js';
import { letteringText } from '../src/core/webtoon-scene.js';
import { briefFor, briefWithSwappedTexts, pageWorkflow } from './fixtures/webtoon-episode.js';

const units = [{ id: 'u1', text: '"문 열어." 그녀가 말했다.' }, { id: 'u2', text: '대답은 없었다.' }, { id: 'u3', text: '손잡이가 차가웠다.' }];
const first = pageWorkflow(units, { pages: 3 }), page1 = first.adaptation.pages[0];
const second = pageWorkflow(units, { pages: 3, passedThrough: 1 }), page2 = second.adaptation.pages[1];
const withBrief = (w, page) => ({ ...w, pages: w.pages.map(p => p.id === page.id ? { ...p, brief: briefFor(w, page) } : p) });
const code = re => err => re.test(err.message);

test('page brief must keep panel order and texts', () => {
  assert.throws(() => validatePageBrief(briefWithSwappedTexts(first, page1), first, page1), /PAGE_BRIEF_ORDER/);
  assert.equal(validatePageBrief(briefFor(first, page1), first, page1), true);
});

test('pageView exposes the page as a scene: its panel count, cited units and texts', () => {
  const view = pageView(first, page1);
  assert.equal(view.panelCount, 3);
  assert.deepEqual(view.sceneUnits.map(u => u.id), ['u1', 'u2', 'u3']);
  assert.deepEqual(view.scenePlan.texts, pageTexts(page1));
  assert.equal(view.styleSnapshot, first.styleSnapshot);
  const narrow = structuredClone(first); narrow.adaptation.pages[0].panels.forEach(p => { p.sourceIds = ['u1']; });
  assert.deepEqual(pageView(narrow, narrow.adaptation.pages[0]).sceneUnits.map(u => u.id), ['u1']);
});

test('page brief needs exactly the three checks with evidence', () => {
  assert.deepEqual(PAGE_BRIEF_CHECKS, ['shows', 'bridge', 'visibleRelations']);
  const brief = briefFor(first, page1);
  assert.throws(() => validatePageBrief({ ...brief, checks: brief.checks.slice(1) }, first, page1), code(/INCOMPLETE_PAGE_BRIEF/));
  assert.throws(() => validatePageBrief({ ...brief, checks: brief.checks.map((c, i) => i ? c : { ...c, evidence: ' ' }) }, first, page1), code(/INCOMPLETE_PAGE_BRIEF/));
  assert.throws(() => validatePageBrief({ ...brief, checks: brief.checks.map((c, i) => i === 1 ? { ...c, id: 'shows' } : c) }, first, page1), code(/INCOMPLETE_PAGE_BRIEF/));
  assert.throws(() => validatePageBrief({ ...brief, findings: [{ severity: 'blocking', evidence: '' }] }, first, page1), code(/INVALID_PAGE_BRIEF_FINDING/));
});

test('a failed check, a blocking finding or failed drawability is false; an advisory finding is not', () => {
  const brief = briefFor(first, page1);
  assert.equal(validatePageBrief({ ...brief, checks: brief.checks.map((c, i) => i ? c : { ...c, passed: false }) }, first, page1), false);
  assert.equal(validatePageBrief({ ...brief, findings: [{ severity: 'blocking', evidence: '문이 그려질 수 없다' }] }, first, page1), false);
  assert.equal(validatePageBrief({ ...brief, findings: [{ severity: 'advisory', evidence: '여백이 많다' }] }, first, page1), true);
  assert.equal(validatePageBrief({ ...brief, drawability: { passed: false, evidence: '한 칸에 동작이 너무 많다' } }, first, page1), false);
  assert.throws(() => validatePageBrief({ ...brief, drawability: { passed: true, evidence: '' } }, first, page1), code(/PAGE_DRAWABILITY_REQUIRED/));
});

test('the scene render-brief limits apply to page moments', () => {
  const brief = briefFor(first, page1), long = Array(36).fill('door').join(' ');
  const moments = brief.renderBrief.moments.map((m, i) => i ? m : { ...m, action: long });
  assert.throws(() => validatePageBrief({ ...brief, renderBrief: { ...brief.renderBrief, moments } }, first, page1), code(/SCENE_RENDER_BRIEF_OVERLOADED/));
  assert.throws(() => validatePageBrief({ ...brief, renderBrief: { ...brief.renderBrief, moments: moments.slice(1) } }, first, page1), code(/SCENE_RENDER_BRIEF_OVERLOADED/));
  assert.throws(() => validatePageBrief({ ...brief, renderBrief: { ...brief.renderBrief, style: 'Painted watercolor.' } }, first, page1), code(/SCENE_STYLE_BRIEF_MISMATCH/));
});

test('stale binding after previous page changes', () => {
  const brief = briefFor(second, page2);
  assert.equal(validatePageBrief(brief, second, page2), true);
  assert.equal(brief.subjectHash, pageBriefBinding(second, page2));
  const redrawn = { ...second, pages: second.pages.map((p, i) => i ? p : { ...p, image: { ...p.image, hash: 'sha256:img-redrawn' } }) };
  assert.throws(() => validatePageBrief(brief, redrawn, page2), code(/STALE_PAGE_BRIEF/));
  const failed = { ...second, pages: second.pages.map((p, i) => i ? p : { ...p, review: { passed: false } }) };
  assert.throws(() => validatePageBrief(brief, failed, page2), code(/STALE_PAGE_BRIEF/));
});

test('stale binding after the page, references, policy or style change', () => {
  const brief = briefFor(first, page1);
  const edited = structuredClone(first); edited.adaptation.pages[0].panels[1].shows = '다른 그림';
  assert.throws(() => validatePageBrief(brief, edited, edited.adaptation.pages[0]), code(/STALE_PAGE_BRIEF/));
  assert.throws(() => validatePageBrief(brief, { ...first, references: [] }, page1), code(/STALE_PAGE_BRIEF/));
  assert.throws(() => validatePageBrief(brief, { ...first, imagePolicy: { ...first.imagePolicy, model: 'other' } }, page1), code(/STALE_PAGE_BRIEF/));
  assert.throws(() => validatePageBrief(brief, { ...first, styleSnapshot: { ...first.styleSnapshot, revisionId: 'sha256:style-2' } }, page1), code(/STALE_PAGE_BRIEF/));
  assert.throws(() => validatePageBrief({ ...brief, subjectHash: undefined }, first, page1), code(/STALE_PAGE_BRIEF/));
});

test('previousPageState is the previous page only after it passed', () => {
  assert.equal(previousPageState(first, page1), null);
  assert.equal(previousPageState(first, first.adaptation.pages[1]), null);
  assert.equal(previousPageState(second, page2), second.pages[0]);
  assert.equal(previousPageState(second, second.adaptation.pages[2]), null);
  assert.equal(pageBriefBinding(first, page1), pageBriefBinding({ ...first, pages: [] }, page1));
});

test('pageBriefSchema is a skeleton bound to the page with one moment per panel', () => {
  const s = pageBriefSchema(second, page2);
  assert.equal(s.subjectHash, pageBriefBinding(second, page2));
  assert.deepEqual(s.checks.map(c => c.id), PAGE_BRIEF_CHECKS);
  assert.deepEqual(s.renderBrief.moments.map(m => m.textIds), page2.panels.map(p => p.texts.map(t => t.id)));
  assert.equal(s.renderBrief.style, 'Colored ink.');
  assert.match(PAGE_BRIEF_PROMPT, /exactly one moment per panel/);
});

test('page prompt opens with the page position and panel count', () => {
  const w = withBrief(first, page1), prompt = pageImagePrompt(w, page1, 2, 3);
  assert.match(prompt, /^Page 2 of 3 of one webtoon episode\. Draw EXACTLY 3 panels\. Choose panel sizes, layout and camera angles\. Each panel shows one clear moment\.\n/);
  assert.match(prompt, new RegExp(JSON.stringify(letteringText(page1.panels[0].texts[0].text)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /^Style: Colored ink\.$/m);
  assert.match(prompt, /^1\. Panel 1: she waits at the door\.\n   dialogue, c1: /m);
  assert.match(prompt, /^3\. Panel 3: she waits at the door\.$/m);
  assert.match(prompt, /All quoted text is in Korean/);
  assert.match(prompt, /exactly 3, no inset or split panels/);
});

test('page prompt attaches the previous page only after it passed', () => {
  const line = 'The last image is the previous page of this episode: continue its identities, clothing and setting, not its events or layout.';
  assert.ok(pageImagePrompt(withBrief(second, page2), page2, 2, 3).includes(line));
  assert.equal(pageImagePrompt(withBrief(first, page1), page1, 1, 3).includes('previous page'), false);
  const failed = withBrief({ ...second, pages: second.pages.map((p, i) => i ? p : { ...p, review: { passed: false } }) }, page2);
  assert.equal(pageImagePrompt(failed, page2, 2, 3).includes('previous page'), false);
});

test('page prompt needs the approved brief', () => {
  assert.throws(() => pageImagePrompt(first, page1, 1, 3), code(/SCENE_RENDER_BRIEF_REQUIRED/));
});
