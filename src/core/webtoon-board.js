import { languageTag, webtoonMessage } from './webtoon-language.js';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { digest, planShots } from './webtoon-contract.js';
import { fontStyle, measureLetters, letteringPath } from './webtoon-font.js';
import { imageText } from './webtoon-text.js';

const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

function verifyImageContainer(bytes, mime) {
  if (mime === 'image/jpeg') {
    if (bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error('TRUNCATED_JPEG');
    return;
  }
  let offset = 8; let header = false; let data = false; let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length) throw new Error('TRUNCATED_PNG');
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (!header) {
      if (kind !== 'IHDR' || length !== 13) throw new Error('INVALID_PNG_HEADER');
      const width = bytes.readUInt32BE(offset + 8); const height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width > 16384 || height > 16384 || width * height > 64000000) throw new Error('IMAGE_DIMENSIONS_EXCEEDED');
      header = true;
    }
    if (kind === 'IDAT') data = true;
    offset += length + 12;
    if (kind === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
  }
  if (!header || !data || !ended) throw new Error('INVALID_PNG_CONTAINER');
}
const lines = (value, width) => {
  const result = [];
  for (const line of String(value).split('\n')) {
    const chars = [...line];
    if (!chars.length) result.push('');
    for (let i = 0; i < chars.length; i += width) result.push(chars.slice(i, i + width).join(''));
  }
  return result;
};

/** Portable, editable lettering and scroll board; no raster-model dependency. */
export function composeWebtoonBoard(plan, images = {}, solvedLayouts = {}) {
  if (plan.presentation?.format && plan.presentation.format !== 'scroll') throw new Error('UNSUPPORTED_COMIC_FORMAT: 페이지 판면은 세로 스크롤 출력기로 대체할 수 없습니다.');
  const shots = planShots(plan); let y = 160;
  const body = [`<text x="400" y="78" text-anchor="middle" font-size="34" font-weight="700">${escape(plan.title)}</text>`];
  const layout = [];
  for (const shot of shots) {
    const image = images[shot.id];
    const reference = shot.id.startsWith('ref-');
    const solved = solvedLayouts[shot.id];
    if (image && solved) {
      if (solved.status !== 'passed') throw new Error('LETTERING_NOT_READY');
      const selected = solved.candidates.find(c => c.id === solved.selectedId);
      if (!selected) throw new Error('INVALID_LAYOUT_SELECTION');
      const header = selected.headerHeight;
      body.push(`<g id="${escape(shot.id)}" transform="translate(0 ${y})"><image x="20" y="${header}" width="760" height="${shot.height}" preserveAspectRatio="xMidYMid meet" href="data:${image.mime};base64,${image.base64}"/>`);
      body.push(`<g class="lettering-v2" data-layer="lettering" transform="translate(0 ${header})">`);
      for (const item of selected.items) {
        if (imageText(shot.texts[item.textIndex])) throw new Error('PHYSICAL_TEXT_DUPLICATE_OVERLAY');
        if (item.tail) {
          const { base, end } = item.tail;
          body.push(`<path data-kind="tail" d="M${base[0].join(' ')} L${end.join(' ')} L${base[1].join(' ')} Z" fill="white" stroke="#252525" stroke-width="2"/>`);
        }
        body.push(`<g data-kind="${escape(item.kind)}" data-utterance="${escape(item.utteranceId)}" transform="translate(${item.center.join(' ')}) rotate(${item.rotation})">`);
        if (item.kind !== 'sfx' && item.appearance?.box !== 'none') {
          const round = item.appearance ? item.appearance.box === 'round' : item.kind === 'dialogue';
          const shape = `x="${-item.w / 2}" y="${-item.h / 2}" width="${item.w}" height="${item.h}" rx="${round ? Math.min(52, item.h / 2) : 3}"`;
          if (item.tail) {
            // Mask only the body outline at the tail junction. The body fill covers
            // the inner tail strokes, giving one open join without moving the text.
            const local = p => `${p[0] - item.center[0]} ${p[1] - item.center[1]}`;
            const id = `tail-join-${shot.id}-${item.textIndex}`;
            const triangle = `M${local(item.tail.base[0])} L${local(item.tail.end)} L${local(item.tail.base[1])} Z`;
            body.push(`<defs><mask id="${escape(id)}" maskUnits="userSpaceOnUse" x="${-item.w / 2 - 4}" y="${-item.h / 2 - 4}" width="${item.w + 8}" height="${item.h + 8}"><rect x="${-item.w / 2 - 4}" y="${-item.h / 2 - 4}" width="${item.w + 8}" height="${item.h + 8}" fill="white"/><path d="${triangle}" fill="black"/></mask></defs>`);
            body.push(`<rect ${shape} fill="white"/><rect data-kind="balloon-outline" ${shape} fill="none" stroke="#252525" stroke-width="2" mask="url(#${escape(id)})"/>`);
          } else body.push(`<rect ${shape} fill="${item.appearance?.fill ?? (item.kind === 'thought' ? '#26332e' : 'white')}" stroke="#252525" stroke-width="2"/>`);
        }
        item.rows.forEach((row, index) => {
          const m = measureLetters(row, item.fontSize);
          const baseline = (index - (item.rows.length - 1) / 2) * item.lineHeight + (m.ascent - m.descent) / 2;
          const path = letteringPath(row, item.fontSize, -m.width / 2, baseline);
          if (item.kind === 'sfx' && item.inkStroke > 0) {
            body.push(`<path aria-hidden="true" d="${path}" fill="#202020" stroke="white" stroke-width="${item.outlineStroke}" stroke-linejoin="round" paint-order="stroke"/>`);
            body.push(`<path data-text="${escape(row)}" data-sfx-style="${escape(item.sfxStyle)}" aria-label="${escape(row)}" d="${path}" fill="#202020" stroke="#202020" stroke-width="${item.inkStroke}" stroke-linejoin="round" paint-order="stroke"/>`);
          } else body.push(`<path data-text="${escape(row)}" aria-label="${escape(row)}" d="${path}" fill="${item.appearance?.ink ?? (item.kind === 'thought' ? '#fff' : '#202020')}"${item.kind === 'sfx' || item.appearance?.box === 'none' ? ' stroke="white" stroke-width="7" stroke-linejoin="round" paint-order="stroke"' : ''}/>`);
        });
        body.push('</g>');
      }
      body.push('</g></g>');
      layout.push({ shotId: shot.id, y, height: shot.height + header, artY: header, artHeight: shot.height, letteringHeight: header, gapAfter: shot.gapAfter, letteringVersion: 2, selectedId: solved.selectedId });
      y += shot.height + header + shot.gapAfter;
      continue;
    }
    // Keep editable lettering outside the art; no guessed tail may point to the wrong face.
    if (image && shot.texts.some(imageText)) throw new Error('PHYSICAL_TEXT_REQUIRES_VERIFIED_LAYOUT');
    const lettering = shot.texts.filter((text) => text.kind !== 'sfx' && !imageText(text));
    let ty = 0;
    const letterBody = [];
    for (const text of lettering) {
      const dialogue = text.kind === 'dialogue';
      const ui = text.kind === 'ui';
      const thought = text.kind === 'thought';
      const rows = lines(text.text, dialogue ? 17 : 22);
      const font = ui ? 27 : 32;
      const width = Math.min(700, Math.max(180, Math.max(...rows.map((row) => [...row].length)) * font + 56));
      const height = rows.length * 42 + (dialogue ? 38 : 24);
      const x = dialogue && text.speaker === 'c2' ? 755 - width : 45;
      letterBody.push(`<g data-kind="${escape(text.kind)}" data-speaker="${escape(text.speaker)}" transform="translate(${x} ${ty})">`);
      if (dialogue) letterBody.push(`<rect width="${width}" height="${height}" rx="${Math.min(40, height / 2)}" fill="white" stroke="#242424" stroke-width="2"/>`);
      else if (ui || thought) letterBody.push(`<rect width="${width}" height="${height}" rx="6" fill="#26332e"/>`);
      else letterBody.push(`<rect x="0" y="8" width="3" height="${height - 16}" fill="#d9d2c5"/>`);
      rows.forEach((line, i) => letterBody.push(`<text xml:space="preserve" x="28" y="${(dialogue ? 43 : 36) + i * 42}" font-size="${font}" fill="${ui || thought ? '#fff' : '#242424'}">${escape(line)}</text>`));
      letterBody.push('</g>'); ty += height + 22;
    }
    const artY = reference ? 0 : ty;
    const actualHeight = shot.height + ty;
    body.push(`<g id="${escape(shot.id)}" transform="translate(0 ${y})">`);
    if (image) body.push(`<image x="20" y="${artY}" width="760" height="${shot.height}" preserveAspectRatio="xMidYMid meet" href="data:${image.mime};base64,${image.base64}"/>`);
    else {
      body.push(`<rect x="20" y="${artY}" width="760" height="${shot.height}" fill="#f5f2ed"/>`);
      body.push(`<text x="52" y="${artY + 45}" fill="#958978" font-size="20">작화 전 · ${escape(shot.id)}</text>`);
      lines(shot.action, 27).slice(0, Math.max(1, Math.floor((shot.height - 90) / 35))).forEach((line, i) => body.push(`<text x="52" y="${artY + 91 + i * 35}" fill="#59534c" font-size="25">${escape(line)}</text>`));
      // Planning-only metadata, not a fake preview of surface lettering.
      const notes = shot.texts.filter(imageText).flatMap(t => lines(`[사물 글자 · ${t.surface}] ${t.text}`, 38));
      const room = Math.max(0, Math.floor((shot.height - 110) / 26));
      notes.slice(0, room).forEach((line, i) => body.push(`<text data-kind="physical-text-plan" x="52" y="${artY + shot.height - 22 - (Math.min(notes.length, room) - 1 - i) * 26}" fill="#59534c" font-size="18">${escape(line)}</text>`));
    }
    body.push(`<g data-layer="lettering" transform="translate(0 ${reference ? shot.height : 0})">${letterBody.join('')}</g>`);
    let sfxY = artY + shot.height - 40;
    for (const text of shot.texts.filter((item) => item.kind === 'sfx')) {
      const rows = lines(text.text, 15);
      for (const line of [...rows].reverse()) {
        body.push(`<text data-kind="sfx" data-speaker="${escape(text.speaker)}" x="55" y="${sfxY}" font-size="52" font-weight="900" font-style="italic" fill="#181818" stroke="white" stroke-width="5" paint-order="stroke">${escape(line)}</text>`);
        sfxY -= 60;
      }
    }
    body.push('</g>');
    layout.push({ shotId: shot.id, y, height: actualHeight, artY, artHeight: shot.height, letteringHeight: ty, gapAfter: shot.gapAfter });
    y += actualHeight + shot.gapAfter;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${y}" viewBox="0 0 800 ${y}" font-family="Apple SD Gothic Neo, Noto Sans KR, sans-serif" role="img" aria-label="${escape(plan.title)}">${Object.keys(solvedLayouts).length ? fontStyle() : ''}<rect width="800" height="${y}" fill="white"/>${body.join('')}</svg>`;
  return { language: languageTag(plan.language ?? 'ko'), svg, hash: digest(svg), layout, width: 800, height: y, imageCount: shots.filter(shot => images[shot.id]).length, artComplete: shots.every((shot) => images[shot.id]),
    limitations: ['SVG 마스터와 HTML 미리보기. 플랫폼용 PNG/JPEG 래스터화는 외부 편집기에서 수행한다.', '대사·독백은 작화 밖의 편집 레이어이며 인물별 좌우 배치는 읽기 보조다. 정확한 말풍선 꼬리와 화면 속 UI 부착 위치는 수동 연출이 필요하다.'] };
}

export async function importWebtoonImages(root, assets, expectedShots) {
  if (!Array.isArray(assets)) throw new Error('INVALID_ASSET_LIST');
  const images = {};
  const project = await realpath(root);
  for (const asset of assets) {
    if (!asset || !expectedShots.includes(asset.shotId) || images[asset.shotId] || typeof asset.path !== 'string') throw new Error('INVALID_ASSET_SHOT');
    const path = await realpath(resolve(root, asset.path));
    const rel = relative(project, path);
    if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('ASSET_OUTSIDE_PROJECT');
    const bytes = await readFile(path);
    if (bytes.length > 20 * 1024 * 1024 || bytes.length < 24) throw new Error('INVALID_IMAGE_SIZE');
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : null;
    if (!mime) throw new Error('UNSUPPORTED_IMAGE: PNG 또는 JPEG만 반입할 수 있습니다.');
    verifyImageContainer(bytes, mime);
    images[asset.shotId] = { mime, hash: digest(bytes), base64: bytes.toString('base64'), sourcePath: rel,
      provenance: asset.provenance ?? { kind: 'manual-import', generation: 'unverified' } };
  }
  return images;
}

export function boardHtml(board) {
  const lang = languageTag(board.language ?? 'ko');
  const label = (ko, en) => webtoonMessage({ languageContract: { language: lang } }, ko, en);
  return `<!doctype html><html lang="${escape(lang)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${label('웹툰 · 세로 읽기', 'Webtoon · Vertical reader')}</title><style>html{color-scheme:light;scroll-behavior:smooth}body{margin:0;background:#e8e5df;color:#242424;font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif}header{max-width:736px;margin:0 auto;padding:24px 32px;display:flex;justify-content:space-between;gap:16px;font-size:14px;letter-spacing:.02em}header span{color:#736b60}main{max-width:800px;margin:auto;background:white;box-shadow:0 0 40px #40352508}svg{display:block;width:100%;height:auto}footer{text-align:center;padding:48px 20px;color:#736b60;font-size:14px}a{color:inherit;text-underline-offset:4px}@media(max-width:600px){header{padding:18px 20px}main{box-shadow:none}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}</style><header id="top"><strong>VIBELORE · WEBTOON</strong><span>${board.artComplete ? label('작화 포함 검토본', 'Illustrated review') : label('작화 전 · 대본 콘티', 'Script storyboard')} · ${board.layout.length}${label('컷', ' panels')}</span></header><main>${board.svg}</main><footer><a href="#top">${label('처음으로 ↑', 'Back to top ↑')}</a></footer></html>`;
}
