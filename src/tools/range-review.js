import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { requireLore } from '../../engine/src/lore/schemas.js';
import { openCanonRepository } from '../core/canon-repository.js';
import { createPublicationUnit } from '../core/publication-unit.js';
import { loadLoreRuntime } from '../core/lore-runtime.js';
import { tokenUnits } from '../core/token-units.js';
import { resolveWorkKit } from '../prompts/index.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
const MAX_PART_CHARS = 12000;
const MAX_CONTEXT_TOKENS = 12000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pending = providers => (providers.pending?.length ?? 0) > 0;
const parse = text => { try { return JSON.parse(String(text).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); } catch { return null; } };
const nonempty = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const active = value => ['active', 'completed'].includes(value?.status) ? value : null;
const planContent = value => {
  if (!value) return null;
  const { createdAt, updatedAt, approvedAt, stageReview, quality, ...content } = value;
  return content;
};
export const RANGE_REVIEW_FOCUS = Object.freeze(['reader-promise', 'causal-progression', 'character-continuity', 'world-continuity', 'pacing-and-payoff']);

function messages(kit, step, input) {
  const result = kit.messages(step, input);
  requireLore(tokenUnits(JSON.stringify(result)) <= MAX_CONTEXT_TOKENS, 'RANGE_REVIEW_CONTEXT_BUDGET',
    'review context exceeds budget; narrow approved design or the requested range');
  return result;
}

function validRefs(ids, allowed) {
  return Array.isArray(ids) && ids.length > 0 && ids.length <= 12 && new Set(ids).size === ids.length
    && ids.every(id => typeof id === 'string' && allowed.has(id));
}

function reportResponse(store, review, freshness = 'current') {
  const { design, arcs, notes, reductions, manifest, evidence, ...report } = review;
  const cited = new Set([...review.result.checks, ...review.result.findings, ...review.result.strengths].flatMap(item => item.evidenceIds));
  return { status: 'reviewed', review: { ...report, freshness, designBasis: design.basis,
    evidence: evidence.filter(item => cited.has(item.id)),
    reportPath: store.rootDir ? join(store.rootDir, '.vibelore', 'range-reviews', `${review.reviewId}.json`) : null } };
}

async function approvedDesign(store, workId, published, fromChapter, throughChapter) {
  const [profile, storySpine, currentArc] = await Promise.all([
    store.loadStoryProfile?.(workId), store.loadStorySpine?.(workId), store.loadArcPlan?.(workId),
  ]);
  const publishedPlans = published?.tree?.plans ?? {};
  const design = { basis: 'current-approved-plans',
    profile: planContent(active(profile) ?? active(publishedPlans.storyProfile)),
    storySpine: planContent(active(storySpine) ?? active(publishedPlans.storySpine)) };
  const arcs = [];
  const lastNumber = currentArc?.arcNumber ?? publishedPlans.arcPlan?.arcNumber ?? 0;
  requireLore(Number.isSafeInteger(lastNumber) && lastNumber >= 0 && lastNumber <= 1000, 'INVALID_RANGE_REVIEW_ARCS', 'invalid arc number');
  for (let number = 1; number <= lastNumber; number++) {
    const storedArc = number === currentArc?.arcNumber ? currentArc : await store.loadArcArchive?.(workId, number);
    const arc = active(storedArc) ?? (publishedPlans.arcPlan?.arcNumber === number ? active(publishedPlans.arcPlan) : null);
    if (arc?.episodes?.some(episode => episode.chapter >= fromChapter && episode.chapter <= throughChapter)) arcs.push(planContent(arc));
  }
  return { design, arcs };
}

async function currentBasis(store, workId, review) {
  const current = store.rootDir ? await createPublicationUnit({ rootDir: store.rootDir }).readPublished() : { ok: true, value: null };
  requireLore(current.ok, 'CORRUPT_PUBLICATION', current.error?.code ?? 'unknown');
  const { design, arcs } = await approvedDesign(store, workId, current.value, review.fromChapter, review.throughChapter);
  const foundation = current.value?.tree?.foundation ?? await store.loadFoundation?.(workId);
  const prose = [];
  for (let chapter = review.fromChapter; chapter <= review.throughChapter; chapter++) {
    const artifact = current.value ? current.value.tree.chapters?.[chapter] : await store.loadArtifact(workId, chapter);
    prose.push({ chapter, proseHash: hash(artifact?.prose ?? null) });
  }
  return { sourceHead: current.value?.head ?? 'legacy-working-tree', designHash: hash(design), arcsHash: hash(arcs),
    foundationHash: hash(foundation ?? null), proseDigest: hash(prose) };
}

/** Explicit advisory review: all selected canon prose is read, then evidence is synthesized. */
export async function runRangeReview({ store, workId, action = 'review', reviewId, fromChapter = 1, throughChapter, focus = '', providers }) {
  requireLore(['review', 'status'].includes(action), 'INVALID_RANGE_REVIEW_ACTION', action);
  if (action === 'status') {
    if (reviewId !== undefined) requireLore(typeof reviewId === 'string' && /^[a-f0-9]{64}$/.test(reviewId), 'INVALID_RANGE_REVIEW_ID', 'expected a review hash');
    const review = await store.loadRangeReview(workId, reviewId);
    if (!review) return { status: 'missing' };
    const current = await currentBasis(store, workId, review);
    return reportResponse(store, review, Object.keys(current).every(key => current[key] === review[key]) ? 'current' : 'stale');
  }
  requireLore(typeof focus === 'string' && focus.length <= 2000, 'INVALID_RANGE_REVIEW_FOCUS', 'focus must be at most 2000 characters');
  const canon = store.rootDir ? await openCanonRepository({ store, publicationUnit: createPublicationUnit({ rootDir: store.rootDir }) }) : store;
  const published = canon.publishedRevision;
  const chapters = await canon.listChapters();
  const end = throughChapter ?? chapters.at(-1);
  requireLore(Number.isSafeInteger(fromChapter) && fromChapter > 0 && Number.isSafeInteger(end) && end >= fromChapter && end - fromChapter < 1000,
    'INVALID_RANGE_REVIEW_RANGE', 'select a contiguous existing range of 1 to 1000 chapters');
  const selected = Array.from({ length: end - fromChapter + 1 }, (_, i) => fromChapter + i);
  requireLore(selected.every(chapter => chapters.includes(chapter)), 'RANGE_REVIEW_MISSING_CHAPTER', 'every selected chapter must exist');
  const kit = await resolveWorkKit({ store: canon, workId });
  const [foundation, { design, arcs }] = await Promise.all([
    canon.loadFoundation?.(workId), approvedDesign(store, workId, published, fromChapter, end),
  ]);
  const parts = [], manifest = [];
  for (const chapter of selected) {
    const artifact = await canon.loadArtifact(workId, chapter);
    requireLore(nonempty(artifact?.prose, Number.MAX_SAFE_INTEGER), 'RANGE_REVIEW_MISSING_PROSE', `${chapter}`);
    const runtime = published ? await loadLoreRuntime({ canonicalStore: canon, foundation, chapter, preferSealed: true }) : { foundation, productionLock: null };
    const arc = arcs.find(arc => arc.episodes.some(episode => episode.chapter === chapter)) ?? null;
    const chapterPlan = published?.tree?.plans?.episodePlans?.[chapter] ?? await store.loadEpisodePlan?.(workId, chapter);
    const context = { design, foundation: runtime.foundation, arcPlan: arc, episodePlan: planContent(active(chapterPlan)),
      worldInput: runtime.productionLock?.revisionId ?? null, focus };
    const proseHash = hash(artifact.prose);
    manifest.push({ chapter, proseHash, chars: artifact.prose.length, worldInput: context.worldInput, contextHash: hash(context) });
    for (let start = 0, part = 1; start < artifact.prose.length; part++) {
      let finish = Math.min(start + MAX_PART_CHARS, artifact.prose.length);
      // Preserve surrogate pairs so every original code unit is passed exactly once.
      if (finish < artifact.prose.length && /[\uD800-\uDBFF]/.test(artifact.prose[finish - 1])) finish--;
      const input = { chapter, part, start, end: finish, proseHash, context, prose: artifact.prose.slice(start, finish) };
      const requestMessages = messages(kit, 'range-review-read', input);
      parts.push({ input, requestMessages });
      start = finish;
    }
  }
  requireLore(parts.length <= 2000, 'RANGE_REVIEW_PART_BUDGET', 'select a smaller range (maximum 2000 prose parts)');
  const notes = [], evidence = [];
  const synthesisContext = { design, arcs, focus, range: { fromChapter, throughChapter: end }, focusCodes: RANGE_REVIEW_FOCUS };
  // Reject an oversized fixed design before spending any model reads on the manuscript.
  messages(kit, 'range-review-synthesis', { ...synthesisContext, notes: [] });
  for (const { input, requestMessages } of parts) {
    const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'range-review-read', messages: requestMessages });
    if (pending(providers)) return { preview: true, operation: 'range_review_read', chapter: input.chapter, part: input.part };
    const note = parse(response.text);
    requireLore(nonempty(note?.summary, 1500) && Array.isArray(note.evidence) && note.evidence.length > 0 && note.evidence.length <= 8,
      'INVALID_RANGE_REVIEW_READ', 'every prose part needs a summary and 1 to 8 actual quotes');
    const ids = [];
    for (const [index, item] of note.evidence.entries()) {
      requireLore(nonempty(item?.quote, 500) && input.prose.includes(item.quote) && nonempty(item.observation, 1000),
        'INVALID_RANGE_REVIEW_EVIDENCE', 'quote must appear in this exact prose part');
      const id = `chapter-${input.chapter}-part-${input.part}-evidence-${index + 1}`;
      evidence.push({ id, chapter: input.chapter, part: input.part, start: input.start, end: input.end, quote: item.quote, observation: item.observation });
      ids.push(id);
    }
    notes.push({ chapter: input.chapter, part: input.part, summary: note.summary, evidenceIds: ids,
      evidence: evidence.filter(item => ids.includes(item.id)) });
  }
  // Large ranges are synthesized from bounded groups; all original part notes remain in the receipt.
  let level = 0, synthesisNotes = notes;
  const reductions = [];
  while (tokenUnits(JSON.stringify(kit.messages('range-review-synthesis', { ...synthesisContext, notes: synthesisNotes }))) > MAX_CONTEXT_TOKENS) {
    const groups = []; let group = [];
    for (const note of synthesisNotes) {
      if (group.length && tokenUnits(JSON.stringify(kit.messages('range-review-merge', { focus, notes: [...group, note] }))) > MAX_CONTEXT_TOKENS) {
        groups.push(group); group = [];
      }
      group.push(note);
    }
    if (group.length) groups.push(group);
    requireLore(groups.length < synthesisNotes.length, 'RANGE_REVIEW_CONTEXT_BUDGET', 'approved design exceeds review budget; narrow the design or range');
    const merged = [];
    for (const [index, groupNotes] of groups.entries()) {
      const allowed = new Set(groupNotes.flatMap(note => note.evidenceIds));
      const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'range-review-merge',
        messages: messages(kit, 'range-review-merge', { focus, level, group: index + 1, notes: groupNotes }) });
      if (pending(providers)) return { preview: true, operation: 'range_review_merge', level, group: index + 1 };
      const value = parse(response.text);
      requireLore(nonempty(value?.summary, 2000) && validRefs(value.evidenceIds, allowed), 'INVALID_RANGE_REVIEW_MERGE', 'retain actual evidence ids in the synthesis');
      const result = { summary: value.summary, evidenceIds: value.evidenceIds,
        evidence: evidence.filter(item => value.evidenceIds.includes(item.id)) };
      merged.push(result); reductions.push({ level, group: index + 1, inputHash: hash(groupNotes), ...result });
    }
    synthesisNotes = merged; level++;
    requireLore(level <= 12, 'RANGE_REVIEW_CONTEXT_BUDGET', 'synthesis did not converge');
  }
  const synthesisInput = { ...synthesisContext, notes: synthesisNotes };
  const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'range-review-synthesis', messages: messages(kit, 'range-review-synthesis', synthesisInput) });
  if (pending(providers)) return { preview: true, operation: 'range_review_synthesis' };
  const result = parse(response.text);
  const allowed = new Set(synthesisNotes.flatMap(note => note.evidenceIds));
  requireLore(result && Array.isArray(result.checks) && result.checks.length === RANGE_REVIEW_FOCUS.length
    && RANGE_REVIEW_FOCUS.every(focus => result.checks.some(check => check.focus === focus && ['met', 'gap', 'not_applicable'].includes(check.result)
      && nonempty(check.reason, 2000) && (check.result === 'not_applicable' ? Array.isArray(check.evidenceIds) && check.evidenceIds.length === 0 : validRefs(check.evidenceIds, allowed))))
    && Array.isArray(result.findings) && result.findings.length <= 30 && result.findings.every(finding => nonempty(finding?.message, 2000)
      && ['advisory', 'upstream', 'research'].includes(finding.action) && validRefs(finding.evidenceIds, allowed))
    && Array.isArray(result.strengths) && result.strengths.length <= 20 && result.strengths.every(item => nonempty(item?.message, 2000) && validRefs(item.evidenceIds, allowed))
    && (!result.checks.some(check => check.result === 'gap') || result.findings.length > 0),
  'INVALID_RANGE_REVIEW_SYNTHESIS', 'all focuses and findings need preserved reading evidence');
  const sourceHead = published?.head ?? 'legacy-working-tree';
  const identity = { workId, sourceHead, fromChapter, throughChapter: end, focus, manifest, designHash: hash(design), arcsHash: hash(arcs),
    foundationHash: hash(foundation ?? null), proseDigest: hash(manifest.map(({ chapter, proseHash }) => ({ chapter, proseHash }))) };
  const review = { schemaVersion: 1, reviewId: hash({ identity, result, notes, reductions }), ...identity,
    advisoryOnly: true, status: 'reviewed', coverage: { mode: 'all-prose-parts', chapters: manifest.length,
      chars: manifest.reduce((total, row) => total + row.chars, 0), parts: parts.length, synthesisLevels: level },
    design, arcs, notes, evidence, reductions, result, reviewer: providers.provenance ?? { kind: 'host-model' },
    independence: 'not-established', reviewedAt: new Date().toISOString() };
  // Never label an old snapshot as the current HEAD after a concurrent publication.
  const current = await currentBasis(store, workId, review);
  requireLore(current.sourceHead === sourceHead, 'RANGE_REVIEW_HEAD_CHANGED', 'canon changed during review; restart against the new HEAD');
  requireLore(current.designHash === review.designHash && current.arcsHash === review.arcsHash,
    'RANGE_REVIEW_DESIGN_CHANGED', 'approved design changed during review; restart against the new design');
  requireLore(current.foundationHash === review.foundationHash && current.proseDigest === review.proseDigest,
    'RANGE_REVIEW_SOURCE_CHANGED', 'legacy source changed during review; restart against the new source');
  await store.saveRangeReview(workId, review);
  return reportResponse(store, review);
}
