/**
 * lore_init -- lay out a project directory, or adopt one that already exists.
 *
 * Adoption matters more than creation: a novelist who already has a folder of
 * notes should be able to point the plugin at it and keep working, rather than
 * being told to start over somewhere else.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createFoundation } from '../../engine/src/continuity/foundation.js';
import { createGenreProfileRegistry } from '../../engine/src/continuity/genre-profile.js';
import { ENGINE_GENRES } from '../../engine/src/continuity/genre-profile.js';

const registry = createGenreProfileRegistry();

export async function runInit({ store, workId, genre, povMode, targetChapters, worldFacts }) {
  const existing = await store.loadFoundation(workId);
  if (existing) {
    return {
      adopted: true,
      workId: existing.workId,
      genre: existing.genre,
      characters: existing.characters.length,
      worldFacts: existing.worldFacts.length,
      chapters: await store.listChapters(),
      message: '기존 작품을 그대로 사용합니다. 덮어쓰지 않았습니다.',
    };
  }

  if (!registry.has(genre)) {
    throw new Error(
      `알 수 없는 장르 "${genre}". 사용 가능: ${ENGINE_GENRES.join(', ')}`,
    );
  }

  let foundation = createFoundation({
    workId,
    genre,
    genreProfile: registry.get(genre),
    ...(povMode ? { povMode } : {}),
  });
  if (targetChapters) foundation = { ...foundation, targetChapters };
  if (worldFacts?.length) {
    foundation = {
      ...foundation,
      worldFacts: worldFacts.map((statement, i) => ({
        id: `w${i + 1}`, statement: String(statement), registeredAtChapter: 1,
      })),
    };
  }

  await store.saveFoundation(foundation);
  for (const dir of ['chapters', 'summaries', 'characters']) {
    await mkdir(join(store.rootDir, dir), { recursive: true });
  }

  return {
    adopted: false,
    workId,
    genre,
    created: ['world/setting.md', 'characters/', 'chapters/', 'summaries/', '.vibelore/'],
    message: '세계관을 world/setting.md 에 적고, 인물은 characters/<id>.md 로 추가하세요. 직접 손으로 고쳐도 됩니다.',
  };
}
