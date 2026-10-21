#!/usr/bin/env python3
"""Export completed plant-runaway evidence without changing its novel or private state.

python3 scripts/export-plant-runaway-showcase.py --work /path/to/works/plant-runaway
Then build thumbnails and use split-showcase-media.py before publication.
"""
import argparse
import json
import re
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / 'docs/showcase'
DEST = ROOT / 'plant-runaway'


def read(path):
    return json.loads(path.read_text())


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


KO = [
    ['2칸에서 바질을 앞세운 구도 때문에 동글이에게 건네는 인사가 잠시 모호합니다. 다음 칸의 빈 분홍 화분이 이를 설명합니다.'],
    ['5칸의 말풍선 배치상 시우의 대답을 바질의 지적보다 먼저 읽을 수 있습니다. 앞선 환기 요구로 행동의 동기는 유지됩니다.',
     '첫 칸부터 시우가 낮게 웅크린 자세입니다. 후반의 무릎 꿇는 부탁은 남아 있지만 원문보다 이른 자세 변화가 들어갔습니다.'],
    ['배수관의 흙자국이 작은 발바닥처럼 표현되었습니다. 위로 이어지는 작은 흔적이라는 기능은 유지됩니다.',
     '현관 장면에서 시우가 가방을 메고 있습니다. 원문에는 현관에 둔 가방을 다시 챙기는 행동이 없습니다.',
     '현관을 바라보는 구도가 방 구조를 압축하고 창문을 생략했습니다. 바질 화분은 높은 받침 위에 유지됩니다.'],
]


def findings(review, translations):
    assert len(review['findings']) == len(translations)
    return [dict(severity=f['severity'], ko=k, en=f['evidence'], layerLabel='시각 검토')
            for f, k in zip(review['findings'], translations)]


def export(work):
    production = work / 'webtoon/episode-01'
    info = read(production / 'production-info.json')
    assert info['status'] == 'completed'
    chapters, paragraphs = [], []
    for n in (1, 2, 3):
        raw = (work / f'chapters/{n:03}.md').read_text()
        match = re.match(r'^---\n(.*?)\n---\n\s*(.*)$', raw, re.S)
        assert match, n
        title = re.search(r'^title: (.+)$', match[1], re.M)[1]
        body = match[2].strip()
        target = DEST / f'novel/{n:03}.txt'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body + '\n')
        chapters.append(dict(chapter=n, title=title, chars=len(body)))
        if n == 1:
            paragraphs = re.split(r'\n\s*\n', body)
    assert len(paragraphs) == 76
    scenes, records = [], []
    names = ['ep01-s1.webp', 'ep01-s2.webp', 'ep01-s3.webp']
    ranges = [(1, 22), (23, 45), (46, 76)]
    seconds = info['apiGenerationsObservedSeconds']
    assert len(seconds) == info['actualApiImageCalls'] == 4
    times = [(seconds[0], 1), (round(sum(seconds[1:3]), 1), 2), (seconds[3], 1)]
    candidates = work / '.vibelore/webtoon/candidates'
    for n, (a, b), (image_seconds, calls) in zip((1, 2, 3), ranges, times):
        r = read(production / f'scene-{n:02}-record.json')
        rev = r['revision']
        candidate = candidates / r['workflowId'] / f'r{rev}'
        brief = read(candidate / 'render-brief.json')
        review = r['visualReview']
        assert review['passed'] and review['observedPanelCount'] == 8
        expected = {t['id']: t['text'] for t in r['plan']['texts']}
        assert all(o['observedText'] == expected[o['id']] and o['readable'] and o['speakerCorrect']
                   for o in review['textObservations'])
        assert len(review['textObservations']) == len(expected)
        assert r['sourceUnitIds'] == [f'ch-1-p-{p}' for p in range(a, b + 1)]
        for t in r['plan']['texts']:
            p = int(t['sourceId'].split('-')[-1])
            assert t['text'] in paragraphs[p - 1]
        prompt = f'prompts/scene-{n:02}-r{rev}.txt'
        (DEST / 'prompts').mkdir(exist_ok=True)
        (DEST / prompt).write_text((production / prompt).read_text())
        fs = findings(review, KO[n - 1])
        s = dict(id=f's{n}', n=n, title=r['plan']['title'], image='img/' + names[n - 1],
                 verdict='pass', blocking=0, pFrom=a, pTo=b, panelCount=8, plannedPanels=8,
                 units=[dict(text=p) for p in paragraphs[a - 1:b]],
                 timings=dict(imageCalls=calls, imageS=image_seconds, planS=[], preflightS=[]),
                 textsOk=len(expected), textsTotal=len(expected), findings=fs,
                 review=review, brief=brief, plan=r['plan'], promptFile=prompt,
                 attemptTotal=rev, chosenAttempt=rev)
        public_record = {k: r[k] for k in ('workflowId', 'revision', 'sourceHash', 'sourceUnitIds',
                                         'plan', 'preflight', 'visualReview', 'autoRevision')}
        if n == 2:
            failed = read(candidates / r['workflowId'] / 'r1/image-review.json')
            assert not failed['passed']
            failed_fs = findings(failed, ['7～8칸에서 바질 화분이 창가 책상에서 바닥으로 이동했습니다. 원문에 없는 이동이므로 같은 책상 위에 유지하도록 다시 그렸습니다.'])
            s['attempts'] = [dict(n=1, image='img/ep01-s2-r1.webp', findings=failed_fs,
                                 plannedPanels=8, observedPanels=8, textsOk=11, textsTotal=11)]
            public_record['previousAttempts'] = [dict(revision=1, image='img/ep01-s2-r1.webp', visualReview=failed)]
            (DEST / 'prompts/scene-02-r1.txt').write_text((production / 'prompts/scene-02-r1.txt').read_text())
        scenes.append(s)
        records.append(public_record)
    assert sum(s['textsTotal'] for s in scenes) == 27
    assets = [(production / filename, name) for filename, name in zip(info['acceptedSceneFiles'], names)]
    assets += [(production / 'scene-02-r1.png', 'ep01-s2-r1.webp'),
               (work / 'webtoon/references/episode-01-reference-v1.png', 'reference-v1.webp')]
    (DEST / 'img').mkdir(exist_ok=True)
    for source, name in assets:
        with Image.open(source) as im:
            im.convert('RGB').save(DEST / 'img' / name, 'WEBP', quality=90, method=6)
    reviewer = dict(host='Codex', model='호스트 모델명 미기록')
    ep = dict(chapter=1, title=chapters[0]['title'], host='Codex', model='호스트 모델명 미기록',
              effort='미기록', novelHost='Antigravity CLI', novelModel='gemini-3.8-flash-medium',
              sceneCount=3, panelTotal=24, passCount=3, reviewer=reviewer,
              regen=dict(autoRevisionLimit=2), scenes=scenes)
    provenance = dict(requestedSceneModel=info['sceneRequestedModel'], observedSceneModel=None,
                      imageCalls=4, imageSeconds=round(sum(seconds), 1), actualCost=None,
                      reference=dict(image='img/reference-v1.webp', tool='image_gen', observedModel=None),
                      reviewMethod=info['reviewMethod'], novelCanonModified=False)
    data = dict(work='우리 집 화분이 가출했습니다', builtAt='2026-10-02',
                imageHost='OpenAI 이미지 API', imageModel=info['sceneRequestedModel'],
                reviewer=reviewer, episodes=[ep], chapters=chapters, provenance=provenance,
                vibelore=dict(label='0.4.8', novel=[dict(from_=1, to=3, packageVersion='0.4.8', commit='7ed081d')],
                              webtoon=dict(packageVersion='0.4.8')))
    data['vibelore']['novel'][0]['from'] = data['vibelore']['novel'][0].pop('from_')
    for chapter in (2, 3):
        folder = work / f'webtoon/episode-{chapter:02}'
        if (folder / 'production-info.json').exists():
            append_episode(work, folder, chapter, data, records)
    if len(data['episodes']) > 1:
        reference = work / 'webtoon/references/episode-02-03-reference-v2.png'
        with Image.open(reference) as im:
            im.convert('RGB').save(DEST / 'img/reference-ep02-03.webp', 'WEBP', quality=90, method=6)
        provenance['additionalReference'] = dict(image='img/reference-ep02-03.webp', requestedModel=info['sceneRequestedModel'],
                                                 observedModel=None, apiCalls=2, imageSeconds=77.4)
        provenance['imageCalls'] = sum(s['timings']['imageCalls'] for e in data['episodes'] for s in e['scenes'])
        provenance['imageSeconds'] = round(sum(s['timings']['imageS'] for e in data['episodes'] for s in e['scenes']), 1)
    write(DEST / 'data.json', data)
    public_production = json.dumps(dict(provenance=provenance, scenes=records), ensure_ascii=False)
    public_production = public_production.replace('"img/', '"https://fbwndrud.github.io/vibelore-showcase-media/plant-runaway/img/')
    write(DEST / 'production.json', json.loads(public_production))
    # Public exports contain neither private paths nor the internal artifact manifest.
    for f in (DEST / 'data.json', DEST / 'production.json', * (DEST / 'prompts').glob('*.txt')):
        text = f.read_text()
        assert '/Users/' not in text and '.vibelore/' not in text, f
    print(f"Exported {len(chapters)} novel chapters, {len(data['episodes'])} webtoon episodes, "
          f"{sum(e['sceneCount'] for e in data['episodes'])} scenes; exact source texts verified.")


def append_episode(work, folder, chapter, data, records):
    info = read(folder / 'production-info.json')
    assert info['status'] == 'completed'
    novel = (DEST / f'novel/{chapter:03}.txt').read_text().strip()
    paragraphs = re.split(r'\n\s*\n', novel)
    scenes = []
    previous_end = 0
    for n, filename in enumerate(info['acceptedSceneFiles'], 1):
        r = read(folder / f'scene-{n:02}-record.json')
        candidate = work / '.vibelore/webtoon/candidates' / r['workflowId'] / f"r{r['revision']}"
        review = r['visualReview']
        assert review['passed'] and review['observedPanelCount'] == 8
        a, b = (int(r['sourceUnitIds'][i].split('-')[-1]) for i in (0, -1))
        assert a == previous_end + 1
        assert r['sourceUnitIds'] == [f'ch-{chapter}-p-{p}' for p in range(a, b + 1)]
        previous_end = b
        expected = {t['id']: t['text'] for t in r['plan']['texts']}
        for t in r['plan']['texts']:
            assert t['text'] in paragraphs[int(t['sourceId'].split('-')[-1]) - 1]
        # Whitespace may change at balloon line breaks; typography is otherwise exact.
        assert len(review['textObservations']) == len(expected)
        assert all(re.sub(r'\s', '', o['observedText']) == re.sub(r'\s', '', expected[o['id']])
                   and o['readable'] and o['speakerCorrect'] for o in review['textObservations'])
        name = f'ep{chapter:02}-s{n}.webp'
        with Image.open(folder / filename) as im:
            im.convert('RGB').save(DEST / 'img' / name, 'WEBP', quality=90, method=6)
        fs = findings(review, info['findingTranslations'][str(n)])
        calls = info['sceneCalls'][str(n)]
        prompt = f'prompts/ep{chapter:02}-scene-{n:02}-r{r["revision"]}.txt'
        (DEST / prompt).write_text((folder / f'prompts/scene-{n:02}-r{r["revision"]}.txt').read_text())
        s = dict(id=f's{n}', n=n, title=r['plan']['title'], image='img/' + name, verdict='pass', blocking=0,
                 pFrom=a, pTo=b, panelCount=8, plannedPanels=8, units=[dict(text=p) for p in paragraphs[a-1:b]],
                 timings=dict(imageCalls=len(calls), imageS=round(sum(c['seconds'] for c in calls), 1), planS=[], preflightS=[]),
                 textsOk=len(expected), textsTotal=len(expected), findings=fs, review=review,
                 brief=read(candidate / 'render-brief.json'), plan=r['plan'], promptFile=prompt,
                 attemptTotal=r['revision'], chosenAttempt=r['revision'])
        record = {k: r[k] for k in ('workflowId', 'revision', 'sourceHash', 'sourceUnitIds', 'plan',
                                  'preflight', 'visualReview', 'autoRevision')}
        record['chapter'] = chapter
        for attempt in r.get('attempts', []):
            if not attempt.get('image'):
                continue
            rev = attempt['revision']
            failed = read(work / '.vibelore/webtoon/candidates' / r['workflowId'] / f'r{rev}/image-review.json')
            prior = f'ep{chapter:02}-s{n}-r{rev}.webp'
            with Image.open(folder / f'scene-{n:02}-r{rev}.png') as im:
                im.convert('RGB').save(DEST / 'img' / prior, 'WEBP', quality=90, method=6)
            ffs = findings(failed, info['attemptFindingTranslations'][f'{n}-{rev}'])
            passed_texts = sum(o['readable'] and o['speakerCorrect'] and
                              re.sub(r'\s', '', o['observedText']) == re.sub(r'\s', '', t['text'])
                              for o, t in zip(failed['textObservations'], read(work / '.vibelore/webtoon/candidates' /
                              r['workflowId'] / f'r{rev}/scene-plan.json')['texts']))
            s.setdefault('attempts', []).append(dict(n=rev, image='img/' + prior, findings=ffs, plannedPanels=8,
                                                  observedPanels=failed['observedPanelCount'], textsOk=passed_texts,
                                                  textsTotal=len(failed['textObservations'])))
            record.setdefault('previousAttempts', []).append(dict(revision=rev, image='img/' + prior, visualReview=failed))
            (DEST / f'prompts/ep{chapter:02}-scene-{n:02}-r{rev}.txt').write_text((folder / f'prompts/scene-{n:02}-r{rev}.txt').read_text())
        scenes.append(s)
        records.append(record)
    assert previous_end == len(paragraphs)
    ep = dict(chapter=chapter, title=data['chapters'][chapter-1]['title'], host='Codex', model='호스트 모델명 미기록',
              effort='미기록', novelHost='Antigravity CLI', novelModel='gemini-3.8-flash-medium', sceneCount=len(scenes),
              panelTotal=sum(s['panelCount'] for s in scenes), passCount=len(scenes), reviewer=data['reviewer'],
              regen=dict(autoRevisionLimit=2), scenes=scenes, device=info['device'])
    data['episodes'].append(ep)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', type=Path, required=True)
    export(parser.parse_args().work.resolve())
