import { mkdtemp, rm } from 'node:fs/promises';
import { after } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownStateStore } from '../../src/store/markdown-store.js';
import { runInit } from '../../src/tools/init.js';
import { WEBTOON_AREAS } from '../../src/core/webtoon-contract.js';

export const workId = 'webtoon-test';
export const answers = { ...Object.fromEntries(WEBTOON_AREAS.map(({ id }) => [id, `사용자 지정 방향 ${id}`])), W15: 'standard', W16: 'scroll' };
export const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAccAAAAASUVORK5CYII=', 'base64');
const testRoots = new Set();
after(async () => { for (const root of testRoots) await rm(root, { recursive: true, force: true }); });

export async function webtoonStore() {
  const root = await mkdtemp(join(tmpdir(), 'vibelore-webtoon-')); testRoots.add(root);
  const store = new MarkdownStateStore(root);
  await runInit({ store, workId, genre: 'other', worldFacts: ['문은 안에서만 열린다.'] });
  const foundation = await store.loadFoundation(workId);
  await store.saveFoundation({ ...foundation, characters: [{ id: 'hero', canonicalName: '윤', aliases: [], registeredAtChapter: 1,
    intrinsic: { gender: 'female', coreAppearance: ['짧은 머리'] }, mutable: { scars: ['미래의 상처'] } }] });
  await store.saveArtifact({ workId, chapterNumber: 1, title: '문', prose: '윤이 닫힌 문 앞에 멈췄다.\n\n윤이 문 안으로 말을 건넸다.' });
  await store.saveStoryState({ workId, chapterNumber: 1, scars: [], location: '문 밖' });
  await store.saveStoryProfile(workId, { status: 'active', revision: 1, narrativeContract: { readerPromise: '인물의 선택이 관계를 바꾼다.' } });
  return store;
}

export function plan(source) {
  const result = { textPolicyVersion: 1, title: '닫힌 문', promise: '말을 걸 용기', closingQuestion: '안에서 답할까?',
    adaptation: source.units.map(({ id }) => ({ sourceId: id, operation: 'keep', reason: '선택과 반응 보존' })),
    visualBible: { characters: [{ id: 'hero', anchors: ['짧은 머리'], performance: '비례 유지' }], environments: [{ id: 'door', description: '문 밖, 빛은 오른쪽' }] },
    sequences: [{ id: 'seq1', purpose: '멈춤에서 말걸기로', shots: source.units.map(({ id }, i) => ({
      id: `shot${i + 1}`, sourceIds: [id], characters: ['hero'], environmentId: 'door', storyTime: '1화', visualState: '상처 없음',
      action: i ? '문에 말을 건다' : '문 앞에 멈춘다', knowledgeBefore: [], knowledgeAfter: ['문은 닫혀 있다'],
      texts: i ? [{ kind: 'dialogue', speaker: 'hero', text: '안에 있나요?' }] : [], height: 640, gapAfter: 100,
    })) }] };
  result.editorial = editorial(source); result.panelCountReason = '선택 전후가 읽히는 두 컷';
  result.sequences[0].shots.forEach((shot, i) => Object.assign(shot, { beatIds: [result.editorial.beats[i].id], purpose: '선택을 보여준다', readerDelta: '행동이 변한다' }));
  return result;
}

export function editorial(source) {
  return { version: 1, focus: { primary: '말을 걸 용기', supporting: ['답을 기다리는 긴장'], tradeoff: '장소 설명보다 선택을 보여준다' },
    beats: source.units.map(({ id }, i) => ({ id: `beat${i + 1}`, sourceIds: [id], decision: 'expand', reason: '선택과 반응',
      readerChange: '멈춤에서 말걸기로', visualProof: '문을 보는 얼굴과 말거는 자세', carryForward: '문은 닫혀 있다' })) };
}

export function provider(options = {}) {
  const requests = [];
  return { requests, provenance: { kind: 'fixture', contextIsolation: 'unverified' },
    async complete(request) {
      requests.push(request);
      const data = JSON.parse(request.messages.at(-1).content);
      if (options.response) {
        const custom = options.response(request, data);
        if (custom !== undefined) return { text: typeof custom === 'string' ? custom : JSON.stringify(custom) };
      }
      let value = request.step === 'webtoon-editorial' ? editorial(data.source)
        : request.step === 'webtoon-plan' ? plan(data.source)
        : request.step === 'webtoon-interview' ? { answers: [{ id: 'W05', value: data.input.text, quote: data.input.text }], enabledBranches: [] }
        : request.step === 'webtoon-layout-analyze' ? { maps: data.shots.map(i => ({ shotId: i.shot.id, inputHash: i.inputHash, inspectedImages: true, evidence: 'Synthetic fixture geometry only', protected: [], entries: i.shot.texts.map((t, textIndex) => ({ textIndex, anchor: [0.5, 0.65], candidates: [[0.5, 0.35]], confidence: 1, reason: 'Synthetic fixture anchor' })) })) }
        : { ...data.schema, inspectedImages: true, findings: [] };
      if (request.step === 'webtoon-plan' && data.editorial) {
        value = { ...value, editorial: data.editorial, panelCountReason: '선택 전후가 읽히는 두 컷' };
        value.sequences[0].shots.forEach((shot, i) => Object.assign(shot, { beatIds: [data.editorial.beats[i].id], purpose: '선택을 보여준다', readerDelta: '행동이 변한다' }));
      }
      return { text: JSON.stringify(value) };
    },
  };
}
