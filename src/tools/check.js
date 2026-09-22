/**
 * lore_check -- run every scan the engine has over a draft chapter and report
 * what broke, ranked so the writer (or the agent) fixes what matters first.
 *
 * Most of this is deterministic and needs no model at all: 29 of the engine's
 * 30 continuity modules are pure functions. Only the semantic layer of
 * `continuityCheck` and the delta extraction want a completion, and both
 * degrade cleanly -- so a `lore_check` with no model work still returns real
 * findings, and the relay only adds the semantic layer on top.
 */
import { extractDelta, continuityCheck } from '../../engine/src/continuity/continuity-check.js';
import { scanLexicon } from '../../engine/src/continuity/lexicon-scan.js';
import { scanSensitive } from '../../engine/src/continuity/sensitive-lexicon.js';
import { scanQuality } from '../../engine/src/continuity/quality-scan.js';
import { checkPov } from '../../engine/src/continuity/pov-check.js';
import { scanDialogueRatio } from '../../engine/src/continuity/dialogue-ratio.js';
import { scanDialogueMarkerVariety } from '../../engine/src/continuity/dialogue-marker-variety.js';
import { scanInfoRestate } from '../../engine/src/continuity/info-restate-detector.js';
import { detectGapSkip } from '../../engine/src/continuity/gap-skip-detector.js';
import { detectCliffhanger } from '../../engine/src/continuity/cliffhanger-detector.js';
import { runProsodyScan } from '../../engine/src/continuity/prosody-scan.js';
import { evaluateChapterQuality } from '../../engine/src/continuity/quality-gate.js';
import { trailingCastMetadata } from './prose-integrity.js';
import { scanWebnovelFormat } from './webnovel-format.js';
import { arcPositionFromRatio } from '../../engine/src/core/arc-context.js';
import { emptyStoryState } from '../../engine/src/continuity/story-state.js';
import { lexicons } from './lexicons.js';
import { episodeForChapter } from './arc.js';
import { episodePlanReviewView } from '../core/episode-plan-view.js';
import { createHash, randomUUID } from 'node:crypto';

const MODEL = { provider: 'host', modelId: 'host-agent' };

/** Anything that throws inside one scan must not take the other twelve down. */
function safely(label, fn) {
  try { return fn() ?? {}; }
  catch (err) { return { violations: [], error: `${label}: ${err.message}` }; }
}

const SEVERITY_RANK = { hard: 0, soft: 1, info: 2 };

export async function runCheck({ store, workId, chapter, prose, castManifestRaw, providers, targetChapters, dialogueBreakMode = 'strict', includeSemanticContinuity = true, includeProfileCheck = true, requireInfluenceObservation = false, issueReceipt = false }) {
  const foundation = await store.loadFoundation(workId);
  if (!foundation) throw new Error('이 디렉터리에 작품이 없습니다. 먼저 lore_init 을 실행하세요.');

  const lex = lexicons();
  const errors = [];
  const collect = (label, fn) => {
    const r = safely(label, fn);
    if (r.error) errors.push(r.error);
    return r.violations ?? [];
  };

  // -- deterministic layer, no model needed ---------------------------------
  const violations = [
    ...collect('lexicon', () => scanLexicon({ prose, chapterNumber: chapter, foundation, lexicon: lex.honorific })),
    ...collect('sensitive', () => scanSensitive({ prose, chapterNumber: chapter, lexicon: lex.sensitive })),
    ...collect('quality', () => scanQuality({
      prose, chapterNumber: chapter,
      emotionLexicon: lex.emotion, simileLexicon: lex.simile, onomatopoeiaLexicon: lex.onomatopoeia,
    })),
    ...collect('pov', () => checkPov({
      prose, chapterNumber: chapter, foundation,
      narratorId: foundation.narratorId, emotionLexicon: lex.emotion,
    })),
    ...collect('dialogue-ratio', () => scanDialogueRatio({ prose, chapterNumber: chapter, genreProfile: foundation.genreProfile })),
    ...collect('dialogue-markers', () => scanDialogueMarkerVariety({ prose, chapterNumber: chapter })),
    ...collect('info-restate', () => scanInfoRestate({ prose, chapterNumber: chapter, foundation })),
    ...collect('gap-skip', () => detectGapSkip({ prose, chapterNumber: chapter })),
    ...collect('webnovel-format', () => scanWebnovelFormat({ prose, chapterNumber: chapter, dialogueBreakMode })),
  ];
  for (const character of foundation.characters) {
    if (character.id.includes('_') && new RegExp(`(^|[^A-Za-z0-9_])${character.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'm').test(prose)) {
      violations.push({ severity: 'hard', code: 'METADATA_LEAK', chapterNumber: chapter, message: `본문에 내부 캐릭터 ID "${character.id}"가 노출됐다.` });
    }
  }
  if (trailingCastMetadata(prose, foundation.characters).length > 0) violations.push({ severity: 'hard', code: 'METADATA_LEAK', chapterNumber: chapter, message: '본문 말미에 내부 캐스트 이름 목록 또는 ID 매핑이 노출됐다.' });

  const arcPlan = await store.loadArcPlan(workId);
  const arcEpisode = episodeForChapter(arcPlan, chapter);
  const estimated = targetChapters ?? foundation.targetChapters ?? 0;
  const arcPosition = arcEpisode
    ? arcPositionFromRatio(arcEpisode.index, arcPlan.estimatedEpisodes)
    : (estimated > 0 ? arcPositionFromRatio(chapter, estimated) : 'rising');
  violations.push(...collect('cliffhanger', () => detectCliffhanger({ prose, chapterNumber: chapter, arcPosition })));

  const prosody = safely('prosody', () => runProsodyScan(prose));
  const quality = safely('quality-gate', () => evaluateChapterQuality({
    prosodyScore: prosody.score ?? 0,
    coherenceScore: null,
  }));

  // -- semantic layer, relayed to the host model ----------------------------
  let delta = null;
  let unregisteredNamed = [];
  // The delta is read against the state the previous chapter left behind, so a
  // change only counts as a change relative to what was already true.
  const prevState = (await store.loadStoryState(workId, chapter - 1)) ?? emptyStoryState(workId);
  const extracted = await extractDelta({
    prose, chapterNumber: chapter, foundation, providers, model: MODEL, prevState,
    castManifestRaw: castManifestRaw ?? '',
    requireInfluenceObservation,
  });
  delta = extracted.delta;
  unregisteredNamed = extracted.unregisteredNamed ?? [];

  // `prevState` is required here too. Note the sharp edge: continuityCheck
  // builds its user prompt *inside* the try that guards the provider call, so a
  // missing field makes the whole semantic layer vanish silently rather than
  // fail loudly. Omitting prevState costs you layer 2 with no error anywhere.
  // The semantic pass embeds the extracted delta in its prompt. While the relay
  // is still collecting the extraction, requesting it would expose a stale
  // placeholder question to the host.
  if (includeSemanticContinuity && (providers?.pending?.length ?? 0) === 0) {
    const semantic = await continuityCheck({
      prose, chapterNumber: chapter, foundation, delta, prevState,
      lexicon: lex.honorific, providers, model: MODEL,
    });
    violations.push(...(semantic.violations ?? []));
  }

  // StoryProfile rules are generated writing guidance, never hard truth. The
  // host may flag drift, but every finding stays soft so taste cannot block a
  // continuity-safe chapter.
  const storyProfile = await store.loadStoryProfile(workId);
  const episodePlan = await store.loadEpisodePlan(workId, chapter);
  if (includeProfileCheck && storyProfile?.status === 'active') {
    try {
      const response = await providers.complete({
        model: MODEL, jsonMode: true, step: 'story-profile-check',
        messages: [
          { role: 'system', content: '승인된 작품 StoryProfile과 회차 본문을 비교한다. 명백하고 구체적인 이탈만 findings에 넣는다. 취향 차이와 장면상 의도는 지적하지 않는다. 모든 finding은 soft다. 순수 JSON만 출력한다.' },
          { role: 'user', content: `StoryProfile:\n${JSON.stringify(storyProfile)}\n\n회차 비트:\n${JSON.stringify(arcEpisode)}\n\nEpisodePlan:\n${JSON.stringify(episodePlanReviewView(episodePlan))}\n\n본문:\n${prose}\n\nJSON: {"findings":[{"code":"PROFILE_TONE_DRIFT|PROFILE_ENGINE_DRIFT|PROFILE_BEAT_DRIFT","message":"구체적 근거"}]}` },
        ],
      });
      const parsed = JSON.parse(String(response.text).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim());
      for (const finding of Array.isArray(parsed?.findings) ? parsed.findings.slice(0, 10) : []) {
        if (finding && typeof finding.message === 'string') {
          violations.push({ severity: 'soft', code: String(finding.code ?? 'PROFILE_DRIFT'), chapterNumber: chapter, message: finding.message });
        }
      }
    } catch { /* relay miss or malformed advisory result: core checks still stand */ }
  }

  const ranked = violations
    .filter(Boolean)
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
  const hard = ranked.filter((v) => v.severity === 'hard');

  const result = {
    verdict: hard.length === 0 ? (ranked.length === 0 ? 'clean' : 'soft-only') : 'blocked',
    violations: ranked,
    counts: {
      hard: hard.length,
      soft: ranked.filter((v) => v.severity === 'soft').length,
      total: ranked.length,
    },
    prosody: { score: prosody.score ?? null, breakdown: prosody.breakdown ?? null },
    qualityGate: quality,
    unregisteredNamed,
    delta,
    ...(errors.length > 0 ? { scanErrors: errors } : {}),
  };

  // Manual rewrite/check/commit flows need the semantic delta produced by this
  // exact check. Do not issue a receipt while the host relay still has answers
  // outstanding; the resumed pass will issue the usable receipt.
  if (issueReceipt && (providers?.pending?.length ?? 0) === 0) {
    const receipt = {
      checkId: `check-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      workflowId: null,
      workId,
      chapter,
      proseHash: `sha256:${createHash('sha256').update(String(prose)).digest('hex')}`,
      verdict: hard.length === 0 ? 'passed' : 'blocked',
      delta,
      hardViolations: hard.length,
      prosody: prosody.score ?? null,
      checkedAt: new Date().toISOString(),
      consumedAt: null,
    };
    await store.saveCheckReceipt(workId, receipt);
    result.checkId = receipt.checkId;
  }

  return result;
}
