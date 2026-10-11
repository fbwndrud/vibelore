import { createHash } from 'node:crypto';
import { gateApprovalActivation, approvalRepairFields } from './approval-language-gate.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const parse = text => { try { return JSON.parse(String(text).replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim()); } catch { return null; } };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = details => ({ ok: false, status: 'clean_fail', code: 'APPROVAL_REPAIR_INVALID', details });

/** Generated foundation only: one cited-field repair, meaning audit, then fresh proof. */
export async function validateGeneratedFoundation(args) {
  const first = await gateApprovalActivation(args);
  if (first.ok || first.code !== 'OUTPUT_LANGUAGE_MISMATCH') return first;
  const evidence = first.validation?.failureDetails?.evidence ?? [];
  const fields = approvalRepairFields(args.value, evidence);
  if (!fields.length || fields.length > 8) return first;
  const response = await args.providers.complete({ model: MODEL, step: 'foundation-language-repair', jsonMode: true,
    messages: [{ role: 'system', content: 'Translate only the supplied generated fields into the target language, preserving meaning. Do not change facts, quantities, names, IDs or add properties. Return JSON only: {"patches":[{"path":"exact allowed path","before":"exact entire original string","after":"minimal translation"}]}.' },
      { role: 'user', content: JSON.stringify({ language: args.resolution.language, fields, evidence }) }] });
  if ((args.providers.pending?.length ?? 0) > 0) return { ok: false, preview: true };
  const patches = parse(response.text)?.patches;
  if (!Array.isArray(patches) || !patches.length || patches.length > fields.length || patches.some(p => !p || typeof p.path !== 'string') || new Set(patches.map(p => p.path)).size !== patches.length)
    return fail({ reason: 'invalid_patches' });
  const repaired = structuredClone(args.value);
  for (const patch of patches) {
    if (!fields.some(f => f.path === patch.path && f.before === patch.before) || typeof patch.after !== 'string' || !patch.after.trim() || patch.after === patch.before
      || Object.keys(patch).some(key => !['path', 'before', 'after'].includes(key))) return fail({ reason: 'unauthorized_patch', patch });
    const segments = patch.path.split('.'); const last = segments.pop(); let parent = repaired;
    for (const segment of segments) parent = parent[segment];
    parent[last] = patch.after;
  }
  const verified = await args.providers.complete({ model: MODEL, step: 'foundation-language-repair-review', jsonMode: true,
    messages: [{ role: 'system', content: 'Compare each before/after pair against the original foundation. Approve only a translation with identical factual meaning. Changing abilities, quantities, requirements or source names is forbidden. Read every pair; do not infer approval from language fluency. JSON only: {"meaningPreserved":true,"evidence":[{"path":"exact patch path","before":"exact before","after":"exact after","reason":"specific semantic comparison"}]}.' },
      { role: 'user', content: JSON.stringify({ patches, foundation: args.value }) }] });
  if ((args.providers.pending?.length ?? 0) > 0) return { ok: false, preview: true };
  const decision = parse(verified.text);
  if (decision?.meaningPreserved !== true || !Array.isArray(decision.evidence) || decision.evidence.length !== patches.length
    || decision.evidence.some(e => !e || typeof e.path !== 'string') || new Set(decision.evidence.map(e => e.path)).size !== patches.length
    || !patches.every(p => decision.evidence.some(e => e.path === p.path && e.before === p.before && e.after === p.after && typeof e.reason === 'string' && e.reason.trim())))
    return fail({ reason: 'meaning_not_preserved_or_unproven', decision });
  // Separate state preserves the original failure across relay replay. A new artifact
  // cannot consume the original proof, or reset a pending repaired proof to the old hash.
  const result = await gateApprovalActivation({ ...args, value: repaired, stateKey: 'foundation-repaired' });
  if (!result.ok) return result;
  const repair = { beforeHash: hash(args.value), afterHash: hash(repaired), patches, meaningEvidence: decision.evidence };
  await args.store.saveApprovalValidation(args.workId, 'foundation-repaired', { ...result.validation, repair });
  return { ...result, value: repaired, repair };
}
