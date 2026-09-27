/**
 * A deterministic long-running work for input-size guards. Growth follows
 * the thundertrail chapters 1-7 rates, kept pessimistic: a supporting
 * character every 8 chapters (one in ten dead), one hook per chapter that is
 * never paid, three ledger records, one relationship and half an address term.
 *
 * Planted needles must survive any trimming: an old dead character the plan
 * names, an old open hook and an old item the prose touches, and a
 * supporting character who speaks in the prose.
 */
const core = (id, canonicalName, role) => ({
  id, canonicalName, aliases: [], registeredAtChapter: 1, contradiction: `${canonicalName}의 모순`,
  intrinsic: { gender: 'female', ageBand: '20대', role, coreAppearance: ['짧은 머리'] }, mutable: { status: 'alive', knownFacts: [] },
});

export function longRunWork(chapters) {
  const characters = [core('c1', '리아', '주인공'), core('c2', '도윤', '동료'), core('c3', '보리', '마수'), core('c4', '마렌', '운송인')];
  const characterStates = {
    c1: { location: '거점', status: '손목 부상', knownFacts: ['표식은 이동 방향이다'] },
    c2: { location: '거점', status: '경계' }, c3: { location: '가방', status: '졸림' }, c4: { location: '마당', status: '짐 정리' },
  };
  const extras = Math.floor(chapters / 8);
  for (let i = 0; i < extras; i += 1) {
    characters.push({ ...core(`x${i}`, `조연${i}`, '조연'), registeredAtChapter: 8 + i * 8 });
    characterStates[`x${i}`] = { location: `장소${i}`, status: '이동 중', vitalStatus: i % 10 === 0 ? 'dead' : 'alive', knownFacts: [`사실${i}`] };
  }
  const hooks = [{ id: 'red-lamp', text: '붉은 등불은 누가 껐는가', status: 'open', plantedAtChapter: 3, lastMovedChapter: 3 }];
  const record = (id, name, fields, chapter) => ({ id, feature: 'objects', label: 'Artifact', name, aliases: [], status: 'active', fields,
    registeredAt: chapter, lastEventAt: chapter, recent: [{ chapter, event: 'registered' }] });
  const records = [record('silver-key', '은빛 열쇠', { holder: 'x5', state: '녹슨 채 보관' }, 4)];
  const relationships = [];
  const entries = { 'c1->c2': { term: '도윤', sinceChapter: 1, register: 'intimate' } };
  for (let c = 8; c <= chapters; c += 1) {
    hooks.push({ id: `h${c}`, text: `${c}화 고개의 남은 질문`, status: 'open', plantedAtChapter: c, lastMovedChapter: c });
    for (let k = 0; k < 3; k += 1) records.push(record(`it${c}-${k}`, `${c}화 물건${k}`, { holder: `x${c % Math.max(1, extras)}`, state: `${c}화 물건 상태` }, c));
    relationships.push({ from: `x${c % Math.max(1, extras)}`, to: 'c1', kind: '경계', state: `${c}화 이후 확인` });
    if (c % 2) entries[`x${c % Math.max(1, extras)}->c${1 + (c % 4)}`] = { term: '선배', sinceChapter: c, register: 'polite' };
  }
  const foundation = { workId: 'long', genre: 'fantasy', povMode: '3인칭제한', worldFacts: [{ id: 'f1', statement: '빛 방패는 한계를 넘으면 깨진다.' }],
    characters, intrinsicChanges: [], genreProfile: { invariants: [{ id: 'DEAD', severity: 'hard', description: '죽은 인물은 돌아오지 않는다' }] } };
  const state = { workId: 'long', chapterNumber: chapters, characterStates, hooks, ledger: { records }, relationships, addressMap: { entries } };
  const plan = '리아는 조연0의 무덤 앞을 지나 붉은 등불이 있던 고개로 간다.';
  const prose = '리아는 은빛 열쇠를 꺼냈다. 조연5가 말했다. "붉은 등불을 끈 건 나야." 도윤은 줄을 당겼다.';
  return { foundation, state, plan, prose, cast: ['c1', 'c2', 'c3', 'c4'] };
}

/** A ledger event log of `count` lines spread over the records, oldest first; `silver-key` has eight of them. */
export function longRunHistory(chapters, count) {
  const events = Array.from({ length: 8 }, (_, i) => ({ chapter: 4 + i, target: 'record', id: 'silver-key', event: i ? 'changed' : 'registered', note: `열쇠 ${i}` }));
  for (let i = events.length; i < count; i += 1) {
    const c = 8 + (i % Math.max(1, chapters - 7));
    events.push({ chapter: c, target: 'record', id: `it${c}-${i % 3}`, event: 'mentioned' });
  }
  return events.sort((a, b) => a.chapter - b.chapter);
}
