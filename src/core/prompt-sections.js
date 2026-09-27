import { effectiveIntrinsic } from '../../engine/src/continuity/character.js';
import { isHookActive, trackedRecordKey } from '../../engine/src/continuity/story-state.js';
import { searchTerms } from './search-terms.js';

/**
 * Shared text renderers for every model request that carries characters, world
 * facts or the carried story state. Requests used to embed these as JSON in a
 * different shape each; one renderer keeps the same fact in the same words
 * everywhere (and byte-identical for prompt caches). IDs stay inline so answers
 * can still name them exactly.
 *
 * Foundation `mutable` is design-time data (the chapter-one location), so it is
 * never rendered: the current location and condition come from
 * `state.characterStates`.
 */

const asArray = (value) => Array.isArray(value) ? value : [];
const clean = (value) => typeof value === 'string' ? value.trim() : '';

export function renderCharacter(foundation, character, chapter, kit, { appearance = true, initialPlacement = false, description = false } = {}) {
  const t = kit.phrases.context;
  const labels = t.intrinsicLabels;
  const events = asArray(foundation.intrinsicChanges).filter((e) => e.characterId === character.id);
  const intrinsic = effectiveIntrinsic({ ...character.intrinsic, coreAppearance: asArray(character.intrinsic?.coreAppearance) }, events, chapter);
  const pinned = Object.entries(labels)
    .filter(([k]) => intrinsic[k] !== undefined && intrinsic[k] !== '')
    .map(([k, label]) => `${label}=${intrinsic[k]}`);
  if (appearance && intrinsic.coreAppearance?.length) pinned.push(t.appearance(intrinsic.coreAppearance.join('·')));
  const lines = [`- ${character.canonicalName} (\`${character.id}\`) — ${pinned.join(', ')}`];
  if (asArray(character.aliases).length) lines.push(t.characterAliases(character.aliases.join(', ')));
  if (description && clean(character.description)) lines.push(t.characterDescription(clean(character.description)));
  if (character.contradiction) lines.push(t.characterContradiction(character.contradiction));
  const model = character.dramaticModel;
  if (model?.valueOrder?.length) lines.push(t.valueOrder(model.valueOrder.join(' > ')));
  for (const trait of (model?.behaviorTraits ?? []).slice(0, 3)) {
    lines.push(t.behaviorTrait(trait.trigger, trait.actionBias, trait.benefit, trait.cost));
  }
  if (model?.perception?.seesFirst?.length || model?.perception?.missesFirst?.length) {
    lines.push(t.perception(model.perception.seesFirst?.join('·') || '-', model.perception.missesFirst?.join('·') || '-'));
  }
  if (model?.defense?.underPressure) lines.push(t.defense(model.defense.underPressure));
  if (model?.repair?.firstMove) lines.push(t.repair(model.repair.firstMove));
  const speech = character.speechProfile;
  if (speech) {
    const samples = speech.samples ?? {};
    lines.push(t.speech([speech.defaultRegister, speech.sentenceShape, speech.logicHabit, speech.emotionalLeak].filter(Boolean).join(' / ') || t.speechProfilePresent));
    const sampleLines = [
      samples.everyday ? t.speechSampleEveryday(samples.everyday) : '',
      samples.underPressure ? t.speechSamplePressure(samples.underPressure) : '',
      samples.lying ? t.speechSampleLying(samples.lying) : '',
      samples.intimate ? t.speechSampleIntimate(samples.intimate) : '',
    ].filter(Boolean);
    if (sampleLines.length) lines.push(t.speechSamples(sampleLines.join(' / ')));
    if (speech.relationVariants?.length) {
      lines.push(t.relationVariants(speech.relationVariants.map((row) => `${row.targetId || '?'}=${row.adjustment || row.sample || ''}`).join('; ')));
    }
  }
  // Design-time knowledge stays true; the design-time place and condition only
  // describe the opening, so they are shown when asked for (chapter one).
  const initial = character.mutable ?? {};
  if (asArray(initial.knownFacts).length) lines.push(t.initialKnowledge(initial.knownFacts.join('; ')));
  if (initialPlacement && (clean(initial.location) || clean(initial.status))) {
    lines.push(t.initialPlacement([clean(initial.location), clean(initial.status)].filter(Boolean).join(' · ')));
  }
  const changed = events.filter((e) => e.atChapter <= chapter);
  if (changed.length > 0) {
    lines.push(t.intrinsicChanges(changed.map((e) => t.intrinsicChange(e.atChapter, labels[e.field] ?? e.field, JSON.stringify(e.from), JSON.stringify(e.to))).join('; ')));
  }
  return lines.join('\n');
}

/** Characters in `ids` order (all registered ones when `ids` is empty). */
export function renderCharacters(foundation, ids, chapter, kit, options = {}) {
  const wanted = asArray(ids);
  const characters = asArray(foundation?.characters)
    .filter((c) => c.disabled !== true && (c.registeredAtChapter ?? 0) <= chapter)
    .filter((c) => !wanted.length || wanted.includes(c.id))
    .sort((a, b) => (wanted.length ? wanted.indexOf(a.id) - wanted.indexOf(b.id) : 0));
  return characters.map((c) => renderCharacter(foundation, c, chapter, kit, options)).join('\n');
}

/**
 * The fixed setting a writer drafts (or rewrites) a chapter against: world
 * facts, the cast and the genre invariants. Appearance is given only where a
 * character first enters; repeating it every chapter pulled appearance tags
 * into climaxes. The design-time place and condition belong to chapter one.
 */
export function renderWriterFoundation(foundation, cast, chapter, kit) {
  const t = kit.phrases.sections;
  const invariants = asArray(foundation?.genreProfile?.invariants).map((inv) => t.invariant(inv.severity, inv.description));
  const ids = asArray(cast).length ? cast : asArray(foundation?.characters)
    .filter((c) => c.disabled !== true && (c.registeredAtChapter ?? 0) <= chapter).map((c) => c.id);
  return [
    t.worldFactsHeading, renderWorldFacts(foundation, kit), '',
    t.charactersHeading,
    ...ids.map((id) => renderCharacters(foundation, [id], chapter, kit, {
      appearance: chapter === 1 || asArray(foundation?.characters).find((c) => c.id === id)?.registeredAtChapter === chapter,
      initialPlacement: chapter === 1,
    })).filter(Boolean),
    ...(invariants.length ? ['', t.invariantsHeading, ...invariants] : []),
  ].join('\n');
}

export function renderWorldFacts(foundation, kit) {
  return asArray(foundation?.worldFacts).map((fact) => `- ${fact.statement}`).join('\n');
}

function flatBody(data, name) {
  return Object.entries(data ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${[].concat(value).map((v) => (typeof v === 'object' ? Object.values(v).join(' ') : name(v))).join(', ')}`)
    .join('; ');
}

const MODES = new Set(['writer', 'extract', 'check']);
const WRITER_TRACKED_LIMIT = 12;
const WRITER_RELATION_LIMIT = 6;
const WRITER_KNOWN_FACTS = 3;
const EXTRACT_TRACKED_LIMIT = 30;
const EXTRACT_RELATION_LIMIT = 12;
const HOOK_LIMIT = 12;
const RECENT_HOOK_CHAPTERS = 3;
const RECENT_LOSS_CHAPTERS = 5;
const ENTITY_LIMIT = 20;
const HOOK_MATCH_WEIGHT = 2;
const HOLDER_FIELDS = ['holder', 'owner', 'user', 'holders', 'characterId', 'from', 'to'];

function mentions(record, ids) {
  return HOLDER_FIELDS.some((field) => asArray([].concat(record.data?.[field] ?? [])).some((value) => ids.has(value)));
}

function directed(relationship) {
  const arrow = /^([^\s>]+)->([^\s>]+)$/.exec(clean(relationship.to));
  const from = clean(relationship.from) || arrow?.[1] || '';
  const to = arrow && !clean(relationship.from) ? arrow[2] : clean(relationship.to);
  return from ? { from, to, kind: clean(relationship.kind), state: clean(relationship.state) } : null;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const TRAILING_BLOCK = /[\p{N}A-Za-z]/u;

/**
 * `name` occurs in `text` as a word: not glued to a letter or digit before it,
 * and not followed by a digit or Latin letter ("조연5" does not match "조연50").
 * Korean particles may follow ("리아가").
 */
function namedIn(text, name) {
  if (typeof name !== 'string' || name.length < 2) return false;
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const before = at > 0 ? text[at - 1] : '';
    const after = text[at + name.length] ?? '';
    if (!(before && WORD_CHAR.test(before)) && !(after && TRAILING_BLOCK.test(after))) return true;
  }
  return false;
}

/** Characters whose name or alias appears in `text`, plus `cast`. */
export function namedCharacters(foundation, text, cast = []) {
  const named = new Set(asArray(cast));
  const value = clean(text);
  if (!value) return named;
  for (const c of asArray(foundation?.characters)) {
    if ([c.canonicalName, ...asArray(c.aliases)].some((n) => namedIn(value, n))) named.add(c.id);
  }
  return named;
}

const IDENTITY_FIELDS = ['name', 'title', 'label', 'canonicalName', 'id'];

/** 2 when the text names the record (an identity field), 1 when it only shares another field value. */
function textMatches(record, text) {
  if (!text) return 0;
  const hit = (value) => typeof value === 'string' && value.length >= 2 && value.length <= 40 && text.includes(value);
  const data = record.data ?? {};
  if (IDENTITY_FIELDS.some((field) => hit(data[field]))) return 2;
  return Object.entries(data).some(([field, value]) => !IDENTITY_FIELDS.includes(field) && hit(value)) ? 1 : 0;
}

/**
 * Open hooks that bear on the text: shared words weighing at least
 * HOOK_MATCH_WEIGHT characters, or planted in the last few chapters. The rest
 * are counted, not listed, so the list does not grow with the work.
 */
function selectHooks(active, text, language, now, hookIds = new Set(), oldest = 0) {
  const debt = new Set([...active].sort((a, b) => (a.plantedAtChapter ?? 0) - (b.plantedAtChapter ?? 0)).slice(0, oldest).map((hook) => hook.id));
  const terms = new Set(searchTerms(text, language));
  const scored = active.map((hook, index) => {
    const weight = [...new Set(searchTerms(hook.text ?? '', language))].filter((term) => term.length >= 2 && terms.has(term))
      .reduce((sum, term) => sum + term.length, 0);
    const recent = Number.isFinite(now) && Number(hook.plantedAtChapter) >= now - RECENT_HOOK_CHAPTERS + 1;
    const planned = hookIds.has(hook.id) || debt.has(hook.id);
    return { hook, index, weight, recent, planned };
  }).filter((item) => item.planned || item.weight >= HOOK_MATCH_WEIGHT || item.recent)
    .sort((a, b) => Number(b.planned) - Number(a.planned) || b.weight - a.weight || (b.hook.plantedAtChapter ?? 0) - (a.hook.plantedAtChapter ?? 0) || a.index - b.index);
  // Hooks the plan touches (and a planner's oldest ones) are never cut; the cap applies to the rest.
  const planned = scored.filter((item) => item.planned);
  const others = scored.filter((item) => !item.planned);
  const kept = [...planned, ...others.slice(0, Math.max(0, HOOK_LIMIT - planned.length))];
  return { shown: kept.map((item) => item.hook), omitted: active.length - scored.length, capped: scored.length - kept.length };
}

/** Known facts sharing words with the focus first, then the latest, up to WRITER_KNOWN_FACTS. */
function selectFacts(facts, text, language) {
  const terms = new Set(searchTerms(text, language));
  const matching = facts.filter((fact) => typeof fact === 'string' && searchTerms(fact, language).some((term) => term.length >= 2 && terms.has(term)));
  const chosen = [...matching.slice(-WRITER_KNOWN_FACTS)];
  for (const fact of [...facts].reverse()) {
    if (chosen.length >= WRITER_KNOWN_FACTS) break;
    if (!chosen.includes(fact)) chosen.push(fact);
  }
  return facts.filter((fact) => chosen.includes(fact));
}

/**
 * Tracked records the text names directly come first, then records held by a
 * named character, most recent first, up to `limit`.
 */
function selectTracked(tracked, text, ids, limit) {
  const ranked = tracked.map((record, index) => {
    const match = textMatches(record, text);
    const held = mentions(record, ids);
    // Named outright first, then held by a named character, then a shared field value.
    return { record, index, rank: match === 2 ? 3 : held ? 2 : match };
  }).filter((item) => item.rank > 0)
    .sort((a, b) => b.rank - a.rank || (b.record.updatedChapter ?? 0) - (a.record.updatedChapter ?? 0) || b.index - a.index)
    .slice(0, limit);
  return { shown: ranked.map((item) => item.record), omitted: tracked.length - ranked.length, capped: Math.max(0, tracked.filter((record) => textMatches(record, text) || mentions(record, ids)).length - ranked.length) };
}

/**
 * The carried StoryState as text, limited to what bears on this chapter so
 * that it does not grow with the length of the work. `focusText` is what the
 * request is about (the plan for a writer, the prose for extraction and the
 * check); characters named in it join `cast`.
 * `hookIds` (the plan's touched hooks) and the `oldestHooks` longest-open ones
 * (a planner's debt) are always listed.
 * - `writer`: cast states, dead or missing characters the focus names or who
 *   were lost in the last chapters, address terms within the cast, open
 *   threads the focus touches or that were just planted, directed
 *   relationships touching the cast, tracked items the cast holds or the
 *   focus names.
 * - `extract`: the same selection with exact keys and hook ids, so the
 *   extractor updates existing records instead of inventing new ones.
 * - `check`: states and address terms of the named characters.
 * What is left out is counted, never silently dropped.
 */
export function renderCurrentState(state, foundation, { cast = [], kit, mode = 'writer', focusText = '', entities = [], hookIds = [], oldestHooks = 0 } = {}) {
  if (!MODES.has(mode)) throw new Error(`UNKNOWN_STATE_RENDER_MODE: ${mode}`);
  if (!state) return '';
  const t = kit.phrases.sections;
  const focus = clean(focusText);
  const castIds = new Set(asArray(cast));
  const named = namedCharacters(foundation, focus, cast);
  const now = Number(state.chapterNumber);
  const name = (id) => asArray(foundation?.characters).find((c) => c.id === id)?.canonicalName ?? id;
  const lines = [t.currentStateHeading];

  const states = state.characterStates ?? {};
  const lost = (value) => value?.vitalStatus === 'dead' || value?.vitalStatus === 'missing';
  const wanted = ([id, value]) => named.has(id)
    || (mode === 'writer' && lost(value) && Number(value?.sinceChapter) >= now - RECENT_LOSS_CHAPTERS + 1);
  const entries = Object.entries(states);
  const people = entries.filter(wanted)
    .map(([id, value]) => {
      const parts = [];
      if (value?.vitalStatus && t.vital[value.vitalStatus]) parts.push(t.vital[value.vitalStatus]);
      if (clean(value?.location)) parts.push(t.location(clean(value.location)));
      if (clean(value?.status)) parts.push(t.status(clean(value.status)));
      const facts = selectFacts(asArray(value?.knownFacts), focus, kit.language);
      if (mode === 'writer' && facts.length) parts.push(t.knownFacts(facts.join('; ')));
      return parts.length ? t.person(name(id), id, parts.join(' · ')) : '';
    }).filter(Boolean);
  const peopleOmitted = entries.length - entries.filter(wanted).length;
  if (people.length) lines.push(t.peopleHeading, ...people);
  if (peopleOmitted > 0) lines.push(t.omitted(peopleOmitted));

  const address = Object.entries(state.addressMap?.entries ?? {}).map(([key, entry]) => {
    const [speaker, target] = key.split('->');
    const within = mode === 'writer' ? castIds.has(speaker) && castIds.has(target) : named.has(speaker) && named.has(target);
    if (!within) return '';
    return mode === 'extract'
      ? t.addressKeyed(key, name(speaker), name(target), entry.term, entry.sinceChapter)
      : t.address(name(speaker), name(target), entry.term, entry.sinceChapter);
  }).filter(Boolean);
  if (address.length) lines.push(t.addressHeading, ...address);

  if (mode !== 'check') {
    const { shown: hooks, omitted: hooksOmitted, capped: hooksCapped } = selectHooks(asArray(state.hooks).filter(isHookActive), focus, kit.language, now, new Set(asArray(hookIds)), oldestHooks);
    if (hooks.length) {
      lines.push(t.hooksHeading, ...hooks.map((hook) => (mode === 'extract'
        ? t.hookKeyed(hook.id, hook.status ?? hook.phase, hook.plantedAtChapter, hook.text ?? '')
        : t.hook(hook.text ?? hook.id, hook.status ?? hook.phase))));
    }
    if (hooksCapped > 0) lines.push(t.capped(hooksCapped));
    if (hooksOmitted > 0) lines.push(t.omitted(hooksOmitted));

    const relationIds = mode === 'extract' ? named : castIds;
    // Both ends in focus first, then one end; most recent first within each; shown oldest first.
    const relations = asArray(state.relationships).map(directed).filter(Boolean)
      .map((item, index) => ({ item, index, both: (relationIds.has(item.from) || named.has(item.from)) && (relationIds.has(item.to) || named.has(item.to)) }))
      .filter(({ item }) => relationIds.has(item.from) || relationIds.has(item.to))
      .sort((a, b) => Number(b.both) - Number(a.both) || b.index - a.index)
      .slice(0, mode === 'extract' ? EXTRACT_RELATION_LIMIT : WRITER_RELATION_LIMIT)
      .sort((a, b) => a.index - b.index)
      .map(({ item }) => item);
    if (relations.length) lines.push(t.relationsHeading, ...relations.map((item) => t.relation(name(item.from), name(item.to), item.kind, item.state)));

    const body = (data) => flatBody(data, (v) => String(name(v)));
    const tracked = asArray(state.trackedEntities);
    if (mode === 'extract') {
      const { shown, omitted, capped } = selectTracked(tracked, focus, named, EXTRACT_TRACKED_LIMIT);
      if (shown.length) lines.push(t.trackedHeadingKeyed, ...shown.map((record) => t.trackedKeyed(record.kind, trackedRecordKey(record.data) || '-', body(record.data).slice(0, 160))));
      if (capped > 0) lines.push(t.capped(capped));
      if (omitted - capped > 0) lines.push(t.omitted(omitted - capped));
    } else {
      const { shown } = selectTracked(tracked, focus, castIds, WRITER_TRACKED_LIMIT);
      if (shown.length) lines.push(t.trackedHeading, ...shown.map((record) => t.tracked(record.kind, body(record.data), record.updatedChapter)));
    }
  }
  if (mode === 'extract' && asArray(entities).length) {
    const relevant = asArray(entities).filter((e) => focus && [e.canonicalName, e.entityId].some((n) => typeof n === 'string' && n.length >= 2 && focus.includes(n)))
      .slice(0, ENTITY_LIMIT);
    if (relevant.length) lines.push(t.entitiesHeading, ...relevant.map((e) => t.entity(e.kind, e.canonicalName ?? e.entityId, e.entityId, e.status)));
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * Who a chapter plan may draw on: the core cast registered at the start,
 * characters the focus names and those registered in the last chapters.
 */
export function planningCast(foundation, { focusText = '', chapter = 0 } = {}) {
  const named = namedCharacters(foundation, focusText);
  return asArray(foundation?.characters).filter((c) => c.disabled !== true && (c.registeredAtChapter ?? 0) <= (chapter || Infinity))
    .filter((c) => (c.registeredAtChapter ?? 1) <= 1 || named.has(c.id) || (chapter && (c.registeredAtChapter ?? 0) >= chapter - 10))
    .map((c) => c.id);
}

const CAST_NAME_LIMIT = 30;

/**
 * The planning cast list: a line with role and contradiction for each
 * character `planningCast` selects, then the other registered characters by
 * name only, up to CAST_NAME_LIMIT, and a count of the rest.
 */
export function renderCastBrief(foundation, kit, { focusText = '', chapter = 0 } = {}) {
  const t = kit.phrases.sections;
  const all = asArray(foundation?.characters).filter((c) => c.disabled !== true && (!chapter || (c.registeredAtChapter ?? 0) <= chapter));
  const selected = new Set(planningCast(foundation, { focusText, chapter }));
  const others = all.filter((c) => !selected.has(c.id));
  const lines = all.filter((c) => selected.has(c.id)).map((c) => t.castBrief(c.canonicalName, c.id, c.intrinsic?.role, c.contradiction));
  if (others.length) {
    lines.push(t.castOthers(others.slice(-CAST_NAME_LIMIT).map((c) => `${c.canonicalName}(${c.id})`).join(', ')));
    if (others.length > CAST_NAME_LIMIT) lines.push(t.omitted(others.length - CAST_NAME_LIMIT));
  }
  return lines.join('\n');
}

/** Chapter summaries oldest first, each labelled with its chapter. */
export function renderSummaries(summaries, kit) {
  const t = kit.phrases.sections;
  return asArray(summaries)
    .map((item) => ({ chapter: Number(item.chapterNumber ?? item.chapter), text: clean(item.summary ?? item.text) }))
    .filter((item) => item.text)
    .sort((a, b) => a.chapter - b.chapter)
    .map((item) => t.summary(item.chapter, item.text)).join('\n');
}

export function renderCharacterArcBeats(beats, foundation, kit) {
  const t = kit.phrases.sections;
  const name = (id) => asArray(foundation?.characters).find((c) => c.id === id)?.canonicalName ?? id;
  return asArray(beats).map((beat) => t.arcCharacterBeat(`${name(beat.characterId)} (${beat.characterId})`, clean(beat.promise), clean(beat.beat), clean(beat.note))).join('\n');
}

/** The fixed arc beat, one labelled line per non-empty field; a field equal to one already shown is skipped. */
export function renderArcBeat(beat, kit) {
  const t = kit.phrases.sections;
  const seen = new Set();
  const lines = [];
  for (const [field, label] of Object.entries(t.arcBeatLabels)) {
    const raw = beat?.[field];
    const value = typeof raw === 'string' ? raw.trim()
      : raw && typeof raw === 'object' ? Object.values(raw).filter((v) => typeof v === 'string' && v.trim()).join(' / ') : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    lines.push(t.arcBeatField(label, value));
  }
  return lines.join('\n');
}

/**
 * Continuity-check sections. Each item carries the path the reviewer may cite as
 * evidence; quotes are checked against the original objects at that path.
 * Foundation `mutable` is left out: the current place and condition come from
 * the state section.
 */
export function renderCheckSections({ foundation, prevState, delta, povDesign = null, povCharacterId = null, kit, focusText = '' }) {
  const t = kit.phrases.sections;
  const labels = kit.phrases.context.intrinsicLabels;
  const name = (id) => asArray(foundation?.characters).find((c) => c.id === id)?.canonicalName ?? id;
  const intrinsicFields = (intrinsic = {}) => [
    ...Object.entries(labels).filter(([k]) => intrinsic[k] !== undefined && intrinsic[k] !== '').map(([k, label]) => `${label}=${intrinsic[k]}`),
    ...(intrinsic.coreAppearance?.length ? [kit.phrases.context.appearance(intrinsic.coreAppearance.join('·'))] : []),
  ].join(', ');
  const pov = [
    foundation?.povMode ? `povMode=${foundation.povMode}` : '',
    ...Object.entries(povDesign ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => `povDesign.${k}=${v}`),
    povCharacterId ? `povCharacterId=${povCharacterId} (${name(povCharacterId)})` : '',
  ].filter(Boolean);
  const onPage = namedCharacters(foundation, focusText, [
    ...asArray(delta?.appearedCharacterIds), ...(povCharacterId ? [povCharacterId] : []),
    ...asArray(delta?.mutableChanges).map((m) => m.characterId),
    ...asArray(delta?.newAddressEntries).flatMap((a) => [a.speakerId, a.targetId]),
  ].filter(Boolean));
  const foundationText = [
    t.checkPathNote,
    ...(pov.length ? [t.checkPov(pov.join(' · '))] : []),
    // Only characters this chapter shows; the path keeps the Foundation index for evidence.
    ...asArray(foundation?.characters).map((c, i) => (onPage.has(c.id)
      ? t.checkCharacter(`foundation.characters[${i}]`, c.canonicalName, c.id,
        [intrinsicFields(c.intrinsic), asArray(c.aliases).length ? c.aliases.join(', ') : ''].filter(Boolean).join(' · '))
      : '')).filter(Boolean),
    ...asArray(foundation?.intrinsicChanges).map((e, i) => t.checkWorldFact(`foundation.intrinsicChanges[${i}]`, `${name(e.characterId)} ${e.field}: ${e.from} → ${e.to} (${e.atChapter})`)),
    ...asArray(foundation?.worldFacts).map((f, i) => t.checkWorldFact(`foundation.worldFacts[${i}]`, f.statement)),
  ].join('\n');
  const appeared = asArray(delta?.appearedCharacterIds);
  const deltaText = [
    ...(appeared.length ? [t.deltaAppeared(appeared.map((id) => `${name(id)} (${id})`).join(', '))] : []),
    ...asArray(delta?.newAddressEntries).map((a, i) => t.deltaAddress(`delta.newAddressEntries[${i}]`, name(a.speakerId), name(a.targetId), a.term)),
    ...asArray(delta?.mutableChanges).map((m, i) => t.deltaMutable(`delta.mutableChanges[${i}]`, `${name(m.characterId)} (${m.characterId})`,
      [m.vitalStatus && t.vital[m.vitalStatus], m.location && t.location(m.location), m.status && t.status(m.status)].filter(Boolean).join(' · '))),
    // Genre invariants such as item ownership or power tiers are judged on these.
    ...asArray(delta?.trackedEntityOps).map((op, i) => t.deltaTracked(`delta.trackedEntityOps[${i}]`, op.kind, flatBody(op.data, name))),
  ];
  const invariants = asArray(foundation?.genreProfile?.invariants).map((inv) => t.invariant(inv.severity, `${inv.id}: ${inv.description}`));
  // Ownership and tier invariants compare a change with the value before it.
  const touchedKeys = new Set(asArray(delta?.trackedEntityOps).map((op) => `${op.kind}\u0000${trackedRecordKey(op.data)}`));
  const before = asArray(prevState?.trackedEntities).filter((record) => touchedKeys.has(`${record.kind}\u0000${trackedRecordKey(record.data)}`));
  const touchedTracked = before.length ? [t.trackedHeading, ...before.map((record) => t.tracked(record.kind, flatBody(record.data, name), record.updatedChapter))].join('\n') : '';
  return {
    prev: [renderCurrentState(prevState, foundation, { kit, mode: 'check', cast: [...onPage] }), touchedTracked].filter(Boolean).join('\n'),
    foundation: foundationText,
    delta: deltaText.length ? deltaText.join('\n') : t.deltaEmpty,
    invariants: invariants.length ? invariants.join('\n') : '-',
  };
}

/**
 * The reader-experience fields of an EpisodePlan that the shared plan render
 * (renderEpisodePlan) leaves out. Reviews that judge expectation, turn, payoff
 * and exit value append this after the shared render.
 */
export function renderPlanReviewExtras(plan, foundation, kit) {
  if (!plan) return '';
  const t = kit.phrases.sections;
  const name = (id) => asArray(foundation?.characters).find((c) => c.id === id)?.canonicalName ?? id;
  const lines = [];
  const expectation = plan.readerExpectation ?? {};
  if (clean(expectation.likelyOutcome)) lines.push(t.planExpectation(clean(expectation.likelyOutcome), asArray(expectation.evidenceOnPage).map(clean).filter(Boolean).join('; ')));
  const turn = plan.turn ?? {};
  if (clean(turn.brokenBelief) || clean(turn.causedByChoice) || clean(turn.priorClueReinterpreted)) lines.push(t.planTurn(clean(turn.brokenBelief), clean(turn.causedByChoice), clean(turn.priorClueReinterpreted)));
  const payoff = plan.payoff ?? {};
  if (clean(payoff.promisePaid) || clean(payoff.proofOnPage)) lines.push(t.planPayoff(clean(payoff.promisePaid), clean(payoff.proofOnPage)));
  const cost = plan.costCreatedByResolution ?? {};
  if (clean(cost.immediate) || clean(cost.deferred)) lines.push(t.planCost(clean(cost.immediate), clean(cost.deferred), clean(cost.payer)));
  const exit = plan.exitValue ?? {};
  if (clean(exit.closedQuestion) || clean(exit.nextQuestion) || clean(exit.specificFutureValue)) lines.push(t.planExit(clean(exit.closedQuestion), clean(exit.nextQuestion), clean(exit.specificFutureValue), clean(exit.hookType)));
  for (const agenda of asArray(plan.characterAgendas)) {
    if (clean(agenda?.goal)) lines.push(t.planAgenda(`${name(agenda.characterId)} (${agenda.characterId})`, clean(agenda.goal), clean(agenda.redLine), clean(agenda.fallback)));
  }
  return lines.length ? [t.planReviewHeading, ...lines].join('\n') : '';
}
