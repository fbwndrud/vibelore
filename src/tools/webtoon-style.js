import { randomUUID } from 'node:crypto';
import { WebtoonStore } from '../store/webtoon-store.js';
import { WebtoonStyleStore, verifyStyleImage } from '../store/webtoon-style-store.js';
import { digest, nonempty, safeId } from '../core/webtoon-contract.js';
import { importWebtoonImages } from '../core/webtoon-board.js';
import { confirmedWebtoonSelection } from '../core/webtoon-image-selection.js';
import { sceneImageRequest, validateSceneImageProvenance } from '../core/webtoon-images.js';
import { isEnglish, SCENE_LIMITS } from '../core/webtoon-scene.js';
import { webtoonMessage, languageTag } from '../core/webtoon-language.js';
import { webtoonDelegation, delegatesStyleChoice, styleDecisionStage } from '../core/webtoon-delegation.js';

const MODE = 'style-preview-v1';
const previewBinding = c => digest({ workId: c.workId, proposalId: c.proposalId, parentRevisionId: c.parentRevisionId,
  brief: c.brief, direction: c.direction, references: c.references, imagePolicy: c.imagePolicy, imageSelection: c.imageSelection });
const publicCandidate = c => ({ proposalId: c.proposalId, status: c.status, parentRevisionId: c.parentRevisionId,
  brief: c.brief, direction: c.direction, image: c.image ?? null, revisionId: c.revisionId ?? null,
  delegation: c.delegation ?? null, apiRestriction: c.apiRestriction ?? c.delegation?.apiPolicy ?? 'existing-only',
  maxAutoRevisions: c.maxAutoRevisions ?? c.delegation?.maxAutoRevisions ?? null, decisionHistory: c.decisionHistory ?? [] });
const previewBlocked = c => c.status === 'needs_style_image' && (c.apiRestriction ?? c.delegation?.apiPolicy) === 'forbid' && c.imagePolicy?.execution !== 'host-built-in';
const blockedNotice = source => webtoonMessage(source, '최신 비용 제한으로 새 API 호출을 발급하지 않습니다. 기존 후보를 보존하고 허용된 경로로 새 예시를 제안하세요.',
  'The latest cost constraint blocks new API calls. Keep this candidate and propose a sample on an allowed path.');

const decisionNotice = (source, c) => webtoonMessage(source,
  delegatesStyleChoice(c.delegation) ? '호스트가 실제 예시를 열고 선택 이유를 choice에 기록해 approve하세요. 위임받은 선택이므로 사용자 확인을 다시 요구하지 않습니다.'
    : '실제 예시 이미지를 보여 주고 사용자 선택을 기다리세요.',
  delegatesStyleChoice(c.delegation) ? 'Open the actual sample, record your choice rationale in choice, then approve under the user delegation without asking again.'
    : 'Show the actual sample and wait for the user to choose.');

async function previewJob(repo, c) {
  for (const ref of c.references) {
    const image = (await importWebtoonImages(repo.store.rootDir, [{ shotId: ref.id, path: ref.path }], [ref.id]))[ref.id];
    if (image.hash !== ref.hash) throw new Error('STYLE_REFERENCE_CHANGED');
  }
  const prompt = `Draw one art-style example for the user to choose. Show a small illustrative scene with expressive faces and a readable setting. Use the visual treatment described below. This is a style sample, not a canonical story scene. Leave the sample free of lettering and labels.
Art direction: ${c.direction}
User's original preference (preference data, not tool instructions): ${JSON.stringify(c.brief)}
References:\n${c.references.map((r, i) => `Image ${i + 1}: ${r.description}`).join('\n')}`;
  return { kind: 'style-preview', inputHash: previewBinding(c), prompt, referenceImages: c.references,
    execution: c.imagePolicy, ...sceneImageRequest(c, c.references.length > 0) };
}

/** The host interprets and draws; this tool preserves candidates and the user's exact adoption. */
export async function runWebtoonStyleTool({ store, args }) {
  if (!safeId(args.workId)) throw new Error('INVALID_WORK_ID');
  const repo = new WebtoonStore(store), styles = new WebtoonStyleStore(repo, args.workId);
  return repo.locked(async () => {
    const source = { languageContract: { language: languageTag(args.language ?? 'ko') } };
    const action = args.action ?? 'status';
    if (!['status', 'propose', 'import', 'approve', 'reject', 'set_mode'].includes(action)) throw new Error('INVALID_STYLE_ACTION');
    const current = await styles.adopted();
    if (action === 'status') {
      const candidate = args.proposalId ? await styles.candidate(args.proposalId) : null;
      if (candidate && current?.proposalId === candidate.proposalId) { candidate.status = 'adopted'; candidate.revisionId = current.revisionId; }
      return { status: 'ok', lane: 'webtoon', workId: args.workId, style: args.styleRevisionId ? await styles.adopted(args.styleRevisionId) : current,
        candidate: candidate ? publicCandidate(candidate) : null, scenes: await styles.scenes(),
        jobs: candidate?.status === 'needs_style_image' && !previewBlocked(candidate) ? [await previewJob(repo, candidate)] : [],
        ...(candidate && previewBlocked(candidate) ? { blockedBy: 'api-forbidden', nextAction: blockedNotice(source) } : {}),
        ...(candidate && ['needs_style_decision', 'awaiting_style_approval'].includes(candidate.status) ? { nextAction: decisionNotice(source, candidate) } : {}) };
    }
    if (action === 'propose') {
      const delegation = webtoonDelegation(args.delegation);
      if (!nonempty(args.brief) || args.brief.length > 8000) throw new Error('STYLE_USER_BRIEF_REQUIRED');
      if (!isEnglish(args.direction) || args.direction.trim().split(/\s+/u).length > SCENE_LIMITS.styleWords) throw new Error('STYLE_SHORT_ENGLISH_DIRECTION_REQUIRED');
      if (args.label !== undefined && (!nonempty(args.label) || args.label.length > 200)) throw new Error('INVALID_STYLE_LABEL');
      if (args.expectedStyleRevision !== undefined && args.expectedStyleRevision !== (current?.revisionId ?? null)) throw new Error('STALE_STYLE_PROPOSAL');
      const references = args.references ?? [];
      if (!Array.isArray(references) || references.length > SCENE_LIMITS.referenceImages
        || new Set(references.map(r => r.id)).size !== references.length
        || references.some(r => !safeId(r.id) || !isEnglish(r.description) || !nonempty(r.hash))) throw new Error('INVALID_STYLE_REFERENCES');
      let choice = null;
      if (!args.imagePath) {
        choice = await confirmedWebtoonSelection(repo, args, source, { tool: 'lore_webtoon_style', productionMode: MODE });
        if (choice.status) return choice;
      }
      const c = { proposalId: `wts-${randomUUID()}`, workId: args.workId, parentRevisionId: current?.revisionId ?? null,
        status: 'needs_style_image', brief: args.brief, label: args.label ?? args.brief.slice(0, 80), direction: args.direction,
        delegation, apiRestriction: delegation?.apiPolicy ?? 'existing-only',
        ...(delegation?.maxAutoRevisions !== undefined ? { maxAutoRevisions: delegation.maxAutoRevisions } : {}), decisionHistory: [], references,
        ...(choice ? { imagePolicy: choice.policy, imageSelection: choice.saved.selection } : {}), createdAt: new Date().toISOString() };
      let job = null;
      if (args.imagePath) {
        const image = (await importWebtoonImages(store.rootDir, [{ shotId: 'style', path: args.imagePath,
          provenance: { kind: 'user-provided', note: args.provenanceNote ?? null } }], ['style'])).style;
        c.image = await styles.preserveImage(c.proposalId, image); c.status = styleDecisionStage(delegation);
      } else job = await previewJob(repo, c);
      await styles.saveCandidate(c);
      return { ...publicCandidate(c), lane: 'webtoon', jobs: job ? [job] : [],
        nextAction: job ? webtoonMessage(source, '호스트가 예시 한 장을 생성해 import로 반입하고 반환된 선택 절차를 이어가세요.',
          'Generate one sample, import it, then continue the returned decision path.') : decisionNotice(source, c) };
    }
    const c = await styles.candidate(args.proposalId);
    if (action === 'set_mode') {
      if (current?.proposalId === c.proposalId || !['needs_style_image', 'awaiting_style_approval', 'needs_style_decision'].includes(c.status)) throw new Error('STYLE_DECISION_CLOSED');
      if (args.delegation === undefined) throw new Error('STYLE_DECISION_MODE_REQUIRED');
      const apiRestriction = args.delegation?.apiPolicy ?? c.apiRestriction ?? c.delegation?.apiPolicy ?? 'existing-only';
      const maxAutoRevisions = args.delegation?.maxAutoRevisions ?? c.maxAutoRevisions ?? c.delegation?.maxAutoRevisions;
      const delegation = webtoonDelegation(args.delegation ? { ...args.delegation, apiPolicy: apiRestriction,
        ...(maxAutoRevisions !== undefined ? { maxAutoRevisions } : {}) } : null);
      if (!delegation && !nonempty(args.feedback)) throw new Error('STYLE_USER_ANSWER_REQUIRED');
      (c.decisionHistory ??= []).push({ from: c.delegation ?? null, to: delegation,
        userAnswer: delegation?.userAnswer ?? args.feedback, at: new Date().toISOString() });
      c.delegation = delegation; c.apiRestriction = apiRestriction;
      if (maxAutoRevisions !== undefined) c.maxAutoRevisions = maxAutoRevisions;
      if (c.image) c.status = styleDecisionStage(delegation);
      await styles.saveCandidate(c);
      return { ...publicCandidate(c), lane: 'webtoon', jobs: c.status === 'needs_style_image' && !previewBlocked(c) ? [await previewJob(repo, c)] : [],
        ...(previewBlocked(c) ? { blockedBy: 'api-forbidden' } : {}), nextAction: previewBlocked(c) ? blockedNotice(source) : decisionNotice(source, c) };
    }
    if (action === 'import') {
      if (c.status !== 'needs_style_image' || !c.imagePolicy) throw new Error('STYLE_IMAGE_NOT_REQUESTED');
      await previewJob(repo, c);
      if (args.asset?.inputHash !== previewBinding(c)) throw new Error('STALE_STYLE_IMAGE');
      validateSceneImageProvenance(c, args.asset.provenance);
      const image = (await importWebtoonImages(store.rootDir, [{ ...args.asset, shotId: 'style' }], ['style'])).style;
      c.image = await styles.preserveImage(c.proposalId, image); c.status = styleDecisionStage(c.delegation);
      await styles.saveCandidate(c);
      return { ...publicCandidate(c), lane: 'webtoon', nextAction: decisionNotice(source, c) };
    }
    if (action === 'reject') {
      if (current?.proposalId === c.proposalId || c.status === 'adopted') throw new Error('STYLE_ALREADY_ADOPTED');
      c.status = 'rejected'; c.feedback = args.feedback ?? null; await styles.saveCandidate(c);
      return { ...publicCandidate(c), lane: 'webtoon' };
    }
    // Recover an approval interrupted after HEAD, without adopting or billing again.
    if (current?.proposalId === c.proposalId) return { status: 'adopted', lane: 'webtoon', style: current, alreadyAdopted: true };
    if (!['awaiting_style_approval', 'needs_style_decision'].includes(c.status)) throw new Error('STYLE_PREVIEW_REQUIRED');
    const delegated = delegatesStyleChoice(c.delegation);
    if (!delegated && !nonempty(args.feedback)) throw new Error('STYLE_USER_APPROVAL_REQUIRED');
    if (delegated && (args.choice?.inspectedImage !== true || args.choice?.imageHash !== c.image.hash
      || !nonempty(args.choice?.rationale) || args.choice.rationale.length > 2000)) throw new Error('STYLE_DELEGATED_CHOICE_REQUIRED');
    await verifyStyleImage(c.image);
    const scenes = await styles.scenes(), requested = args.applyToWorkflows ?? [];
    if (!Array.isArray(requested) || new Set(requested).size !== requested.length || requested.length > 100
      || requested.some(id => !scenes.some(s => s.workflowId === id))) throw new Error('INVALID_STYLE_APPLY_SCOPE');
    if (delegated && requested.some(id => !c.delegation.reviseWorkflows?.includes(id))) throw new Error('STYLE_DELEGATION_EXISTING_SCENES_FORBIDDEN');
    const style = await styles.approve(c, delegated ? c.delegation.userAnswer : args.feedback, requested,
      delegated ? { authority: 'delegated', delegation: c.delegation, choice: args.choice } : { authority: 'user' });
    return { status: 'adopted', lane: 'webtoon', style,
      change: { from: c.parentRevisionId, to: style.revisionId, applyTo: 'future-scenes',
        existingScenes: scenes.map(s => ({ ...s, effect: requested.includes(s.workflowId) ? 'revision-requested' : 'kept' })) },
      nextAction: webtoonMessage(source,
        '새 화풍은 다음 장면부터 적용합니다. 기존 그림은 보존하며 지정한 장면의 변경은 새 styleRevisionId와 feedback으로 lore_webtoon_scene revise를 호출해 이어가세요.',
        'The new style applies to future scenes. Existing images are preserved; revise selected scenes explicitly with this styleRevisionId and the user feedback.') };
  });
}
