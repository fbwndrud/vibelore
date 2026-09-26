import { effectiveIntrinsic } from '../../engine/src/continuity/character.js';
import { isHookActive, trackedRecordKey } from '../../engine/src/continuity/story-state.js';

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

export function renderCharacter(foundation, character, chapter, kit, { appearance = true, initialPlacement = false } = {}) {
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

/**
 * The carried StoryState as text.
 * - `writer`: what bears on this chapter — cast states (and every dead or missing
 *   character), address terms within the cast, active threads, directed
 *   relationships touching the cast, tracked items the cast holds or the plan
 *   names, most recent first.
 * - `extract`: the whole index with exact keys and hook ids, so the extractor
 *   updates existing records instead of inventing new ones.
 * - `check`: current states and the whole address map.
 */
export function renderCurrentState(state, foundation, { cast = [], kit, mode = 'writer', focusText = '', entities = [] } = {}) {
  if (!MODES.has(mode)) throw new Error(`UNKNOWN_STATE_RENDER_MODE: ${mode}`);
  if (!state) return '';
  const t = kit.phrases.sections;
  const castIds = new Set(asArray(cast));
  const name = (id) => asArray(foundation?.characters).find((c) => c.id === id)?.canonicalName ?? id;
  const lines = [t.currentStateHeading];

  const states = state.characterStates ?? {};
  const people = Object.entries(states)
    .filter(([id, value]) => mode !== 'writer' || castIds.has(id) || value?.vitalStatus === 'dead' || value?.vitalStatus === 'missing')
    .map(([id, value]) => {
      const parts = [];
      if (value?.vitalStatus && t.vital[value.vitalStatus]) parts.push(t.vital[value.vitalStatus]);
      if (clean(value?.location)) parts.push(t.location(clean(value.location)));
      if (clean(value?.status)) parts.push(t.status(clean(value.status)));
      const facts = asArray(value?.knownFacts).slice(-WRITER_KNOWN_FACTS);
      if (mode === 'writer' && facts.length) parts.push(t.knownFacts(facts.join('; ')));
      return parts.length ? t.person(name(id), id, parts.join(' · ')) : '';
    }).filter(Boolean);
  if (people.length) lines.push(t.peopleHeading, ...people);

  const address = Object.entries(state.addressMap?.entries ?? {}).map(([key, entry]) => {
    const [speaker, target] = key.split('->');
    if (mode === 'writer' && !(castIds.has(speaker) && castIds.has(target))) return '';
    return mode === 'extract'
      ? t.addressKeyed(key, name(speaker), name(target), entry.term, entry.sinceChapter)
      : t.address(name(speaker), name(target), entry.term, entry.sinceChapter);
  }).filter(Boolean);
  if (address.length) lines.push(t.addressHeading, ...address);

  if (mode !== 'check') {
    const hooks = asArray(state.hooks).filter(isHookActive).map((hook) => (mode === 'extract'
      ? t.hookKeyed(hook.id, hook.phase, hook.plantedAtChapter, hook.text ?? '')
      : t.hook(hook.text ?? hook.id, hook.phase)));
    if (hooks.length) lines.push(t.hooksHeading, ...hooks);

    const relations = asArray(state.relationships).map(directed).filter(Boolean)
      .filter((item) => mode === 'extract' || castIds.has(item.from) || castIds.has(item.to));
    const shownRelations = mode === 'extract' ? relations : relations.slice(-WRITER_RELATION_LIMIT);
    if (shownRelations.length) lines.push(t.relationsHeading, ...shownRelations.map((item) => t.relation(name(item.from), name(item.to), item.kind, item.state)));

    const body = (data) => flatBody(data, (v) => String(name(v)));
    const tracked = asArray(state.trackedEntities);
    if (mode === 'extract') {
      if (tracked.length) lines.push(t.trackedHeadingKeyed, ...tracked.map((record) => t.trackedKeyed(record.kind, trackedRecordKey(record.data) || '-', body(record.data).slice(0, 160))));
    } else {
      const focus = clean(focusText);
      const relevant = tracked.filter((record) => mentions(record, castIds)
        || (focus && Object.values(record.data ?? {}).some((value) => typeof value === 'string' && value.length >= 2 && value.length <= 40 && focus.includes(value))))
        .map((record, index) => ({ record, index }))
        .sort((a, b) => (b.record.updatedChapter ?? 0) - (a.record.updatedChapter ?? 0) || b.index - a.index)
        .slice(0, WRITER_TRACKED_LIMIT);
      if (relevant.length) lines.push(t.trackedHeading, ...relevant.map(({ record }) => t.tracked(record.kind, body(record.data), record.updatedChapter)));
    }
  }
  if (mode === 'extract' && asArray(entities).length) {
    lines.push(t.entitiesHeading, ...asArray(entities).map((e) => t.entity(e.kind, e.canonicalName ?? e.entityId, e.entityId, e.status)));
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/** One line per character: id, role and contradiction — the planning cast list. */
export function renderCastBrief(foundation, kit) {
  const t = kit.phrases.sections;
  return asArray(foundation?.characters).filter((c) => c.disabled !== true)
    .map((c) => t.castBrief(c.canonicalName, c.id, c.intrinsic?.role, c.contradiction)).join('\n');
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
export function renderCheckSections({ foundation, prevState, delta, povDesign = null, povCharacterId = null, kit }) {
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
  const foundationText = [
    t.checkPathNote,
    ...(pov.length ? [t.checkPov(pov.join(' · '))] : []),
    ...asArray(foundation?.characters).map((c, i) => t.checkCharacter(`foundation.characters[${i}]`, c.canonicalName, c.id,
      [intrinsicFields(c.intrinsic), asArray(c.aliases).length ? c.aliases.join(', ') : ''].filter(Boolean).join(' · '))),
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
  return {
    prev: renderCurrentState(prevState, foundation, { kit, mode: 'check' }),
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
