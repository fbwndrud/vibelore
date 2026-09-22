import { buildStyleAnchor } from '../core/style-continuity.js';

export async function runStyleAnchor({ store, workId, action = 'status', chapters = [], reason = '' }) {
  if (action === 'status') {
    const anchor = await store.loadStyleAnchor(workId);
    return { status: anchor?.status ?? 'missing', anchor: anchor ?? null };
  }
  if (action !== 'approve') throw new Error('action은 status 또는 approve여야 합니다.');
  if (typeof reason !== 'string' || reason.length > 2000) throw new Error('STYLE_ANCHOR_REASON_INVALID: 선호 이유는 2000자 이내 문자열이어야 합니다.');
  const selected = [...new Set((chapters ?? []).map(Number))];
  if (selected.length < 1 || selected.length > 3 || selected.some((chapter) => !Number.isInteger(chapter) || chapter < 1)) {
    throw new Error('STYLE_ANCHOR_CHAPTERS_INVALID: 정본 화를 1~3개 지정하세요.');
  }
  const artifacts = [];
  for (const chapter of selected) {
    const artifact = await store.loadArtifact(workId, chapter);
    if (!artifact?.prose?.trim()) throw new Error(`STYLE_ANCHOR_CHAPTER_MISSING: ${chapter}화 정본이 없습니다.`);
    artifacts.push({ chapterNumber: chapter, prose: artifact.prose });
  }
  const previous = await store.loadStyleAnchor(workId);
  const anchor = buildStyleAnchor({ workId, chapters: artifacts, reason: reason.trim(), revision: Number(previous?.revision ?? 0) + 1 });
  await store.saveStyleAnchor(workId, anchor);
  return { status: 'active', anchor };
}
