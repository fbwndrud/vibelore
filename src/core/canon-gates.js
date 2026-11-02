// Canon time gates: parse "N화부터" markers and cut the foundation at a chapter horizon. Pure module, no imports.

export const GATE_SUMMARY_LIMIT = 30;

const KO_MARKER = /^(.*?)\s*화부터$/;
const EN_MARKER = /^from\s+chapter\s*(.*)$/i;
const GATE_HEADING = /^###(?!#)\s*(.*)$/;
const SECTION_HEADING = /^##(?!#)\s*(.*)$/;

const gateError = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });

/** Returns { fromChapter } for a marker, null for non-marker text, throws CANON_GATE_INVALID for a marker-shaped near-miss. */
export function parseGateMarker(text) {
  const trimmed = String(text ?? '').trim();
  const match = EN_MARKER.exec(trimmed) ?? KO_MARKER.exec(trimmed);
  if (!match) return null;
  const digits = match[1].trim();
  const fromChapter = /^\d+$/.test(digits) ? Number(digits) : NaN;
  if (!Number.isSafeInteger(fromChapter) || fromChapter < 1) {
    throw gateError('CANON_GATE_INVALID', trimmed, { lineText: trimmed });
  }
  return { fromChapter };
}

/** Non-throwing check: true when the text is marker-shaped, even if its value is invalid. */
export function looksLikeGateMarker(text) {
  try {
    return parseGateMarker(text) !== null;
  } catch (error) {
    if (error.code === 'CANON_GATE_INVALID') return true;
    throw error;
  }
}

/** Builds marker text; style is 'ko' (12화부터) or 'en' (from chapter 12). */
export function formatGateMarker(fromChapter, style = 'ko') {
  return style === 'en' ? `from chapter ${fromChapter}` : `${fromChapter}화부터`;
}

/** Splits a leading "[marker] statement" off a fact; a bracket that is not marker-shaped gives null. */
export function parseFactTag(statement) {
  const match = /^\s*\[([^\]]*)\]([\s\S]*)$/.exec(String(statement ?? ''));
  if (!match || !looksLikeGateMarker(match[1])) return null;
  const { fromChapter } = parseGateMarker(match[1]);
  const rest = match[2].trim();
  if (!rest) throw gateError('CANON_GATE_INVALID', String(statement).trim(), { lineText: String(statement).trim() });
  return { fromChapter, statement: rest };
}

const trimBlankEdges = (lines) => lines.join('\n').replace(/^(?:[ \t\r]*\n)+/, '').trimEnd();

/** Splits description text into base and "### N화부터" blocks; with no gate heading the input is returned unchanged as base. */
export function splitGatedSection(text) {
  const source = String(text ?? '');
  const lines = source.split('\n');
  const headings = lines.map((line) => {
    const match = GATE_HEADING.exec(line.trim());
    if (!match) return null;
    const marker = parseGateMarker(match[1]);
    return marker ? marker.fromChapter : false;
  });
  if (!headings.some((value) => value)) return { base: source, blocks: [] };

  const base = [];
  const blocks = [];
  let current = null;
  lines.forEach((line, index) => {
    if (headings[index]) {
      current = { fromChapter: headings[index], lines: [] };
      blocks.push(current);
    } else if (GATE_HEADING.test(line.trim())) {
      current = null;
      base.push(line);
    } else {
      (current ? current.lines : base).push(line);
    }
  });
  return {
    base: base.join('\n').trimEnd(),
    blocks: blocks.map((block) => ({ fromChapter: block.fromChapter, text: trimBlankEdges(block.lines) })).filter((block) => block.text)
  };
}

/** 1-based line numbers of marker-shaped "###" lines outside the Description section (markers that would be silently ignored). */
export function findIgnoredMarkers(fileText, descriptionHeadings) {
  const names = new Set((descriptionHeadings ?? []).map((name) => String(name).trim().toLowerCase()));
  const found = [];
  let inDescription = false;
  String(fileText ?? '').split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    const section = SECTION_HEADING.exec(trimmed);
    if (section) {
      inDescription = names.has(section[1].trim().toLowerCase());
      return;
    }
    const heading = GATE_HEADING.exec(trimmed);
    if (heading && !inDescription && looksLikeGateMarker(heading[1])) found.push(index + 1);
  });
  return found;
}

function assertHorizon(horizon) {
  if (typeof horizon === 'number' && (horizon === Infinity || (Number.isFinite(horizon) && horizon >= 1))) return;
  throw gateError('CANON_GATE_HORIZON', `horizon must be a number >= 1 or Infinity (got ${String(horizon)})`);
}

const factChapter = (fact) => fact?.registeredAtChapter ?? 1;

/** Copy of the foundation holding only what is open at the horizon chapter; the input is not mutated. */
export function gateFoundation(foundation, horizon) {
  assertHorizon(horizon);
  if (foundation == null) return foundation;
  const out = structuredClone(foundation);
  if (Array.isArray(out.worldFacts)) out.worldFacts = out.worldFacts.filter((fact) => factChapter(fact) <= horizon);
  for (const character of Array.isArray(out.characters) ? out.characters : []) {
    if (!character || typeof character !== 'object') continue;
    const { base, blocks } = typeof character.description === 'string' ? splitGatedSection(character.description) : { base: '', blocks: [] };
    // Already-projected progressions are re-filtered too, so a lower horizon never leaks.
    const progressions = blocks.length ? blocks : character.progressions;
    if (blocks.length) {
      if (base) character.description = base;
      else delete character.description;
    }
    if (!Array.isArray(progressions)) continue;
    const open = progressions.filter((block) => block.fromChapter <= horizon);
    if (open.length) character.progressions = open;
    else delete character.progressions;
  }
  return out;
}

/** References of entries hidden at the horizon (no text); null when the foundation has no gates. */
export function gateSummary(foundation, horizon) {
  assertHorizon(horizon);
  if (foundation == null) return null;
  const hidden = [];
  let gated = 0;
  for (const fact of foundation.worldFacts ?? []) {
    const fromChapter = factChapter(fact);
    if (fromChapter > 1) gated += 1;
    if (fromChapter > horizon) hidden.push({ ref: `fact:${fact.id}`, kind: 'world-fact', fromChapter, reason: 'canon_gate' });
  }
  for (const character of foundation.characters ?? []) {
    if (typeof character?.description !== 'string') continue;
    for (const block of splitGatedSection(character.description).blocks) {
      gated += 1;
      if (block.fromChapter > horizon) hidden.push({ ref: `character:${character.id}`, kind: 'progression', fromChapter: block.fromChapter, reason: 'canon_gate' });
    }
  }
  if (!gated) return null;
  return { hidden: hidden.slice(0, GATE_SUMMARY_LIMIT), total: hidden.length };
}
