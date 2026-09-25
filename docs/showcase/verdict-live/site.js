/* 공통 사이트 메뉴. <body data-page="..."> 기준으로 현재 페이지를 표시한다. 정적 문구 번역(i18n.js)도 여기서 먼저 적용한다. */
(function () {
  'use strict';
  const T = window.T || ((s) => s);
  if (window.I18N) I18N.apply(document.body);
  const PAGES = [['read', 'read.html', '작품 읽기'], ['notes', 'notes.html', '제작 노트'], ['multilingual', '../multilingual/', '다국어'], ['all', '../', '다른 작품']];
  const cur = document.body.dataset.page || '';
  const nav = document.createElement('nav');
  nav.className = 'snav'; nav.setAttribute('aria-label', T('사이트'));
  const home = document.createElement('a');
  home.href = './'; home.className = 'snav-home'; home.textContent = '판결 LIVE'; home.lang = 'ko';
  if (cur === 'home') home.setAttribute('aria-current', 'page');
  nav.append(home);
  const ul = document.createElement('div'); ul.className = 'snav-links';
  for (const [key, href, label] of PAGES) {
    const a = document.createElement('a');
    a.href = href; a.textContent = T(label);
    if (key === cur) { a.className = 'on'; a.setAttribute('aria-current', 'page'); }
    ul.append(a);
  }
  nav.append(ul);
  if (window.I18N) nav.append(I18N.toggle());
  document.body.prepend(nav);
})();
