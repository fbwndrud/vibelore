import test from 'node:test';
import assert from 'node:assert/strict';

import { runPatternAnalysis } from '../src/tools/story-experience.js';
import { promptKit } from '../src/prompts/index.js';
import { buildLanguageContract } from '../engine/src/core/language-policy.js';

const kit = promptKit({ contract: buildLanguageContract({ language: 'ko' }) });
const foundation = { characters: [
  { id: 'c1', canonicalName: '리아', registeredAtChapter: 1 },
  { id: 'c2', canonicalName: '도윤', registeredAtChapter: 1 },
] };
const previousEntries = [
  { chapter: 6, solutionPattern: '환경이용', protagonistMethod: '길목 먼저 보기', costShape: '신체' },
  { chapter: 7, solutionPattern: '협상', protagonistMethod: '길목 먼저 보기', costShape: '관계' },
];

test('pattern review sees the id table and the previous categories so names repeat for the same function', async () => {
  let request;
  await runPatternAnalysis({ chapter: 8, prose: '본문', foundation, cast: ['c1', 'c2'], previousEntries, kit,
    providers: { async complete(req) { request = req; return { text: '{}' }; } } });
  const user = request.messages.find((m) => m.role === 'user').content;
  assert.match(user, /c1=리아/);
  assert.match(user, /c2=도윤/);
  assert.match(user, /7화[^\n]*협상[^\n]*길목 먼저 보기/);
  assert.match(user, /6화[\s\S]*7화/, 'oldest first');
});

test('supporting agency keys given as names are stored as ids', async () => {
  const result = await runPatternAnalysis({ chapter: 8, prose: '본문', foundation, cast: ['c1', 'c2'], kit,
    providers: { async complete() { return { text: JSON.stringify({ supportingAgency: { 도윤: '운행을 끊었다', c1: '방패를 거뒀다' } }) }; } } });
  assert.deepEqual(result.supportingAgency, { c2: '운행을 끊었다', c1: '방패를 거뒀다' });
});
