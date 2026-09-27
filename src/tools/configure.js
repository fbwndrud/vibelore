import { OPTIONAL_DRAFT_SECTIONS, OPTIONAL_REVIEWS, loadDisabledDraftSections, loadDisabledReviews, loadLedgerConfig, saveWriterSupportPolicy } from '../core/review-policy.js';
import { TRACKING_FEATURES } from '../../engine/src/continuity/ledger.js';
import { compileArcIntent, compileEpisodeIntent, compileNarrativeContract } from '../core/narrative-contract.js';
import { resolveWorkLanguage } from '../core/work-language.js';
import { episodeForChapter } from './arc.js';

export async function runConfigureStatus({ store, workId, disabledReviews, disabledDraftSections, tracking, customTracking, mergeRecords }) {
  if (Array.isArray(disabledReviews) || Array.isArray(disabledDraftSections) || tracking !== undefined || customTracking !== undefined || mergeRecords !== undefined) {
    await saveWriterSupportPolicy(store, workId, {
      disabledReviews: Array.isArray(disabledReviews) ? disabledReviews : undefined,
      disabledDraftSections: Array.isArray(disabledDraftSections) ? disabledDraftSections : undefined,
      tracking, customTracking, mergeRecords,
    });
  }
  const disabled = await loadDisabledReviews(store, workId);
  const draftSectionsOff = await loadDisabledDraftSections(store, workId);
  const ledgerConfig = await loadLedgerConfig(store, workId);
  const [foundation, profile, identity, writerSkill, storySpine, arcPlan] = await Promise.all([
    store.loadFoundation(workId), store.loadStoryProfile(workId), store.loadStoryIdentity(workId),
    store.loadWriterSkill(workId), store.loadStorySpine(workId), store.loadArcPlan(workId),
  ]);
  const chapters = await store.listChapters();
  const nextChapter = (chapters.at(-1) ?? 0) + 1;
  const episodePlan = await store.loadEpisodePlan(workId, nextChapter);
  const missing = [
    !foundation && 'foundation', profile?.status !== 'active' && 'storyProfile',
    storySpine?.status !== 'active' && 'storySpine', writerSkill?.status !== 'active' && 'writerSkill',
  ].filter(Boolean);
  const contract = profile || identity || writerSkill
    ? compileNarrativeContract({ profile, identity, writerSkill }) : null;
  // 표시 전용이다. 구형 문서의 언어/형식 키를 조회 때문에 새로 쓰지 않는다.
  const workLanguage = await resolveWorkLanguage({ store, workId, foundation, profile });
  return {
    status: missing.length ? 'incomplete' : 'ready', missing,
    language: {
      tag: workLanguage.language,
      promptFamily: workLanguage.promptFamily,
      source: workLanguage.languageSource,
      implicit: workLanguage.implicitLegacy,
      canonicalFormatVersion: workLanguage.canonicalFormatVersion,
      contractHash: workLanguage.contractHash,
    },
    length: {
      unit: workLanguage.length.unit,
      target: workLanguage.length.target,
      source: workLanguage.length.source,
    },
    narrativeContract: contract,
    reviewPolicy: {
      disabled, available: OPTIONAL_REVIEWS,
      // Density and length advice come from the editorial review.
      ...(disabled.includes('editorial-quality') ? { note: 'editorial-quality가 꺼져 있어 분량·밀도 조언도 나오지 않습니다.' } : {}),
    },
    draftSections: { disabled: draftSectionsOff, available: OPTIONAL_DRAFT_SECTIONS },
    tracking: { enabled: Object.fromEntries(TRACKING_FEATURES.map((feature) => [feature, ledgerConfig.tracking[feature] !== false])), available: TRACKING_FEATURES },
    customTracking: ledgerConfig.customTracking,
    merges: ledgerConfig.merges,
    storySpine: storySpine ? { status: storySpine.status, revision: storySpine.revision ?? null, dramaticQuestion: storySpine.dramaticQuestion ?? null } : null,
    arcIntent: compileArcIntent(arcPlan),
    episodeIntent: compileEpisodeIntent({ episodePlan, arcEpisode: episodeForChapter(arcPlan, nextChapter), chapter: nextChapter }),
    nextAction: missing.length
      ? `다음 설정 단계를 완료하세요: ${missing.join(', ')}`
      : '통합 계약과 활성 아크가 준비됐습니다. lore_write로 집필하세요.',
  };
}
