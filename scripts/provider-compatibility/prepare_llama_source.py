"""Prepare an audited llama.cpp source tree in a new, explicit directory.

The selected upstream archive stays intact. This Idefics3 correction removes
an extra tile and tile separators from a standalone image, matching the
processor's zero-row/zero-column representation. It does not change weights,
projectors, multi-tile images, or install/select a runtime for the user.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile

REVISION = '78651c410dd8d97e3e22e533e0e7117889e3863a'
ARCHIVE_SHA256 = '3261e7f33becb7ada614605116f96222fc097f016b48cd627e01055f1535f981'
SOURCE_HASHES = {
    'tools/mtmd/mtmd-image.cpp': '83d61f416c6681ee44a2db7dc2972c87caee24e318b4380af53e704b8ba359d5',
    'tools/mtmd/mtmd.cpp': '648a9a46d5a042fe2afcf6d782b1f660939bd5af2d4e550a3fc9412b3dc9777d',
}
AUDITED_SOURCES = {
    REVISION: {'archive_sha256': ARCHIVE_SHA256, 'source_hashes': SOURCE_HASHES},
    '78a8ae14be559b45f5f13ddee82c188b683d5d8d': {
        'archive_sha256': '1b7430a305cff97c514dcef80c963bd362d877b8fef4450ba8ef7f116cc45cc6',
        'source_hashes': {
            'tools/mtmd/mtmd-image.cpp': '3d9c70e8ad25ead29c85b576a5b8d37ea0f11cd867e24ca206c65a27a83252b1',
            'tools/mtmd/mtmd.cpp': '1884e78cf8116413b54602f9bc4aeb2b2ed3f49a1be33d2df2e45cca93d6262a',
        },
    },
}


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError('upstream source differs from the audited correction')
    return text.replace(before, after, 1)


def patch_images(text):
    text = replace_once(text,
        '        output.append(hparams, slices, true);\n        output.grid_x = grid_x;',
        '''        // A single view has no row/column tiles in the Idefics3 processor.
        if (grid_x == 1 && grid_y == 1) {
            return output;
        }
        output.append(hparams, slices, true);
        output.grid_x = grid_x;''')
    start = text.index('mtmd_image_preproc_out mtmd_image_preprocessor_idefics3::preprocess')
    end = text.index('\n//\n', start + 10)
    function = replace_once(text[start:end],
        '    output.append(hparams, sliced.slices, true);',
        '''    if (instructions.grid_size.width == 1 && instructions.grid_size.height == 1) {
        return output;
    }
    output.append(hparams, sliced.slices, true);''')
    return text[:start] + function + text[end:]


def patch_tokens(text):
    return replace_once(text,
        '                if (!ctx->ov_img_first) {\n                    add_text(ctx->tok_ov_img_start);',
        '''                if (!ctx->ov_img_first) {
                    if (ctx->proj_type_v() == PROJECTOR_TYPE_IDEFICS3 && chunks.empty()) {
                        // A standalone global image has no tile separator newlines.
                        add_text("<fake_token_around_image><global-img>", true);
                    } else {
                        add_text(ctx->tok_ov_img_start);
                    }''')


def prepare(archive, output, revision=REVISION):
    try:
        selected = AUDITED_SOURCES[revision]
    except KeyError:
        raise ValueError('unsupported upstream revision') from None
    archive, output = Path(archive), Path(output)
    original_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    if original_hash != selected['archive_sha256']:
        raise ValueError('upstream archive SHA-256 mismatch')
    # A failed/partial preparation remains reviewable; never reuse or overwrite it.
    output.mkdir(parents=False, exist_ok=False)
    with tarfile.open(archive) as source:
        source.extractall(output, filter='data')
    root = output / ('llama.cpp-' + revision)
    changes = []
    for name, patch in [('tools/mtmd/mtmd-image.cpp', patch_images), ('tools/mtmd/mtmd.cpp', patch_tokens)]:
        path = root / name
        before = path.read_bytes()
        if hashlib.sha256(before).hexdigest() != selected['source_hashes'][name]:
            raise ValueError('upstream source file SHA-256 mismatch')
        after = patch(before.decode()).encode()
        path.write_bytes(after)
        changes.append({'file': name, 'before_sha256': selected['source_hashes'][name], 'after_sha256': hashlib.sha256(after).hexdigest()})
    if hashlib.sha256(archive.read_bytes()).hexdigest() != original_hash:
        raise ValueError('source archive changed during preparation')
    audit = {'schema_version': 1, 'revision': revision, 'local_revision': revision[:9] + '-aiolm.single1',
             'source_archive_sha256': original_hash, 'corrections': changes}
    (root / 'aiolm-source-compatibility.json').write_text(json.dumps(audit, indent=2) + '\n')
    return audit


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--output-directory', required=True)
    parser.add_argument('--revision', choices=tuple(AUDITED_SOURCES), default=REVISION,
                        help='audited upstream revision; defaults to the original b11460 source')
    args = parser.parse_args()
    print(json.dumps(prepare(args.archive, args.output_directory, args.revision), indent=2))
