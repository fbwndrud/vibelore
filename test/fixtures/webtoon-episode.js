import { imagePolicyFor } from '../../src/core/webtoon-images.js';
import { pageBriefSchema } from '../../src/core/webtoon-episode.js';
import { ADAPTATION_REVIEW_CHECKS } from '../../src/core/webtoon-adaptation-review.js';
import { deriveRequestFingerprint } from '../../engine/src/core/request-fingerprint.js';
import { sceneSetup } from './webtoon-scene.js';

/** Plain adaptation fixtures for the episode path: one expand beat over all units, one page, three panels, one dialogue text. */
const clone = value => structuredClone(value);
const panelAt = (units, page, n, extra = {}) => ({ id: `p${page}-${n}`, beatIds: ['beat-1'], sourceIds: n === 3 ? units.slice(1).map(u => u.id) : [units[0].id],
  shows: '문 앞에 선 인물의 굳은 어깨', readerDelta: '망설임이 보인다', bridge: n === 1 ? 'page opener' : '앞 칸의 망설임이 손을 멈추게 한다',
  texts: n === 1 ? [{ id: `t${page}-1`, sourceId: units[0].id, kind: 'dialogue', speaker: 'c1', text: units[0].text }] : [], ...extra });

export const adaptationFor = (units, overrides = {}) => ({
  editorial: { version: 1, focus: { primary: '문 앞의 망설임', supporting: ['고요'], tradeoff: '설명을 덜고 표정을 남긴다' },
    beats: [{ id: 'beat-1', sourceIds: units.map(u => u.id), decision: 'expand', reason: '주된 경험', readerChange: '망설임을 느낀다',
      visualProof: '문 앞에서 멈춘 손', carryForward: '불필요: 이 쪽 안에서 전달' }] },
  extras: [], pageCountReason: '한 장면이라 한 쪽이면 충분하다',
  pages: [{ id: 'page-1', purpose: '망설임을 보여 준다', pageTurn: '문이 열린다', panels: [1, 2, 3].map(n => panelAt(units, 1, n)) }],
  ...overrides,
});

/** Last unit leaves the beat and the panels, so the editorial map no longer covers it. */
export function dropUnit(a) {
  const next = clone(a), last = next.editorial.beats[0].sourceIds.pop();
  for (const panel of next.pages.flatMap(p => p.panels)) panel.sourceIds = panel.sourceIds.filter(id => id !== last);
  return next;
}

/** Last unit becomes an omitted beat, and the third panel still draws it. */
export function omitDrawnBeat(a) {
  const next = clone(a), [beat] = next.editorial.beats, last = beat.sourceIds.pop();
  next.editorial.beats.push({ ...beat, id: 'beat-2', sourceIds: [last], decision: 'omit', visualProof: '' });
  Object.assign(next.pages[0].panels[2], { beatIds: ['beat-2'], sourceIds: [last] });
  return next;
}

export function withText(a, text) { const next = clone(a); next.pages[0].panels[0].texts[0].text = text; return next; }
export function withSpeaker(a, speaker) { const next = clone(a); next.pages[0].panels[0].texts[0].speaker = speaker; return next; }
export function withExtraSpeaker(a, id) {
  const next = withSpeaker(a, id); next.extras = [...(next.extras ?? []), { id, label: '이름 없는 기수', sourceIds: [next.pages[0].panels[0].sourceIds[0]] }];
  return next;
}

/** First page gets `n` panels, copies of its last one without texts. */
export function withPanels(a, n) {
  const next = clone(a), { panels } = next.pages[0];
  while (panels.length < n) panels.push({ ...clone(panels.at(-1)), id: `p1-${panels.length + 1}`, texts: [] });
  panels.length = n;
  return next;
}

/** First panel gets `n` dialogue texts copied from its first one. */
export function withTexts(a, n) {
  const next = clone(a), [panel] = next.pages[0].panels, [text] = panel.texts;
  panel.texts = Array.from({ length: n }, (_, i) => ({ ...text, id: `t1-${i + 1}` }));
  return next;
}

/** `n` pages, each a copy of the first with its own page, panel and text ids. */
export function withPages(a, n) {
  const next = clone(a), [page] = next.pages;
  next.pages = Array.from({ length: n }, (_, k) => ({ ...clone(page), id: `page-${k + 1}`, panels: page.panels.map((panel, i) => ({ ...clone(panel), id: `p${k + 1}-${i + 1}`,
    texts: panel.texts.map((t, j) => ({ ...t, id: `t${k + 1}-${i + 1}-${j + 1}` })) })) }));
  return next;
}

/** Minimal workflow object for adaptation review: source, units and a valid adaptation. */
export function reviewWorkflow(units, overrides = {}) {
  return { source: { hash: 'sha256:source', cast: [{ id: 'c1', name: '윤', appearance: '짧은 머리' }] }, units, adaptation: adaptationFor(units), adaptationReviewModel: null, ...overrides };
}

/** Episode workflow for page briefs and prompts: `n` pages with runtime state, one reference, an image policy and an adopted style. */
export function pageWorkflow(units, { pages = 2, passedThrough = 0, ...overrides } = {}) {
  const adaptation = withPages(adaptationFor(units), pages), image = id => ({ hash: `sha256:img-${id}`, path: `/${id}.png`, width: 1024, height: 1536 });
  return { source: { hash: 'sha256:source' }, units, adaptation, imagePolicy: imagePolicyFor('gpt-image-2.5-sunburst', 'openai-api'),
    references: [{ id: 'ref', path: '/ref.png', hash: 'sha256:ref', description: 'Character identity only.' }],
    styleSnapshot: { revisionId: 'sha256:style-1', profile: { style: 'Colored ink.' }, image: { path: '/style.png', hash: 'sha256:style' } },
    pages: adaptation.pages.map((p, i) => ({ id: p.id, image: image(p.id), tiles: [], ...(i < passedThrough ? { review: { passed: true } } : {}) })), ...overrides };
}

/** A filled page brief: every check passes, one short moment per panel with that panel's text ids; `over` patches the pieces a test cares about. */
export function briefFor(w, page, over = {}) {
  const s = pageBriefSchema(w, page);
  return { ...s, checks: s.checks.map(c => ({ ...c, passed: true, evidence: 'Visible in the panel.' })), findingItem: undefined,
    drawability: { passed: true, evidence: 'Synthetic fixture moments; no real image quality claim.' },
    renderBrief: { ...s.renderBrief, moments: s.renderBrief.moments.map((m, i) => ({ ...m, sourceIds: page.panels[i].sourceIds, action: `Panel ${i + 1}: she waits at the door.` })) }, ...over };
}

/** The same brief with the first two moments' text ids swapped. */
export function briefWithSwappedTexts(w, page) {
  const brief = briefFor(w, page), [a, b, ...rest] = brief.renderBrief.moments;
  return { ...brief, renderBrief: { ...brief.renderBrief, moments: [{ ...a, textIds: b.textIds }, { ...b, textIds: a.textIds }, ...rest] } };
}

/** Webtoon store with a confirmed API selection and one reference image, plus valid episode start args (no page count: the work cap applies). */
export async function episodeSetup(options) {
  const { store, repo, args: { panelCount, ...args } } = await sceneSetup(options);
  return { store, repo, args };
}

/** Host answer for `webtoon-adaptation`: one page of three panels; the speaker is the first cast member of the request, and the page-count reason follows the feedback so a revision differs. */
export const adaptationAnswer = d => withSpeaker(adaptationFor(d.source,
  { pageCountReason: d.feedback ? `피드백 반영: ${d.feedback.slice(0, 40)}` : '한 장면이라 한 쪽이면 충분하다' }), d.cast?.[0]?.id ?? 'narrator');

/** Host answer for `webtoon-adaptation-review` shaped from the request schema; `fail` fails readThrough and adds a blocking and an advisory finding. */
export function adaptationReviewAnswer(d, request, { fail = false } = {}) {
  const [panel] = d.scriptOnly.pages[0].panels;
  return { ...d.schema, findingItem: undefined, checks: Object.fromEntries(ADAPTATION_REVIEW_CHECKS.map(key => [key,
    key === 'readThrough' && fail ? { status: 'failed', panels: [panel.id], evidence: `Panel ${panel.id} has an action with no visible cause.` }
      : { status: 'passed', panels: [panel.id], evidence: `Panel ${panel.id} reads as intended.` }])),
    findings: [...(fail ? [{ severity: 'blocking', panels: [panel.id], evidence: `Panel ${panel.id}: show what makes her stop.` }] : []),
      { severity: 'advisory', panels: [panel.id], evidence: 'Minor polish: tighten the last bridge.' }],
    ...(d.schema.reviewerEvidence ? { reviewerEvidence: { modelId: request.model.modelId, responseId: 'fixture-response-1' } } : {}) };
}

/**
 * Fixture host for the episode path. `adaptationReview: 'fail'` fails every adaptation review. The page brief is left unanswered
 * (it is Task 7's), reported the way a relay would: through `pending`.
 */
export function provider({ adaptationReview } = {}) {
  const requests = [], pending = [];
  return { requests, pending, provenance: { kind: 'fixture', contextIsolation: 'unverified' }, async complete(request) {
    requests.push(request);
    const d = JSON.parse(request.messages.at(-1).content);
    if (request.step === 'webtoon-adaptation') return { text: JSON.stringify(adaptationAnswer(d)) };
    if (request.step === 'webtoon-adaptation-review') return { text: JSON.stringify(adaptationReviewAnswer(d, request, { fail: adaptationReview === 'fail' })) };
    pending.splice(0, pending.length, { id: deriveRequestFingerprint(request), step: request.step, jsonMode: true,
      system: request.messages[0].content, user: request.messages.at(-1).content });
    throw new Error(`PENDING_${request.step}`);
  } };
}
