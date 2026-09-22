import test from 'node:test';
import assert from 'node:assert/strict';
import { composeWebtoonBoard, boardHtml } from '../src/core/webtoon-board.js';

const shot = { id: 'shot-1', action: '얼굴을 보고 말한다.', height: 640, gapAfter: 120,
  texts: [{ kind: 'dialogue', speaker: 'c1', text: '안녕하세요.' }, { kind: 'caption', speaker: 'narrator', text: '오랜만이었다.' }, { kind: 'sfx', speaker: 'system', text: '쿵' }] };
const plan = (item = shot) => ({ title: '<첫 끼>', sequences: [{ shots: [item] }] });

test('editable letters have their own space and cannot cover the illustration', () => {
  const board = composeWebtoonBoard(plan(), { 'shot-1': { mime: 'image/png', base64: 'aGVsbG8=' } });
  const layout = board.layout[0];
  assert.equal(layout.artY, layout.letteringHeight);
  assert.equal(layout.height, layout.artHeight + layout.letteringHeight);
  assert.match(board.svg, /data-kind="dialogue"/);
  assert.match(board.svg, /data-kind="caption"/);
  assert.match(board.svg, /data-kind="sfx"/);
  assert.doesNotMatch(board.svg, /러프 콘티|얼굴을 보고/);
  assert.match(board.svg, /&lt;첫 끼&gt;/);
  assert.equal(board.artComplete, true);
});

test('reference captions sit below the image and no-dialogue panels retain planned rhythm', () => {
  const reference = composeWebtoonBoard(plan({ ...shot, id: 'ref-character-one' }));
  assert.equal(reference.layout[0].artY, 0);
  assert.match(reference.svg, /data-layer="lettering" transform="translate\(0 640\)"/);
  const silent = composeWebtoonBoard(plan({ ...shot, texts: [] }));
  assert.equal(silent.layout[0].height, 640);
  assert.equal(silent.layout[0].gapAfter, 120);
  assert.match(boardHtml(silent), /작화 전 · 대본 콘티/);
});
