import { nonempty } from './webtoon-contract.js';
import { validateCompositionLabel } from './webtoon-composition.js';
import { castIdsOf } from './webtoon-scene.js';

export const SCENE_IMAGE_REVIEW_VERSION = 2;
export const SCENE_VISUAL_CHECKS = ['reflectionGeometry', 'propStructure', 'handsAndContact', 'withinSceneContinuity', 'layoutAndTiming'];

export const SCENE_IMAGE_REVIEW_PROMPT = `Open every attached scene and reference image. Inspect the actual pixels before comparing them with the intended brief. Report observed facts, not a paraphrase of the prompt. Count all visible panels, including insets. Transcribe each visible text exactly in its drawn script and identify its speaker through visible balloon placement and tails.
For each visualChecks entry, give status passed, failed, uncertain or not_applicable, the actual one-based panel numbers, and concrete visible evidence. First state what is drawn, then explain whether it meets a source/brief/user requirement. Use uncertain when a required relation cannot be established; never infer it passed from the intended pose. Use not_applicable with a reason for absent or legitimately offscreen details that the scene does not require. Do not require every prop or limb in every panel.
reflectionGeometry: when a reflection is shown, compare the real and reflected head orientation, gaze, collar/hand positions and held object separately. Check that the viewing angle can depict the same person and that real and reflected objects remain distinguishable. Ordinary occlusion is not itself a defect; unobservable required correspondence is uncertain. Avoid invented optical measurements.
propStructure: distinguish each object's body, lid, hinge or stand; inspect silhouette, support, tabletop/floor contact and occlusion. Name any fused parts or unsupported structure and its panel.
handsAndContact: identify who holds each object, the visible grip and wrist, hand count and actual contact. Check whether a hand accidentally merges with a prop or performs an action absent from the source.
withinSceneContinuity: compare named visible details in at least two panels when their continuity matters: identity, clothes, object location, scale, facing and hand use. Respect viewpoint changes and ordinary cropping; explain missing evidence rather than asserting a match.
layoutAndTiming: describe the actual panel hierarchy, reading path and any expressly requested pause. Locate the gap and compare its visible size to the requested reference, such as a face height. A thin divider is not a broad reading pause.
Inspect character-specific expressions and body acting against the source and selected brief. Keep style preference advisory, not a reason for automatic redraw. For previousScene, open its image and compare identity/clothing, setting/props and action transition with concrete evidence. Prior findings and the user feedback identify things to inspect, not a verdict to copy. Clearly report missing/invented actions. Set inspectedImages=false if images cannot be opened. Do not claim an independent human evaluation. Keep findings visible; no silent regeneration.`;

export function sceneVisualCheckSchema() {
  return Object.fromEntries(SCENE_VISUAL_CHECKS.map(key => [key, {
    status: 'passed|failed|uncertain|not_applicable', panels: [], evidence: '',
  }]));
}

/** Attach actual reference bytes, preserving every role even when two roles use identical pixels. */
export function sceneReviewInputs(w) {
  const images = [], referenceImages = [], indices = new Map();
  const add = (asset, id, description, distinct = false) => {
    if (!asset?.path) return;
    const key = asset.hash ?? asset.path;
    if (distinct || !indices.has(key)) {
      images.push({ path: asset.path, ...(asset.mime ? { mime: asset.mime } : {}) });
      indices.set(key, images.length);
    }
    referenceImages.push({ id, imageIndex: indices.get(key), description });
  };
  add(w.sceneImage, 'current-scene', 'The generated scene being inspected.', true);
  add(w.previousScene?.image, 'previous-scene', 'The previous scene for continuity comparison.', true);
  add(w.styleSnapshot?.image, 'adopted-style', 'User-adopted visual treatment; not a source of new story facts.', true);
  for (const ref of w.sceneReferences) {
    if (!['previous-scene', 'adopted-style'].includes(ref.id)) add(ref, ref.id, ref.description);
  }
  return { images, referenceImages };
}

/** A broad aggregate pass cannot hide a failed or unobservable required visual relationship. */
export function validateSceneVisualChecks(checks, panelCount) {
  const statuses = ['passed', 'failed', 'uncertain', 'not_applicable'];
  for (const key of SCENE_VISUAL_CHECKS) {
    const c = checks?.[key];
    if (!statuses.includes(c?.status) || !nonempty(c.evidence) || !Array.isArray(c.panels)
      || c.panels.some(p => !Number.isInteger(p) || p < 1 || p > panelCount)
      || (c.status !== 'not_applicable' && !c.panels.length)) {
      throw new Error(`INCOMPLETE_SCENE_VISUAL_REVIEW: ${key}`);
    }
  }
  return SCENE_VISUAL_CHECKS.every(key => ['passed', 'not_applicable'].includes(checks[key].status));
}

export const COMPOSITION_CHECK_SENTENCE = 'For compositionCheck, compare each panel to its planned composition label; report differs with the observed label only when visible evidence shows it, and unclear when it cannot be seen.';

/** A completed scene from before composition labels, reviewed once to record what was drawn (set by the backfill action). */
const isBackfill = w => w.compositionBackfill === true;
/** Composition is asked for only by workflows that carry a composition version or are being backfilled; older workflows keep their review bytes. */
export const compositionCheckActive = w => Boolean(w.compositionVersion) || isBackfill(w);

/** The review prompt, with the composition sentence appended only when the check is asked for. */
export const sceneImageReviewPrompt = w => compositionCheckActive(w) ? `${SCENE_IMAGE_REVIEW_PROMPT}\n${COMPOSITION_CHECK_SENTENCE}` : SCENE_IMAGE_REVIEW_PROMPT;

/** One placeholder entry per panel the image must show; the count is the panel count resolved for this revision. */
export function compositionCheckSchema(w) {
  const result = isBackfill(w) ? 'observed|unclear' : 'match|differs|unclear';
  return Array.from({ length: w.panelCount }, (_, i) => ({ panel: i + 1, result, observed: null, evidence: '' }));
}

/** Throws INCOMPLETE_SCENE_COMPOSITION_REVIEW unless the check has one well-formed entry per panel; it never affects the verdict. */
export function validateCompositionCheck(check, w) {
  const fail = detail => { throw new Error(`INCOMPLETE_SCENE_COMPOSITION_REVIEW: ${detail}`); };
  if (!Array.isArray(check) || check.length !== w.panelCount) fail(`exactly one entry per panel (${w.panelCount}) is required`);
  const results = isBackfill(w) ? ['observed', 'unclear'] : ['match', 'differs', 'unclear'];
  const carriesLabel = result => result === 'differs' || result === 'observed';
  const castIds = castIdsOf(w.source?.cast);
  check.forEach((e, i) => {
    if (e?.panel !== i + 1) fail(`entry ${i + 1} must be for panel ${i + 1}`);
    if (!results.includes(e.result)) fail(`panel ${e.panel} result must be ${results.join(', ')}`);
    if (!nonempty(e.evidence)) fail(`panel ${e.panel} needs evidence`);
    if (!carriesLabel(e.result)) {
      if (e.observed !== null && e.observed !== undefined) fail(`panel ${e.panel} must not carry an observed label`);
      return;
    }
    try { validateCompositionLabel(e.observed, { castIds }); }
    catch (err) { fail(`panel ${e.panel} observed label: ${err.message}`); }
  });
}

/** The label each panel ends with: the plan when it matched, the observation when it differs, the plan flagged unclear otherwise. */
export function finalCompositionLabels(w) {
  const check = w.visualReview?.compositionCheck;
  if (!Array.isArray(check)) return [];
  const planned = n => w.preflight?.renderBrief?.moments?.[n - 1]?.composition ?? null;
  return check.map(({ panel, result, observed }) => {
    if (result === 'differs') return { panel, label: observed, source: 'review-corrected', confidence: 'clear' };
    if (result === 'observed') return { panel, label: observed, source: 'observed-backfill', confidence: 'clear' };
    if (isBackfill(w)) return { panel, label: null, source: 'observed-backfill', confidence: 'unclear' };
    return { panel, label: planned(panel), source: 'plan', confidence: result === 'match' ? 'clear' : 'unclear' };
  });
}
