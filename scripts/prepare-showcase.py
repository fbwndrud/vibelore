#!/usr/bin/env python3
"""Validate and refresh the public showcase; optionally archive a work before replacing it."""
import argparse
import hashlib
import importlib.util
import json
import re
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlparse, unquote

REPO = Path(__file__).resolve().parent.parent
ROOT = REPO / 'docs/showcase'
MEDIA_URL = 'https://fbwndrud.github.io/vibelore-showcase-media/'


def read(path):
    return json.loads(path.read_text())


def encoded(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + '\n'


def inside(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f'공개 폴더 밖 경로: {relative}')
    return path


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from strings(v)


def register_archive(root, wid, revision, has_reader):
    registry = root / 'history.json'
    history = read(registry) if registry.exists() else {'schemaVersion': 1, 'works': {}}
    entries = history['works'].setdefault(wid, [])
    if any(e['revision'] == revision for e in entries):
        return
    entries.append({'revision': revision, 'href': f'history/{wid}/{revision}/' + ('read.html' if has_reader else 'index.html')})
    with tempfile.NamedTemporaryFile(mode='w', dir=root, encoding='utf-8', delete=False) as tmp:
        tmp.write(encoded(history))
        path = Path(tmp.name)
    path.replace(registry)


def build_browse(root):
    catalog = read(root / 'works.json')
    out = {}
    for w in catalog['works']:
        wid = w['id']
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', wid) or wid in out:
            raise ValueError(f'잘못되거나 중복된 작품 ID: {wid}')
        folder = inside(root, wid)
        data = read(folder / 'data.json')
        for key in ('href', 'thumb', 'thumbSq'):
            if not inside(root, w[key]).exists():
                raise ValueError(f'{wid}: {key} 파일 없음')
        if data.get('languages'):
            variants = {}
            for lang in data['languages']:
                code = lang['code']
                if code in variants:
                    raise ValueError(f'{wid}: 중복 언어 {code}')
                variants[code] = {
                    'title': lang['novel']['workTitle'], 'dir': lang.get('dir', 'ltr'),
                    'blurb': lang['novel']['premise'],
                    'excerpt': lang['novel'].get('excerpt', [])[:3],
                    'cover': lang.get('webtoon', {}).get('image'),
                    'novelHref': w['href'] + '#n-' + code,
                    'webtoonHref': w['href'] + '#w-' + code if lang.get('webtoon') else None,
                }
            out[wid] = {'languages': list(variants), 'variants': variants,
                        'novel': {'episodes': 1, 'excerpt': True},
                        'webtoon': {'episodes': 1, 'scenes': 1}}
        else:
            language = w.get('language')
            if not language:
                raise ValueError(f'{wid}: 작품 language 필요 (UI 언어와 별개)')
            chapters = data.get('chapters', [])
            episodes = data.get('episodes', [])
            for collection in (chapters, episodes):
                numbers = [c['chapter'] for c in collection]
                if len(numbers) != len(set(numbers)):
                    raise ValueError(f'{wid}: 중복 회차')
            for c in chapters:
                if not (folder / 'novel' / f"{c['chapter']:03}.txt").is_file():
                    raise ValueError(f"{wid}: 소설 {c['chapter']}화 본문 없음")
            for e in episodes:
                ids = [s['id'] for s in e.get('scenes', [])]
                if len(ids) != len(set(ids)):
                    raise ValueError(f'{wid}: 중복 장면 ID')
                for s in e.get('scenes', []):
                    url = s.get('image', '')
                    if not url or (not urlparse(url).scheme and not inside(folder, url).is_file()):
                        raise ValueError(f'{wid}: 장면 이미지 없음 {url}')
            out[wid] = {'languages': [language], 'variants': {},
                        'novel': {'episodes': len(chapters) if chapters else len(episodes),
                                  'excerptText': ((folder / 'novel' / f"{chapters[0]['chapter']:03}.txt").read_text().strip().split('\n\n')[:3]
                                                  if chapters else [u['text'] for scene in episodes[:1] for sc in scene.get('scenes', []) for u in sc.get('units', [])][:3])},
                        'webtoon': {'episodes': len(episodes),
                                    'scenes': sum(len(e.get('scenes', [])) for e in episodes)}}
        for fmt in ('novel', 'webtoon'):
            if fmt in w['formats'] and not out[wid][fmt]['episodes']:
                raise ValueError(f'{wid}: {fmt} 공개 회차 없음')
    history = read(root / 'history.json') if (root / 'history.json').exists() else {'works': {}}
    for wid, item in out.items():
        item['history'] = history['works'].get(wid, [])
    return {'schemaVersion': 1, 'works': out}


def archive(root, wid, media):
    """Content-addressed snapshot. Copy image bytes before updating the live work."""
    catalog = read(root / 'works.json')
    work = next((w for w in catalog['works'] if w['id'] == wid), None)
    if work is None:
        raise ValueError(f'작품 없음: {wid}')
    folder = inside(root, wid)
    has_reader = (folder / 'read.html').is_file()
    media = media.resolve()
    # Only published payloads, never production transcripts or .vibelore.
    files = sorted(p for p in folder.rglob('*') if p.is_file())
    images = inside(media, wid) / 'img'
    image_files = sorted(p for p in images.rglob('*') if p.is_file()) if images.is_dir() else []
    # Fail before writing if the data refers to missing media.
    for value in strings(read(folder / 'data.json')):
        if value.startswith(MEDIA_URL):
            if not inside(media, unquote(value[len(MEDIA_URL):])).is_file():
                raise ValueError(f'보존할 이미지 없음: {value}')
    digest = hashlib.sha256(encoded(work).encode())
    for base, entries in ((folder, files), (images, image_files)):
        for p in entries:
            digest.update(str(p.relative_to(base)).encode())
            digest.update(p.read_bytes())
    revision = digest.hexdigest()[:16]
    dest = root / 'history' / wid / revision
    media_dest = media / 'history' / wid / revision / 'img'
    if dest.exists():
        register_archive(root, wid, revision, has_reader)
        print(f'{wid}: 이미 보존됨 {revision}')
        return revision
    # Stage both sets before exposing the history entry.
    with tempfile.TemporaryDirectory(dir=root) as tmp:
        stage = Path(tmp) / 'work'
        shutil.copytree(folder, stage)
        prefix = MEDIA_URL + f'history/{wid}/{revision}/img/'
        for p in stage.rglob('*'):
            if p.is_file() and p.suffix in ('.json', '.html', '.js', '.css'):
                p.write_text(p.read_text().replace(MEDIA_URL + wid + '/img/', prefix))
        reader = stage / 'read.html'
        if reader.exists():
            html = reader.read_text().replace('<head>', f'<head>\n<base href="../../../{wid}/">', 1)
            opts = f'dataUrl: "../history/{wid}/{revision}/data.json", contentRoot: "../history/{wid}/{revision}/", archiveLabel: "{revision}", '
            html = html.replace('Reader.start({', 'Reader.start({' + opts, 1)
            html = html.replace('href="data.json"', f'href="../history/{wid}/{revision}/data.json"')
            reader.write_text(html)
        else:
            # Multilingual pages use their own relative data/assets. Keep them in the snapshot.
            page = stage / 'index.html'
            page.write_text(page.read_text().replace('../i18n.js', '../../../i18n.js').replace('href="../"', 'href="../../../"'))
        (stage / 'manifest.json').write_text(encoded({'schemaVersion': 1, 'revision': revision, 'work': work}))
        if image_files:
            media_dest.parent.mkdir(parents=True, exist_ok=True)
            if not media_dest.exists():
                with tempfile.TemporaryDirectory(dir=media_dest.parent) as media_tmp:
                    media_stage = Path(media_tmp) / 'img'
                    shutil.copytree(images, media_stage)
                    media_stage.rename(media_dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        stage.rename(dest)
    register_archive(root, wid, revision, has_reader)
    print(f'{wid}: 공개본 보존 {revision} (이미지 저장소도 함께 배포)')
    return revision


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--check', action='store_true', help='검증만 수행하고 생성 파일이 최신인지 확인')
    ap.add_argument('--archive', metavar='WORK', help='교체 전에 현재 공개본 보존')
    ap.add_argument('--media', type=Path, default=REPO.parent / 'vibelore-showcase-media')
    ap.add_argument('--thumbs', action='store_true', help='표지를 바꿨을 때 썸네일도 재생성')
    args = ap.parse_args()
    if args.check and (args.archive or args.thumbs):
        ap.error('--check는 파일을 변경하는 옵션과 함께 쓸 수 없습니다')
    browse = encoded(build_browse(ROOT))
    target = ROOT / 'browse.json'
    if args.check:
        if not target.exists() or target.read_text() != browse:
            raise ValueError('browse.json 갱신 필요: python3 scripts/prepare-showcase.py')
    else:
        if args.archive:
            archive(ROOT, args.archive, args.media)
            browse = encoded(build_browse(ROOT))
        target.write_text(browse)
        spec = importlib.util.spec_from_file_location('showcase_facts', REPO / 'scripts/build-showcase-facts.py')
        facts = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(facts)
        facts.main()
        if args.thumbs:
            import subprocess
            import sys
            subprocess.run([sys.executable, str(REPO / 'scripts/build-showcase-thumbs.py')], check=True)
    print('쇼케이스 목록·회차 검증 완료')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError) as exc:
        raise SystemExit(str(exc))
