const sentenceCount = (text) => (text.match(/[.!?。…](?:["'”’」』])?(?=\s|$)/g) ?? []).length;
const containsDialogue = (paragraph) => /["“][^"”]+["”]|「[^」]+」|『[^』]+』/s.test(paragraph);
const systemNotice = (paragraph) => /^\s*[\[【].*[\]】]\s*$/s.test(paragraph);

/** High-confidence mobile-webnovel paragraph failures; taste stays outside the gate. */
export function scanWebnovelFormat({ prose, chapterNumber, dialogueBreakMode = 'strict' }) {
  const text = String(prose ?? '').replace(/\r\n/g, '\n');
  const paragraphs = text.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const violations = [];
  const multiLineParagraphs = paragraphs.filter((paragraph) => paragraph.split('\n').filter((line) => line.trim()).length > 1);
  const softLineBreaks = multiLineParagraphs.reduce((total, paragraph) =>
    total + Math.max(0, paragraph.split('\n').filter((line) => line.trim()).length - 1), 0);
  if (softLineBreaks >= 20 || multiLineParagraphs.length >= 12) {
    violations.push({ severity: 'soft', code: 'WEBNOVEL_SOFT_LINEBREAKS', chapterNumber,
      message: `빈 줄 없는 일반 줄바꿈 ${softLineBreaks}개가 ${multiLineParagraphs.length}개 문단 안에 남아 있다. 일반 산문 문단 내부는 공백으로 잇고 문단 경계는 빈 줄로 구분하라.` });
  }
  const dense = paragraphs.flatMap((paragraph, index) => {
    const sentences = sentenceCount(paragraph);
    return paragraph.length > 650 || (paragraph.length > 420 && sentences >= 6)
      ? [{ index: index + 1, chars: paragraph.length, sentences }]
      : [];
  });
  if (dense.length) violations.push({ severity: 'soft', code: 'WEBNOVEL_DENSE_PARAGRAPH', chapterNumber,
    message: `모바일 독서에 과밀한 문단 ${dense.length}개: ${dense.slice(0, 4).map((item) => `${item.index}번 ${item.chars}자/${item.sentences}문장`).join(', ')}` });

  let longestDenseRun = 0;
  let currentRun = 0;
  for (const paragraph of paragraphs) {
    if (paragraph.length >= 300) { currentRun += 1; longestDenseRun = Math.max(longestDenseRun, currentRun); }
    else currentRun = 0;
  }
  if (longestDenseRun >= 3) violations.push({ severity: 'soft', code: 'WEBNOVEL_LONG_PARAGRAPH_RUN', chapterNumber,
    message: `300자 이상 문단이 ${longestDenseRun}개 연속되어 모바일 호흡이 막힌다.` });

  const mixedDialogue = paragraphs.filter((paragraph) => {
    const lines = paragraph.split('\n').filter((line) => line.trim());
    if (lines.length !== 1) return false;
    const line = lines[0];
    const quotes = line.match(/["“][^"”]+["”]|「[^」]+」|『[^』]+』/g) ?? [];
    if (!quotes.length) return false;
    if (dialogueBreakMode !== 'relaxed') {
      return quotes.length !== 1 || paragraph.trim() !== quotes[0].trim();
    }
    const outside = quotes.reduce((rest, quote) => rest.replace(quote, ''), line).trim();
    return outside.length > 100;
  });
  if (mixedDialogue.length) violations.push({ severity: 'soft',
    code: dialogueBreakMode === 'relaxed' ? 'WEBNOVEL_DIALOGUE_BURIED' : 'WEBNOVEL_DIALOGUE_NOT_ISOLATED', chapterNumber,
    message: dialogueBreakMode === 'relaxed'
      ? `대사와 100자 초과 서술이 한 줄에 붙은 문단 ${mixedDialogue.length}개. 대사를 독립 호흡으로 분리하라.`
      : `큰따옴표 대사가 독립 문단이 아닌 곳 ${mixedDialogue.length}개. 각 인용 대사의 앞뒤를 빈 줄로 분리하라.` });

  if (paragraphs.length >= 12) {
    const veryShort = paragraphs.filter((paragraph) => paragraph.length <= 18).length;
    if (veryShort / paragraphs.length >= 0.7) violations.push({ severity: 'soft', code: 'WEBNOVEL_CHOPPY_BREAKS', chapterNumber,
      message: `18자 이하 문단이 ${veryShort}/${paragraphs.length}개로 과도해 문장이 카드처럼 잘게 끊긴다.` });
  }
  const narrativeParagraphs = paragraphs.filter((paragraph) => !containsDialogue(paragraph) && !systemNotice(paragraph));
  let longestFragmentedRun = 0;
  let fragmentedRun = 0;
  for (const paragraph of paragraphs) {
    if (containsDialogue(paragraph) || systemNotice(paragraph)) {
      fragmentedRun = 0;
      continue;
    }
    if (paragraph.length <= 40 && sentenceCount(paragraph) <= 1) {
      fragmentedRun += 1;
      longestFragmentedRun = Math.max(longestFragmentedRun, fragmentedRun);
    } else fragmentedRun = 0;
  }
  const fragmentedParagraphs = narrativeParagraphs.filter((paragraph) => paragraph.length <= 40 && sentenceCount(paragraph) <= 1).length;
  if (narrativeParagraphs.length >= 16 && fragmentedParagraphs / narrativeParagraphs.length >= 0.65 && longestFragmentedRun >= 6) {
    violations.push({ severity: 'soft', code: 'WEBNOVEL_FRAGMENTED_RHYTHM', chapterNumber,
      message: `짧은 서술 문단이 ${fragmentedParagraphs}/${narrativeParagraphs.length}개이고 ${longestFragmentedRun}개 연속된다. 원인·반응·결과가 한 박자인 곳은 문단을 묶어 호흡을 회복할 수 있다.` });
  }
  return { violations, stats: {
    paragraphs: paragraphs.length, denseParagraphs: dense.length, longestDenseRun,
    narrativeParagraphs: narrativeParagraphs.length, fragmentedParagraphs, longestFragmentedRun,
    softLineBreaks, multiLineParagraphs: multiLineParagraphs.length,
  } };
}

/** Split only quote boundaries flagged by WEBNOVEL_DIALOGUE_BURIED; words stay byte-identical. */
export function separateBuriedDialogue(prose, dialogueBreakMode = 'strict') {
  return String(prose ?? '').split(/\n\s*\n/).map((paragraph) => {
    const trimmed = paragraph.trim();
    if (dialogueBreakMode !== 'relaxed') {
      const pieces = trimmed.split(/(["“][^"”]+["”]|「[^」]+」|『[^』]+』)/s).map((piece) => piece.trim()).filter(Boolean);
      return pieces.length > 1 ? pieces.join('\n\n') : trimmed;
    }
    const match = trimmed.match(/^(.*?)(["“][^"”]+["”]|「[^」]+」|『[^』]+』)(.*)$/s);
    if (!match) return trimmed;
    const [, before, quote, after] = match;
    if (`${before}${after}`.trim().length <= 100) return trimmed;
    return [before.trim(), quote.trim(), after.trim()].filter(Boolean).join('\n\n');
  }).join('\n\n').trim();
}

/** Merge only long runs of short narration; quoted speech and system notices stay isolated. */
export function mergeFragmentedNarration(prose) {
  const paragraphs = String(prose ?? '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const mergeable = (paragraph) => !containsDialogue(paragraph) && !systemNotice(paragraph)
    && paragraph.length <= 70 && sentenceCount(paragraph) <= 2;
  const output = [];
  for (let index = 0; index < paragraphs.length;) {
    let end = index;
    while (end < paragraphs.length && mergeable(paragraphs[end])) end += 1;
    const run = paragraphs.slice(index, end);
    if (run.length < 5) {
      output.push(...(run.length ? run : [paragraphs[index]]));
      index = run.length ? end : index + 1;
      continue;
    }
    let paragraph = '';
    for (const part of run) {
      if (paragraph && paragraph.length + part.length + 1 > 220) {
        output.push(paragraph);
        paragraph = part;
      } else paragraph = paragraph ? `${paragraph} ${part}` : part;
    }
    if (paragraph) output.push(paragraph);
    index = end;
  }
  return output.join('\n\n').trim();
}

export function normalizeWebnovelLayout(prose, dialogueBreakMode = 'strict') {
  return separateBuriedDialogue(prose, dialogueBreakMode);
}
