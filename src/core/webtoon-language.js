// The novel's language resolver owns language selection. This adapter does not
// turn a webtoon preference or the host conversation into a translation request.
export function languageTag(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('INVALID_WEBTOON_LANGUAGE');
  try { return Intl.getCanonicalLocales(value)[0]; }
  catch { throw new Error('INVALID_WEBTOON_LANGUAGE'); }
}

export function webtoonLanguage(source) {
  return languageTag(source?.languageContract?.language ?? 'ko');
}

export const koreanWebtoon = source => new Intl.Locale(webtoonLanguage(source)).language === 'ko';
export const webtoonMessage = (source, ko, en) => koreanWebtoon(source) ? ko : en;

async function sharedLanguageResolver() {
  const resolverUrl = new URL('./work-language.js', import.meta.url);
  try { return (await import(resolverUrl.href)).resolveWorkLanguage; }
  catch (error) {
    // Only the old checkout's absent adapter is optional, never its dependencies
    // or a language-contract error returned by a multilingual installation.
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== resolverUrl.href) throw error;
    return null;
  }
}

export async function resolveWebtoonLanguage({ store, workId, foundation, storyProfile }, resolveLanguage) {
  const resolver = resolveLanguage === undefined ? await sharedLanguageResolver() : resolveLanguage;
  if (resolver) {
    const resolved = await resolver({ store, workId, foundation, profile: storyProfile });
    return { version: 1, language: languageTag(resolved.language), promptFamily: resolved.promptFamily,
      workContractHash: resolved.contractHash, allowedLanguageExceptions: resolved.contract.allowedLanguageExceptions ?? [],
      resolver: 'work-language' };
  }
  // This pre-multilingual checkout cannot validate accepted-creation or published
  // language contracts. Do not pretend a non-Korean work is validated here.
  if ([foundation, storyProfile].some(value => value && Object.hasOwn(value, 'language'))) {
    throw new Error('WEBTOON_LANGUAGE_CONTRACT_UNAVAILABLE: Integrate the shared work-language resolver before adapting language-tagged novels.');
  }
  return { version: 1, language: 'ko', promptFamily: 'ko', resolver: 'implicit-legacy-ko', allowedLanguageExceptions: [] };
}

export function webtoonLanguageDirective(source) {
  if (!source?.languageContract) return '';
  const language = webtoonLanguage(source);
  return `Target work language (BCP 47): ${language}. Write generated titles, dialogue, thoughts, captions, sound effects, physical writing, plans and review explanations in this language. Preserve JSON keys, IDs, enum values and user/source quotations. Approved scoped exceptions are supplied in languageContract.allowedLanguageExceptions; do not invent exceptions or translate the novel because the conversation language differs. Schema examples are not output text. Return only JSON.`;
}

const RTL_SCRIPTS = new Set(['Arab', 'Hebr', 'Thaa', 'Syrc', 'Nkoo', 'Adlm', 'Rohg']);
/** Image models default to a left-to-right page even when the balloons read right to left, so an RTL reader meets a reply before the line it answers. */
const RTL_PAGE_ORDER = ' The whole page reads right to left: rows of panels run top to bottom, and panels within a row run right to left. Inside a panel, the first line spoken sits at the right or top, and each later line sits to its left or below.';

/** Image models draw the lettering themselves; name the exact language, script and direction instead of hoping they infer it. */
export function sceneLetteringLine(source) {
  const tag = webtoonLanguage(source);
  const script = new Intl.Locale(tag).maximize().script;
  const language = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
  const scriptName = new Intl.DisplayNames(['en'], { type: 'script' }).of(script);
  const rtl = RTL_SCRIPTS.has(script);
  return `All quoted text is in ${language} (${tag}), written in ${scriptName} script (ISO 15924 ${script}). Letter it in that script exactly as quoted, reading ${rtl ? 'right-to-left' : 'left-to-right'} inside each balloon.${rtl ? RTL_PAGE_ORDER : ''}`;
}

const questions = {
  W01: ['Purpose and audience', 'Who is this comic for, and is the goal a sample, pitch or serial episode?'],
  W02: ['Adaptation scope', 'Which events, relationships and lines must remain? What may be compressed, omitted or reordered?'],
  W03: ['Episode focus', 'What should readers remember most? What supports that experience, and what may be left out?'],
  W04: ['Art direction', 'What linework, color, proportions and background detail do you want or want to avoid?'],
  W05: ['Characters and acting', 'Keep established identities. How may unspecified clothing, expressions and stylization be interpreted?'],
  W06: ['Visual world', 'How should unspecified architecture, clothing, technology and recurring spaces be designed?'],
  W07: ['Dialogue and interior voice', 'Which thoughts must remain as text, and which explanations should become actions or expressions?'],
  W08: ['Pacing and reveals', 'Where should readers pause, and when should information be revealed?'],
  W09: ['Intensity', 'What violence, horror, intimacy or exaggeration should be reduced or emphasized?'],
  W10: ['Screen and language', 'What reading devices, accessibility or translated editions are needed? Translation is a separate scope, not a language override.'],
  W11: ['Budget and time', 'What are the budget and time limits, and the priorities for quality, speed and revision?'],
  W12: ['Participation and approval', 'Which choices may be delegated? Rough-storyboard approval remains mandatory before final art.'],
  W13: ['Acceptance criteria', 'Which failures in identity, emotion, readability or action matter most?'],
  W14: ['Continuity and changes', 'What must remain fixed across episodes, and how should later source or preference changes apply?'],
  W15: ['Lettering design', 'How should dialogue, thoughts, narration and sound effects differ? Choose a preset or describe supported changes.'],
  W16: ['Reading format', 'Which reading format do you want? Choose independently from art direction.'],
  E01: ['Body and time changes', 'Which identity anchors survive a transformation, and when is it revealed?'],
  E02: ['Interfaces and documents', 'Which exact interface text or numbers must be readable, and when?'],
  E03: ['Action and contact', 'How should clarity, speed, injury and damage be balanced?'],
  E04: ['Relationships', 'How should gaze, distance, silence and private thoughts convey relationships?'],
  E05: ['Horror and mystery', 'What stays unseen, and which clues may readers know first?'],
  E06: ['Comedy and distortion', 'How much facial or body exaggeration is allowed in comic and serious scenes?'],
  E07: ['Specialist and period detail', 'Which tools and spaces require accuracy or explanatory graphics?'],
  E08: ['Translation and multiple layouts', 'May layout change for translated text or print? These outputs require separate implementation and approval.'],
};

const recommendations = {
  W01: 'Review one understandable episode storyboard for readers unfamiliar with the novel.',
  W02: 'Preserve source facts and motives; record expression changes in the adaptation map.',
  W03: 'Choose the primary experience and supporting beats before deriving the panel count.',
  W04: 'Compare a visual sample of the same scene before fixing the art direction.',
  W05: 'Preserve canonical appearance and review performance variations in visual samples.',
  W06: 'Preserve established world rules and define recurring spaces first.',
  W07: 'Preserve essential interior voice and reserve lettering space in rough storyboards.',
  W08: 'Vary pacing by scene purpose while preserving the intended order of revelations.',
  W09: 'Start from the novel tone and confirm the intensity of its visual expression.',
  W10: 'Keep the approved novel language; review editable lettering for mobile scrolling first. Translation is a separate scope.',
  W11: 'Review the script before paid generation and confirm paid limits separately.',
  W12: 'Review direction, script, rough storyboards, visual standards and final output; delegate routine details.',
  W13: 'Prioritize readability and character identification, with work-specific priorities.',
  W14: 'Pin the source revision and revisit only decisions affected by an approved change.',
};

export function localizeWebtoonArea(area, source) {
  if (koreanWebtoon(source)) return area;
  const [title, question] = questions[area.id];
  const row = { ...area, title, question,
    recommendation: ['W15', 'W16'].includes(area.id) ? area.recommendation
      : recommendations[area.id] ?? 'Decide using the source intent and the production constraints of this scene.',
    ...(area.custom ? { custom: 'Describe your preference; unsupported rendering features require confirmation, not a promise of support.' } : {}) };
  if (area.id === 'W04' && area.options) row.options = [
    { value: 'Clear color, distinct lines and natural proportions', label: 'Clear-color illustration' },
    { value: 'Bold ink, strong shadows and dimensional anatomy', label: 'American-comics influence' },
    { value: 'Fine lines, expressive faces and monochrome tones', label: 'Japanese-manga influence' },
  ];
  if (area.id === 'W15') {
    row.options = [
      { value: 'standard', label: 'High contrast', description: 'Round dialogue balloons, dark thought boxes, boxed narration and contextual sound effects.' },
      { value: 'soft', label: 'Light boxes', description: 'Round dialogue balloons, light thought boxes, boxed narration and contextual sound effects.' },
      { value: 'minimal', label: 'Minimal boxes', description: 'Dialogue balloons; outlined thoughts and narration without boxes.' },
    ];
    row.custom = 'Supported JSON fields: dialogue=round|square, thought=dark|light|plain, caption=box|plain, sfx=contextual|plain|impact. Specify all four. Arbitrary fonts and curved tails are not supported.';
  }
  if (area.id === 'W16') {
    row.options = [{ value: 'scroll', label: 'Vertical scroll', supported: true },
      { value: 'page-ltr', label: 'Pages: left to right', supported: false }, { value: 'page-rtl', label: 'Pages: right to left', supported: false }];
    row.notice = 'Page-based production is not implemented. Your choice is retained and production pauses; it never silently switches to scrolling. Art style does not imply reading direction.';
  }
  return row;
}
