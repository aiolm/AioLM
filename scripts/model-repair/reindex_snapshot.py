"""Create a separate snapshot index from complete, hash-verified safetensors.

This does not repair tensor values or infer missing weights. The original
snapshot remains unchanged; the derived snapshot must still pass AioLM's
artifact inspection, runtime probe and real model loading.
"""
import argparse
import ctypes
import hashlib
import json
import math
import os
import shutil
import struct
import sys
import tempfile
from pathlib import Path

MAX_HEADER_BYTES = 16 * 1024 * 1024
DTYPE_BYTES = {
    "BOOL": 1, "U8": 1, "I8": 1, "F8_E4M3": 1, "F8_E5M2": 1,
    "I16": 2, "U16": 2, "F16": 2, "BF16": 2,
    "I32": 4, "U32": 4, "F32": 4, "I64": 8, "U64": 8, "F64": 8,
}
SIDECAR_SUFFIXES = {".json", ".jinja", ".model", ".txt", ".md"}


def publish_exclusive(stage, destination):
    """Publish a complete snapshot without replacing an output created meanwhile."""
    if os.name == "nt":
        os.rename(stage, destination)
        return
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        rename = library.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        arguments = [os.fsencode(stage), os.fsencode(destination), 4]  # RENAME_EXCL
    elif sys.platform.startswith("linux") and hasattr(library, "renameat2"):
        rename = library.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        arguments = [-100, os.fsencode(stage), -100, os.fsencode(destination), 1]  # AT_FDCWD / RENAME_NOREPLACE
    else:
        raise NotImplementedError("this OS cannot publish the snapshot without replacing an existing output")
    rename.restype = ctypes.c_int
    if rename(*arguments) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(destination))


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key in snapshot metadata")
        value[key] = item
    return value


def tensor_inventory(path):
    size = path.stat().st_size
    with path.open("rb") as stream:
        raw_size = stream.read(8)
        if len(raw_size) != 8:
            raise ValueError("truncated safetensors header")
        header_size = struct.unpack("<Q", raw_size)[0]
        if not 2 <= header_size <= min(MAX_HEADER_BYTES, size - 8):
            raise ValueError("invalid safetensors header size")
        header = json.loads(stream.read(header_size), object_pairs_hook=unique_object)
    if not isinstance(header, dict):
        raise ValueError("safetensors header must be an object")
    data_size = size - 8 - header_size
    ranges = []
    names = []
    for name, tensor in header.items():
        if name == "__metadata__":
            continue
        if not name or not isinstance(tensor, dict):
            raise ValueError("invalid tensor descriptor")
        shape, offsets = tensor.get("shape"), tensor.get("data_offsets")
        width = DTYPE_BYTES.get(tensor.get("dtype"))
        if (width is None or not isinstance(shape, list)
                or any(type(dimension) is not int or dimension < 0 for dimension in shape)
                or not isinstance(offsets, list) or len(offsets) != 2
                or any(type(offset) is not int for offset in offsets)):
            raise ValueError("invalid tensor dtype, shape or byte offsets")
        start, end = offsets
        if not 0 <= start <= end <= data_size or end - start != math.prod(shape) * width:
            raise ValueError("tensor byte range does not match its shape and dtype")
        ranges.append((start, end))
        names.append(name)
    cursor = 0
    for start, end in sorted(ranges):
        if start != cursor:
            raise ValueError("tensor ranges overlap or leave uncovered bytes")
        cursor = end
    if not names or cursor != data_size:
        raise ValueError("safetensors data is incomplete or contains uncovered bytes")
    return names, data_size


def reindex_snapshot(source, destination, expected_hashes):
    source, destination = Path(source), Path(destination)
    if destination.exists() or destination.is_symlink():
        raise FileExistsError("the output snapshot must be a new directory")
    if not source.is_dir() or not destination.parent.is_dir():
        raise ValueError("source snapshot and output parent must exist")
    original_index = source / "model.safetensors.index.json"
    if not original_index.is_file() or not (source / "config.json").is_file():
        raise ValueError("source requires config.json and an existing weight index")
    if original_index.stat().st_size > MAX_HEADER_BYTES:
        raise ValueError("source index exceeds the metadata limit")
    original_bytes = original_index.read_bytes()
    json.loads(original_bytes, object_pairs_hook=unique_object)
    weights = sorted(path for path in source.glob("*.safetensors") if path.is_file())
    if not weights or {path.name for path in weights} != set(expected_hashes):
        raise ValueError("provide an expected SHA-256 for every available weight file")
    inventory = {}
    total_size = 0
    for path in weights:
        expected = expected_hashes[path.name]
        if len(expected) != 64 or any(char not in "0123456789abcdef" for char in expected):
            raise ValueError("expected weight SHA-256 must contain 64 lowercase hex digits")
        if sha256(path) != expected:
            raise ValueError("weight SHA-256 mismatch")
        names, data_size = tensor_inventory(path)
        for name in names:
            if name in inventory:
                raise ValueError("duplicate tensor across weight files")
            inventory[name] = path.name
        total_size += data_size
    index = {"metadata": {"total_size": total_size}, "weight_map": dict(sorted(inventory.items()))}
    index_bytes = (json.dumps(index, indent=2) + "\n").encode()
    stage = Path(tempfile.mkdtemp(prefix=".aiolm-reindex-", dir=destination.parent))
    try:
        for path in source.iterdir():
            if (path.is_file() and path.name not in {original_index.name, ".aiolm-snapshot.json", "aiolm-index-repair.json", "source-index.json"}
                    and (path.suffix in SIDECAR_SUFFIXES or path.suffix == ".safetensors" or path.name == ".gitattributes"
                         or path.name.upper().startswith(("LICENSE", "COPYING", "NOTICE", "COPYRIGHT")))):
                shutil.copyfile(path, stage / path.name)
        for path in weights:
            copied = stage / path.name
            if sha256(copied) != expected_hashes[path.name] or tensor_inventory(copied) != tensor_inventory(path):
                raise ValueError("copied weights changed during snapshot reconstruction")
        if original_index.read_bytes() != original_bytes:
            raise ValueError("source index changed during reconstruction")
        (stage / "source-index.json").write_bytes(original_bytes)
        (stage / original_index.name).write_bytes(index_bytes)
        audit = {
            "schema_version": 1, "operation": "derived-safetensors-index",
            "original_index_sha256": hashlib.sha256(original_bytes).hexdigest(),
            "derived_index_sha256": hashlib.sha256(index_bytes).hexdigest(),
            "weight_sha256": dict(sorted(expected_hashes.items())),
            "tensor_count": len(inventory), "data_bytes": total_size,
            "loader_validation_required": True,
        }
        (stage / "aiolm-index-repair.json").write_text(json.dumps(audit, indent=2) + "\n")
        if destination.exists() or destination.is_symlink():
            raise FileExistsError("output appeared during reconstruction; it was preserved")
        publish_exclusive(stage, destination)
        return audit
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def expected_hash(value):
    name, separator, digest = value.partition("=")
    if not separator or Path(name).name != name or not name.endswith(".safetensors"):
        raise argparse.ArgumentTypeError("use WEIGHT_FILENAME=SHA256")
    return name, digest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--weight-sha256", type=expected_hash, action="append", required=True)
    args = parser.parse_args()
    if len(dict(args.weight_sha256)) != len(args.weight_sha256):
        parser.error("duplicate expected weight filenames")
    print(json.dumps(reindex_snapshot(args.source, args.output, dict(args.weight_sha256)), indent=2))
