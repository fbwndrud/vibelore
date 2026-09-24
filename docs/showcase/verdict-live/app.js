/* 판결 LIVE — 장면 웹툰 뷰어 (thundertrail/app.js에서 복제). data.json 하나로 렌더링. 의존성 없음. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode etc. */ } },
  };
  const fmtS = (arr) => arr.length ? arr.map((x) => x + '초').join('+') : '–';

  let DATA = null;
  let state = { ep: 1, scene: 's1', mode: store.get('vl.mode', 'both'), size: store.get('vl.size', 'm'), meta: store.get('vl.meta', '0') === '1' };

  function parseHash() {
    const m = location.hash.match(/#ep(\d)(?:\/(s\d+))?/);
    if (m) { state.ep = +m[1]; state.scene = m[2] || 's1'; }
  }
  function ep() { return DATA.episodes.find((e) => e.chapter === state.ep) || DATA.episodes[0]; }

  /* ---------- header ---------- */
  function renderTabs() {
    const box = $('#eptabs'); box.innerHTML = '';
    for (const e of DATA.episodes) {
      box.append(el('a', { href: `#ep${e.chapter}/s1`, class: 'eptab' + (e.chapter === state.ep ? ' active' : '') }, el('span', null, `${e.chapter}화`), el('small', null, e.host)));
    }
    const act = box.querySelector('.active');
    if (act && box.scrollWidth > box.clientWidth) box.scrollLeft += act.getBoundingClientRect().left - box.getBoundingClientRect().left - (box.clientWidth - act.offsetWidth) / 2;
    for (const b of document.querySelectorAll('.seg button')) b.classList.toggle('active', b.dataset.mode === state.mode);
    for (const b of document.querySelectorAll('.sheet .mtools button')) b.classList.toggle('active', b.dataset.mode === state.mode);
  }
  function renderHead() {
    const e = ep();
    $('#kicker').textContent = `EPISODE ${String(e.chapter).padStart(2, '0')}` + (state.meta ? ` · ${e.host} · ${e.model}` : '');
    $('#eptitle').textContent = e.title;
    if (!state.meta) {
      $('#eplead').textContent = `${e.chapter}화 · 웹툰 ${e.sceneCount}장면. 왼쪽은 웹툰, 오른쪽은 같은 대목의 소설 원문입니다. 위의 보기 방식에서 웹툰만, 소설만 볼 수도 있습니다.`;
      document.title = `${DATA.work} · ${e.chapter}화`;
    } else if (e.regen) $('#eplead').textContent = `${e.sceneCount}장면 ${e.panelTotal}칸. 검토에서 떨어진 장면을 서버가 결함 목록으로 다시 설계해 새로 그리는 자동 재설계(최대 ${e.regen.autoRevisionLimit}회)를 넣고 다시 만든 회차입니다. 검토 통과 ${e.passCount}/${e.sceneCount} (재생성 전 ${e.regen.before.passCount}/${e.regen.before.sceneCount}). 이전 시도의 그림과 판정도 장면마다 그대로 공개합니다.`;
    else $('#eplead').textContent = `${e.sceneCount}장면 ${e.panelTotal}칸. 장면마다 이미지 API 한 번으로 3~12칸을 한 장에 생성했습니다. 왼쪽은 그 첫 결과, 오른쪽은 소설 원문입니다. 검토 통과 ${e.passCount}, 수정 필요 판정 ${e.sceneCount - e.passCount}. 판정과 관계없이 자동 재생성 없이 그대로 공개합니다.`;
    $('#chip-novel').textContent = `${e.novelHost} · ${e.novelModel}`;
    $('#chip-adapt').textContent = `${e.host} · ${e.model} · ${e.effort}`;
    $('#chip-image').textContent = `Codex · OpenAI API · ${DATA.imageModel}`;
    const rv = e.reviewer || DATA.reviewer;
    $('#chip-review').textContent = `${rv.host} (${rv.model}) · 독립 평가 아님`;
    if (state.meta) document.title = `${DATA.work} · ${e.chapter}화 ${e.host}`;
  }
  function applyMeta() {
    document.body.classList.toggle('meta-on', state.meta);
    for (const b of document.querySelectorAll('.metatog')) { b.setAttribute('aria-pressed', String(state.meta)); b.textContent = state.meta ? '제작 정보 끄기' : '제작 정보 보기'; }
    store.set('vl.meta', state.meta ? '1' : '0');
  }

  /* ---------- reader ---------- */
  function sceneMeta(s) {
    const t = s.timings;
    return `원문 p${s.pFrom}–${s.pTo} · ${s.panelCount}칸 · 이미지 API ${t.imageCalls}회${t.imageCalls > 1 ? '(재시도 포함)' : ''}${t.imageS ? ' · ' + t.imageS + '초' : ''}${s.imageUsd ? ' · $' + s.imageUsd.toFixed(2) : ''} · 각색 ${fmtS(t.planS)} · 사전 검증 ${fmtS(t.preflightS)}`;
  }
  function findingsBlock(s) {
    const regen = !!ep().regen;
    const head = el('div', { class: 'fhead' + (s.verdict === 'pass' ? ' pass' : '') },
      el('b', null, `가감 없이 · 장면 ${s.n} 검토`),
      el('span', null, regen
        ? (s.attempts.length ? `${s.attempts.length + 1}번째 시도의 결과입니다. 앞 시도의 그림과 판정은 아래에 있습니다. 검토는 오케스트레이션 호스트의 자기검토입니다.` : '첫 시도에 통과했습니다. 검토는 오케스트레이션 호스트의 자기검토입니다.')
        : '자동 재생성 없이 첫 결과와 판정을 그대로 공개합니다. 검토는 오케스트레이션 호스트의 자기검토입니다.'));
    const ul = el('ul');
    for (const f of s.findings) {
      ul.append(el('li', null,
        el('span', { class: 'fl ' + (f.severity === 'blocking' ? 'b' : 'a') }, f.severity === 'blocking' ? '차단' : '참고'),
        el('span', null, f.correction ? el('b', null, '[정정] ') : null, f.ko),
        el('span', { class: 'layer', title: '결함 귀속' }, f.layerLabel)));
    }
    ul.append(el('li', null, el('span', { class: 'fl ok' }, '확인'),
      el('span', null, `한국어 문구 ${s.textsOk}/${s.textsTotal} 정확 렌더링·화자 일치, ${s.review.observedPanelCount}칸, 읽기 순서 정상.`)));
    const det = el('details', null, el('summary', null, '검토 원문(영문) 보기'));
    det.append(el('pre', { style: 'white-space:pre-wrap;font-size:11px;margin:6px 0 0' }, s.findings.map((f) => `[${f.severity}] ${f.en}`).join('\n\n') + '\n\n' + s.review.evidence));
    ul.append(el('li', null, det));
    const box = el('div', { class: 'findings' }, head, ul);
    if (s.attempts && s.attempts.length) box.append(attemptsBlock(s));
    return box;
  }
  function attemptsBlock(s) {
    const det = el('details', { class: 'attempts' }, el('summary', null, `이전 시도 ${s.attempts.length}개 보기 · 자동 재설계 전 그림과 판정`));
    const grid = el('div', { class: 'agrid' });
    for (const a of s.attempts) {
      const ul = el('ul');
      for (const f of a.findings.filter((f) => f.severity === 'blocking')) ul.append(el('li', null, f.correction ? el('b', null, '[정정] ') : null, f.ko));
      const emph = [];
      if (a.emphasis && a.emphasis.focusTextIds) emph.push(`정확히 쓸 문구 ${a.emphasis.focusTextIds.length}개 강조`);
      if (a.emphasis && a.emphasis.corrections) emph.push(...a.emphasis.corrections);
      const fig = el('figure', null,
        el('a', { href: a.image, target: '_blank', rel: 'noopener' }, el('img', { src: a.image, alt: `장면 ${s.n} ${a.n}번째 시도`, loading: 'lazy', width: 1024, height: 1536 })),
        el('figcaption', null, el('b', null, `${a.n}번째 시도 · 수정 필요`), el('span', null, `계획 ${a.plannedPanels}칸 / 그림 ${a.observedPanels}칸 · 문구 ${a.textsOk}/${a.textsTotal} 정확`), ul,
          emph.length ? el('span', { class: 'emph' }, '이 시도에 들어간 강조: ' + emph.join(' · ')) : null));
      grid.append(fig);
    }
    det.append(grid);
    return det;
  }
  function renderScenes() {
    const e = ep();
    const rail = $('#rail'); rail.innerHTML = ''; rail.append(el('span', { class: 'lbl' }, '장면'));
    const col = $('#toon'); col.innerHTML = '';
    for (const s of e.scenes) {
      rail.append(el('a', { href: `#ep${e.chapter}/${s.id}`, class: s.verdict, 'data-scene': s.id, title: s.title }, s.n));
      const badge = el('span', { class: 'badge ' + s.verdict }, s.verdict === 'pass' ? '검토: 통과' : `검토: 수정 필요 ${s.blocking}건`);
      const sec = el('section', { class: 'scene', id: `scene-${s.id}`, 'data-scene': s.id },
        el('div', { class: 'scene-head' },
          el('div', { class: 'scene-title' }, el('b', null, `장면 ${s.n} · ${s.title}`), el('span', null, sceneMeta(s))),
          badge),
        el('img', { src: s.image, alt: `${e.chapter}화 장면 ${s.n} ${s.title}`, loading: s.n > 2 ? 'lazy' : 'eager', width: 1024, height: 1536 }),
        el('div', { class: 'scene-actions' },
          el('button', { onclick: () => openModal('brief', s) }, '실제 영어 프롬프트'),
          el('button', { onclick: () => openModal('plan', s) }, '통합 각색 JSON'),
          el('button', { onclick: () => openModal('review', s) }, '시각 검토 결과'),
          el('a', { href: s.image, target: '_blank', rel: 'noopener' }, '이미지 원본(WebP)')),
        findingsBlock(s));
      col.append(sec);
    }
  }
  function renderProse() {
    const e = ep();
    const box = $('#prose'); box.innerHTML = '';
    let chars = 0;
    for (const s of e.scenes) {
      box.append(el('div', { class: 'pdiv', id: `pdiv-${s.id}` }, el('span'), el('b', null, `장면 ${s.n} · p${s.pFrom}–${s.pTo}`), el('span')));
      const g = el('div', { class: 'pgroup', 'data-scene': s.id });
      for (const u of s.units) { g.append(el('p', null, u.text)); chars += u.text.length; }
      box.append(g);
    }
    $('#prose-label').textContent = `소설 원문 · 정본 ${e.chapter}화 · ${chars.toLocaleString('ko-KR')}자`;
  }
  function applyMode() {
    const r = $('#reader');
    r.classList.remove('mode-webtoon', 'mode-both', 'mode-novel');
    r.classList.add('mode-' + state.mode);
    store.set('vl.mode', state.mode);
    renderTabs();
  }
  function applySize() {
    const map = { s: ['15px', '1.9'], m: ['17px', '1.95'], l: ['20px', '2'] };
    const [fs, lh] = map[state.size] || map.m;
    document.documentElement.style.setProperty('--prose-size', fs);
    document.documentElement.style.setProperty('--prose-lh', lh);
    for (const b of document.querySelectorAll('.sizes button')) b.classList.toggle('active', b.dataset.size === state.size);
    store.set('vl.size', state.size);
  }

  /* ---------- current scene sync ---------- */
  let observer = null;
  function setCurrent(sid, opts) {
    if (state.scene === sid && !(opts && opts.force)) return;
    state.scene = sid;
    for (const a of document.querySelectorAll('#rail a')) a.classList.toggle('current', a.dataset.scene === sid);
    for (const g of document.querySelectorAll('.pgroup')) g.classList.toggle('current', g.dataset.scene === sid);
    const e = ep(); const s = e.scenes.find((x) => x.id === sid);
    if (state.mode === 'both') {
      const d = $(`#pdiv-${sid}`); const p = $('#prose');
      if (d && p) p.scrollTo({ top: d.offsetTop - p.offsetTop - 8, behavior: 'smooth' });
    }
    if (s) renderSheet(s);
    if (history.replaceState) history.replaceState(null, '', `#ep${e.chapter}/${sid}`);
  }
  function observe() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver((entries) => {
      const vis = entries.filter((x) => x.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (vis.length) setCurrent(vis[0].target.dataset.scene);
    }, { rootMargin: '-35% 0px -45% 0px', threshold: [0, 0.2, 0.5, 0.8] });
    for (const s of document.querySelectorAll('.scene')) observer.observe(s);
  }

  /* ---------- mobile sheet ---------- */
  function renderSheet(s) {
    $('#sheet-label').textContent = `원문 보기 · 장면 ${s.n} · p${s.pFrom}–${s.pTo}`;
    const b = $('#sheet-body'); b.innerHTML = '';
    for (const u of s.units) b.append(el('p', null, u.text));
  }

  /* ---------- modal ---------- */
  function openModal(kind, s) {
    const e = ep(); const dlg = $('#modal'); const body = $('#modal-body'); body.innerHTML = '';
    const title = { brief: '실제 영어 프롬프트 (renderBrief)', plan: '통합 각색 JSON (scene plan)', review: '시각 검토 결과 (image review)' }[kind];
    $('#modal-title').textContent = `${e.chapter}화 장면 ${s.n} · ${title}`;
    if (kind === 'brief') {
      body.append(el('p', null, `이미지 API에 보낸 장면 지시입니다. 각색 호스트(${e.host} · ${e.model})가 영어로 작성했고, 칸별 순간(moment) 수가 곧 칸 수(${s.panelCount})입니다. 한국어 문구는 원문 그대로 이미지 안에 렌더링하도록 지시합니다.`));
      body.append(el('h4', null, 'STYLE'), el('p', null, s.brief.style));
      const ol = el('ol');
      for (const m of s.brief.moments) ol.append(el('li', null, m.action, m.textIds && m.textIds.length ? el('span', { style: 'color:var(--muted)' }, ` [${m.textIds.join(', ')}]`) : null));
      body.append(el('h4', null, 'MOMENTS'), ol);
      body.append(el('h4', null, 'TEXTS (verbatim Korean lettering)'), (() => { const ul = el('ul'); for (const t of s.plan.texts) ul.append(el('li', null, `${t.id} · ${t.speaker} · ${t.kind} — ${t.text}`)); return ul; })());
    } else if (kind === 'plan') {
      body.append(el('p', null, `각색 호스트가 원문 단락(p${s.pFrom}–${s.pTo})에서 뽑은 사실·비트·불확실성. 원문에 없는 것은 그리지 않도록 uncertainties에 명시합니다.`));
      body.append(el('pre', null, JSON.stringify(s.plan, null, 2)));
    } else {
      const rv = ep().reviewer || DATA.reviewer;
      body.append(el('p', null, `오케스트레이션 호스트(${rv.host}, ${rv.model})가 실제 이미지를 열어 작성한 검토입니다. 독립 평가가 아닙니다.`));
      const c = s.review.continuity;
      if (c) {
        body.append(el('h4', null, '연속성 (이전 장면 이미지와 대조)'));
        const kv = el('div', { class: 'kv' });
        for (const k of ['identity', 'setting', 'actionTransition']) if (c[k]) kv.append(el('b', null, `${k} · ${c[k].passed ? '통과' : '실패'}`), el('span', null, c[k].evidence));
        body.append(kv);
      }
      body.append(el('h4', null, '문구 관측'));
      const tb = el('table'); tb.append(el('tr', null, el('th', null, 'id'), el('th', null, '관측 문구'), el('th', null, '판독'), el('th', null, '화자'), el('th', null, '근거')));
      for (const t of s.review.textObservations) tb.append(el('tr', null, el('td', null, t.id), el('td', null, t.observedText), el('td', null, t.readable ? '○' : '×'), el('td', null, t.speakerCorrect ? '○' : '×'), el('td', null, t.evidence)));
      body.append(tb);
      body.append(el('h4', null, '판정 근거'), el('p', null, s.review.evidence));
      body.append(el('h4', null, 'findings'));
      const ul = el('ul'); for (const f of s.findings) ul.append(el('li', null, el('b', null, `[${f.severity} · ${f.layerLabel}] `), f.ko, el('br'), el('span', { style: 'color:var(--muted);font-size:12px' }, f.en))); body.append(ul);
    }
    dlg.showModal();
  }

  /* ---------- boot ---------- */
  function renderAll() {
    applyMeta(); renderTabs(); renderHead(); renderScenes(); renderProse(); applyMode(); applySize(); observe();
    const s = ep().scenes.find((x) => x.id === state.scene) || ep().scenes[0];
    setCurrent(s.id, { force: true });
    const target = $(`#scene-${s.id}`);
    if (target && s.id !== 's1') setTimeout(() => target.scrollIntoView({ block: 'start' }), 50);
  }
  function onHash() {
    const prev = state.ep; parseHash();
    if (prev !== state.ep) { renderAll(); window.scrollTo({ top: 0 }); return; }
    const t = $(`#scene-${state.scene}`); if (t) { t.scrollIntoView({ block: 'start', behavior: 'smooth' }); setCurrent(state.scene, { force: true }); }
  }
  fetch('data.json').then((r) => r.json()).then((d) => {
    DATA = d; parseHash(); renderAll();
    $('#built').textContent = d.builtAt.slice(0, 10);
    window.addEventListener('hashchange', onHash);
    for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => { state.mode = b.dataset.mode; applyMode(); });
    for (const b of document.querySelectorAll('.metatog')) b.addEventListener('click', () => { state.meta = !state.meta; applyMeta(); renderHead(); });
    for (const b of document.querySelectorAll('[data-size]')) b.addEventListener('click', () => { state.size = b.dataset.size; applySize(); });
    $('#modal-close').addEventListener('click', () => $('#modal').close());
    $('#modal').addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });
    $('#sheet-toggle').addEventListener('click', () => { const sh = $('#sheet'); sh.classList.toggle('open'); $('#sheet-toggle').textContent = sh.classList.contains('open') ? '접기' : '위로 펼치기'; });
  }).catch((err) => { $('#toon').textContent = 'data.json을 불러오지 못했습니다: ' + err; });
})();
