#!/usr/bin/env python3
"""쇼케이스 인물·설정 사전 데이터(lore.json)를 작품 정본과 .vibelore 기록에서 만든다.

    python3 scripts/build-showcase-lore.py vesper verdict-live executionprincess thundertrail

읽는 것: works/<id>/characters/*.md, .vibelore/entities.json, .vibelore/ledger/{seed.json,events.jsonl},
.vibelore/story-state/<N>.json. 쓰는 것: docs/showcase/<id>/lore.json.
화별 이력을 함께 담아 리더가 '읽는 화 시점'의 상태만 접어 보여줄 수 있게 한다. 쇼케이스에 공개된 화까지만 담는다.
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SURNAMES = set('김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민진나지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예경봉사부가복태목형피두감음빈동온호범좌')
SEED_LABEL = {'location': '장소', 'item': '물건', 'monster': '마수', 'faction': '세력'}


def split_list(v):
    out, depth, cur = [], 0, ''
    for ch in v:
        if ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        if ch == ',' and depth == 0:
            out.append(cur.strip()); cur = ''
        else:
            cur += ch
    if cur.strip():
        out.append(cur.strip())
    return out


def parse_character(path):
    text = path.read_text()
    _, fm, body = text.split('---', 2)
    meta = {}
    for line in fm.strip().splitlines():
        k, _, v = line.partition(':')
        v = v.strip()
        meta[k.strip()] = split_list(v[1:-1]) if v.startswith('[') and v.endswith(']') else v
    sections = {}
    for chunk in re.split(r'^## ', body, flags=re.M)[1:]:
        head, _, rest = chunk.partition('\n')
        m = re.search(r'```json\n(.*?)\n```', rest, re.S)
        sections[head.strip()] = json.loads(m.group(1)) if m else rest.strip()
    info = {k: meta[k] for k in ('role', 'species', 'form', 'ageBand', 'birthOrder') if meta.get(k)}
    if meta.get('genderLabel') or meta.get('gender'):
        info['gender'] = meta.get('genderLabel') or meta.get('gender')
    # 본문은 성을 떼고 부르는 경우가 많다: '한다온' → '다온', '아델리아 라비엔' → '아델리아'
    name = meta['name']
    short = name.split()[0] if ' ' in name else name[1:] if len(name) == 3 and name[0] in SURNAMES else None
    return {
        'id': meta['id'], 'name': name, 'aliases': meta.get('aliases') or [], 'short': short,
        'since': int(meta.get('registeredAtChapter') or 1), 'info': info,
        'appearance': meta.get('appearance') or [],
        'contradiction': sections.get('모순', ''), 'description': sections.get('설명', ''),
        'model': sections.get('극적 모델'), 'voice': sections.get('말투 프로필'),
    }


def slim(ev, keep=('note', 'set', 'status', 'evidence', 'alias')):
    out = {'ch': ev['chapter'], 'e': ev['event']}
    for k in keep:
        if ev.get(k) not in (None, '', {}):
            out[k] = ev[k]
    return out


def showcase_through(wid):
    d = json.loads((ROOT / 'docs/showcase' / wid / 'data.json').read_text())
    chs = [c['chapter'] for c in d.get('chapters', [])] + [e['chapter'] for e in d.get('episodes', [])]
    return max(chs)


def build(wid):
    work = ROOT / 'works' / wid
    vl = work / '.vibelore'
    through = showcase_through(wid)
    snaps = {}
    for p in (vl / 'story-state').glob('*.json'):
        n = int(p.stem)
        if n <= through:
            snaps[n] = json.loads(p.read_text())
    chapters = sorted(snaps)
    last = snaps[chapters[-1]] if chapters else {}

    characters = [parse_character(p) for p in sorted((work / 'characters').glob('*.md'))]

    # 기록(장소·물건·비밀·예정된 일): ledger가 있으면 화별 이벤트, 없으면 entities.json 설계 시드
    records = []
    events_path = vl / 'ledger' / 'events.jsonl'
    if events_path.exists():
        events = [json.loads(l) for l in events_path.read_text().splitlines() if l.strip()]
        events = [e for e in events if e['chapter'] <= through]
        final = {r['id']: r for r in last.get('ledger', {}).get('records', [])}
        seed = json.loads((vl / 'ledger' / 'seed.json').read_text())['entities']
        by_id = {}
        for s in seed:
            by_id[s['entityId']] = {
                'id': s['entityId'], 'name': s['canonicalName'], 'label': SEED_LABEL.get(s['kind'], s['kind']),
                'group': 'objects', 'since': 0, 'aliases': [{'t': a, 'ch': 0} for a in s['aliases']],
                'ev': [{'ch': 0, 'e': 'registered', 'set': s['attrs'], 'status': s.get('status', 'active')}],
            }
        for e in events:
            if e['target'] != 'record':
                continue
            r = by_id.get(e['id'])
            if r is None:
                f = final.get(e['id'], {})
                r = by_id[e['id']] = {
                    'id': e['id'], 'name': f.get('name', e['id']), 'label': f.get('label', ''),
                    'group': f.get('feature', 'objects'), 'since': e['chapter'], 'aliases': [], 'ev': [],
                }
                r['_final_aliases'] = [a['text'] for a in f.get('aliases', [])]
            if e['event'] == 'alias':
                r['aliases'].append({'t': e['alias'], 'ch': e['chapter']})
            r['ev'].append(slim(e))
        for r in by_id.values():
            known = {a['t'] for a in r['aliases']}
            for a in r.pop('_final_aliases', []):
                if a not in known:
                    r['aliases'].append({'t': a, 'ch': r['since']})
            if r['id'] in final and final[r['id']].get('label'):
                r['label'] = SEED_LABEL.get(final[r['id']]['label'], final[r['id']]['label'])
        records = list(by_id.values())
    else:
        for s in json.loads((vl / 'entities.json').read_text()):
            since = s.get('registeredAtChapter') or 0
            records.append({
                'id': s['entityId'], 'name': s['canonicalName'], 'label': SEED_LABEL.get(s['kind'], s['kind']),
                'group': 'objects', 'since': since, 'aliases': [{'t': a, 'ch': since} for a in s['aliases']],
                'ev': [{'ch': since, 'e': 'registered', 'set': s['attrs'], 'status': s.get('status', 'active')}],
            })
        events = []

    # 떡밥: ledger 이벤트가 있으면 그것, 없으면 화별 스냅샷의 phase 변화
    hooks = {}
    for n in chapters:
        for h in snaps[n].get('hooks', []):
            planted = h.get('plantedAtChapter') or n
            x = hooks.setdefault(h['id'], {'id': h['id'], 'planted': planted, 'text': [], 'ev': [], '_phase': None})
            # 오래된 작품은 떡밥 문장 자체를 화마다 고쳐 쓴다 — 뒷화 문장이 스포일러가 되지 않게 화별로 남긴다
            if h.get('text') and (not x['text'] or x['text'][-1]['v'] != h['text']):
                x['text'].append({'ch': planted if not x['text'] else n, 'v': h['text']})
            x['horizon'] = h.get('horizon')
            phase = h.get('phase') or h.get('status')
            if not events and phase != x['_phase']:
                x['ev'].append({'ch': n if x['_phase'] else planted, 'e': 'planted' if not x['_phase'] else phase})
                x['_phase'] = phase
    for e in events:
        if e['target'] == 'hook' and e['id'] in hooks:
            hooks[e['id']]['ev'].append(slim(e, ('note', 'evidence')))
    for h in hooks.values():
        h.pop('_phase', None)
        h['ev'].sort(key=lambda v: v['ch'])

    # 관계·호칭·아크 위치·인물이 아는 것: 스냅샷 사이 바뀐 것만
    def pair(r):
        if r.get('from'):
            return r['from'], r['to']
        if '->' in r.get('to', ''):
            return tuple(r['to'].split('->', 1))
        m = re.search(r'\((c\d+)-(c\d+)\)', r.get('kind', ''))
        return (m.group(1), m.group(2)) if m else (None, r.get('to'))

    relations, address, arcs, knows = {}, {}, {}, {}
    for n in chapters:
        s = snaps[n]
        for r in s.get('relationships', []):
            a, b = pair(r)
            x = relations.setdefault(f'{a}->{b}', {'from': a, 'to': b, 'ch': []})
            cur = {'kind': r.get('kind', ''), 'state': r.get('state', '')}
            if not x['ch'] or {k: x['ch'][-1][k] for k in cur} != cur:
                x['ch'].append({'ch': n, **cur})
        for key, v in s.get('addressMap', {}).get('entries', {}).items():
            a, b = key.split('->', 1)
            x = address.setdefault(key, {'from': a, 'to': b, 'ch': []})
            cur = {'term': v.get('term', ''), 'register': v.get('register', '')}
            if not x['ch'] or {k: x['ch'][-1][k] for k in cur} != cur:
                x['ch'].append({'ch': v.get('sinceChapter') or n, **cur})
        for cid, v in s.get('arcCursor', {}).items():
            x = arcs.setdefault(cid, [])
            cur = {'beat': v.get('beat', ''), 'note': v.get('note', '')}
            if not x or {k: x[-1][k] for k in cur} != cur:
                x.append({'ch': v.get('enteredAtChapter') or n, **cur})
        for cid, v in s.get('characterStates', {}).items():
            x = knows.setdefault(cid, {'facts': [], '_seen': set()})
            for f in v.get('knownFacts', []):
                if f not in x['_seen']:
                    x['_seen'].add(f); x['facts'].append({'ch': n, 'f': f})
            loc = v.get('location')
            if loc and (not x.get('loc') or x['loc'][-1]['v'] != loc):
                x.setdefault('loc', []).append({'ch': n, 'v': loc})
    for x in knows.values():
        x.pop('_seen', None)

    out = {
        'workId': wid, 'builtAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'through': through, 'hasLedger': bool(events),
        'characters': characters, 'records': records, 'hooks': list(hooks.values()),
        'relations': list(relations.values()), 'address': list(address.values()), 'arcs': arcs, 'knows': knows,
    }
    dest = ROOT / 'docs/showcase' / wid / 'lore.json'
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    print(f'{wid}: {len(characters)} characters, {len(records)} records, {len(hooks)} hooks, '
          f'{len(relations)} relations, {len(address)} address, through {through} → {dest.stat().st_size // 1024}KB')


if __name__ == '__main__':
    for w in sys.argv[1:] or ['vesper', 'verdict-live', 'executionprincess', 'thundertrail']:
        build(w)
