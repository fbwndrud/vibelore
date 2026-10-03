#!/usr/bin/env python3
"""Export the completed family-revenge canon and seven real scene attempts.

Run with the workspace Python runtime (Pillow required), then build thumbnails,
split-showcase-media.py, build-showcase-lore.py and prepare-showcase.py.
Reads production records; never changes the canon or .vibelore.
"""
import hashlib
import json
import re
import unicodedata
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'works/family-revenge'
OUT = ROOT / 'docs/showcase/family-revenge'
HOST = 'Codex 세션 · 세부 모델 미기록'


def read(path):
    return json.loads(Path(path).read_text())


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def sanitize(value):
    # Preserve evidence and hashes without publishing machine paths or user answers.
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items() if k not in ('path', 'userAnswer')}
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    if isinstance(value, str):
        return re.sub(r'/Users/[^\s\"\']+', '[local artifact]', value)
    return value


def normalized(text):
    return re.sub(r'\s+', '', unicodedata.normalize('NFC', text)).strip('“”"')


def lettering(plan, review):
    observed = {x['id']: x for x in review['textObservations']}
    total = len(plan['texts'])
    ok = sum(bool((o := observed.get(t['id'])) and o['readable'] and o['speakerCorrect']
                  and normalized(o['observedText']) == normalized(t['text'])) for t in plan['texts'])
    return ok, total


def image(source, name, expected=None):
    source = Path(source)
    if expected and 'sha256:' + hashlib.sha256(source.read_bytes()).hexdigest() != expected:
        raise ValueError(f'Image changed since review: {name}')
    target = OUT / 'img' / name
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as im:
        im.save(target, 'WEBP', lossless=True, method=6)
    return 'img/' + name


def findings(review, scene, revision):
    translations = {
        (3, 1, 'blocking'): '영수증 금액 ‘백이십만 원’이 첫 칸과 마지막 칸에 중복되어, 한 번만 표기하라는 지시를 어겼습니다. 마지막에는 영수증 뒷면을 보이도록 수정했습니다.',
        (4, 1, 'blocking'): '원문 ‘어떤 서류를…’가 그림에서 ‘이면 서류를…’로 바뀌었습니다. 다음 시도에서 원문을 강조했습니다.',
        (4, 2, 'blocking'): '‘정희의 밥은 없었다’라는 원문과 달리 정희 앞에 밥그릇이 그려졌습니다. 다음 시도에서 시아버지의 식사만 보이도록 구도를 좁혔습니다.',
    }
    out = []
    for f in review.get('findings', []):
        en = f.get('evidence') or f.get('message', '')
        ko = translations.get((scene, revision, f['severity']))
        if not ko and 'earring thumbnail' in en:
            ko = '영수증의 귀걸이 사진이 희미해, 다음 장면의 확대 컷에서 제품과 착용한 귀걸이의 일치를 보여주도록 했습니다.'
        if not ko:
            ko = '정희가 식탁 아래가 아니라 위에서 손을 모았습니다. 감정은 전달되며 advisory로 남겼습니다.' if 'hands' in en else '태섭의 표정이 대사의 유화적인 태도보다 굳어 보입니다. advisory로 남겼습니다.' if 'stern' in en else en
        out.append({'severity': f['severity'], 'ko': ko, 'en': en})
    return out


def main():
    chapters = []
    bodies = []
    for p in sorted((SOURCE / 'chapters').glob('*.md')):
        match = re.match(r'^---\n(.*?)\n---\n(.*)', p.read_text(), re.S)
        if not match:
            raise ValueError(f'Missing frontmatter: {p.name}')
        n = int(re.search(r'^chapter: (\d+)$', match[1], re.M)[1])
        title = re.search(r'^title: (.+)$', match[1], re.M)[1].strip('"')
        body = match[2].strip()
        chapters.append({'chapter': n, 'title': title, 'chars': len(body)})
        bodies.append(body)
        target = OUT / 'novel' / f'{n:03}.txt'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body + '\n')
    assert [c['chapter'] for c in chapters] == list(range(1, 11))
    workflows = sorted((read(p) for p in (SOURCE / '.vibelore/webtoon/workflows').glob('*.json')),
                       key=lambda w: int(w['sceneUnits'][0]['id'].split('-')[-1]))
    assert len(workflows) == 4 and all(w['stage'] == 'completed' for w in workflows)
    original = re.split(r'\n\s*\n', bodies[0])
    units = [u['text'] for w in workflows for u in w['sceneUnits']]
    assert units == original and len(units) == 76
    scenes, records, refs = [], [], []
    for n, w in enumerate(workflows, 1):
        r = read(ROOT / f'tmp/family-revenge-webtoon-20261004/s{n}-result.json')
        assert r['workflowId'] == w['workflowId'] and r['revision'] == w['revision']
        revision = r['revision']
        sources = [(a['revision'], a['artifacts']) for a in r['attempts']] + [(revision, r['artifacts'])]
        attempts = []
        for rev, artifacts in sources:
            plan, brief, review, preflight = [read(artifacts[k]['path']) for k in
                                            ('scene-plan.json', 'render-brief.json', 'image-review.json', 'preflight.json')]
            name = f'ep01-s{n}' + (f'-try{rev}' if rev < revision else '')
            pic = image(artifacts['scene.png']['path'], name + '.webp', artifacts['scene.png']['hash'])
            ok, total = lettering(plan, review)
            record = f'records/ep01-s{n}-r{rev}.json'
            prompt = f'prompts/ep01-s{n}-r{rev}.txt'
            dump(OUT / record, {'scene': n, 'revision': rev, 'workflowId': w['workflowId'],
                               'runtime': w['runtime'], 'sourceHash': r['sourceHash'],
                               'sourceUnitIds': [u['id'] for u in w['sceneUnits']],
                               'image': {'sourcePngHash': artifacts['scene.png']['hash'], 'publicImage': 'https://fbwndrud.github.io/vibelore-showcase-media/family-revenge/' + pic},
                               'plan': sanitize(plan), 'brief': sanitize(brief),
                               'preflight': sanitize(preflight), 'visualReview': sanitize(review),
                               'reviewMethod': 'Same-host review; context isolation unverified',
                               'artifactHashes': {k: v['hash'] for k, v in artifacts.items()}})
            (OUT / 'prompts').mkdir(exist_ok=True)
            (OUT / prompt).write_text(sanitize(Path(artifacts['scene-image.prompt.txt']['path']).read_text()))
            records.append({'scene': n, 'revision': rev, 'verdict': 'pass' if review['passed'] else 'revise',
                            'record': record, 'prompt': prompt})
            if rev < revision:
                assert not review['passed']
                attempts.append({'n': rev, 'image': pic, 'findings': findings(review, n, rev),
                                 'plannedPanels': plan['panelCount'], 'observedPanels': review['observedPanelCount'],
                                 'textsOk': ok, 'textsTotal': total,
                                 'emphasis': {k: brief[k] for k in ('focusTextIds', 'corrections') if brief.get(k)}})
            else:
                assert review['passed'] and ok == total
                scenes.append({'id': f's{n}', 'n': n, 'title': plan['title'], 'image': pic,
                               'pFrom': int(w['sceneUnits'][0]['id'].split('-')[-1]),
                               'pTo': int(w['sceneUnits'][-1]['id'].split('-')[-1]),
                               'units': [{'text': u['text']} for u in w['sceneUnits']],
                               'panelCount': plan['panelCount'], 'plannedPanels': plan['panelCount'],
                               'verdict': 'pass', 'blocking': 0, 'textsOk': ok, 'textsTotal': total,
                               'findings': findings(review, n, rev), 'review': review, 'brief': brief, 'plan': plan,
                               'timings': {'imageCalls': revision}, 'relayTimings': sanitize(r['timings']),
                               'attemptTotal': revision, 'chosenAttempt': revision, 'attempts': attempts})
    for filename, label in [('cast-reference-v1.png', '인물·의상 참조'), ('dining-room-reference-v1.png', '식당·부엌 참조')]:
        refs.append({'title': label, 'image': image(SOURCE / 'output/webtoon-ep01' / filename,
                                                  filename.replace('-v1.png', '.webp'))})
    data = {'work': '아까는 식구 아니라면서요', 'title': '아까는 식구 아니라면서요', 'language': 'ko',
            'builtAt': '2026-10-04', 'novelModel': HOST, 'imageHost': 'OpenAI API',
            'imageModel': 'gpt-image-2.5-sunburst (요청 모델)',
            'reviewer': {'host': 'Codex', 'model': HOST}, 'chapters': chapters,
            'arcs': [{'n': 1, 'title': '그 집의 장부에서 내 이름을 빼는 날', 'start': 1, 'end': 10}],
            'vibelore': {'label': '0.4.8', 'novel': [{'from': 1, 'to': 10, 'packageVersion': '0.4.8',
                                                  'commit': workflows[0]['runtime']['gitCommit']}],
                         'webtoon': workflows[0]['runtime']},
            'production': {'runtime': workflows[0]['runtime'], 'sourceCanonHead': workflows[0]['source']['sourceCanonHead'],
                           'requestedImageModel': 'gpt-image-2.5-sunburst', 'observedImageModel': None,
                           'costUsd': None, 'usage': None, 'pureInferenceSeconds': None,
                           'imageApiCalls': 9, 'referenceCalls': 2, 'sceneCalls': 7,
                           'regenerations': 3, 'firstPassScenes': 2, 'finalPassScenes': 4,
                           'reviewMethod': 'Same-host review; context isolation unverified',
                           'references': refs, 'records': records},
            'episodes': [{'chapter': 1, 'title': chapters[0]['title'], 'host': 'Codex', 'model': HOST,
                          'novelHost': 'Codex', 'novelModel': HOST, 'effort': '미기록', 'sceneCount': 4, 'panelTotal': 34,
                          'passCount': 4, 'regen': {'autoRevisionLimit': 2}, 'scenes': scenes}]}
    assert sum(s['panelCount'] for s in scenes) == 34
    assert sum(s['textsTotal'] for s in scenes) == 44
    dump(OUT / 'data.json', data)
    print('family-revenge: 10 chapters, 76 source paragraphs, 4 scenes / 34 panels, 7 audited attempts, 9 images')


if __name__ == '__main__':
    main()
