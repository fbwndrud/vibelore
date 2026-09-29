/* 작품 페이지 공통 틀(디자인 캔버스 ③). shared/chrome.js 다음에 싣는다.
 * <body data-page="works" data-root="../" data-work="vesper" data-tab="overview|notes|data|<추가 탭 id>"> 와 <section id="work-band"></section>.
 * works.json(작품 정보·탭)과 facts.json(제작 정보 8칸, scripts/build-showcase-facts.py)으로 테마 띠와 탭을 그린다.
 * 탭: 개요 · 읽기 · 제작 노트 · 비용·데이터가 모든 작품에 같고, 인물·설정(lore)과 works.json의 tabs가 뒤에 붙는다.
 * WorkPage.overview({ devices })는 개요 본문(회차·아크·연출 실험·제작 정보), WorkPage.data({ files, costLink })는 비용·데이터 본문을 채운다. */
(function () {
  'use strict';
  const { el, root, loadCatalog } = window.Showcase;
  const T = (s, v) => (window.T ? window.T(s, v) : s);
  const body = document.body;
  const id = body.dataset.work;
  const tab = body.dataset.tab;
  const EN = !!(window.I18N && I18N.lang === 'en');
  const $ = (s) => document.querySelector(s);
  const num = (n) => (window.I18N ? I18N.num(n) : n.toLocaleString('ko-KR'));

  const FACTS = [['vibelore', 'vibelore'], ['novel', '설계·집필'], ['adapt', '웹툰 각색'], ['image', '이미지'], ['review', '그림 검토'], ['size', '분량'], ['cost', '비용'], ['time', '소요 시간']];
  // 스크립트가 만든 문구는 {ko, en} 두 벌이다. 두 벌이 같으면(버전 설명 등) i18n 사전으로 옮긴다.
  const txt = (x) => (!x ? '' : EN ? (x.en !== x.ko ? x.en : T(x.ko)) : x.ko);
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } } };

  function tabs(w) {
    const p = w.pages || {};
    const list = [['overview', '개요', './'], ['read', '읽기', 'read.html'], ['notes', '제작 노트', p.notes || 'notes.html'], ['data', '비용·데이터', 'data.html']];
    const extra = [];
    if (w.lore) extra.push(['lore', '인물·설정', `${root}lore.html?work=${w.id}`]);
    for (const [k, label, href] of w.tabs || []) extra.push([k, label, href]);
    return [list, extra];
  }
  function lastRead(w) {
    const h = store.get('reader.last.' + w.id);
    const m = h && h.match(/^#ep(\d+)(?:\/s(\d+))?$/);
    if (!m) return null;
    return { href: 'read.html' + h, label: m[2] ? T('이어 읽기 · {ch}화 장면 {n}', { ch: m[1], n: m[2] }) : T('이어 읽기 · {ch}화', { ch: m[1] }) };
  }

  function band(w, works) {
    const box = document.getElementById('work-band'); if (!box) return;
    box.className = 'wband';
    box.style.setProperty('--wb', w.bg || w.tone);
    const i = works.findIndex((x) => x.id === w.id);
    const older = works[i + 1]; const newer = works[i - 1];
    const link = (x, label, after) => el('a', { href: root + x.href }, after ? null : '← ', el('span', null, label), ' · ', EN && x.gloss ? x.gloss : el('span', { lang: 'ko' }, x.title), after ? ' →' : null);
    const cont = lastRead(w);
    const [main, extra] = tabs(w);
    const tabLink = ([k, label, href]) => el('a', { href, 'aria-current': k === tab ? 'page' : null }, label);
    box.replaceChildren(
      el('div', { class: 'wrap wband-top' },
        el('nav', { 'aria-label': '이동 경로' }, el('a', { href: root || './' }, '작품'), el('span', null, '/'), el('span', { class: 'here', lang: 'ko' }, w.title)),
        el('nav', { 'aria-label': '다른 작품' },
          older ? link(older, '이전 작품') : el('span', { class: 'none' }, '이전 작품 없음'),
          newer ? link(newer, '다음 작품', true) : el('span', { class: 'none' }, '다음 작품 없음'))),
      el('div', { class: 'wrap wband-hero' },
        el('a', { class: 'cover', href: 'read.html', 'aria-label': '1화부터 읽기' }, el('img', { src: root + (w.thumb || w.cover), alt: w.alt })),
        el('div', { class: 'info' },
          el('span', { class: 'genre' }, w.genre),
          el('h1', { lang: 'ko' }, w.title),
          w.gloss ? el('span', { class: 'gl en-only' }, w.gloss) : null,
          w.sub ? el('span', { class: 'gl ko-only' }, w.sub) : null,
          el('p', null, w.blurb),
          el('div', { class: 'ctas' },
            el('a', { class: 'btn primary', href: 'read.html' }, '1화부터 읽기'),
            cont ? el('a', { class: 'btn ghost', href: cont.href }, cont.label) : null))),
      el('nav', { class: 'wrap wtabs', 'aria-label': '작품 쪽' }, main.map(tabLink), extra.length ? el('span', { class: 'sep', 'aria-hidden': 'true' }) : null, extra.map(tabLink)));
    document.title = `${EN && w.gloss ? w.gloss : w.title} · ${T({ overview: '개요', notes: '제작 노트', data: '비용·데이터' }[tab] || document.title.split(' · ').pop())}`;
    if (window.I18N) I18N.apply(box);
  }

  function factsBox(f, more) {
    const dl = el('dl');
    for (const [k, label] of FACTS) {
      const x = f && f[k];
      const none = !x || x.v.ko === '기록 없음';
      dl.append(el('div', { class: 'row' }, el('dt', null, label),
        el('dd', { class: none ? 'none' : null }, x ? txt(x.v) : T('기록 없음'), x && x.note ? el('small', null, txt(x.note)) : null)));
    }
    return el('aside', { class: 'wp-facts' },
      el('div', { class: 'hd' }, el('h2', null, '제작 정보'), el('span', null, '모든 작품 같은 항목')), dl,
      more ? el('a', { class: 'more', href: 'data.html#compare' }, '이 정보를 다른 작품과 나란히 보기 →') : null);
  }

  const ready = Promise.all([loadCatalog(), fetch(root + 'facts.json').then((r) => r.json()).catch(() => ({}))]).then(([cat, facts]) => {
    const w = cat.works.find((x) => x.id === id);
    band(w, cat.works);
    return { w, works: cat.works, facts };
  });

  /* 개요: 회차 카드, 아크, 연출 실험, 제작 정보 */
  function overview(opt) {
    opt = opt || {};
    return Promise.all([ready, fetch('data.json').then((r) => r.json())]).then(([{ w, facts }, d]) => {
      const eps = d.episodes;
      const hosts = new Set(eps.map((e) => e.host + e.model));
      const epBox = $('#wp-episodes');
      for (const e of eps) {
        epBox.append(el('a', { class: 'wp-ep', href: `read.html#ep${e.chapter}/s1` },
          el('b', null, T('{n}화 · 웹툰 + 소설', { n: e.chapter })),
          el('span', null, T('{s}장면 · {p}칸', { s: e.sceneCount, p: e.panelTotal }) + (e.device ? ' · ' + T('연출 실험') : '')),
          hosts.size > 1 ? el('small', null, `${e.host} · ${e.model}`) : null));
      }
      if (d.chapters && d.chapters.length > eps.length) {
        const rest = d.chapters.filter((c) => !eps.some((e) => e.chapter === c.chapter));
        epBox.append(el('a', { class: 'wp-ep', href: `read.html#ep${rest[0].chapter}` },
          el('b', null, T('{a}~{b}화 · 소설', { a: rest[0].chapter, b: rest[rest.length - 1].chapter })),
          el('span', null, T('{n}화 · {c}자', { n: rest.length, c: num(rest.reduce((a, c) => a + c.chars, 0)) }))));
      }
      if (d.arcs && d.arcs.length) {
        const box = el('div', { class: 'wp-arcs' });
        for (const a of d.arcs) box.append(el('a', { href: `read.html#ep${a.start}` }, el('span', { class: 'n' }, T('아크 {n}', { n: a.n })), el('span', { lang: 'ko' }, a.title), el('span', { class: 'r' }, T('{a}~{b}화', { a: a.start, b: a.end }))));
        epBox.after(box);
      }
      const devs = eps.filter((e) => e.device);
      if (devs.length) {
        const box = $('#wp-devices'); box.closest('section').hidden = false;
        for (const e of devs) {
          const sid = (opt.devices || {})[e.chapter] || 's1';
          const s = e.scenes.find((x) => x.id === sid) || e.scenes[0];
          box.append(el('a', { class: 'wp-dev', href: `read.html#ep${e.chapter}/${s.id}` },
            el('img', { src: s.image, alt: T('{ch}화 장면 {n}', { ch: e.chapter, n: s.n }), loading: 'lazy' }),
            el('div', null, el('span', { class: 'k' }, T('{n}화', { n: e.chapter })), el('b', null, T(e.device.title)), el('span', null, T(e.device.hint || e.device.summary)))));
        }
      }
      $('#wp-facts').replaceWith(factsBox(facts[w.id], true));
      if (window.I18N) I18N.apply($('.wp-grid'));
    });
  }

  /* 비용·데이터: 제작 정보 전체, 다른 작품과 나란히, 자세한 비용, 데이터 파일 */
  function data(opt) {
    opt = opt || {};
    return ready.then(({ w, works, facts }) => {
      $('#wp-facts').replaceWith(factsBox(facts[w.id], false));
      const cols = works.filter((x) => facts[x.id]);
      const table = el('table',
        null,
        el('thead', null, el('tr', null, el('th'), cols.map((x) => el('th', { class: x.id === w.id ? 'me' : null }, el('a', { href: root + x.href + 'data.html', lang: 'ko' }, x.title))))),
        el('tbody', null, FACTS.map(([k, label]) => el('tr', null, el('th', null, label), cols.map((x) => {
          const f = facts[x.id][k];
          return el('td', { class: x.id === w.id ? 'me' : null }, txt(f.v), f.note ? el('small', null, txt(f.note)) : null);
        })))));
      $('#compare').append(el('div', { class: 'wp-cmp' }, table));
      if (opt.costLink) $('#cost-link').append(el('a', { class: 'wp-go', href: opt.costLink[0] }, opt.costLink[1]));
      const ul = $('#files');
      for (const [path, what] of opt.files || []) ul.append(el('li', null, el('a', { href: path }, el('code', null, path.replace(/^\.\.\//, 'showcase/'))), el('span', null, what)));
      if (window.I18N) I18N.apply($('.wp-data'));
    });
  }

  window.WorkPage = { ready, overview, data };
})();
