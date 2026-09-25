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
    nextAction = chapterCandidates.length || unknownChanges.length
      ? '세계·인물 변경과 원고 변경이 섞여 있습니다. 원고 변경을 되돌리거나 따로 처리한 뒤 lore_sync action=validate로 세계·인물 변경을 검토하세요.'
      : '세계·인물 변경입니다. lore_sync action=validate로 바뀐 항목과 영향을 받는 계획을 확인한 뒤, 같은 approvalId로 action=apply 하면 반영합니다. 이미 발행된 화는 다시 검사하지 않습니다.';
  } else if (chapterCandidates.length === 1 && chapterCandidates[0].chapter === lastChapter && chapterCandidates[0].parseStatus === 'valid') {
    classification = 'latest_chapter_review_required';
    nextAction = '마지막 화 손수정본을 검사 영수증과 함께 다시 커밋해야 합니다. 자동 승인하지 않습니다.';
  } else if (chapterCandidates.length) {
    classification = 'rewrite_refold_required';
    nextAction = '이전 화 손수정은 아직 기본 도구로 반영할 수 없습니다. 이 파일을 발행본 내용으로 되돌린 뒤 집필을 이어 가세요. 설정 자체를 바꾸려면 world/·characters/ 수정을 lore_sync로 반영할 수 있습니다.';
  }
  return {
    status: 'needs_review', sourceHead: publication.value.head, changed: drift.changed,
    classification, designChanges, chapterCandidates, unknownChanges, nextAction,
  };
}

const byId = (items) => new Map((items ?? []).map((item) => [item.id, item]));
const same = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
const foundationHash = (foundation) => `sha256:${createHash('sha256').update(JSON.stringify(stable(foundation))).digest('hex')}`;

/** What changed between the published Foundation and the edited Markdown. */
function diffFoundation(before, after) {
  const facts = { added: [], removed: [], changed: [] };
  const oldFacts = byId(before?.worldFacts);
  const newFacts = byId(after?.worldFacts);
  for (const [id, fact] of newFacts) {
    if (!oldFacts.has(id)) facts.added.push({ id, after: fact.statement });
    else if (oldFacts.get(id).statement !== fact.statement) facts.changed.push({ id, before: oldFacts.get(id).statement, after: fact.statement });
  }
  for (const [id, fact] of oldFacts) if (!newFacts.has(id)) facts.removed.push({ id, before: fact.statement });
  const characters = { added: [], removed: [], changed: [] };
  const oldCast = byId(before?.characters);
  const newCast = byId(after?.characters);
  for (const [id, character] of newCast) {
    const previous = oldCast.get(id);
    if (!previous) { characters.added.push({ id, name: character.canonicalName }); continue; }
    const fields = [...new Set([...Object.keys(previous), ...Object.keys(character)])].filter((key) => !same(previous[key], character[key])).sort();
    if (fields.length) characters.changed.push({ id, name: character.canonicalName, fields });
  }
  for (const [id, character] of oldCast) if (!newCast.has(id)) characters.removed.push({ id, name: character.canonicalName });
  return { worldFacts: facts, characters };
}

/** Published plans that mention a changed or removed fact or character. */
function designImpact(tree, diff) {
  const terms = [
    ...diff.worldFacts.changed.flatMap((item) => [item.id, item.before]),
    ...diff.worldFacts.removed.flatMap((item) => [item.id, item.before]),
    ...diff.characters.changed.flatMap((item) => [item.id, item.name]),
    ...diff.characters.removed.flatMap((item) => [item.id, item.name]),
  ].filter((term) => typeof term === 'string' && term.length >= 2);
  const plans = tree?.plans ?? {};
  const entries = [
    ...['storyProfile', 'storySpine', 'writerSkill', 'arcPlan'].map((key) => [key, plans[key]]),
    ...Object.entries(plans.episodePlans ?? {}).map(([chapter, plan]) => [`episodePlans.${chapter}`, plan]),
  ].filter(([, plan]) => plan);
  return {
    plans: entries.flatMap(([plan, value]) => {
      const text = JSON.stringify(value);
      const mentions = [...new Set(terms.filter((term) => text.includes(term)))];
      return mentions.length ? [{ plan, mentions }] : [];
    }),
    publishedChapters: Object.keys(tree?.chapters ?? {}).length,
  };
}

async function validateDesign({ store, workId, inspected }) {
  if (inspected.chapterCandidates.length || inspected.unknownChanges.length) {
    return { status: 'blocked', code: 'MIXED_WORKING_TREE_CHANGES', changed: inspected.changed, nextAction: inspected.nextAction };
  }
  const publication = await createPublicationUnit({ rootDir: store.rootDir }).readPublished();
  if (!publication.ok) throw new Error(`CORRUPT_PUBLICATION: ${publication.error.code}`);
  let working;
  try { working = await store.loadFoundation(workId); }
  catch (error) { return { status: 'blocked', code: 'FOUNDATION_PARSE_FAILED', reason: error.message, changed: inspected.designChanges }; }
  const designDiff = diffFoundation(publication.value.tree?.foundation, working);
  const impact = designImpact(publication.value.tree, designDiff);
  const fingerprint = await fingerprintWorkingTree(store.rootDir);
  const candidate = {
    schemaVersion: 2, kind: 'design', approvalId: `sync-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    workId, sourceHead: publication.value.head, workingTreeDigest: fingerprint.digest,
    foundationHash: foundationHash(working), designDiff, impact, stale: false,
    validatedAt: new Date().toISOString(), consumedAt: null,
  };
  await store.saveSyncCandidate(workId, candidate);
  return {
    status: 'awaiting_approval', approvalId: candidate.approvalId, changed: inspected.designChanges, designDiff, impact,
    nextAction: impact.plans.length
      ? '영향을 받는 계획을 확인하세요. 같은 approvalId로 lore_sync action=apply 하면 세계·인물 변경을 정본에 반영합니다. 계획은 자동으로 고치지 않습니다.'
      : '같은 approvalId로 lore_sync action=apply 하면 세계·인물 변경을 정본에 반영합니다.',
  };
}

async function applyDesign({ store, workId, candidate }) {
  const unit = createPublicationUnit({ rootDir: store.rootDir });
  const current = await unit.readPublished();
  if (!current.ok) throw new Error(`CORRUPT_PUBLICATION: ${current.error.code}`);
  if (current.value?.head !== candidate.sourceHead) throw new Error('STALE_SYNC_HEAD: 검증 이후 Published HEAD가 변경됐습니다.');
  const fingerprint = await fingerprintWorkingTree(store.rootDir);
  const working = await store.loadFoundation(workId);
  if (fingerprint.digest !== candidate.workingTreeDigest || foundationHash(working) !== candidate.foundationHash) {
    throw new Error('STALE_SYNC_CANDIDATE: 검증 이후 세계·인물 파일이 변경됐습니다.');
  }
  const priorExperience = await loadCurrentExperienceLedger({ store, workId });
  const token = await unit.issueFencingToken();
  if (!token.ok) throw new Error(`정사 fencing token을 발급할 수 없습니다: ${token.error.code}`);
  const chapters = Object.keys(current.value.tree?.chapters ?? {}).map(Number);
  const through = chapters.length ? Math.max(...chapters) : 0;
  const result = await unit.publish({
    context: {
      snapshotId: candidate.sourceHead, expectedHead: candidate.sourceHead, storyTimeScope: { worldline: 'main', through },
      publicationOrder: Math.max(1, through), transactionTime: new Date().toISOString(), policyRevision: 'vibelore-1',
      semanticGeneration: 'vibelore-1', fencingToken: token.value.fencingToken,
    },
    candidate: {
      tree: { foundation: working },
      projections: current.value.projections ?? {}, impactClosure: [{ id: 'foundation', dependencyKind: 'design', status: 'satisfied' }],
    },
  });
  if (!result.ok) throw new Error(`세계·인물 변경 발행 실패: ${result.error.code}`);
  await saveExperienceLedgerForHead({
    store, workId, sourceHead: result.value.head, entries: priorExperience.entries, criticVersion: priorExperience.criticVersion ?? null,
  });
  // The approved edit is the new baseline.
  await captureWorkingTreeFingerprint({ store, sourceHead: result.value.head });
  return result.value;
}

export async function runSyncStatus({ store, workId, action = 'inspect', approvalId, providers }) {
  if (action === 'inspect') return inspectSync({ store, workId });
  if (action === 'validate') {
    const inspected = await inspectSync({ store, workId });
    if (inspected.classification === 'design_review_required') return validateDesign({ store, workId, inspected });
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
    if (candidate.kind === 'design') {
      if (candidate.stale) throw new Error('STALE_SYNC_CANDIDATE: 다시 검토해야 합니다.');
      let published;
      try { published = await applyDesign({ store, workId, candidate }); }
      catch (error) {
        Object.assign(candidate, { stale: true, staleReason: error.message, staleAt: new Date().toISOString() });
        await store.saveSyncCandidate(workId, candidate);
        throw error;
      }
      Object.assign(candidate, { consumedAt: new Date().toISOString(), publishedHead: published.head });
      await store.saveSyncCandidate(workId, candidate);
      return { status: 'completed', kind: 'design', publication: published, designDiff: candidate.designDiff, impact: candidate.impact };
    }
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
