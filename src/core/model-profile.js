/**
 * Model profile -- per-stage model routing for `lore_write`.
 *
 * vibelore never calls a model API with its own key. Under the host relay
 * every model request is handed back to the host agent, so "which model" is
 * a *hint* the host may honor (for example by delegating the request to a
 * sub-agent on that model). The local OpenAI-compatible provider honors the
 * hint directly when the profile names provider `local`.
 *
 * Stages, in the order a chapter moves through them:
 *   identity  -- story identity, pilot contract, world/cast foundation
 *   planning  -- profile, spine, arc and episode planning
 *   draft     -- prose generation and revision
 *   quality   -- continuity, coherence, editorial and reader reviews
 *   final     -- boundary decision, summary and commit-time extraction
 *
 * Resolution order for a step:
 *   1. the stage's explicit entry
 *   2. `light` for planning / draft / quality, when given
 *   3. `default`
 *   4. nothing -- the request is left exactly as the tool built it
 *
 * When the profile is empty the wrapper is a no-op, so existing behavior and
 * request fingerprints are unchanged.
 */

export const MODEL_STAGES = ['identity', 'planning', 'draft', 'quality', 'final'];
export const LIGHT_STAGES = new Set(['planning', 'draft', 'quality']);
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const STEP_STAGE = {
  'story-identity': 'identity', 'pilot-contract': 'identity', worldbuild: 'identity',
  'cast-design': 'identity', 'entity-seed': 'identity', 'revise-foundation': 'identity',
  'story-profile': 'planning', 'story-profile-check': 'planning', 'story-spine': 'planning',
  'story-spine-quality': 'planning', 'writer-skill': 'planning', 'writer-skill-audition': 'planning',
  'arc-plan': 'planning', 'arc-quality': 'planning', 'next-arc-proposal': 'planning',
  'era-research': 'planning', 'episode-plan': 'planning', 'chapter-plan': 'planning',
  draft: 'draft', revise: 'draft', rewrite: 'draft', 'sentinel-repair': 'draft',
  'continuity-check': 'quality', 'continuity-extract': 'quality', 'continuity-extract-repair': 'quality',
  'coherence-judge': 'quality', 'editorial-quality': 'quality', 'character-fidelity': 'quality',
  'reader-hook': 'quality', 'pattern-ledger': 'quality', 'arc-review': 'quality',
  'narrative-boundary': 'final', 'chapter-summary': 'final',
  'influence-observation-repair': 'final', 'influence-observation-repair-retry': 'final',
};

/** Map a provider request step name to a routing stage. Unknown steps use `default`. */
export function stageForStep(step) {
  if (typeof step !== 'string') return null;
  if (STEP_STAGE[step]) return STEP_STAGE[step];
  const head = step.split(/[-:]/)[0];
  return STEP_STAGE[head] ?? null;
}

function normalizeEffort(value) {
  if (typeof value !== 'string') return null;
  const effort = value.trim().toLowerCase();
  return REASONING_EFFORTS.includes(effort) ? effort : null;
}

function cleanId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  return /^[A-Za-z0-9._:/-]{1,120}$/.test(id) ? id : '';
}

/**
 * Normalize one profile entry. Accepts `"model-id"` or
 * `{ provider?, modelId | model, reasoningEffort | reasoning }`.
 * Returns null for anything unusable; an entry with only a reasoning effort
 * is kept so a stage can raise or lower effort on the inherited model.
 */
export function normalizeModelEntry(value) {
  if (typeof value === 'string') {
    const modelId = cleanId(value);
    return modelId ? { provider: 'host', modelId } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const provider = cleanId(value.provider) || 'host';
  const modelId = cleanId(value.modelId ?? value.model);
  const reasoningEffort = normalizeEffort(value.reasoningEffort ?? value.reasoning);
  if (!modelId && !reasoningEffort) return null;
  return {
    ...(modelId ? { provider, modelId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/** Normalize a whole profile. Returns null when nothing usable was given. */
export function normalizeModelProfile(input) {
  if (typeof input === 'string') input = { default: input };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const key of ['default', 'light', ...MODEL_STAGES]) {
    const entry = normalizeModelEntry(input[key]);
    if (entry) out[key] = entry;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Resolve the model for a step. Returns `{ provider, modelId, reasoningEffort?, stage }`
 * or null when the profile says nothing about this step.
 */
export function resolveModel(profile, step) {
  if (!profile) return null;
  const stage = stageForStep(step);
  const base = profile.default ?? null;
  const light = stage && LIGHT_STAGES.has(stage) ? profile.light ?? null : null;
  const explicit = stage ? profile[stage] ?? null : null;
  const layers = [base, light, explicit].filter(Boolean);
  if (!layers.length) return null;
  const merged = {};
  for (const layer of layers) {
    if (layer.modelId) { merged.provider = layer.provider; merged.modelId = layer.modelId; }
    if (layer.reasoningEffort) merged.reasoningEffort = layer.reasoningEffort;
  }
  if (!merged.modelId) return null;
  return { ...merged, stage: stage ?? 'default' };
}

/**
 * Wrap a provider so every `complete()` carries the resolved model for its
 * step. A null profile returns the provider untouched.
 */
export function withModelProfile(providers, profile) {
  const normalized = normalizeModelProfile(profile);
  if (!normalized || !providers || typeof providers.complete !== 'function') return providers;
  return Object.create(providers, {
    modelProfile: { value: normalized, enumerable: true },
    complete: {
      value(req) {
        const resolved = resolveModel(normalized, req?.step);
        if (!resolved) return providers.complete(req);
        const { stage, ...model } = resolved;
        return providers.complete({ ...req, model, stage });
      },
    },
  });
}
