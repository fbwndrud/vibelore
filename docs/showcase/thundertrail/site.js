/* 길 위의 번개 리더 메뉴(작품 페이지 탭과 같은 순서). 그리는 코드는 shared/worknav.js. */
WorkNav({
  title: '길 위의 번개',
  pages: [
    ['home', './', '개요'],
    ['read', 'read.html', '읽기'],
    ['notes', 'process.html', '제작 노트'],
    ['data', 'data.html', '비용·데이터'],
    ['lore', '../lore.html?work=thundertrail', '인물·설정'],
    ['cost', 'cost.html', '비용·시간 상세'],
    ['compare', 'compare.html', '모델 비교'],
    ['all', '../', '다른 작품'],
  ],
});
