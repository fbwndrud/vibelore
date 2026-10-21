(async function () {
  'use strict';
  const d = await fetch('data.json').then(r => { if (!r.ok) throw new Error('Production records unavailable'); return r.json(); });
  const node = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
  function link(href, label) { const a = node('a', label); a.href = href; return a; }
  function figure(src, label) {
    const f = node('figure'), a = link(src, ''), img = node('img');
    img.src = src; img.alt = label; img.loading = 'lazy'; a.append(img); f.append(a, node('figcaption', label)); return f;
  }
  const p = d.production;
  for (const label of [`소설 ${d.chapters.length}화 완결`, `웹툰 4장면 · 34칸`, `첫 시도 통과 ${p.firstPassScenes}/4`, `최종 통과 ${p.finalPassScenes}/4`, `재생성 ${p.regenerations}건`]) document.querySelector('#summary').append(node('span', label));
  for (const ref of p.references) document.querySelector('#references').append(figure(ref.image, ref.title));
  for (const s of d.episodes[0].scenes) {
    for (const a of s.attempts) {
      const detail = node('details');
      detail.open = true;
      const issue = a.findings.filter(f => f.severity === 'blocking').map(f => f.ko).join(' ');
      detail.append(node('summary', `장면 ${s.n} · ${a.n}차 → ${s.chosenAttempt}차`), node('p', issue));
      const pair = node('div'); pair.className = 'revision-pair';
      pair.append(figure(a.image, `수정 전 · ${a.n}차 · 문구 ${a.textsOk}/${a.textsTotal} 정확 · 수정 필요`), figure(s.image, `최종본 · ${s.chosenAttempt}차 · 문구 ${s.textsOk}/${s.textsTotal} 정확 · 통과`));
      detail.append(pair); document.querySelector('#revisions').append(detail);
    }
  }
  for (const r of p.records) {
    const li = node('li', `장면 ${r.scene} · ${r.revision}차 · ${r.verdict === 'pass' ? '통과' : '수정 필요'} — `);
    li.append(link(r.record, '계획·검토 기록 JSON'), document.createTextNode(' · '), link(r.prompt, '이미지 프롬프트 TXT'));
    document.querySelector('#records').append(li);
  }
})().catch(error => { document.querySelector('#summary').textContent = '제작 기록을 불러오지 못했습니다.'; console.error(error); });
