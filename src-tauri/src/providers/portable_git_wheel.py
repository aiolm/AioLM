"""Capture already installed pure-Python mlx-lm with checked source evidence.

No source build/install hooks run. Pip regenerates entry-point scripts on the
destination. PEP 610 direct_url.json is not forged: a separate content-checked
portable source record preserves the original pinned Git revision.
"""
import base64
import csv
import hashlib
import importlib.metadata as metadata
import io
import json
import pathlib
import sys
import zipfile

dist = metadata.distribution("mlx-lm")
commit, destination = sys.argv[1:3]
provenance = json.loads(dist.read_text("direct_url.json") or "{}")
recorded = provenance.get("vcs_info", {}).get("commit_id") or portable_source_commit(dist)
if recorded != commit:
    raise RuntimeError("mlx-lm installed source revision does not match the pinned export")
wheel = dist.read_text("WHEEL") or ""
if "Root-Is-Purelib: true" not in wheel:
    raise RuntimeError("portable mlx-lm capture requires a pure Python installed wheel")
files, hashes = {}, {}
dist_info = None
for entry in dist.files or []:
    relative = pathlib.PurePosixPath(str(entry).replace("\\", "/"))
    if relative.is_absolute() or ".." in relative.parts:
        # Entry-point scripts live outside site-packages and are regenerated
        # from entry_points.txt; arbitrary outside files cannot be vendored.
        if relative.name.startswith("mlx_lm.") or relative.name.startswith("mlx_lm-"):
            continue
        raise RuntimeError("mlx-lm contains an unsupported outside distribution file")
    if "__pycache__" in relative.parts or relative.suffix == ".pyc":
        continue
    if relative.parts[0].endswith(".dist-info"):
        dist_info = relative.parts[0]
        if relative.name in {"RECORD", "direct_url.json", "INSTALLER", "REQUESTED", "aiolm_portable_source.json"}:
            continue
    source = pathlib.Path(dist.locate_file(entry))
    if source.is_symlink() or not source.is_file() or source.stat().st_size > 64 * 1024 * 1024:
        raise RuntimeError("mlx-lm contains an unreadable or oversized distribution file")
    data = source.read_bytes()
    name = relative.as_posix()
    files[name] = data
    hashes[name] = hashlib.sha256(data).hexdigest()
    if len(files) > 10000 or sum(map(len, files.values())) > 256 * 1024 * 1024:
        raise RuntimeError("mlx-lm installed wheel exceeds capture bounds")
if not dist_info or len(files) > 10000 or sum(map(len, files.values())) > 256 * 1024 * 1024:
    raise RuntimeError("mlx-lm installed wheel is incomplete or exceeds capture bounds")
files[dist_info + "/aiolm_portable_source.json"] = json.dumps({"format": 1, "distribution": "mlx-lm", "commit": commit, "files": hashes}, sort_keys=True).encode()
rows = []
for name, data in files.items():
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
    rows.append([name, "sha256=" + digest, str(len(data))])
record = dist_info + "/RECORD"
rows.append([record, "", ""])
stream = io.StringIO(newline="")
csv.writer(stream, lineterminator="\n").writerows(rows)
files[record] = stream.getvalue().encode()
output = pathlib.Path(destination) / ("mlx_lm-" + dist.version.replace("-", "_") + "-py3-none-any.whl")
with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
    for name, data in sorted(files.items()):
        archive.writestr(name, data)
print("captured pinned mlx-lm wheel")
