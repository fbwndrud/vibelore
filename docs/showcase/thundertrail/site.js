/* 공통 사이트 메뉴. <body data-page="..."> 기준으로 현재 페이지를 표시한다. */
(function () {
  'use strict';
  const PAGES = [
    ['read', 'read.html', '작품 읽기'],
    ['process', 'process.html', '제작 기록'],
    ['workflow', 'workflow.html', '워크플로 해설'],
    ['cost', 'cost.html', '비용·시간'],
    ['compare', 'compare.html', '모델 비교'],
  ];
  const cur = document.body.dataset.page || '';
  const nav = document.createElement('nav');
  nav.className = 'snav'; nav.setAttribute('aria-label', '사이트');
  const home = document.createElement('a');
  home.href = './'; home.className = 'snav-home'; home.textContent = '길 위의 번개';
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
