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
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'source.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                for name, data in files.items():
                    member = tarfile.TarInfo('llama.cpp-' + source.REVISION + '/' + name)
                    member.size = len(data)
                    tar.addfile(member, io.BytesIO(data))
            original = archive.read_bytes()
            hashes = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
            with patch.object(source, 'ARCHIVE_SHA256', hashlib.sha256(original).hexdigest()), patch.object(source, 'SOURCE_HASHES', hashes):
                audit = source.prepare(archive, root / 'output')
                with self.assertRaises(FileExistsError):
                    source.prepare(archive, root / 'output')
            prepared = root / 'output' / ('llama.cpp-' + source.REVISION)
            self.assertEqual(archive.read_bytes(), original)
            for name in ('LICENSE', 'unrelated.cpp'):
                self.assertEqual((prepared / name).read_bytes(), files[name])
            self.assertEqual({item['file'] for item in audit['corrections']}, {'tools/mtmd/mtmd-image.cpp', 'tools/mtmd/mtmd.cpp'})
            self.assertNotIn(str(root), json.dumps(audit))
            for item in audit['corrections']:
                self.assertEqual(item['after_sha256'], hashlib.sha256((prepared / item['file']).read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()
