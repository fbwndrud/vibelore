import { readFile, readdir } from 'node:fs/promises';
import { createLoreExpressionProfile } from '../../engine/src/lore/assets.js';
import { digest, safeId } from '../core/webtoon-contract.js';
import { readJson, atomicWrite } from './webtoon-store.js';

export const STYLE_REFERENCE_ID = 'adopted-style';
const revisionId = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

/** Work-local adoption uses the shared expression profile schema; it never requires a shared world. */
export class WebtoonStyleStore {
  constructor(repo, workId) {
    if (!safeId(workId)) throw new Error('INVALID_WORK_ID');
    this.repo = repo; this.workId = workId;
  }
  path(...parts) { return this.repo.path('styles', this.workId, ...parts); }
  async head() { return (await readJson(this.path('HEAD.json')))?.revisionId ?? null; }
  async candidate(id) {
    if (!safeId(id)) throw new Error('INVALID_STYLE_PROPOSAL_ID');
    const value = await readJson(this.path('candidates', `${id}.json`));
    if (!value || value.workId !== this.workId) throw new Error('STYLE_PROPOSAL_NOT_FOUND');
    return value;
  }
  async saveCandidate(value) {
    if (!safeId(value.proposalId) || value.workId !== this.workId) throw new Error('INVALID_STYLE_PROPOSAL_ID');
    await atomicWrite(this.path('candidates', `${value.proposalId}.json`), JSON.stringify(value, null, 2));
  }
  async preserveImage(proposalId, image) {
    if (!safeId(proposalId)) throw new Error('INVALID_STYLE_PROPOSAL_ID');
    const bytes = Buffer.from(image.base64, 'base64');
    const path = this.path('images', `${image.hash.slice(7)}.${image.mime === 'image/png' ? 'png' : 'jpg'}`);
    const prior = await readFile(path).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (prior && digest(prior) !== image.hash) throw new Error('STYLE_IMAGE_CHANGED');
    if (!prior) await atomicWrite(path, bytes);
    return { path, hash: image.hash, mime: image.mime, provenance: image.provenance };
  }
  async read(id) {
    if (!revisionId(id)) throw new Error('INVALID_STYLE_REVISION');
    const value = await readJson(this.path('revisions', `${id.slice(7)}.json`));
    if (!value || value.workId !== this.workId) throw new Error('STYLE_REVISION_NOT_FOUND');
    const { revisionId: ownId, ...payload } = value;
    if (ownId !== id || digest(payload) !== id) throw new Error('STYLE_REVISION_CHANGED');
    await verifyStyleSnapshot(value);
    return value;
  }
  async adopted(id) {
    const target = id ?? await this.head();
    if (!target) return null;
    // Orphan writes from an interrupted approval are not adopted revisions.
    for (let current = await this.head(); current;) {
      const value = await this.read(current);
      if (current === target) return value;
      current = value.parentRevisionId;
    }
    throw new Error('STYLE_REVISION_NOT_ADOPTED');
  }
  async approve(candidate, feedback, applyToWorkflows, decision = { authority: 'user' }) {
    if (await this.head() !== candidate.parentRevisionId) throw new Error('STALE_STYLE_PROPOSAL');
    if (!candidate.image || !['awaiting_style_approval', 'needs_style_decision'].includes(candidate.status)) throw new Error('STYLE_PREVIEW_REQUIRED');
    await verifyStyleImage(candidate.image);
    const profile = createLoreExpressionProfile({ profileId: 'webtoon-style', label: candidate.label,
      style: candidate.direction, notes: candidate.brief });
    const payload = { schemaVersion: 1, kind: 'webtoon-style', workId: this.workId,
      parentRevisionId: candidate.parentRevisionId, proposalId: candidate.proposalId,
      brief: candidate.brief, profile, image: candidate.image,
      adoption: { feedback, ...decision, decisionHistory: candidate.decisionHistory ?? [],
        apiRestriction: candidate.apiRestriction ?? candidate.delegation?.apiPolicy ?? 'existing-only',
        ...(candidate.maxAutoRevisions !== undefined ? { maxAutoRevisions: candidate.maxAutoRevisions } : {}),
        applyTo: 'future-scenes', applyToWorkflows, adoptedAt: new Date().toISOString() } };
    const value = { ...payload, revisionId: digest(payload) };
    await atomicWrite(this.path('revisions', `${value.revisionId.slice(7)}.json`), JSON.stringify(value, null, 2));
    // A head is the adoption receipt. Candidate state can be recovered from it after a restart.
    await atomicWrite(this.path('HEAD.json'), JSON.stringify({ revisionId: value.revisionId }));
    candidate.status = 'adopted'; candidate.revisionId = value.revisionId;
    await this.saveCandidate(candidate);
    return value;
  }
  async scenes() {
    const files = await readdir(this.repo.path('workflows')).catch(e => { if (e.code !== 'ENOENT') throw e; return []; });
    const rows = [];
    for (const file of files.filter(f => f.endsWith('.json')).sort()) {
      const w = await readJson(this.repo.path('workflows', file));
      if (w?.workId === this.workId && w.productionMode === 'scene-direct-v1') rows.push({ workflowId: w.workflowId,
        revision: w.revision, status: w.stage, styleRevisionId: w.styleSnapshot?.revisionId ?? null });
    }
    return rows;
  }
}

export async function verifyStyleImage(image) {
  const bytes = await readFile(image.path).catch(e => { if (e.code !== 'ENOENT') throw e; throw new Error('STYLE_IMAGE_MISSING'); });
  if (digest(bytes) !== image.hash) throw new Error('STYLE_IMAGE_CHANGED');
}

export async function verifyStyleSnapshot(value) {
  const { revisionId: id, ...payload } = value;
  if (!revisionId(id) || digest(payload) !== id) throw new Error('STYLE_REVISION_CHANGED');
  const { revisionId: profileId, ...profile } = value.profile;
  if (createLoreExpressionProfile(profile).revisionId !== profileId) throw new Error('STYLE_PROFILE_CHANGED');
  await verifyStyleImage(value.image);
}

export function styleReference(value) {
  return { id: STYLE_REFERENCE_ID, path: value.image.path, hash: value.image.hash, styleRevisionId: value.revisionId,
    description: 'User-adopted art style only: use its visual treatment, not its cast, clothing, layout or lettering. Scene identity and setting come from the source and their own references.' };
}
