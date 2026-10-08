// Opt-in live companion for the existing night-stop fixture. All paid work uses
// the engine outbox; reruns reuse command IDs and never resend unknown outcomes.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv, parseArgs } from 'node:util';
import { openStudio } from '../src/engine/index.js';
import { runWorker } from '../src/engine/worker.js';
import { googleProvider } from '../src/providers/google.js';

export const voiceIntents = {
  seoyun: { voice: 'Kore', style: '젊은 여성. 맑고 단단한 중저음, 겉으로 담담하지만 기대와 그리움이 비치는 말투.' },
  minjae: { voice: 'Puck', style: '젊은 남성. 밝고 살짝 장난기 있으나 상대를 배려하는 편안한 말투.' },
  eunseo: { voice: 'Leda', style: '젊은 여성. 부드럽고 섬세하며 망설임이 묻어나는 말투. 감정을 과장하지 않는다.' },
  doyun: { voice: 'Orus', style: '젊은 남성. 낮고 또렷하며 침착하고 믿음직한 말투. 퉁명스럽지 않게.' },
  narrator: { voice: 'Sulafat', style: '따뜻하고 깊은 여성 해설. 서정적인 한국 라디오 드라마의 내레이터. 차분한 호흡으로 장면을 건넨다.' },
  driver: { voice: 'Charon', style: '중년 남성 버스 기사. 깊고 여유로운 목소리, 정중하고 조금 신비로운 온기. 안내 방송처럼 기계적으로 읽지 않는다.' },
};
const emotions = [
  '고요한 밤의 도입. 장면을 보여 주듯 차분하게.',
  '확신을 구하는 작은 설렘. 끝의 질문을 자연스럽게 올린다.',
  '표에 적힌 신기한 내용을 친구에게 알려 준다.',
  '처음엔 불쑥 희망, 이어 사과할 사람을 떠올리며 조금 작아진다.',
  '친구를 다독이듯 현실적인 설명을 건넨다.',
  '엄마를 떠올리는 짧은 숨, 이어 조용한 결심.',
  '기다려 주는 듯 여유롭고 정중한 질문.',
  '친구들과 함께 가고 싶은 마음으로 조심스럽게 묻는다.',
  '비밀을 알려 주듯 부드럽고 확신 있게.',
  '망설임을 내려놓고 친구의 선택을 지지한다. 마지막은 작은 안도.',
  '부담을 맡아 주듯 편안하고 든든하게.',
  '잔잔한 경이. 마지막 바다가 열리는 이미지를 여운 있게 전한다.',
];
export function googleScene(origin) {
  return {
    ...origin, id: 'google-scene', productionId: 'google-live', title: '함께 돌아오는 표 · Google TTS',
    occurrences: origin.occurrences.map(o => ({ ...o, id: `google-${o.id}` })),
    presentations: origin.presentations.map(p => ({ ...p, occurrenceId: `google-${p.occurrenceId}` })),
    utterances: origin.utterances.map((u, i) => {
      const role = origin.occurrences.find(o => o.id === u.speakerOccurrenceId).roleBindingId;
      return { ...u, id: `google-${u.id}`, speakerOccurrenceId: `google-${u.speakerOccurrenceId}`,
        addresseeOccurrenceIds: u.addresseeOccurrenceIds.map(id => `google-${id}`),
        holdMs: [420, 160, 120, 180, 140, 300, 320, 140, 240, 180, 120, 360][i],
        acting: `한국어 원어민의 자연스러운 서울말. ${voiceIntents[role].style} ${emotions[i]} 대화는 평소 대화 속도로, 문장 안 쉼은 짧고 자연스럽게. 대사 텍스트만 정확히 말한다. 연기 지시나 역할 이름을 읽지 않는다.` };
    }),
    shots: origin.shots.map(sh => ({ ...sh, id: `google-${sh.id}`, referenceSlotId: null })),
  };
}

export async function renderGoogleEdition({ service, projectId, edition, command }) {
  const snapshot = await service.snapshot(projectId);
  const outputs = snapshot.aggregates.filter(a => a.kind === 'editionOutput')
    .map(a => a.value).filter(o => o.editionId === edition.id && o.closureDigest === edition.closureDigest);
  const completed = outputs.find(o => o.status === 'completed');
  if (completed) return completed;
  const renderId = outputs.length ? `${edition.id}-${crypto.randomUUID()}` : edition.id;
  return command('edition.render', 'editionOutput', renderId, { editionId: edition.id, renderId });
}

export async function convertGoogleDemo({ directory, assets, output, key, phase = 'first', cue = 0, projectId = 'night-stop', fetchImpl = fetch }) {
  if (!key || !['first', 'complete'].includes(phase)) throw Error('Configured key and explicit phase first/complete required.');
  if (!Number.isInteger(cue) || cue < 0 || cue > 11) throw Error('Cue must be an integer from 0 to 11.');
  await mkdir(output, { recursive: true });
  const transportPath = join(output, 'transport-receipt.json');
  const transport = JSON.parse(await readFile(transportPath, 'utf8').catch(e => { if (e.code === 'ENOENT') return '[]'; throw e; }));
  const provider = googleProvider({ key, fetchImpl: async (...args) => {
    const record = { startedAt: new Date().toISOString() };
    transport.push(record);
    await writeFile(transportPath, JSON.stringify(transport, null, 2));
    try {
      const response = await fetchImpl(...args);
      record.httpStatus = response.status;
      const data = await response.clone().json().catch(() => null);
      if (data?.error) {
        record.errorStatus = ['INVALID_ARGUMENT', 'RESOURCE_EXHAUSTED', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'NOT_FOUND', 'UNAVAILABLE', 'INTERNAL'].includes(data.error.status) ? data.error.status : 'other';
        const message = String(data.error.message ?? '').toLowerCase();
        record.categories = ['model', 'quota', 'billing', 'permission', 'api key', 'response_format', 'sample_rate', 'speech_config', 'store', 'stream', 'input', 'unsupported', 'unknown', 'not found'].filter(s => message.includes(s));
      }
      record.completedAt = new Date().toISOString();
      await writeFile(transportPath, JSON.stringify(transport, null, 2));
      return response;
    } catch (error) {
      record.networkFailure = true;
      const code = error.cause?.code;
      record.transportCode = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) ? code : 'other';
      await writeFile(transportPath, JSON.stringify(transport, null, 2));
      throw error;
    }
  } });
  const service = await openStudio({ directory, providers: { google: provider } });
  async function cmd(type, kind, id, payload, stable = null) {
    const s = await service.snapshot(projectId);
    return (await service.command({ projectId, commandId: stable ?? crypto.randomUUID(), aggregate: { kind, id }, expectedRevision: stable ? 0 : (s.aggregates.find(a => a.kind === kind && a.id === id)?.revision ?? 0), type, payload })).value;
  }
  async function receipt() {
    const s = await service.snapshot(projectId), attempts = s.attempts.filter(a => a.request.productionId === 'google-live');
    const result = { productionId: 'google-live', model: 'gemini-3.8-flash-tts', voiceIntents, budget: s.budget,
      actualBillingVerified: false, attempts, candidates: s.candidates.filter(c => c.productionId === 'google-live' && c.mediaKind === 'audio'),
      reservations: s.reservations.filter(r => attempts.some(a => a.id === r.attemptId)),
      adoptions: s.adoptions.filter(a => a.slotId.startsWith('google-')) };
    await writeFile(join(output, 'live-receipt.json'), JSON.stringify(result, null, 2));
    return s;
  }
  try {
    let snapshot = await service.snapshot(projectId);
    if (snapshot.budget.budgetMicros === 0)
      await cmd('project.budget.set', 'project', projectId, { budgetMicros: 1000000 });
    const base = JSON.parse(await readFile(join(assets, 'landscape-closure.json'), 'utf8')).closure;
    const desired = googleScene(base.scenes[0]);
    if (!snapshot.productions.some(p => p.id === 'google-live'))
      await cmd('production.create', 'production', 'google-live', { id: 'google-live', title: '밤의 정류장 · Google Gemini 3.8 TTS', sourcePackageId: base.sourcePackage.id });
    for (const [roleId, { voice }] of Object.entries(voiceIntents)) {
      snapshot = await service.snapshot(projectId);
      const id = `google-${roleId}`;
      if (!snapshot.aggregates.some(a => a.kind === 'casting' && a.id === id))
        await cmd('casting.set', 'casting', id, { id, scope: 'production', productionId: 'google-live', roleId, state: null, voice });
    }
    snapshot = await service.snapshot(projectId);
    if (!snapshot.scenes.some(s => s.id === desired.id)) await cmd('scene.put', 'scene', desired.id, desired);
    for (let i = 0; i < 6; i++) {
      snapshot = await service.snapshot(projectId);
      const slot = { id: `google-image${i}`, scope: { kind: 'scene', id: desired.id }, subject: { kind: 'environment', id: 'night-stop' }, appearanceStateRef: null };
      if (!snapshot.candidates.some(c => c.id === `google-picture${i}`))
        await cmd('asset.import', 'assetSlot', slot.id, { id: `google-picture${i}`, slot, mediaKind: 'image', bytes: [...await readFile(join(assets, `art-${i}.png`))], actor: 'authorized-google-conversion' });
      if (!snapshot.slots.some(s => s.id === slot.id && s.candidateId === `google-picture${i}`))
        await cmd('candidate.adopt', 'assetSlot', slot.id, { slotId: slot.id, candidateId: `google-picture${i}`, actor: 'authorized-google-conversion', reason: 'Reuse existing illustration in independent Google production scope.' });
    }
    snapshot = await service.snapshot(projectId);
    if (snapshot.scenes.find(s => s.id === desired.id).shots.some(sh => !sh.referenceSlotId)) {
      desired.shots = desired.shots.map((sh, i) => ({ ...sh, referenceSlotId: `google-${base.scenes[0].shots[i].referenceSlotId}` }));
      await cmd('scene.put', 'scene', desired.id, desired);
    }
    const scene = (await service.snapshot(projectId)).scenes.find(s => s.id === desired.id);
    const indices = phase === 'first' ? [cue] : scene.utterances.map((_, i) => i);
    for (const i of indices) {
      const u = scene.utterances[i];
      snapshot = await service.snapshot(projectId);
      // A drain may not silently dispatch any other queued work.
      if (snapshot.attempts.some(a => a.status === 'prepared')) throw Error('Existing queued work must be handled explicitly before this runner.');
      const roleId = scene.occurrences.find(o => o.id === u.speakerOccurrenceId).roleBindingId;
      const subscriberId = `google-request-${i}`;
      const job = await cmd('generation.request', 'generation', subscriberId, {
        subscriberId, target: { kind: 'utterance', id: u.id }, provider: 'google', kind: 'audio',
        context: { accountId: 'configured-google', policyRevision: 'studio-v1', authorizationRevision: 'google-live-v1', sourceVisibility: 'selected' },
        input: { model: 'gemini-3.8-flash-tts', prompt: u.text, config: { voice: voiceIntents[roleId].voice, acting: u.acting } },
        recipe: { operation: 'generate' }, estimateMicros: 10000, intent: 'reuse_or_generate',
      }, `google-generate-${i}`);
      const queued = (await service.snapshot(projectId)).jobs.find(j => j.id === job.id);
      await runWorker({ service, drain: true, projectId, attemptId: queued.currentAttemptId });
      snapshot = await receipt();
      const currentJob = snapshot.jobs.find(j => j.id === job.id);
      const attempt = snapshot.attempts.find(a => a.id === currentJob.currentAttemptId);
      const candidate = snapshot.candidates.find(c => c.attemptId === attempt.id);
      if (attempt.status !== 'succeeded' || !attempt.operationId || !candidate || candidate.validation.status !== 'passed' || candidate.mime !== 'audio/wav')
        throw Error(`Stopped without retry: cue ${i}, status ${attempt.status}, validation ${attempt.validationStatus ?? 'absent'}.`);
      const slot = { id: `google-audio${i}`, scope: { kind: 'scene', id: scene.id }, subject: { kind: 'role', id: roleId }, appearanceStateRef: null, castingStateRef: null, utteranceId: u.id };
      if (!snapshot.slots.some(s => s.id === slot.id && s.candidateId === candidate.id))
        await cmd('candidate.adopt', 'assetSlot', slot.id, { slotId: slot.id, slot, candidateId: candidate.id, actor: 'authorized-google-conversion', reason: 'Authorized Google conversion; WAV decode and exact requested text/voice intent checked. Listening, acting, transcription and returned voice remain unverified.' });
      await writeFile(join(output, `google-take${i}.wav`), await service.readBlob(projectId, candidate.blobId));
      await receipt();
      console.log(JSON.stringify({ cue: i, roleId, voice: voiceIntents[roleId].voice, candidateId: candidate.id, operationId: attempt.operationId, durationSeconds: candidate.metadata.durationSeconds, status: 'validated-and-adopted' }));
    }
    if (phase === 'first') return;
    snapshot = await service.snapshot(projectId);
    if (!snapshot.aggregates.some(a => a.kind === 'timeline' && a.id === 'google-live'))
      await cmd('timeline.update', 'timeline', 'google-live', { productionId: 'google-live', fps: 30 });
    for (const profile of ['audio', 'landscape']) {
      const id = `google-live-${profile}`;
      snapshot = await service.snapshot(projectId);
      let edition = snapshot.editions.find(e => e.id === id);
      if (!edition) edition = await cmd('edition.create', 'edition', id, { id, productionId: 'google-live', profile });
      await writeFile(join(output, `${id}-closure.json`), JSON.stringify(edition, null, 2));
      console.log(`Rendering or reusing ${profile}, ${edition.closure.timeline.durationFrames / 30}s`);
      const rendered = await renderGoogleEdition({ service, projectId, edition, command: cmd });
      if (rendered.status !== 'completed') throw Error(`Render incomplete: ${profile}`);
      await writeFile(join(output, `night-stop-google.${profile === 'audio' ? 'wav' : 'mp4'}`), await service.readBlob(projectId, rendered.manifest.output.blobId));
      await writeFile(join(output, `${id}-manifest.json`), JSON.stringify(rendered, null, 2));
      console.log(`Completed ${profile}: ${rendered.manifest.durationSeconds}s`);
    }
    await receipt();
  } finally { await service.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { project: { type: 'string' }, assets: { type: 'string' }, output: { type: 'string' }, 'env-file': { type: 'string' }, phase: { type: 'string' }, cue: { type: 'string', default: '0' }, 'project-id': { type: 'string', default: 'night-stop' } } });
    if (!values.project || !values.assets || !values.output || !values.phase) throw Error('Explicit project, assets, output and phase required.');
    // Read only the explicitly configured key. No dotenv copying or credential search.
    const key = values['env-file'] ? parseEnv(await readFile(values['env-file'], 'utf8')).GOOGLE_API_KEY : process.env.GOOGLE_API_KEY;
    await convertGoogleDemo({ directory: resolve(values.project), assets: resolve(values.assets), output: resolve(values.output), key, phase: values.phase, cue: Number(values.cue), projectId: values['project-id'] });
  } catch (error) { console.error(error.code ?? 'GOOGLE_DEMO_STOPPED'); process.exitCode = 1; }
}
