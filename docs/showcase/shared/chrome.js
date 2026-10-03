/* 목록·버전 연혁·만드는 방식 공통: 머리글, 바닥글, works.json 읽기.
 * <body data-page="works|versions|how" data-sub="system|novel|webtoon" data-root="../"> 로 쓴다.
 * data-root는 쇼케이스 루트(works.json이 있는 곳)까지의 상대 경로다. 문구는 한국어로 쓰고 I18N.apply가 바꾼다.
 */
(function () {
  'use strict';
  const body = document.body;
  const root = body.dataset.root || '';
  const page = body.dataset.page;
  const sub = body.dataset.sub;

  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'style') n.style.cssText = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };

  const NAV = page === 'works' ? [['works', '서가', ''], ['how', '만드는 방식', 'how/']] : [
    ['works', '작품', ''],
    ['novel', '소설', '?format=novel'],
    ['webtoon', '웹툰', '?format=webtoon'],
    ['how', '만드는 방식', 'how/'],
  ];
  const SUB = [['system', '전체 구성', 'how/'], ['novel', '소설 한 화', 'how/novel.html'], ['webtoon', '웹툰 한 장면', 'how/webtoon.html']];
  const href = (p) => root + p || './';

  const top = document.getElementById('top');
  if (top) {
    top.className = 'top';
    const langSlot = el('span');
    top.append(
      el('div', { class: 'left' },
        el('a', { class: 'brand', href: href('') }, page === 'works' ? 'VIBELORE / LIBRARY' : 'VIBELORE SHOWCASE'),
        el('nav', { class: 'nav', 'aria-label': '쇼케이스 메뉴' }, NAV.map(([id, label, p]) => el('a', { href: href(p), 'data-nav': id, 'aria-current': id === page ? 'page' : null }, label)),
          el('details', { class: 'nav-production' }, el('summary', null, '제작 정보'), el('div', { class: 'nav-production-menu' }, el('a', { href: href('versions.html') }, '버전 연혁'), el('a', { href: href('thundertrail/compare.html') }, '모델 비교'))))),
      el('div', { class: 'right' }, el('a', { href: 'https://github.com/fbwndrud/vibelore' }, 'vibelore GitHub'), langSlot));
    if (page === 'how') {
      top.after(el('nav', { class: 'sub-nav', 'aria-label': '만드는 방식 쪽' }, SUB.map(([id, label, p]) => el('a', { href: href(p), 'aria-current': id === sub ? 'page' : null }, label))));
    }
    langSlot.id = 'site-language';
    if (window.I18N) langSlot.append(I18N.toggle());
  }

  function cmpVer(a, b) {
    const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
    return 0;
  }
  let catalog = null;
  function loadCatalog() {
    if (!catalog) catalog = Promise.all(['works.json', 'browse.json'].map((file) => fetch(root + file).then((r) => { if (!r.ok) throw new Error(file + ' ' + r.status); return r.json(); })))
      .then(([data, browse]) => ({ ...data, works: data.works.map((w) => ({ ...w, reading: browse.works[w.id] })) }));
    return catalog;
  }
  // 가장 늦은 버전으로 끝난 작품이 최신작. 같으면 목록 순서가 앞선 것.
  function latestWork(works) {
    return works.reduce((best, w) => (!best || cmpVer(w.version.to, best.version.to) > 0 ? w : best), null);
  }

  window.Showcase = { el, root, cmpVer, loadCatalog, latestWork, T: (s, v) => (window.T ? window.T(s, v) : s) };
  if (window.I18N) I18N.apply(body);
})();
