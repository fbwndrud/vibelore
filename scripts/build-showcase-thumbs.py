#!/usr/bin/env python3
"""쇼케이스 목록·버전 연혁·작품 띠에 쓰는 작은 표지 썸네일을 만든다.

    python3 scripts/build-showcase-thumbs.py

읽는 것: docs/showcase/works.json의 `cover`(이미지 저장소 기준 원본 경로, 로컬에 없으면 MEDIA 주소에서 받음). 쓰는 것: works.json의 `thumb`·`thumbSq` 경로.
- thumb: 폭 600px(2배 화면의 대표 작품 300px 기준), 원본 비율 그대로(목록 대표 작품·카드·작품 페이지 띠).
- thumbSq: 128×128, 위쪽 기준 정사각 자르기(목록 행·버전 연혁 아이콘).
표지를 바꾸면 다시 실행한다. 결과가 같으면 파일을 다시 쓰지 않는다.
"""
import io
import json
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / 'docs' / 'showcase'
LOCAL_MEDIA = ROOT.parents[2] / 'vibelore-showcase-media'
MEDIA = 'https://fbwndrud.github.io/vibelore-showcase-media/'  # scripts/split-showcase-media.py와 같음
WIDE = 600
SQ = 128


def webp(img, quality):
    buf = io.BytesIO()
    img.save(buf, 'WEBP', quality=quality, method=6)
    return buf.getvalue()


def write(path, data):
    if path.exists() and path.read_bytes() == data:
        return 'same'
    path.write_bytes(data)
    return f'{len(data) // 1024}KB'


def main():
    for w in json.loads((ROOT / 'works.json').read_text())['works']:
        if not w.get('thumb') or not w.get('thumbSq'):
            print(w['id'], '· thumb/thumbSq 경로 없음, 건너뜀')
            continue
        local = ROOT / w['cover']
        if not local.exists() and (LOCAL_MEDIA / w['cover']).is_file():
            local = LOCAL_MEDIA / w['cover']
        src = Image.open(local if local.exists() else io.BytesIO(urllib.request.urlopen(MEDIA + w['cover']).read())).convert('RGB')
        wide = src.resize((WIDE, round(src.height * WIDE / src.width)), Image.LANCZOS)
        side = min(src.width, src.height)
        sq = src.crop(((src.width - side) // 2, 0, (src.width + side) // 2, side)).resize((SQ, SQ), Image.LANCZOS)
        print(w['id'], '·', w['thumb'], write(ROOT / w['thumb'], webp(wide, 72)), '·', w['thumbSq'], write(ROOT / w['thumbSq'], webp(sq, 80)))


if __name__ == '__main__':
    main()
