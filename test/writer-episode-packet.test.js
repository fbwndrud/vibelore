import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileWriterEpisodePacket } from '../src/core/writer-episode-packet.js';

function activePlan() {
  return {
    workId: 'bench-loop', chapter: 6, revision: 2, status: 'active', createdAt: '2026-08-27T00:00:00.000Z',
    title: '종료 휘슬 다음의 전반 8분', premise: '승리 뒤 시간이 다시 돌아온다.',
    openingState: '한겸만 반복을 기억한다고 믿는다.', closingState: '세 사람의 이름이 명단에서 삭제된다.',
    cast: ['han-gyeom', 'kang-taejun', 'seo-yura'],
    entryState: { activeQuestion: '왜 다시 돌아왔는가?', protagonistImmediateWant: '동료를 통제하지 않고 원인을 확인한다.', tickingLoss: '전반 8분 전에 선택해야 한다.' },
    scenePressure: { choiceOwner: 'han-gyeom', incompatibleGoods: ['검증된 승리', '동료의 선택권'], decisionDeadline: '전반 8분' },
    readerExpectation: { likelyOutcome: '한겸이 정답을 재현한다.', evidenceOnPage: ['이전 전술을 기억한다.'] },
    payoff: { promisePaid: '시간이 8분을 넘어간다.', proofOnPage: '전광판이 08:01을 표시한다.', notJustReported: true },
    turn: { brokenBelief: '승리하면 반복이 끝난다.', causedByChoice: '한겸이 지시하지 않는다.', priorClueReinterpreted: '동료들의 기억 조각' },
    costCreatedByResolution: { immediate: '세 사람이 공모자로 지목된다.', deferred: '구단의 공식 적이 된다.', beneficiary: '선수단', payer: '한겸·강태준·서유라' },
    exitValue: { closedQuestion: '8분을 넘을 수 있는가?', nextQuestion: '봉쇄된 경기장에서 증거를 지킬 수 있는가?', specificFutureValue: '출입문 봉쇄와 명단 삭제' },
    reveals: ['서유라와 강태준도 일부를 기억한다.'], withheld: ['반복의 최종 원인'],
    scenes: [
      { order: 1, situation: '서유라가 증거 위치를 먼저 말한다.', choice: '한겸은 기억 조각을 먼저 말하게 한다.', change: '반복이 세 사람의 선택과 연결된다.' },
      { order: 2, situation: '부상과 증거 공개는 각자의 자리를 위협한다.', choice: '강태준과 서유라가 공개 시점을 직접 정한다.', change: '선발과 증거 소유권이 바뀐다.' },
      { order: 3, situation: '새 선발이 압박 함정에 걸린다.', choice: '한겸은 강태준에게 판단을 넘긴다.', change: '08:01과 경기장 봉쇄가 함께 온다.' },
    ],
  };
}

describe('Writer Episode Packet Compiler', () => {
  it('compiles the same active plan into a byte-stable focus packet without operational or JSON leakage', () => {
    const plan = activePlan();
    plan.characterArcBeats = [{ characterId: 'han-gyeom', beat: 'wound', note: '정답을 강요하지 않는다.' }];
    const input = { episodePlan: plan, arcEpisode: { chapter: 6, goal: '8분을 넘는다.', conflict: '선택권을 통제하고 싶은 유혹' }, characterNames: { 'han-gyeom': '한겸' } };
    const first = compileWriterEpisodePacket(input);
    const second = compileWriterEpisodePacket(structuredClone(input));

    assert.equal(first.ok, true);
    assert.equal(first.value.writerText, second.value.writerText);
    assert.equal(first.value.trace.obligationHash, second.value.trace.obligationHash);
    const changedArc = compileWriterEpisodePacket({ ...input, arcEpisode: { ...input.arcEpisode, goal: '다른 Arc 의무' } });
    assert.notEqual(first.value.trace.obligationHash, changedArc.value.trace.obligationHash);
    assert.match(first.value.writerText, /## Reader Contract/);
    assert.match(first.value.writerText, /## Episode Core/);
    assert.match(first.value.writerText, /## Writer Freedom/);
    assert.doesNotMatch(first.value.writerText, /## 인과 진행/);
    assert.match(first.value.writerText, /08:01/);
    assert.match(first.value.writerText, /한겸: 이번 화 변화=wound — 정답을 강요하지 않는다\./);
    assert.match(first.value.writerText, /정확한 대사와 미세 행동/);
    assert.doesNotMatch(first.value.writerText, /workId|createdAt|revision|"scenePressure"|sha256:/);
    assert.deepEqual(first.value.trace.includedFields.includes('costCreatedByResolution.immediate'), true);
    assert.ok(first.value.usage.usedTokens <= first.value.usage.maxTokens);
  });

  it('fails closed instead of trimming mandatory obligations when the packet budget is too small', () => {
    const result = compileWriterEpisodePacket({ episodePlan: activePlan(), arcEpisode: { chapter: 6 }, budget: { maxTokens: 20 } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'EPISODE_PACKET_OVERFLOW');
    assert.ok(result.error.requiredTokens > result.error.maxTokens);
  });

  it('keeps only foreground voice targets inside the smaller default packet budget', () => {
    const plan = activePlan();
    plan.foregroundCharacters = ['han-gyeom'];
    plan.episodeVoiceTargets = ['han-gyeom', 'kang-taejun', 'seo-yura'].map((characterId, index) => ({
      characterId,
      sceneOrder: index + 1,
      speakingPressure: '진형이 무너지는 동안 자기 보호 대상과 팀 명령 중 하나를 골라야 한다.',
      surfaceIntent: '현재 위치와 다음 행동을 상대에게 납득시킨다.',
      hiddenIntent: '자신이 감춘 별도 계획과 두려움은 들키지 않으려 한다.',
      sampleLine: '지시는 들었어. 하지만 네 계산표에 없는 사람부터 데리고 나간다.',
      narrationFilter: '시점 인물은 말의 감정보다 달라진 위치와 장비를 먼저 보고 숨은 의도를 뒤늦게 추론한다.',
    }));

    const result = compileWriterEpisodePacket({ episodePlan: plan, arcEpisode: { chapter: 6 } });
    assert.equal(result.ok, true);
    assert.ok(result.value.usage.usedTokens <= result.value.usage.maxTokens);
    assert.equal(result.value.usage.maxTokens, 1400);
    assert.match(result.value.writerText, /## Voice Targets/);
    assert.match(result.value.writerText, /han-gyeom/);
    assert.doesNotMatch(result.value.writerText, /kang-taejun|seo-yura/);
  });

  it('adapts a legacy active plan from existing fields and records every derived obligation', () => {
    const legacy = {
      status: 'active', chapter: 1, revision: 1, title: '첫 고지', premise: '윤재가 세금 규칙을 체험한다.',
      povCharacter: 'hero', cast: ['hero'], openingState: '규칙을 모른다.', closingState: '납부 기한을 안다.',
      arcBeat: { goal: '전진', conflict: '세금', cost: '채무' },
      scenes: [
        { order: 1, objective: '규칙 확인', obstacle: '세금 고지', turn: '고지서를 받는다.', outcome: '채무가 생긴다.' },
        { order: 2, objective: '납부', obstacle: '돈이 부족하다.', turn: '감별을 쓴다.', outcome: '조건을 얻는다.' },
      ],
      reveals: [], withheld: [],
    };
    const result = compileWriterEpisodePacket({ episodePlan: legacy, arcEpisode: { chapter: 1, ...legacy.arcBeat }, budget: { maxTokens: 900 } });
    assert.equal(result.ok, true);
    assert.match(result.value.writerText, /규칙 확인 → 세금 고지 → 고지서를 받는다\./);
    assert.match(result.value.writerText, /지급할 결과: 납부 기한을 안다\./);
    assert.match(result.value.writerText, /남는 비용: 채무/);
    assert.ok(result.value.trace.derivedFields.some((item) => item.field === 'payoff.promisePaid' && item.derivedFrom === 'closingState'));
    assert.ok(result.value.trace.derivedFields.some((item) => item.field === 'costCreatedByResolution.immediate' && item.derivedFrom === 'arcBeat.cost'));
  });

  it('rejects an active but dramatically incomplete plan with exact missing obligations', () => {
    const result = compileWriterEpisodePacket({ episodePlan: { status: 'active', chapter: 3, premise: '', scenes: [] }, arcEpisode: { chapter: 3 } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MANDATORY_EPISODE_FIELD_MISSING');
    assert.ok(result.error.missing.includes('premise'));
    assert.ok(result.error.missing.includes('scenes[2+]'));
    assert.ok(result.error.missing.includes('payoff'));
    assert.ok(result.error.missing.includes('exit'));
  });

  it('merges a closing state already paid as the payoff instead of repeating it to the writer', () => {
    const plan = activePlan();
    plan.closingState = plan.payoff.promisePaid;
    plan.exitValue.specificFutureValue = plan.payoff.promisePaid;
    const result = compileWriterEpisodePacket({ episodePlan: plan, arcEpisode: { chapter: 6 } });
    assert.equal(result.ok, true);
    assert.equal(result.value.writerText.match(/시간이 8분을 넘어간다\./g)?.length, 1);
    assert.ok(result.value.trace.mergedFields.some((item) => item.field === 'exitValue.specificFutureValue' && item.mergedInto === 'payoff.promisePaid'));
  });
});
