import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../src/core/webtoon-contract.js';
import { letteringBinding, solveLettering, validateVisualMap, imageDimensions } from '../src/core/webtoon-lettering.js';
import { measureLetters, wrapLetters, letteringPath } from '../src/core/webtoon-font.js';
import { composeWebtoonBoard } from '../src/core/webtoon-board.js';
import { pixel } from './fixtures/webtoon.js';

const image = { mime: 'image/png', base64: pixel.toString('base64'), hash: digest(pixel) };
const shot = { id: 'one', height: 760, gapAfter: 40, texts: [{kind:'dialogue',speaker:'hero',text:'오래 하시면 됩니다.'}] };
const map = () => ({ inputHash:letteringBinding(shot,image),inspectedImages:true,evidence:'Synthetic geometry',protected:[[.45,.55,.1,.12]],entries:[{textIndex:0,anchor:[.5,.6],candidates:[[.5,.28],[.45,.25],[.55,.22]],confidence:1,reason:'Fixture mouth'}] });

test('font uses real advances, preserves explicit lines and outlines supported Korean', () => {
  assert.ok(measureLetters('WW',30).width > measureLetters('ii',30).width);
  assert.equal(measureLetters('안녕',60).width, measureLetters('안녕',30).width*2);
  assert.deepEqual(wrapLetters('안녕\n하세요.',400,30), ['안녕','하세요.']);
  assert.match(letteringPath('쾅 오래 하시면 됩니다.',30,0,30), /^M/);
  assert.doesNotMatch(letteringPath('안녕',30,0,30), /NaN|Infinity/);
  assert.throws(()=>measureLetters('😀',30), /MISSING_GLYPH/);
  assert.throws(()=>measureLetters('e\u0301',30), /UNSUPPORTED_TEXT_SHAPING/);
});

test('visual evidence, coverage, anchors and current image/text/font bindings are required', () => {
  assert.deepEqual(imageDimensions(image),[1,1]);
  assert.deepEqual(validateVisualMap(shot,image,map()),[]);
  assert.deepEqual(validateVisualMap({...shot,height:800},image,map()),['STALE_VISUAL_MAP']);
  assert.ok(validateVisualMap(shot,image,{...map(),inspectedImages:false}).includes('VISUAL_INSPECTION_REQUIRED'));
  const low=map();low.entries[0].confidence=.6;
  assert.ok(validateVisualMap(shot,image,low).includes('UNRESOLVED_ANCHOR'));
  assert.ok(validateVisualMap(shot,image,{...map(),entries:[]}).includes('TEXT_COVERAGE_MISMATCH'));
});

test('joint solve is deterministic, protects faces, produces actual tail and portable outlines', () => {
  const layout=solveLettering(shot,image,map());
  assert.equal(layout.status,'passed');
  assert.deepEqual(layout,solveLettering(shot,image,map()));
  assert.ok(layout.candidates.length>1 && layout.candidates.length<=3);
  const item=layout.candidates[0].items[0];
  assert.ok(item.bounds.y+item.bounds.h < .55*760);
  assert.ok(item.tail.end[1] < .55*760);
  const dx=item.tail.end[0]-item.center[0];const dy=item.tail.end[1]-item.center[1];
  assert.ok(Math.abs(dx)>item.w/2+7 || Math.abs(dy)>item.h/2+7,'Tail must protrude beyond its own balloon');
  const board=composeWebtoonBoard({title:'검사',sequences:[{shots:[shot]}]},{one:image},{one:layout});
  assert.match(board.svg,/data-kind="tail"/);
  assert.match(board.svg,/data-kind="balloon-outline"[^>]+mask="url\(#tail-join-one-0\)"/);
  assert.match(board.svg,/data-text="오래/);
  assert.doesNotMatch(board.svg,/data:font/);
  assert.ok(board.svg.length<100000);
  assert.equal(board.layout[0].letteringVersion,2);
});

test('infeasible placement and reversed reading order block instead of using a fallback', () => {
  const crowded=map();crowded.protected=[[0,0,1,1]];
  assert.match(solveLettering(shot,image,crowded).issues[0],/NO_FEASIBLE_LAYOUT/);
  const two={...shot,texts:[...shot.texts,{kind:'caption',speaker:'system',text:'다음'}]};
  const m=map();m.inputHash=letteringBinding(two,image);m.entries.push({textIndex:1,candidates:[[.5,.05]],confidence:1,reason:'Deliberately reversed'});
  assert.match(solveLettering(two,image,m).issues[0],/NO_FEASIBLE_LAYOUT/);
});

test('silent art needs no fabricated inspection and a one-syllable SFX uses its actual ink bounds', () => {
  assert.equal(solveLettering({...shot,texts:[]},image,null).status,'passed');
  const sound={...shot,texts:[{kind:'sfx',speaker:'system',text:'쾅'}]};
  const m=map();m.inputHash=letteringBinding(sound,image);m.entries[0].rotation=-18;
  const l=solveLettering(sound,image,m);assert.equal(l.status,'passed');
  assert.ok(l.candidates[0].items[0].w<100);
  assert.equal(l.candidates[0].items[0].tail,null);
});

test('diegetic UI follows its observed location without reversing narrative order', () => {
  const three={...shot,texts:[shot.texts[0],{kind:'ui',speaker:'system',text:'주소'},{kind:'caption',speaker:'narrator',text:'확인하고 말하자.'}]};
  const m=map();m.inputHash=letteringBinding(three,image);
  m.entries.push({textIndex:1,candidates:[[.18,.82]],confidence:1,reason:'Observed paper field'});
  m.entries.push({textIndex:2,candidates:[[.78,.55]],confidence:1,reason:'Narrative after dialogue, above the paper'});
  assert.equal(solveLettering(three,image,m).status,'passed');
  m.entries[2].candidates=[[.78,.05]];
  assert.match(solveLettering(three,image,m).issues[0],/NO_FEASIBLE_LAYOUT/);
});

test('impact is opt-in, its enlarged footprint is checked and dialogue cannot adopt it', () => {
  const sound={...shot,texts:[{kind:'sfx',speaker:'system',text:'쾅'}]};
  const m=map();m.inputHash=letteringBinding(sound,image);m.entries[0].rotation=-18;
  const plain=solveLettering(sound,image,m).candidates[0].items[0];
  m.entries[0].sfxStyle='impact';
  const l=solveLettering(sound,image,m);assert.equal(l.status,'passed');
  const impact=l.candidates[0].items[0];
  assert.ok(impact.fontSize>plain.fontSize && impact.bounds.w>plain.bounds.w && impact.bounds.h>plain.bounds.h);
  assert.equal(impact.inkStroke,4);
  const board=composeWebtoonBoard({title:'타격',sequences:[{shots:[sound]}]},{one:image},{one:l});
  assert.match(board.svg,/data-sfx-style="impact"/);assert.match(board.svg,/stroke-width="10"/);
  assert.equal([...board.svg.matchAll(/data-text="쾅"/g)].length,1);
  const speech=map();speech.entries[0].sfxStyle='impact';
  assert.ok(validateVisualMap(shot,image,speech).includes('INVALID_SFX_STYLE'));
  m.entries[0].sfxStyle='__proto__';assert.ok(validateVisualMap(sound,image,m).includes('INVALID_SFX_STYLE'));
});
