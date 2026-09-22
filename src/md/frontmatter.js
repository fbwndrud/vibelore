/**
 * A deliberately small YAML-subset for file frontmatter.
 *
 * Why not a YAML library: these files are written by the engine and edited by
 * hand by a novelist, so the format has to be one a human can fix without
 * knowing YAML's corner cases. Restricting to `key: scalar` and inline
 * `key: [a, b]` lists means there is no ambiguity to get wrong -- and it means
 * the plugin keeps its zero-dependency promise.
 *
 * Anything structural that does not fit lives in the `.vibelore/` sidecar
 * instead of being forced into frontmatter. See store/markdown-store.js.
 */

const FENCE = '---';

/** Values are strings unless they look unambiguously like a number or boolean. */
function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  // Quoted strings keep their contents verbatim, which is how a value that
  // happens to read like a number stays a string.
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
      (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    return s.slice(1, -1);
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((p) => parseScalar(p));
  }
  return s;
}

function formatScalar(v) {
  if (Array.isArray(v)) return `[${v.map((x) => formatScalar(x)).join(', ')}]`;
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  // Quote only when the raw form would parse back as something else.
  const wouldMisparse =
    s !== s.trim() ||
    s === 'true' || s === 'false' || s === 'null' || s === '~' ||
    /^-?\d*\.?\d+$/.test(s) ||
    s.startsWith('[') || s.startsWith('"') || s.startsWith("'") ||
    s.includes('\n');
  if (s.includes('\n')) {
    throw new Error('frontmatter: multi-line values belong in the body, not in frontmatter');
  }
  return wouldMisparse ? JSON.stringify(s) : s;
}

/**
 * Split a document into { data, body }. A file with no frontmatter fence is
 * treated as all body, which is what a writer gets if they start a chapter
 * from scratch in their editor.
 */
export function parseDocument(text) {
  const src = String(text ?? '');
  const normalized = src.startsWith('﻿') ? src.slice(1) : src;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) {
    return { data: {}, body: normalized.replace(/^\n+/, '') };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === FENCE) { end = i; break; }
  }
  if (end === -1) {
    // Unterminated fence -- treat the whole thing as body rather than throwing
    // away the writer's text.
    return { data: {}, body: normalized };
  }
  const data = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key === '') continue;
    data[key] = parseScalar(line.slice(idx + 1));
  }
  return { data, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
}

export function formatDocument(data, body) {
  const keys = Object.keys(data ?? {}).filter((k) => data[k] !== undefined);
  const head = keys.length === 0
    ? ''
    : `${FENCE}\n${keys.map((k) => `${k}: ${formatScalar(data[k])}`).join('\n')}\n${FENCE}\n\n`;
  const text = String(body ?? '').replace(/\s+$/, '');
  return `${head}${text}\n`;
}

/**
 * Read one `## Heading` section's body out of a markdown document.
 * Used for the parts of a record a writer edits as prose.
 */
export function readSection(body, heading) {
  const lines = String(body ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const stop = rest.findIndex((l) => /^##\s/.test(l.trim()));
  const section = stop === -1 ? rest : rest.slice(0, stop);
  return section.join('\n').trim();
}

/** Bullet lines (`- item`) of a section, with the marker stripped. */
export function readBullets(body, heading) {
  const section = readSection(body, heading);
  if (section === null) return [];
  return section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter((l) => l !== '');
}

export function section(heading, content) {
  const text = String(content ?? '').trim();
  return `## ${heading}\n${text === '' ? '' : `${text}\n`}`;
}

export function bulletSection(heading, items) {
  const list = (items ?? []).map((i) => `- ${String(i).replace(/\n/g, ' ')}`).join('\n');
  return section(heading, list);
}
