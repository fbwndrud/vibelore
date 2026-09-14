import assert from 'node:assert/strict';
import { it } from 'node:test';
import { extractDelta } from '../engine/src/continuity/continuity-check.js';

it('resolves canonical names to IDs and drops role labels from model deltas', async () => {
  const foundation = { characters: [{ id: 'seo_doyun', canonicalName: '서도윤', aliases: ['도윤'] }] };
  const providers = { async complete() { return { text: JSON.stringify({ mutableChanges: [
    { characterId: '서도윤', knownFactsAdded: ['선발 기준을 안다'] },
    { characterId: '임시 코치', knownFactsAdded: ['잘못 만든 역할 ID'] },
  ] }) }; } };
  const result = await extractDelta({ prose: '서도윤은 선발 기준을 말했다.', chapterNumber: 1, foundation, providers, model: {}, prevState: { chapterNumber: 0, addressMap: { entries: {} }, hooks: [] }, castManifestRaw: '{"cast":[{"characterId":"seo_doyun","addressTermsUsed":[]}]}' });
  assert.deepEqual(result.delta.mutableChanges, [{ characterId: 'seo_doyun', knownFactsAdded: ['선발 기준을 안다'] }]);
});

it('extracts provenance-ready influence events and resolves directional character IDs', async () => {
  const foundation = { characters: [
    { id: 'seo_doyun', canonicalName: '서도윤', aliases: ['도윤'] },
    { id: 'han_jaehyuk', canonicalName: '한재혁', aliases: ['재혁'] },
  ] };
  const providers = { async complete() { return { text: JSON.stringify({ influenceEvents: [{
    characterId: '서도윤', anchor: '후반 63분 교체권을 양보한 선택', interpretation: '재혁에게 마지막 기회를 맡긴다',
    dimensionChanges: { trust: 1 }, nextChoiceBias: '혼자 통제하지 않고 선택권을 건넨다',
    relationshipClaims: [{ from: '서도윤', to: '한재혁', dimensions: { trust: 1 }, belief: '압박 속에서도 맡길 수 있다' }],
  }] }) }; } };
  const result = await extractDelta({ prose: '도윤은 교체권을 재혁에게 넘겼다.', chapterNumber: 3, foundation, providers, model: {}, prevState: { chapterNumber: 2, addressMap: { entries: {} }, hooks: [] }, castManifestRaw: '{"cast":[{"characterId":"seo_doyun","addressTermsUsed":[]},{"characterId":"han_jaehyuk","addressTermsUsed":[]}]}' });
  assert.equal(result.delta.influenceEvents[0].characterId, 'seo_doyun');
  assert.deepEqual(result.delta.influenceEvents[0].relationshipClaims[0], {
    from: 'seo_doyun', to: 'han_jaehyuk', dimensions: { trust: 1 }, belief: '압박 속에서도 맡길 수 있다',
  });
});

it('requests a repaired delta when strict planning receives no influence observation', async () => {
  const foundation = { characters: [
    { id: 'seo_doyun', canonicalName: '서도윤', aliases: ['도윤'] },
    { id: 'han_jaehyuk', canonicalName: '한재혁', aliases: ['재혁'] },
  ] };
  const steps = [];
  const providers = { async complete(request) {
    steps.push(request.step);
    if (request.step === 'continuity-extract') return { text: '{}' };
    return { text: JSON.stringify({ influenceEvents: [{
      characterId: '서도윤', anchor: '도윤이 교체권을 재혁에게 넘겼다',
      interpretation: '통제를 나눈다', dimensionChanges: { trust: 1 }, nextChoiceBias: '선택권을 먼저 묻는다', relationshipClaims: [],
    }] }) };
  } };

  const result = await extractDelta({
    prose: '도윤은 교체권을 재혁에게 넘겼다.', chapterNumber: 3, foundation, providers, model: {},
    prevState: { chapterNumber: 2, addressMap: { entries: {} }, hooks: [] },
    castManifestRaw: '{"cast":[{"characterId":"seo_doyun","addressTermsUsed":[]},{"characterId":"han_jaehyuk","addressTermsUsed":[]}]}',
    requireInfluenceObservation: true,
  });

  assert.deepEqual(steps, ['continuity-extract', 'continuity-extract-repair']);
  assert.equal(result.delta.influenceEvents[0].characterId, 'seo_doyun');
});
