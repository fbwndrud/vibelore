import { readFile } from "node:fs/promises";
import { fail } from "../engine/contracts.js";
// Inspect the font's actual Unicode cmap. Never infer coverage from a font name.
export function validateGlyphs(bytes, text) {
  const b = Buffer.from(bytes);
  let cmap;
  for (let i = 0; i < b.readUInt16BE(4); i++) {
    const at = 12 + i * 16;
    if (b.toString("ascii", at, at + 4) === "cmap")
      cmap = b.readUInt32BE(at + 8);
  }
  if (cmap == null) fail("INVALID_FONT", "Font has no cmap.");
  const maps = [];
  for (let i = 0; i < b.readUInt16BE(cmap + 2); i++) {
    const at = cmap + 4 + i * 8,
      platform = b.readUInt16BE(at),
      encoding = b.readUInt16BE(at + 2);
    if (platform === 0 || (platform === 3 && [1, 10].includes(encoding)))
      maps.push(cmap + b.readUInt32BE(at + 4));
  }
  function glyph(cp) {
    for (const at of maps) {
      const format = b.readUInt16BE(at);
      if (format === 12) {
        const n = b.readUInt32BE(at + 12);
        for (let j = 0; j < n; j++) {
          const g = at + 16 + j * 12,
            start = b.readUInt32BE(g),
            end = b.readUInt32BE(g + 4);
          if (cp >= start && cp <= end && b.readUInt32BE(g + 8) + cp - start)
            return true;
        }
      }
      if (format === 4 && cp <= 65535) {
        const n = b.readUInt16BE(at + 6) / 2,
          ends = at + 14,
          starts = ends + n * 2 + 2,
          deltas = starts + n * 2,
          ranges = deltas + n * 2;
        for (let j = 0; j < n; j++) {
          if (
            cp < b.readUInt16BE(starts + j * 2) ||
            cp > b.readUInt16BE(ends + j * 2)
          )
            continue;
          const delta = b.readInt16BE(deltas + j * 2),
            range = b.readUInt16BE(ranges + j * 2);
          let g = range
            ? b.readUInt16BE(
                ranges +
                  j * 2 +
                  range +
                  (cp - b.readUInt16BE(starts + j * 2)) * 2,
              )
            : cp;
          if (g) g = (g + delta) & 65535;
          if (g) return true;
        }
      }
    }
    return false;
  }
  for (const char of text.normalize("NFC"))
    if (!/\s/u.test(char) && !glyph(char.codePointAt(0)))
      fail(
        "UNSUPPORTED_GLYPH",
        "Caption contains a glyph absent from the bundled font.",
        { codePoint: char.codePointAt(0) },
      );
}
export async function prepareFont(service, projectId, text) {
  const bytes = await readFile(
    new URL("../../assets/fonts/GowunDodum-Regular.ttf", import.meta.url),
  );
  validateGlyphs(bytes, text);
  const license = await readFile(
    new URL("../../assets/fonts/OFL.txt", import.meta.url),
  );
  return {
    family: "StudioCaption",
    blobId: (await service.blobs.put(projectId, bytes)).blobId,
    licenseBlobId: (await service.blobs.put(projectId, license)).blobId,
    license: "SIL-OFL-1.1",
  };
}
