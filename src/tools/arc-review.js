import { runPatternAnalysis } from './story-experience.js';
import { createPublicationUnit } from '../core/publication-unit.js';
import { saveExperienceLedgerForHead } from '../core/experience-ledger.js';
import { resolveWorkKit } from '../prompts/index.js';

const MODEL = { provider: 'host', modelId: 'host-agent' };
export const MIN_ARC_REVIEW_DIMENSION = 60;

const DIMENSIONS = [
  'payoffCadence', 'patternVariety', 'moralChoiceVariety', 'emotionalTemperatureRange',
  'evidenceVariety', 'endingVariety', 'commercialMomentum',
];
const ACTIONABLE_DIMENSIONS = new Set(['payoffCadence', 'endingVariety', 'commercialMomentum']);
const TARGETED_CODES = new Set(['CHARACTER_ARC_RUSH', 'UNSUPPORTED_RELATIONSHIP_SHIFT', 'SOCIAL_CONSEQUENCE_RESET']);
const MIN_TARGETED_CONFIDENCE = 0.8;
const CHARACTER_OUTCOME_STATUSES = new Set(['resolved', 'complicated', 'dormant']);

function parse(raw) {
  try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
}

export function arcReviewCheckpoint(arcPlan, chapter) {
  const episode = arcPlan?.episodes?.find((item) => item.chapter === chapter);
  if (!episode) return null;
  const index = Number(episode.index);
  const total = Number(arcPlan.estimatedEpisodes) || arcPlan.episodes.length;
  if (index === total) return 'final';
  return index > 0 && index % 5 === 0 ? 'checkpoint' : null;
}

export async function runArcReview({ store, workId, arcPlan, chapter, prose, patternEntry, patternEntries, providers, kit: kitSource }) {
  const checkpoint = arcReviewCheckpoint(arcPlan, chapter);
  if (!checkpoint) return null;
  const priorSummaries = (await store.loadRecentChapterSummaries(workId, chapter, arcPlan.estimatedEpisodes ?? 20))
    .filter((item) => item.chapterNumber >= arcPlan.startChapter)
    .reverse();
  const priorPatterns = (patternEntries ?? await store.loadPatternLedger(workId))
    .filter((item) => item.chapter >= arcPlan.startChapter && item.chapter < chapter);
  const patterns = [...priorPatterns, patternEntry].filter(Boolean);
  const priorProse = typeof store.loadArtifact === 'function'
    ? (await Promise.all(priorSummaries.slice(-2).map(async (item) => {
      const artifact = await store.loadArtifact(workId, item.chapterNumber);
      return artifact?.prose ? { chapter: item.chapterNumber, prose: String(artifact.prose).slice(0, 14000) } : null;
    }))).filter(Boolean)
    : [];
  const kit = await resolveWorkKit({ store, workId, kit: kitSource });
  const response = await providers.complete({
    model: MODEL, jsonMode: true, step: 'arc-review',
    messages: kit.messages('arc-review', {
      arcNumber: arcPlan.arcNumber, arcTitle: arcPlan.title, checkpoint, chapter,
      promise: arcPlan.promise, minimumPayoff: arcPlan.readerContract?.minimumPayoff ?? '',
      characterArcsJson: JSON.stringify(arcPlan.characterArcs ?? []),
      priorSummariesJson: JSON.stringify(priorSummaries.map((item) => ({ chapter: item.chapterNumber, summary: item.summary }))),
      patternsJson: JSON.stringify(patterns),
      priorProseJson: JSON.stringify(priorProse),
      prose: String(prose).slice(0, 14000),
    }),
  });
  const obj = parse(response.text);
  const dimensions = obj?.dimensions && typeof obj.dimensions === 'object' ? obj.dimensions : {};
  const scores = DIMENSIONS.map((key) => Number(dimensions[key])).filter((score) => Number.isFinite(score) && score >= 0 && score <= 100);
  const score = scores.length === DIMENSIONS.length
    ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length)
    : null;
  const targetedApplicable = obj?.targetedReview?.applicable === true;
  const targetedFindings = targetedApplicable
    ? (Array.isArray(obj.targetedReview?.findings) ? obj.targetedReview.findings : []).flatMap((finding) => {
      const code = String(finding?.code ?? '');
      const message = String(finding?.message ?? '').trim();
      const evidence = String(finding?.evidence ?? '').trim();
      const confidence = Number(finding?.confidence);
      return TARGETED_CODES.has(code) && message && evidence && Number.isFinite(confidence)
        ? [{ code, message, evidence, confidence: Math.max(0, Math.min(1, confidence)) }]
        : [];
    }).slice(0, 6)
    : [];
  const plannedCharacterIds = new Set((arcPlan.characterArcs ?? []).map((arc) => arc.characterId));
  const characterOutcomes = checkpoint === 'final'
    ? (Array.isArray(obj?.characterOutcomes) ? obj.characterOutcomes : []).flatMap((outcome) => {
      const characterId = String(outcome?.characterId ?? '');
      const status = String(outcome?.status ?? '');
      const evidence = String(outcome?.evidence ?? '').trim();
      if (!plannedCharacterIds.has(characterId) || !CHARACTER_OUTCOME_STATUSES.has(status) || !evidence) return [];
      return [{
        characterId, status, evidence: evidence.slice(0, 800),
        remainingPressure: String(outcome?.remainingPressure ?? '').trim().slice(0, 800),
      }];
    }).slice(0, 2)
    : [];
  return {
    workId, arcNumber: arcPlan.arcNumber, chapter, checkpoint,
    score, reportedScore: typeof obj?.score === 'number' ? Math.round(obj.score) : null,
    dimensions,
    findings: (Array.isArray(obj?.findings) ? obj.findings : []).filter((item) => typeof item?.message === 'string').slice(0, 15),
    targetedReview: { applicable: targetedApplicable, findings: targetedFindings },
    characterOutcomes,
    reviewedAt: new Date().toISOString(),
  };
}

export function arcReviewAdvisories(review, chapter) {
  return (review?.targetedReview?.findings ?? [])
    .filter((finding) => Number(finding.confidence) >= MIN_TARGETED_CONFIDENCE)
    .map((finding) => ({
      severity: 'soft', advisoryOnly: true, chapterNumber: chapter,
      code: finding.code, confidence: finding.confidence,
      message: `${finding.message} (근거: ${finding.evidence})`,
    }));
}

export async function runStoredArcReview({ store, workId, throughChapter, providers }) {
  const kit = await resolveWorkKit({ store, workId });
  const arcPlan = await store.loadArcPlan(workId);
  if (!arcPlan) throw new Error('평가할 아크 계획이 없습니다.');
  const chapters = await store.listChapters();
  const lastArcChapter = arcPlan.episodes.at(-1)?.chapter;
  const chapter = Number(throughChapter) || Math.min(chapters.at(-1) ?? 0, lastArcChapter ?? 0);
  if (!arcReviewCheckpoint(arcPlan, chapter)) throw new Error('아크 리뷰는 5화 단위 체크포인트 또는 아크 종결화에서 실행하세요.');

  const refreshed = [];
  for (const episode of arcPlan.episodes.filter((item) => item.chapter <= chapter)) {
    const artifact = await store.loadArtifact(workId, episode.chapter);
    if (!artifact?.prose) throw new Error(`${episode.chapter}화 본문을 찾을 수 없습니다.`);
    refreshed.push(await runPatternAnalysis({ chapter: episode.chapter, prose: artifact.prose, providers, kit }));
    if ((providers.pending?.length ?? 0) > 0) {
      return {
        preview: true, operation: 'arc_review_pattern_backfill', chapter,
        patternChapter: episode.chapter,
      };
    }
  }
  const currentArtifact = await store.loadArtifact(workId, chapter);
  const review = await runArcReview({
    store, workId, arcPlan, chapter, prose: currentArtifact.prose,
    patternEntry: refreshed.find((entry) => entry.chapter === chapter), patternEntries: refreshed, providers, kit,
  });
  if ((providers.pending?.length ?? 0) > 0) return { preview: true, operation: 'arc_review_backfill', chapter };

  const existing = await store.loadPatternLedger(workId);
  const refreshedChapters = new Set(refreshed.map((entry) => entry.chapter));
  let sourceHead = 'legacy-working-tree';
  const entries = [...existing.filter((entry) => !refreshedChapters.has(entry.chapter)), ...refreshed];
  if (store.rootDir && typeof store.saveExperienceLedger === 'function') {
    const publication = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
    if (!publication.ok) throw new Error(`CORRUPT_PUBLICATION: ${publication.error.code}`);
    sourceHead = publication.value?.head ?? sourceHead;
    await saveExperienceLedgerForHead({ store, workId, sourceHead, entries, criticVersion: 'pattern-ledger-legacy' });
  } else {
    await store.savePatternLedger(workId, entries.sort((a, b) => a.chapter - b.chapter));
  }
  await store.saveArcReview(workId, { ...review, sourceHead });
  return { review, patterns: refreshed };
}

export function arcReviewViolations(review, chapter) {
  if (!review) return [];
  const findings = review.findings ?? [];
  return Object.entries(review.dimensions ?? {}).flatMap(([dimension, rawScore]) => {
    const score = Number(rawScore);
    if (!ACTIONABLE_DIMENSIONS.has(dimension) || !Number.isFinite(score) || score >= MIN_ARC_REVIEW_DIMENSION) return [];
    const finding = findings.find((item) => item.dimension === dimension && item.scope === 'current_chapter');
    if (!finding) return [];
    return [{ severity: 'soft', chapterNumber: chapter, code: finding.code, message: finding.message }];
  });
}
