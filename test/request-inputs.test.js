import test from 'node:test';
import assert from 'node:assert/strict';

import { runWriteWorkflow } from '../src/tools/workflow.js';
import { qualityStore, outputs, workId } from './fixtures/quality-workflow.js';
import { contractResponse } from './fixtures/contract-response.js';
import { SYNTHETIC_LONG_PROSE } from './fixtures/synthetic-prose.js';

/**
 * Guard for what each per-chapter model request carries in front of the prose:
 * text sections only (JSON belongs to the answer schema), the sections the
 * request is meant to judge from, and an upper bound on size so a section
 * that starts dumping a whole object shows up here first. Bounds are for the
 * chapter-one fixture with about 1.5x headroom over the measured size.
 */
const BOUNDS = {
  'story-profile-check': 1100, 'continuity-extract': 400, 'continuity-check': 800,
  'chapter-title': 100, 'chapter-summary': 100, 'narrative-boundary': 600,
  'coherence-judge': 100, 'editorial-quality': 200, 'character-fidelity': 900,
  'reader-hook': 2600, 'pattern-ledger': 200,
};
const SECTIONS = {
  'character-fidelity': [/윤재 \(`hero`\)/, /1화 EpisodePlan/],
  'reader-hook': [/1화 EpisodePlan/],
  'pattern-ledger': [/hero=윤재/],
  'narrative-boundary': [/아크 약속/, /1화 EpisodePlan/],
};
const ABSENT = {
  // The editorial review judges the reader's experience without the plan.
  'editorial-quality': [/EpisodePlan/],
};

async function requests() {
  const store = await qualityStore();
  const seen = [];
  await runWriteWorkflow({ store, workId, autonomy: 'auto', providers: { async complete(req) { seen.push(req); const contract = contractResponse(req); if (contract) return contract; return { text: outputs[req.step] ?? '{}' }; } } });
  return seen;
}

const userOf = (req) => req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');

test('every per-chapter request carries text sections of bounded size before the prose', async () => {
  const seen = await requests();
  const probe = SYNTHETIC_LONG_PROSE.slice(0, 40);
  for (const [step, bound] of Object.entries(BOUNDS)) {
    const req = seen.find((item) => item.step === step);
    assert.ok(req, `${step} was requested`);
    const user = userOf(req);
    const at = user.indexOf(probe);
    assert.ok(at >= 0, `${step} carries the prose`);
    assert.equal(user.split(probe).length - 1, 1, `${step} carries the prose once`);
    const input = user.slice(0, at);
    assert.doesNotMatch(input, /\{"|"[A-Za-z]+":/, `${step} has no JSON before the prose`);
    assert.ok(input.length <= bound, `${step}: ${input.length} > ${bound}`);
    for (const pattern of SECTIONS[step] ?? []) assert.match(input, pattern, `${step} section ${pattern}`);
    for (const pattern of ABSENT[step] ?? []) assert.doesNotMatch(user, pattern, `${step} leaves out ${pattern}`);
  }
});

test('the draft request has no JSON input besides the cast-manifest format it answers in', async () => {
  const seen = await requests();
  const user = userOf(seen.find((item) => item.step === 'draft')).replace(/⟦vle:cast-manifest[^⟧]*⟧/g, '');
  assert.doesNotMatch(user, /\{"|"[A-Za-z]+":/);
  assert.ok(user.length <= 3500, `draft: ${user.length}`);
});
