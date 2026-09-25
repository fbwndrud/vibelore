import { compileArcIntent, compileEpisodeIntent, compileNarrativeContract } from '../core/narrative-contract.js';
import { resolveWorkLanguage } from '../core/work-language.js';
import { episodeForChapter } from './arc.js';

export async function runConfigureStatus({ store, workId }) {
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
    storySpine: storySpine ? { status: storySpine.status, revision: storySpine.revision ?? null, dramaticQuestion: storySpine.dramaticQuestion ?? null } : null,
    arcIntent: compileArcIntent(arcPlan),
    episodeIntent: compileEpisodeIntent({ episodePlan, arcEpisode: episodeForChapter(arcPlan, nextChapter), chapter: nextChapter }),
    nextAction: missing.length
      ? `다음 설정 단계를 완료하세요: ${missing.join(', ')}`
      : '통합 계약과 활성 아크가 준비됐습니다. lore_write로 집필하세요.',
  };
}
