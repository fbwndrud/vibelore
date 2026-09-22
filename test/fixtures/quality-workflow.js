import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownStateStore } from '../../src/store/markdown-store.js';
import { runInit } from '../../src/tools/init.js';
import { SYNTHETIC_LONG_PROSE } from './synthetic-prose.js';
import { REVIEW_RESPONSES } from './review-responses.js';

export const workId = 'quality-regression';
export const outputs = {
  ...REVIEW_RESPONSES,
  'chapter-plan': JSON.stringify({ plan: '윤재가 문을 연다.', scene: { settings: [], characters: ['hero'], items: [], antagonists: [], additionalRefs: [] }, tension: {} }),
  draft: `${SYNTHETIC_LONG_PROSE}\n\n⟦vle:cast-manifest {"cast":[{"characterId":"hero","addressTermsUsed":[]}]}⟧`,
  'continuity-extract': '{}', 'continuity-check': '{}', 'story-profile-check': '{"findings":[]}',
  'chapter-summary': '{"summary":"윤재가 문을 열었다.","plotBeat":"opening","sceneTags":[],"povCharacter":"hero"}',
  'narrative-boundary': '{"decision":"advance_episode","reason":"첫 사건이 끝났다."}',
};

export async function qualityStore() {
  const store = new MarkdownStateStore(await mkdtemp(join(tmpdir(), 'vibelore-quality-')));
  await runInit({ store, workId, genre: 'litrpg', povMode: '3인칭제한', worldFacts: ['탑은 세금을 걷는다.'] });
  const foundation = await store.loadFoundation(workId);
  await store.saveFoundation({ ...foundation, characters: [{ id: 'hero', canonicalName: '윤재', aliases: [], registeredAtChapter: 1,
    intrinsic: { gender: 'male', ageBand: '20대', role: '주인공', coreAppearance: [] }, mutable: { status: 'alive', knownFacts: ['지도 확대는 이미 배웠다.'] } }] });
  await store.saveStoryProfile(workId, { workId, status: 'active', revision: 1, engineGenre: 'litrpg', genreLabel: '유쾌한 모험', subgenres: [], themes: [], tracking: { semantic: [], engineBacked: [] }, tones: ['유쾌'], storyEngines: ['능력으로 얻은 시간에 놀이를 즐긴다'],
    format: { pov: '3인칭제한', chapterChars: 3300, dialogueBreakMode: 'relaxed' },
    narrativeContract: { readerPromise: '놀이를 실제로 즐기는 약속' },
    voiceContract: { genreVoiceRecipe: { narration: '모르는 것을 배우며 능청스럽게 반응한다.', exposition: '2006년의 경험과 2026년의 새 사용법을 구분한다.' },
      narrationExamples: [{ situation: '지도', example: '지도는 배웠다. 이제 바다를 찾아볼 차례였다.' }],
      dialogueExamples: [{ situation: '식사', example: '“세상은 구했으니 밥부터 먹자.”' }] },
    promptGuidance: { avoid: [], worldbuild: [], cast: [], arc: [], draft: ['배운 지도 사용법을 다음 행동에서 활용한다.'] },
  });
  await store.saveStorySpine(workId, { status: 'active', causalChain: ['문을 연다', '함께 논다', '새 길을 찾는다'] });
  await store.saveWriterSkill(workId, { status: 'active', revision: 1, authorCraft: { judgments: ['행동으로 즐거움을 보인다'] } });
  await store.saveStoryIdentity(workId, { readerPromise: '놀이', protagonistAppeal: '편하게 묻는 사람', emotionalDefect: '', competenceSignature: ['힘을 조절한다'], comedyEngines: ['익숙한 일과 새 문화의 만남'], solutionPatternsToRotate: ['전투'] });
  await store.savePilotContract(workId, { seriesPromise: '놀이' });
  const scenes = [{ situation: '닫힌 문 앞에 선다', choice: '문을 민다', change: '문이 열린다' }, { situation: '길이 보인다', choice: '앞으로 간다', change: '안에 들어간다' }];
  await store.saveArcPlan(workId, { status: 'active', arcNumber: 1, title: '첫 문', promise: '문 너머의 놀이', startChapter: 1, estimatedEpisodes: 3,
    episodes: [1, 2, 3].map((chapter) => ({ chapter, index: chapter, beat: `사건 ${chapter}`, goal: '문을 연다', pressure: '잠긴 문', carry: '놀이' })) });
  await store.saveEpisodePlan(workId, { status: 'active', revision: 1, chapter: 1, arcNumber: 1, premise: '지도에서 본 길을 찾는다', cast: ['hero'], povCharacter: 'hero', locations: ['탑 입구'],
    openingState: '문 앞', closingState: '안에 들어감', scenes, payoff: { promisePaid: '문을 연다', proofOnPage: '안에 들어간다' }, entryState: { protagonistImmediateWant: '입장' }, exitValue: { specificFutureValue: '안에 들어감' } });
  return store;
}
