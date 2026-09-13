/**
 * 작품 언어의 생애 단계 해석 (다국어 Phase 1, 플러그인 쪽).
 *
 * 언어 규칙 자체는 `engine/src/core/language-policy.js` 하나가 정한다. 이 모듈은
 * 그 규칙을 **저장된 것들**과 연결한다: 프로필 revision, 정본 foundation, 그리고
 * 수락된 생성 기록(accepted creation record).
 *
 * 단계:
 *   foundation 이전 — 현재 프로필 revision 이 원천이다. 프로필이 있으면 그 revision
 *                     이 승인(active)된 경우에만 생성할 수 있다.
 *   foundation 이후 — 저장된 작품 언어가 원천이고 v1 에서 변경할 수 없다. 명시
 *                     인자는 일치 확인용이며 일회성 출력 override 가 아니다.
 *   발행 이후     — Published HEAD 의 foundation 이 실행 원천이다(phase 3 이
 *                     workflow/sync 경로에서 이 계약을 소비한다).
 *
 * 여기서 하지 않는 것: 모델 호출, 검사 판정, 영수증. 조회만으로 문서를 다시 쓰지
 * 않는다.
 */
import {
  CANONICAL_FORMAT_VERSION_LEGACY_KO,
  IMPLICIT_LEGACY_LANGUAGE,
  LanguagePolicyError,
  LANGUAGE_ERROR_CODES,
  buildLanguageContract,
  computeLanguageContractHash,
  normalizeLanguageTag,
  resolveCanonicalFormatVersion,
  resolveCreationLanguage,
  resolveExistingWorkLanguage,
  resolveLengthContract,
} from '../../engine/src/core/language-policy.js';

export const ACCEPTED_CREATION_SCHEMA_VERSION = 1;

/** 프로필이 새 v3 분량 계약을 저장하는 스키마 버전. */
export const STORY_PROFILE_SCHEMA_VERSION = 3;

export class WorkLanguageError extends Error {
  constructor(code, details = {}) {
    super(`${code}: ${JSON.stringify(details)}`);
    this.name = 'WorkLanguageError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/**
 * 저장된 문서에 언어 키가 실제로 있었는지를 값의 유효성과 분리해 읽는다.
 *
 * `hasKey` 는 오직 `Object.hasOwn` 이다. 키가 있는데 값이 비어 있으면 손상된
 * 계약이며, 그 판정은 공유 resolver 가 한다. 여기서 값이 이상하다는 이유로 구작
 * (키 없음)으로 재분류하지 않는다.
 */
export function readStoredLanguage(doc) {
  if (!doc || typeof doc !== 'object') return { language: null, hasKey: undefined };
  const hasKey = Object.hasOwn(doc, 'language');
  const raw = hasKey ? doc.language : null;
  const language = raw === null || raw === undefined || raw === '' ? null : String(raw);
  return { language, hasKey };
}

/**
 * 프로필에 **실제로 저장된** 분량 필드를 그대로 모아 공유 resolver 에 넘긴다.
 * 어댑터가 만들어 내는 가짜 중복은 기본값 주입을 뜻하며, 두 필드가 모두 저장되어
 * 있는 진짜 충돌을 무시하는 것을 뜻하지 않는다.
 */
function profileHasStoredLength(profile) {
  return profile?.format?.length != null || profile?.format?.chapterChars != null;
}

function storedProfileLengthFields(format) {
  return {
    storedLength: format?.length ?? null,
    storedLegacyLength: format?.chapterChars != null ? { chapterChars: format.chapterChars } : null,
  };
}

/**
 * 프로필의 분량을 읽는 **유일한** 경계.
 *
 * v3 프로필은 `format.length` 만 갖는다. 구형 프로필의 `format.chapterChars` 는
 * 이름과 무관하게 `legacyCodeUnits` 로만 해석하며 원본을 다시 쓰지 않는다. 어댑터가
 * 가짜 중복(같은 값을 length 와 legacy 양쪽에 넣는 것)을 만들지 않으므로
 * `LENGTH_CONTRACT_CONFLICT` 는 호출자가 실제로 중복 지정했을 때만 난다.
 */
export function readProfileLength(profile, { language, length = null, legacyLength = null } = {}) {
  const tag = normalizeLanguageTag(language ?? IMPLICIT_LEGACY_LANGUAGE);
  return resolveLengthContract({
    language: tag, length, legacyLength, ...storedProfileLengthFields(profile?.format),
  });
}

/**
 * 모델이 제안한 분량은 사용자 입력이 아니다. 구형 스키마로 답한 모델의
 * `chapterChars` 는 legacyCodeUnits 제안으로 읽고, 해석할 수 없으면 조용히 버리고
 * 언어별 기본값으로 간다. 모델 응답 하나가 도구 호출을 실패시키지 않게 한다.
 */
export function resolveProposedLength({ language, requestedLength, requestedLegacyLength, proposedFormat }) {
  const explicit = resolveLengthContract({
    language, length: requestedLength ?? null, legacyLength: requestedLegacyLength ?? null,
  });
  if (explicit.source !== 'default') return explicit;
  try {
    // 모델이 length 와 구형 필드를 모순되게 답하면 공유 resolver 가 충돌로 판정하고,
    // 아래 catch 가 그 제안을 버린 뒤 언어 기본값으로 간다.
    const proposed = resolveLengthContract({
      language, ...storedProfileLengthFields(proposedFormat),
    });
    return proposed.source === 'default' ? explicit : { ...proposed, source: 'proposed' };
  }
  catch (err) {
    if (!(err instanceof LanguagePolicyError)) throw err;
    return explicit;
  }
}

/**
 * 이 작품의 언어 계약을 결정한다.
 *
 * @param {{ store: object, workId: string, requested?: string|string[]|null,
 *           length?: object|null, legacyLength?: object|null,
 *           requireApprovedProfile?: boolean }} input
 * @returns {Promise<{
 *   phase: 'pre-foundation'|'created',
 *   language: string, promptFamily: string, implicitLegacy: boolean,
 *   languageSource: string, canonicalFormatVersion: number,
 *   length: { unit: string, target: number, source: string },
 *   contract: object, contractHash: string,
 *   profile: object|null, foundation: object|null, creationRecord: object|null,
 * }>}
 */
export async function resolveWorkLanguage({
  store, workId, requested = null, length = null, legacyLength = null,
  requireApprovedProfile = false, foundation: preloadedFoundation, profile: profileOverride,
} = {}) {
  const creationRecord = typeof store.loadAcceptedCreation === 'function'
    ? await store.loadAcceptedCreation(workId)
    : null;
  const foundation = preloadedFoundation !== undefined
    ? preloadedFoundation
    : await store.loadFoundation(workId);
  // `profile: null` 은 "이 결정에 기존 프로필을 쓰지 않는다"는 뜻이다. 명시적인
  // 언어 변경 revision 이 이전 언어의 계약을 상속하지 않게 하는 데 쓴다.
  const profile = profileOverride !== undefined
    ? profileOverride
    : (typeof store.loadStoryProfile === 'function' ? await store.loadStoryProfile(workId) : null);

  if (foundation || creationRecord) {
    // 생성 뒤에는 프로필이 동의하는 사본이다. 손수정된 프로필 언어를 실행 원천으로
    // 삼지 않는다.
    assertProfileAgreesWithCreation({ creationRecord, profile });
    const stored = creationRecord
      ? { language: String(creationRecord.language), hasKey: true }
      : readStoredLanguage(foundation);
    const resolved = resolveExistingWorkLanguage({
      requested, workLanguage: stored.language, workHasLanguageKey: stored.hasKey,
    });
    const storedFormatVersion = creationRecord
      ? Number(creationRecord.canonicalFormatVersion)
      : (foundation?.canonicalFormatVersion ?? null);
    return finish({
      phase: 'created',
      resolved,
      storedFormatVersion,
      formatVersionKeyPresent: creationRecord ? true : foundation?.canonicalFormatVersion !== undefined,
      length,
      legacyLength,
      // 승인된 프로필의 목표가 우선이다. 프로필에 저장된 분량 필드가 하나도 없을
      // 때만 생성 기록의 값을 쓴다. 프로필에 length 와 chapterChars 가 함께 저장돼
      // 있으면 둘 다 넘겨 진짜 충돌을 판정하게 한다.
      ...(profileHasStoredLength(profile)
        ? storedProfileLengthFields(profile.format)
        : { storedLength: creationRecord?.length ?? null, storedLegacyLength: null }),
      profile,
      foundation,
      creationRecord,
    });
  }

  // foundation 이전: 현재 프로필 revision 이 원천이다. 오래된 승인 revision 으로
  // 자동 후퇴하지 않으며 아직 발급되지 않은 revision 을 승인으로 세지도 않는다.
  if (profile && requireApprovedProfile && profile.status !== 'active') {
    throw new WorkLanguageError('PROFILE_REVISION_NOT_APPROVED', {
      workId, status: profile.status ?? null, revision: profile.revision ?? null,
    });
  }
  const stored = readStoredLanguage(profile);
  const resolved = resolveCreationLanguage({
    requested,
    profileLanguage: profile ? stored.language : null,
    profileHasLanguageKey: profile ? stored.hasKey : undefined,
  });
  return finish({
    phase: 'pre-foundation',
    resolved,
    storedFormatVersion: null,
    formatVersionKeyPresent: undefined,
    length,
    legacyLength,
    ...storedProfileLengthFields(profile?.format),
    profile,
    foundation: null,
    creationRecord: null,
  });
}

function finish({
  phase, resolved, storedFormatVersion, formatVersionKeyPresent,
  length, legacyLength, storedLength = null, storedLegacyLength = null,
  profile, foundation, creationRecord,
}) {
  const tag = resolved.language;
  const contract = buildLanguageContract({
    language: tag,
    length,
    legacyLength,
    storedLength,
    storedLegacyLength,
    storedCanonicalFormatVersion: storedFormatVersion,
    storedFormatVersionKeyPresent: formatVersionKeyPresent,
    allowedLanguageExceptions: profile?.allowedLanguageExceptions ?? [],
    languageSource: resolved.source,
    dialogueBreakMode: profile?.format?.dialogueBreakMode
      ?? foundation?.workContract?.formatPolicy?.dialogueBreakMode
      ?? creationRecord?.workContract?.formatPolicy?.dialogueBreakMode
      ?? ((phase === 'pre-foundation' || creationRecord || Object.hasOwn(foundation ?? {}, 'language'))
        ? (tag.promptFamily === 'ko' ? 'strict' : 'natural') : null),
  });
  const lengthContract = resolveLengthContract({
    language: tag, length, legacyLength, storedLength, storedLegacyLength,
  });
  const format = resolveCanonicalFormatVersion({
    language: tag, stored: storedFormatVersion, storedHasKey: formatVersionKeyPresent,
  });
  return {
    phase,
    language: tag.tag,
    baseLanguage: tag.baseLanguage,
    promptFamily: tag.promptFamily,
    implicitLegacy: resolved.implicitLegacy,
    languageSource: resolved.source,
    canonicalFormatVersion: format.canonicalFormatVersion,
    writesFormatKeys: format.writesFormatKeys,
    length: lengthContract,
    contract,
    contractHash: computeLanguageContractHash(contract),
    profile: profile ?? null,
    foundation: foundation ?? null,
    creationRecord: creationRecord ?? null,
  };
}

/**
 * 수락된 생성 기록. 최초 발행 전에도 `world/setting.md` 의 language/형식 키 손수정과
 * 프로필 손수정을 대조할 수 있는 원천이다. 저장은 store 가 불변으로 다룬다.
 */
export function buildAcceptedCreationRecord({ workId, resolution, profile, acceptedAt = new Date().toISOString() }) {
  return {
    schemaVersion: ACCEPTED_CREATION_SCHEMA_VERSION,
    workId,
    language: resolution.language,
    promptFamily: resolution.promptFamily,
    canonicalFormatVersion: resolution.canonicalFormatVersion,
    length: { unit: resolution.length.unit, target: resolution.length.target },
    languageSource: resolution.languageSource,
    contractHash: resolution.contractHash,
    workContract: resolution.contract,
    profileRevision: profile?.revision ?? null,
    profileStatus: profile?.status ?? null,
    acceptedAt,
  };
}

/**
 * 생성 이후의 프로필 손수정이 언어 불변 규칙을 우회하지 못하게 한다. 프로필은
 * 이 시점부터 동의하는 사본이며 실행 원천이 아니다.
 */
export function assertProfileAgreesWithCreation({ creationRecord, profile }) {
  if (!creationRecord || !profile) return;
  const stored = readStoredLanguage(profile);
  const profileLanguage = stored.hasKey ? normalizeLanguageTag(stored.language).tag : IMPLICIT_LEGACY_LANGUAGE;
  if (profileLanguage !== creationRecord.language) {
    throw new LanguagePolicyError(LANGUAGE_ERROR_CODES.WORK_LANGUAGE_IMMUTABLE, {
      requested: profileLanguage,
      stored: creationRecord.language,
      scope: 'profile',
    });
  }
}

/**
 * foundation 이전의 명시적 언어 변경인가. 변경이면 새 프로필 revision 이며 이전
 * 언어의 예시·승인·대기 질문을 계승하지 않는다.
 */
export function profileLanguageChange({ profile, requested }) {
  if (!profile || requested === null || requested === undefined || requested === '') {
    return { changed: false, from: null, to: null };
  }
  const stored = readStoredLanguage(profile);
  const from = stored.hasKey ? normalizeLanguageTag(stored.language).tag : IMPLICIT_LEGACY_LANGUAGE;
  const to = normalizeLanguageTag(requested).tag;
  return { changed: from !== to, from, to };
}

/**
 * 수락된 생성 기록이 있거나 문서에 언어 키가 있으면 신작 계약이다. 호출자가
 * workContract 를 빠뜨렸다고 구작으로 내리지 않는다. 키 없는 구작의 저수준
 * 수동 check/commit 만 레거시 분기다. 새로 시작한 workflow 는
 * `usesChapterValidationGate` 가 연다.
 */
export function isNewContractWork(resolution, { foundation = null, creationRecord = null } = {}) {
  if (resolution?.creationRecord || creationRecord)
    return true;
  const doc = resolution?.foundation ?? foundation;
  if (doc && Object.hasOwn(doc, 'language'))
    return true;
  if (resolution?.writesFormatKeys)
    return true;
  return false;
}

/**
 * 활성 집필 워크플로는 키 없는 구작이어도 새 검사 계약을 쓴다. 파일의 언어 키
 * 부재는 발행 때 그대로 두고, 이미 승인·발행된 산출물을 읽기만 할 때는
 * 소급 감사하지 않는다.
 */
export function usesChapterValidationGate({
  resolution = null, foundation = null, creationRecord = null, workflow = null, chapter = null,
} = {}) {
  if (workflow && Number(workflow.chapter) === Number(chapter)
    && !['completed', 'rejected'].includes(workflow.stage)) {
    return true;
  }
  return isNewContractWork(resolution, { foundation, creationRecord });
}

/**
 * 엔진에 넘기는 foundation 스냅샷은 저장된 정본을 바꾸지 않고, 지금 승인된
 * 계약과 분량을 붙인다. 생성 당시 3000 과 프로필 3300 이 동시에 보이지 않게 한다.
 */
export function executionFoundationSnapshot(foundation, workContract) {
  if (!foundation || typeof foundation !== 'object')
    return foundation ?? null;
  if (!workContract)
    return foundation;
  const snapshot = { ...foundation, workContract };
  if (workContract.length && typeof workContract.length === 'object') {
    snapshot.length = { unit: workContract.length.unit, target: workContract.length.target };
  }
  return snapshot;
}

/**
 * 예외만 바뀐 프로필 revision 인가. locale/본문/그 밖 계약 필드는 같아야 한다.
 * 문법 정규화 뒤에 실제 인물 ID·인용 출처 결합은 호출자가 이어서 검증한다.
 */
export function isExceptionOnlyProfileRevision({ previous, next } = {}) {
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object')
    return false;
  const skip = new Set([
    'allowedLanguageExceptions', 'revision', 'status', 'approvedAt', 'approvedBy',
    'updatedAt', 'createdAt', 'approval', 'approvalId',
  ]);
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (skip.has(key))
      continue;
    if (JSON.stringify(previous[key] ?? null) !== JSON.stringify(next[key] ?? null))
      return false;
  }
  return JSON.stringify(previous.allowedLanguageExceptions ?? [])
    !== JSON.stringify(next.allowedLanguageExceptions ?? []);
}

export { CANONICAL_FORMAT_VERSION_LEGACY_KO };
