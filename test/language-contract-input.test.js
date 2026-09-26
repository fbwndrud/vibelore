import test from 'node:test';
import assert from 'node:assert/strict';

import { languageComplianceMessages } from '../src/core/validation-gate.js';
import { layoutRelayRequests } from '../src/core/relay-prompt-layout.js';
import { buildLanguageContract } from '../engine/src/core/language-policy.js';

const prose = '“가자.” 리아가 말했다.\n\n도윤은 줄을 당겼다.';
const artifact = { prose, title: '첫 문', summary: '리아가 길을 연다.', semanticDelta: { chapterNumber: 1 }, castManifestRaw: '' };

test('the language check carries the prose verbatim so it shares the cached prose block', () => {
  const workContract = { ...buildLanguageContract({ language: 'ko' }), promptFamily: 'ko', allowedLanguageExceptions: [] };
  const { user } = languageComplianceMessages({ workContract, artifact, epoch: 1, attempt: 1 });
  assert.equal(user.split(prose).length - 1, 1, 'prose appears once, unescaped');
  assert.doesNotMatch(user, /\\n|\\"/, 'no JSON-escaped prose');
  const [laid] = layoutRelayRequests([{ id: 'l', step: 'language-contract', jsonMode: true, system: 's', user }], [{ id: 'chapter-prose', label: '1화 본문', text: prose }]);
  assert.ok(laid.promptCache, 'the relay can move the prose into the shared block');
});
