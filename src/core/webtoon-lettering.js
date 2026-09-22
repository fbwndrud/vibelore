import { digest } from './webtoon-contract.js';
import { letteringAppearance } from './webtoon-presentation.js';
import { LETTERING_FONT, measureLetters, wrapLetters } from './webtoon-font.js';
import { imageText } from './webtoon-text.js';

export const LAYOUT_VERSION = 2;
// Opt-in per sound: ambient effects keep the existing quieter treatment.
export const SFX_STYLES = Object.freeze({
  plain: Object.freeze({ fontSize: 58, inkStroke: 0, outlineStroke: 7 }),
  impact: Object.freeze({ fontSize: 76, inkStroke: 4, outlineStroke: 10 }),
});
const finite = Number.isFinite;
const point = (p, gutter = false) => Array.isArray(p) && p.length === 2 && p.every(finite) && p[0] >= 0 && p[0] <= 1 && p[1] >= (gutter ? -0.5 : 0) && p[1] <= 1;
const rect = (r) => Array.isArray(r) && r.length === 4 && r.every(finite) && r[0] >= 0 && r[1] >= 0 && r[2] > 0 && r[3] > 0 && r[0] + r[2] <= 1.001 && r[1] + r[3] <= 1.001;
const overlaps = (a, b, pad = 0) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
const inside = (p, r, pad = 0) => p[0] >= r.x - pad && p[0] <= r.x + r.w + pad && p[1] >= r.y - pad && p[1] <= r.y + r.h + pad;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segmentHits(a, b, r) {
  // Slab intersection, including short/thin obstacles; sampling would miss those.
  let lo = 0; let hi = 1;
  for (const [axis, min, max] of [[0, r.x, r.x + r.w], [1, r.y, r.y + r.h]]) {
    const d = b[axis] - a[axis];
    if (!d) { if (a[axis] < min || a[axis] > max) return false; }
    else { const t1 = (min - a[axis]) / d; const t2 = (max - a[axis]) / d; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2)); }
  }
  return lo <= hi;
}
function segmentsCross(a, b) {
  if (!a || !b) return false;
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return cross(a.start, a.end, b.start) * cross(a.start, a.end, b.end) < 0 && cross(b.start, b.end, a.start) * cross(b.start, b.end, a.end) < 0;
}
export const letteringBinding = (shot, image) => digest({ version: LAYOUT_VERSION, shotId: shot.id, texts: shot.texts, height: shot.height, imageHash: image.hash, font: LETTERING_FONT.hash,
  ...(shot.letteringStyle ? { letteringStyle: shot.letteringStyle } : {}) });
export function imageDimensions(image) {
  const b = Buffer.from(image.base64, 'base64');
  if (image.mime === 'image/png') return [b.readUInt32BE(16), b.readUInt32BE(20)];
  let p = 2;
  while (p + 4 < b.length) {
    if (b[p++] !== 255) throw new Error('INVALID_JPEG_DIMENSIONS');
    while (b[p] === 255) p++;
    const marker = b[p++];
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return [b.readUInt16BE(p + 5), b.readUInt16BE(p + 3)];
    if (marker === 0xda || marker === 0xd9) break;
    const length = b.readUInt16BE(p); if (length < 2) break; p += length;
  }
  throw new Error('INVALID_JPEG_DIMENSIONS');
}
export function validateVisualMap(shot, image, map) {
  const failures = [];
  if (!map || map.inputHash !== letteringBinding(shot, image)) return ['STALE_VISUAL_MAP'];
  if (map.inspectedImages !== true || typeof map.evidence !== 'string' || !map.evidence.trim()) failures.push('VISUAL_INSPECTION_REQUIRED');
  if (!Array.isArray(map.protected) || map.protected.length > 100 || !map.protected.every(r => rect(r))) failures.push('INVALID_PROTECTED_REGIONS');
  if (!Array.isArray(map.entries) || map.entries.length !== shot.texts.length) return [...failures, 'TEXT_COVERAGE_MISMATCH'];
  const seen = new Set();
  for (const entry of map.entries) {
    if (!entry || !Number.isInteger(entry.textIndex) || !shot.texts[entry.textIndex] || seen.has(entry.textIndex)) { failures.push('INVALID_TEXT_INDEX'); continue; }
    seen.add(entry.textIndex);
    if (!finite(entry.confidence) || entry.confidence < 0.7 || entry.confidence > 1) failures.push('UNRESOLVED_ANCHOR');
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) failures.push('ANCHOR_REASON_REQUIRED');
    const text = shot.texts[entry.textIndex];
    const kind = text.kind;
    if (imageText(text)) {
      if (entry.observedText !== text.text) failures.push('PHYSICAL_TEXT_MISMATCH');
      if (!rect(entry.surfaceBounds)) failures.push('PHYSICAL_TEXT_BOUNDS_REQUIRED');
      if (entry.anchor !== undefined || entry.candidates !== undefined || entry.rotation !== undefined || entry.sfxStyle !== undefined) failures.push('PHYSICAL_TEXT_IS_NOT_OVERLAY');
      continue;
    }
    if (entry.sfxStyle !== undefined && (kind !== 'sfx' || typeof entry.sfxStyle !== 'string' || !Object.hasOwn(SFX_STYLES, entry.sfxStyle))) failures.push('INVALID_SFX_STYLE');
    if (['dialogue', 'sfx'].includes(kind) && !point(entry.anchor)) failures.push('ANCHOR_REQUIRED');
    if (text.delivery === 'offscreen' && point(entry.anchor)
      && Math.min(entry.anchor[0], entry.anchor[1], 1 - entry.anchor[0], 1 - entry.anchor[1]) > 0.03) failures.push('OFFSCREEN_ANCHOR_MUST_BE_EDGE');
    if (!Array.isArray(entry.candidates) || !entry.candidates.length || entry.candidates.length > 8 || !entry.candidates.every(p => point(p, true))) failures.push('INVALID_PLACEMENT_CANDIDATES');
    if (entry.rotation !== undefined && (!finite(entry.rotation) || Math.abs(entry.rotation) > 40 || kind !== 'sfx')) failures.push('INVALID_ROTATION');
  }
  return [...new Set(failures)];
}
export function solveLettering(shot, image, map) {
  const inputHash = letteringBinding(shot, image);
  const blocked = issues => ({ version: 2, shotId: shot.id, inputHash, status: 'blocked', issues, candidates: [] });
  if (!shot.texts.length) return { version: 2, shotId: shot.id, inputHash, imageHash: image.hash, font: LETTERING_FONT, status: 'passed', issues: [], candidates: [{ id: inputHash, items: [], cost: 0, headerHeight: 0 }], selectedId: inputHash };
  const errors = validateVisualMap(shot, image, map); if (errors.length) return blocked(errors);
  const [iw, ih] = imageDimensions(image); const s = Math.min(760 / iw, shot.height / ih);
  const box = { x: 20 + (760 - iw * s) / 2, y: (shot.height - ih * s) / 2, w: iw * s, h: ih * s };
  const transform = p => [box.x + p[0] * box.w, box.y + p[1] * box.h];
  const protectedRects = [...map.protected, ...map.entries.filter(e => imageText(shot.texts[e.textIndex])).map(e => e.surfaceBounds)]
    .map(r => ({ x: box.x + r[0] * box.w, y: box.y + r[1] * box.h, w: r[2] * box.w, h: r[3] * box.h }));
  let beam = [{ items: [], cost: 0 }];
  try {
    for (let textIndex = 0; textIndex < shot.texts.length; textIndex++) {
      const text = shot.texts[textIndex]; const entry = map.entries.find(e => e.textIndex === textIndex);
      if (imageText(text)) continue;
      const sound = text.kind === 'sfx';
      const sfxStyle = sound ? (shot.letteringStyle?.sfx && shot.letteringStyle.sfx !== 'contextual' ? shot.letteringStyle.sfx : entry.sfxStyle ?? 'plain') : null;
      const size = sound ? SFX_STYLES[sfxStyle].fontSize : 30; const lineHeight = size * 1.35;
      const anchor = entry.anchor && transform(entry.anchor); const choices = [];
      for (const width of (sound ? [180, 260, 340] : [240, 300, 360])) {
        const rows = wrapLetters(text.text, width - 54, size);
        const metrics = rows.map(row => measureLetters(row, size));
        const w = Math.max(sound ? 0 : 100, ...metrics.map(m => m.right - m.left)) + (sound ? 16 : 40);
        const h = sound ? (rows.length - 1) * lineHeight + Math.max(...metrics.map(m => m.ascent + m.descent)) + 16 : rows.length * lineHeight + 38;
        const angle = (entry.rotation ?? 0) * Math.PI / 180;
        const rw = Math.abs(w * Math.cos(angle)) + Math.abs(h * Math.sin(angle));
        const rh = Math.abs(w * Math.sin(angle)) + Math.abs(h * Math.cos(angle));
        entry.candidates.forEach((p, index) => {
          const center = transform(p); const bounds = { x: center[0] - rw / 2 - 4, y: center[1] - rh / 2 - 4, w: rw + 8, h: rh + 8 };
          if (bounds.x < 20 || bounds.x + bounds.w > 780 || bounds.y < -400 || bounds.y + bounds.h > shot.height || protectedRects.some(r => overlaps(bounds, r, 5))) return;
          let tail = null;
          if (text.kind === 'dialogue') {
            const d = distance(center, anchor); if (d < Math.max(w, h) / 2) return;
            const dx = (anchor[0] - center[0]) / d; const dy = (anchor[1] - center[1]) / d;
            const edge = Math.min(Math.abs(dx) > 0.001 ? w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 0.001 ? h / 2 / Math.abs(dy) : Infinity);
            const start = [center[0] + dx * (edge - 8), center[1] + dy * (edge - 8)];
            // Stop at the speaker's protected face boundary, not through the face to its mouth.
            let end = [anchor[0] - dx * 18, anchor[1] - dy * 18];
            for (let t = 0; t < d - edge; t += 2) {
              const q = [start[0] + dx * t, start[1] + dy * t];
              if (protectedRects.some(r => inside(anchor, r) && inside(q, r, 4))) { end = [q[0] - dx * 3, q[1] - dy * 3]; break; }
            }
            // A tail hidden inside its own balloon is not a visible speaker cue.
            if (distance(center, end) < edge + 8 || distance(start, end) > 260 || protectedRects.some(r => segmentHits(start, end, r))) return;
            tail = { start, end, base: [[start[0] - dy * 9, start[1] + dx * 9], [start[0] + dy * 9, start[1] - dx * 9]] };
          }
          choices.push({ textIndex, utteranceId: `${shot.id}:text-${textIndex}`, kind: text.kind, speaker: text.speaker, text: text.text, rows,
            ...(text.delivery ? { delivery: text.delivery } : {}),
            ...(sound ? { sfxStyle, ...SFX_STYLES[sfxStyle] } : {}),
            ...(!sound && shot.letteringStyle ? { appearance: letteringAppearance(text.kind, shot.letteringStyle) } : {}),
            fontSize: size, lineHeight, center, w, h, bounds, tail, rotation: entry.rotation ?? 0,
            cost: index * 12 + h * 0.025 + (anchor ? distance(center, anchor) * (sound ? 0.12 : 0.025) : 0) + Math.max(0, -bounds.y) * 0.06 });
        });
      }
      const next = [];
      for (const prior of beam) for (const choice of choices) {
        // Diegetic labels belong to the observed sign/form, not the dialogue flow.
        const narrative = kind => ['dialogue', 'thought', 'caption'].includes(kind);
        const lastSpeech = prior.items.findLast(item => narrative(item.kind));
        if (narrative(choice.kind) && lastSpeech && choice.center[1] < lastSpeech.center[1] + 28) continue;
        if (prior.items.some(item => overlaps(choice.bounds, item.bounds, 12) || segmentsCross(choice.tail, item.tail)
          || (choice.tail && segmentHits(choice.tail.start, choice.tail.end, item.bounds)) || (item.tail && segmentHits(item.tail.start, item.tail.end, choice.bounds)))) continue;
        next.push({ items: [...prior.items, choice], cost: prior.cost + choice.cost });
      }
      beam = next.sort((a, b) => a.cost - b.cost).slice(0, 24);
      if (!beam.length) return blocked([`NO_FEASIBLE_LAYOUT:text-${textIndex}`]);
    }
  } catch (error) { return blocked([error.message]); }
  const unique = new Map();
  for (const candidate of beam) {
    const key = digest(candidate.items.map(({ center, w, h, sfxStyle, rotation, fontSize }) => ({ center, w, h, sfxStyle, rotation, fontSize })));
    if (!unique.has(key)) unique.set(key, { ...candidate, id: key, headerHeight: Math.ceil(Math.max(0, ...candidate.items.map(i => -i.bounds.y + 14))) });
  }
  const candidates = [...unique.values()].slice(0, 3);
  return { version: 2, shotId: shot.id, inputHash, imageHash: image.hash, mapHash: digest(map), font: LETTERING_FONT, status: 'passed',
    issues: [], candidates, selectedId: candidates[0].id, imageBox: box,
    limitations: ['Geometry checked against host-reported regions, not independent semantic truth.', 'Bounded candidate search; no feasible result is not proof of global impossibility.', 'Straight tails and rectangular protected regions; arbitrary masks and complex-script shaping are not implemented.'] };
}
