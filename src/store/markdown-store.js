/**
 * MarkdownStateStore -- the engine's StateStore port, backed by a directory the
 * writer owns.
 *
 * The split, and why it is drawn here:
 *
 *   markdown  -- things a novelist writes, reads and edits by hand: the world,
 *                the cast, the chapters, the summaries. These files are
 *                CANONICAL. If the writer opens `characters/riel.md` and
 *                changes an eye colour, that edit is the truth and the next
 *                load reflects it.
 *   .vibelore -- machine bookkeeping nobody edits by hand: the genre profile,
 *                the intrinsic-change log, story-state deltas, arc cursors,
 *                entity snapshots, suspended runs. JSON, because forcing it
 *                into markdown produces files that are both unpleasant to read
 *                and lossy to parse.
 *
 * The rule that keeps trust intact: a save never destroys something a human put
 * in a file. Unknown frontmatter keys and unknown `##` sections survive a
 * round trip untouched -- see `mergeCharacterDoc`.
 */
import { normalizeStoryState } from '../../engine/src/continuity/story-state.js';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  bulletSection, formatDocument, parseDocument, readBullets, readSection, section,
} from '../md/frontmatter.js';
import {
  CANONICAL_FORMAT_ERROR_CODES, CANONICAL_FORMAT_KEYS, CanonicalFormatError,
  CHARACTER_SECTION_KEYS, SETTING_SECTION_KEYS,
  allOwnedHeadings, assertCanonicalSections, formatKeysToWrite, headingsFor, resolveDocumentFormat,
} from './canonical-format.js';
import { CANONICAL_FORMAT_VERSION_MULTILINGUAL, normalizeLanguageTag } from '../../engine/src/core/language-policy.js';

/** 비교 전용 정규화. 태그가 깨졌으면 원문 그대로 비교해 오류를 숨기지 않는다. */
function comparableLanguage(value) {
  try { return normalizeLanguageTag(value).tag; }
  catch { return String(value); }
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function assertSafeId(kind, value) {
  if (typeof value !== 'string' || value.length === 0 || !SAFE_ID.test(value)) {
    throw new Error(`MarkdownStateStore: invalid ${kind} ${JSON.stringify(value)} (must match [A-Za-z0-9_-]+)`);
  }
}

/** Chapter files sort correctly in a file listing and read correctly to a human. */
function pad(n) { return String(n).padStart(3, '0'); }

async function readTextOrNull(path) {
  try { return await readFile(path, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

async function readJsonOrNull(path) {
  const raw = await readTextOrNull(path);
  if (raw === null) return null;
  try { return JSON.parse(raw); }
  catch (err) {
    throw new Error(`MarkdownStateStore: ${path} is not valid JSON -- ${err.message}`);
  }
}

/** Write via tmp+rename so an interrupted save never leaves a half-written file. */
async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

const writeJson = (path, value) => writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

/** Frontmatter keys and section headings this store owns. Everything else is the writer's. */
const CHARACTER_KEYS = new Set([
  'id', 'name', 'aliases', 'role', 'gender', 'ageBand', 'birthOrder', 'appearance',
  'species', 'form', 'genderLabel', 'acceptedPronouns', 'acceptedGenderedTerms',
  'forbiddenGenderedTerms', 'registeredAtChapter',
  ...CANONICAL_FORMAT_KEYS,
]);

function jsonSection(heading, value) {
  if (!value || typeof value !== 'object') return '';
  return section(heading, `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
}

function readJsonSection(body, heading) {
  const raw = readSection(body, heading);
  if (!raw) return undefined;
  const json = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(json); } catch { return undefined; }
}

function characterToDoc(character, existingText, { version, formatKeys }) {
  const heading = headingsFor(version);
  const intrinsic = character.intrinsic ?? {};
  const owned = {
    id: character.id,
    name: character.canonicalName,
    // Aliases are load-bearing, not decoration: the lexicon scan matches prose
    // against every name a character answers to, so a missing alias reads as a
    // stranger appearing in the scene.
    aliases: character.aliases ?? [],
    role: intrinsic.role,
    gender: intrinsic.gender,
    genderLabel: intrinsic.genderLabel,
    species: intrinsic.species,
    form: intrinsic.form,
    ageBand: intrinsic.ageBand,
    birthOrder: intrinsic.birthOrder,
    appearance: intrinsic.coreAppearance ?? [],
    acceptedPronouns: intrinsic.addressing?.acceptedPronouns ?? [],
    acceptedGenderedTerms: intrinsic.addressing?.acceptedGenderedTerms ?? [],
    forbiddenGenderedTerms: intrinsic.addressing?.forbiddenGenderedTerms ?? [],
    registeredAtChapter: character.registeredAtChapter,
  };
  const prior = existingText ? parseDocument(existingText) : { data: {}, body: '' };
  // Foreign frontmatter keys are the writer's; keep them, and keep them last so
  // the engine's own fields stay at the top where they are easy to scan.
  const foreign = {};
  for (const [k, v] of Object.entries(prior.data)) {
    if (!CHARACTER_KEYS.has(k)) foreign[k] = v;
  }
  // 버전 2 의 소유 표제는 내용이 비어도 생성한다. 버전 1 은 기존 동작을 그대로 둔다.
  const alwaysEmit = version === CANONICAL_FORMAT_VERSION_MULTILINGUAL;
  const dramaticModel = character.dramaticModel ?? readJsonSection(prior.body, heading.dramaticModel);
  const speechProfile = character.speechProfile ?? readJsonSection(prior.body, heading.speechProfile);
  const body = [
    section(heading.contradiction, character.contradiction ?? readSection(prior.body, heading.contradiction) ?? ''),
    section(heading.description, character.description ?? readSection(prior.body, heading.description) ?? ''),
    jsonSection(heading.dramaticModel, dramaticModel) || (alwaysEmit ? section(heading.dramaticModel, '') : ''),
    jsonSection(heading.speechProfile, speechProfile) || (alwaysEmit ? section(heading.speechProfile, '') : ''),
    preserveForeignSections(prior.body, allOwnedHeadings(CHARACTER_SECTION_KEYS)),
  ].filter((s) => s.trim() !== '').join('\n');
  return formatDocument({ ...owned, ...formatKeys, ...foreign }, body);
}

/** Everything under a `##` heading the store does not own, verbatim. */
function preserveForeignSections(body, ownedHeadings) {
  const lines = String(body ?? '').split(/\r?\n/);
  const out = [];
  let keeping = false;
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line.trim());
    if (m) keeping = !ownedHeadings.includes(m[1].trim());
    if (keeping) out.push(line);
  }
  return out.join('\n').trim();
}

function docToCharacter(text, extra, { version }) {
  const heading = headingsFor(version);
  const { data, body } = parseDocument(text);
  const appearance = Array.isArray(data.appearance)
    ? data.appearance.map(String)
    : (data.appearance === undefined || data.appearance === '' ? [] : [String(data.appearance)]);
  const aliases = Array.isArray(data.aliases)
    ? data.aliases.map(String)
    : (data.aliases === undefined || data.aliases === '' ? [] : [String(data.aliases)]);
  const contradiction = readSection(body, heading.contradiction) ?? '';
  const description = readSection(body, heading.description) ?? '';
  const dramaticModel = readJsonSection(body, heading.dramaticModel) ?? extra?.dramaticModel;
  const speechProfile = readJsonSection(body, heading.speechProfile) ?? extra?.speechProfile;
  return {
    ...(extra ?? {}),
    id: String(data.id),
    canonicalName: String(data.name ?? data.id),
    aliases,
    registeredAtChapter: Number(data.registeredAtChapter ?? 1),
    intrinsic: {
      ...(extra?.intrinsic ?? {}),
      ...(data.gender !== undefined ? { gender: String(data.gender) } : {}),
      ...(data.genderLabel !== undefined && data.genderLabel !== '' ? { genderLabel: String(data.genderLabel) } : {}),
      ...(data.species !== undefined ? { species: String(data.species) } : {}),
      ...(data.form !== undefined ? { form: String(data.form) } : {}),
      ...(data.ageBand !== undefined ? { ageBand: String(data.ageBand) } : {}),
      ...(data.birthOrder !== undefined ? { birthOrder: String(data.birthOrder) } : {}),
      ...(data.role !== undefined ? { role: String(data.role) } : {}),
      coreAppearance: appearance,
      addressing: {
        acceptedPronouns: Array.isArray(data.acceptedPronouns) ? data.acceptedPronouns.map(String) : [],
        acceptedGenderedTerms: Array.isArray(data.acceptedGenderedTerms) ? data.acceptedGenderedTerms.map(String) : [],
        forbiddenGenderedTerms: Array.isArray(data.forbiddenGenderedTerms) ? data.forbiddenGenderedTerms.map(String) : [],
      },
    },
    ...(contradiction ? { contradiction } : {}),
    ...(description ? { description } : {}),
    ...(dramaticModel ? { dramaticModel } : {}),
    ...(speechProfile ? { speechProfile } : {}),
  };
}

/** `- (w1) 문장` -- the id stays visible so a writer can see what the engine references. */
const FACT_LINE = /^\((?<id>[^)]+)\)\s*(?<statement>.+)$/;

export class MarkdownStateStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  // -- paths ----------------------------------------------------------------
  get settingPath() { return join(this.rootDir, 'world', 'setting.md'); }
  get storySpinePath() { return join(this.rootDir, 'world', 'story-spine.md'); }
  get writerSkillPath() { return join(this.rootDir, 'world', 'writer-skill.md'); }
  get charactersDir() { return join(this.rootDir, 'characters'); }
  characterPath(id) { return join(this.charactersDir, `${id}.md`); }
  chapterPath(n) { return join(this.rootDir, 'chapters', `${pad(n)}.md`); }
  summaryPath(n) { return join(this.rootDir, 'summaries', `${pad(n)}.md`); }
  get summariesDir() { return join(this.rootDir, 'summaries'); }
  sidecar(...parts) { return join(this.rootDir, '.vibelore', ...parts); }

  // -- ArcPlan --------------------------------------------------------------
  async loadArcPlan(workId) {
    assertSafeId('workId', workId);
    return readJsonOrNull(this.sidecar('arc-plan.json'));
  }

  async saveArcPlan(workId, plan) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('arc-plan.json'), plan);
    await writeJson(this.sidecar('arcs', `${plan.arcNumber}.json`), plan);
  }

  // -- StoryProfile ---------------------------------------------------------
  async loadStoryProfile(workId) {
    assertSafeId('workId', workId);
    return readJsonOrNull(this.sidecar('story-profile.json'));
  }

  async saveStoryProfile(workId, profile) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('story-profile.json'), profile);
  }

  // -- StorySpine -----------------------------------------------------------
  async loadStorySpine(workId) {
    assertSafeId('workId', workId);
    return readJsonOrNull(this.sidecar('story-spine.json'));
  }

  async saveStorySpine(workId, spine) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('story-spine.json'), spine);
    const body = [
      section('극적 질문', spine.dramaticQuestion ?? ''),
      section('주인공의 욕망과 필요', `욕망: ${spine.protagonistWant ?? ''}\n\n필요: ${spine.protagonistNeed ?? ''}`),
      section('잘못된 믿음과 최초 해법', `잘못된 믿음: ${spine.falseBelief ?? ''}\n\n최초 해법: ${spine.initialStrategy ?? ''}`),
      bulletSection('인과 사슬', spine.causalChain ?? []),
      section('중간 재해석', spine.midpointReframe ?? ''),
      section('최종 선택과 결말 비용', `선택: ${spine.finalChoice ?? ''}\n\n비용: ${spine.endingCost ?? ''}\n\n변화: ${spine.endingChange ?? ''}`),
      bulletSection('플롯을 바꾸는 인물 힘', (spine.characterForces ?? []).map((row) => `${row.characterId}: ${row.want} — ${row.actionThatChangesPlot}`)),
    ].join('\n');
    await writeAtomic(this.storySpinePath, formatDocument({ workId, status: spine.status }, body));
  }

  async loadWriterSkill(workId) {
    assertSafeId('workId', workId);
    return readJsonOrNull(this.sidecar('writer-skill.json'));
  }

  async saveWriterSkill(workId, skill) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('writer-skill.json'), skill);
    const body = [
      section('작가의 시선', skill.aestheticThesis ?? ''),
      bulletSection('작가 판단 원칙', skill.authorCraft?.judgments ?? []),
      bulletSection('생략과 여백', skill.authorCraft?.omissions ?? []),
      bulletSection('대사의 관계 행동', skill.authorCraft?.dialogueConduct ?? []),
      bulletSection('자기 장기 배반', skill.authorCraft?.selfBetrayal ?? []),
      bulletSection('사건 발생 원천', skill.storyDramaturgy?.conflictSources ?? []),
      bulletSection('압력 확대 법칙', skill.storyDramaturgy?.escalationLaws ?? []),
      section('주인공의 반복 오류', skill.storyDramaturgy?.protagonistError ?? ''),
      bulletSection('적대자의 적응', skill.storyDramaturgy?.oppositionAdaptation ?? []),
      bulletSection('핵심 판단 습관', skill.coreAttention ?? []),
      bulletSection('장면 변환 기술', skill.sceneTransformations ?? []),
      bulletSection('정보를 숨기는 감각', skill.withholdingInstinct ?? []),
      bulletSection('보상을 만드는 감각', skill.payoffInstinct ?? []),
      bulletSection('고착 방지', skill.antiFixation ?? []),
      bulletSection('작가에게 남기는 자유', skill.discoverySpaces ?? []),
    ].join('\n');
    await writeAtomic(this.writerSkillPath, formatDocument({ workId, status: skill.status, selectedCandidate: skill.selectedCandidate }, body));
  }

  // -- StoryExperience -----------------------------------------------------
  async loadStoryIdentity(workId) {
    assertSafeId('workId', workId);
    return readJsonOrNull(this.sidecar('story-identity.json'));
  }

  async saveStoryIdentity(workId, identity) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('story-identity.json'), identity);
  }

  async loadPilotContract(workId) {
    assertSafeId('workId', workId);
    return readJsonOrNull(this.sidecar('pilot-contract.json'));
  }

  async savePilotContract(workId, contract) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('pilot-contract.json'), contract);
  }

  async loadPatternLedger(workId) {
    assertSafeId('workId', workId);
    return (await readJsonOrNull(this.sidecar('pattern-ledger.json'))) ?? [];
  }

  async savePatternLedger(workId, entries) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('pattern-ledger.json'), entries);
  }

  async loadExperienceLedger(workId) {
    assertSafeId('workId', workId);
    const current = await readJsonOrNull(this.sidecar('experience-ledger.json'));
    if (current) return current;
    return { schemaVersion: 1, sourceHead: null, entries: await this.loadPatternLedger(workId) };
  }

  async saveExperienceLedger(workId, ledger) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('experience-ledger.json'), ledger);
    await writeJson(this.sidecar('pattern-ledger.json'), ledger.entries ?? []);
  }

  async loadWorkingTreeFingerprint() {
    return readJsonOrNull(this.sidecar('working-tree-fingerprint.json'));
  }

  async saveWorkingTreeFingerprint(fingerprint) {
    await writeJson(this.sidecar('working-tree-fingerprint.json'), fingerprint);
  }

  async loadStyleAnchor(workId) {
    assertSafeId('workId', workId);
    return readJsonOrNull(this.sidecar('style-anchor.json'));
  }

  async saveStyleAnchor(workId, anchor) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('style-anchor.json'), anchor);
  }

  async loadSyncCandidate(workId) {
    assertSafeId('workId', workId);
    return readJsonOrNull(this.sidecar('sync-candidate.json'));
  }

  async saveSyncCandidate(workId, candidate) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('sync-candidate.json'), candidate);
  }

  async loadArcReview(workId, arcNumber, chapter) {
    assertSafeId('workId', workId);
    return readJsonOrNull(this.sidecar('arc-reviews', `${Number(arcNumber)}-${Number(chapter)}.json`));
  }

  async saveArcReview(workId, review) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('arc-reviews', `${Number(review.arcNumber)}-${Number(review.chapter)}.json`), review);
  }

  // -- EpisodePlan ----------------------------------------------------------
  async loadEpisodePlan(workId, chapter) {
    assertSafeId('workId', workId);
    return readJsonOrNull(this.sidecar('episode-plans', `${chapter}.json`));
  }

  async saveEpisodePlan(workId, plan) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('episode-plans', `${plan.chapter}.json`), plan);
  }

  // -- ChapterWorkflow -----------------------------------------------------
  async saveModelExchange(workId, exchange) {
    assertSafeId('workId', workId);
    const exchangeId = createHash('sha256').update(JSON.stringify(exchange)).digest('hex');
    await writeJson(this.sidecar('model-exchanges', `${exchangeId}.json`), exchange);
    return exchangeId;
  }

  async loadModelExchange(workId, exchangeId) {
    assertSafeId('workId', workId);
    if (!/^[a-f0-9]{64}$/.test(exchangeId)) throw new Error('Invalid model exchange id');
    return readJsonOrNull(this.sidecar('model-exchanges', `${exchangeId}.json`));
  }

  async loadWorkflow(workId, workflowId = 'current') {
    assertSafeId('workId', workId);
    assertSafeId('workflowId', workflowId);
    return readJsonOrNull(this.sidecar('workflows', `${workflowId}.json`));
  }

  async saveWorkflow(workId, workflow) {
    assertSafeId('workId', workId);
    assertSafeId('workflowId', workflow.workflowId);
    await writeJson(this.sidecar('workflows', `${workflow.workflowId}.json`), workflow);
    await writeJson(this.sidecar('workflows', 'current.json'), workflow);
  }

  async appendWorkflowEvent(workId, workflowId, event) {
    assertSafeId('workId', workId);
    assertSafeId('workflowId', workflowId);
    const path = this.sidecar('workflow-events', `${workflowId}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async loadWorkflowEvents(workId, workflowId, limit = 100) {
    assertSafeId('workId', workId);
    assertSafeId('workflowId', workflowId);
    const raw = await readTextOrNull(this.sidecar('workflow-events', `${workflowId}.jsonl`));
    if (raw === null) return [];
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).slice(-Math.max(1, limit));
  }

  async saveCheckReceipt(workId, receipt) {
    assertSafeId('workId', workId);
    assertSafeId('checkId', receipt.checkId);
    await writeJson(this.sidecar('check-receipts', `${receipt.checkId}.json`), receipt);
  }

  async loadCheckReceipt(workId, checkId) {
    assertSafeId('workId', workId);
    assertSafeId('checkId', checkId);
    return readJsonOrNull(this.sidecar('check-receipts', `${checkId}.json`));
  }

  async loadApprovalValidation(workId, key) {
    assertSafeId('workId', workId);
    assertSafeId('approval validation key', key);
    return readJsonOrNull(this.sidecar('approval-validation', workId, `${key}.json`));
  }

  async saveApprovalValidation(workId, key, state) {
    assertSafeId('workId', workId);
    assertSafeId('approval validation key', key);
    await writeJson(this.sidecar('approval-validation', workId, `${key}.json`), state);
  }

  async saveValidationState(workId, state) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('validation-state', `${workId}.json`), state);
  }

  async loadValidationState(workId) {
    assertSafeId('workId', workId);
    return readJsonOrNull(this.sidecar('validation-state', `${workId}.json`));
  }

  async saveContextTrace(workId, trace) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('context-traces', `${trace.chapter}.json`), trace);
  }

  async loadContextTrace(workId, chapter) {
    assertSafeId('workId', workId);
    return readJsonOrNull(this.sidecar('context-traces', `${chapter}.json`));
  }

  async saveRevisionCandidates(workId, workflowId, candidates) {
    assertSafeId('workId', workId); assertSafeId('workflowId', workflowId);
    await writeJson(this.sidecar('revision-candidates', `${workflowId}.json`), candidates);
  }

  async loadRevisionCandidates(workId, workflowId) {
    assertSafeId('workId', workId); assertSafeId('workflowId', workflowId);
    return (await readJsonOrNull(this.sidecar('revision-candidates', `${workflowId}.json`))) ?? [];
  }

  // -- accepted creation record ---------------------------------------------
  /**
   * 수락된 생성 계약. 최초 발행 전에도 언어·정본 형식의 손수정을 막는 원천이며
   * 한 번 기록되면 바뀌지 않는다.
   */
  async loadAcceptedCreation(workId) {
    assertSafeId('workId', workId);
    return readJsonOrNull(this.sidecar('accepted-creation.json'));
  }

  async saveAcceptedCreation(workId, record) {
    assertSafeId('workId', workId);
    const existing = await this.loadAcceptedCreation(workId);
    if (existing) {
      const same = existing.language === record.language
        && Number(existing.canonicalFormatVersion) === Number(record.canonicalFormatVersion)
        && existing.length?.unit === record.length?.unit
        && Number(existing.length?.target) === Number(record.length?.target);
      if (!same) {
        throw new CanonicalFormatError(CANONICAL_FORMAT_ERROR_CODES.CREATION_RECORD_IMMUTABLE, {
          workId,
          stored: { language: existing.language, canonicalFormatVersion: existing.canonicalFormatVersion, length: existing.length ?? null },
          requested: { language: record.language, canonicalFormatVersion: record.canonicalFormatVersion, length: record.length ?? null },
        });
      }
      return existing;
    }
    await writeJson(this.sidecar('accepted-creation.json'), record);
    return record;
  }

  /** 이 작품 문서들이 따라야 하는 형식 계약. 기록이 없으면 null(구작). */
  async loadCanonicalContract(workId) {
    const record = await this.loadAcceptedCreation(workId);
    if (!record) return null;
    return {
      language: String(record.language),
      canonicalFormatVersion: Number(record.canonicalFormatVersion),
    };
  }

  // -- Foundation -----------------------------------------------------------
  async loadFoundation(workId) {
    assertSafeId('workId', workId);
    const settingText = await readTextOrNull(this.settingPath);
    if (settingText === null) return null;
    const { data, body } = parseDocument(settingText);
    const contract = await this.loadCanonicalContract(workId);
    const format = resolveDocumentFormat({ data, contract, doc: 'world/setting.md' });
    const heading = headingsFor(format.canonicalFormatVersion);
    assertCanonicalSections({
      body, version: format.canonicalFormatVersion, keys: SETTING_SECTION_KEYS, doc: 'world/setting.md',
    });
    const extra = (await readJsonOrNull(this.sidecar('foundation.json'))) ?? {};

    const worldFactMeta = new Map(Object.entries(extra.worldFactMeta ?? {}));
    const worldFacts = readBullets(body, heading.worldFacts).map((line, i) => {
      const m = FACT_LINE.exec(line);
      const id = m?.groups?.id?.trim() ?? `w${i + 1}`;
      const statement = (m?.groups?.statement ?? line).trim();
      return { id, statement, registeredAtChapter: Number(worldFactMeta.get(id) ?? 1) };
    });

    const characterExtras = extra.characterExtras ?? {};
    let files = [];
    try { files = await readdir(this.charactersDir); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const characters = [];
    for (const name of files.filter((f) => f.endsWith('.md')).sort()) {
      const text = await readTextOrNull(join(this.charactersDir, name));
      if (text === null) continue;
      const id = name.replace(/\.md$/, '');
      const doc = `characters/${name}`;
      const parsed = parseDocument(text);
      const charFormat = resolveDocumentFormat({ data: parsed.data, contract, doc });
      assertCanonicalSections({
        body: parsed.body, version: charFormat.canonicalFormatVersion, keys: CHARACTER_SECTION_KEYS, doc,
      });
      characters.push(docToCharacter(text, characterExtras[id], { version: charFormat.canonicalFormatVersion }));
    }

    return {
      ...(extra.rest ?? {}),
      workId: String(data.workId ?? workId),
      genre: String(data.genre ?? extra.rest?.genre ?? ''),
      worldFacts,
      characters,
      // 키가 없던 구작에는 키를 만들어 주지 않는다. 실행 해석은 호출자가
      // language-policy 로 결정한다.
      ...(format.languageKeyPresent ? { language: format.language } : {}),
      ...(format.formatVersionKeyPresent ? { canonicalFormatVersion: format.canonicalFormatVersion } : {}),
      intrinsicChanges: extra.intrinsicChanges ?? [],
      genreProfile: extra.genreProfile,
      ...(data.povMode !== undefined ? { povMode: data.povMode } : {}),
      ...(data.worldEra !== undefined ? { worldEra: data.worldEra } : {}),
      ...(data.fanficSource !== undefined ? { fanficSource: data.fanficSource } : {}),
    };
  }

  async saveFoundation(foundation) {
    assertSafeId('workId', foundation.workId);
    const record = await this.loadCanonicalContract(foundation.workId);
    // 호출자가 명시한 메타데이터가 수락된 생성 기록과 다르면 조용히 기록 쪽으로
    // 바꿔 쓰지 않고 쓰기 전에 거부한다. 메타데이터가 아예 없는 구작 입력은 다른
    // 경우이며 키의 부재를 그대로 보존한다.
    if (record) {
      if (foundation.language != null && comparableLanguage(foundation.language) !== record.language) {
        throw new CanonicalFormatError(CANONICAL_FORMAT_ERROR_CODES.WORK_LANGUAGE_IMMUTABLE, {
          workId: foundation.workId, scope: 'foundation-input',
          expected: record.language, requested: String(foundation.language),
        });
      }
      if (foundation.canonicalFormatVersion != null
        && Number(foundation.canonicalFormatVersion) !== record.canonicalFormatVersion) {
        throw new CanonicalFormatError(CANONICAL_FORMAT_ERROR_CODES.CANONICAL_FORMAT_CONTRACT_MISMATCH, {
          workId: foundation.workId, scope: 'foundation-input',
          expected: record.canonicalFormatVersion, requested: Number(foundation.canonicalFormatVersion),
        });
      }
    }
    // 생성 기록이 없는 작품에서도 이번 계약으로 **새로** 만드는 문서에는 언어와
    // 형식 버전을 기록한다. 이미 있는 문서의 키 부재는 그대로 보존한다.
    const newDocContract = record
      ?? (foundation.language != null && foundation.canonicalFormatVersion != null
        ? { language: String(foundation.language), canonicalFormatVersion: Number(foundation.canonicalFormatVersion) }
        : null);

    const prior = await readTextOrNull(this.settingPath);
    const priorDoc = prior ? parseDocument(prior) : { data: {}, body: '' };
    const settingFormat = prior
      ? resolveDocumentFormat({ data: priorDoc.data, contract: record, doc: 'world/setting.md' })
      : { canonicalFormatVersion: newDocContract?.canonicalFormatVersion ?? 1 };
    const settingHeading = headingsFor(settingFormat.canonicalFormatVersion);
    // 뒤쪽 인물 문서에서 충돌이 나 앞 문서만 바뀌는 일이 없도록, 쓰기 전에 문서
    // 집합 전체를 먼저 검증한다.
    assertCanonicalSections({
      body: priorDoc.body, version: settingFormat.canonicalFormatVersion, keys: SETTING_SECTION_KEYS, doc: 'world/setting.md',
    });
    const characterPlans = [];
    for (const c of foundation.characters ?? []) {
      assertSafeId('character id', c.id);
      const doc = `characters/${c.id}.md`;
      const existing = await readTextOrNull(this.characterPath(c.id));
      const parsed = existing ? parseDocument(existing) : { data: {}, body: '' };
      const format = existing
        ? resolveDocumentFormat({ data: parsed.data, contract: record, doc })
        : { canonicalFormatVersion: newDocContract?.canonicalFormatVersion ?? 1 };
      assertCanonicalSections({
        body: parsed.body, version: format.canonicalFormatVersion, keys: CHARACTER_SECTION_KEYS, doc,
      });
      characterPlans.push({
        character: c,
        existing,
        version: format.canonicalFormatVersion,
        formatKeys: formatKeysToWrite({
          priorData: parsed.data, exists: Boolean(existing), contract: existing ? record : newDocContract,
        }),
      });
    }

    const owned = new Set(['workId', 'genre', 'povMode', 'worldEra', 'fanficSource', ...CANONICAL_FORMAT_KEYS]);
    const foreignKeys = Object.fromEntries(
      Object.entries(priorDoc.data).filter(([k]) => !owned.has(k)),
    );

    const body = [
      bulletSection(settingHeading.worldFacts, (foundation.worldFacts ?? []).map((f) => `(${f.id}) ${f.statement}`)),
      preserveForeignSections(priorDoc.body, allOwnedHeadings(SETTING_SECTION_KEYS)),
    ].filter((s) => s.trim() !== '').join('\n');

    await writeAtomic(this.settingPath, formatDocument({
      workId: foundation.workId,
      genre: foundation.genre,
      ...(foundation.povMode !== undefined ? { povMode: foundation.povMode } : {}),
      ...(foundation.worldEra !== undefined ? { worldEra: foundation.worldEra } : {}),
      ...(foundation.fanficSource !== undefined ? { fanficSource: foundation.fanficSource } : {}),
      ...formatKeysToWrite({ priorData: priorDoc.data, exists: Boolean(prior), contract: prior ? record : newDocContract }),
      ...foreignKeys,
    }, body));

    const characterExtras = {};
    for (const { character: c, existing, version, formatKeys } of characterPlans) {
      await writeAtomic(this.characterPath(c.id), characterToDoc(c, existing, { version, formatKeys }));
      // Anything the markdown projection cannot express is kept beside it, so a
      // round trip is lossless even for fields this store has never seen.
      const { id, canonicalName, aliases, registeredAtChapter, intrinsic, contradiction, description, dramaticModel, speechProfile, ...rest } = c;
      const intrinsicRest = { ...(intrinsic ?? {}) };
      for (const k of ['gender', 'genderLabel', 'species', 'form', 'ageBand', 'birthOrder', 'role', 'coreAppearance', 'addressing']) delete intrinsicRest[k];
      if (Object.keys(rest).length > 0 || Object.keys(intrinsicRest).length > 0) {
        characterExtras[c.id] = {
          ...rest,
          ...(Object.keys(intrinsicRest).length > 0 ? { intrinsic: intrinsicRest } : {}),
        };
      }
    }

    const { workId, genre, worldFacts, characters, intrinsicChanges, genreProfile,
      povMode, worldEra, fanficSource, language, canonicalFormatVersion, ...rest } = foundation;
    await writeJson(this.sidecar('foundation.json'), {
      genreProfile,
      intrinsicChanges: intrinsicChanges ?? [],
      worldFactMeta: Object.fromEntries(
        (worldFacts ?? []).map((f) => [f.id, f.registeredAtChapter ?? 1]),
      ),
      characterExtras,
      ...(Object.keys(rest).length > 0 ? { rest } : {}),
    });
  }

  // -- StoryState -----------------------------------------------------------
  async loadStoryState(workId, chapterNumber) {
    assertSafeId('workId', workId);
    return normalizeStoryState(await readJsonOrNull(this.sidecar('story-state', `${chapterNumber}.json`)));
  }

  async saveStoryState(state) {
    assertSafeId('workId', state.workId);
    await writeJson(this.sidecar('story-state', `${state.chapterNumber}.json`), state);
  }

  // -- ChapterArtifact ------------------------------------------------------
  async loadArtifact(workId, chapterNumber) {
    assertSafeId('workId', workId);
    const meta = await readJsonOrNull(this.sidecar('artifacts', `${chapterNumber}.json`));
    const text = await readTextOrNull(this.chapterPath(chapterNumber));
    if (meta === null && text === null) return null;
    const { body, data } = text === null ? { body: '', data: {} } : parseDocument(text);
    return {
      ...(meta ?? { workId, chapterNumber }),
      ...(data.title !== undefined ? { title: String(data.title) } : {}),
      // formatDocument writes a trailing newline; strip it so prose round-trips
      // to exactly what was handed in.
      prose: body.replace(/\s+$/, ''),
    };
  }

  async saveArtifact(artifact) {
    assertSafeId('workId', artifact.workId);
    const { prose, title, ...meta } = artifact;
    const prior = await readTextOrNull(this.chapterPath(artifact.chapterNumber));
    const priorDoc = prior ? parseDocument(prior) : { data: {}, body: '' };
    await writeAtomic(this.chapterPath(artifact.chapterNumber), formatDocument({
      chapter: artifact.chapterNumber,
      ...(title !== undefined ? { title } : (priorDoc.data.title !== undefined ? { title: priorDoc.data.title } : {})),
    }, prose ?? ''));
    await writeJson(this.sidecar('artifacts', `${artifact.chapterNumber}.json`), meta);
  }

  // -- ChapterSummary -------------------------------------------------------
  async saveChapterSummary(record) {
    assertSafeId('workId', record.workId);
    const { summary, workId, chapterNumber, ...meta } = record;
    await writeAtomic(this.summaryPath(chapterNumber), formatDocument(
      { workId, chapter: chapterNumber },
      section('요약', summary ?? ''),
    ));
    if (Object.keys(meta).length > 0) {
      await writeJson(this.sidecar('summaries', `${chapterNumber}.json`), meta);
    }
  }

  async loadChapterSummary(workId, chapterNumber) {
    assertSafeId('workId', workId);
    const text = await readTextOrNull(this.summaryPath(chapterNumber));
    if (text === null) return null;
    const { data, body } = parseDocument(text);
    const meta = (await readJsonOrNull(this.sidecar('summaries', `${chapterNumber}.json`))) ?? {};
    return {
      ...meta,
      workId: String(data.workId ?? workId),
      chapterNumber: Number(data.chapter ?? chapterNumber),
      summary: readSection(body, '요약') ?? body.trim(),
    };
  }

  async loadRecentChapterSummaries(workId, beforeChapter, limit) {
    assertSafeId('workId', workId);
    if (limit <= 0) return [];
    let entries = [];
    try { entries = await readdir(this.summariesDir); }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    const numbers = entries
      .filter((n) => n.endsWith('.md'))
      .map((n) => Number(n.replace(/\.md$/, '')))
      .filter((n) => Number.isInteger(n) && n > 0 && n < beforeChapter)
      .sort((a, b) => b - a)
      .slice(0, limit);
    const out = [];
    for (const n of numbers) {
      const rec = await this.loadChapterSummary(workId, n);
      if (rec) out.push(rec);
    }
    return out;
  }

  // -- Entities / Jobs ------------------------------------------------------
  async loadEntitySnapshots(workId) {
    assertSafeId('workId', workId);
    return (await readJsonOrNull(this.sidecar('entities.json'))) ?? [];
  }

  async saveEntitySnapshots(workId, snapshots) {
    assertSafeId('workId', workId);
    await writeJson(this.sidecar('entities.json'), snapshots ?? []);
  }

  async loadJob(jobId) {
    assertSafeId('jobId', jobId);
    return readJsonOrNull(this.sidecar('jobs', `${jobId}.json`));
  }

  async saveJob(job) {
    assertSafeId('workId', job.workId);
    assertSafeId('jobId', job.id);
    await writeJson(this.sidecar('jobs', `${job.id}.json`), job);
  }

  // -- chapter discovery (plugin-level, not part of the engine port) --------
  async listChapters() {
    let entries = [];
    try { entries = await readdir(join(this.rootDir, 'chapters')); }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    return entries
      .filter((n) => n.endsWith('.md'))
      .map((n) => Number(n.replace(/\.md$/, '')))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b);
  }
}
