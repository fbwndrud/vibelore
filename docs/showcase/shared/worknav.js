/* 작품 폴더 공통 메뉴. <작품>/site.js가 WorkNav({ title, pages })로 부른다. <body data-page="..."> 기준으로 현재 페이지를 표시한다.
   정적 문구 번역(i18n.js)도 여기서 먼저 적용한다. pages: [key, href, 한국어 이름] */
window.WorkNav = function (cfg) {
  'use strict';
  const T = window.T || ((s) => s);
  if (window.I18N) I18N.apply(document.body);
  const cur = document.body.dataset.page || '';
  const nav = document.createElement('nav');
  nav.className = 'snav'; nav.setAttribute('aria-label', T('사이트'));
  const home = document.createElement('a');
  home.href = './'; home.className = 'snav-home'; home.textContent = cfg.title; home.lang = 'ko';
  if (cur === 'home') home.setAttribute('aria-current', 'page');
  nav.append(home);
  const ul = document.createElement('div'); ul.className = 'snav-links';
  for (const [key, href, label] of cfg.pages) {
    const a = document.createElement('a');
    a.href = href; a.textContent = T(label);
    if (key === cur) { a.className = 'on'; a.setAttribute('aria-current', 'page'); }
    ul.append(a);
  }
  nav.append(ul);
  if (window.I18N) nav.append(I18N.toggle());
  document.body.prepend(nav);
};
