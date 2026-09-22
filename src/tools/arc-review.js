import { runPatternAnalysis } from './story-experience.js';
import { createPublicationUnit } from '../core/publication-unit.js';
import { saveExperienceLedgerForHead } from '../core/experience-ledger.js';

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

export async function runArcReview({ store, workId, arcPlan, chapter, prose, patternEntry, patternEntries, providers }) {
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
  const response = await providers.complete({
    model: MODEL, jsonMode: true, step: 'arc-review',
    messages: [
      { role: 'system', content: '당신은 한국 상업 웹소설의 아크 단위 편집자다. 개별 화의 문장 완성도가 아니라 여러 화를 연속으로 읽을 때의 보상 간격, 선택과 장면의 기능적 반복, 감정 온도 변화, 증거와 결말 이미지의 다양성, 다음 결제를 만드는 추진력을 평가한다. PatternLedger의 표현이 달라도 기능이 같으면 반복으로 본다. 반대로 장르의 핵심 쾌감이 반복되더라도 방법·대가·관계 결과가 달라지면 변주로 인정한다. 관계 점검은 별도의 조건부 관찰이다. 표본 안에 명시적인 관계·말투 변화가 있거나 한 인물이 다른 인물의 안전·지위·신뢰를 크게 훼손한 사건이 있을 때만 applicable=true로 평가한다. 해당 사건이 없으면 관계 문제를 만들지 않으며, 조건부 관찰은 일곱 평균 점수에 섞지 않는다. 순수 JSON만 출력한다.' },
      { role: 'user', content: [
        `아크: ${arcPlan.arcNumber} / ${arcPlan.title}`, `체크포인트: ${checkpoint} / ${chapter}화`,
        `아크 독자 약속: ${arcPlan.promise}`, `최소 지급 약속: ${arcPlan.readerContract?.minimumPayoff ?? ''}`,
        `개인 아크 약속과 과거 근거: ${JSON.stringify(arcPlan.characterArcs ?? [])}`,
        '', '이전 화 요약:', JSON.stringify(priorSummaries.map((item) => ({ chapter: item.chapterNumber, summary: item.summary }))),
        '', '정규화된 PatternLedger:', JSON.stringify(patterns), '',
        '관계 인과 표본(직전 최대 2화 원문):', JSON.stringify(priorProse), '', '현재 화 본문:', String(prose).slice(0, 14000), '',
        '각 dimensions를 0~100으로 채점한다. findings는 누적 진단인지, 현재 화를 고치면 개선 가능한지를 scope로 구분한다.',
        'targetedReview는 단계 진행의 행동 근거와 중대한 관계 사건 뒤 태도·책임·거리 변화가 후속 장면에 남는지만 본다.',
        'final 체크포인트에서만 characterOutcomes를 채운다. 계획된 개인 아크 인물만 평가하며, resolved는 약속의 변화가 비용 있는 행동으로 증명됨, complicated는 변화와 반작용이 모두 남음, dormant는 약속을 판단할 행동 증거가 부족함이다. evidence에는 실제 화수와 행동을 적고 remainingPressure에는 다음 아크에 남은 질문만 적는다.',
        'JSON: {"score":0,"dimensions":{"payoffCadence":0,"patternVariety":0,"moralChoiceVariety":0,"emotionalTemperatureRange":0,"evidenceVariety":0,"endingVariety":0,"commercialMomentum":0},"findings":[{"dimension":"payoffCadence|patternVariety|moralChoiceVariety|emotionalTemperatureRange|evidenceVariety|endingVariety|commercialMomentum","code":"PAYOFF_DROUGHT|PATTERN_FAMILY_REPETITION|MORAL_CHOICE_REPETITION|SCENE_TEMPERATURE_FLAT|EVIDENCE_FAMILY_REPETITION|ENDING_IMAGE_REPETITION|COMMERCIAL_MOMENT_MISSING","scope":"arc|current_chapter","message":"연속 독서 근거와 최소 수정 방향"}],"targetedReview":{"applicable":false,"findings":[{"code":"CHARACTER_ARC_RUSH|UNSUPPORTED_RELATIONSHIP_SHIFT|SOCIAL_CONSEQUENCE_RESET","message":"문제와 최소 수정 방향","evidence":"화수와 본문의 짧고 구체적인 근거","confidence":0.0}]},"characterOutcomes":[{"characterId":"계획된 인물 id","status":"resolved|complicated|dormant","evidence":"화수와 비용 있는 행동","remainingPressure":"남은 질문 또는 빈 문자열"}]}',
      ].join('\n') },
    ],
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
    refreshed.push(await runPatternAnalysis({ chapter: episode.chapter, prose: artifact.prose, providers }));
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
    patternEntry: refreshed.find((entry) => entry.chapter === chapter), patternEntries: refreshed, providers,
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
