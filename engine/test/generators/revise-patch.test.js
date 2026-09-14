import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyRevisionPatch, revisionOperationLimit, runRevise } from '../../src/generators/text/steps/revise.js';

const foundation = {
  genreProfile: { invariants: [] },
  characters: [{
    id: 'hero', canonicalName: '윤재', aliases: [], registeredAtChapter: 1,
    intrinsic: { gender: 'male', ageBand: 'adult', role: '주인공', coreAppearance: [] },
  }],
};

describe('bounded prose revision patches', () => {
  it('changes only addressed paragraphs and preserves blank-line rhythm', () => {
    const original = '첫 문단이다.\n\n둘째 문단이다.\n\n셋째 문단이다.';
    const revised = applyRevisionPatch({
      originalProse: original,
      patchRaw: JSON.stringify({
        replacements: [{ paragraph: 2, text: '둘째 문단만 고쳤다.' }],
        insertions: [],
        castManifest: { cast: [{ characterId: 'hero', addressTermsUsed: [] }] },
      }),
    });
    assert.match(revised, /^첫 문단이다\.\n\n둘째 문단만 고쳤다\.\n\n셋째 문단이다\./);
    assert.match(revised, /⟦vle:cast-manifest/);
  });

  it('rejects a revision that exceeds its explicit operation budget', () => {
    const patchRaw = JSON.stringify({
      replacements: Array.from({ length: 4 }, (_, index) => ({ paragraph: index + 1, text: `수정 ${index + 1}` })),
      insertions: [],
    });
    assert.throws(() => applyRevisionPatch({
      originalProse: '1\n\n2\n\n3\n\n4', patchRaw, maxOperations: 3,
    }), /REVISION_PATCH_TOO_BROAD/);
  });

  it('uses JSON patch mode and includes the approved style context', async () => {
    let request;
    const providers = { async complete(input) {
      request = input;
      return { text: JSON.stringify({ replacements: [], insertions: [], castManifest: { cast: [] } }) };
    } };
    const result = await runRevise({
      foundation, chapterNumber: 1, prose: '첫 문단이다.', castManifestRaw: '{"cast":[]}',
      violations: [{ severity: 'hard', code: 'TEST', message: '검사' }],
      styleContext: { approvedAnchor: 'APPROVED_STYLE_TOKEN' },
      patchMode: true, model: { provider: 'host', modelId: 'host-agent' }, providers,
    });
    assert.equal(request.jsonMode, true);
    assert.match(request.messages.map((message) => message.content).join('\n'), /APPROVED_STYLE_TOKEN/);
    assert.match(result.revisedProse, /^첫 문단이다\.\n\n⟦vle:cast-manifest/);
    assert.equal(revisionOperationLimit([{ code: 'QUALITY_GATE_LENGTH' }]), 12);
  });
});
