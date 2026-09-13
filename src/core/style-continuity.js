import { asKit } from '../prompts/index.js';

const sentenceLengths = (text) => [...String(text ?? '').matchAll(/[^.!?。…]+[.!?。…]+/g)]
  .map((match) => match[0].trim().length)
  .filter(Boolean);

const paragraphsOf = (prose) => String(prose ?? '')
  .replace(/\r\n/g, '\n')
  .trim()
  .split(/\n\s*\n/)
  .map((paragraph) => paragraph.trim())
  .filter(Boolean);

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const rounded = (value, digits = 3) => Number(Number(value || 0).toFixed(digits));

export function proseStyleFingerprint(prose) {
  const text = String(prose ?? '').replace(/\r\n/g, '\n').trim();
  const paragraphs = paragraphsOf(text);
  const lengths = paragraphs.map((paragraph) => paragraph.length);
  const sentences = sentenceLengths(text);
  const dialogueParagraphs = paragraphs.filter((paragraph) => /^[“"「『]/.test(paragraph)).length;
  const shortParagraphs = paragraphs.filter((paragraph) => paragraph.length <= 40).length;
  const softLineBreaks = paragraphs.reduce((total, paragraph) =>
    total + Math.max(0, paragraph.split('\n').filter((line) => line.trim()).length - 1), 0);
  const firstPersonMarkers = (text.match(/(?:^|\s)(?:나는|내가|나를|나의|내게|내가)(?=\s|[,.!?]|$)/g) ?? []).length;
  return {
    chars: text.length,
    paragraphs: paragraphs.length,
    paragraphsPer1k: rounded(paragraphs.length / Math.max(1, text.length) * 1000, 1),
    medianParagraphChars: median(lengths),
    p90ParagraphChars: lengths.length ? [...lengths].sort((a, b) => a - b)[Math.floor(lengths.length * 0.9)] : 0,
    shortParagraphRatio: rounded(shortParagraphs / Math.max(1, paragraphs.length)),
    dialogueParagraphRatio: rounded(dialogueParagraphs / Math.max(1, paragraphs.length)),
    medianSentenceChars: median(sentences),
    firstPersonMarkersPer1k: rounded(firstPersonMarkers / Math.max(1, text.length) * 1000, 1),
    softLineBreaks,
  };
}

function excerptFrom(prose) {
  const paragraphs = paragraphsOf(prose);
  const selected = [];
  let chars = 0;
  for (const paragraph of paragraphs) {
    if (selected.length && chars + paragraph.length + 2 > 700) break;
    selected.push(paragraph);
    chars += paragraph.length + 2;
  }
  return selected.join('\n\n').slice(0, 700).trim();
}

function aggregateFingerprints(fingerprints) {
  const numeric = (key) => median(fingerprints.map((item) => item[key]));
  const paragraphDensity = numeric('paragraphsPer1k');
  const medianParagraphChars = numeric('medianParagraphChars');
  return {
    paragraphsPer1k: paragraphDensity,
    medianParagraphChars,
    dialogueParagraphRatio: numeric('dialogueParagraphRatio'),
    medianSentenceChars: numeric('medianSentenceChars'),
    firstPersonMarkersPer1k: numeric('firstPersonMarkersPer1k'),
    tolerance: {
      paragraphsPer1k: [rounded(Math.max(1, paragraphDensity * 0.65), 1), rounded(paragraphDensity * 1.35, 1)],
      medianParagraphChars: [Math.max(1, Math.floor(medianParagraphChars * 0.55)), Math.ceil(medianParagraphChars * 1.8)],
      dialogueParagraphRatio: [rounded(Math.max(0, numeric('dialogueParagraphRatio') - 0.2)), rounded(Math.min(1, numeric('dialogueParagraphRatio') + 0.2))],
    },
  };
}

export function buildStyleAnchor({ workId, chapters, reason = '', revision = 1, approvedAt = new Date().toISOString() }) {
  const unique = [...new Map((chapters ?? []).map((chapter) => [Number(chapter.chapterNumber), chapter])).values()]
    .filter((chapter) => Number.isInteger(Number(chapter.chapterNumber)) && Number(chapter.chapterNumber) > 0 && String(chapter.prose ?? '').trim())
    .slice(0, 3);
  if (!unique.length) throw new Error('STYLE_ANCHOR_SOURCE_REQUIRED: 승인할 정본 화가 필요합니다.');
  const fingerprints = unique.map((chapter) => proseStyleFingerprint(chapter.prose));
  return {
    schemaVersion: 1,
    workId,
    status: 'active',
    revision,
    reason,
    sourceChapters: unique.map((chapter) => Number(chapter.chapterNumber)),
    excerpts: unique.map((chapter) => ({ chapter: Number(chapter.chapterNumber), text: excerptFrom(chapter.prose) })),
    baseline: aggregateFingerprints(fingerprints),
    approvedAt,
  };
}

export function renderStyleAnchor(anchor, kitSource) {
  if (!anchor || anchor.status !== 'active') return '';
  const t = asKit(kitSource).phrases.writer;
  const baseline = anchor.baseline ?? {};
  return [
    t.styleAnchorHeading,
    t.styleAnchorSources((anchor.sourceChapters ?? []).join(', ')),
    ...(anchor.reason ? [t.styleAnchorReason(anchor.reason)] : []),
    t.styleAnchorBaseline(baseline),
    ...(anchor.excerpts ?? []).map((excerpt) => t.styleAnchorExcerpt(excerpt.chapter, excerpt.text)),
  ].join('\n\n');
}

function lcsCount(left, right) {
  const row = new Uint32Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= right.length; j += 1) {
      const previous = row[j];
      row[j] = left[i - 1] === right[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = previous;
    }
  }
  return row[right.length];
}

export function evaluateRevisionPreservation({ sourceProse, candidateProse, violations = [] }) {
  const source = proseStyleFingerprint(sourceProse);
  const candidate = proseStyleFingerprint(candidateProse);
  const sourceParagraphs = paragraphsOf(sourceProse);
  const candidateParagraphs = paragraphsOf(candidateProse);
  const unchangedParagraphs = lcsCount(sourceParagraphs, candidateParagraphs);
  const lengthExpansion = violations.some((violation) => violation.code === 'QUALITY_GATE_LENGTH');
  const formatRepair = violations.some((violation) => String(violation.code ?? '').startsWith('WEBNOVEL_'));
  const minimumUnchangedRatio = lengthExpansion ? 0.65 : (formatRepair ? 0.5 : 0.75);
  const metrics = {
    sourceParagraphs: source.paragraphs,
    candidateParagraphs: candidate.paragraphs,
    unchangedParagraphs,
    unchangedParagraphRatio: rounded(unchangedParagraphs / Math.max(1, sourceParagraphs.length)),
    paragraphDensityDelta: rounded(candidate.paragraphsPer1k - source.paragraphsPer1k, 1),
    softLineBreakDelta: candidate.softLineBreaks - source.softLineBreaks,
    charChangeRatio: rounded(Math.abs(candidate.chars - source.chars) / Math.max(1, source.chars)),
  };
  const found = [];
  if (metrics.softLineBreakDelta >= 12 && candidate.softLineBreaks >= 20) {
    found.push({ severity: 'hard', code: 'REVISION_LAYOUT_DRIFT', message: `수정본이 빈 문단 경계를 일반 줄바꿈으로 바꿨다: 일반 줄바꿈 ${source.softLineBreaks}→${candidate.softLineBreaks}.`, evidence: metrics });
  }
  const densityLimit = Math.max(10, source.paragraphsPer1k * 0.3);
  if (!lengthExpansion && Math.abs(metrics.paragraphDensityDelta) > densityLimit) {
    found.push({ severity: 'hard', code: 'REVISION_RHYTHM_DRIFT', message: `수정 범위를 넘어 문단 호흡이 달라졌다: 1,000자당 문단 ${source.paragraphsPer1k}→${candidate.paragraphsPer1k}.`, evidence: metrics });
  }
  if (metrics.unchangedParagraphRatio < minimumUnchangedRatio) {
    found.push({ severity: 'hard', code: 'REVISION_SCOPE_DRIFT', message: `원문 보존 문단 비율 ${Math.round(metrics.unchangedParagraphRatio * 100)}%가 허용 하한 ${Math.round(minimumUnchangedRatio * 100)}%보다 낮다.`, evidence: metrics });
  }
  return { passed: found.length === 0, violations: found, metrics, source, candidate };
}

export function evaluateChapterStyle({ prose, anchor, chapterNumber }) {
  if (!anchor || anchor.status !== 'active') return { drifted: false, advisories: [], fingerprint: proseStyleFingerprint(prose) };
  const fingerprint = proseStyleFingerprint(prose);
  const baseline = anchor.baseline ?? {};
  const tolerance = baseline.tolerance ?? {};
  const reasons = [];
  const outside = (value, range) => Array.isArray(range) && (value < range[0] || value > range[1]);
  if (outside(fingerprint.paragraphsPer1k, tolerance.paragraphsPer1k)) reasons.push(`문단 밀도 ${fingerprint.paragraphsPer1k} (기준 ${tolerance.paragraphsPer1k.join('~')})`);
  if (outside(fingerprint.medianParagraphChars, tolerance.medianParagraphChars)) reasons.push(`문단 중앙값 ${fingerprint.medianParagraphChars}자 (기준 ${tolerance.medianParagraphChars.join('~')})`);
  if (outside(fingerprint.dialogueParagraphRatio, tolerance.dialogueParagraphRatio)) reasons.push(`대사 문단 비율 ${fingerprint.dialogueParagraphRatio} (기준 ${tolerance.dialogueParagraphRatio.join('~')})`);
  const advisories = reasons.length ? [{
    severity: 'soft', advisoryOnly: true, code: 'STYLE_ANCHOR_DRIFT', chapterNumber,
    message: `승인된 작품 문체 기준과 큰 차이가 있다: ${reasons.join(', ')}. 자동 교정하지 말고 원고와 기준 예시를 함께 검토한다.`,
    evidence: { sourceChapters: anchor.sourceChapters, fingerprint, baseline },
  }] : [];
  return { drifted: advisories.length > 0, advisories, fingerprint };
}
