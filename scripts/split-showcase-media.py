#!/usr/bin/env python3
"""쇼케이스 장면 이미지를 이미지 저장소(fbwndrud/vibelore-showcase-media)로 옮기고 데이터의 경로를 바꾼다.

    python3 scripts/split-showcase-media.py --media ../vibelore-showcase-media

1. docs/showcase/<작품>/img/*를 이미지 저장소의 <작품>/img/로 복사한다(내용이 같으면 건너뜀).
2. <작품>/data.json의 "img/..." 값과 how/*.html의 ../<작품>/img/... 경로를 MEDIA 주소로 바꾼다.
3. 복사가 확인된 docs/showcase/<작품>/img/ 파일을 지운다.
작품 build-site.py가 data.json과 img/를 새로 만들면 다시 실행한다. 이미지 저장소 커밋·푸시는 따로 한다.
works.json의 cover는 이미지 저장소 기준 경로이고, 목록 썸네일은 scripts/build-showcase-thumbs.py가 만든다.
"""
import argparse
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'docs' / 'showcase'
MEDIA = 'https://fbwndrud.github.io/vibelore-showcase-media/'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--media', required=True, type=Path, help='이미지 저장소 로컬 체크아웃')
    media = ap.parse_args().media.resolve()
    if not (media / '.git').exists():
        raise SystemExit(f'{media}: git 체크아웃이 아닙니다')

    for img in sorted(ROOT.glob('*/img')):
        work = img.parent.name
        dst = media / work / 'img'
        dst.mkdir(parents=True, exist_ok=True)
        copied = same = 0
        for f in sorted(img.iterdir()):
            t = dst / f.name
            if t.exists() and t.read_bytes() == f.read_bytes():
                same += 1
            else:
                shutil.copy2(f, t)
                copied += 1
        for f in list(img.iterdir()):
            assert (dst / f.name).read_bytes() == f.read_bytes(), f
            f.unlink()
        img.rmdir()
        print(f'{work}/img · 복사 {copied} · 이미 있음 {same}')

    for data in sorted(ROOT.glob('*/data.json')):
        s = data.read_text()
        out, n = re.subn(r'"img/', f'"{MEDIA}{data.parent.name}/img/', s)
        if n:
            data.write_text(out)
            print(f'{data.parent.name}/data.json · 경로 {n}개')
    for page in sorted(ROOT.glob('how/*.html')):
        s = page.read_text()
        out, n = re.subn(r'(["(])\.\./([\w-]+)/img/', lambda m: f'{m.group(1)}{MEDIA}{m.group(2)}/img/', s)
        if n:
            page.write_text(out)
            print(f'how/{page.name} · 경로 {n}개')


if __name__ == '__main__':
    main()
