/* 공통 사이트 메뉴. <body data-page="..."> 기준으로 현재 페이지를 표시한다. */
(function () {
  'use strict';
  const PAGES = [['read', 'read.html', '작품 읽기'], ['notes', 'notes.html', '제작 노트'], ['all', '../', '다른 작품']];
  const cur = document.body.dataset.page || '';
  const nav = document.createElement('nav');
  nav.className = 'snav'; nav.setAttribute('aria-label', '사이트');
  const home = document.createElement('a');
  home.href = './'; home.className = 'snav-home'; home.textContent = '처형 1분 전의 황녀';
  if (cur === 'home') home.setAttribute('aria-current', 'page');
  nav.append(home);
  const ul = document.createElement('div'); ul.className = 'snav-links';
  for (const [key, href, label] of PAGES) {
    const a = document.createElement('a');
    a.href = href; a.textContent = label;
    if (key === cur) { a.className = 'on'; a.setAttribute('aria-current', 'page'); }
    ul.append(a);
  }
  nav.append(ul);
  document.body.prepend(nav);
})();
