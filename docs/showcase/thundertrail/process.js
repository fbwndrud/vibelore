/* 길 위의 번개 — 제작 과정 페이지. process.json + data.json 으로 렌더링. 의존성 없음. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };
  const dur = (s) => s == null ? '–' : s < 60 ? `${s}초` : s < 3600 ? `${Math.floor(s / 60)}분 ${s % 60 ? (s % 60) + '초' : ''}`.trim() : `${Math.floor(s / 3600)}시간 ${Math.round((s % 3600) / 60)}분`;
  const CHAR = { c1: '리아', c2: '도윤', c3: '보리', c4: '마렌' };

  let P = null; let D = null; let KO = {};
  const tr = (key, en) => (KO[key] || en || '');
  // 내부 식별자를 사람이 읽는 말로: 리아(c1) → 리아, c2 → 도윤, text-3 → “대사”
  let TEXTS = {};
  const human = (s) => String(s || '')
    .replace(/(리아|도윤|보리|마렌)\s?\((c[1-4])\)/g, '$1')
    .replace(/\b(c[1-4])\s?\((리아|도윤|보리|마렌)\)/g, (m, c) => CHAR[c])
    .replace(/\b(c[1-4])\b/g, (m) => CHAR[m] || m)
    .replace(/\btext-[A-Za-z0-9-]+/g, (m) => TEXTS[m] ? `“${TEXTS[m].text}”` : m)
    .replace(/\bch-\d+-p-(\d+)/g, '$1문단')
    // 치환 뒤 조사 맞춤: 도윤·마렌은 받침 있음, 리아·보리는 없음
    .replace(/(도윤|마렌)(가|는|를|와|로)(?![가-힣])/g, (m, n, j) => n + { 가: '이', 는: '은', 를: '을', 와: '과', 로: '으로' }[j])
    .replace(/(리아|보리)(이|은|을|과|으로)(?![가-힣])/g, (m, n, j) => n + { 이: '가', 은: '는', 을: '를', 과: '와', 으로: '로' }[j])
    .replace(/”(을|를) 말한다/g, '”라고 말한다').replace(/”(을|를) 말하/g, '”라고 말하');
  const trh = (key, en) => human(tr(key, en));
  const state = { ep: 1, lane: store.get('tt.proc.lane', 'webtoon'), scene: 's1' };

  /* ---------- 용어 ---------- */
  const CODE = {
    INTRINSIC_VIOLATION: ['확정 설정과 충돌', 'hard'], QUALITY_GATE_LENGTH: ['분량 미달', 'hard'],
    CAST_MANIFEST_MISMATCH: '등장인물 목록과 본문 불일치', CLEAN_CONFLICT_RESET: '갈등이 대가 없이 봉합됨', COST_FREE_CHOICE: '대가 없는 선택',
    COST_SHAPE_REPETITION: '대가의 모양이 반복됨', DIALOGUE_INFO_ONLY: '정보 전달만 하는 대사', DIALOGUE_RATIO_OFF: '대사 비율이 기준에서 벗어남',
    DOUBLE_ENDING: '결말이 두 번 나옴', DRAMATIC_CONSEQUENCERESIDUE: '결과가 다음으로 남지 않음', DRAMATIC_POWERSHIFT: '힘의 이동이 약함',
    EMOTIONAL_TEMPERATURE_REPETITION: '감정 온도가 매 화 같음', EVIDENCE_FAMILY_REPETITION: '같은 종류의 단서 반복', GENERIC_COMPETENCE: '누구나 할 법한 유능함',
    GENERIC_DIALOGUE: '누구나 할 법한 대사', MORAL_CHOICE_REPETITION: '같은 도덕적 선택 반복', MUTABLE_UNJUSTIFIED: '근거 없는 상태 변화',
    NO_TIME_SKIP: '시간 도약 없음', OFF_AXIS_HUMANITY_MISSING: '목표 밖의 인간미 부족', ON_THE_NOSE_DIALOGUE: '속뜻을 다 말해 버리는 대사',
    OVERLONG_DENSITY: '서술이 과밀함', PLAN_SHAPED_PROSE: '계획서를 옮긴 듯한 문장', PROFILE_BEAT_DRIFT: '약속한 전개 박자에서 벗어남',
    PROFILE_ENGINE_DRIFT: '작품의 이야기 엔진에서 벗어남', PROFILE_OVERPERFORMANCE: '설정을 과하게 드러냄', RELATIONSHIP_DRIFT: '관계 변화의 근거 부족',
    REPEATED_NEGOTIATION: '같은 협상이 반복됨', SCENE_DISCONNECT: '장면 연결이 끊김', SCENE_TEMPERATURE_FLAT: '장면 온도가 단조로움',
    SCENE_THIN: '장면이 얇음', SHOW_NOT_TELL_LOW: '보여주기보다 설명', SIMILE_TOO_SPARSE: '비유가 너무 적음', STATIC_POWER: '힘의 균형이 움직이지 않음',
    TELEGRAPHED_TURN: '전환이 미리 들킴', UNPAID_PROMISE: '약속한 장면이 빠짐', VOICE_MISMATCH: '인물 말투 불일치', VOICE_RANGE_NARROW: '말투의 폭이 좁음',
    VOICE_SAMPLE_COPIED: '예시 문장을 거의 그대로 사용',
  };
  const codeLabel = (c) => { const v = CODE[c]; return Array.isArray(v) ? v[0] : (v || c); };
  const REVIEWER = {
    'coherence-judge': ['논리 검토', '사건의 인과·설정 사실이 앞뒤가 맞는지'],
    'editorial-quality': ['편집 검토', '장면의 힘·속뜻·대가·전환이 살아 있는지'],
    'character-fidelity': ['인물 검토', '각 인물의 말투와 동기가 설정과 맞는지'],
    'reader-hook': ['독자 훅 검토', '계획한 약속을 본문이 실제로 지급했는지'],
    'pattern-ledger': ['반복 패턴 기록', '앞 화와 같은 모양이 반복되는지'],
    'arc-review': ['아크 검토', '아크 전체(여러 화)를 이어 읽었을 때의 변화 폭'],
  };
  const CHECK = {
    sourceFidelity: ['원문 충실도', '원문에 없는 사건·대사·소품을 넣지 않았는가'],
    spatialFeasibility: ['공간 가능성', '인물·소품 위치가 한 화면에서 말이 되는가'],
    temporalCausality: ['시간·인과 순서', '원문에서 일어난 순서대로 보이는가'],
    visualLoad: ['한 장에 담을 양', '정해진 칸 수에 동작과 글자가 무리 없이 들어가는가'],
  };
  const STEP_KO = { 'webtoon-scene-plan': '장면 계획', 'webtoon-scene-preflight': '사전 검증', 'webtoon-scene-image-review': '그림 검토' };
  const REJECT_KO = {
    SCENE_DIRECTION_MUST_BE_ENGLISH: '연출 지시가 영어가 아니어서 서버가 반려',
    INVALID_SCENE_FINDING: '검증 결과 형식이 규격에 맞지 않아 반려',
    INVALID_SCENE_TEXT_ROLE: '대사 역할 표기가 규격에 맞지 않아 반려',
    STALE_SCENE_PREFLIGHT: '계획이 바뀐 뒤의 오래된 검증 결과라 반려',
  };

  /* ---------- 전체 흐름 ---------- */
  const LANES = [
    { key: 'novel', title: '소설', sub: '한 화 = 하나의 영속 워크플로. 순서를 건너뛰면 커밋되지 않습니다', steps: [
      { t: '작품 발견 인터뷰', d: '장르·톤·독자 약속을 정해 작품 프로필로 고정', who: ['human', 'ai'], go: '#design' },
      { t: '아크 설계', d: '여러 화(여기선 3화) 단위 약속과 사건·압력·전환', who: ['ai', 'human'], go: '#design-arcs' },
      { t: '화별 계획', d: '장면, 선택, 대가, 다음 질문', who: ['ai'], go: 'novel:plan' },
      { t: '초고', d: '화별 계획 묶음과 직전 맥락으로 약 4000자', who: ['ai'], go: 'novel:timeline' },
      { t: '규칙 검사', d: '분량·확정 설정 충돌 검사, 대사 줄바꿈 정리', who: ['rule'], go: 'novel:gate' },
      { t: '비평가 검토', d: '논리·편집·인물·독자 훅·반복 패턴', who: ['ai'], go: 'novel:reviews' },
      { t: '최소 수정', d: '규칙 위반(hard)이 있을 때만, 최대 3회', who: ['ai'], go: 'novel:gate', loop: '막히면 되돌아감' },
      { t: '영수증·커밋', d: '통과본만 정본에 기록하고 다음 화를 판단', who: ['rule', 'ai'], go: 'novel:commit' },
    ] },
    { key: 'webtoon', title: '웹툰', sub: '장면마다 독립 워크플로. 그림은 장면당 한 장(3~12칸)', steps: [
      { t: '각색 인터뷰', d: '작화·문자·판면과 원작 보존 원칙 결정', who: ['human'], go: '#design-webtoon' },
      { t: '장면 나누기', d: '소설 단락을 장면 단위로 묶음', who: ['ai'], go: 'webtoon:1' },
      { t: '장면 계획', d: '원문 사실 추출, 비트, 대사 배치, 불확실성', who: ['ai'], go: 'webtoon:2' },
      { t: '사전 검증', d: '원문·공간·순서·분량 4가지를 그리기 전에 확인', who: ['ai'], go: 'webtoon:5', loop: '막히면 계획 재설계' },
      { t: '이미지 생성', d: '장면당 한 번 호출, 글자까지 그림 안에', who: ['img'], go: 'webtoon:6' },
      { t: '그림 검토', d: '글자·화자·원문 대조로 판정. 자동 재생성 없음', who: ['ai'], go: 'webtoon:7' },
    ] },
  ];

  function renderLanes() {
    const box = $('#lanes'); box.innerHTML = '';
    for (const lane of LANES) {
      const steps = el('div', { class: 'steps' });
      lane.steps.forEach((s, i) => {
        steps.append(el('button', { class: 'step', type: 'button', onclick: () => goStep(s.go) },
          el('span', { class: 'n' }, `${i + 1}`, s.who.map((w) => el('i', { class: 'who ' + w, title: { ai: 'AI 판단', rule: '규칙 검사', human: '사람 결정', img: '이미지 모델' }[w] }))),
          el('span', { class: 't' }, s.t),
          el('span', { class: 'd' }, s.d),
          s.loop ? el('span', { class: 'loop' }, '↺ ' + s.loop) : null));
      });
      box.append(el('div', { class: 'lane' }, el('div', { class: 'lane-h' }, el('b', null, lane.title), el('span', null, lane.sub)), steps));
    }
  }
  function goStep(go) {
    if (go.startsWith('#')) { const t = $(go); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const [lane, anchor] = go.split(':');
    state.lane = lane; store.set('tt.proc.lane', lane);
    // 웹툰 단계는 재설계가 있었던 장면을 우선 보여 준다
    if (lane === 'webtoon' && anchor === '5') {
      const w = P.webtoon.find((x) => x.chapter === state.ep);
      const s = w && w.scenes.find((x) => x.redesigns > 0);
      if (s) state.scene = s.id;
    }
    renderEpisode(); writeHash();
    requestAnimationFrame(() => {
      const t = document.getElementById(lane === 'webtoon' ? 'st-' + anchor : 'nv-' + anchor) || $('#episode');
      t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /* ---------- 통계 ---------- */
  function renderStats() {
    const reviewsN = P.novel.reduce((a, n) => a + n.reviews.reduce((b, r) => b + r.findings.length, 0), 0);
    const scenes = P.webtoon.reduce((a, w) => a + w.scenes.length, 0);
    const redesign = P.webtoon.reduce((a, w) => a + w.scenes.reduce((b, s) => b + (s.redesigns || 0), 0), 0);
    const facts = D.episodes.reduce((a, e) => a + e.scenes.reduce((b, s) => b + (s.plan.facts || []).length, 0), 0);
    const pass = D.episodes.reduce((a, e) => a + e.passCount, 0);
    const items = [
      [P.novel.length + '화', '소설 워크플로'],
      [reviewsN + '건', '비평가 지적'],
      [P.novel.filter((n) => n.attempts.length > 1).length + '화', '규칙 위반으로 수정'],
      [scenes + '장면', '웹툰 장면 워크플로'],
      [facts + '개', 'AI가 원문에서 뽑은 사실'],
      [redesign + '회', '사전 검증이 막아 재설계'],
      [`${pass}/${scenes}`, '그림 검토 통과'],
    ];
    const box = $('#pstats'); box.innerHTML = '';
    for (const [b, s] of items) box.append(el('div', { class: 'pstat' }, el('b', null, b), el('span', null, s)));
  }

  /* ---------- 작품 설계 ---------- */
  function renderDesign() {
    const w = P.work; const pr = w.profile; const c = pr.contract || {};
    const body = $('#design-body'); body.innerHTML = '';
    body.append(el('div', { class: 'cols' },
      el('div', { class: 'box' }, el('h3', null, '독자에게 한 약속'), el('p', { class: 'big' }, c.readerPromise),
        el('div', { class: 'why' }, el('b', null, '왜 이 시점인가 '), c.viewpointReason)),
      el('div', { class: 'box' }, el('h3', null, '작품 프로필'),
        el('dl', { class: 'dl' },
          el('dt', null, '장르'), el('dd', null, pr.genre),
          el('dt', null, '톤'), el('dd', null, (pr.tones || []).join(' · ')),
          el('dt', null, '주제'), el('dd', null, (pr.themes || []).join(' · ')),
          el('dt', null, '시점·분량'), el('dd', null, `${pr.format?.pov || ''} · 화당 약 ${pr.format?.chapterChars || '?'}자`),
          el('dt', null, '첫 화 압력'), el('dd', null, c.openingPressure),
          el('dt', null, '설명 규칙'), el('dd', null, c.expositionPolicy),
          el('dt', null, '문장 규칙'), el('dd', null, c.registerPolicy)))));
    // 아크
    const arcs = el('div', { class: 'arcs', id: 'design-arcs' });
    for (const a of w.arcs) {
      const eps = el('div', { class: 'arc-eps' });
      for (const e of a.episodes) {
        eps.append(el('div', { class: 'arc-ep' }, el('b', null, `${e.chapter}화`),
          el('div', null, el('div', null, el('b', { style: 'font-size:14px' }, e.title || '')),
            e.beat ? el('div', null, el('span', { class: 'lb' }, '사건'), e.beat) : null,
            e.turn ? el('div', null, el('span', { class: 'lb' }, '전환'), e.turn) : null,
            e.readerExpectation ? el('div', { class: 'muted' }, el('span', { class: 'lb' }, '독자 예상'), e.readerExpectation) : null)));
      }
      const mis = (a.misconception || [])[0];
      arcs.append(el('div', { class: 'box' },
        el('h3', null, `아크 ${a.n} · ${a.status === 'completed' ? '완료' : '진행 중'}${a.quality ? ' · 설계 점수 ' + a.quality : ''}`),
        el('p', { class: 'big' }, `「${a.title}」`), el('p', null, a.promise),
        mis ? el('div', { class: 'why' }, el('b', null, '독자가 잘못 믿게 둘 것 '), mis.readerBelief, el('br'), el('span', { class: 'muted' }, '숨은 진짜 이유: ' + (mis.hiddenCausality || ''))) : null,
        eps));
    }
    body.append(el('h3', { class: 'small muted', style: 'margin:22px 0 10px;letter-spacing:.12em' }, '아크 설계'), arcs);
    // 아크 검토
    for (const r of w.arcReviews || []) {
      const fl = el('div', { class: 'flist' });
      for (const f of r.findings || []) fl.append(finding(f));
      body.append(el('details', { class: 'box more', style: 'margin-top:16px' },
        el('summary', null, `아크 ${r.arcNumber} 종료 후 검토 · 점수 ${r.score} · 지적 ${(r.findings || []).length}건 (3화 집필 직후)`),
        el('p', { class: 'note', style: 'margin:8px 0' }, '1~3화를 이어 읽었을 때 반복되는 모양을 짚은 기록입니다. 자동 수정 사유가 아니라 다음 아크 설계 참고용입니다.'), fl));
    }
    // 웹툰 인터뷰
    const pickIds = ['W02', 'W04', 'W07', 'W08', 'W09', 'W12'];
    const ul = el('dl', { class: 'dl' });
    const lbl = { W02: '원작 보존', W04: '작화', W07: '대사·내면', W08: '정보 공개', W09: '부상·소품', W12: '위임 범위' };
    for (const d of w.webtoonDecisions.filter((x) => pickIds.includes(x.id))) ul.append(el('dt', null, lbl[d.id]), el('dd', null, d.value));
    body.append(el('div', { class: 'box', id: 'design-webtoon', style: 'margin-top:16px' }, el('h3', null, '웹툰 각색 인터뷰에서 정한 것'),
      el('p', { class: 'note' }, '각색을 시작하기 전 사람이 답한 항목입니다. 이후 모든 장면 계획과 검증이 이 원칙을 기준으로 삼습니다.'), ul));
  }

  /* ---------- 회차 ---------- */
  function renderTabs() {
    const box = $('#ptabs'); box.innerHTML = '';
    for (const e of D.episodes) {
      box.append(el('button', { class: 'eptab' + (e.chapter === state.ep ? ' active' : ''), role: 'tab', 'aria-selected': String(e.chapter === state.ep), onclick: () => { state.ep = e.chapter; state.scene = 's1'; renderEpisode(); writeHash(); } },
        el('span', null, `${e.chapter}화`), el('small', null, e.host)));
    }
    for (const b of document.querySelectorAll('#lane-seg button')) b.classList.toggle('active', b.dataset.lane === state.lane);
  }
  function renderEpisode() {
    renderTabs();
    const body = $('#ep-body'); body.innerHTML = '';
    if (state.lane === 'novel') renderNovel(body); else renderWebtoon(body);
  }

  function finding(f) {
    const who = f.characterId ? `${CHAR[f.characterId] || f.characterId} · ` : '';
    return el('div', { class: 'fitem' },
      el('div', { class: 'fh' }, el('b', null, who + codeLabel(f.code)), el('code', null, f.code || ''),
        f.confidence != null ? el('span', { class: 'tg' }, `확신 ${Math.round(f.confidence * 100)}%`) : null),
      el('p', null, f.message), f.evidence ? el('q', null, f.evidence) : null);
  }

  /* ----- 소설 ----- */
  function stepKind(op) {
    if (/plan|identity|contract/.test(op)) return 'k-plan';
    if (op === 'draft') return 'k-draft';
    if (op === 'revise') return 'k-rev';
    if (/continuity|check/.test(op)) return 'k-check';
    if (/boundary|summary/.test(op)) return 'k-end';
    return 'k-review';
  }
  function renderNovel(body) {
    const n = P.novel.find((x) => x.chapter === state.ep); const e = D.episodes.find((x) => x.chapter === state.ep);
    if (!n) { body.append(el('p', { class: 'note' }, '이 회차의 소설 워크플로 기록이 없습니다.')); return; }
    const total = n.steps.reduce((a, s) => a + (s.sec || 0), 0);
    // 헤더
    body.append(el('div', { class: 'box' },
      el('h3', null, `${n.chapter}화 · ${e.novelHost} · ${e.novelModel} · ${n.autonomy === 'auto' ? '자동 모드' : '승인 모드'}`),
      el('p', { class: 'big' }, `「${n.plan.title}」`), el('p', null, n.summary)));
    // 타임라인
    const tl = el('div', { class: 'tl' });
    for (const s of n.steps) tl.append(el('span', { class: stepKind(s.op), style: `flex:${Math.max(s.sec, total / 80)}`, title: `${s.label}${s.attempt > 1 ? ' (수정본)' : ''} · ${dur(s.sec)}` }, s.sec / total > 0.07 ? s.label : ''));
    const list = el('div', { class: 'tl-list' });
    for (const s of n.steps) list.append(el('div', null, el('span', null, s.label + (s.attempt > 1 ? ' · 수정본' : '')), el('em', null, dur(s.sec))));
    body.append(el('div', { class: 'box', id: 'nv-timeline', style: 'margin-top:16px' }, el('h3', null, `워크플로 타임라인 · 모델 작업 합계 ${dur(total)}`), tl, list,
      el('p', { class: 'note' }, '각 칸은 서버가 모델에게 일을 맡긴 단계입니다. 초고 뒤 검사·검토는 순서대로 모두 거쳐야 하며 건너뛸 수 없습니다.')));
    // 계획
    const pl = n.plan;
    const sc = el('div', { class: 'flist' });
    for (const s of pl.scenes || []) sc.append(el('div', { class: 'fitem' }, el('div', { class: 'fh' }, el('b', null, `장면 ${s.order} · ${s.location || ''}`)),
      el('p', null, s.situation), s.choice ? el('p', null, el('span', { class: 'muted' }, '선택/장애 · '), s.choice) : null, s.change ? el('p', null, el('span', { class: 'muted' }, '바뀌는 것 · '), s.change) : null));
    body.append(el('div', { class: 'cols', id: 'nv-plan', style: 'margin-top:16px' },
      el('div', { class: 'box' }, el('h3', null, '화별 계획 — 쓰기 전에 AI가 정한 것'),
        el('dl', { class: 'dl' },
          el('dt', null, '이번 화 전제'), el('dd', null, pl.premise),
          el('dt', null, '독자가 예상할 것'), el('dd', null, pl.likelyOutcome),
          el('dt', null, '실제 전환'), el('dd', null, pl.turn),
          el('dt', null, '해결이 남길 대가'), el('dd', null, [pl.cost?.immediate, pl.cost?.deferred].filter(Boolean).join(' / ')),
          el('dt', null, '지급할 보상'), el('dd', null, pl.payoff),
          el('dt', null, '다음 화 질문'), el('dd', null, pl.nextQuestion),
          pl.arcBeat ? [el('dt', null, '인물 변화'), el('dd', null, pl.arcBeat)] : null),
        el('div', { class: 'why' }, el('b', null, '포인트 '), '독자가 예상할 결과를 먼저 적어 두고, 그와 다른 전환과 대가를 설계합니다. 비평 단계는 본문이 이 계획을 실제로 지급했는지를 대조합니다.')),
      el('div', { class: 'box' }, el('h3', null, `계획한 장면 ${(pl.scenes || []).length}개`), sc)));
    // 규칙 검사·수정
    renderGate(body, n);
    // 비평가
    const rv = el('div', { class: 'box', id: 'nv-reviews', style: 'margin-top:16px' }, el('h3', null, '비평가 검토 — 원고를 읽은 AI의 지적'),
      el('p', { class: 'note' }, '비평은 기본적으로 참고(advisory)입니다. 작가의 의도일 수 있어 자동 수정 사유가 되지 않고, 확정 설정 위반·분량 같은 규칙 위반만 수정을 강제합니다.'));
    const attempts = [...new Set(n.reviews.map((r) => r.attempt))];
    for (const at of attempts) {
      if (attempts.length > 1) rv.append(el('h4', null, at === 1 ? '첫 원고에 대한 검토' : '수정본에 대한 검토'));
      for (const r of n.reviews.filter((x) => x.attempt === at)) {
        const [name, what] = REVIEWER[r.step] || [r.step, ''];
        const g = el('details', { class: 'rv-group', open: r.findings.length && at === attempts[attempts.length - 1] ? '' : null },
          el('summary', null, name, el('span', { class: 'cnt' }, r.findings.length ? `지적 ${r.findings.length}건` : '지적 없음'), el('span', { class: 'cnt' }, '· ' + what)));
        const fl = el('div', { class: 'flist' });
        for (const f of r.findings) fl.append(finding(f));
        if (r.findings.length) g.append(fl);
        rv.append(g);
      }
    }
    body.append(rv);
    // 커밋
    const rc = n.receipt; const inf = el('div', { class: 'flist' });
    for (const i of rc.influence || []) {
      const p = i.proof || {};
      inf.append(el('div', { class: 'fitem' },
        el('div', { class: 'fh' }, el('b', null, `${CHAR[i.characterId] || i.characterId}의 선택을 AI가 읽은 방식`)),
        i.anchor ? el('q', null, i.anchor) : null,
        el('p', null, i.interpretation),
        p.chosen ? el('p', null, el('span', { class: 'muted' }, '고른 것 · '), p.chosen) : null,
        (p.alternativesAvailable || []).length ? el('p', null, el('span', { class: 'muted' }, '고를 수 있었던 다른 길 · '), p.alternativesAvailable.join(' / ')) : null,
        p.costPaid ? el('p', null, el('span', { class: 'muted' }, '치른 대가 · '), p.costPaid) : null,
        (p.competingHypotheses || []).length ? el('p', null, el('span', { class: 'muted' }, '다르게 읽힐 가능성 · '), p.competingHypotheses.join(' / ')) : null,
        i.nextChoiceBias ? el('p', null, el('span', { class: 'muted' }, '다음 선택에 줄 영향 · '), i.nextChoiceBias) : null));
    }
    const hooks = el('div', { class: 'tags' });
    for (const h of rc.hooks || []) hooks.append(el('span', { class: 'tg' + (h.phase === 'planted' ? ' warn' : '') }, `${h.phase === 'planted' ? '새 떡밥' : h.phase === 'resolved' ? '회수' : '진행'} · ${h.text}`));
    const sco = n.scores || {};
    body.append(el('div', { class: 'cols', id: 'nv-commit', style: 'margin-top:16px' },
      el('div', { class: 'box' }, el('h3', null, '커밋과 다음 화 판단'),
        el('div', { class: 'tags' }, el('span', { class: 'tg ok' }, `규칙 위반 ${sco.hard ?? 0}`), el('span', { class: 'tg' }, `문장 리듬 ${sco.prosody ?? '–'}`), el('span', { class: 'tg' }, `논리 ${sco.coherence ?? '–'}`), el('span', { class: 'tg' }, `${sco.chars ?? '–'}자`)),
        el('p', null, el('b', null, { advance_episode: '→ 아크 안에서 다음 화로', complete_arc: '→ 이 화로 아크 완료', extend_arc: '→ 아크 연장' }[n.boundary.decision] || n.boundary.decision)),
        el('p', { class: 'small' }, n.boundary.reason),
        el('h4', null, '정본에 기록된 떡밥 상태'), hooks),
      el('div', { class: 'box' }, el('h3', null, '인물 해석 — 검사 영수증에 남은 판단'),
        el('p', { class: 'note' }, 'AI는 인물이 한 선택을 “다른 길도 있었는데 대가를 치르고 이것을 골랐다”는 증거로만 성격에 반영합니다. 반대 해석도 함께 남깁니다.'), inf)));
  }

  function renderGate(body, n) {
    const box = el('div', { class: 'box', id: 'nv-gate', style: 'margin-top:16px' }, el('h3', null, '규칙 검사와 수정'));
    const pols = n.policies || {};
    const first = pols[1] || pols['1'] || { blocking: [], advisory: [] };
    const blocking = first.blocking || [];
    if (!blocking.length) {
      box.append(el('p', null, el('span', { class: 'tg ok' }, '첫 원고 통과'), ' 확정 설정 충돌·분량 미달 같은 규칙 위반이 없어 수정 없이 커밋 단계로 갔습니다.'));
    } else {
      const a1 = n.attempts.find((a) => a.attempt === 1) || {}; const a2 = n.attempts.find((a) => a.attempt === 2) || {};
      box.append(el('div', { class: 'redesign' },
        el('div', { class: 'rh' }, '첫 원고가 규칙 검사에서 막혔습니다'),
        el('div', { class: 'tags' }, blocking.map((c) => el('span', { class: 'tg red' }, `${codeLabel(c)} (${c})`))),
        el('p', { class: 'small' }, `첫 원고 ${a1.chars}자, 확정 설정 충돌 ${a1.hard ?? '?'}건. 서버가 커밋을 거부하고 같은 워크플로 안에서 “필요한 최소 수정”을 요청했습니다.`),
        el('div', { class: 'arrow-row' }, el('span', { class: 'tg warn' }, `1차 ${a1.chars}자 · 위반 ${a1.hard}`), el('span', { class: 'ar' }, '→ 수정 →'), el('span', { class: 'tg ok' }, `2차 ${a2.chars}자 · 위반 ${a2.hard}`)),
        a2.preservation ? el('p', { class: 'small' }, `수정본은 원래 문단 ${a2.preservation.sourceParagraphs}개 중 ${a2.preservation.unchangedParagraphs}개(${Math.round(a2.preservation.unchangedParagraphRatio * 100)}%)를 그대로 두고, 글자 기준 ${Math.round(a2.preservation.charChangeRatio * 100)}%만 바꿨습니다. 다시 쓰기가 아니라 고치기인지 서버가 따로 확인합니다.`) : null));
      if (a1.prose && a2.prose) box.append(el('h4', null, '무엇이 바뀌었나 — 첫 원고와 수정본 비교'), el('div', { class: 'diff-legend' }, el('span', null, '+ 새로 쓴 문단'), el('span', null, '− 지운 문단'), el('span', null, '± 문단 안에서 고친 단어'), el('span', null, '회색 = 그대로 둔 문단')), diffView(a1.prose, a2.prose));
    }
    const adv = first.advisory || [];
    if (adv.length) {
      box.append(el('h4', null, `규칙 검사가 남긴 참고 신호 ${adv.length}개`),
        el('p', { class: 'note' }, '모델 없이 코드가 세는 신호입니다. 기록만 하고 커밋을 막지 않습니다.'),
        el('div', { class: 'tags' }, adv.map((c) => el('span', { class: 'tg', title: c }, codeLabel(c)))));
    }
    body.append(box);
  }

  function diffView(a, b) {
    const A = a.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean); const B = b.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
    const m = A.length; const n = B.length; const L = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const ops = []; let i = 0; let j = 0;
    while (i < m && j < n) { if (A[i] === B[j]) { ops.push(['same', A[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) ops.push(['del', A[i++]]); else ops.push(['add', B[j++]]); }
    while (i < m) ops.push(['del', A[i++]]); while (j < n) ops.push(['add', B[j++]]);
    const box = el('div', { class: 'diff' });
    let run = [];
    const flush = () => {
      if (!run.length) return;
      if (run.length <= 2) run.forEach((t) => box.append(el('p', { class: 'same' }, t)));
      else {
        const hidden = run.slice(); const btn = el('button', { class: 'fold', type: 'button' }, `변경 없는 문단 ${hidden.length}개 펼치기`);
        btn.addEventListener('click', () => { const frag = document.createDocumentFragment(); hidden.forEach((t) => frag.append(el('p', { class: 'same' }, t))); btn.replaceWith(frag); });
        box.append(btn);
      }
      run = [];
    };
    for (let x = 0; x < ops.length; x++) {
      const [k, t] = ops[x];
      if (k === 'same') { run.push(t); continue; }
      flush();
      // 삭제 바로 뒤 추가가 비슷한 문단이면 단어 단위로 합쳐 보여 준다
      const nx = ops[x + 1];
      if (k === 'del' && nx && nx[0] === 'add') {
        const w = wordDiff(t, nx[1]);
        if (w) { box.append(w); x++; continue; }
      }
      box.append(el('p', { class: k }, t));
    }
    flush();
    return box;
  }
  function wordDiff(a, b) {
    const A = a.split(/(\s+)/); const B = b.split(/(\s+)/);
    const m = A.length; const n = B.length; const L = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const same = A.filter((t) => t.trim()).length ? L[0][0] / Math.max(m, n) : 0;
    if (same < 0.5) return null;
    const p = el('p', { class: 'mod' }); let i = 0; let j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && A[i] === B[j]) { p.append(A[i]); i++; j++; }
      else if (i < m && (j >= n || L[i + 1][j] >= L[i][j + 1])) { p.append(el('del', null, A[i])); i++; }
      else { p.append(el('ins', null, B[j])); j++; }
    }
    return p;
  }

  /* ----- 웹툰 ----- */
  function renderWebtoon(body) {
    const e = D.episodes.find((x) => x.chapter === state.ep); const w = P.webtoon.find((x) => x.chapter === state.ep);
    const redesigns = w.scenes.reduce((a, s) => a + (s.redesigns || 0), 0);
    body.append(el('div', { class: 'box' },
      el('h3', null, `${e.chapter}화 · 각색 ${e.host} · ${e.model}${e.effort ? ' · ' + e.effort : ''} · 이미지 ${D.imageModel}`),
      el('p', null, `${e.sceneCount}장면 ${e.panelTotal}칸. 사전 검증이 막아 계획을 다시 짠 횟수 ${redesigns}회${w.blockedRuns.length ? `, 연출 지시 문제로 통째로 멈춘 장면 워크플로 ${w.blockedRuns.length}개` : ''}. 그림 검토 통과 ${e.passCount}/${e.sceneCount}.`),
      el('p', { class: 'note' }, '장면을 고르면 그 장면이 원문에서 그림이 되기까지 7단계를 순서대로 보여 줍니다. 오른쪽 숫자 배지는 재설계 횟수입니다.')));
    const strip = el('div', { class: 'strip', role: 'tablist', 'aria-label': '장면' });
    for (const s of e.scenes) {
      const ps = w.scenes.find((x) => x.id === s.id) || {};
      strip.append(el('button', { class: 'thumb' + (s.id === state.scene ? ' active' : ''), type: 'button', role: 'tab', 'aria-selected': String(s.id === state.scene), onclick: () => { state.scene = s.id; renderEpisode(); writeHash(); } },
        el('span', { class: 'im' }, el('img', { src: s.image, alt: `장면 ${s.n}`, loading: 'lazy' }),
          el('span', { class: 'mk ' + (s.verdict === 'pass' ? 'pass' : 'revise') }, s.verdict === 'pass' ? '통과' : '수정 필요'),
          ps.redesigns ? el('span', { class: 'rd', title: '사전 검증 재설계' }, `↺${ps.redesigns}`) : null),
        el('span', { class: 'cap' }, `${s.n}. ${s.title}`)));
    }
    body.append(strip);
    const s = e.scenes.find((x) => x.id === state.scene) || e.scenes[0];
    const ps = w.scenes.find((x) => x.id === s.id) || {};
    body.append(sceneDetail(e, s, ps, w));
  }

  function srcChip(id, units) {
    const short = id.replace(/^ch-\d+-p-/, 'p');
    return el('button', { class: 'src', type: 'button', 'data-src': id, title: '원문 보기', onclick: (ev) => showPop(ev.currentTarget, id, units) }, short);
  }
  function showPop(anchor, id, units) {
    const pop = $('#pop'); const u = units[id];
    if (!pop.classList.contains('hidden') && pop.dataset.id === id) { pop.classList.add('hidden'); return; }
    pop.innerHTML = ''; pop.dataset.id = id;
    pop.append(el('small', null, `원문 ${id.replace(/^ch-(\d+)-p-/, '$1화 문단 ')}`), u || '(이 장면 밖의 문단)');
    pop.classList.remove('hidden');
    const r = anchor.getBoundingClientRect(); const pw = Math.min(360, window.innerWidth - 24);
    pop.style.left = Math.max(12, Math.min(window.scrollX + r.left, window.scrollX + window.innerWidth - pw - 12)) + 'px';
    pop.style.top = (window.scrollY + r.bottom + 6) + 'px';
  }
  const withEn = (ko, en) => (ko && en && ko !== en) ? el('details', { class: 'more' }, el('summary', null, '영어 원문'), el('div', { class: 'en' }, en)) : null;

  function sceneDetail(e, s, ps, w) {
    const k = `e${e.chapter}.${s.id}`;
    const units = {}; for (const u of s.units) units[u.id] = u.text;
    const pl = s.plan || {};
    const texts = {}; for (const t of pl.texts || []) texts[t.id] = t;
    TEXTS = texts;
    const stepper = el('div', { class: 'stepper' });
    const st = (n, title, sub, kids, cls) => stepper.append(el('div', { class: 'st' + (cls ? ' ' + cls : ''), id: 'st-' + n }, el('div', { class: 'num' }, n), el('div', { class: 'body' }, el('div', { class: 'sh' }, el('b', null, title), sub ? el('span', null, sub) : null), kids)));

    // 1 장면 나누기
    const paras = el('div', { class: 'diff' }); for (const u of s.units) paras.append(el('p', null, el('span', { class: 'src', style: 'margin-right:8px;cursor:default' }, u.id.replace(/^ch-\d+-p-/, 'p')), u.text));
    st(1, '장면 나누기', `원문 문단 p${s.pFrom}–${s.pTo} · ${s.units.length}개`, [
      el('p', { class: 'small' }, el('span', { class: 'muted' }, 'AI가 이 묶음을 한 장면으로 본 이유 · '), trh(k + '.seg', ps.segmentNote)),
      withEn(KO[k + '.seg'], ps.segmentNote),
      el('details', { class: 'more' }, el('summary', null, '이 장면의 소설 원문 펼치기'), paras)]);

    // 2 사실 추출
    const facts = el('ul', { class: 'facts' });
    for (const f of pl.facts || []) facts.append(el('li', null, el('span', null, (f.sourceIds || []).map((id) => srcChip(id, units))), el('span', null, trh(`${k}.fact.${f.id}`, f.statement))));
    st(2, '원문에서 사실 뽑기', `${(pl.facts || []).length}개 · 각 사실은 근거 문단에 묶임`, [
      el('p', { class: 'note' }, '그림에 들어갈 모든 것은 먼저 “원문이 확정한 사실”로 적고, 근거 문단 번호를 붙입니다. 번호를 누르면 원문이 보입니다.'), facts]);

    // 3 의도와 비트
    const beats = el('div', { class: 'beats' });
    for (const b of pl.beats || []) {
      const ln = el('div', { class: 'ln' });
      for (const tid of b.textIds || []) { const t = texts[tid]; if (t) ln.append(el('div', { class: 'line' }, el('small', null, `${t.kind === 'caption' ? '자막' : t.kind === 'dialogue' ? '대사' : t.kind}${t.speaker && t.speaker !== 'narrator' ? ' · ' + (CHAR[t.speaker] || t.speaker) : ''}`), t.text)); }
      beats.append(el('div', { class: 'beat' }, el('div', null, (b.sourceIds || []).map((id) => srcChip(id, units)), ' ', trh(`${k}.beat.${b.id}`, b.action), (b.textIds || []).length ? ln : null)));
    }
    st(3, '연출 의도와 비트', `비트 ${(pl.beats || []).length}개 · 글자 ${(pl.texts || []).length}줄`, [
      el('div', { class: 'why' }, el('b', null, '이 장면의 의도 '), trh(k + '.intent', pl.intent)), withEn(KO[k + '.intent'], pl.intent),
      el('p', { class: 'note' }, '비트는 “보여 줄 순간”입니다. 대사·자막은 원문 문장을 그대로 가져와 해당 비트에 붙입니다. 원문에 없는 대사는 만들지 않습니다.'), beats]);

    // 4 불확실성
    const unc = el('ol', { class: 'unc' });
    (pl.uncertainties || []).forEach((u, i) => unc.append(el('li', null, trh(`${k}.unc.${i}`, u))));
    st(4, 'AI가 확신하지 못한 것', `${(pl.uncertainties || []).length}개 · 스스로 적은 한계`, [
      el('p', { class: 'note' }, '원문이 명시하지 않아 추론으로 채운 부분을 AI가 따로 적어 둡니다. 확정 사실과 섞이지 않게 하려는 장치입니다.'), unc]);

    // 5 사전 검증
    const pf = el('div', { class: 'checks' });
    for (const c of ps.preflight || []) {
      const [nm, q] = CHECK[c.name] || [c.name, ''];
      pf.append(el('div', { class: 'chk' + (c.passed ? '' : ' fail') }, el('div', { class: 'ch' }, el('b', null, nm), el('span', { class: 'tg ' + (c.passed ? 'ok' : 'warn') }, c.passed ? '통과' : '막힘')),
        el('p', { class: 'muted small' }, q), el('details', { class: 'more' }, el('summary', null, '검증자의 근거'), el('p', { class: 'small', style: 'margin-top:6px;line-height:1.7' }, trh(`${k}.pf.${c.name}`, c.evidence)), withEn(KO[`${k}.pf.${c.name}`], c.evidence))));
    }
    const kids5 = [el('p', { class: 'note' }, '이미지 모델을 부르기 전에, 다른 AI 호출이 계획을 원문과 대조합니다. 하나라도 막히면 그리지 않고 계획을 다시 짭니다. 그림을 그린 뒤에야 원문과 어긋난 걸 발견하는 일을 줄이기 위한 관문입니다.')];
    if (ps.redesigns) {
      const bb = el('div', { class: 'redesign' }, el('div', { class: 'rh' }, `첫 계획이 막혀 ${ps.redesigns}번 재설계했습니다`));
      for (const c of ps.blockedBefore || []) {
        const [nm] = CHECK[c.name] || [c.name];
        bb.append(el('div', null, el('span', { class: 'tg red' }, `${nm} 막힘`), el('p', { class: 'small', style: 'margin:6px 0 0;line-height:1.7' }, trh(`${k}.blk.${c.name}`, c.evidence)), withEn(KO[`${k}.blk.${c.name}`], c.evidence)));
      }
      if ((ps.panelHistory || []).length > 1) bb.append(el('div', { class: 'arrow-row' }, el('span', { class: 'muted small' }, '칸 수 변화'), ps.panelHistory.map((p, i) => [i ? el('span', { class: 'ar' }, '→') : null, el('span', { class: 'tg' + (i === ps.panelHistory.length - 1 ? ' ok' : '') }, `${p}칸`)])));
      bb.append(el('p', { class: 'note' }, (ps.blockedBefore || []).length ? '마지막으로 막혔던 계획의 사유입니다. 재설계한 계획이 아래 4항목을 모두 통과한 뒤에야 그림을 그렸습니다.' : '재설계 기록은 남았지만 막힌 사유 원문은 워크플로에 보존되지 않았습니다.'));
      kids5.push(bb);
    }
    if ((ps.rejections || []).length) kids5.push(el('p', { class: 'note' }, '형식 반려: ' + ps.rejections.map((r) => REJECT_KO[r] || r).join(' · ') + ' — 서버가 규격에 맞지 않는 응답을 받아들이지 않고 다시 요청한 기록입니다.'));
    kids5.push(pf);
    const pfOk = (ps.preflight || []).every((c) => c.passed);
    st(5, '사전 검증', `${ps.preflightRounds || 1}회 실행${ps.redesigns ? ` · 재설계 ${ps.redesigns}회` : ''}`, kids5, ps.redesigns ? 'warn' : (pfOk ? 'ok' : ''));

    // 6 이미지
    const mom = el('ol', { class: 'unc' });
    for (const m of (s.brief || {}).moments || []) mom.append(el('li', null, m.action));
    st(6, '이미지 생성', `${s.panelCount}칸 · ${s.timings?.imageS ? s.timings.imageS + '초' : ''}${s.imageUsd ? ' · $' + s.imageUsd.toFixed(2) : ''}`, [
      el('p', { class: 'small' }, `검증을 통과한 계획을 이미지 모델용 브리프로 바꿔 한 번 호출합니다. 칸 수는 계획 단계에서 AI가 정했고(${s.panelCount}칸), 말풍선·자막 글자도 그림 안에 함께 그립니다.`),
      el('details', { class: 'more' }, el('summary', null, `이미지 모델에 넘긴 순간 ${((s.brief || {}).moments || []).length}개와 화풍 지시(영어 원문)`), el('div', { class: 'en' }, (s.brief || {}).style || ''), mom)]);

    // 7 검토
    const fl = el('div', { class: 'flist' });
    for (const f of s.findings || []) fl.append(el('div', { class: 'fitem' }, el('div', { class: 'fh' }, el('span', { class: 'fl ' + (f.severity === 'blocking' ? 'b' : 'a') }, f.severity === 'blocking' ? '차단' : '참고'), el('b', null, f.layerLabel || '')), el('p', null, f.ko || f.en), withEn(f.ko, f.en)));
    const obs = el('table', { class: 'obs' }, el('tr', null, el('th', null, '계획한 글자'), el('th', null, '그림에서 읽힌 글자'), el('th', null, '판정')));
    for (const o of (s.review || {}).textObservations || []) {
      const t = texts[o.id] || {};
      const bad = !o.readable || !o.speakerCorrect || (t.text && o.observedText && t.text !== o.observedText);
      obs.append(el('tr', null, el('td', { class: 't' }, t.text || o.id), el('td', { class: 't' + (bad ? ' bad' : '') }, o.observedText || '(안 보임)'),
        el('td', null, !o.readable ? '못 읽음' : !o.speakerCorrect ? '화자 틀림' : (t.text && o.observedText && t.text !== o.observedText) ? '글자 다름' : '일치')));
    }
    st(7, '그림 검토', `차단 ${s.blocking} · 참고 ${s.advisory} · 글자 ${s.textsOk}/${s.textsTotal} 일치`, [
      el('p', { class: 'note' }, '다른 AI 호출이 완성 이미지를 실제로 열어 계획·원문과 대조합니다. 차단이 하나라도 있으면 “수정 필요”로 판정하지만, 이 공개본은 재생성 없이 첫 결과를 그대로 싣습니다.'),
      (s.findings || []).length ? fl : el('p', null, el('span', { class: 'tg ok' }, '지적 없음')),
      el('details', { class: 'more' }, el('summary', null, `글자 대조표 (${(s.review || {}).textObservations?.length || 0}줄)`), obs)], s.verdict === 'pass' ? 'ok' : 'warn');

    // side
    const tb = el('div', { class: 'tbar' }); const tmax = Math.max(1, ...(ps.timings || []).map((t) => t.sec));
    for (const t of ps.timings || []) tb.append(el('div', { class: 'r' }, el('span', null, STEP_KO[t.step] || t.step), el('i', { class: t.step.includes('preflight') ? 'pf' : t.step.includes('review') ? 'rv' : '', style: `width:${Math.max(4, (t.sec / tmax) * 100)}%` }), el('em', null, dur(t.sec))));
    const side = el('aside', { class: 'side' },
      el('img', { src: s.image, alt: `${e.chapter}화 장면 ${s.n} ${s.title}` }),
      el('div', { class: 'meta' }, el('b', null, `${s.n}. ${s.title}`), el('br'), `판정 ${s.verdict === 'pass' ? '통과' : '수정 필요'} · ${s.panelCount}칸 · `, el('a', { href: `./#ep${e.chapter}/${s.id}` }, '웹툰 뷰어에서 보기')),
      (ps.timings || []).length ? el('div', { class: 'box', style: 'padding:12px 14px' }, el('h3', null, '단계별 소요 시간'), tb) : null);
    return el('div', { class: 'scene-detail' }, stepper, side);
  }

  /* ---------- 작업 중 바뀐 것 ---------- */
  function renderChanges() {
    const box = $('#changes-body'); box.innerHTML = '';
    const items = [
      { c: 3, s: 's4', t: '연출 지시가 원문보다 앞서 가서 검증이 세 번 막음', d: '3화 공통 연출 지시에 “밤 바위 통로 → 새벽 옆길 → 산중 거점”이라는 여정을 적어 두었는데, 한 장면 발췌는 거기까지 가지 않았습니다. 사전 검증이 “원문에 없는 시간·장소를 그리라는 지시”로 세 번 막았고, 사람이 지시를 “발췌가 도달한 곳까지만”으로 바꿔 s4부터 적용했습니다. 막힌 워크플로는 지우지 않고 보관했습니다.' },
      { c: 4, s: 's1', t: '같은 유형의 여정 지시가 4화 첫 장면에서도 막힘', d: '수레·짐승·장부 탁자·갈림길 굽이까지 한 번에 적은 지시를 첫 장면 발췌(p1–9)가 다 보여 주지 않아 검증이 막았습니다. 지시를 발췌 중립 문구로 바꾸고 s1을 새 워크플로로 다시 시작했습니다.' },
      { c: 4, s: 's2', t: '추론 강도를 high → medium으로 낮춤', d: '4화 각색 모델(Grok 4.7) high 설정이 호출당 계획 약 460초·검증 약 490초로 3화의 세 배였습니다. 사용자 승인 후 s2부터 medium으로 바꿨습니다. s1은 전부 high로 만들었습니다.' },
    ];
    const g = el('div', { class: 'box' }, el('div', { class: 'chg' }, items.map((i) => {
      const raw = (P.directionChanges || []).find((x) => x.chapter === i.c && x.scene === i.s);
      return [el('div', { class: 'when' }, el('b', null, `${i.c}화 ${i.s}`), raw ? raw.at.slice(0, 16).replace('T', ' ') + ' UTC' : ''),
        el('div', null, el('b', null, i.t), el('p', { style: 'margin:4px 0 0' }, i.d),
          raw && raw.old ? el('details', { class: 'more' }, el('summary', null, '바뀐 지시 원문(영어)'), el('div', { class: 'en' }, '이전: ' + raw.old + '\n\n이후: ' + raw.new)) : null)];
    })));
    box.append(g, el('p', { class: 'note', style: 'margin-top:10px' }, '이 밖의 판단(장면 분할, 계획, 검증, 검토 판정)은 모두 AI가 내렸습니다. 일부 장면의 이미지 재호출은 실행 환경 오류로 그림이 아예 나오지 않은 경우뿐이며, 사람이 여러 결과 중 고르거나 마음에 들지 않아 다시 뽑은 적은 없습니다.'));
  }

  /* ---------- 해시 ---------- */
  function writeHash() { history.replaceState(null, '', `#ep${state.ep}/${state.lane}${state.lane === 'webtoon' ? '/' + state.scene : ''}`); }
  function readHash() {
    const m = location.hash.match(/#ep(\d)\/(novel|webtoon)(?:\/(s\d+))?/);
    if (m) { state.ep = +m[1]; state.lane = m[2]; state.scene = m[3] || 's1'; return true; }
    return false;
  }

  Promise.all([fetch('process.json').then((r) => r.json()), fetch('data.json').then((r) => r.json())]).then(([p, d]) => {
    P = p; D = d; KO = p.ko || {};
    const deep = readHash();
    renderStats(); renderLanes(); renderDesign(); renderEpisode(); renderChanges();
    $('#built').textContent = (p.builtAt || '').slice(0, 10);
    for (const b of document.querySelectorAll('#lane-seg button')) b.addEventListener('click', () => { state.lane = b.dataset.lane; store.set('tt.proc.lane', state.lane); renderEpisode(); writeHash(); });
    document.addEventListener('click', (ev) => { if (!ev.target.closest('.src') && !ev.target.closest('#pop')) $('#pop').classList.add('hidden'); });
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') $('#pop').classList.add('hidden'); });
    if (deep) requestAnimationFrame(() => $('#episode').scrollIntoView());
    window.addEventListener('hashchange', () => { if (readHash()) { renderEpisode(); $('#episode').scrollIntoView(); } });
  }).catch((err) => {
    $('#ep-body').append(el('p', { class: 'note' }, '데이터를 불러오지 못했습니다: ' + err.message));
  });
})();
