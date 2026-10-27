import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import prepare_llama_source as source


class SourcePreparation(unittest.TestCase):
    def test_wrong_archive_hash_cannot_create_or_change_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'source.tar.gz'
            archive.write_bytes(b'synthetic invalid archive')
            output = root / 'output'
            with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                source.prepare(archive, output)
            self.assertFalse(output.exists())
            output.mkdir()
            marker = output / 'preserved.txt'
            marker.write_text('existing build')
            with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                source.prepare(archive, output)
            self.assertEqual(marker.read_text(), 'existing build')

    def test_unsupported_revision_cannot_read_archive_or_create_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, 'unsupported upstream revision'):
                source.prepare(root / 'absent.tar.gz', root / 'output', 'unreviewed-revision')
            self.assertFalse((root / 'output').exists())

    def test_each_revision_rejects_unverified_archive_before_creating_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'unverified.tar.gz'
            archive.write_bytes(b'synthetic unverified source archive')
            for revision in source.AUDITED_SOURCES:
                with self.subTest(revision=revision):
                    output = root / revision
                    with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                        source.prepare(archive, output, revision)
                    self.assertFalse(output.exists())

    def test_audited_preparation_preserves_archive_license_and_unrelated_sources(self):
        # Synthetic source fragments exercise the archive/provenance contract;
        # real processor/image behavior is checked against the selected runtime.
        image = '''        output.append(hparams, slices, true);
        output.grid_x = grid_x;
mtmd_image_preproc_out mtmd_image_preprocessor_idefics3::preprocess
    output.append(hparams, sliced.slices, true);
//
unrelated_preprocessor
'''
        tokens = '                if (!ctx->ov_img_first) {\n                    add_text(ctx->tok_ov_img_start);\n'
        files = {'tools/mtmd/mtmd-image.cpp': image.encode(), 'tools/mtmd/mtmd.cpp': tokens.encode(),
                 'LICENSE': b'Synthetic license notice: preserve verbatim.', 'unrelated.cpp': b'unrelated engine behavior'}
        for revision in source.AUDITED_SOURCES:
            with self.subTest(revision=revision):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    archive = root / 'source.tar.gz'
                    with tarfile.open(archive, 'w:gz') as tar:
                        for name, data in files.items():
                            member = tarfile.TarInfo('llama.cpp-' + revision + '/' + name)
                            member.size = len(data)
                            tar.addfile(member, io.BytesIO(data))
                    original = archive.read_bytes()
                    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
                    selected = {'archive_sha256': hashlib.sha256(original).hexdigest(), 'source_hashes': hashes}
                    with patch.dict(source.AUDITED_SOURCES, {revision: selected}):
                        audit = source.prepare(archive, root / 'output', revision)
                        if revision == source.REVISION:
                            self.assertEqual(source.prepare(archive, root / 'default-output'), audit)
                        with self.assertRaises(FileExistsError):
                            source.prepare(archive, root / 'output', revision)
                    prepared = root / 'output' / ('llama.cpp-' + revision)
                    self.assertEqual(archive.read_bytes(), original)
                    for name in ('LICENSE', 'unrelated.cpp'):
                        self.assertEqual((prepared / name).read_bytes(), files[name])
                    self.assertEqual({item['file'] for item in audit['corrections']}, {'tools/mtmd/mtmd-image.cpp', 'tools/mtmd/mtmd.cpp'})
                    self.assertNotIn(str(root), json.dumps(audit))
                    self.assertEqual(audit['revision'], revision)
                    self.assertEqual(audit['local_revision'], revision[:9] + '-aiolm.single1')
                    for item in audit['corrections']:
                        self.assertEqual(item['after_sha256'], hashlib.sha256((prepared / item['file']).read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()
