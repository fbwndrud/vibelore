/* 워크플로 해설. 단계 정의는 여기, 실측 수치는 costs.json 에서. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const T = window.T || ((s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m)) : s));
  const WHO = { ai: 'AI 판단', rule: '규칙 검사', human: '사람 결정', img: '이미지 모델' };

  // steps: 이 카드가 대응하는 모델 호출 단계 이름(costs.json summary.step). 비어 있으면 모델 호출 없음.
  const NOVEL = [
    { id: 'profile', t: '작품 발견 인터뷰', tool: 'lore_profile', who: ['human', 'ai'], steps: [],
      role: '어떤 이야기를 누구에게 어떤 약속으로 쓸지 정합니다. 장르, 톤, 시점, 독자에게 줄 재미, 설명을 언제 할지 같은 “독서 계약”입니다.',
      in: '사용자와의 대화(원하는 이야기, 좋아하는 작품, 피하고 싶은 것)', out: '작품 프로필(StoryProfile): 독자 약속, 첫 화 압력, 시점 규칙, 문장 규칙',
      why: '매 화 AI가 톤을 새로 해석하면 작품이 흔들립니다. 한 번 승인한 프로필을 모든 화가 기준으로 씁니다.',
      ex: [['작품 설계에 남은 실제 프로필', 'process.html#design']] },
    { id: 'arc', t: '아크 설계', tool: 'lore_arc_plan', who: ['ai', 'human'], steps: ['arc-plan', 'arc-quality'],
      role: '여러 화(3~20화)를 묶은 이야기 단위를 설계합니다. 아크의 약속, 화별 사건·압력·전환, 독자가 잠시 잘못 믿게 둘 것까지 정합니다.',
      in: '작품 프로필, 직전 아크의 결과와 남은 떡밥', out: '아크 계획(화별 비트, 독자 예상, 대가, 반대편의 목적) + 설계 품질 점수',
      why: '화 단위로만 쓰면 매 화 사건이 비슷해지고 긴 호흡의 회수가 사라집니다. 설계를 다른 호출이 점수로 검증하고, 사람이 승인해야 집필이 시작됩니다.',
      ex: [['아크 1·2 설계와 “독자가 잘못 믿게 둘 것”', 'process.html#design']] },
    { id: 'plan', t: '화별 계획', tool: 'lore_write', who: ['ai', 'rule'], steps: ['episode-plan', 'chapter-plan'],
      role: '이번 화의 장면, 인물의 선택, 독자가 예상할 결과, 실제 전환, 해결이 남길 대가, 다음 화 질문을 적습니다.',
      in: '아크의 이번 화 비트, 직전 화 요약과 상태, 열린 떡밥 목록', out: '화별 계획(EpisodePlan)',
      why: '“독자가 예상할 것”을 먼저 적어야 그와 다른 전환을 설계할 수 있습니다. 계획은 코드가 필수 항목과 분량 예산을 검사한 뒤에야 초고로 넘어갑니다.',
      ex: [['2화 계획: 독자 예상 vs 실제 전환', 'process.html#ep2/novel']] },
    { id: 'draft', t: '초고', tool: 'lore_write', who: ['ai'], steps: ['draft'],
      role: '계획 묶음과 직전 장면을 받아 한 화(약 4000자)를 씁니다.',
      in: '화별 계획을 압축한 집필 묶음, 직전 화 마지막 장면, 문체 계약', out: '원고',
      why: '초고 모델은 설정 전체가 아니라 이번 화에 필요한 것만 받습니다. 맥락이 짧을수록 설정을 덜 흘립니다.',
      ex: [['1화 타임라인', 'process.html#ep1/novel']] },
    { id: 'continuity', t: '연속성 추출·검사', tool: 'lore_write', who: ['ai', 'rule'], steps: ['continuity-extract', 'continuity-check'],
      role: '원고에서 인물 위치, 부상, 소지품, 새로 알게 된 사실을 뽑아 확정 설정(정본)과 대조합니다.',
      in: '원고, 정본 설정과 인물 상태', out: '변경 목록과 위반(hard/soft)',
      why: '“잃은 밧줄이 다시 손에 있다” 같은 모순은 비평가보다 구조화된 대조가 정확히 잡습니다. 확정 사실과의 충돌(hard)은 반드시 고칩니다.',
      ex: [['2화 첫 원고의 확정 설정 충돌 2건', 'process.html#ep2/novel']] },
    { id: 'gate', t: '규칙 검사', tool: '서버 코드', who: ['rule'], steps: [],
      role: '분량, 확정 설정 충돌, 대사 줄바꿈 같은 기계적인 기준을 모델 없이 코드로 판정합니다.',
      in: '원고와 검사 결과', out: '막음(blocking) / 참고(advisory) 신호',
      why: '규칙 위반만 수정을 강제하고, 문체·전개 신호는 참고로만 기록합니다. 작가의 의도를 AI가 멋대로 “교정”하지 않게 하기 위해서입니다.',
      ex: [['2화: 분량 미달·설정 충돌로 막힘', 'process.html#ep2/novel']] },
    { id: 'critics', t: '비평가 검토', tool: 'lore_write', who: ['ai'], steps: ['story-profile-check', 'coherence-judge', 'editorial-quality', 'character-fidelity', 'reader-hook', 'pattern-ledger'],
      role: '역할이 다른 비평가 여섯이 원고를 읽습니다. 작품 프로필 이탈, 논리, 장면의 힘·속뜻·대가, 인물 말투·동기, 계획한 약속의 지급 여부, 앞 화와의 반복.',
      in: '원고, 계획, 작품 프로필, 인물 설정', out: '지적 목록(근거 인용, 확신도, 고칠 방향)',
      why: '한 번에 “좋은지” 묻지 않고 관점을 쪼개면 지적이 구체적이 됩니다. 모두 참고용이라 자동 수정 사유가 되지 않습니다.',
      ex: [['2화 독자 훅: “청록빛 방패가 한 번도 등장하지 않음”', 'process.html#ep2/novel']] },
    { id: 'revise', t: '최소 수정', tool: 'lore_write', who: ['ai', 'rule'], steps: ['revise'], loop: '막히면 되돌아감(최대 3회)',
      role: '규칙 위반이 있을 때만, 원고를 다시 쓰지 않고 필요한 곳만 고칩니다.',
      in: '원고, 위반 목록, 비평가 지적', out: '수정본 + 보존율(바뀌지 않은 문단 비율)',
      why: '다시 쓰면 멀쩡하던 부분까지 바뀝니다. 서버가 보존율을 따로 재서 “고치기”였는지 확인합니다.',
      ex: [['2화: 64문단 중 59개 유지, 글자 31%만 수정', 'process.html#ep2/novel']] },
    { id: 'commit', t: '영수증·커밋', tool: '서버 코드', who: ['rule'], steps: [],
      role: '검사를 통과한 원고만 정본(chapters/)에 기록하고, 떡밥·관계·인물 지식 변화를 검사 영수증에 남깁니다.',
      in: '통과본과 모든 검사 결과', out: '정본 원고, 검사 영수증, 떡밥 장부',
      why: '영수증 없는 원고는 커밋되지 않습니다. 다음 화 계획이 이 장부를 다시 읽어 떡밥을 잊지 않습니다.',
      ex: [['1~7화 떡밥 추적', 'process.html#hooks']] },
    { id: 'boundary', t: '다음 화 판단·요약', tool: 'lore_write', who: ['ai'], steps: ['narrative-boundary', 'chapter-summary', 'arc-review'],
      role: '이번 화로 아크를 계속할지, 닫을지, 늘릴지 판단하고 다음 화가 읽을 요약을 만듭니다. 아크가 끝나면 여러 화를 이어 읽는 아크 검토를 합니다.',
      in: '커밋된 원고, 아크 계획', out: '진행 판단(다음 화 / 아크 완료 / 연장)과 근거, 요약',
      why: '아크를 언제 닫을지를 본문이 실제로 지급한 것에 근거해 정합니다. 계획표대로 기계적으로 넘기지 않습니다.',
      ex: [['3화: 아크 1 완료 판단과 근거', 'process.html#ep3/novel']] },
  ];
  const WEBTOON = [
    { id: 'interview', t: '각색 인터뷰', tool: 'lore_webtoon_plan', who: ['human'], steps: [],
      role: '작화 스타일, 글자(말풍선·자막) 방식, 판면, 원작 보존 원칙을 사람이 정합니다.',
      in: '사용자 답변', out: '웹툰 각색 계약',
      why: '그림체와 “원작에 없는 대사를 만들지 않는다” 같은 원칙은 AI가 정할 일이 아닙니다.',
      ex: [['실제 인터뷰 결정', 'process.html#design-webtoon']] },
    { id: 'segment', t: '장면 나누기', tool: '호스트', who: ['ai'], steps: ['host-scene-segmentation'],
      role: '소설 한 화의 문단을 그림 한 장이 될 장면 단위로 묶습니다.',
      in: '소설 원고(문단 번호 포함)', out: '장면 목록(문단 범위, 제목, 묶은 이유)',
      why: '장면 경계가 곧 그림 한 장의 범위입니다. 한 장에 너무 많은 사건을 넣으면 뒤 단계에서 막힙니다.',
      ex: [['1화 장면 나누기', 'process.html#ep1/webtoon/s1']] },
    { id: 'splan', t: '장면 계획', tool: 'lore_webtoon_scene', who: ['ai'], steps: ['webtoon-scene-plan'],
      role: '원문이 확정한 사실을 근거 문단과 함께 뽑고, 보여 줄 순간(비트), 대사·자막 배치, 칸 수, 스스로 확신하지 못한 부분을 적습니다.',
      in: '장면 문단, 인물·세계 설정, 직전 장면', out: '장면 계획(사실·비트·글자·불확실성) + 이미지 브리프',
      why: '그림에 들어갈 모든 것을 “근거 문단이 있는 사실”로 먼저 적어야, 원문에 없는 걸 그리는 일을 줄일 수 있습니다.',
      ex: [['1화 s6: AI가 적은 불확실성', 'process.html#ep1/webtoon/s6']] },
    { id: 'preflight', t: '사전 검증', tool: 'lore_webtoon_scene', who: ['ai', 'rule'], steps: ['webtoon-scene-preflight'], loop: '막히면 계획 재설계',
      role: '그리기 전에 다른 호출이 계획을 원문과 대조합니다. 원문 충실도, 공간 가능성, 시간·인과 순서, 한 장에 담을 양. 형식이 틀린 응답은 서버가 반려합니다.',
      in: '장면 계획, 원문 문단', out: '4항목 통과/막힘과 근거',
      why: '그림을 그린 뒤에야 원문과 어긋난 걸 발견하면 되돌릴 수 없습니다. 이 작품 1~5화에서 10번 계획을 다시 짜게 했습니다.',
      ex: [['4화 s1: 막힌 뒤 5칸 → 10칸으로 재설계', 'process.html#ep4/webtoon/s1']] },
    { id: 'image', t: '이미지 생성', tool: 'OpenAI Images API', who: ['img'], steps: [],
      role: '검증을 통과한 브리프와 인물 참조 이미지로 장면 한 장(3~12칸)을 그립니다. 글자도 그림 안에 넣습니다.',
      in: '이미지 브리프, 인물·장소 참조 이미지', out: '장면 이미지 1장',
      why: '칸마다 따로 그리지 않고 장면을 한 장으로 그려 인물과 조명이 칸 사이에서 흔들리지 않게 합니다.',
      ex: [['작품 읽기에서 결과 보기', 'read.html']] },
    { id: 'review', t: '그림 검토', tool: 'lore_webtoon_scene', who: ['ai'], steps: ['webtoon-scene-image-review'],
      role: '완성 이미지를 열어 계획·원문과 대조합니다. 글자가 정확한지, 말풍선 화자가 맞는지, 원문에 없는 소품·효과음이 있는지.',
      in: '이미지, 장면 계획, 원문', out: '판정(통과 / 수정 필요), 차단·참고 지적, 글자 대조표',
      why: '이미지 모델은 한글 한 글자를 바꾸거나 말풍선을 다른 인물에 붙이곤 합니다. 이 사이트는 판정과 관계없이 첫 결과를 그대로 공개합니다.',
      ex: [['1화 s8: “표시를” → “표저를” 글자 변형', 'process.html#ep1/webtoon/s8']] },
  ];

  const fmtK = (n) => n >= 10000 ? `${(n / 1000).toFixed(0)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n));
  const dur = (s) => s < 60 ? T('{n}초', { n: Math.round(s) }) : T('{m}분 {s}초', { m: Math.floor(s / 60), s: Math.round(s % 60) });

  function stat(C, steps) {
    if (!C || !steps.length) return null;
    const rows = C.summary.filter((r) => r.step !== '*' && steps.includes(r.step));
    if (!rows.length) return null;
    const a = rows.reduce((o, r) => { for (const k of ['calls', 'new', 'cacheRead', 'cacheWrite', 'output', 'sec', 'secKnown', 'tokKnown']) o[k] = (o[k] || 0) + r[k]; return o; }, {});
    if (!a.tokKnown) return null;
    return { calls: a.calls, inTok: (a.new + a.cacheRead + a.cacheWrite) / a.tokKnown, outTok: a.output / a.tokKnown, sec: a.secKnown ? a.sec / a.secKnown : null, per: T('호출 1회 평균(1~6화 전체)') };
  }

  function card(s, i, C, lane) {
    const st = stat(C, s.steps);
    return el('article', { class: 'wcard', id: `${lane}-${s.id}` },
      el('div', { class: 'wh' }, el('span', { class: 'wn' }, String(i + 1)), el('div', null, el('h3', null, T(s.t)), el('div', { class: 'wtool' }, s.who.map((w) => el('span', { class: 'wwho' }, el('i', { class: 'who ' + w }), T(WHO[w]))), el('code', null, T(s.tool)))),
        s.loop ? el('span', { class: 'loop' }, '↺ ' + T(s.loop)) : null),
      el('p', { class: 'wrole' }, T(s.role)),
      el('dl', { class: 'dl' }, el('dt', null, T('받는 것')), el('dd', null, T(s.in)), el('dt', null, T('내놓는 것')), el('dd', null, T(s.out))),
      el('div', { class: 'why' }, el('b', null, T('왜 있나 ')), T(s.why)),
      st ? el('div', { class: 'wstat' }, el('span', null, T('이 작품 실측 · 호출 {n}회', { n: st.calls })), el('span', null, T('입력 {i} · 출력 {o} 토큰', { i: fmtK(st.inTok), o: fmtK(st.outTok) })), st.sec ? el('span', null, T('약 {d}', { d: dur(st.sec) })) : null, el('small', null, st.per), el('a', { href: `cost.html#step-${s.steps[0]}` }, T('표 보기')))
        : el('div', { class: 'wstat none' }, el('span', null, T(s.steps.length ? '이 단계의 토큰 기록 없음' : s.who.includes('img') ? '이미지 비용·시간은 비용·시간 페이지' : '모델 호출 없음(코드·사람)')), s.who.includes('img') ? el('a', { href: 'cost.html#images' }, T('보기')) : null),
      el('div', { class: 'wex' }, el('span', { class: 'muted small' }, T('이 작품에서 · ')), s.ex.map(([t, h]) => el('a', { href: h }, T(t) + ' →'))));
  }

  function lanes() {
    const box = $('#lanes');
    for (const [title, sub, list, lane] of [['소설', '한 화 = 하나의 영속 워크플로', NOVEL, 'novel'], ['웹툰', '한 장면 = 하나의 워크플로', WEBTOON, 'webtoon']]) {
      const steps = el('div', { class: 'steps' });
      list.forEach((s, i) => steps.append(el('a', { class: 'step', href: `#${lane}-${s.id}` },
        el('span', { class: 'n' }, `${i + 1}`, s.who.map((w) => el('i', { class: 'who ' + w, title: T(WHO[w]) }))), el('span', { class: 't' }, T(s.t)),
        s.loop ? el('span', { class: 'loop' }, '↺ ' + T(s.loop)) : null)));
      box.append(el('div', { class: 'lane' }, el('div', { class: 'lane-h' }, el('b', null, T(title)), el('span', null, T(sub))), steps));
    }
  }

  fetch('costs.json').then((r) => r.json()).catch(() => null).then((C) => {
    lanes();
    NOVEL.forEach((s, i) => $('#novel-cards').append(card(s, i, C, 'novel')));
    WEBTOON.forEach((s, i) => $('#webtoon-cards').append(card(s, i, C, 'webtoon')));
    if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
  });
})();
