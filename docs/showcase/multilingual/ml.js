/* 다국어 쇼케이스. data.json(tmp/showcase-multilingual/build-multilingual.py 산출)으로 렌더링. 의존성 없음.
 * 소설·대사는 각 언어 원문 그대로 lang/dir을 붙여 싣고, 검토 문장은 기록된 영어 원문 그대로 싣는다. */
(function () {
  'use strict';
  const T = window.T || ((s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m)) : s));
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else n.setAttribute(k, v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  // 원문 블록: lang·dir을 붙이고 해당 문자 글꼴을 쓴다
  const src = (tag, L, attrs, ...kids) => el(tag, Object.assign({ lang: L.code, dir: L.dir, class: 'src' }, attrs || {}), ...kids);
  const en = (tag, attrs, ...kids) => el(tag, Object.assign({ lang: 'en', dir: 'ltr' }, attrs || {}), ...kids);
  const NAME = { ko: '한국어', en: '영어', ja: '일본어', 'zh-Hant': '번체 중국어', es: '스페인어', fr: '프랑스어', ar: '아랍어', th: '태국어' };
  const name = (L) => T(NAME[L.code] || L.code);
  // 읽기 방향은 manifest의 영어 값. 한국어 UI에서만 풀어 쓴다
  const DIR_KO = { 'left-to-right': '왼쪽에서 오른쪽', 'right-to-left inside balloons; balloon/panel placement left-to-right': '말풍선 안은 오른쪽에서 왼쪽, 말풍선·칸 배치는 왼쪽에서 오른쪽' };
  const dirLabel = (d) => (window.I18N && I18N.lang === 'en' ? d : (DIR_KO[d] || d)) || '–';
  const usd = (x) => (x == null ? '–' : '$' + Number(x).toFixed(2));
  const dur = (s) => (s == null ? '–' : s < 60 ? T('{n}초', { n: s }) : T('{m}분 {s}초', { m: Math.floor(s / 60), s: s % 60 }));

  function chips(D) {
    const box = $('#chips');
    for (const L of D.languages) {
      const w = L.webtoon;
      box.append(el('a', { class: 'chip', href: `#w-${L.code}` },
        el('b', { lang: L.code, dir: L.dir }, L.native), el('small', null, name(L)),
        el('span', { class: 'row' },
          el('span', { class: 'pill ' + (L.novel.committed ? 'ok' : 'red') }, T(L.novel.committed ? '소설 커밋' : '소설 미커밋')),
          w ? el('span', { class: 'pill ' + (w.pass ? 'ok' : 'warn') }, T(w.pass ? '웹툰 통과' : '웹툰 수정 필요')) : null)));
    }
  }

  function novels(D) {
    $('#novel-sub').textContent = T('언어마다 작품 발견 인터뷰부터 1화 커밋까지 공개 MCP 도구만으로 진행한 수락 테스트 결과입니다. 소설 모델은 {m}.', { m: D.novelModel });
    const box = $('#novels');
    for (const L of D.languages) {
      const n = L.novel;
      box.append(el('article', { class: 'ncard', id: `n-${L.code}` },
        el('div', { class: 'nh' }, el('span', { class: 'lg' }, `${name(L)} · `, el('bdi', { lang: L.code }, L.native)),
          el('span', { class: 'pill ' + (n.committed ? 'ok' : 'red') }, T(n.committed ? '1화 커밋됨' : '커밋 안 됨'))),
        src('h3', L, { class: 'src wt' }, n.workTitle),
        src('p', L, { class: 'src premise' }, n.premise),
        el('div', { class: 'ch1' },
          el('div', { class: 'ct' }, T('1화 · 커밋된 원고 앞부분'), ' · ', src('b', L, null, n.chapterTitle)),
          src('div', L, { class: 'src ex' }, n.excerpt.map((p) => el('p', null, p)))),
        el('dl', { class: 'facts' },
          el('dt', null, T('커밋')), el('dd', null, el('code', null, n.sourceHead), ' · ', T('chapters/001.md, 본문 {n}자', { n: window.I18N ? I18N.num(n.chapterChars) : n.chapterChars })),
          el('dt', null, T('lore_write 패스')), el('dd', null, T('{p}회 · 필수 수정 {r}회', { p: n.loreWritePasses, r: n.reviseRequests })),
          el('dt', null, T('언어 감사')), el('dd', null, el('span', { class: 'pill ' + (n.languageAudit === 'pass' ? 'ok' : 'red') }, n.languageAudit === 'pass' ? T('통과') : String(n.languageAudit))),
          el('dt', null, T('증거')), el('dd', null, el('code', null, n.evidence)))));
    }
  }

  function runBox(D) {
    const P = D.webtoonRun; const B = D.webtoonBefore;
    $('#webtoon-sub').textContent = T('각 작품 1화의 첫 장면을 lore_webtoon_scene으로 한 장씩 그렸습니다. 칸 수는 auto, 대사는 작품 언어 원문 그대로 이미지 안에 넣었습니다.');
    const box = $('#runbox');
    box.append(el('div', null, el('b', null, T('주 결과')), ' ', el('code', null, P.id), ' · ', T('{date} 생성', { date: (P.generatedAt || '').slice(0, 10) }), ' · ',
      T('그림 검토 통과 {p}/{n}', { p: P.passCount, n: P.langCount }), P.totals ? ' · ' + T('비용 {v} (호스트 {h} + 이미지 {i})', { v: usd(P.totals.totalUsd), h: usd(P.totals.hostUsd), i: usd(P.totals.imageUsd) }) : ''));
    if (B) {
      box.append(el('div', { class: 'cmp' }, el('span', { class: 'pill' }, T('비교')),
        T('프롬프트 수정 전 실행 {id}: 통과 {p}/{n}', { id: B.id, p: B.passCount, n: B.langCount }), '→',
        T('수정 후 {id}: 통과 {p}/{n}', { id: P.id, p: P.passCount, n: P.langCount })),
      el('p', { style: 'margin:6px 0 0' }, T('같은 발췌·인물 참조·호스트·이미지 모델·연출 지시로 다시 그렸습니다. 두 실행 모두 언어마다 첫 이미지 한 장뿐이며, 수정 전 그림과 판정은 각 언어 아래에 그대로 둡니다.')));
    }
    box.append(el('details', null, el('summary', null, T('실행 조건 원문(영어)')),
      en('p', { class: 'dir' }, el('b', null, 'policy: '), P.policy), en('p', { class: 'dir' }, el('b', null, 'reviewer: '), P.reviewer),
      en('p', { class: 'dir' }, el('b', null, 'host: '), P.hostModel), en('p', { class: 'dir' }, el('b', null, 'images: '), P.imageModel),
      en('p', { class: 'dir' }, el('b', null, 'direction: '), P.direction), en('p', { class: 'dir' }, el('b', null, 'server: '), P.server)));
  }

  function lineTable(L, w, onlyFlagged) {
    const rows = w.lines.filter((x) => !onlyFlagged || x.flag || !x.readable || !x.speakerCorrect);
    if (!rows.length) return null;
    const tb = el('table', { class: 'lines' }, el('tr', null, el('th', null, 'id'), el('th', null, T('계획한 글자')), el('th', null, T('그림에서 읽힌 글자')), el('th', null, T('검토 메모(영어)'))));
    for (const x of rows) {
      tb.append(el('tr', null, el('td', { class: 'id' }, x.id, el('br'), x.kind || ''),
        src('td', L, null, x.planned || ''), src('td', L, { class: 'src' + (x.flag ? ' bad' : '') }, x.observed || T('(안 보임)')),
        en('td', { style: 'font-size:12px;color:var(--sub)' }, x.evidence || '')));
    }
    return tb;
  }

  function verdictPill(w) { return el('span', { class: 'pill ' + (w.pass ? 'ok' : 'warn') }, T(w.pass ? '도구 검토 통과' : '도구 검토 실패 · 수정 필요')); }

  function webtoons(D) {
    const box = $('#webtoons'); const P = D.webtoonRun; const B = D.webtoonBefore;
    for (const L of D.languages) {
      const w = L.webtoon; if (!w) continue;
      const alt = T('{lang} 웹툰 1화 첫 장면 “{title}” ({n}칸)', { lang: name(L), title: w.sceneTitle, n: w.panelsSeen });
      const fl = el('ul', { class: 'flist' });
      for (const f of w.findings) fl.append(el('li', null, el('span', { class: 'pill ' + (f.severity === 'blocking' ? 'red' : '') }, T(f.severity === 'blocking' ? '차단' : '참고')), en('span', null, f.evidence)));
      const body = el('div', { class: 'wbody' },
        el('h3', null, el('span', { class: 'lg' }, `${name(L)} · `, el('bdi', { lang: L.code }, L.native)), src('span', L, null, w.sceneTitle)),
        el('div', { class: 'stats' }, verdictPill(w),
          el('span', { class: 'pill' }, T('칸 계획 {p} / 그림 {s}', { p: w.panelsPlanned, s: w.panelsSeen })),
          el('span', { class: 'pill' + (w.nonVerbatim.length ? ' warn' : ' ok') }, T('계획과 같은 줄 {ok}/{n}', { ok: w.textsVerbatim, n: w.textsTotal })),
          w.speakerProblems.length ? el('span', { class: 'pill red' }, T('화자 문제 {n}줄', { n: w.speakerProblems.length })) : null,
          el('span', { class: 'pill wrap' }, T('읽기 방향: {d}', { d: dirLabel(w.readingDirection) }))),
        w.letteringSummary ? el('p', { class: 'summary' }, el('small', null, T('글자 검토 요약 (검토자 원문, 영어)')), en('span', null, w.letteringSummary)) : null,
        w.findings.length ? fl : el('p', { class: 'summary' }, T('지적 없음')),
        w.changeVsBefore && B ? el('p', { class: 'summary' }, el('small', null, T('{id} 대비 달라진 점 (검토자 원문, 영어)', { id: B.id })), en('span', null, w.changeVsBefore)) : null,
        (() => { const t = lineTable(L, w, true); return t ? el('div', null, el('div', { style: 'font-size:12px;color:var(--muted);margin-bottom:4px' }, T('계획과 다르게 읽힌 줄')), t) : null; })(),
        el('details', { class: 'more' }, el('summary', null, T('모든 대사·자막 {n}줄 대조', { n: w.lines.length })), lineTable(L, w, false)),
        el('details', { class: 'more' }, el('summary', null, T('검토 전문(영어)')), en('p', { class: 'ev' }, w.reviewEvidence || '')),
        el('div', { style: 'font-size:12px;color:var(--muted)' }, T('제작 {t} · 호스트 {h} + 이미지 {i}', { t: dur(w.seconds), h: usd(w.hostUsd), i: usd(w.imageUsd) }), ' · ', el('code', null, w.workflowId)));
      const bw = L.webtoonBefore;
      if (bw && B) {
        const bfl = el('ul', { class: 'flist' });
        for (const f of bw.findings) bfl.append(el('li', null, el('span', { class: 'pill ' + (f.severity === 'blocking' ? 'red' : '') }, T(f.severity === 'blocking' ? '차단' : '참고')), en('span', null, f.evidence)));
        body.append(el('div', { class: 'before' },
          el('details', { class: 'more' }, el('summary', null, T('프롬프트 수정 전 ({id}) 그림과 판정 보기', { id: B.id }), ' ', verdictPill(bw)),
            el('div', { class: 'bgrid' },
              el('a', { href: bw.image, target: '_blank', rel: 'noopener' }, el('img', { src: bw.image, width: bw.width, height: bw.height, loading: 'lazy', alt: T('{lang} 웹툰 1화 첫 장면, 프롬프트 수정 전 ({n}칸)', { lang: name(L), n: bw.panelsSeen }) })),
              el('div', { class: 't' },
                el('div', { class: 'stats' }, el('span', { class: 'pill' }, T('칸 계획 {p} / 그림 {s}', { p: bw.panelsPlanned, s: bw.panelsSeen })),
                  el('span', { class: 'pill' + (bw.nonVerbatim.length ? ' warn' : ' ok') }, T('계획과 같은 줄 {ok}/{n}', { ok: bw.textsVerbatim, n: bw.textsTotal }))),
                bw.letteringSummary ? el('p', { class: 'summary', style: 'margin-top:8px' }, el('small', null, T('글자 검토 요약 (검토자 원문, 영어)')), en('span', null, bw.letteringSummary)) : null,
                bw.findings.length ? bfl : null,
                (() => { const t = lineTable(L, bw, true); return t ? el('div', { style: 'margin-top:8px' }, t) : null; })())))));
      }
      box.append(el('article', { class: 'wcard', id: `w-${L.code}` },
        el('div', { class: 'wimg' },
          el('a', { href: w.image, target: '_blank', rel: 'noopener' }, el('img', { src: w.image, width: w.width, height: w.height, alt, loading: box.children.length > 1 ? 'lazy' : 'eager' })),
          el('div', { class: 'cap' }, T('{run} 첫 결과 · 원본 1024×1536을 {w}px WebP로 줄임', { run: P.id, w: w.width }))),
        body));
    }
  }

  fetch('data.json').then((r) => r.json()).then((D) => {
    $('#built').textContent = (D.builtAt || '').slice(0, 10);
    chips(D); novels(D); runBox(D); webtoons(D);
    if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
  }).catch((err) => { $('#novels').textContent = T('데이터를 불러오지 못했습니다: ') + err.message; });
})();
