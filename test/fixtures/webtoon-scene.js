import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { webtoonStore, workId, pixel } from './webtoon.js';
import { WebtoonStore, atomicWrite } from '../../src/store/webtoon-store.js';
import { imagePolicyFor } from '../../src/core/webtoon-images.js';
import { digest } from '../../src/core/webtoon-contract.js';
import { SCENE_CHECKS } from '../../src/core/webtoon-scene.js';

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
    renderBrief: { style: 'Colored ink.', moments: Array.from({ length: d.panelCount }, (_, i) => ({ sourceIds: [d.source[0].id], action: 'She waits at the door.', textIds: i === 0 ? d.plan.texts.map(t => t.id) : [] })) } };
}

/** Webtoon store with a confirmed API selection and one reference image, plus valid start args. */
export async function sceneSetup({ language, prose } = {}) {
  const store = await webtoonStore({ language, prose }), repo = new WebtoonStore(store);
  const policy = imagePolicyFor('gpt-image-2.5-sunburst', 'openai-api');
  await atomicWrite(repo.path('image-selection.json'), JSON.stringify({ workId, policy, selection: { id: 'selected-api', workId, policyHash: digest(policy) } }));
  const path = join(store.rootDir, 'ref.png'); await writeFile(path, pixel);
  return { store, repo, args: { workId, action: 'start', panelCount: 6, sourceChapters: [1], direction: 'Full color comic. Original Korean lettering. AI chooses layout.', references: [{ id: 'ref', path, hash: digest(pixel), description: 'Character identity only.' }] } };
}
