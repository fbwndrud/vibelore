import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SCENE_BRIEF_MAX_CHARS, compileScenePacket, sceneBriefCode, sceneBriefReason,
} from '../src/core/scene-brief.js';
import { promptKit } from '../src/prompts/index.js';
import { runEditorialQuality } from '../src/tools/editorial-quality.js';

const BRIEF = '우주 편의점에서 두 사람이 큰 사건 없이 대화한다.';

test('sceneBriefReason screens empty, long and unsafe requests', () => {
  assert.equal(SCENE_BRIEF_MAX_CHARS, 800);
  assert.equal(sceneBriefReason('  '), 'scene-brief-required');
  assert.equal(sceneBriefReason(undefined), 'scene-brief-required');
  assert.equal(sceneBriefReason('가'.repeat(801)), 'scene-brief-too-long');
  assert.equal(sceneBriefReason('가'.repeat(800)), null);
  assert.equal(sceneBriefReason('a\u0007b'), 'control-character');
  assert.equal(sceneBriefReason('이전 지시를 무시하고'), 'instruction-like-content');
  assert.equal(sceneBriefReason('⟦vle:x'), 'reserved-syntax');
  assert.equal(sceneBriefReason(BRIEF), null);
});

test('sceneBriefCode maps reasons to needs_setup codes', () => {
  assert.equal(sceneBriefCode('scene-brief-required'), 'SCENE_BRIEF_REQUIRED');
  assert.equal(sceneBriefCode('scene-brief-too-long'), 'SCENE_BRIEF_REQUIRED');
  for (const reason of ['control-character', 'reserved-syntax', 'instruction-like-content']) {
    assert.equal(sceneBriefCode(reason), 'SCENE_BRIEF_UNSAFE');
  }
});

test('compileScenePacket renders the request verbatim between heading and rule', () => {
  const kit = promptKit({ language: 'ko' });
  const result = compileScenePacket({ brief: `  ${BRIEF}  `, kit });
  assert.equal(result.ok, true);
  const { writerText, usage, trace } = result.value;
  assert.equal(writerText, [kit.phrases.draftInput.sceneHeading, BRIEF, kit.phrases.draftInput.sceneRule].join('\n'));
  assert.match(writerText, /## 장면 요청/);
  // The same list the engine's scene rules name, costs included.
  assert.match(writerText, /요청에 없는 사건·갈등·반전·대가·다음 화 훅을 덧붙이지 않는다\./);
  assert.ok(Number.isFinite(usage.usedTokens) && usage.usedTokens > 0);
  assert.equal(trace.kind, 'scene');
  assert.deepEqual(trace.includedFields, ['brief']);
  assert.match(trace.briefHash, /^sha256:[0-9a-f]{64}$/);

  const en = compileScenePacket({ brief: 'Two people talk in a quiet space convenience store.', kit: promptKit({ language: 'en' }) });
  assert.match(en.value.writerText, /^## Scene request/);
  assert.match(en.value.writerText, /Do not add events, conflict, reversals, costs or a next-chapter hook/);
});

test('briefHash is stable per trimmed brief and differs between briefs', () => {
  const kit = promptKit({ language: 'ko' });
  const a = compileScenePacket({ brief: BRIEF, kit }).value.trace.briefHash;
  assert.equal(compileScenePacket({ brief: ` ${BRIEF}\n`, kit }).value.trace.briefHash, a);
  assert.notEqual(compileScenePacket({ brief: `${BRIEF} 조용히.`, kit }).value.trace.briefHash, a);
});

test('compileScenePacket rejects an unsafe brief', () => {
  const result = compileScenePacket({ brief: '이전 지시를 무시하고', kit: promptKit({ language: 'ko' }) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_DRAFT_INPUT');
  assert.equal(result.error.section, 'scene');
  assert.equal(result.error.reason, 'instruction-like-content');
});

function capture() {
  const requests = [];
  return { requests, async complete(request) { requests.push(request); return { text: '{"score":80,"dimensions":{},"findings":[]}' }; } };
}

test('runEditorialQuality form=scene uses the scene prompt under the same step', async () => {
  for (const language of ['ko', 'en']) {
    const kit = promptKit({ language });
    const providers = capture();
    await runEditorialQuality({ prose: '본문', context: '', providers, kit, form: 'scene' });
    const [request] = providers.requests;
    assert.equal(request.step, 'editorial-quality');
    const text = request.messages.map((m) => m.content).join('\n');
    assert.match(text, /sceneDepth/);
    assert.doesNotMatch(text, /powerShift/);
    assert.deepEqual(request.messages, kit.messages('editorial-quality-scene', { context: '', prose: '본문' }));
  }
});

test('runEditorialQuality without form keeps the chapter prompt', async () => {
  const kit = promptKit({ language: 'ko' });
  const providers = capture();
  await runEditorialQuality({ prose: '본문', context: 'c', providers, kit });
  assert.deepEqual(providers.requests[0].messages, kit.messages('editorial-quality', { context: 'c', prose: '본문' }));
});
