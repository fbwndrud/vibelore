import { createFoundation } from '../../engine/src/continuity/foundation.js';
import { createGenreProfileRegistry } from '../../engine/src/continuity/genre-profile.js';

/** Preexisting legacy canon: never creates then removes a new work contract. */
export async function legacyWorkFixture({ store, workId, genre = 'other', worldFacts = [], ...options }) {
  const foundation = { ...createFoundation({ workId, genre, genreProfile: createGenreProfileRegistry().get(genre), ...options }),
    ...options, worldFacts: worldFacts.map((statement, index) => ({ id: `w${index + 1}`, statement, registeredAtChapter: 1 })) };
  await store.saveFoundation(foundation);
  return foundation;
}
