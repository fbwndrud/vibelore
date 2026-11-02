/** Plain adaptation fixtures for the episode path: one expand beat over all units, one page, three panels, one dialogue text. */
const clone = value => structuredClone(value);
const panelAt = (units, page, n, extra = {}) => ({ id: `p${page}-${n}`, beatIds: ['beat-1'], sourceIds: n === 3 ? units.slice(1).map(u => u.id) : [units[0].id],
  shows: '문 앞에 선 인물의 굳은 어깨', readerDelta: '망설임이 보인다', bridge: n === 1 ? 'page opener' : '앞 칸의 망설임이 손을 멈추게 한다',
  texts: n === 1 ? [{ id: `t${page}-1`, sourceId: units[0].id, kind: 'dialogue', speaker: 'c1', text: units[0].text }] : [], ...extra });

export const adaptationFor = (units, overrides = {}) => ({
  editorial: { version: 1, focus: { primary: '문 앞의 망설임', supporting: ['고요'], tradeoff: '설명을 덜고 표정을 남긴다' },
    beats: [{ id: 'beat-1', sourceIds: units.map(u => u.id), decision: 'expand', reason: '주된 경험', readerChange: '망설임을 느낀다',
      visualProof: '문 앞에서 멈춘 손', carryForward: '불필요: 이 쪽 안에서 전달' }] },
  extras: [], pageCountReason: '한 장면이라 한 쪽이면 충분하다',
  pages: [{ id: 'page-1', purpose: '망설임을 보여 준다', pageTurn: '문이 열린다', panels: [1, 2, 3].map(n => panelAt(units, 1, n)) }],
  ...overrides,
});

/** Last unit leaves the beat and the panels, so the editorial map no longer covers it. */
export function dropUnit(a) {
  const next = clone(a), last = next.editorial.beats[0].sourceIds.pop();
  for (const panel of next.pages.flatMap(p => p.panels)) panel.sourceIds = panel.sourceIds.filter(id => id !== last);
  return next;
}

/** Last unit becomes an omitted beat, and the third panel still draws it. */
export function omitDrawnBeat(a) {
  const next = clone(a), [beat] = next.editorial.beats, last = beat.sourceIds.pop();
  next.editorial.beats.push({ ...beat, id: 'beat-2', sourceIds: [last], decision: 'omit', visualProof: '' });
  Object.assign(next.pages[0].panels[2], { beatIds: ['beat-2'], sourceIds: [last] });
  return next;
}

export function withText(a, text) { const next = clone(a); next.pages[0].panels[0].texts[0].text = text; return next; }
export function withSpeaker(a, speaker) { const next = clone(a); next.pages[0].panels[0].texts[0].speaker = speaker; return next; }
export function withExtraSpeaker(a, id) {
  const next = withSpeaker(a, id); next.extras = [...(next.extras ?? []), { id, label: '이름 없는 기수', sourceIds: [next.pages[0].panels[0].sourceIds[0]] }];
  return next;
}

/** First page gets `n` panels, copies of its last one without texts. */
export function withPanels(a, n) {
  const next = clone(a), { panels } = next.pages[0];
  while (panels.length < n) panels.push({ ...clone(panels.at(-1)), id: `p1-${panels.length + 1}`, texts: [] });
  panels.length = n;
  return next;
}

/** First panel gets `n` dialogue texts copied from its first one. */
export function withTexts(a, n) {
  const next = clone(a), [panel] = next.pages[0].panels, [text] = panel.texts;
  panel.texts = Array.from({ length: n }, (_, i) => ({ ...text, id: `t1-${i + 1}` }));
  return next;
}

/** `n` pages, each a copy of the first with its own page, panel and text ids. */
export function withPages(a, n) {
  const next = clone(a), [page] = next.pages;
  next.pages = Array.from({ length: n }, (_, k) => ({ ...clone(page), id: `page-${k + 1}`, panels: page.panels.map((panel, i) => ({ ...clone(panel), id: `p${k + 1}-${i + 1}`,
    texts: panel.texts.map((t, j) => ({ ...t, id: `t${k + 1}-${i + 1}-${j + 1}` })) })) }));
  return next;
}
