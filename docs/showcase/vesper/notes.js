/* 베스퍼 — 제작 노트. data.json을 읽어 버전·아크·장면·비용 표를 채운다. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const T = window.T || ((s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m)) : s));
  const k = (x) => (x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : (x / 1000).toFixed(0) + 'K');
  const table = (heads, rows) => {
    const t = el('table'); const hr = el('tr'); for (const h of heads) hr.append(el('th', null, T(h))); t.append(hr);
    for (const r of rows) { const tr = el('tr', r.cls); for (const [v, c] of r.cells) { const td = el('td', c); if (v && v.nodeType) td.append(v); else td.textContent = v; tr.append(td); } t.append(tr); }
    return t;
  };
  fetch('data.json').then((r) => r.json()).then((d) => {
    $('#built').textContent = d.builtAt.slice(0, 10);
    const link = (c) => { const a = el('a', null, c); a.href = `https://github.com/fbwndrud/vibelore/commit/${c}`; return a; };
    const vr = d.vibelore.novel.map((v) => ({ cells: [[v.from === v.to ? T('{n}화', { n: v.from }) : T('{a}~{b}화', { a: v.from, b: v.to })], [T('소설')], [v.packageVersion, 'n'], [link(v.commit), 'n']] }));
    vr.push({ cells: [[T('1화')], [T('웹툰')], [d.vibelore.webtoon.packageVersion, 'n'], [link(d.vibelore.webtoon.commit), 'n']] });
    $('#vers').append(table(['회차', '작업', '패키지 버전', '실행 커밋'], vr));

    const arcs = $('#arcs');
    for (const a of d.arcs) {
      const row = el('div', 'arc');
      row.append(el('div', 'r', T('{n}아크 · {a}~{b}화', { n: a.n, a: a.start, b: a.end })));
      const mid = el('div'); const b = el('b', null, a.title); b.lang = 'ko'; const sp = el('span', null, a.promise); sp.lang = 'ko'; mid.append(b, sp); row.append(mid);
      const sc = el('div', 's', String(a.reviews[a.reviews.length - 1].score)); sc.append(el('small', null, a.reviews.map((r) => T('{c}화 {s}', { c: r.chapter, s: r.score })).join(' · '))); row.append(sc);
      arcs.append(row);
    }

    const refs = $('#refs');
    for (const r of d.references) {
      const f = el('figure'); const img = el('img'); img.src = r.image; img.alt = T('기준 이미지 {id}', { id: r.id }); img.loading = 'lazy';
      const cap = el('figcaption', null, r.description); cap.lang = 'ko'; f.append(img, cap); refs.append(f);
    }

    $('#scenes').append(table(['화', '장면', '제목', '칸', '시도', '문구 정확', '판정', '비고'], d.episodes.flatMap((e) => e.scenes.map((s) => {
      const a = el('a', null, s.title); a.lang = 'ko'; a.href = `read.html#ep${e.chapter}/${s.id}`;
      return { cells: [[T('{n}화', { n: e.chapter }), 'n'], [String(s.n), 'n'], [a], [String(s.panelCount), 'n'], [s.attemptTotal > 1 ? T('{n}회 중 {c}번째', { n: s.attemptTotal, c: s.chosenAttempt }) : '1', 'n'], [`${s.textsOk}/${s.textsTotal}`, 'n'],
        [s.verdict === 'pass' ? T('통과') : T('수정 필요')], [s.lettering ? T('글자 {n}곳 후반 식자', { n: s.lettering.fixes.length }) : (s.attemptTotal > 1 ? T('자동 재설계 후 통과') : '')]] };
    }))));

    const c = d.costs; const h = (ms) => T('{n}시간', { n: (ms / 3600000).toFixed(1) });
    $('#cost').append(table(['항목', '호출', '입력 토큰', '출력 토큰', '모델 실행 시간', '비용'], [
      { cells: [[T('소설 설계·아크·50화 집필·검토')], [String(c.novel.calls), 'n'], [k(c.novel.input), 'n'], [k(c.novel.output), 'n'], [h(c.novel.ms), 'n'], ['$' + c.novel.usd.toFixed(2), 'n']] },
      { cells: [[T('웹툰 장면 분할·각색·사전 검증·그림 검토')], [String(c.webtoon.calls), 'n'], [k(c.webtoon.input), 'n'], [k(c.webtoon.output), 'n'], [h(c.webtoon.ms), 'n'], ['$' + c.webtoon.usd.toFixed(2), 'n']] },
      { cells: [[T('이미지 생성 (기준 {r} + 장면 {s})', { r: c.images.reference, s: c.images.scene })], [String(c.images.reference + c.images.scene), 'n'], ['–', 'n'], ['–', 'n'], ['–', 'n'], [T('약 ${v} (추정)', { v: c.images.usdEstimated.toFixed(2) }), 'n']] },
      { cls: 'total', cells: [[T('합계')], [String(c.novel.calls + c.webtoon.calls + c.images.reference + c.images.scene), 'n'], [k(c.novel.input + c.webtoon.input), 'n'], [k(c.novel.output + c.webtoon.output), 'n'], [h(c.novel.ms + c.webtoon.ms), 'n'], [T('약 ${v}', { v: (c.novel.usd + c.webtoon.usd + c.images.usdEstimated).toFixed(2) }), 'n']] },
    ]));
  });
})();
