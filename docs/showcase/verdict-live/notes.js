/* 판결 LIVE — 제작 노트. data.json을 읽어 표를 채운다. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const T = window.T || ((s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m)) : s));
  const EN = !!(window.I18N && I18N.lang === 'en');
  const ch = (n) => T('{n}화', { n });
  const usd = (x) => '$' + x.toFixed(2);
  // direction-changes.jsonl 항목 순서대로의 한국어 요약
  const LOG_KO = [
    ['말풍선 이름표 금지', '1화·2화 첫 장면에 영어 화자 이름표가 붙은 뒤, 말풍선 안에 이름·라벨을 쓰지 말고 꼬리와 위치로만 화자를 표시하라는 규칙을 더했습니다.'],
    ['실존 플랫폼 로고 금지', '2화 첫 장면의 빨간 재생 버튼 로고 뒤, 가상 플랫폼에 추상 마크만 쓰도록 했습니다.'],
    ['엑스트라와 주인공 구분', '3화 첫 장면의 스트리머들이 서아·채리를 복제한 뒤, 이름 없는 인물은 주인공들과 다른 머리·옷을 입히도록 했습니다.'],
    ['없는 글자 금지', '1화 썸네일 문구와 JUSTICE LIVE 뒤, 원문에 없는 제목·간판·UI 라벨을 쓰지 말라는 규칙을 더했습니다.'],
    ['2화 간판 절단', '2화 4장면이 ‘삼성약국’을 그린 뒤, 창밖 약국 간판은 창틀에 잘려 초록 십자와 앞 글자만 보이게 했습니다(원작: 간판 글자가 반쯤 잘려 있었다).'],
    ['관찰: 지시가 이미지에 직접 가지 않음', '서버의 이미지 프롬프트에는 연출 지시 원문이 아니라 사전 검증이 쓴 30단어 스타일과 칸별 설명만 들어갑니다. 앞 장면 참조 이미지가 창작 글자(JUSTICE LIVE)를 계속 전파했습니다.'],
  ];
  fetch('data.json').then((r) => r.json()).then((d) => {
    $('#built').textContent = d.builtAt.slice(0, 10);
    const refs = $('#refs');
    for (const r of d.references) {
      const f = el('figure'); const img = el('img'); img.src = r.image; img.alt = T('기준 이미지 {id}', { id: r.id }); img.loading = 'lazy';
      const cap = el('figcaption', null, r.description); cap.lang = /[가-힣]/.test(r.description) ? 'ko' : 'en'; f.append(img, cap); refs.append(f);
    }
    const t = el('table');
    const hr = el('tr'); for (const h of ['화', '제목', '장면', '칸', '검토 통과', '차단 결함', '참고', '차단 귀속']) hr.append(el('th', null, T(h))); t.append(hr);
    for (const e of d.episodes) {
      const tr = el('tr');
      const by = Object.entries(e.blockingByLayer).map(([k, v]) => `${T({ render: '이미지 모델', pipeline: '파이프라인', adapt: '각색' }[k])} ${v}`).join(' · ') || '–';
      const a = el('a', null, e.title); a.lang = 'ko'; a.href = `read.html#ep${e.chapter}/s1`;
      const td = el('td'); td.append(a);
      tr.append(el('td', 'n', ch(e.chapter)), td, el('td', 'n', e.sceneCount), el('td', 'n', e.panelTotal), el('td', 'n', `${e.passCount}/${e.sceneCount}`), el('td', 'n', e.blockingTotal), el('td', 'n', e.advisoryTotal), el('td', null, by));
      t.append(tr);
    }
    $('#eps').append(t);
    const e1 = d.episodes.find((e) => e.regen);
    if (e1) {
      const rt = el('table');
      const h = el('tr'); for (const x of ['장면', '시도', '최종 판정', '시도별 계획/그림 칸', '시도별 문구 정확']) h.append(el('th', null, T(x))); rt.append(h);
      for (const s of e1.scenes) {
        const all = [...s.attempts.map((a) => [a.plannedPanels, a.observedPanels, a.textsOk, a.textsTotal]), [s.panelCount, s.review.observedPanelCount, s.textsOk, s.textsTotal]];
        const a = el('a', null, `${s.n} · ${s.title}`); a.lang = 'ko'; a.href = `read.html#ep1/${s.id}`; const td = el('td'); td.append(a);
        const tr = el('tr');
        tr.append(td, el('td', 'n', all.length), el('td', null, T(s.verdict === 'pass' ? '통과' : '수정 필요')),
          el('td', null, all.map((x) => `${x[0]}/${x[1]}`).join(' → ')), el('td', null, all.map((x) => `${x[2]}/${x[3]}`).join(' → ')));
        rt.append(tr);
      }
      $('#regen').append(rt);
      const b = e1.regen.before;
      $('#regen-note').textContent = T('검토 통과 {bp}/{bs} → {p}/{s}. 이미지 호출 {bi}회 → {i}회. 각색·검증 모델 비용 ${bu} → ${u}. 칸은 ‘계획/그림’, 문구는 ‘정확/전체’이며 화살표는 시도 순서입니다.', { bp: b.passCount, bs: b.sceneCount, p: e1.passCount, s: e1.sceneCount, bi: b.imageCalls, i: e1.imageCalls, bu: b.webtoonUsd.toFixed(2), u: e1.cost.webtoonUsd.toFixed(2) });
    }
    const log = $('#log');
    d.directionChanges.forEach((c, i) => {
      // 영어 UI는 direction-changes.jsonl의 영어 원문을, 한국어 UI는 요약을 보여 준다
      const k = EN ? [c.change || T('관찰'), c.reason || c.note] : (LOG_KO[i] || [c.change || '관찰', c.reason || c.note]);
      const div = el('div'); if (EN) div.lang = 'en'; div.append(el('b', null, `${c.at.slice(0, 16).replace('T', ' ')} UTC · ${k[0]}`), el('br'), document.createTextNode(k[1])); log.append(div);
    });
    const c = d.costs; const ct = el('table');
    const hr2 = el('tr'); for (const h of ['항목', '호출', '금액', '비고']) hr2.append(el('th', null, T(h))); ct.append(hr2);
    const rows = [
      ['이야기 뼈대(StorySpine) 생성·심사', c.design.spineCalls, c.design.spineUsd, '자동 재생성 실패분 포함'],
      ['작가 스킬', '', c.design.writerSkillUsd, ''],
    ];
    for (const e of d.episodes) rows.push([T('소설 {n}화 (아크 포함)', { n: e.chapter }), e.cost.novelCalls, e.cost.novelUsd, 'Claude CLI 보고값']);
    rows.push(['이미지 모델 확정 관문', c.imageModelGateCalls, c.imageModelGateUsd, '1화 컷 콘티·재시도 한도 소진 후 재시작 포함']);
    rows.push(['웹툰 1화 첫 제작 각색·사전 검증 (재생성으로 대체)', c.ep1Before.cliCalls, c.ep1Before.webtoonUsd, '장면 분할 포함']);
    for (const e of d.episodes) rows.push([T('웹툰 {n}화 각색·사전 검증', { n: e.chapter }) + (e.regen ? T(' (재생성, 자동 재설계 포함)') : ''), e.cliCalls, e.cost.webtoonUsd, e.regen ? '장면 분할은 첫 제작 것 재사용' : '장면 분할 포함']);
    rows.push(['이미지 생성 (기준 6 + 첫 제작 장면 24)', c.imagesRequests, c.imagesUsd, 'OpenAI 사용량 API 실측, 정가 환산']);
    rows.push(['이미지 생성 (1화 재생성 12)', c.ep1RegenImages, c.ep1RegenImagesUsdEstimated, '추정: 첫 제작 장당 평균 × 12']);
    let total = 0;
    for (const [a, n, v, note] of rows) { total += v; const tr = el('tr'); tr.append(el('td', null, T(a)), el('td', 'n', n), el('td', 'n', usd(v)), el('td', null, T(note))); ct.append(tr); }
    const tr = el('tr', 'total'); tr.append(el('td', null, T('합계')), el('td'), el('td', 'n', usd(total)), el('td', null, T('작품 설계 인터뷰(대화 세션 작성)는 제외'))); ct.append(tr);
    $('#cost').append(ct);
    $('#cost-note').textContent = T('모델 비용은 Claude Code CLI가 보고한 total_cost_usd, 이미지는 OpenAI 조직 사용량 API 토큰에 정가(이미지 입력 $8/M, 텍스트 입력 $5/M, 이미지 출력 $30/M)를 곱한 값입니다.');
  });
})();
