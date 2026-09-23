/* 비용·시간. costs.json 으로 렌더링. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const num = (n) => Math.round(n).toLocaleString('ko-KR');
  const tk = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : num(n);
  const usd = (n) => n == null ? '–' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  const dur = (s) => s == null ? '–' : s < 60 ? `${Math.round(s)}초` : s < 3600 ? `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초` : `${Math.floor(s / 3600)}시간 ${Math.round((s % 3600) / 60)}분`;
  const KIND = { real: ['실측', 'k-real'], list: ['정가 환산', 'k-list'], est: ['추정', 'k-est'], none: ['기록 없음', 'k-none'] };
  const kind = (k) => el('span', { class: 'kind ' + KIND[k][1] }, KIND[k][0]);
  const HOST = { openai: 'OpenAI API', codex: 'Codex', claude: 'Claude', grok: 'Grok' };

  let C = null;
  const row = (ch, lane, step = '*') => C.summary.find((r) => r.chapter === ch && r.lane === lane && r.step === step);
  const tot = (r) => r ? r.new + r.cacheRead + r.cacheWrite + r.output : 0;
  const costOf = (r) => !r ? { v: null, k: 'none' } : r.usdKnown === 0 ? { v: null, k: 'none' } : { v: r.usd, k: r.listUsd > 0 ? 'list' : 'real' };
  const ep = (ch) => C.episodes.find((e) => e.chapter === ch) || {};
  const imgs = (ch) => C.images.filter((i) => i.chapter === ch);
  const wall = (ch) => (C.novelWall.find((w) => w.chapter === ch) || {}).sec;
  const hostName = (e, lane) => lane === 'novel' ? `${HOST[(e.novelHost || '').toLowerCase()] || e.novelHost || ''} · ${e.novelModel || ''}` : `${e.host || ''} · ${e.model || ''}`;

  /* ---------- 전제 ---------- */
  function caveats() {
    const n = C.notes; const box = $('#caveats');
    for (const t of [n.orchestrator, n.version, n.novel1, n.codexList, '6·7화(OpenAI Responses API 직접 호출, gpt-6-luna·gpt-6-sol)는 응답에 금액이 없어 호출별 금액은 비워 두었습니다. OpenAI Costs API의 9/23 일 단위 청구액은 두 모델 모두 $0이었고, 토큰은 실측입니다. 사용량 API는 sol 요청을 39건으로 집계했지만 실행 기록은 37건이며, 2건 차이의 원인은 확인하지 못했습니다.'])
      box.append(el('p', null, t));
  }

  /* ---------- 회차별 합계 ---------- */
  function epTable() {
    const t = $('#ep-table');
    t.append(el('tr', { class: 'grp' }, el('th'), el('th', { colspan: 4 }, '소설 쓰기'), el('th', { colspan: 4 }, '웹툰 각색'), el('th', { colspan: 2 }, '이미지'), el('th')));
    t.append(el('tr', null, ['회차', '모델', '토큰', '비용', '시간', '모델', '토큰', '비용', '시간', '비용', '시간', '합계 비용'].map((h) => el('th', null, h))));
    for (const e of C.episodes) {
      const ch = e.chapter; const nv = row(ch, 'novel'); const wt = row(ch, 'webtoon'); const im = imgs(ch);
      let nvCost = costOf(nv); if (!nv && e.cost && e.cost.novelUsd != null) nvCost = { v: e.cost.novelUsd, k: 'est' };
      const wtCost = costOf(wt);
      const imUsd = im.length ? im.reduce((a, i) => a + (i.usd || 0), 0) : null; const imSec = im.reduce((a, i) => a + (i.sec || 0), 0);
      const nvSec = nv && nv.secKnown ? nv.sec : null;
      const parts = [nvCost.v, wt ? wtCost.v : 0, imUsd || 0];
      const partial = parts.some((x) => x == null) || !wt;
      const sum = parts.reduce((a, x) => a + (x || 0), 0);
      t.append(el('tr', null,
        el('td', null, el('b', null, `${ch}화`)),
        el('td', { class: 'l' }, hostName(e, 'novel')),
        el('td', null, nv ? tk(tot(nv)) : '–', nv ? null : el('span', { class: 'sub' }, '기록 없음')),
        el('td', null, usd(nvCost.v), ' ', kind(nvCost.k)),
        el('td', null, nvSec != null ? dur(nvSec) : wall(ch) ? el('span', null, dur(wall(ch)), el('span', { class: 'sub' }, '워크플로 경과')) : '–'),
        el('td', { class: 'l' }, e.webtoonPending ? el('span', { class: 'muted' }, '제작 중') : hostName(e, 'webtoon')),
        el('td', null, wt ? tk(tot(wt)) : '–'),
        el('td', null, wt ? [usd(wtCost.v), ' ', kind(wtCost.k)] : '–'),
        el('td', null, wt && wt.secKnown ? dur(wt.sec) : '–'),
        el('td', null, imUsd != null ? [usd(imUsd), ' ', kind('real')] : '–'),
        el('td', null, im.length ? dur(imSec) : '–'),
        el('td', null, el('b', null, sum > 0 ? usd(sum) : '–'), partial ? el('span', { class: 'sub' }, e.webtoonPending ? '소설만' : '일부 미집계') : null)));
    }
  }

  /* ---------- 토큰 구성 ---------- */
  const SEG = [['cacheRead', '캐시 읽기', 'c-cr'], ['cacheWrite', '캐시 쓰기', 'c-cw'], ['new', '새 입력', 'c-new'], ['output', '출력', 'c-out']];
  function tokChart() {
    const box = $('#tok-chart'); const rows = [];
    for (const e of C.episodes) for (const [lane, lb] of [['novel', '소설'], ['webtoon', '웹툰 각색']]) { const r = row(e.chapter, lane); if (r && r.tokKnown) rows.push([`${e.chapter}화 ${lb}`, lane === 'novel' ? e.novelModel : e.model, r]); }
    const max = Math.max(...rows.map((x) => tot(x[2])));
    const ch = el('div', { class: 'tchart', role: 'img', 'aria-label': '회차별 토큰 구성 막대. 아래 표에 같은 숫자가 있습니다.' });
    const tip = el('div', { class: 'tip hidden' }); document.body.append(tip);
    for (const [lb, model, r] of rows) {
      const bar = el('div', { class: 'tbar2', style: `width:${Math.max(2, (tot(r) / max) * 100)}%` });
      for (const [k, name, cls] of SEG) if (r[k] > 0) {
        const s = el('span', { class: cls, style: `flex:${r[k]}` });
        const show = (ev) => { tip.textContent = ''; tip.append(el('b', null, lb), el('br'), `${name} ${num(r[k])} 토큰 (${Math.round((r[k] / tot(r)) * 100)}%)`, el('br'), `호출 ${r.tokKnown}회 · 합계 ${num(tot(r))}`); tip.classList.remove('hidden'); tip.style.left = Math.min(ev.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (ev.clientY + 14) + 'px'; };
        s.addEventListener('mousemove', show); s.addEventListener('mouseleave', () => tip.classList.add('hidden'));
        bar.append(s);
      }
      ch.append(el('div', { class: 'trow' }, el('div', { class: 'tl2' }, lb, el('small', null, model)), el('div', null, bar), el('em', null, tk(tot(r)))));
    }
    box.append(ch, el('div', { class: 'tlegend' }, SEG.map(([, name, cls]) => el('span', null, el('i', { class: cls }), name))),
      el('p', { class: 'note', style: 'margin-top:10px' }, 'Claude·Codex·OpenAI API 호출은 이번 제작에서 요청마다 캐시를 새로 만들어 대부분 캐시 쓰기로 잡혔습니다. Grok은 캐시 없이 새 입력으로 읽습니다. 같은 일을 해도 공급자 방식에 따라 막대 모양이 달라집니다.'));
  }

  /* ---------- 단계별 상세 ---------- */
  const st = { ch: 5, lane: 'novel' };
  function stepTabs() {
    const box = $('#st-tabs'); box.innerHTML = '';
    const chs = [...new Set(C.summary.filter((r) => r.lane === st.lane).map((r) => r.chapter))].sort((a, b) => a - b);
    if (!chs.includes(st.ch)) st.ch = chs[chs.length - 1];
    for (const c of chs) box.append(el('button', { class: 'eptab' + (c === st.ch ? ' active' : ''), onclick: () => { st.ch = c; stepTable(); } }, el('span', null, st.lane === 'arc' ? `${c}화 전` : `${c}화`)));
    for (const b of document.querySelectorAll('#st-lane button')) b.classList.toggle('active', b.dataset.lane === st.lane);
  }
  function stepTable() {
    stepTabs();
    const t = $('#step-table'); t.innerHTML = '';
    t.append(el('tr', null, ['단계', '호출', '새 입력', '캐시 쓰기', '캐시 읽기', '출력', '(그중 추론)', '시간', '비용'].map((h) => el('th', null, h))));
    const order = []; for (const c of C.calls) if (c.chapter === st.ch && c.lane === st.lane && !order.includes(c.step)) order.push(c.step);
    const rows = order.map((s) => row(st.ch, st.lane, s)).filter(Boolean);
    const line = (r, cls) => { const c = costOf(r); return el('tr', { class: cls }, el('td', { class: 'l' }, r.label, r.tokKnown < r.calls ? el('span', { class: 'sub' }, `${r.calls - r.tokKnown}회 토큰 기록 없음`) : null),
      el('td', null, r.calls), el('td', null, tk(r.new)), el('td', null, tk(r.cacheWrite)), el('td', null, tk(r.cacheRead)), el('td', null, tk(r.output)), el('td', { class: 'muted' }, tk(r.reasoning)),
      el('td', null, r.secKnown ? dur(r.sec) : '–'), el('td', null, usd(c.v), ' ', kind(c.k))); };
    for (const r of rows) t.append(line(r));
    const all = row(st.ch, st.lane); if (all) t.append(line(all, 'tot'));
    const e = ep(st.ch);
    $('#step-note').textContent = st.lane === 'novel' ? `${st.ch}화 소설 · ${hostName(e, 'novel')}. 한 단계가 여러 번 호출되면(예: 수정 뒤 재검토) 합산했습니다.` + (st.ch === 3 ? ' 3화는 호출별 소요 시간이 남지 않아 시간 칸이 비어 있습니다.' : '')
      : st.lane === 'webtoon' ? `${st.ch}화 웹툰 각색 · ${hostName(e, 'webtoon')}. 장면 ${e.sceneCount}개의 계획·검증 호출 합계입니다. 그림 검토는 오케스트레이터가 직접 해서 토큰 기록이 없습니다.`
        : `${st.ch}화를 쓰기 전에 다음 아크를 설계한 호출입니다(아크 설계와 설계 검증).`;
  }

  /* ---------- 단계별 평균 ---------- */
  function avgTable() {
    const t = $('#avg-table');
    t.append(el('tr', null, ['단계', '기록된 회차', '호출', '호출당 입력', '호출당 출력', '호출당 시간', '호출당 비용'].map((h) => el('th', null, h))));
    const steps = []; for (const c of C.calls) if (!steps.includes(c.step)) steps.push(c.step);
    for (const s of steps) {
      const rs = C.summary.filter((r) => r.step === s);
      const a = rs.reduce((o, r) => { for (const k of ['calls', 'new', 'cacheRead', 'cacheWrite', 'output', 'sec', 'secKnown', 'tokKnown', 'usd', 'usdKnown']) o[k] = (o[k] || 0) + r[k]; return o; }, {});
      const chs = [...new Set(rs.map((r) => r.chapter))].sort((x, y) => x - y);
      t.append(el('tr', { id: `step-${s}` }, el('td', { class: 'l' }, rs[0].label, el('span', { class: 'sub' }, s)),
        el('td', null, chs.map((c) => c + '화').join(' ')), el('td', null, a.calls),
        el('td', null, a.tokKnown ? tk((a.new + a.cacheRead + a.cacheWrite) / a.tokKnown) : '–'), el('td', null, a.tokKnown ? tk(a.output / a.tokKnown) : '–'),
        el('td', null, a.secKnown ? dur(a.sec / a.secKnown) : '–'), el('td', null, a.usdKnown ? usd(a.usd / a.usdKnown) : '–')));
    }
  }

  /* ---------- 이미지 ---------- */
  function imgTable() {
    const t = $('#img-table');
    t.append(el('tr', null, ['회차', '장면(장)', '총 비용', '장당 비용', '장당 시간'].map((h) => el('th', null, h))));
    for (const e of C.episodes) {
      const im = imgs(e.chapter); if (!im.length) continue;
      const u = im.reduce((a, i) => a + (i.usd || 0), 0); const s = im.reduce((a, i) => a + (i.sec || 0), 0);
      t.append(el('tr', null, el('td', null, `${e.chapter}화`), el('td', null, im.length), el('td', null, usd(u), ' ', kind('real')), el('td', null, usd(u / im.length)), el('td', null, dur(s / im.length))));
    }
    t.append(el('tr', null, el('td', { class: 'l', colspan: 5 }, el('span', { class: 'muted small' }, `모델 ${C.imageModel}, 1024×1536, 품질 high. 비용은 OpenAI usage API 집계로, 차이는 참조 이미지 수(4~8장)에서 옵니다.`))));
  }

  /* ---------- 계산기 ---------- */
  function calc() {
    const novelOpts = C.episodes.filter((e) => row(e.chapter, 'novel')).map((e) => ({ ch: e.chapter, label: `${e.novelModel} (${e.chapter}화 실측${e.chapter <= 3 ? ', 구버전' : ''})`, r: row(e.chapter, 'novel') }));
    const toonOpts = C.episodes.filter((e) => row(e.chapter, 'webtoon')).map((e) => ({ ch: e.chapter, label: `${e.model} (${e.chapter}화 실측${e.chapter === 1 ? ', 정가 환산' : ''})`, r: row(e.chapter, 'webtoon'), scenes: e.sceneCount }));
    const allImg = C.images.filter((i) => i.usd != null);
    const imgUsd = allImg.reduce((a, i) => a + i.usd, 0) / allImg.length; const imgSec = allImg.reduce((a, i) => a + (i.sec || 0), 0) / allImg.length;
    const pickDefault = (opts) => (opts.find((o) => o.ch === 5) || opts[opts.length - 1]).ch;
    const sel = (id, opts, def) => el('select', { id }, opts.map((o) => { const x = el('option', { value: o.ch }, o.label); if (o.ch === def) x.selected = true; return x; }));
    const form = el('div', { class: 'cform' },
      el('label', null, '몇 화를 쓸까요', el('input', { type: 'number', id: 'c-n', min: 1, max: 300, value: 10 })),
      el('label', null, '소설 모델', sel('c-novel', novelOpts, pickDefault(novelOpts)), el('small', null, '그 모델로 쓴 회차 하나의 실측을 그대로 곱합니다.')),
      el('label', { class: 'chk' }, el('input', { type: 'checkbox', id: 'c-toon', checked: 'checked' }), '웹툰도 만들기'),
      el('div', { class: 'row' },
        el('label', null, '각색 모델', sel('c-adapt', toonOpts, pickDefault(toonOpts))),
        el('label', null, '화당 장면 수', el('input', { type: 'number', id: 'c-scenes', min: 1, max: 20, value: 7 }), el('small', null, '이 작품은 7~9장면'))));
    const out = el('div', { class: 'cout', id: 'c-out', 'aria-live': 'polite' });
    $('#calc-body').append(form, out);
    const update = () => {
      const n = Math.max(1, +$('#c-n').value || 1); const toon = $('#c-toon').checked; const sc = Math.max(1, +$('#c-scenes').value || 1);
      const nv = novelOpts.find((o) => o.ch === +$('#c-novel').value); const ad = toonOpts.find((o) => o.ch === +$('#c-adapt').value);
      const nvUsd = nv.r.usdKnown ? nv.r.usd : null; const nvSec = nv.r.secKnown ? nv.r.sec : wall(nv.ch) || 0;
      const adPer = ad.r.usd / ad.scenes; const adSecPer = ad.r.secKnown ? ad.r.sec / ad.scenes : 0;
      const perEp = (nvUsd || 0) + (toon ? sc * (adPer + imgUsd) : 0);
      const secEp = nvSec + (toon ? sc * (adSecPer + imgSec) : 0);
      const tokEp = tot(nv.r) + (toon ? tot(ad.r) / ad.scenes * sc : 0);
      out.innerHTML = '';
      const parts = [el('div', { class: 'small muted' }, `${n}화 예상 비용`), el('div', { class: 'big2' }, usd(perEp * n), el('small', null, `화당 ${usd(perEp)}`)),
        el('dl', null,
          el('dt', null, '소설 쓰기'), el('dd', null, nvUsd == null ? '금액 기록 없음' : `${usd(nvUsd * n)} (화당 ${usd(nvUsd)})`),
          toon ? [el('dt', null, `웹툰 각색 (장면 ${sc}개)`), el('dd', null, `${usd(adPer * sc * n)} (장면당 ${usd(adPer)})`),
            el('dt', null, '이미지'), el('dd', null, `${usd(imgUsd * sc * n)} (장당 ${usd(imgUsd)})`)] : null,
          el('dt', null, '모델 작업 시간'), el('dd', null, `${dur(secEp * n)} (화당 ${dur(secEp)})`),
          el('dt', null, '답변 모델 토큰'), el('dd', null, `${tk(tokEp * n)} (화당 ${tk(tokEp)})`)),
        nvUsd == null ? el('div', { class: 'warn' }, '이 소설 모델은 금액이 기록되지 않아 합계에서 빠졌습니다. 토큰만 참고하세요.') : null,
        nv.ch <= 3 ? el('div', { class: 'warn' }, '구버전(0.3.0)으로 쓴 회차라 현재 버전보다 호출이 많습니다. 4화 이후 회차를 기준으로 고르는 편이 현재에 가깝습니다.') : null,
        el('div', { class: 'note' }, '작업을 지휘하는 호스트(Claude Code·Codex 세션)의 비용과 사람의 검토 시간은 포함하지 않았습니다. 시간은 호출을 순서대로 실행했을 때의 합이라, 장면을 병렬로 돌리면 줄어듭니다.')];
      out.append(...parts.filter(Boolean));
    };
    for (const id of ['c-n', 'c-novel', 'c-toon', 'c-adapt', 'c-scenes']) $('#' + id).addEventListener('input', update);
    update();
  }

  fetch('costs.json').then((r) => r.json()).then((c) => {
    C = c; caveats(); calc(); epTable(); tokChart(); stepTable(); avgTable(); imgTable();
    for (const b of document.querySelectorAll('#st-lane button')) b.addEventListener('click', () => { st.lane = b.dataset.lane; stepTable(); });
    if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) setTimeout(() => t.scrollIntoView({ block: 'center', behavior: 'instant' }), 60); }
  }).catch((err) => { $('#calc-body').append(el('p', { class: 'note' }, '데이터를 불러오지 못했습니다: ' + err.message)); });
})();
