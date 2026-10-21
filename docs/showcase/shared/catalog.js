/* A work is discovered by its story and language, with production details kept secondary. */
(function () {
  'use strict';
  const { el, cmpVer, loadCatalog, T } = window.Showcase;
  const FORMATS = [['novel', '소설'], ['webtoon', '웹툰'], ['all', '모든 작품']];
  const MODELS = [['all', '전체'], ['claude', 'Claude'], ['gpt', 'GPT'], ['gemini', 'Gemini'], ['mixed', '여러 모델 비교']];
  const NAMES = { ko: '한국어', en: '영어', ja: '일본어', 'zh-Hant': '번체 중국어', es: '스페인어', fr: '프랑스어', ar: '아랍어', th: '태국어' };
  const DEFAULT = { format: 'novel', workLanguage: 'all', model: 'all', sort: 'recommended', q: '' };
  const state = { ...DEFAULT };
  let works = [], languages = [];
  function readState() {
    const p = new URLSearchParams(location.search);
    const choices = { format: ['all', 'novel', 'webtoon', 'multi'], workLanguage: ['all', ...languages], model: MODELS.map((x) => x[0]), sort: ['recommended', 'version', 'size', 'title'] };
    for (const k of Object.keys(choices)) state[k] = choices[k].includes(p.get(k)) ? p.get(k) : DEFAULT[k];
    state.q = p.get('q') || '';
  }
  function syncUrl() {
    const u = new URL(location.href);
    u.searchParams.delete('view');
    for (const k of Object.keys(DEFAULT)) {
      if (state[k] === DEFAULT[k]) u.searchParams.delete(k); else u.searchParams.set(k, state[k]);
    }
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  }
  const byFormat = (w, f = state.format) => f === 'all' || (f === 'multi' ? !!w.variant : w.formats.includes(f));
  const byLanguage = (w, l = state.workLanguage) => l === 'all' || w.language === l;
  const byModel = (w, m = state.model) => m === 'all' || w.family === m;
  const title = (w) => w.variant?.title || w.title;
  const lang = (w) => w.language;
  const blurb = (w) => w.variant?.blurb || w.blurb;
  const format = () => state.format === 'webtoon' ? 'webtoon' : 'novel';
  function readHref(w, f = format()) {
    const href = w.variant ? w.variant[f + 'Href'] : w.href + (w.links?.read || 'read.html');
    const u = new URL(href || w.href, location.href);
    if (!w.variant) u.searchParams.set('format', f); else u.searchParams.set('read', '1');
    const ui = new URLSearchParams(location.search).get('lang');
    if (ui) u.searchParams.set('lang', ui);
    return u.pathname + u.search + u.hash;
  }
  const count = (w) => w.reading[format()].episodes;
  function jacket(w, index) {
    return el('div', { class: 'book-jacket jacket-' + w.id, 'aria-hidden': 'true' },
      el('span', { class: 'jacket-series' }, 'VIBELORE / STORIES'),
      el('span', { class: 'jacket-title', lang: lang(w), dir: w.variant?.dir || 'ltr' }, title(w)),
      el('span', { class: 'jacket-sub', lang: lang(w) }, w.variant ? T(NAMES[lang(w)]) : w.sub || T(w.genre)),
      el('span', { class: 'jacket-art' }),
      el('span', { class: 'jacket-footer' }, el('span', null, 'VIBELORE'), el('span', null, String(index + 1).padStart(2, '0'))));
  }
  function card(w, index) {
    const f = format(), excerpt = w.variant?.excerpt || w.reading.novel.excerptText || [];
    const isSample = !!w.variant;
    const status = isSample ? (f === 'novel' ? '1화 발췌' : '1장면 공개') : w.completed?.[f] ? T('{n}화 완결', { n: count(w) }) : T('{n}화 공개', { n: count(w) });
    const visual = el('a', { class: 'story-visual ' + (f === 'webtoon' ? 'webtoon-art' : ''), href: readHref(w), 'aria-label': title(w) + ' · ' + T(f === 'novel' ? '소설 읽기' : '웹툰 보기') },
      f === 'novel' ? jacket(w, index) : el('img', { src: w.variant?.cover || w.thumb, alt: w.variant ? title(w) : w.alt, loading: index < 4 ? 'eager' : 'lazy' }));
    return el('article', { class: 'story-card' + (isSample ? ' sample-card' : '') }, visual,
      el('div', { class: 'story-meta' }, el('span', null, T(NAMES[lang(w)] || lang(w))), el('span', { class: 'dot' }, '·'), el('span', { class: 'status' }, T(status))),
      el('a', { class: 'story-title', href: readHref(w), lang: lang(w), dir: w.variant?.dir || 'ltr' }, title(w)),
      el('p', { class: 'story-blurb', lang: lang(w), dir: w.variant?.dir || 'ltr', title: blurb(w) }, blurb(w)),
      el('div', { class: 'story-bottom' }, el('span', null, isSample ? T('짧은 이야기') : T(w.genre.split(' · ')[0])),
        el('a', { class: 'read-link', href: readHref(w) }, T(f === 'novel' ? '읽기' : '보기'), el('span', { 'aria-hidden': 'true' }, '↗'))),
      ...(state.format === 'all' && w.formats.includes('webtoon') ? [el('a', { class: 'read-link', style: 'display:block;margin-top:10px', href: readHref(w, 'webtoon') }, T('웹툰으로 보기') + ' ↗')] : []),
      ...(f === 'novel' && excerpt.length ? [el('details', { class: 'opening' }, el('summary', null, T('첫 문장 미리 읽기')), el('div', { class: 'opening-text', lang: lang(w), dir: w.variant?.dir || 'ltr' }, excerpt.map((p) => el('p', null, p)), el('a', { class: 'read-link', href: readHref(w) }, T('이어서 읽기') + ' →')))] : []),
      el('details', { class: 'story-details' }, el('summary', null, T('작품 정보')), el('p', null, w.meta),
        el('p', null, 'vibelore ' + w.version.label), el('a', { href: w.href }, T('작품 소개')),
        el('span', null, ' · '), el('a', { href: w.href + (w.links?.notes || w.pages?.notes || (w.variant ? '#about' : 'notes.html')) }, T('제작 노트')),
        ...(w.reading.history || []).map((r) => el('p', null, el('a', { href: r.href }, T('이전 공개본') + ' · ' + r.revision)))));
  }
  function shelf(items, sample) {
    return el('section', { class: 'shelf-section', 'aria-label': T(sample ? '다른 언어의 이야기' : '연재와 완결') },
      ...(sample ? [el('div', { class: 'section-heading' }, el('h3', null, T('다른 언어, 다른 이야기.')), el('p', null, T('언어마다 별도로 만든 작품의 1화 발췌입니다.')))] : []),
      el('div', { class: 'shelf-grid' }, items.map(card)));
  }
  const SORTS = { recommended: () => 0, version: (a, b) => cmpVer(b.version.to, a.version.to), size: (a, b) => count(b) - count(a), title: (a, b) => title(a).localeCompare(title(b), I18N.lang) };
  function render() {
    document.getElementById('f-format').replaceChildren(...FORMATS.map(([f, label]) => el('button', { type: 'button', class: 'shelf-tab', 'aria-pressed': String(state.format === f), onclick: () => { state.format = f; render(); } }, T(label), el('small', null, works.filter((w) => byFormat(w, f) && byLanguage(w) && byModel(w)).length))));
    document.body.dataset.medium = format();
    document.getElementById('f-model').replaceChildren(...MODELS.map(([m, label]) => el('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.model === m), onclick: () => { state.model = m; render(); } }, T(label))));
    const shown = works.filter((w) => byFormat(w) && byLanguage(w) && byModel(w) && (title(w) + ' ' + (w.gloss || '')).toLocaleLowerCase().includes(state.q.toLocaleLowerCase())).sort(SORTS[state.sort]);
    const main = shown.filter((w) => !w.variant), samples = shown.filter((w) => w.variant);
    const out = document.getElementById('out');
    document.getElementById('works-label').textContent = T(state.format === 'novel' ? '소설 서가' : state.format === 'webtoon' ? '웹툰 서가' : '모든 이야기');
    document.getElementById('count').textContent = shown.length === 1 ? T('1편') : T('{n}편', { n: shown.length });
    document.getElementById('f-language').value = state.workLanguage;
    document.getElementById('sort').value = state.sort;
    if (!shown.length) out.replaceChildren(el('div', { class: 'empty' }, T('조건에 맞는 작품이 없습니다.'), el('button', { type: 'button', onclick: () => { Object.assign(state, DEFAULT); document.getElementById('search').value = ''; render(); } }, T('필터 모두 풀기'))));
    else out.replaceChildren(...(main.length ? [shelf(main, false)] : []), ...(samples.length ? [shelf(samples, true)] : []));
    I18N.apply(out); syncUrl();
    document.getElementById('site-language').replaceChildren(I18N.toggle());
    for (const a of document.querySelectorAll('[data-nav]')) {
      const active = 'works';
      if (a.dataset.nav === active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      if (['works', 'novel', 'webtoon'].includes(a.dataset.nav)) {
        const u = new URL(location.href);
        u.searchParams.set('format', a.dataset.nav === 'works' ? 'all' : a.dataset.nav);
        a.href = u.pathname + u.search;
      }
    }
  }
  loadCatalog().then((data) => {
    works = data.works.flatMap((w) => Object.keys(w.reading.variants).length ? Object.entries(w.reading.variants).map(([language, variant]) => ({ ...w, language, variant })) : [w]);
    languages = [...new Set(works.map((w) => w.language))];
    readState();
    document.getElementById('f-language').replaceChildren(...[['all', '모든 언어'], ...languages.map((l) => [l, NAMES[l] || l])].map(([value, label]) => el('option', { value }, T(label))));
    if (state.model !== 'all') document.getElementById('production-filters').open = true;
    document.getElementById('search').value = state.q;
    document.getElementById('search').addEventListener('input', (e) => { state.q = e.target.value; render(); });
    for (const [id, key] of [['f-language', 'workLanguage'], ['sort', 'sort']]) document.getElementById(id).addEventListener('change', (e) => { state[key] = e.target.value; render(); });
    window.addEventListener('popstate', () => { readState(); document.getElementById('search').value = state.q; render(); }); render();
  }).catch((e) => document.getElementById('out').replaceChildren(el('p', { class: 'empty' }, T('작품 목록을 불러오지 못했습니다.') + ' (' + e.message + ')')));
})();
