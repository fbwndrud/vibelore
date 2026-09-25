/**
 * The approval language gate must classify every natural-language field that the
 * approval generators actually ask the model to write. The field names are derived
 * from the live prompt schemas (plugin steps and engine worldbuild/cast-design), so a
 * new generator field cannot silently turn a passing reviewer answer into
 * `unclassified_generated_field` again (2026-09-24 en/es acceptance: genderLabel).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVAL_LANGUAGE_FIELDS, gateApprovalActivation, projectApprovalValue } from '../src/core/approval-language-gate.js';
import { buildLanguageContract } from '../engine/src/core/language-policy.js';
import {
  APPROVAL_VALUE_HUMAN_TEXT_FIELDS, MACHINE_CONTRACT_FIELD_NAMES,
  canonicalApprovalArtifact, computeArtifactHash, evaluateLanguageCompliance,
} from '../engine/src/core/validation-contract.js';
import { FOUNDATION_LANGUAGE_FIELDS } from '../engine/src/generators/text/foundation-validation.js';
import { prepareBookFoundationCandidate } from '../engine/src/generators/text/steps/worldbuild.js';
import { normalizeStoryProfile } from '../src/tools/story-profile.js';
import * as koFamily from '../src/prompts/ko.js';
import * as multilingualFamily from '../src/prompts/multilingual.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownStateStore } from '../src/store/markdown-store.js';

const newStore = async () => new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'approval-fields-')));
function approvalProvider({ answer = null } = {}) {
  return { pending: [], async complete(request) {
    const input = JSON.parse(request.messages[1].content);
    return { text: answer ? answer(input) : JSON.stringify({ language: input.language, artifactHash: input.artifactHash, verdict: 'pass', evidence: [], allowedExceptions: [] }) };
  } };
}

/** Every parseable JSON object literal in a prompt (the schema examples). */
function schemaExamples(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0; let inString = false; let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { out.push(JSON.parse(text.slice(i, j + 1))); i = j; } catch { /* prose braces */ }
        break;
      }
    }
  }
  return out;
}

/** A model that fills every schema slot: enum alternatives pick the first value, blanks get prose. */
function fillSchema(value) {
  if (typeof value === 'string') {
    if (/^[\w-]+(\|[\w-]+)+$/.test(value)) return value.split('|')[0];
    return value.trim() ? value : 'Generated prose in the work language.';
  }
  if (Array.isArray(value)) return value.map(fillSchema);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillSchema(v)]));
  return value;
}

function unclassifiedPaths(kind, value, language) {
  const artifact = canonicalApprovalArtifact({ kind, revision: 1, value: projectApprovalValue(value) });
  try {
    evaluateLanguageCompliance({ artifact, workContract: buildLanguageContract({ language }), languageFields: APPROVAL_LANGUAGE_FIELDS,
      compliance: { language, artifactHash: computeArtifactHash(artifact), verdict: 'pass', evidence: [], allowedExceptions: [] } });
    return [];
  } catch (error) {
    return [...new Set((error.details?.fieldPaths ?? [`${error.code}: ${JSON.stringify(error.details)}`]).map(p => p.replace(/\[\d+\]/g, '[]')))];
  }
}

const promptContext = new Proxy({}, { get: (_, key) => (['worldFacts', 'characters', 'summaries'].includes(key) ? [] : key === 'count' ? 3 : '') });
const PLUGIN_APPROVAL_STEPS = Object.freeze({
  'story-profile': 'profile', 'story-spine': 'story', 'story-identity': 'story', 'pilot-contract': 'story',
  'writer-skill': 'writer', 'arc-plan': 'arc', 'episode-plan': 'episode',
});

for (const [family, kit, language] of [['multilingual', multilingualFamily, 'en'], ['ko', koFamily, 'ko']]) {
  for (const [step, kind] of Object.entries(PLUGIN_APPROVAL_STEPS)) {
    test(`${family} ${step} schema: every generated field is classified for the approval gate`, () => {
      const spec = kit.steps[step];
      const examples = schemaExamples([spec.system, spec.user(promptContext)].join('\n'));
      assert.ok(examples.length > 0, `${step} prompt has no JSON schema example`);
      let value = Object.assign({}, ...examples.map(fillSchema));
      if (kind === 'profile') value = normalizeStoryProfile(value);
      assert.deepEqual(unclassifiedPaths(kind, value, language), []);
    });
  }

  test(`${family} foundation (worldbuild + cast-design) schema: every generated field is classified`, async () => {
    const providers = { async complete(request) {
      const [schema] = schemaExamples(request.messages.at(-1).content);
      return { text: JSON.stringify(fillSchema(schema)) };
    } };
    const workContract = buildLanguageContract({ language });
    const { foundation } = await prepareBookFoundationCandidate({ workId: 'book', providers, model: {} }, {
      title: 'Harbor', brief: 'A harbor story', genre: 'other', targetChapters: 10, language, workContract,
      length: { unit: workContract.length.unit, target: workContract.length.target },
    });
    assert.ok(foundation.characters[0].intrinsic.genderLabel, 'the cast schema asks for genderLabel');
    // src/tools/generate.js strips engine-side design violations before the approval gate.
    const value = { ...foundation, characters: foundation.characters.map(({ designViolations, ...character }) => character) };
    assert.deepEqual(unclassifiedPaths('foundation', value, language), []);
  });
}

// The engine's own foundation gate list names cast-design prose the plugin gate must also know.
test('engine foundation language fields are all classified by the plugin approval gate', () => {
  const human = new Set([...APPROVAL_LANGUAGE_FIELDS.humanTextFields, ...APPROVAL_VALUE_HUMAN_TEXT_FIELDS]);
  // Not natural-language leaves of a plugin approval value: workContract internals are
  // hashed as engine configuration, and designViolations is stripped before the gate.
  const notApprovalLeaves = new Set(['designViolations', 'formatVersionSource', 'languageSource', 'lengthSource', 'unicode']);
  const missing = FOUNDATION_LANGUAGE_FIELDS.humanTextFields.filter(name => !human.has(name) && !notApprovalLeaves.has(name));
  assert.deepEqual(missing, []);
  assert.deepEqual(APPROVAL_LANGUAGE_FIELDS.humanTextFields.filter(name => MACHINE_CONTRACT_FIELD_NAMES.includes(name)), []);
});

// 2026-09-24 en/es acceptance: every reviewer answer passed but lore_create ended in
// clean_fail INCOMPLETE_LANGUAGE_EVIDENCE on characters[].intrinsic.genderLabel.
test('a cast-design genderLabel does not block a passing foundation review', async () => {
  const store = await newStore(); const providers = approvalProvider();
  const value = {
    title: 'The Harbor That Opened', language: 'en',
    worldFacts: [{ id: 'wf1', statement: 'The harbor closed after the storm.' }],
    characters: [{ id: 'c1', canonicalName: 'Mara Vale', contradiction: 'She wants help but calls it surrender.',
      intrinsic: { gender: 'custom', genderLabel: 'Keeper of the lamp; the harbor calls her neither', species: 'human', form: 'humanoid', ageBand: 'late thirties', birthOrder: 'eldest daughter', role: 'protagonist' } }],
  };
  const out = await gateApprovalActivation({ store, workId: 'book', kind: 'foundation', value, resolution: { implicitLegacy: false, contract: buildLanguageContract({ language: 'en' }) }, providers });
  assert.equal(out.ok, true, JSON.stringify(out.validation?.failureDetails ?? out.code));
});

// ageBand is free text in the work language ("early twenties", "20대초반"), not an enum.
// Only the engine default sentinel `unknown` is a machine value.
test('a generated ageBand is reviewed as work-language text; the unknown sentinel stays machine', async () => {
  assert.deepEqual(projectApprovalValue({ characters: [{ intrinsic: { ageBand: 'unknown' } }] }).characters[0].intrinsic.ageBand, { id: 'unknown' });
  assert.equal(projectApprovalValue({ characters: [{ intrinsic: { ageBand: '20대초반' } }] }).characters[0].intrinsic.ageBand, '20대초반');
  const store = await newStore();
  const providers = approvalProvider({ answer: input => JSON.stringify({ language: 'en', artifactHash: input.artifactHash, verdict: 'fail',
    evidence: [{ fieldPath: 'value.characters[0].intrinsic.ageBand', quote: '20대초반', reason: 'Korean, not English' }], allowedExceptions: [] }) });
  const value = { title: 'Harbor', language: 'en', worldFacts: [{ id: 'wf1', statement: 'The harbor closed.' }],
    characters: [{ id: 'c1', canonicalName: 'Mara', intrinsic: { gender: 'female', ageBand: '20대초반' } }] };
  const out = await gateApprovalActivation({ store, workId: 'book', kind: 'foundation', value, resolution: { implicitLegacy: false, contract: buildLanguageContract({ language: 'en' }) }, providers });
  assert.equal(out.ok, false);
  assert.equal(out.validation?.failureCode, 'OUTPUT_LANGUAGE_MISMATCH', JSON.stringify(out.validation?.failureDetails));
});
