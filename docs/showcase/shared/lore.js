/* 인물·설정 사전 — 작품 정본(characters/)과 .vibelore 기록에서 뽑은 <작품>/lore.json을 '읽는 화 시점'까지만 보여준다.
   리더: Lore.attachReader({ lore, dict }) → 본문 도구줄에 켜기 버튼. 켜면 본문 속 이름을 누를 수 있고, 누르면 카드가 열린다.
   사전 페이지: Lore.load(url).then(db => Lore.card(db, entry, upto)).
   화 기준: 리더에서 N화를 읽는 중이면 N-1화까지를 보여주고 N화 변화는 접어 둔다. 사전은 고른 화까지 모두 보여준다. */
(function () {
  const T = (s, v) => (window.T ? window.T(s, v) : s.replace(/\{(\w+)\}/g, (m, k) => (v && v[k] != null ? v[k] : m)));
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : String(k));
    return n;
  }
  const ko = (tag, attrs, ...kids) => el(tag, Object.assign({ lang: 'ko' }, attrs), ...kids);

  const FIELD = {
    description: '설명', state: '상태', knownBy: '아는 사람', owner: '소유·관리', location: '위치', holder: '가진 사람', when: '때',
    participants: '관련 인물', author: '작성자', type: '종류', role: '역할', tier: '비중', rarity: '희귀도', species: '종족',
    rule: '규칙', climate: '분위기', level: '등급', parent: '상위', issuer: '발행', result: '결과', trigger: '계기',
    writingNote: '집필 메모', constraint: '제약', disposition: '성향', context: '맥락', habitat: '서식지', evidence: '근거',
    source: '출처', closingDate: '닫히는 날', position: '자리', relatedPlaces: '이어진 곳', schedule: '일정',
    emotionDisplay: '감정 표현', knownMembers: '알려진 구성원', note: '메모', behavior: '행동', speechStyle: '말씨',
    stance: '입장', cover: '위장', notableDetail: '눈여겨볼 점', relationToProtagonist: '주인공과의 관계', comment: '댓글',
    views: '조회수', effect: '효과', requester: '요청한 사람', requestedBy: '요청한 사람', title: '제목', subject: '대상',
    reach: '도달', condition: '조건', channel: '채널', reason: '이유', requirement: '요건',
    form: '형태', ageBand: '나이대', birthOrder: '서열', gender: '성별',
    valueOrder: '가치 순서', behaviorTraits: '행동 경향', actionBias: '기울기', benefit: '얻는 것', cost: '치르는 것',
    perception: '지각', seesFirst: '먼저 보는 것', missesFirst: '놓치는 것', defense: '방어', public: '평소',
    underPressure: '압박 속', repair: '관계 회복', firstMove: '첫 수', cannotDo: '못 하는 것', privateDelights: '혼자만의 기쁨',
    unproductiveWant: '쓸모없는 바람', dimensionBaselines: '출발 수치', genreDetails: '장르 설정',
    defaultRegister: '기본 말씨', sentenceShape: '문장 모양', logicHabit: '사고 습관', emotionalLeak: '감정이 새는 곳',
    samples: '예문', everyday: '평소', lying: '거짓말', intimate: '가까운 사이', relationVariants: '상대별 변주',
    targetId: '상대', adjustment: '조정', sample: '예문',
  };
  const EVENT = { registered: '처음 기록', changed: '바뀜', mentioned: '언급', status: '상태 변화', alias: '새 이름', planted: '심음', advanced: '진전', advancing: '진전', paid: '회수', parked: '보류' };
  const STATUS = { secret: '비밀', public: '공개됨', partial: '일부 드러남', pending: '예정', happened: '일어남', prevented: '막음', altered: '바뀜' };
  const REGISTER = { formal: '존대', polite: '공손', intimate: '친밀', playful: '장난', 'playful-formal': '장난 섞인 존대', plain: '평어', subordinate: '아랫사람 말투' };
  const BEAT = { wound: '상처', attempt: '시도', collapse: '무너짐', companion: '동행', 'self-choice': '스스로 고름', echo: '메아리' };
  const HORIZON = { next: '다음 화쯤', soon: '곧', arc: '아크 안에서' };
  const GROUP = { character: '인물', objects: '장소·물건', knowledge: '비밀·사건', scheduled: '예정된 일', hook: '떡밥·복선' };
  const label = (map, k) => (map[k] ? T(map[k]) : k);

  /* ---------- 데이터 ---------- */
  const cache = {};
  function load(url) {
    if (!cache[url]) cache[url] = fetch(url, { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(index);
    return cache[url];
  }
  function index(db) {
    db.byId = {};
    for (const c of db.characters) { c.kind = 'character'; db.byId[c.id] = c; }
    for (const r of db.records) { r.kind = r.group; db.byId[r.id] = r; }
    for (const h of db.hooks) { h.kind = 'hook'; h.name = h.id; h.since = h.planted; db.byId[h.id] = h; }
    return db;
  }
  const nameOf = (db, id) => (db.byId[id] ? db.byId[id].name : id || '?');
  const cleanAlias = (a) => a.replace(/\s*\(.*?\)\s*$/, '').trim();
  /* 본문에서 누를 수 있는 이름: 인물(별칭 포함)과 장소·물건. 한 글자 이름은 다른 낱말과 겹쳐서 뺀다. */
  function terms(db, upto) {
    const out = [];
    const add = (t, id) => { t = cleanAlias(t); if (t.length >= 2) out.push([t, id]); };
    for (const c of db.characters) if (c.since <= upto) { add(c.name, c.id); if (c.short) add(c.short, c.id); for (const a of c.aliases) add(a, c.id); }
    for (const r of db.records) if (r.group === 'objects' && r.since <= upto) {
      add(r.name, r.id); for (const a of r.aliases) if (a.ch <= upto) add(a.t, r.id);
    }
    out.sort((a, b) => b[0].length - a[0].length);
    return out;
  }
  function recordState(r, upto) {
    const f = {}; let status = null;
    for (const e of r.ev) if (e.ch <= upto) { if (e.set) Object.assign(f, e.set); if (e.status) status = e.status; }
    return { fields: f, status };
  }
  const latest = (list, upto) => { let x = null; for (const v of list || []) if (v.ch <= upto) x = v; return x; };

  /* ---------- 카드 ---------- */
  function kv(obj, db) {
    const dl = el('dl', { class: 'lore-kv' });
    for (const [k, v] of Object.entries(obj || {})) {
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
      dl.append(el('dt', FIELD[k] ? null : { lang: 'ko' }, label(FIELD, k)), el('dd', null, value(v, db)));
    }
    return dl;
  }
  function value(v, db) {
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x !== 'object')) return ko('ul', { class: 'lore-list' }, v.map((x) => el('li', null, String(x))));
      return el('div', { class: 'lore-stack' }, v.map((x) => el('div', { class: 'lore-sub' }, x && x.targetId ? kv(Object.assign({}, x, { targetId: nameOf(db, x.targetId) }), db) : value(x, db))));
    }
    if (v && typeof v === 'object') return kv(v, db);
    return ko('span', null, String(v));
  }
  function fold(title, count, body, open) {
    const d = el('details', { class: 'lore-fold' }, el('summary', null, title, count != null ? el('small', null, ' ' + count) : null), body);
    if (open) d.open = true;
    return d;
  }
  function timeline(items) {
    return el('ol', { class: 'lore-tl' }, items.map((x) => el('li', null,
      el('b', null, x.ch ? T('{n}화', { n: x.ch }) : T('설계')), el('span', { class: 'lore-ev', lang: x.tagKo ? 'ko' : null }, x.tag || ''), ko('span', null, x.text || ''))));
  }
  const evItems = (evs) => evs.map((e) => ({
    ch: e.ch, tag: label(EVENT, e.e) + (e.status ? ' · ' + label(STATUS, e.status) : ''),
    text: [e.note, e.alias ? '“' + e.alias + '”' : null, e.set && !e.note ? Object.values(e.set).join(' · ') : null, e.evidence ? '— ' + e.evidence : null].filter(Boolean).join(' '),
  }));

  function characterBody(db, c, upto, only) {
    const inRange = (ch) => (only ? ch === only : ch <= upto);
    const box = el('div');
    const k = db.knows && db.knows[c.id];
    const facts = k ? k.facts.filter((x) => inRange(x.ch)) : [];
    const loc = k && k.loc ? (only ? k.loc.filter((x) => x.ch === only).pop() : latest(k.loc, upto)) : null;
    if (loc) box.append(kv({ location: loc.v }));
    const rel = db.relations.filter((r) => r.from === c.id || r.to === c.id).map((r) => {
      const s = only ? r.ch.filter((x) => x.ch === only).pop() : latest(r.ch, upto); if (!s) return null;
      const who = r.from && r.from !== c.id ? nameOf(db, r.from) : r.to !== c.id ? nameOf(db, r.to) : nameOf(db, r.from);
      return { ch: s.ch, tag: who + ' · ' + s.kind, tagKo: true, text: s.state };
    }).filter(Boolean);
    const addr = db.address.filter((a) => a.from === c.id || a.to === c.id).map((a) => {
      const s = only ? a.ch.filter((x) => x.ch === only).pop() : latest(a.ch, upto); if (!s) return null;
      return { ch: s.ch, tag: `${nameOf(db, a.from)} → ${nameOf(db, a.to)}`, tagKo: true, text: `“${s.term}” · ${label(REGISTER, s.register)}` };
    }).filter(Boolean);
    const arc = (db.arcs[c.id] || []).filter((x) => inRange(x.ch)).map((x) => ({ ch: x.ch, tag: label(BEAT, x.beat), text: x.note }));
    if (arc.length) box.append(fold(T('아크 위치'), arc.length, timeline(arc), !!only));
    if (rel.length) box.append(fold(T('관계'), rel.length, timeline(rel)));
    if (addr.length) box.append(fold(T('호칭'), addr.length, timeline(addr)));
    if (facts.length) box.append(fold(T('이 인물이 아는 것'), facts.length, timeline(facts.slice().reverse().map((x) => ({ ch: x.ch, text: x.f })))));
    return box.childNodes.length ? box : null;
  }

  function card(db, entry, upto, current) {
    const e = entry; const wrap = el('article', { class: 'lore-card', 'data-kind': e.kind });
    const since = e.since || 0;
    const head = el('header', null,
      el('span', { class: 'lore-kind' }, e.kind === 'character' ? T('인물') : e.kind === 'hook' ? T('떡밥·복선') : T(e.label || GROUP[e.kind])),
      e.kind !== 'hook' ? ko('h3', null, e.name) : null);
    wrap.append(head);
    // 인물 카드의 외형·설명·극적 모델은 연재 전 설계라 화 기준으로 가리지 않는다(어느 이름을 누를 수 있는지는 terms가 정한다)
    if (e.kind !== 'character' && since > upto) {
      wrap.append(el('p', { class: 'lore-note' }, T('{n}화에 처음 나옵니다. 이 화를 다 읽은 뒤 아래를 펼치세요.', { n: since })));
    } else if (e.kind === 'character') {
      if (e.aliases.length) head.append(ko('p', { class: 'lore-alias' }, e.aliases.join(' · ')));
      wrap.append(kv(e.info));
      if (e.appearance.length) wrap.append(el('h4', null, T('외형')), value(e.appearance));
      if (e.contradiction) wrap.append(el('h4', null, T('모순')), ko('p', null, e.contradiction));
      if (e.description) wrap.append(el('h4', null, T('설명')), ko('p', null, e.description));
      const now = characterBody(db, e, upto); if (now) wrap.append(now);
      if (e.model) wrap.append(fold(T('극적 모델 (작품 설계)'), null, kv(e.model, db)));
      if (e.voice) wrap.append(fold(T('말투 프로필 (작품 설계)'), null, kv(e.voice, db)));
    } else if (e.kind === 'hook') {
      const txt = latest(e.text, upto); const evs = e.ev.filter((x) => x.ch <= upto);
      const paid = evs.find((x) => x.e === 'paid');
      wrap.append(ko('p', { class: 'lore-hook' }, txt ? txt.v : ''));
      wrap.append(kv({ [T('심은 화')]: T('{n}화', { n: e.planted }), [T('상태')]: paid ? T('{n}화에 회수', { n: paid.ch }) : evs.find((x) => x.e === 'parked') ? T('보류') : T('열림'), [T('회수 예정')]: paid ? null : label(HORIZON, e.horizon) }));
      if (evs.length > 1) wrap.append(fold(T('화별 기록'), evs.length, timeline(evItems(evs))));
    } else {
      const st = recordState(e, upto);
      const al = e.aliases.filter((a) => a.ch <= upto).map((a) => a.t);
      if (al.length) head.append(ko('p', { class: 'lore-alias' }, al.join(' · ')));
      if (st.status && STATUS[st.status]) head.append(el('span', { class: 'lore-status' }, label(STATUS, st.status)));
      wrap.append(kv(st.fields));
      const evs = e.ev.filter((x) => x.ch <= upto && x.e !== 'registered');
      if (evs.length) wrap.append(fold(T('화별 기록'), evs.length, timeline(evItems(evs))));
    }
    if (current) {
      let later = null;
      if (e.kind === 'character') later = characterBody(db, e, current, current);
      else if (e.kind === 'hook') { const x = e.ev.filter((v) => v.ch === current); if (x.length) later = timeline(evItems(x)); }
      else { const x = e.ev.filter((v) => v.ch === current); if (x.length) later = timeline(evItems(x)); }
      if (later) wrap.append(fold(T('{n}화에서 생긴 변화 — 다 읽은 뒤 펼치세요', { n: current }), null, later));
    }
    return wrap;
  }

  /* ---------- 본문 링크 ---------- */
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function link(root, db, ch) {
    const list = terms(db, ch); if (!list.length) return;
    const map = new Map(list); const re = new RegExp(list.map((x) => esc(x[0])).join('|'), 'g');
    const groups = root.querySelectorAll('.pgroup').length ? root.querySelectorAll('.pgroup') : [root];
    for (const g of groups) {
      // 처리 표시는 단락에 둔다 — 시트처럼 같은 상자에 내용만 갈아 끼우는 곳도 새 단락은 다시 잇는다
      const seen = new Set();
      for (const p of g.querySelectorAll('p')) {
        if (p.dataset.lore === String(ch)) { for (const b of p.querySelectorAll('.lore-term')) seen.add(b.dataset.lore); continue; }
        p.dataset.lore = String(ch);
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); const nodes = [];
        while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('.lore-term')) nodes.push(walker.currentNode);
        for (const node of nodes) {
          const s = node.nodeValue; let m; let last = 0; const frag = document.createDocumentFragment(); let hit = false;
          re.lastIndex = 0;
          while ((m = re.exec(s))) {
            const id = map.get(m[0]); if (seen.has(id)) continue;
            seen.add(id); hit = true;
            frag.append(s.slice(last, m.index), el('button', { type: 'button', class: 'lore-term', 'data-lore': id }, m[0]));
            last = m.index + m[0].length;
          }
          if (hit) { frag.append(s.slice(last)); node.replaceWith(frag); }
        }
      }
    }
  }
  function unlink(root) {
    for (const b of root.querySelectorAll('.lore-term')) b.replaceWith(b.textContent);
    for (const p of root.querySelectorAll('p[data-lore]')) delete p.dataset.lore;
    root.normalize();
  }

  /* ---------- 리더 부착 ---------- */
  function attachReader(opt) {
    const STORE = 'lore.on';
    const get = () => { try { return localStorage.getItem(STORE) === '1'; } catch (e) { return false; } };
    const put = (v) => { try { localStorage.setItem(STORE, v ? '1' : '0'); } catch (e) { /* 저장 불가 */ } };
    const roots = (opt.roots || ['#prose', '#sheet-body']).map((s) => document.querySelector(s)).filter(Boolean);
    const prose = roots[0]; let on = get(); let db = null; let lastFocus = null;
    const chapter = () => +(prose.dataset.chapter || 1);
    // 데스크톱은 본문 도구줄, 모바일은 아래 시트 도구줄에 같은 켜기 버튼을 둔다
    const btns = [];
    for (const sel of opt.tools || ['.prose-tools', '.sheet .mtools']) {
      const tools = document.querySelector(sel); if (!tools) continue;
      const b = el('button', { type: 'button', class: 'lore-toggle', 'aria-pressed': String(on), title: T('본문 속 인물·장소 이름을 눌러 설정을 봅니다') }, T('인물·설정'));
      b.addEventListener('click', () => set(!on));
      if (sel === '.prose-tools') tools.insertBefore(b, tools.lastElementChild); else tools.append(b);
      btns.push(b);
    }

    const panel = el('aside', { class: 'lore-panel', hidden: '', 'aria-label': T('인물·설정'), tabindex: '-1' });
    const pbody = el('div', { class: 'lore-panel-body' });
    const dictLink = el('a', { class: 'lore-dict' }, T('사전에서 전체 보기 →'));
    panel.append(el('div', { class: 'lore-panel-head' }, el('b', { class: 'lore-scope' }), el('button', { type: 'button', class: 'lore-close', onclick: close }, T('닫기'))), pbody, dictLink);
    document.body.append(panel);
    function close() { panel.hidden = true; if (lastFocus) lastFocus.focus(); }
    function open(id, from) {
      const e = db.byId[id]; if (!e) return; const ch = chapter();
      lastFocus = from; pbody.innerHTML = '';
      panel.querySelector('.lore-scope').textContent = ch > 1 ? T('{n}화까지의 기록', { n: ch - 1 }) : T('연재 전 작품 설계');
      pbody.append(card(db, e, ch - 1, ch));
      dictLink.href = `${opt.dict}&ch=${ch - 1}#${encodeURIComponent(id)}`;
      if (window.I18N) I18N.apply(panel);
      panel.hidden = false; panel.focus();
    }
    function relink() { if (on && db) for (const r of roots) link(r, db, chapter()); }
    function set(v) {
      on = v; put(v); for (const b of btns) b.setAttribute('aria-pressed', String(v)); document.body.classList.toggle('lore-on', v);
      if (!v) { for (const r of roots) unlink(r); panel.hidden = true; return; }
      load(opt.lore).then((d) => { db = d; relink(); }).catch(() => { for (const b of btns) { b.disabled = true; b.title = T('설정 데이터를 불러오지 못했습니다'); } });
    }
    document.addEventListener('click', (ev) => { const t = ev.target.closest && ev.target.closest('.lore-term'); if (t && db) open(t.dataset.lore, t); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !panel.hidden) close(); });
    let queued = 0;
    const mo = new MutationObserver(() => { clearTimeout(queued); queued = setTimeout(relink, 0); });
    for (const r of roots) mo.observe(r, { childList: true });
    try { localStorage.setItem('lore.read.' + opt.work, String(chapter())); } catch (e) { /* 저장 불가 */ }
    window.addEventListener('hashchange', () => setTimeout(() => { try { localStorage.setItem('lore.read.' + opt.work, String(chapter())); } catch (e) { /* 저장 불가 */ } }, 50));
    if (on) set(true);
  }

  window.Lore = { load, card, terms, attachReader, GROUP, latest, recordState, el, ko, label, HORIZON };
})();
