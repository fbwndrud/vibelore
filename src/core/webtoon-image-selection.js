import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { readJson, atomicWrite } from '../store/webtoon-store.js';
import { digest, nonempty } from './webtoon-contract.js';
import { validateImageRuntime, sceneImagePolicy, savedSceneSelection } from './webtoon-images.js';
import { webtoonMessage } from './webtoon-language.js';
import { SCENE_PRODUCTION_MODE } from './webtoon-scene.js';
import { webtoonDelegation } from './webtoon-delegation.js';

const RUNTIME_REQUEST = { host: 'host id, e.g. codex', options: [{ id: 'option id', execution: 'host-built-in | api', provider: 'e.g. codex, openai, google, local',
  tool: 'built-in tool name (host-built-in only)', modelSelectable: 'boolean: does this path take a model argument', models: ['model ids this path accepts (empty when not selectable)'],
  credential: 'env var the API path needs (api only, name only, never the value)', note: 'what the host actually knows, e.g. which model its built-in tool uses' }] };

function imageChoiceNotice(source, policy) {
  const model = policy.targetModel ?? webtoonMessage(source, `호스트가 정함(${policy.tool}에 모델 선택 인자 없음)`, `chosen by the host (${policy.tool} has no model argument)`);
  const note = policy.hostNote ? ` ${webtoonMessage(source, '호스트 설명', 'Host note')}: ${policy.hostNote}` : '';
  const keep = webtoonMessage(source, ' 선택은 이 작품의 다음 장면·회차에도 유지되며, 실패해도 다른 경로로 자동 전환하지 않습니다.',
    ' The choice persists for this work\'s next scenes and chapters; a failure never switches to another path automatically.');
  if (policy.execution === 'host-built-in') return webtoonMessage(source,
    `${policy.host} 내장 ${policy.tool}로 그립니다. 호스트 사용량(구독) 안에서 실행되며 별도 API 과금은 없습니다. 모델: ${model}.`,
    `Draws with ${policy.host}'s built-in ${policy.tool} inside the host's own usage (subscription); no separate API billing. Model: ${model}.`) + note + keep;
  return webtoonMessage(source,
    `${policy.provider} API ${model}로 그립니다. 별도 API 과금이 붙고 실행 환경의 ${policy.credential ?? 'API 키'}가 필요하며, 원작·참조 이미지를 ${policy.provider}에 전송합니다.`,
    `Draws with the ${policy.provider} API model ${model}. Separate API billing applies, the host needs ${policy.credential ?? 'an API key'}, and the source and reference images are sent to ${policy.provider}.`) + note + keep;
}

/** The host reports its image paths, the user picks one (built-in proposed first), and the answer is kept for this work. */
export async function confirmedWebtoonSelection(repo, args, source, { tool = 'lore_webtoon_scene', productionMode = SCENE_PRODUCTION_MODE } = {}) {
  const delegation = webtoonDelegation(args.delegation);
  const apiForbidden = args.apiRestriction === 'forbid' || delegation?.apiPolicy === 'forbid';
  const kept = args.changeImageChoice ? null : savedSceneSelection(await readJson(repo.path('image-selection.json')), args.workId);
  if (kept && !(apiForbidden && kept.policy.execution !== 'host-built-in')) return kept;
  const base = { lane: 'webtoon', productionMode, jobs: [] };
  const pendingPath = repo.path('image-choice-pending.json');
  const pending = await readJson(pendingPath);
  // A proposal is confirmed by its id; the host need not resend the runtime report it already made.
  const byId = args.confirmImageChoice !== undefined && args.imageRuntime === undefined && args.imageOption === undefined && args.imageModel === undefined;
  if (args.imageRuntime === undefined && !byId) return { ...base, status: 'needs_image_runtime', runtimeRequest: RUNTIME_REQUEST,
    nextAction: webtoonMessage(source,
      '이 호스트에서 실제로 쓸 수 있는 이미지 생성 경로(내장 도구, API)와 각 경로가 받는 모델을 확인해 imageRuntime으로 같은 요청을 다시 호출하세요. 모르는 것은 추측하지 말고 note에 그대로 적습니다.',
      'Check which image paths this host really offers (built-in tools, APIs) and the models each accepts, then call the same request again with imageRuntime. Do not guess; write what is unknown in note.') };
  const runtime = byId ? null : validateImageRuntime(args.imageRuntime);
  const policy = byId ? pending?.policy : sceneImagePolicy(runtime, args.imageOption, args.imageModel);
  if (args.confirmImageChoice === undefined) {
    const choice = pending?.workId === args.workId && digest(pending.policy) === digest(policy) ? pending
      : { id: `wic-${randomUUID()}`, workId: args.workId, policy, options: runtime.options, proposed: { optionId: policy.optionId, model: policy.targetModel },
        remember: 'this-work', proposedAt: new Date().toISOString(), notice: imageChoiceNotice(source, policy) };
    if (choice !== pending) await atomicWrite(pendingPath, JSON.stringify(choice, null, 2));
    if (delegation && (policy.execution === 'host-built-in' || (!apiForbidden && delegation.apiPolicy === 'allow'))) {
      const confirmed = { workId: args.workId, policy, selection: { id: choice.id, workId: args.workId, policyHash: digest(policy),
        confirmedAt: new Date().toISOString(), userAnswer: delegation.userAnswer, authority: 'delegated', delegation,
        billing: policy.billing, scope: 'this-work-until-user-changes', preserveReferences: false, source: tool } };
      await atomicWrite(repo.path('image-selection.json'), JSON.stringify(confirmed, null, 2));
      await rm(pendingPath, { force: true });
      return { policy, saved: confirmed };
    }
    return { ...base, status: 'needs_image_choice', imageChoice: choice,
      ...(delegation || apiForbidden ? { blockedBy: apiForbidden ? 'api-forbidden' : 'new-api-cost', delegation } : {}),
      nextAction: webtoonMessage(source,
        'options 전체와 제안(proposed)·notice를 사용자에게 보여 주세요. 사용자가 다른 경로나 모델을 고르면 imageOption·imageModel을 바꿔 다시 제안받고, 확정하면 같은 요청 인자에 confirmImageChoice ID와 원답 feedback을 넣어 다시 호출하세요.',
        'Show the user every option, the proposal and the notice. If they pick another path or model, call again with imageOption/imageModel for a new proposal; once they choose, call the same request again with confirmImageChoice and their own answer in feedback.') };
  }
  if (apiForbidden && policy?.execution !== 'host-built-in') throw new Error('WEBTOON_API_FORBIDDEN');
  if (!pending || !policy || pending.id !== args.confirmImageChoice || pending.workId !== args.workId || digest(pending.policy) !== digest(policy)) throw new Error('STALE_IMAGE_CHOICE');
  if (!nonempty(args.feedback)) throw new Error('IMAGE_CHOICE_USER_ANSWER_REQUIRED');
  const confirmed = { workId: args.workId, policy, selection: { id: pending.id, workId: args.workId, policyHash: digest(policy), confirmedAt: new Date().toISOString(),
    userAnswer: args.feedback, billing: policy.billing, scope: 'this-work-until-user-changes', preserveReferences: false, source: tool } };
  await atomicWrite(repo.path('image-selection.json'), JSON.stringify(confirmed, null, 2));
  await rm(pendingPath, { force: true });
  return { policy, saved: confirmed };
}
