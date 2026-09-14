import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { foldCharacterDynamics } from '../src/core/character-dynamics.js';
import {
  foldLegacyChapterCharacterDynamics, renderSceneCharacterPacket,
} from '../src/core/character-dynamics-adapter.js';

const context = (overrides = {}) => ({
  snapshotId: 'rev-7', expectedHead: 'rev-7',
  storyTimeScope: { worldline: 'main', through: 20 },
  transactionTime: 200, policyRevision: 'proof-v1',
  semanticGeneration: 3, fencingToken: 9, ...overrides,
});

const model = {
  characterId: 'jiwon',
  valueOrder: ['선택권', '안전'],
  behaviorTraits: [{ id: 'control', trigger: '위험', actionBias: '대신 결정한다' }],
  dimensionBaselines: { unilateralControl: 3 },
};

const agenda = {
  characterId: 'jiwon', goal: '상대의 안전을 확보한다', hiddenPlan: '혼자 위험을 제거한다',
  nextAction: '계약을 대신 취소한다', deadline: 18, resources: ['권한'], deficits: ['신뢰'],
  knowledge: ['계약에는 위험 조항이 있다'], misbeliefs: ['상대는 위험을 모른다'],
  lineNotCrossed: '상대의 직업을 끝내지는 않는다', fallback: '위험 조항만 공개한다',
};

const event = (overrides = {}) => ({
  eventId: 'chapter-18-choice', sourceHash: 'sha256:chapter18', anchor: 'p12:l3-l8',
  characterId: 'jiwon', storyTime: 18, transactionTime: 101, worldline: 'main',
  interpretation: '보호한다는 명분으로 선택권을 빼앗았다',
  dimensionChanges: { unilateralControl: -1 }, nextChoiceBias: '정보를 공개하고 선택을 돌려준다',
  agendaUpdate: { nextAction: '위험 조항을 공개한다', prediction: '상대는 남기로 선택할 것이다' },
  behavioralProof: {
    hypothesis: '통제 대신 선택권을 존중한다', pressure: '상대가 남으면 자신이 해고된다',
    alternativesAvailable: ['계약을 몰래 취소한다', '위험 조항을 공개한다'],
    alternativesKnown: true, voluntary: true, chosen: '위험 조항을 공개한다', costPaid: '해고 위험',
    competingHypotheses: ['상사의 명령에 따랐다'], competingEvidence: ['상사는 취소를 지시했다'],
  },
  relationshipClaims: [{ from: 'jiwon', to: 'seonwoo', dimensions: { autonomyTrust: 1 },
    belief: '선우가 불리한 선택도 감당할 수 있다' }],
  ...overrides,
});

describe('CharacterDynamics seam', () => {
  it('observes and folds a costly voluntary choice into character, agenda, and directional relationship state', () => {
    const result = foldCharacterDynamics(context(), { models: [model], agendas: [agenda], events: [event()] });
    assert.equal(result.ok, true);
    assert.equal(result.value.characterStates.jiwon.dimensions.unilateralControl, 2);
    assert.equal(result.value.characterStates.jiwon.changeStatuses[0].status, 'tested-contested');
    assert.equal(result.value.agendas.jiwon.nextAction, '위험 조항을 공개한다');
    assert.equal(result.value.relationshipStates['jiwon->seonwoo'].dimensions.autonomyTrust, 1);
    assert.equal(result.value.relationshipStates['seonwoo->jiwon'], undefined);
    assert.deepEqual(result.value.characterStates.jiwon.influences[0], {
      eventId: 'chapter-18-choice', anchor: 'p12:l3-l8', storyTime: 18,
      interpretation: '보호한다는 명분으로 선택권을 빼앗았다',
      nextChoiceBias: '정보를 공개하고 선택을 돌려준다',
      behavioralProof: { hypothesis: '통제 대신 선택권을 존중한다', status: 'tested-contested', cost: '해고 위험' },
      relationshipBeliefs: [{ from: 'jiwon', to: 'seonwoo', belief: '선우가 불리한 선택도 감당할 수 있다' }],
    });
  });

  it('folds stable events exactly once even when observations are replayed', () => {
    const first = foldCharacterDynamics(context(), { models: [model], agendas: [agenda], events: [event()] });
    const replay = foldCharacterDynamics(context(), { models: [model], agendas: [agenda], previous: first.value, events: [event()] });
    assert.equal(replay.ok, true);
    assert.equal(replay.value.characterStates.jiwon.dimensions.unilateralControl, 2);
    assert.equal(replay.value.appliedEventIds.length, 1);
  });

  it('respects story time, transaction time, and worldline visibility', () => {
    const events = [
      event(),
      event({ eventId: 'future', storyTime: 21, dimensionChanges: { unilateralControl: -1 } }),
      event({ eventId: 'late-edit', transactionTime: 201, dimensionChanges: { unilateralControl: -1 } }),
      event({ eventId: 'branch', worldline: 'alternate', dimensionChanges: { unilateralControl: -1 } }),
    ];
    const result = foldCharacterDynamics(context(), { models: [model], agendas: [agenda], events });
    assert.equal(result.value.characterStates.jiwon.dimensions.unilateralControl, 2);
    assert.deepEqual(result.value.appliedEventIds, ['chapter-18-choice']);
  });

  it('rejects incomplete execution context and unstable event identity as typed failures', () => {
    const missingContext = foldCharacterDynamics({ snapshotId: 'x' }, { models: [model], agendas: [agenda], events: [] });
    assert.deepEqual(missingContext, { ok: false, error: { code: 'invalid_execution_context', missing: ['expectedHead', 'storyTimeScope', 'transactionTime', 'policyRevision', 'semanticGeneration', 'fencingToken'] } });
    const unstable = foldCharacterDynamics(context(), { models: [model], agendas: [agenda], events: [event({ eventId: '', sourceHash: '' })] });
    assert.equal(unstable.ok, false);
    assert.equal(unstable.error.code, 'unstable_event_identity');
  });

  it('produces canonical-equivalent state for incremental and full folds', () => {
    const events = Array.from({ length: 40 }, (_, index) => event({
      eventId: `e-${index}`, anchor: `p${index}:l1`, storyTime: index + 1,
      dimensionChanges: { unilateralControl: index % 2 ? 1 : -1 },
      behavioralProof: null, relationshipClaims: [], agendaUpdate: {},
    }));
    const full = foldCharacterDynamics(context({ storyTimeScope: { worldline: 'main', through: 40 } }), { models: [model], agendas: [agenda], events });
    const half = foldCharacterDynamics(context(), { models: [model], agendas: [agenda], events: events.slice(0, 20) });
    const incremental = foldCharacterDynamics(context({ storyTimeScope: { worldline: 'main', through: 40 } }), { models: [model], agendas: [agenda], previous: half.value, events: events.slice(20) });
    assert.deepEqual(incremental.value.characterStates, full.value.characterStates);
    assert.deepEqual(incremental.value.relationshipStates, full.value.relationshipStates);
    assert.deepEqual(incremental.value.agendas, full.value.agendas);
  });

  it('folds 10,000 synthetic episodes without losing exactly-once identity', () => {
    const events = Array.from({ length: 10_000 }, (_, index) => event({
      eventId: `long-${index}`, anchor: `episode-${index + 1}`, storyTime: index + 1,
      dimensionChanges: { unilateralControl: index % 2 ? 1 : -1 },
      behavioralProof: null, relationshipClaims: [], agendaUpdate: {},
    }));
    const started = performance.now();
    const result = foldCharacterDynamics(context({ storyTimeScope: { worldline: 'main', through: 10_000 } }), { models: [model], agendas: [agenda], events });
    assert.equal(result.ok, true);
    assert.equal(result.value.appliedEventIds.length, 10_000);
    assert.equal(result.value.characterStates.jiwon.dimensions.unilateralControl, 3);
    assert.equal(result.value.characterStates.jiwon.influences.length, 12);
    assert.ok(performance.now() - started < 1500);
  });

  it('adapts an accepted legacy chapter delta with stable provenance and replays it exactly once', () => {
    const foundation = {
      characters: [
        { id: 'jiwon', canonicalName: '지원', contradiction: '보호하려다 선택권을 빼앗는다', dramaticModel: model, agenda },
        { id: 'seonwoo', canonicalName: '선우', contradiction: '퇴로를 남기다 거절로 읽힌다' },
      ],
    };
    const delta = {
      chapterNumber: 18, appearedCharacterIds: ['jiwon', 'seonwoo'],
      mutableChanges: [{ characterId: 'jiwon', knownFactsAdded: ['선우는 위험 조항을 알고도 남았다'] }],
      relationshipOps: [{ from: 'jiwon', to: 'seonwoo', kind: '동료', state: '선택을 신뢰함' }],
    };
    const episodePlan = {
      chapter: 18, povCharacter: 'jiwon', cast: ['jiwon', 'seonwoo'],
      scenePressure: { choiceOwner: 'jiwon', incompatibleGoods: ['안전', '선택권'], decisionDeadline: '오늘' },
      entryState: { protagonistImmediateWant: '선우를 안전하게 한다' },
      carryForward: ['선우가 스스로 남았다'],
    };
    const acceptedObservation = {
      status: 'accepted', observationId: 'obs-18', sourceHash: 'sha256:chapter18',
      acceptedAt: 101, policyRevision: 'proof-v1',
      influenceEvents: [{
        characterId: 'jiwon', anchor: 'p12:l3-l8', interpretation: '상대의 선택을 믿어야 한다',
        dimensionChanges: { unilateralControl: -1 }, nextChoiceBias: '선택권을 돌려준다',
        behavioralProof: event().behavioralProof,
      }],
    };
    const first = foldLegacyChapterCharacterDynamics(context(), { foundation, delta, episodePlan, acceptedObservation });
    assert.equal(first.ok, true);
    assert.equal(first.value.characterStates.jiwon.dimensions.unilateralControl, 2);
    assert.equal(first.value.observationProvenance['obs-18'].sourceHash, 'sha256:chapter18');
    const replay = foldLegacyChapterCharacterDynamics(context(), { foundation, delta, episodePlan, acceptedObservation, previous: first.value });
    assert.equal(replay.ok, true);
    assert.equal(replay.value.characterStates.jiwon.dimensions.unilateralControl, 2);
    assert.equal(replay.value.appliedEventIds.length, first.value.appliedEventIds.length);
  });

  it('renders a bounded next-scene packet from current state and active cast only', () => {
    const folded = foldCharacterDynamics(context(), { models: [model], agendas: [agenda], events: [event()] });
    const packet = renderSceneCharacterPacket({
      projection: folded.value, cast: ['jiwon', 'seonwoo'], pressure: '해고를 감수하고 선택권을 돌려줄지 결정', maxInfluences: 2,
    });
    assert.match(packet, /지원|jiwon/);
    assert.match(packet, /위험 조항을 공개한다/);
    assert.match(packet, /선우가 불리한 선택도 감당할 수 있다/);
    assert.doesNotMatch(packet, /seonwoo->jiwon/);
    assert.ok(packet.length < 1800);
  });

  it('refuses to fold unaccepted observations into character truth', () => {
    const result = foldLegacyChapterCharacterDynamics(context(), {
      foundation: { characters: [{ id: 'jiwon', canonicalName: '지원' }] },
      delta: { chapterNumber: 18, mutableChanges: [], relationshipOps: [] }, episodePlan: {},
      acceptedObservation: { status: 'proposed', observationId: 'obs-x', sourceHash: 'sha256:x' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'observation_not_accepted');
  });
});
