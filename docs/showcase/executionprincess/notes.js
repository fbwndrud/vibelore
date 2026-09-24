/* 처형 1분 전의 황녀 — 제작 노트. data.json을 읽어 표를 채운다. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const k = (x) => (x / 1000).toFixed(0) + 'K';
  fetch('data.json').then((r) => r.json()).then((d) => {
    $('#built').textContent = d.builtAt.slice(0, 10);
    const refs = $('#refs');
    for (const r of d.references) {
      const f = el('figure'); const img = el('img'); img.src = r.image; img.alt = r.id; img.loading = 'lazy';
      f.append(img, el('figcaption', null, r.description)); refs.append(f);
    }
    const t = el('table');
    const hr = el('tr'); for (const h of ['화', '제목', '장면', '칸', '검토 통과', '차단 결함', '참고']) hr.append(el('th', null, h)); t.append(hr);
    for (const e of d.episodes) {
      const tr = el('tr');
      const a = el('a', null, e.title); a.href = `read.html#ep${e.chapter}/s1`;
      const td = el('td'); td.append(a);
      tr.append(el('td', 'n', `${e.chapter}화`), td, el('td', 'n', e.sceneCount), el('td', 'n', e.panelTotal), el('td', 'n', `${e.passCount}/${e.sceneCount}`), el('td', 'n', e.blockingTotal), el('td', 'n', e.advisoryTotal));
      t.append(tr);
    }
    $('#eps').append(t);
    const c = d.costs; const s = c.solTokens; const ct = el('table');
    const hr2 = el('tr'); for (const h of ['항목', '호출', '입력 토큰', '출력 토큰', '비고']) hr2.append(el('th', null, h)); ct.append(hr2);
    const rows = [['작품 생성·이야기 뼈대·작가 스킬', s.design, '거절된 시도·재시도 포함'], ['아크 설계', s.arc, '거절된 첫 안 포함']];
    for (const ch of ['1', '2', '3']) rows.push([`소설 ${ch}화`, s.novel[ch], '되돌린 뒤 다시 쓴 원고 포함']);
    rows.push(['손수정 반영(lore_sync)', s.sync, '1화 재작성분의 연속성 추출']);
    rows.push(['웹툰 장면 분할·각색·사전 검증', s.webtoon, '2·3화 버린 첫 시도 포함']);
    const tot = { calls: 0, input: 0, output: 0 };
    for (const [name, v, note] of rows) {
      tot.calls += v.calls; tot.input += v.input; tot.output += v.output;
      const tr = el('tr'); tr.append(el('td', null, name), el('td', 'n', v.calls), el('td', 'n', k(v.input)), el('td', 'n', k(v.output)), el('td', null, note)); ct.append(tr);
    }
    const tr = el('tr', 'total'); tr.append(el('td', null, 'GPT-6 Sol 합계'), el('td', 'n', tot.calls), el('td', 'n', k(tot.input)), el('td', 'n', k(tot.output)), el('td', null, '출력에는 추론 토큰 포함')); ct.append(tr);
    const ti = el('tr'); ti.append(el('td', null, `이미지 생성 (기준 ${c.referencesCalls} + 장면 ${c.imagesCalls - c.referencesCalls})`), el('td', 'n', c.imagesCalls), el('td', 'n', '–'), el('td', 'n', '–'), el('td', null, `약 $${c.imagesUsdEstimated.toFixed(2)} (추정)`)); ct.append(ti);
    $('#cost').append(ct);
    $('#cost-note').textContent = `이미지 비용은 OpenAI 조직 사용량 API의 해당 시간 창 합계 $${c.imagesWindowUsd.toFixed(2)}(${c.imagesWindowRequests}건, 정가 환산)를 건수로 나눠 이 작품의 ${c.imagesCalls}건에 곱한 값입니다. 같은 창에 다른 작업의 이미지 호출이 섞여 있습니다.`;
  });
})();
