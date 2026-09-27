import assert from 'node:assert/strict';
import { test } from 'node:test';
import { phrases as ko } from '../src/prompts/ko.js';
import { phrases as multilingual } from '../src/prompts/multilingual.js';

test('the scene join rule forbids replaying the previous chapter ending', () => {
  assert.match(ko.draftInput.previousTailRule, /반복하거나 되풀이하지 않는다/);
  assert.match(multilingual.draftInput.previousTailRule, /Do not repeat or restate/);
});

test('payoff guidance asks for results inside the scene, not screen or document evidence', () => {
  const koPayoff = ko.packet.payoffProof('X');
  const mlPayoff = multilingual.packet.payoffProof('X');
  assert.doesNotMatch(koPayoff, /화면 증거|증거/);
  assert.doesNotMatch(mlPayoff, /evidence/);
  assert.doesNotMatch(ko.packet.bridgeProof('X'), /증거/);
});
