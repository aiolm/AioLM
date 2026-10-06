"""Validate a portable source record against every captured installed file."""
def portable_source_commit(distribution):
    import hashlib
    import json
    import pathlib
    record = json.loads(distribution.read_text("aiolm_portable_source.json") or "{}")
    commit = record.get("commit", "")
    files = record.get("files", {})
    if record.get("format") != 1 or record.get("distribution") != "mlx-lm" or len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
        return ""
    if not isinstance(files, dict) or not files or len(files) > 10000:
        return ""
    total = 0
    for name, expected in files.items():
        relative = pathlib.PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name:
            return ""
        source = pathlib.Path(distribution.locate_file(name))
        if source.is_symlink() or not source.is_file() or source.stat().st_size > 64 * 1024 * 1024:
            return ""
        total += source.stat().st_size
        if total > 256 * 1024 * 1024 or hashlib.sha256(source.read_bytes()).hexdigest() != expected:
            return ""
    return commit
