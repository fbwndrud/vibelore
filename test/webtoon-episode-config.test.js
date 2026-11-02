import test from 'node:test';
import assert from 'node:assert/strict';
import { runConfigureStatus } from '../src/tools/configure.js';
import { loadWebtoonAdaptationReviewModel, loadWebtoonImageQuality, loadWebtoonPageCap, loadWebtoonSceneDirect } from '../src/core/review-policy.js';
import { webtoonStore, workId } from './fixtures/webtoon.js';

test('webtoon episode settings default, save and validate', async () => {
  const store = await webtoonStore();
  assert.equal(await loadWebtoonPageCap(store, workId), 6);
  assert.equal(await loadWebtoonImageQuality(store, workId), null);
  assert.equal(await loadWebtoonAdaptationReviewModel(store, workId), null);
  assert.deepEqual(await loadWebtoonSceneDirect(store, workId), { enabled: false });
  await runConfigureStatus({ store, workId, webtoonPageCap: 4, webtoonImageQuality: 'high',
    webtoonAdaptationReviewModel: { provider: 'host', modelId: 'gpt-6.1-terra' } });
  assert.equal(await loadWebtoonPageCap(store, workId), 4);
  assert.equal(await loadWebtoonImageQuality(store, workId), 'high');
  assert.equal((await loadWebtoonAdaptationReviewModel(store, workId)).modelId, 'gpt-6.1-terra');
  for (const bad of [0, 21, 2.5, '4']) await assert.rejects(runConfigureStatus({ store, workId, webtoonPageCap: bad }), /INVALID_WEBTOON_PAGE_CAP/);
  await assert.rejects(runConfigureStatus({ store, workId, webtoonImageQuality: 'ultra' }), /INVALID_WEBTOON_IMAGE_QUALITY/);
  await assert.rejects(runConfigureStatus({ store, workId, webtoonAdaptationReviewModel: { reasoningEffort: 'medium' } }), /INVALID_WEBTOON_REVIEW_MODEL/);
  for (const bad of [{ enabled: true }, { enabled: true, userAnswer: '  ' }]) {
    await assert.rejects(runConfigureStatus({ store, workId, webtoonSceneDirect: bad }), /WEBTOON_SCENE_DIRECT_USER_ANSWER_REQUIRED/);
  }
  assert.equal(await loadWebtoonPageCap(store, workId), 4, 'a rejected save keeps the stored values');
  await runConfigureStatus({ store, workId, webtoonSceneDirect: { enabled: true, userAnswer: '장면 통째로 그려줘' } });
  assert.equal((await loadWebtoonSceneDirect(store, workId)).enabled, true);
  assert.equal((await loadWebtoonSceneDirect(store, workId)).userAnswer, '장면 통째로 그려줘');
});

test('configure status reports the webtoon episode settings, keeps them on omission and clears them on null', async () => {
  const store = await webtoonStore();
  const model = { provider: 'host', modelId: 'gpt-6.1-terra', reasoningEffort: 'medium' };
  const fresh = await runConfigureStatus({ store, workId });
  assert.deepEqual([fresh.webtoonAdaptationReviewModel, fresh.webtoonPageCap, fresh.webtoonImageQuality, fresh.webtoonSceneDirect],
    [null, 6, null, { enabled: false }]);
  const saved = await runConfigureStatus({ store, workId, webtoonAdaptationReviewModel: model, webtoonPageCap: 3,
    webtoonImageQuality: 'low', webtoonSceneDirect: { enabled: true, userAnswer: '네, 직접 생성' } });
  assert.deepEqual(saved.webtoonAdaptationReviewModel, model);
  assert.equal(saved.webtoonPageCap, 3);
  assert.equal(saved.webtoonImageQuality, 'low');
  assert.deepEqual(saved.webtoonSceneDirect, { enabled: true, userAnswer: '네, 직접 생성' });
  assert.deepEqual((await runConfigureStatus({ store, workId })).webtoonPageCap, 3);
  const cleared = await runConfigureStatus({ store, workId, webtoonAdaptationReviewModel: null, webtoonPageCap: null, webtoonImageQuality: null, webtoonSceneDirect: null });
  assert.deepEqual([cleared.webtoonAdaptationReviewModel, cleared.webtoonPageCap, cleared.webtoonImageQuality, cleared.webtoonSceneDirect],
    [null, 6, null, { enabled: false }]);
});
