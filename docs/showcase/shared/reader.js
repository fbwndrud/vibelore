/* 작품 공통 리더 — <작품>/read.html에서 Reader.start({ store, imageHost })로 연다. 데이터 형식은 README의 "리더 데이터(data.json)" 절.
   두 형태를 한 코드로 그린다.
   - 소설 목록이 있는 작품(data.chapters): 회차 선택 + novel/NNN.txt 본문, 웹툰이 있는 화만 웹툰·나란히 보기
   - 웹툰 회차만 있는 작품(data.episodes): 회차 탭 + 장면별 원문 단락(units)
   재설계 이력(attempts)·후반 식자(lettering)·연출 실험(device)·서버 판정 표시(derived)는 데이터에 있을 때만 나온다. 의존성 없음. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode etc. */ } },
  };
  const T = window.T || ((s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m)) : s));
  const EN = !!(window.I18N && I18N.lang === 'en');
  const LANG = EN ? 'en' : 'ko';
  // 영어 UI에서는 검토 원문(영어)을, 한국어 UI에서는 한국어 번역을 보여 준다
  const fx = (f) => (EN && f.en ? f.en : f.ko);
  const fmtS = (arr) => arr && arr.length ? arr.map((x) => T('{n}초', { n: x })).join('+') : '–';
  const num = (n) => (window.I18N ? I18N.num(n) : n.toLocaleString('ko-KR'));
  const pad = (n) => String(n).padStart(3, '0');

  let DATA = null; let OPT = {}; let KEY = 'vl';
  const TEXT = {};
  const state = { ch: 1, scene: 's1', mode: 'both', size: 'm', meta: false };

  const novelList = () => !!(DATA.chapters && DATA.chapters.length);
  const chapters = () => (novelList() ? DATA.chapters : DATA.episodes);
  const chap = () => chapters().find((c) => c.chapter === state.ch) || chapters()[0];
  const toon = () => DATA.episodes.find((e) => e.chapter === state.ch) || null;
  const arcOf = (n) => (DATA.arcs || []).find((a) => n >= a.start && n <= a.end);
  const reviewer = (e) => (e && e.reviewer) || DATA.reviewer;
  const novelVersion = (n) => (DATA.vibelore && DATA.vibelore.novel || []).find((x) => n >= x.from && n <= x.to);

  function parseHash() {
    const m = location.hash.match(/#ep(\d+)(?:\/(s\d+))?/);
    if (!m) return;
    const n = +m[1];
    state.ch = chapters().some((c) => c.chapter === n) ? n : chapters()[0].chapter;
    state.scene = m[2] || 's1';
  }
  function loadText(n) {
    if (TEXT[n]) return Promise.resolve(TEXT[n]);
    return fetch(`novel/${pad(n)}.txt`).then((r) => r.text()).then((t) => (TEXT[n] = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)));
  }

  /* ---------- header ---------- */
  function renderPicker() {
    const box = $('#eptabs'); box.innerHTML = '';
    if (novelList()) {
      const sel = el('select', { class: 'chsel', 'aria-label': T('회차 선택') });
      const groups = DATA.arcs && DATA.arcs.length ? DATA.arcs : [{ start: 1, end: Infinity }];
      for (const a of groups) {
        const g = a.title ? el('optgroup', { label: T('{n}아크 · {title}', { n: a.n, title: a.title }) }) : sel;
        for (const c of DATA.chapters.filter((c) => c.chapter >= a.start && c.chapter <= a.end)) {
          const hasToon = DATA.episodes.some((e) => e.chapter === c.chapter);
          g.append(el('option', { value: c.chapter, selected: c.chapter === state.ch ? 'selected' : null }, `${T('{n}화', { n: c.chapter })} · ${c.title}${hasToon ? ' · ' + T('웹툰') : ''}`));
        }
        if (g !== sel) sel.append(g);
      }
      sel.addEventListener('change', () => { location.hash = `#ep${sel.value}`; });
      box.append(sel);
      for (const e of DATA.episodes) box.append(el('a', { href: `#ep${e.chapter}/s1`, class: 'eptab' + (state.ch === e.chapter ? ' active' : '') }, el('span', null, T('{n}화 웹툰', { n: e.chapter }))));
      return;
    }
    for (const e of DATA.episodes) {
      box.append(el('a', { href: `#ep${e.chapter}/s1`, class: 'eptab' + (e.chapter === state.ch ? ' active' : '') }, el('span', null, T('{n}화', { n: e.chapter })), el('small', null, e.host)));
    }
    const act = box.querySelector('.active');
    if (act && box.scrollWidth > box.clientWidth) box.scrollLeft += act.getBoundingClientRect().left - box.getBoundingClientRect().left - (box.clientWidth - act.offsetWidth) / 2;
  }
  function leadText(c, e) {
    const a = arcOf(c.chapter);
    const arcLine = a ? T('{n}아크 『{title}』', { n: a.n, title: a.title }) : '';
    if (!e) return `${arcLine} · ${T('{n}자', { n: num(c.chars) })}. ` + T('웹툰은 {list}화만 만들었습니다. 이 화는 소설로 읽습니다.', { list: DATA.episodes.map((x) => x.chapter).join('·') });
    if (!state.meta) {
      return novelList()
        ? `${arcLine}. ` + T('웹툰 {n}장면. 왼쪽은 웹툰, 오른쪽은 같은 대목의 소설 원문입니다. 위의 보기 방식에서 웹툰만, 소설만 볼 수도 있습니다.', { n: e.sceneCount })
        : T('{ch}화 · 웹툰 {n}장면. 왼쪽은 웹툰, 오른쪽은 같은 대목의 소설 원문입니다. 위의 보기 방식에서 웹툰만, 소설만 볼 수도 있습니다.', { ch: e.chapter, n: e.sceneCount });
    }
    if (e.regen && e.regen.before) return T('{scenes}장면 {panels}칸. 검토에서 떨어진 장면을 서버가 결함 목록으로 다시 설계해 새로 그리는 자동 재설계(최대 {limit}회)를 넣고 다시 만든 회차입니다. 검토 통과 {pass}/{scenes} (재생성 전 {bpass}/{bscenes}). 이전 시도의 그림과 판정도 장면마다 그대로 공개합니다.', { scenes: e.sceneCount, panels: e.panelTotal, limit: e.regen.autoRevisionLimit, pass: e.passCount, bpass: e.regen.before.passCount, bscenes: e.regen.before.sceneCount });
    if (e.regen) {
      const lettered = e.scenes.filter((s) => s.lettering).length;
      return T('{scenes}장면 {panels}칸. 검토에서 떨어진 장면은 서버가 결함 목록으로 다시 설계해 새로 그렸습니다(자동 재설계 최대 {limit}회). 검토 통과 {pass}/{scenes}.', { scenes: e.sceneCount, panels: e.panelTotal, limit: e.regen.autoRevisionLimit, pass: e.passCount })
        + (lettered ? ' ' + T('끝내 통과하지 못한 장면 {n}개는 틀린 글자만 후반 식자로 고쳐 싣고, 식자 전 원본과 서버 판정을 함께 공개합니다.', { n: lettered }) : '');
    }
    return T('{scenes}장면 {panels}칸. 장면마다 이미지 API 한 번으로 3~12칸을 한 장에 생성했습니다. 왼쪽은 그 첫 결과, 오른쪽은 소설 원문입니다. 검토 통과 {pass}, 수정 필요 판정 {fail}. 판정과 관계없이 자동 재생성 없이 그대로 공개합니다.', { scenes: e.sceneCount, panels: e.panelTotal, pass: e.passCount, fail: e.sceneCount - e.passCount });
  }
  function renderHead() {
    const c = chap(); const e = toon(); const v = novelVersion(c.chapter);
    const first = DATA.episodes[0] || {};
    const novelHost = (e || first).novelHost; const novelModel = (e || first).novelModel;
    const vb = DATA.vibelore;
    let kicker = `EPISODE ${String(c.chapter).padStart(2, '0')}` + (novelList() ? ` / ${DATA.chapters.length}` : '');
    if (state.meta) kicker += novelList() && vb ? ` · vibelore ${v ? v.packageVersion + ' @ ' + v.commit : vb.label} · ${novelModel}` : e ? ` · ${e.host} · ${e.model}` : '';
    $('#kicker').textContent = kicker;
    $('#eptitle').textContent = c.title;
    $('#eplead').textContent = leadText(c, e);
    const hint = $('#ephint');
    if (hint) { if (e && e.device && e.device.hint) { hint.hidden = false; hint.textContent = T(e.device.hint); } else hint.hidden = true; }
    const dv = $('#epdevice');
    if (dv) { if (e && e.device) { dv.hidden = false; dv.innerHTML = ''; dv.append(el('b', null, T('연출 실험 · ') + T(e.device.title)), el('span', null, T(e.device.summary))); } else dv.hidden = true; }
    document.title = `${DATA.work} · ${T('{n}화', { n: c.chapter })}` + (state.meta && e && !novelList() ? ` ${e.host}` : '');
    document.body.classList.toggle('novel-only', !e);
    $('#chip-novel').textContent = `${novelHost} · ${novelModel}` + (vb ? ` · vibelore ${v ? v.packageVersion : vb.label}` : '');
    if (e) {
      $('#chip-adapt').textContent = `${e.host} · ${e.model} · ${e.effort}` + (vb && vb.webtoon ? ` · vibelore ${vb.webtoon.packageVersion}` : '');
      $('#chip-image').textContent = `${T(DATA.imageHost || OPT.imageHost || 'OpenAI API')} · ${DATA.imageModel}`;
      const rv = reviewer(e);
      $('#chip-review').textContent = T('{host} ({model}) · 독립 평가 아님', { host: rv.host, model: rv.model });
    }
  }
  function applyMeta() {
    document.body.classList.toggle('meta-on', state.meta);
    for (const b of document.querySelectorAll('.metatog')) { b.setAttribute('aria-pressed', String(state.meta)); b.textContent = state.meta ? T('제작 정보 끄기') : T('제작 정보 보기'); }
    store.set(KEY + '.meta', state.meta ? '1' : '0');
  }

  /* ---------- webtoon ---------- */
  function sceneMeta(s) {
    const t = s.timings;
    return T('원문 p{a}–{b}', { a: s.pFrom, b: s.pTo }) + ' · ' + T('{n}칸', { n: s.panelCount }) + ' · ' + T('이미지 API {n}회', { n: t.imageCalls }) + (t.imageCalls > 1 && !s.attemptTotal ? T('(재시도 포함)') : '')
      + (t.imageS ? ' · ' + T('{n}초', { n: t.imageS }) : '') + (s.imageUsd && OPT.sceneCost !== false ? ' · $' + s.imageUsd.toFixed(2) : '') + ' · ' + T('각색') + ' ' + fmtS(t.planS) + ' · ' + T('사전 검증') + ' ' + fmtS(t.preflightS);
  }
  function findingTags(f) {
    return [f.correction ? el('b', null, T('[정정] ')) : null, f.derived ? el('b', null, T('[서버 판정] ')) : null];
  }
  function reviewNote(e, s) {
    if (s.attemptTotal > 1) return T('{n}번의 시도 중 {c}번째 그림을 실었습니다. 다른 시도의 그림과 판정은 아래에 있습니다. 검토는 오케스트레이션 호스트의 자기검토입니다.', { n: s.attemptTotal, c: s.chosenAttempt });
    if (e.regen && s.attempts && s.attempts.length) return T('{n}번째 시도의 결과입니다. 앞 시도의 그림과 판정은 아래에 있습니다. 검토는 오케스트레이션 호스트의 자기검토입니다.', { n: s.attempts.length + 1 });
    if (e.regen) return T('첫 시도에 통과했습니다. 검토는 오케스트레이션 호스트의 자기검토입니다.');
    return T('자동 재생성 없이 첫 결과와 판정을 그대로 공개합니다. 검토는 {model}(오케스트레이션 호스트)가 했으며 독립 평가가 아닙니다.', { model: reviewer(e).model });
  }
  function findingsBlock(e, s) {
    const head = el('div', { class: 'fhead' + (s.verdict === 'pass' ? ' pass' : '') },
      el('b', null, T('가감 없이 · 장면 {n} 검토', { n: s.n })), el('span', null, reviewNote(e, s)));
    const ul = el('ul');
    for (const f of s.findings) {
      ul.append(el('li', null,
        el('span', { class: 'fl ' + (f.severity === 'blocking' ? 'b' : 'a') }, T(f.severity === 'blocking' ? '차단' : '참고')),
        el('span', { lang: LANG }, ...findingTags(f), fx(f)),
        el('span', { class: 'layer', title: T('결함 귀속') }, T(f.layerLabel))));
    }
    ul.append(el('li', null, el('span', { class: 'fl ok' }, T('확인')),
      el('span', null, T(e.scenes.some((x) => x.lettering) ? '식자 전 기준 한국어 문구 {ok}/{total} 정확 렌더링·화자 일치, {panels}칸, 읽기 순서 정상.' : '한국어 문구 {ok}/{total} 정확 렌더링·화자 일치, {panels}칸, 읽기 순서 정상.', { ok: s.textsOk, total: s.textsTotal, panels: s.review.observedPanelCount }))));
    const det = el('details', null, el('summary', null, T('검토 원문(영문) 보기')));
    det.append(el('pre', { lang: 'en', style: 'white-space:pre-wrap;font-size:11px;margin:6px 0 0' }, s.findings.map((f) => `[${f.severity}] ${f.en}`).join('\n\n') + '\n\n' + s.review.evidence));
    ul.append(el('li', null, det));
    if (s.lettering) {
      const lt = el('div', { class: 'lettering' }, el('b', null, T('후반 식자 수정 · ')),
        T('이미지 모델이 글자를 끝내 틀리게 그려서, 그림은 그대로 두고 틀린 글자 영역만 흰 바탕에 원문대로 다시 식자했습니다({font}). vibelore 서버 판정은 “수정 필요”로 남아 있습니다.', { font: s.lettering.font }));
      const fl = el('ul', { style: 'margin:6px 0 0;padding-left:18px' });
      for (const f of s.lettering.fixes) fl.append(el('li', { lang: 'ko' }, `${f.textId}: ${f.observed} → ${f.fixed}`));
      lt.append(fl, el('a', { href: s.lettering.raw, target: '_blank', rel: 'noopener' }, T('식자 전 원본 그림 보기')));
      ul.append(el('li', null, lt));
    }
    const box = el('div', { class: 'findings' }, head, ul);
    if (s.attempts && s.attempts.length) box.append(attemptsBlock(s));
    return box;
  }
  function attemptsBlock(s) {
    const det = el('details', { class: 'attempts' }, el('summary', null, s.attemptTotal
      ? T('다른 시도 {n}개 보기 · 자동 재설계 전후 그림과 판정', { n: s.attempts.length })
      : T('이전 시도 {n}개 보기 · 자동 재설계 전 그림과 판정', { n: s.attempts.length })));
    const grid = el('div', { class: 'agrid' });
    for (const a of s.attempts) {
      const ul = el('ul');
      for (const f of a.findings.filter((f) => f.severity === 'blocking')) ul.append(el('li', { lang: LANG }, ...findingTags(f), fx(f)));
      const emph = [];
      if (a.emphasis && a.emphasis.focusTextIds) emph.push(T('정확히 쓸 문구 {n}개 강조', { n: a.emphasis.focusTextIds.length }));
      if (a.emphasis && a.emphasis.corrections) emph.push(...a.emphasis.corrections);
      grid.append(el('figure', null,
        el('a', { href: a.image, target: '_blank', rel: 'noopener' }, el('img', { src: a.image, alt: T('장면 {n} {a}번째 시도', { n: s.n, a: a.n }), loading: 'lazy', width: 1024, height: 1536 })),
        el('figcaption', null, el('b', null, a.after ? T('{n}번째 시도 · 공개본보다 나중 시도, 수정 필요', { n: a.n }) : T('{n}번째 시도 · 수정 필요', { n: a.n })),
          el('span', null, T('계획 {p}칸 / 그림 {o}칸 · 문구 {ok}/{total} 정확', { p: a.plannedPanels, o: a.observedPanels, ok: a.textsOk, total: a.textsTotal })), ul,
          emph.length ? el('span', { class: 'emph' }, T('이 시도에 들어간 강조: '), el('span', { lang: 'en' }, emph.join(' · '))) : null)));
    }
    det.append(grid);
    return det;
  }
  function renderScenes() {
    const e = toon();
    const rail = $('#rail'); rail.innerHTML = '';
    const col = $('#toon'); col.innerHTML = '';
    if (!e) return;
    rail.append(el('span', { class: 'lbl' }, T('장면')));
    for (const s of e.scenes) {
      rail.append(el('a', { href: `#ep${e.chapter}/${s.id}`, class: s.verdict, 'data-scene': s.id, title: s.title }, s.n));
      const badge = el('span', { class: 'badge ' + s.verdict }, s.verdict === 'pass' ? T('검토: 통과') : s.lettering ? T('검토: 수정 필요 · 식자 수정') : T('검토: 수정 필요 {n}건', { n: s.blocking }));
      const g = e.device && e.device.glow && e.device.glow[s.id];
      col.append(el('section', { class: 'scene' + (g ? ' glow' : ''), id: `scene-${s.id}`, 'data-scene': s.id, style: g ? `--g:linear-gradient(to bottom,${g.join(',')})` : null },
        el('div', { class: 'scene-head' },
          el('div', { class: 'scene-title' }, el('b', null, T('장면 {n}', { n: s.n }) + ' · ', el('bdi', { lang: 'ko' }, s.title)), el('span', null, sceneMeta(s))),
          badge),
        el('img', { src: s.image, alt: T('{ch}화 장면 {n} {title}', { ch: e.chapter, n: s.n, title: s.title }), loading: s.n > 2 ? 'lazy' : 'eager', width: 1024, height: 1536 }),
        el('div', { class: 'scene-actions' },
          el('button', { onclick: () => openModal('brief', s) }, T('실제 영어 프롬프트')),
          el('button', { onclick: () => openModal('plan', s) }, T('통합 각색 JSON')),
          el('button', { onclick: () => openModal('review', s) }, T('시각 검토 결과')),
          el('a', { href: s.image, target: '_blank', rel: 'noopener' }, T('이미지 원본(WebP)'))),
        findingsBlock(e, s)));
    }
  }

  /* ---------- prose ---------- */
  function chNav() {
    const n = state.ch; const nav = el('div', { class: 'chnav' });
    nav.append(n > 1 ? el('a', { href: `#ep${n - 1}` }, '← ' + T('{n}화', { n: n - 1 })) : el('span'));
    nav.append(n < DATA.chapters.length ? el('a', { href: `#ep${n + 1}` }, T('{n}화', { n: n + 1 }) + ' →') : el('span', { style: 'color:var(--muted)' }, T('완결')));
    return nav;
  }
  function renderProse() {
    const e = toon(); const c = chap();
    const box = $('#prose'); box.innerHTML = ''; box.dataset.chapter = c.chapter;
    const label = (n) => { $('#prose-label').textContent = T('소설 원문 · 정본 {ch}화 · {n}자', { ch: c.chapter, n: num(n) }); };
    if (e) {
      let chars = 0;
      for (const s of e.scenes) {
        box.append(el('div', { class: 'pdiv', id: `pdiv-${s.id}` }, el('span'), el('b', { lang: LANG }, `${T('장면 {n}', { n: s.n })} · p${s.pFrom}–${s.pTo}`), el('span')));
        const g = el('div', { class: 'pgroup', 'data-scene': s.id });
        for (const u of s.units) { g.append(el('p', null, u.text)); chars += u.text.length; }
        box.append(g);
      }
      // 소설 목록이 있으면 화 전체 글자 수(data.chapters), 없으면 장면 원문 글자 수
      label(novelList() ? c.chars : chars);
      if (novelList()) box.append(chNav());
      return Promise.resolve();
    }
    label(c.chars);
    return loadText(c.chapter).then((paras) => {
      if (state.ch !== c.chapter) return;
      const g = el('div', { class: 'pgroup current' });
      for (const p of paras) g.append(el('p', null, p));
      box.append(g, chNav());
    });
  }
  function applyMode() {
    const r = $('#reader');
    r.classList.remove('mode-webtoon', 'mode-both', 'mode-novel');
    r.classList.add('mode-' + (toon() ? state.mode : 'novel'));
    store.set(KEY + '.mode', state.mode);
    for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('active', b.dataset.mode === state.mode);
  }
  function applySize() {
    const map = { s: ['15px', '1.9'], m: ['17px', '1.95'], l: ['20px', '2'] };
    const [fs, lh] = map[state.size] || map.m;
    document.documentElement.style.setProperty('--prose-size', fs);
    document.documentElement.style.setProperty('--prose-lh', lh);
    for (const b of document.querySelectorAll('.sizes button')) b.classList.toggle('active', b.dataset.size === state.size);
    store.set(KEY + '.size', state.size);
  }

  /* ---------- current scene sync ---------- */
  let observer = null;
  function setCurrent(sid, opts) {
    const e = toon(); if (!e) return;
    if (state.scene === sid && !(opts && opts.force)) return;
    state.scene = sid;
    for (const a of document.querySelectorAll('#rail a')) a.classList.toggle('current', a.dataset.scene === sid);
    for (const g of document.querySelectorAll('.pgroup')) g.classList.toggle('current', g.dataset.scene === sid);
    const s = e.scenes.find((x) => x.id === sid);
    if (state.mode === 'both') {
      const d = $(`#pdiv-${sid}`); const p = $('#prose');
      if (d && p) p.scrollTo({ top: d.offsetTop - p.offsetTop - 8, behavior: 'smooth' });
    }
    if (s) renderSheet(s);
    if (history.replaceState) history.replaceState(null, '', `#ep${e.chapter}/${sid}`);
    remember(`#ep${e.chapter}/${sid}`);
  }
  // 작품 개요의 ‘이어 읽기’ 버튼이 읽는다(shared/workpage.js)
  function remember(h) { if (OPT.work) store.set('reader.last.' + OPT.work, h); }
  function observe() {
    if (observer) observer.disconnect();
    if (!toon()) return;
    observer = new IntersectionObserver((entries) => {
      const vis = entries.filter((x) => x.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (vis.length) setCurrent(vis[0].target.dataset.scene);
    }, { rootMargin: '-35% 0px -45% 0px', threshold: [0, 0.2, 0.5, 0.8] });
    for (const s of document.querySelectorAll('.scene')) observer.observe(s);
  }

  /* ---------- mobile sheet ---------- */
  function renderSheet(s) {
    $('#sheet-label').textContent = `${T('원문 보기')} · ${T('장면 {n}', { n: s.n })} · p${s.pFrom}–${s.pTo}`;
    const b = $('#sheet-body'); b.innerHTML = '';
    for (const u of s.units) b.append(el('p', null, u.text));
  }

  /* ---------- modal ---------- */
  function openModal(kind, s) {
    const e = toon(); const dlg = $('#modal'); const body = $('#modal-body'); body.innerHTML = '';
    const title = T({ brief: '실제 영어 프롬프트 (renderBrief)', plan: '통합 각색 JSON (scene plan)', review: '시각 검토 결과 (image review)' }[kind]);
    $('#modal-title').textContent = `${T('{ch}화 장면 {n}', { ch: e.chapter, n: s.n })} · ${title}`;
    if (kind === 'brief') {
      body.append(el('p', null, T('이미지 API에 보낸 장면 지시입니다. 각색 호스트({host} · {model})가 영어로 작성했고, 칸별 순간(moment) 수가 곧 칸 수({n})입니다. 한국어 문구는 원문 그대로 이미지 안에 렌더링하도록 지시합니다.', { host: e.host, model: e.model, n: s.plannedPanels || s.panelCount })));
      body.append(el('h4', null, 'STYLE'), el('p', { lang: 'en' }, s.brief.style));
      const ol = el('ol', { lang: 'en' });
      for (const m of s.brief.moments) ol.append(el('li', null, m.action, m.textIds && m.textIds.length ? el('span', { style: 'color:var(--muted)' }, ` [${m.textIds.join(', ')}]`) : null));
      body.append(el('h4', null, 'MOMENTS'), ol);
      const ul = el('ul'); for (const t of s.plan.texts) ul.append(el('li', null, `${t.id} · ${t.speaker} · ${t.kind} — ${t.text}`));
      body.append(el('h4', null, 'TEXTS (verbatim Korean lettering)'), ul);
    } else if (kind === 'plan') {
      body.append(el('p', null, T('각색 호스트가 원문 단락(p{a}–{b})에서 뽑은 사실·비트·불확실성. 원문에 없는 것은 그리지 않도록 uncertainties에 명시합니다.', { a: s.pFrom, b: s.pTo })));
      body.append(el('pre', { lang: 'en' }, JSON.stringify(s.plan, null, 2)));
    } else {
      const rv = reviewer(e);
      body.append(el('p', null, T('오케스트레이션 호스트({host}, {model})가 실제 이미지를 열어 작성한 검토입니다. 독립 평가가 아닙니다.', { host: rv.host, model: rv.model })));
      const c = s.review.continuity;
      if (c) {
        body.append(el('h4', null, T('연속성 (이전 장면 이미지와 대조)')));
        const kv = el('div', { class: 'kv' });
        for (const k of ['identity', 'setting', 'actionTransition']) if (c[k]) kv.append(el('b', null, `${k} · ${c[k].passed ? T('통과') : T('실패')}`), el('span', { lang: 'en' }, c[k].evidence));
        body.append(kv);
      }
      body.append(el('h4', null, T('문구 관측')));
      const tb = el('table'); tb.append(el('tr', null, el('th', null, 'id'), el('th', null, T('관측 문구')), el('th', null, T('판독')), el('th', null, T('화자')), el('th', null, T('근거'))));
      for (const t of s.review.textObservations) tb.append(el('tr', null, el('td', null, t.id), el('td', { lang: 'ko' }, t.observedText), el('td', null, t.readable ? '○' : '×'), el('td', null, t.speakerCorrect ? '○' : '×'), el('td', { lang: 'en' }, t.evidence)));
      body.append(tb);
      body.append(el('h4', null, T('판정 근거')), el('p', { lang: 'en' }, s.review.evidence));
      body.append(el('h4', null, 'findings'));
      const ul = el('ul'); for (const f of s.findings) ul.append(el('li', null, el('b', null, `[${f.severity} · ${T(f.layerLabel)}] `), EN ? null : f.ko, EN ? null : el('br'), el('span', { lang: 'en', style: EN ? null : 'color:var(--muted);font-size:12px' }, f.en))); body.append(ul);
    }
    dlg.showModal();
  }

  /* ---------- boot ---------- */
  function renderAll() {
    applyMeta(); renderPicker(); renderHead(); renderScenes(); applyMode(); applySize();
    return renderProse().then(() => {
      const e = toon(); if (!e) { remember(`#ep${state.ch}`); return; }
      const s = e.scenes.find((x) => x.id === state.scene) || e.scenes[0];
      setCurrent(s.id, { force: true });
      const target = $(`#scene-${s.id}`);
      // 딥링크 장면으로 먼저 스크롤한 뒤 관찰을 시작해야 첫 관찰이 s1으로 되돌리지 않는다
      // 해시와 같은 id의 요소가 없어 브라우저가 load 때 맨 위로 되돌리므로 load 뒤에 스크롤한다
      const go = () => { if (target && s.id !== 's1') target.scrollIntoView({ block: 'start', behavior: 'instant' }); setTimeout(observe, 300); };
      if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
    });
  }
  function onHash() {
    const prev = state.ch; parseHash();
    if (prev !== state.ch) { renderAll(); window.scrollTo({ top: 0 }); return; }
    const t = $(`#scene-${state.scene}`); if (t) { t.scrollIntoView({ block: 'start', behavior: 'smooth' }); setCurrent(state.scene, { force: true }); }
  }

  /* opt.store: localStorage 키 앞말(작품마다 보기 방식·글자 크기를 따로 기억)
     opt.imageHost: data.json에 imageHost가 없을 때 이미지 칩에 쓸 이름
     opt.sceneCost: false면 장면 머리에 이미지 비용($)을 쓰지 않는다
     opt.work: 인물·설정 사전 연결용 작품 id(shared/lore.js가 있으면 붙인다) */
  function start(opt) {
    OPT = opt || {}; KEY = OPT.store || OPT.work || 'reader';
    state.mode = store.get(KEY + '.mode', 'both'); state.size = store.get(KEY + '.size', 'm'); state.meta = store.get(KEY + '.meta', '0') === '1';
    fetch('data.json').then((r) => r.json()).then((d) => {
      DATA = d; state.ch = chapters()[0].chapter; parseHash(); renderAll();
      $('#built').textContent = d.builtAt.slice(0, 10);
      window.addEventListener('hashchange', onHash);
      for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => { state.mode = b.dataset.mode; applyMode(); });
      for (const b of document.querySelectorAll('.metatog')) b.addEventListener('click', () => { state.meta = !state.meta; applyMeta(); renderHead(); });
      for (const b of document.querySelectorAll('[data-size]')) b.addEventListener('click', () => { state.size = b.dataset.size; applySize(); });
      $('#modal-close').addEventListener('click', () => $('#modal').close());
      $('#modal').addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });
      $('#sheet-toggle').addEventListener('click', () => { const sh = $('#sheet'); sh.classList.toggle('open'); $('#sheet-toggle').textContent = sh.classList.contains('open') ? T('접기') : T('위로 펼치기'); });
    }).catch((err) => { $('#toon').textContent = T('data.json을 불러오지 못했습니다: ') + err; });
    if (OPT.work && window.Lore) Lore.attachReader({ work: OPT.work, lore: 'lore.json', dict: `../lore.html?work=${OPT.work}` });
  }

  window.Reader = { start };
})();
