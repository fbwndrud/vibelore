import { createHash, randomUUID } from 'node:crypto';
import { createPublicationUnit } from '../core/publication-unit.js';
import { captureWorkingTreeFingerprint, detectWorkingTreeDrift, fingerprintWorkingTree } from '../core/working-tree-sync.js';
import { loadCurrentExperienceLedger, saveExperienceLedgerForHead } from '../core/experience-ledger.js';
import { assertCurrentChapterReceipt, invalidateValidationSession, loadValidationSession } from '../core/validation-context.js';
import { computeArtifactHash } from '../core/validation-gate.js';
import { assertProseIntegrity } from './prose-integrity.js';
import { runCheck } from './check.js';
import { runCommit } from './commit.js';

const CHAPTER_PATH = /^chapters\/(\d+)\.md$/;
const proseHash = (prose) => `sha256:${createHash('sha256').update(String(prose)).digest('hex')}`;
const pending = (providers) => (providers?.pending?.length ?? 0) > 0;
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;

async function inspectSync({ store, workId }) {
  const publication = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
  if (!publication.ok) throw new Error(`CORRUPT_PUBLICATION: ${publication.error.code}`);
  if (!publication.value) return { status: 'unpublished', changed: [], nextAction: '첫 정본 발행 전이므로 동기화할 HEAD가 없습니다.' };
  const drift = await detectWorkingTreeDrift({ store, sourceHead: publication.value.head });
  if (drift.status === 'clean') return { ...drift, nextAction: '동기화가 필요하지 않습니다.' };
  if (drift.status === 'stale_fingerprint' && drift.changed.length === 0) {
    const captured = await captureWorkingTreeFingerprint({ store, sourceHead: publication.value.head });
    return {
      status: 'baseline_captured', sourceHead: publication.value.head, changed: [], fingerprint: captured.digest,
      nextAction: '사용자 편집 파일 변경 없이 Published HEAD만 전진한 기준선을 갱신했습니다.',
    };
  }
  if (drift.status === 'untracked') {
    const publishedFoundation = publication.value.tree?.foundation ?? null;
    const workingFoundation = await store.loadFoundation(workId);
    const publishedChapters = publication.value.tree?.chapters ?? {};
    const workingChapterNumbers = await store.listChapters();
    const sameFoundation = JSON.stringify(stable(workingFoundation)) === JSON.stringify(stable(publishedFoundation));
    const sameChapters = workingChapterNumbers.length === Object.keys(publishedChapters).length
      && (await Promise.all(workingChapterNumbers.map(async (chapter) => {
        const working = await store.loadArtifact(workId, chapter);
        const published = publishedChapters[chapter];
        return working?.prose === published?.prose && (working?.title ?? null) === (published?.title ?? null);
      }))).every(Boolean);
    if (sameFoundation && sameChapters) {
      const captured = await captureWorkingTreeFingerprint({ store, sourceHead: publication.value.head });
      return { status: 'baseline_captured', sourceHead: publication.value.head, changed: [], fingerprint: captured.digest, nextAction: '구형 작품의 현재 materialization을 기준선으로 등록했습니다.' };
    }
    return {
      status: 'needs_review', sourceHead: publication.value.head, changed: [], classification: 'untracked_working_tree',
      nextAction: '기준 fingerprint가 없고 Published HEAD와 작업 파일이 다릅니다. 자동 기준선 등록을 거부했습니다.',
    };
  }

  const chapterChanges = drift.changed.map((path) => ({ path, match: CHAPTER_PATH.exec(path) })).filter((item) => item.match);
  const designChanges = drift.changed.filter((path) => path.startsWith('world/') || path.startsWith('characters/'));
  const unknownChanges = drift.changed.filter((path) => !designChanges.includes(path) && !CHAPTER_PATH.test(path));
  const chapterCandidates = [];
  for (const { path, match } of chapterChanges) {
    const chapter = Number(match[1]);
    const artifact = await store.loadArtifact(workId, chapter);
    let parseStatus = 'valid';
    try { assertProseIntegrity(artifact?.prose ?? ''); }
    catch { parseStatus = 'invalid_prose'; }
    chapterCandidates.push({ path, chapter, parseStatus, chars: artifact?.prose?.length ?? 0 });
  }
  const publishedChapters = Object.keys(publication.value.tree?.chapters ?? {}).map(Number).sort((a, b) => a - b);
  const lastChapter = publishedChapters.at(-1) ?? 0;
  let classification = 'unsupported_change';
  let nextAction = '변경 파일을 직접 덮어쓰지 않습니다. 변경 유형을 검토하세요.';
  if (designChanges.length) {
    classification = 'design_review_required';
    nextAction = '세계·인물 변경은 이후 계획과 원고에 영향을 주므로 재검증·영향 분석 후 별도 발행해야 합니다.';
  } else if (chapterCandidates.length === 1 && chapterCandidates[0].chapter === lastChapter && chapterCandidates[0].parseStatus === 'valid') {
    classification = 'latest_chapter_review_required';
    nextAction = '마지막 화 손수정본을 검사 영수증과 함께 다시 커밋해야 합니다. 자동 승인하지 않습니다.';
  } else if (chapterCandidates.length) {
    classification = 'rewrite_refold_required';
    nextAction = '이전 화 손수정은 해당 화 재검사·재커밋 후 lore_refold가 필요합니다.';
  }
  return {
    status: 'needs_review', sourceHead: publication.value.head, changed: drift.changed,
    classification, designChanges, chapterCandidates, unknownChanges, nextAction,
  };
}

export async function runSyncStatus({ store, workId, action = 'inspect', approvalId, providers }) {
  if (action === 'inspect') return inspectSync({ store, workId });
  if (action === 'validate') {
    const inspected = await inspectSync({ store, workId });
    if (inspected.classification !== 'latest_chapter_review_required') return inspected;
    const chapter = inspected.chapterCandidates[0].chapter;
    const artifact = await store.loadArtifact(workId, chapter);
    const validationScope = `sync-${chapter}`;
    const check = await runCheck({
      store, workId, chapter, prose: artifact.prose, title: artifact.title, providers,
      forceContract: true, issueReceipt: true, allowWorkingTreeDrift: true, validationScope,
    });
    if (pending(providers) || check.preview) return { preview: true, operation: 'sync_check', chapter };
    if (!check.validationComplete || !check.checkId || !check.artifact || check.counts?.hard > 0) {
      return { status: check.status === 'clean_fail' ? 'clean_fail' : 'blocked', chapter,
        code: check.code ?? 'VALIDATION_INCOMPLETE', violations: check.violations ?? [],
        validationAttempts: check.validationAttempts, languageCompliance: check.languageCompliance,
        coverage: check.coverage };
    }
    const receipt = await store.loadCheckReceipt(workId, check.checkId);
    const session = await loadValidationSession(store, workId, validationScope);
    await assertCurrentChapterReceipt({ store, workId, chapter, receipt, artifact: check.artifact,
      allowWorkingTreeDrift: true, validationScope });
    const fingerprint = await fingerprintWorkingTree(store.rootDir);
    const candidate = {
      schemaVersion: 2, approvalId: `sync-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      workId, chapter, sourceHead: receipt.sourceHead, workingTreeDigest: fingerprint.digest,
      proseHash: proseHash(artifact.prose), artifact: check.artifact,
      artifactHash: computeArtifactHash(check.artifact), checkId: receipt.checkId,
      validationScope, validationEpoch: session.epoch, planSourceHash: receipt.planSourceHash,
      contractHash: receipt.contractHash, stale: false,
      advisories: check.violations.filter((item) => item.severity !== 'hard'),
      validatedAt: new Date().toISOString(), consumedAt: null,
    };
    await store.saveSyncCandidate(workId, candidate);
    return {
      status: 'awaiting_approval', approvalId: candidate.approvalId, chapter,
      advisories: candidate.advisories,
      nextAction: '같은 approvalId로 lore_sync action=apply를 호출하면 검증된 손수정본을 재발행합니다.',
    };
  }
  if (action === 'apply') {
    const candidate = await store.loadSyncCandidate(workId);
    if (!candidate || candidate.consumedAt || candidate.approvalId !== approvalId) throw new Error('유효한 미사용 sync approvalId가 없습니다.');
    if (candidate.schemaVersion !== 2 || candidate.stale || !candidate.checkId || !candidate.artifact) {
      throw new Error('STALE_SYNC_CANDIDATE: 새로운 검사 영수증으로 다시 검증해야 합니다.');
    }
    let result;
    let priorExperience;
    try {
      const publication = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
      if (!publication.ok) throw new Error(`CORRUPT_PUBLICATION: ${publication.error.code}`);
      if (publication.value?.head !== candidate.sourceHead) throw new Error('STALE_SYNC_HEAD: 검증 이후 Published HEAD가 변경됐습니다.');
      const fingerprint = await fingerprintWorkingTree(store.rootDir);
      const artifact = await store.loadArtifact(workId, candidate.chapter);
      if (fingerprint.digest !== candidate.workingTreeDigest || proseHash(artifact?.prose) !== candidate.proseHash
          || computeArtifactHash(candidate.artifact) !== candidate.artifactHash) {
        throw new Error('STALE_SYNC_CANDIDATE: 검증 이후 Markdown 또는 검사 묶음이 변경됐습니다.');
      }
      const receipt = await store.loadCheckReceipt(workId, candidate.checkId);
      if (!receipt || receipt.validationEpoch !== candidate.validationEpoch)
        throw new Error('STALE_SYNC_CANDIDATE: 검사 영수증이 없거나 세대가 다릅니다.');
      await assertCurrentChapterReceipt({ store, workId, chapter: candidate.chapter, receipt,
        artifact: candidate.artifact, allowWorkingTreeDrift: true, validationScope: candidate.validationScope });
      priorExperience = await loadCurrentExperienceLedger({ store, workId });
      // Complete checked fields go straight to the consume-only publication port.
      result = await runCommit({
        store, workId, chapter: candidate.chapter, prose: candidate.artifact.prose,
        title: candidate.artifact.title, summary: candidate.artifact.summary,
        delta: candidate.artifact.semanticDelta, castManifestRaw: candidate.artifact.castManifestRaw,
        checkId: candidate.checkId, allowWorkingTreeDrift: true, validationScope: candidate.validationScope,
        providers: { async complete() { throw new Error('SYNC_APPLY_MODEL_FORBIDDEN'); } },
      });
    } catch (error) {
      candidate.stale = true;
      candidate.staleReason = error.code ?? error.message;
      candidate.staleAt = new Date().toISOString();
      await store.saveSyncCandidate(workId, candidate);
      const session = await loadValidationSession(store, workId, candidate.validationScope);
      if (session) await invalidateValidationSession(store, workId, candidate.validationScope, session, 'STALE_SYNC_CANDIDATE');
      throw error;
    }
    await saveExperienceLedgerForHead({
      store, workId, sourceHead: result.publication.head,
      entries: priorExperience.entries.filter((entry) => entry.chapter !== candidate.chapter),
      criticVersion: priorExperience.criticVersion ?? null,
    });
    candidate.consumedAt = new Date().toISOString();
    candidate.publishedHead = result.publication.head;
    await store.saveSyncCandidate(workId, candidate);
    return { status: 'completed', chapter: candidate.chapter, publication: result.publication, advisories: candidate.advisories };
  }
  throw new Error('action은 inspect, validate 또는 apply여야 합니다.');
}
