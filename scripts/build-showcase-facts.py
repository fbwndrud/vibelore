#!/usr/bin/env python3
"""쇼케이스 작품 페이지의 제작 정보 8칸(works.json의 facts)을 각 작품 기록에서 계산한다.

    python3 scripts/build-showcase-facts.py

읽는 것: docs/showcase/works.json(버전), <id>/data.json(과 thundertrail/costs.json). 쓰는 것: docs/showcase/facts.json({작품 id: 8칸}).
손으로 고치는 works.json과 섞지 않으려고 따로 둔다.
항목은 모든 작품이 같다: vibelore · 설계·집필 · 웹툰 각색 · 이미지 · 그림 검토 · 분량 · 비용 · 소요 시간.
금액·시간은 각 작품 제작 노트(비용 페이지)와 같은 식으로 더하고, 기록이 없으면 '기록 없음'으로 둔다. 추정이 섞이면 그렇게 적는다.
문구는 {ko, en} 두 벌로 만든다(숫자가 들어가 i18n 사전으로 옮길 수 없어서).
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'docs' / 'showcase'
NONE = {'ko': '기록 없음', 'en': 'Not recorded'}
HOST_EN = {'OpenAI 이미지 API': 'OpenAI image API'}


def t(ko, en=None):
    return {'ko': ko, 'en': en if en is not None else ko}


def usd(x):
    return f'${x:,.2f}'


def hours(sec):
    return f'{sec / 3600:.1f}'


def num(n):
    return f'{n:,}'


def uniq(xs):
    out = []
    for x in xs:
        if x not in out:
            out.append(x)
    return out


def row(v, note=None):
    return {'v': v, 'note': note}


def common(w, d):
    eps = d['episodes']
    novel = uniq(f"{e['novelHost']} · {e['novelModel']}" for e in eps)
    adapt = uniq(f"{e['host']} · {e['model']} · {e['effort']}" for e in eps)
    many = lambda xs, noun_ko, noun_en: (row(t(xs[0])) if len(xs) == 1 else
                                        row(t(f'회차마다 다른 {noun_ko} {len(xs)}개', f'{len(xs)} different {noun_en} by episode'), t(' / '.join(xs))))
    host = d.get('imageHost') or w.get('_imageHost')
    rv = d['reviewer']
    sc = sum(e['sceneCount'] for e in eps); pn = sum(e['panelTotal'] for e in eps)
    first, last = eps[0]['chapter'], eps[-1]['chapter']
    return {
        'vibelore': row(t(w['version']['label']), t(w['version']['detail'], None)),
        'novel': many(novel, '모델', 'models'),
        'adapt': many(adapt, '모델', 'models'),
        'image': row(t(f"{host} · {d['imageModel']}", f"{HOST_EN.get(host, host)} · {d['imageModel']}")),
        'review': row(t(f"{rv['host']} ({rv['model']})"), t('제작을 조율한 호스트의 자기검토 · 독립 평가 아님', 'Self-review by the orchestrating host · not independent')),
        '_webtoon': t(f'웹툰 {first}~{last}화 · {sc}장면 · {pn}칸', f'Webtoon ep. {first}–{last} · {sc} scenes · {pn} panels'),
    }


def webtoon_seconds(d):
    s = 0
    for e in d['episodes']:
        for sc in e['scenes']:
            tm = sc['timings']
            s += sum(tm.get('planS') or []) + sum(tm.get('preflightS') or []) + (tm.get('imageS') or 0)
    return s


def vesper(w, d):
    f = common(w, d); c = d['costs']
    chars = sum(x['chars'] for x in d['chapters'])
    f['size'] = row(t(f"소설 {len(d['chapters'])}화 · {num(chars)}자 · {len(d['arcs'])}개 아크", f"Novel {len(d['chapters'])} episodes · {num(chars)} chars · {len(d['arcs'])} arcs"), f.pop('_webtoon'))
    total = c['novel']['usd'] + c['webtoon']['usd'] + c['images']['usdEstimated']
    f['cost'] = row(t(f'약 {usd(total)}', f'about {usd(total)}'),
                    t(f"소설 {usd(c['novel']['usd'])} · 웹툰 {usd(c['webtoon']['usd'])} · 이미지 약 {usd(c['images']['usdEstimated'])}(추정)",
                      f"Novel {usd(c['novel']['usd'])} · webtoon {usd(c['webtoon']['usd'])} · images about {usd(c['images']['usdEstimated'])} (estimated)"))
    ms = c['novel']['ms'] + c['webtoon']['ms']
    f['time'] = row(t(f'모델 호출 {hours(ms / 1000)}시간', f'{hours(ms / 1000)} h of model calls'),
                    t(f"소설 {hours(c['novel']['ms'] / 1000)}시간 · 웹툰 {hours(c['webtoon']['ms'] / 1000)}시간 · 이미지 생성 시간 기록 없음",
                      f"Novel {hours(c['novel']['ms'] / 1000)} h · webtoon {hours(c['webtoon']['ms'] / 1000)} h · image time not recorded"))
    return f


def verdict(w, d):
    f = common(w, d); c = d['costs']; eps = d['episodes']
    f['size'] = row(t(f'소설 {len(eps)}화', f'Novel {len(eps)} episodes'), f.pop('_webtoon'))
    novel = sum(e['cost']['novelUsd'] for e in eps)
    webtoon = sum(e['cost']['webtoonUsd'] for e in eps) + c['ep1Before']['webtoonUsd']
    design = c['design']['spineUsd'] + c['design']['writerSkillUsd'] + c['imageModelGateUsd']
    images = c['imagesUsd'] + c['ep1RegenImagesUsdEstimated']
    total = novel + webtoon + design + images
    f['cost'] = row(t(f'약 {usd(total)}', f'about {usd(total)}'),
                    t(f'설계·관문 {usd(design)} · 소설 {usd(novel)} · 웹툰 {usd(webtoon)} · 이미지 {usd(images)}(재생성분 추정)',
                      f'Design and gate {usd(design)} · novel {usd(novel)} · webtoon {usd(webtoon)} · images {usd(images)} (regeneration estimated)'))
    s = webtoon_seconds(d)
    f['time'] = row(t(f'웹툰 모델 호출 {hours(s)}시간', f'{hours(s)} h of webtoon model calls'),
                    t('장면 각색·사전 검증·이미지 생성 합계 · 소설 시간 기록 없음', 'Scene adaptation, preflight and image generation · novel time not recorded'))
    return f


def princess(w, d):
    f = common(w, d); c = d['costs']; s = c['solTokens']; eps = d['episodes']
    f['size'] = row(t(f'소설 {len(eps)}화', f'Novel {len(eps)} episodes'), f.pop('_webtoon'))
    parts = [s['design'], s['arc'], s['sync'], s['webtoon'], *s['novel'].values()]
    inp = sum(p['input'] for p in parts); out = sum(p['output'] for p in parts)
    f['cost'] = row(NONE, t(f"GPT-6 Sol 호출은 토큰만 기록(입력 {num(inp)} · 출력 {num(out)}) · 이미지 약 {usd(c['imagesUsdEstimated'])}(추정)",
                             f"GPT-6 Sol calls recorded tokens only (input {num(inp)} · output {num(out)}) · images about {usd(c['imagesUsdEstimated'])} (estimated)"))
    sec = webtoon_seconds(d)
    f['time'] = row(t(f'웹툰 모델 호출 {hours(sec)}시간', f'{hours(sec)} h of webtoon model calls'),
                    t('장면 각색·사전 검증·이미지 생성 합계 · 소설 시간 기록 없음', 'Scene adaptation, preflight and image generation · novel time not recorded'))
    return f


def thundertrail(w, d):
    f = common(w, d); C = json.loads((ROOT / 'thundertrail' / 'costs.json').read_text()); eps = d['episodes']
    chars = sum(x['chars'] for x in C['novelWall'])
    f['size'] = row(t(f'소설 {len(eps)}화 · {num(chars)}자', f'Novel {len(eps)} episodes · {num(chars)} chars'), f.pop('_webtoon'))
    # thundertrail/cost.js의 회차별 합계와 같은 식: 소설(요약 또는 회차 기록) + 웹툰 요약 + 이미지 실측
    row_of = lambda ch, lane: next((r for r in C['summary'] if r['chapter'] == ch and r['lane'] == lane and r['step'] == '*'), None)
    cost = lambda r: None if not r or r['usdKnown'] == 0 else r['usd']
    total = 0; partial = False; sec = 0
    for e in C['episodes']:
        ch = e['chapter']; nv = row_of(ch, 'novel'); wt = row_of(ch, 'webtoon')
        nv_usd = cost(nv)
        if nv is None and e.get('cost', {}).get('novelUsd') is not None:
            nv_usd = e['cost']['novelUsd']
        wt_usd = cost(wt) if wt else 0
        im = [i for i in C['images'] if i['chapter'] == ch]
        partial = partial or nv_usd is None or wt_usd is None or not wt
        total += (nv_usd or 0) + (wt_usd or 0) + sum(i.get('usd') or 0 for i in im)
        sec += (nv['sec'] if nv and nv['secKnown'] else 0) + (wt['sec'] if wt and wt['secKnown'] else 0) + sum(i.get('sec') or 0 for i in im)
    f['cost'] = row(t(f'약 {usd(total)}', f'about {usd(total)}'),
                    t('회차별 소설·웹툰·이미지 합계' + (' · 일부 회차 미집계' if partial else '') + ' · 실측·정가 환산·추정 혼재(비용 페이지 참고)',
                      'Novel, webtoon and images by episode' + (' · some episodes not fully recorded' if partial else '') + ' · mixes measured, list-price and estimated (see the cost page)'))
    f['time'] = row(t(f'모델 호출 {hours(sec)}시간', f'{hours(sec)} h of model calls'),
                    t('시간이 기록된 호출만 합산', 'Only calls with recorded time'))
    return f


def plant_runaway(w, d):
    f = common(w, d)
    f['adapt'] = row(t('Codex'), t('호스트 모델명·추론 강도 미기록', 'Host model and reasoning effort not recorded'))
    f['size'] = row(t(f"소설 {len(d['chapters'])}화 · {num(sum(c['chars'] for c in d['chapters']))}자",
                      f"Novel {len(d['chapters'])} episodes · {num(sum(c['chars'] for c in d['chapters']))} chars"),
                    f.pop('_webtoon'))
    episodes = len(d['episodes'])
    scenes = sum(e['sceneCount'] for e in d['episodes'])
    panels = sum(e['panelTotal'] for e in d['episodes'])
    calls = d['provenance']['imageCalls']
    references = 1 + d['provenance'].get('additionalReference', {}).get('apiCalls', 0)
    f['size']['note'] = t(f'웹툰 {episodes}화 · {scenes}장면 · {panels}칸',
                          f'Webtoon {episodes} episodes · {scenes} scenes · {panels} panels')
    f['image']['note'] = t('API 요청 모델 · 응답 모델명 미기록 · 기준 이미지는 내장 도구와 API',
                           'Requested API model · response model not recorded · references use the built-in tool and API')
    f['cost'] = row(NONE, t(f'장면 이미지 {calls}회 · 기준 이미지 {references}회 · 실제 결제 금액 미기록',
                            f'{calls} scene image calls · {references} reference calls · actual billed cost not recorded'))
    f['time'] = row(t(f"장면 이미지 API {d['provenance']['imageSeconds']}초",
                      f"Scene image API {d['provenance']['imageSeconds']} s"),
                    t(f'재생성 포함 {calls}회 합계 · 기준 이미지와 전체 집필·각색 시간 제외',
                      f'{calls} calls including regeneration · excludes reference generation and total writing/adaptation time'))
    return f


BUILD = {'vesper': vesper, 'verdict-live': verdict, 'executionprincess': princess, 'thundertrail': thundertrail,
         'plant-runaway': plant_runaway}
IMAGE_HOST = {'verdict-live': 'Codex · OpenAI API', 'thundertrail': 'OpenAI API'}  # data.json에 imageHost가 없는 작품(리더의 imageHost와 같음)
ORDER = ['vibelore', 'novel', 'adapt', 'image', 'review', 'size', 'cost', 'time']


def main():
    cat = json.loads((ROOT / 'works.json').read_text())
    out = {}
    for w in cat['works']:
        if w['id'] not in BUILD:
            continue
        d = json.loads((ROOT / w['id'] / 'data.json').read_text())
        w['_imageHost'] = IMAGE_HOST.get(w['id'])
        f = BUILD[w['id']](w, d)
        w.pop('_imageHost')
        out[w['id']] = {k: f[k] for k in ORDER}
        print(w['id'], '·', ' | '.join(f"{k}: {f[k]['v']['ko']}" for k in ORDER))
    (ROOT / 'facts.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n')


if __name__ == '__main__':
    main()
