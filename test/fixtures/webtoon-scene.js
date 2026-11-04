import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { webtoonStore, workId, pixel } from './webtoon.js';
import { WebtoonStore, atomicWrite } from '../../src/store/webtoon-store.js';
import { imagePolicyFor } from '../../src/core/webtoon-images.js';
import { digest } from '../../src/core/webtoon-contract.js';
import { SCENE_CHECKS } from '../../src/core/webtoon-scene.js';
import { SCENE_VISUAL_CHECKS } from '../../src/core/webtoon-scene-review.js';

/** Protocol-only fixture, never evidence of visual quality. */
export const sceneVisualChecks = () => Object.fromEntries(SCENE_VISUAL_CHECKS.map(key => [key, {
  status: 'not_applicable', panels: [], evidence: 'Synthetic protocol fixture; no real geometry is being evaluated.',
}]));

/** One-beat scene brief bound to the fixture chapter; `panelCount` is only added when a caller asks for auto mode. */
export function scenePlan(source, panelCount) {
  return { title: '문 앞', intent: 'A person waits outside a door.', facts: [{ id: 'fact-1', sourceIds: [source[0].id], statement: 'The person is outside a closed door.' }],
    staging: 'The door separates outside from inside. Let the artist choose cameras.', uncertainties: [],
    beats: [{ id: 'beat-1', sourceIds: source.map(u => u.id), action: 'She stops and speaks into the room.', textIds: ['text-1'] }],
    texts: [{ id: 'text-1', sourceId: source[0].id, kind: 'caption', speaker: 'narrator', text: source[0].text }],
    ...(panelCount === undefined ? {} : { panelCount }) };
}

/** Preflight answer shaped from the request data `d`; the render brief always has exactly the resolved panel count. */
export function scenePreflight(d, blocking = false) {
  return { ...d.schema, checks: SCENE_CHECKS.map(name => ({ name, passed: !blocking, evidence: 'Grounded in source units and the door boundary.' })),
    drawability: { passed: true, evidence: 'Synthetic fixture moments; no real image quality claim.' },
    renderBrief: { style: 'Colored ink.', ...(d.schema.renderBrief?.pageComposition ? { pageComposition: { layout: 'strip-stack' } } : {}),
      moments: Array.from({ length: d.panelCount }, (_, i) => ({ sourceIds: [d.source[0].id], action: 'She waits at the door.', textIds: i === 0 ? d.plan.texts.map(t => t.id) : [],
        ...(d.schema.renderBrief?.moments?.[0]?.composition ? { composition: sceneComposition() } : {}) })) } };
}

/** Valid label with no directed moment and no cast subject, for requests whose schema asks for composition. */
export const sceneComposition = () => ({ shot: 'MS', angle: 'eye', focal: 'space', background: 'detailed', subjects: [], directed: false });

/** Review answer fields for a composition check: every panel matches its plan. Empty when the request carries no composition check. */
export const sceneCompositionCheck = schema => Array.isArray(schema) ? { compositionCheck: schema.map(e => ({ panel: e.panel, result: 'match', observed: null, evidence: 'Synthetic protocol fixture; framing matches the plan.' })) } : {};

/** Webtoon store with a confirmed API selection and one reference image, plus valid start args. */
export async function sceneSetup({ language, prose } = {}) {
  const store = await webtoonStore({ language, prose }), repo = new WebtoonStore(store);
  const policy = imagePolicyFor('gpt-image-2.5-sunburst', 'openai-api');
  await atomicWrite(repo.path('image-selection.json'), JSON.stringify({ workId, policy, selection: { id: 'selected-api', workId, policyHash: digest(policy) } }));
  const path = join(store.rootDir, 'ref.png'); await writeFile(path, pixel);
  return { store, repo, args: { workId, action: 'start', panelCount: 6, sourceChapters: [1], direction: 'Full color comic. Original Korean lettering. AI chooses layout.', references: [{ id: 'ref', path, hash: digest(pixel), description: 'Character identity only.' }] } };
}
