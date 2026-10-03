"""Public payload validation and preservation, using temporary synthetic works."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, REPO / 'scripts' / filename)
    obj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj


prepare = module('prepare', 'prepare-showcase.py')


class ShowcasePipelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'showcase'
        self.media = Path(self.tmp.name) / 'media'
        self.work = self.root / 'sample'
        self.work.mkdir(parents=True)
        (self.media / 'sample/img').mkdir(parents=True)
        self.image = self.media / 'sample/img/s1.webp'
        self.image.write_bytes(b'first image')
        (self.work / 'thumb.webp').write_bytes(b'thumb')
        (self.work / 'thumb-sq.webp').write_bytes(b'thumb')
        (self.work / 'read.html').write_text('<head></head><script>Reader.start({ work: "sample" });</script>')
        (self.work / 'novel').mkdir()
        (self.work / 'novel/001.txt').write_text('First publication.')
        self.catalog = {'works': [{'id': 'sample', 'title': 'Sample', 'href': 'sample/', 'language': 'ko',
                                  'thumb': 'sample/thumb.webp', 'thumbSq': 'sample/thumb-sq.webp',
                                  'cover': 'sample/img/s1.webp', 'formats': ['novel', 'webtoon']}]}
        self.data = {'chapters': [{'chapter': 1}], 'episodes': [{'chapter': 1, 'scenes': [
            {'id': 's1', 'image': prepare.MEDIA_URL + 'sample/img/s1.webp'}]}]}
        self.save()

    def save(self):
        (self.root / 'works.json').write_text(json.dumps(self.catalog))
        (self.work / 'data.json').write_text(json.dumps(self.data))

    def test_missing_chapter_blocks_refresh(self):
        (self.work / 'novel/001.txt').unlink()
        with self.assertRaisesRegex(ValueError, '본문 없음'):
            prepare.build_browse(self.root)

    def test_duplicate_episode_blocks_refresh(self):
        self.data['episodes'].append(self.data['episodes'][0])
        self.save()
        with self.assertRaisesRegex(ValueError, '중복 회차'):
            prepare.build_browse(self.root)

    def test_language_must_be_explicit(self):
        del self.catalog['works'][0]['language']
        self.save()
        with self.assertRaisesRegex(ValueError, 'language 필요'):
            prepare.build_browse(self.root)

    def test_archive_keeps_prose_images_and_reading_link_after_update(self):
        first = prepare.archive(self.root, 'sample', self.media)
        self.assertEqual(first, prepare.archive(self.root, 'sample', self.media))
        (self.work / 'novel/001.txt').write_text('Second publication.')
        self.image.write_bytes(b'second image')
        second = prepare.archive(self.root, 'sample', self.media)
        self.assertNotEqual(first, second)
        snapshot = self.root / f'history/sample/{first}'
        self.assertEqual((snapshot / 'novel/001.txt').read_text(), 'First publication.')
        self.assertEqual((self.media / f'history/sample/{first}/img/s1.webp').read_bytes(), b'first image')
        archived_data = json.loads((snapshot / 'data.json').read_text())
        self.assertIn(f'history/sample/{first}/img/', archived_data['episodes'][0]['scenes'][0]['image'])
        self.assertIn(f'contentRoot: "../history/sample/{first}/"', (snapshot / 'read.html').read_text())
        entries = json.loads((self.root / 'history.json').read_text())['works']['sample']
        self.assertEqual(len(entries), 2)
        self.assertTrue(all((self.root / e['href']).is_file() for e in entries))

    def test_missing_archive_media_does_not_create_public_history(self):
        self.image.unlink()
        with self.assertRaisesRegex(ValueError, '이미지 없음'):
            prepare.archive(self.root, 'sample', self.media)
        self.assertFalse((self.root / 'history.json').exists())
        self.assertFalse((self.root / 'history').exists())

    def test_novel_only_can_be_archived_without_an_image_repository(self):
        import shutil
        self.data['episodes'] = []
        self.catalog['works'][0]['formats'] = ['novel']
        self.save()
        shutil.rmtree(self.media)
        revision = prepare.archive(self.root, 'sample', self.media)
        self.assertEqual((self.root / f'history/sample/{revision}/novel/001.txt').read_text(), 'First publication.')

    def test_archive_retry_recovers_a_missing_history_entry(self):
        revision = prepare.archive(self.root, 'sample', self.media)
        (self.root / 'history.json').unlink()
        self.assertEqual(prepare.archive(self.root, 'sample', self.media), revision)
        entries = json.loads((self.root / 'history.json').read_text())['works']['sample']
        self.assertEqual(entries[0]['revision'], revision)

    def test_media_update_preserves_the_original_image_url(self):
        from unittest.mock import patch
        split = module('split_media', 'split-showcase-media.py')
        split.ROOT = self.root
        (self.media / '.git').mkdir()
        (self.work / 'img').mkdir()
        (self.work / 'img/s1.webp').write_bytes(b'new public image')
        with patch('sys.argv', ['split', '--media', str(self.media)]):
            split.main()
        self.assertEqual(self.image.read_bytes(), b'first image')
        updated = json.loads((self.work / 'data.json').read_text())['episodes'][0]['scenes'][0]['image']
        self.assertNotEqual(updated, self.data['episodes'][0]['scenes'][0]['image'])
        new_path = self.media / updated.removeprefix(split.MEDIA)
        self.assertEqual(new_path.read_bytes(), b'new public image')
        self.assertFalse((self.work / 'img').exists())
        self.assertEqual(json.loads((self.root / 'works.json').read_text())['works'][0]['cover'], str(new_path.relative_to(self.media)))


if __name__ == '__main__':
    unittest.main()
