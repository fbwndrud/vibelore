import { readFile } from 'node:fs/promises';
import { digest, planShots, escapeHtml } from './webtoon-contract.js';
import { scriptText } from './webtoon-text.js';
import { roughBinding, reviewed, roughReviewed, roughReviewContext, storyboardMode, storyboardApproved, transitionChecks } from './webtoon-continuity.js';

// Approval binds actual rough bytes, not just a host's statement about them.
export async function verifyStoryboard(w) {
  for (const scene of w.continuity.plan.scenes) {
    const r = w.continuity.roughs[scene.id];
    if (!r || r.inputHash !== roughBinding(w, scene.id) || !roughReviewed(w, scene.id)) throw new Error('STORYBOARD_REVIEW_REQUIRED');
    if (digest(await readFile(r.path)) !== r.image.hash) throw new Error('STORYBOARD_BYTES_CHANGED');
  }
}

export function roughReviewJobs(w) {
  if (!storyboardMode(w)) return [];
  return w.continuity.plan.scenes.filter(s => !roughReviewed(w, s.id) && roughReviewContext(w, s.id)).map(scene => {
    const entries = w.continuity.plan.shots.filter(s => s.sceneId === scene.id);
    const incoming = entries.filter(s => s.previousShotId).map(s => w.continuity.plan.shots.find(e => e.shotId === s.previousShotId));
    return { sceneId: scene.id, hash: w.continuity.roughs[scene.id].image.hash, contextHash: roughReviewContext(w, scene.id), shots: entries,
      images: [...new Set([scene.id, ...incoming.map(e => e.sceneId)])].map(id => ({ sceneId: id, path: w.continuity.roughs[id].path, hash: w.continuity.roughs[id].image.hash })),
      instruction: '각 컷의 인물·괴수 수와 위치, 시선, 이동, 접점, 반응, 대사 공간을 실제 러프에서 읽는다. 묶음 경계도 이전 러프와 비교한다. 번호/실루엣이 안 읽히면 unclear다. observations는 모든 shotId, transitions는 모든 previousShotId→shotId별 verdict와 evidence를 제출한다. 전부 clear인 경우에만 passed=true. 현재 contextHash를 함께 제출한다. 상세 대본을 상상하여 빠진 그림을 보충하지 않는다.' };
  });
}

export async function verifyStoryboardArt(w) {
  if (w.storyboardPolicyVersion === 2 && !storyboardMode(w)) throw new Error('STORYBOARD_PLAN_REQUIRED');
  if (!storyboardMode(w)) return;
  if (!storyboardApproved(w)) throw new Error('STORYBOARD_APPROVAL_REQUIRED');
  await verifyStoryboard(w);
  if (w.continuity.plan.shots.some(s => !w.images[s.shotId] || !reviewed(w.continuity.shotReviews[s.shotId], w.images[s.shotId].hash))
    || transitionChecks(w).some(p => !p.passed)) throw new Error('STORYBOARD_ART_REVIEW_REQUIRED');
}

const escape = escapeHtml;

export function storyboardHtml(w) {
  const script = new Map(planShots(w.plan).map(s => [s.id, s]));
  const sceneIds = [...new Set(w.continuity.plan.shots.map(s => s.sceneId))];
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>구도 러프 검토</title>
<style>body{margin:32px auto;max-width:900px;padding:0 20px;font:18px/1.65 sans-serif;background:#eee;color:#222}article{background:white;padding:24px;margin:24px 0}img{width:100%;height:auto}li{margin:20px 0}.note{color:#555}</style>
<h1>${escape(w.plan.title)} — 구도 러프</h1><p>완성 작화 전 검토입니다. 얼굴 디테일보다 누가 어디에서 무엇을 하고, 다음 컷으로 어떻게 이어지는지 봐 주세요. 컷 번호·인물 식별·이동 방향·접점·대사 공간이 읽히지 않으면 수정합니다.</p>
${sceneIds.map(id => {
    const r = w.continuity.roughs[id], scene = w.continuity.plan.scenes.find(s => s.id === id);
    return `<article><h2>${escape(id)}</h2><p>${escape(scene.layout)} / ${escape(scene.cameraAxis)}</p><img alt="${escape(id)} 번호별 구도 러프" src="data:${r.image.mime};base64,${r.image.base64}"><ol>${w.continuity.plan.shots.filter(s => s.sceneId === id).map(s => `<li><strong>${escape(s.shotId)} · ${escape(s.decisiveMoment)}</strong><div>${escape(s.before)} → ${escape(s.after)}</div><div class="note">${escape(s.previousShotId ? `${s.previousShotId}에서 연결: ${s.change}` : s.resetReason ?? '첫 장면')}</div><div>${script.get(s.shotId).texts.map(t => escape(scriptText(t, script.get(s.shotId), w.plan.textPolicyVersion))).join('<br>')}</div></li>`).join('')}</ol></article>`;
  }).join('')}<p>승인은 현재 러프 파일과 계획에만 적용됩니다. 변경된 구도는 다시 확인합니다.</p></html>`;
}
