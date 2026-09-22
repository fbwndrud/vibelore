import { readFileSync } from 'node:fs';
import { digest } from './webtoon-contract.js';

// Only our bundled, unmodified font is parsed. This is not an arbitrary-font loader.
const bytes = readFileSync(new URL('../assets/fonts/GowunDodum-Regular.ttf', import.meta.url));
const tables = {};
for (let i = 0; i < bytes.readUInt16BE(4); i++) {
  const p = 12 + i * 16;
  tables[bytes.toString('ascii', p, p + 4)] = bytes.readUInt32BE(p + 8);
}
const units = bytes.readUInt16BE(tables.head + 18);
const count = bytes.readUInt16BE(tables.hhea + 34);
let cmap;
for (let i = 0; i < bytes.readUInt16BE(tables.cmap + 2); i++) {
  const p = tables.cmap + 4 + i * 8;
  const offset = tables.cmap + bytes.readUInt32BE(p + 4);
  if (bytes.readUInt16BE(offset) === 12) cmap = offset;
}
if (!cmap) throw new Error('BUNDLED_FONT_CMAP_MISSING');
function glyph(cp) {
  let lo = 0; let hi = bytes.readUInt32BE(cmap + 12) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1; const p = cmap + 16 + mid * 12;
    if (cp < bytes.readUInt32BE(p)) hi = mid - 1;
    else if (cp > bytes.readUInt32BE(p + 4)) lo = mid + 1;
    else return bytes.readUInt32BE(p + 8) + cp - bytes.readUInt32BE(p);
  }
  return 0;
}
export const LETTERING_FONT = { family: 'VibeloreGowun', hash: digest(bytes), metricsVersion: 1,
  license: 'SIL OFL 1.1', shaping: 'precomposed Korean, Latin and CJK; kerning/ligatures disabled' };
export const fontStyle = () => '<style>.lettering-v2{fill:#202020}</style>';
const outlineCache = new Map();
function contours(id, depth = 0) {
  if (depth > 12) throw new Error('FONT_COMPOSITE_DEPTH');
  if (outlineCache.has(id)) return outlineCache.get(id);
  const long = bytes.readInt16BE(tables.head + 50) === 1;
  const offset = i => long ? bytes.readUInt32BE(tables.loca + i * 4) : bytes.readUInt16BE(tables.loca + i * 2) * 2;
  if (offset(id) === offset(id + 1)) return [];
  const base = tables.glyf + offset(id); const n = bytes.readInt16BE(base); let p = base + 10; const result = [];
  if (n >= 0) {
    const ends = [];
    for (let i = 0; i < n; i++, p += 2) ends.push(bytes.readUInt16BE(p));
    const instructions = bytes.readUInt16BE(p); p += 2 + instructions;
    const total = (ends.at(-1) ?? -1) + 1; const flags = [];
    while (flags.length < total) { const flag = bytes[p++]; flags.push(flag); if (flag & 8) { const repeat = bytes[p++]; for (let i = 0; i < repeat; i++) flags.push(flag); } }
    const xs = []; const ys = [];
    for (const [values, shortBit, sameBit] of [[xs, 2, 16], [ys, 4, 32]]) {
      let value = 0;
      for (const flag of flags) {
        if (flag & shortBit) value += bytes[p++] * (flag & sameBit ? 1 : -1);
        else if (!(flag & sameBit)) { value += bytes.readInt16BE(p); p += 2; }
        values.push(value);
      }
    }
    let start = 0;
    for (const end of ends) { result.push(xs.slice(start, end + 1).map((x, i) => ({ x, y: ys[start + i], on: !!(flags[start + i] & 1) }))); start = end + 1; }
  } else {
    let flags;
    do {
      flags = bytes.readUInt16BE(p); const child = bytes.readUInt16BE(p + 2); p += 4;
      if (!(flags & 2)) throw new Error('UNSUPPORTED_POINT_ATTACHED_GLYPH');
      let dx; let dy;
      if (flags & 1) { dx = bytes.readInt16BE(p); dy = bytes.readInt16BE(p + 2); p += 4; }
      else { dx = bytes.readInt8(p++); dy = bytes.readInt8(p++); }
      let a = 1; let b = 0; let c = 0; let d = 1;
      const f = () => { const value = bytes.readInt16BE(p) / 16384; p += 2; return value; };
      if (flags & 8) a = d = f();
      else if (flags & 64) { a = f(); d = f(); }
      else if (flags & 128) { a = f(); b = f(); c = f(); d = f(); }
      if (flags & 2048) { const x = a * dx + c * dy; dy = b * dx + d * dy; dx = x; }
      for (const contour of contours(child, depth + 1)) result.push(contour.map(q => ({ x: a * q.x + c * q.y + dx, y: b * q.x + d * q.y + dy, on: q.on })));
    } while (flags & 32);
  }
  outlineCache.set(id, result); return result;
}
// Portable glyph outlines avoid browser fallback and repeated multi-megabyte font embedding.
// Editable strings remain in lettering.json and the SVG group's data-text attribute.
export function letteringPath(text, size, x, baseline) {
  measureLetters(text, size);
  const scale = size / units; const paths = []; let advance = 0;
  const xy = p => `${+(x + (p.x + advance) * scale).toFixed(3)} ${+(baseline - p.y * scale).toFixed(3)}`;
  for (const char of text) {
    const id = glyph(char.codePointAt(0));
    for (const contour of contours(id)) {
      const expanded = [];
      contour.forEach((q, i) => { expanded.push(q); const next = contour[(i + 1) % contour.length]; if (!q.on && !next.on) expanded.push({ x: (q.x + next.x) / 2, y: (q.y + next.y) / 2, on: true }); });
      const start = expanded.findIndex(q => q.on); if (start < 0) continue;
      const points = [...expanded.slice(start), ...expanded.slice(0, start)]; points.push(points[0]);
      let path = `M${xy(points[0])}`;
      for (let i = 1; i < points.length; i++) {
        if (points[i].on) path += `L${xy(points[i])}`;
        else { path += `Q${xy(points[i])} ${xy(points[++i])}`; }
      }
      paths.push(`${path}Z`);
    }
    advance += bytes.readUInt16BE(tables.hmtx + Math.min(id, count - 1) * 4);
  }
  return paths.join('');
}

export function measureLetters(text, size) {
  if (typeof text !== 'string' || text.length > 5000 || !Number.isFinite(size) || size <= 0) throw new Error('INVALID_TEXT_METRICS');
  // Fail closed for scripts requiring shaping that this deliberately small reader does not implement.
  if (/[\p{Mark}\u1100-\u11ff\u200c\u200d\u0590-\u08ff]/u.test(text)) throw new Error('UNSUPPORTED_TEXT_SHAPING');
  let advance = 0; let left = 0; let right = 0; let top = 0; let bottom = 0;
  for (const char of text) {
    const id = glyph(char.codePointAt(0));
    if (!id) throw new Error(`MISSING_GLYPH: U+${char.codePointAt(0).toString(16)}`);
    const long = bytes.readInt16BE(tables.head + 50) === 1;
    const offset = long ? bytes.readUInt32BE(tables.loca + id * 4) : bytes.readUInt16BE(tables.loca + id * 2) * 2;
    const end = long ? bytes.readUInt32BE(tables.loca + (id + 1) * 4) : bytes.readUInt16BE(tables.loca + (id + 1) * 2) * 2;
    if (end > offset) {
      const p = tables.glyf + offset;
      left = Math.min(left, advance + bytes.readInt16BE(p + 2));
      right = Math.max(right, advance + bytes.readInt16BE(p + 6));
      top = Math.max(top, bytes.readInt16BE(p + 8)); bottom = Math.min(bottom, bytes.readInt16BE(p + 4));
    }
    advance += bytes.readUInt16BE(tables.hmtx + Math.min(id, count - 1) * 4);
  }
  const scale = size / units;
  return { width: advance * scale, left: left * scale, right: Math.max(right, advance) * scale, ascent: top * scale, descent: -bottom * scale };
}

export function wrapLetters(text, width, size) {
  const rows = [];
  for (const paragraph of text.split('\n')) {
    let rest = [...paragraph];
    if (!rest.length) { rows.push(''); continue; }
    while (rest.length) {
      let take = 0;
      while (take < rest.length && measureLetters(rest.slice(0, take + 1).join(''), size).width <= width) take++;
      if (!take) throw new Error('TEXT_TOO_WIDE');
      if (take < rest.length) {
        const space = rest.slice(0, take + 1).lastIndexOf(' ');
        if (space > take / 2) take = space;
        while (take > 0 && (/^[、。，．！？!?.,:;\)\]」』】]/u.test(rest[take] ?? '') || /[\(\[「『【]$/u.test(rest[take - 1]))) take--;
        if (!take) throw new Error('LINE_BREAK_PROHIBITED');
      }
      rows.push(rest.splice(0, take).join('').trimEnd());
      while (rest[0] === ' ') rest.shift();
    }
  }
  return rows;
}
