import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileArcIntent, compileEpisodeIntent, compileNarrativeContract, compileDraftContract, renderNarrativeContract } from '../src/core/narrative-contract.js';

describe('NarrativeContract', () => {
  it('preserves full approved intent and selects relevant examples with exclusion reasons', () => {
    const promise = '승인된 약속'.repeat(200);
    const profile = { narrativeContract: { readerPromise: promise }, tones: ['슬픔'], voiceContract: {
      genreVoiceRecipe: { narration: '말을 고르는 조용한 사람' },
      narrationExamples: [
        { situation: '식사', example: '숟가락을 놓았다.' },
        { situation: '지도', example: '지도를 다시 펼쳤다.' },
        { situation: '지도', example: '긴 예시'.repeat(1000) },
        { situation: '전화', example: '전화를 내려놓았다.' },
      ],
    } };
    const result = compileDraftContract({ profile, identity: { readerPromise: '자동 해석' }, episodePlan: { premise: '지도' } });
    assert.ok(result.writerText.includes(promise));
    assert.doesNotMatch(result.writerText, /자동 해석/);
    assert.match(result.writerText, /지도를 다시 펼쳤다/);
    assert.match(result.writerText, /말을 고르는 조용한 사람/);
    assert.equal(result.trace.coreTruncated, false);
    assert.equal(result.trace.examplesIncluded.length, 2);
    assert.ok(result.trace.examplesExcluded.some((item) => item.reason === 'example-budget'));
    assert.ok(result.trace.examplesExcluded.some((item) => item.reason === 'example-count'));
  });

  it('names the chapter viewpoint character from the plan so the draft and the local revise both hear it', () => {
    const profile = { narrativeContract: { readerPromise: '약속' }, tones: [] };
    const names = { c1: '이네스', c2: '클라라' };
    const withViewpoint = compileDraftContract({ profile, identity: {}, episodePlan: { premise: '항구', povCharacter: 'c2' }, characterNames: names });
    assert.match(withViewpoint.writerText, /- 이번 화 시점 인물: 클라라 — 첫 문단을 포함한/);
    const otherViewpoint = compileDraftContract({ profile, identity: {}, episodePlan: { premise: '항구', povCharacter: 'c1' }, characterNames: names });
    assert.notEqual(withViewpoint.trace.digest, otherViewpoint.trace.digest);
    const unnamed = compileDraftContract({ profile, identity: {}, episodePlan: { premise: '항구', povCharacter: 'c2' } });
    assert.match(unnamed.writerText, /시점 인물: c2/);
    const none = compileDraftContract({ profile, identity: {}, episodePlan: { premise: '항구' } });
    assert.doesNotMatch(none.writerText, /시점 인물/);
  });

  it('compiles legacy planning objects into a stable bounded v2 contract', () => {
    const input = {
      profile: { revision: 3, tones: ['긴장', '건조'], format: { pov: '3인칭 제한' }, storyEngines: ['전술적 역전'], readabilityContract: { surfaceEase: 'easy', conceptPacing: 'slow', inferenceLoad: 'explicit', complexityRamp: 'onboarding-first' } },
      identity: { readerPromise: '불완전한 정보로 판을 뒤집는다', protagonistAppeal: '유능하지만 타인을 놓친다', emotionalDefect: '통제 집착', competenceSignature: ['오차 수정'] },
      writerSkill: { revision: 4, authorCraft: { judgments: ['선택의 비용을 먼저 본다'], dialogueConduct: ['대답 대신 관계를 바꾼다'] }, antiFixation: ['같은 증거를 반복하지 않는다'] },
    };
    const first = compileNarrativeContract(input);
    const second = compileNarrativeContract(structuredClone(input));
    assert.equal(first.schemaVersion, 2);
    assert.equal(first.digest, second.digest);
    assert.match(renderNarrativeContract(first), /불완전한 정보/);
    assert.match(renderNarrativeContract(first), /표면=easy.*개념=slow.*추론=explicit.*상승=onboarding-first/);
    assert.deepEqual(first.sourceRevisions, { storyProfile: 3, storyIdentity: null, writerSkill: 4 });
  });

  it('reduces arc and episode plans to intent rather than copying operational state', () => {
    const arc = compileArcIntent({ arcNumber: 1, revision: 2, title: '입학 시험', promise: '전술을 증명한다', status: 'active', episodes: [{ chapter: 1 }] });
    const episode = compileEpisodeIntent({
      chapter: 1,
      arcEpisode: { index: 1, pressure: '해질 때까지', cost: '부상' },
      episodePlan: { revision: 7, premise: '봉쇄된 시험장', exitValue: '팀을 얻는다', cast: ['hero'], scenes: [{ situation: '고립', choice: '구조', change: '점수 손실' }] },
    });
    assert.equal(arc.schemaVersion, 2);
    assert.equal(episode.schemaVersion, 2);
    assert.equal('status' in arc, false);
    assert.equal('revision' in episode, false);
  });

  it('maps the current structured episode fields without leaking object stringification', () => {
    const episode = compileEpisodeIntent({
      chapter: 4,
      episodePlan: {
        exitValue: { specificFutureValue: '주인공이 현장 출입권을 얻는다' },
        payoff: { promisePaid: '첫 의뢰를 끝낸다' },
        costCreatedByResolution: { immediate: '보증금이 묶인다', deferred: '감시 대상이 된다' },
        readerBridge: '계약에 실패하면 오늘 잘 곳을 잃는다.',
      },
    });
    assert.equal(episode.expectedChange, '주인공이 현장 출입권을 얻는다');
    assert.equal(episode.payoff, '첫 의뢰를 끝낸다');
    assert.equal(episode.cost, '보증금이 묶인다');
    assert.equal(episode.readerBridge, '계약에 실패하면 오늘 잘 곳을 잃는다.');
    assert.doesNotMatch(JSON.stringify(episode), /\[object Object\]/);
  });

});
