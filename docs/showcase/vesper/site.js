/* 베스퍼 리더 메뉴(작품 페이지 탭과 같은 순서). 그리는 코드는 shared/worknav.js. */
WorkNav({
  title: '베스퍼',
  pages: [
    ['home', './', '개요'],
    ['read', 'read.html', '읽기'],
    ['notes', 'notes.html', '제작 노트'],
    ['data', 'data.html', '비용·데이터'],
    ['lore', '../lore.html?work=vesper', '인물·설정'],
    ['all', '../', '다른 작품'],
  ],
});
