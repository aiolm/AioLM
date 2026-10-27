"""Synthetic closure and genuine offline pip round trips; no native engines."""
import base64
import csv
import contextlib
import hashlib
import importlib.metadata as metadata
import io
import json
import pathlib
import stat as stat_module
import subprocess
import sys
import tempfile
import unittest
import zipfile
from types import SimpleNamespace
from unittest.mock import patch

ROOT = pathlib.Path(__file__).parent
COMMIT = "a" * 40


class SyntheticWheelDistribution:
    version = "0.3.4"
    entry_points = ()

    def __init__(self, default_source, files, source_paths=None, direct_url=None):
        self.default_source = default_source
        self.files = files
        self.source_paths = source_paths or {}
        self.direct_url = direct_url or json.dumps({"vcs_info": {"commit_id": COMMIT}})

    def read_text(self, name):
        if name == "WHEEL":
            return "Wheel-Version: 1.0\nRoot-Is-Purelib: true\n"
        if name == "direct_url.json":
            return self.direct_url
        return ""

    def locate_file(self, entry):
        return self.source_paths.get(str(entry), self.default_source)


class VirtualBytes(bytes):
    """Keep aggregate-bound tests small while giving captured bytes a model size."""

    def __new__(cls, value, reported_length):
        instance = super().__new__(cls, value)
        instance.reported_length = reported_length
        return instance

    def __len__(self):
        return self.reported_length


class PortablePythonTests(unittest.TestCase):
    def execute(self, script, argv, **patches):
        source = (ROOT / "portable_source_probe.py").read_text() + "\n" + (ROOT / script).read_text()
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(sys, "argv", [script] + argv))
            for name, value in patches.items():
                stack.enter_context(patch.object(metadata, name, value))
            output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            exec(compile(source, script, "exec"), {})
            return output.getvalue()

    def execute_recording(self, dist, destination, read_bytes=None):
        archives = []

        class RecordingZipFile:
            def __init__(self, *args, **kwargs):
                self.entries = []
                archives.append(self)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def writestr(self, name, data):
                self.entries.append((name, data))

        with patch("zipfile.ZipFile", RecordingZipFile):
            if read_bytes is None:
                self.execute("portable_git_wheel.py", [COMMIT, str(destination)], distribution=lambda _: dist)
            else:
                with patch.object(pathlib.Path, "read_bytes", read_bytes):
                    self.execute("portable_git_wheel.py", [COMMIT, str(destination)], distribution=lambda _: dist)
        return archives[0]

    def make_dist(self, root, name, version, requires=()):
        info = root / (name.replace("-", "_") + "-" + version + ".dist-info")
        info.mkdir()
        (info / "METADATA").write_text("Metadata-Version: 2.1\nName: " + name + "\nVersion: " + version + "\n" + "".join("Requires-Dist: " + requirement + "\n" for requirement in requires))
        return metadata.Distribution.at(info)

    def test_closure_excludes_unrelated_packages_and_checks_markers_versions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            engine = self.make_dist(root, "vllm", "0.31.0", ["fixture-dep>=1", "absent; python_version<'2'"])
            dep = self.make_dist(root, "fixture-dep", "1.2")
            unrelated = self.make_dist(root, "private-unrelated", "9.9")
            found = lambda: [engine, dep, unrelated]
            result = self.execute("portable_inventory.py", ["vllm"], distributions=found)
            closure = json.loads(result.split("AIOLM_FREEZE=", 1)[1])
            self.assertEqual([row["name"] for row in closure], ["fixture-dep", "vllm"])
            (root / "fixture_dep-1.2.dist-info" / "METADATA").write_text("Metadata-Version: 2.1\nName: fixture-dep\nVersion: 0.1\n")
            with self.assertRaisesRegex(RuntimeError, "incompatible version"):
                self.execute("portable_inventory.py", ["vllm"], distributions=found)

    def test_pinned_source_capture_installs_offline_and_detects_changed_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source, wheels, installed = [root / name for name in ("source", "wheels", "installed")]
            source.mkdir(); wheels.mkdir()
            dist = self.make_dist(source, "mlx-lm", "0.3.4")
            info = source / "mlx_lm-0.3.4.dist-info"
            (source / "mlx_lm").mkdir()
            (source / "mlx_lm" / "__init__.py").write_text("VALUE = 'synthetic'\n")
            (info / "WHEEL").write_text("Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
            (info / "LICENSE").write_text("Synthetic fixture license\n")
            (info / "direct_url.json").write_text(json.dumps({"url": "https://github.com/ml-explore/mlx-lm", "vcs_info": {"vcs": "git", "commit_id": COMMIT}}))
            files = [path.relative_to(source).as_posix() for path in source.rglob("*") if path.is_file()]
            (info / "RECORD").write_text("".join(name + ",,\n" for name in files))
            self.execute("portable_git_wheel.py", [COMMIT, str(wheels)], distribution=lambda _: dist)
            wheel = next(wheels.glob("*.whl"))
            result = subprocess.run([sys.executable, "-I", "-m", "pip", "install", "--no-index", "--no-deps", "--no-cache-dir", "--disable-pip-version-check", "--no-input", "--target", str(installed), str(wheel)], capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            restored = metadata.Distribution.at(installed / info.name)
            namespace = {}
            exec((ROOT / "portable_source_probe.py").read_text(), namespace)
            self.assertEqual(namespace["portable_source_commit"](restored), COMMIT)
            self.assertEqual((installed / info.name / "LICENSE").read_text(), "Synthetic fixture license\n")
            # Capture again from installed files without inventing PEP 610 Git provenance.
            second = root / "second"; second.mkdir()
            self.execute("portable_git_wheel.py", [COMMIT, str(second)], distribution=lambda _: restored)
            (installed / "mlx_lm" / "__init__.py").write_text("VALUE = 'changed'\n")
            self.assertEqual(namespace["portable_source_commit"](restored), "")
            with self.assertRaisesRegex(RuntimeError, "source revision"):
                self.execute("portable_git_wheel.py", [COMMIT, str(root)], distribution=lambda _: restored)

    def test_source_record_rejects_drive_or_root_anchored_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            outside = root / "outside.py"
            outside.write_text("Synthetic outside file\n")
            dist = self.make_dist(root, "mlx-lm", "0.3.4")
            info = root / "mlx_lm-0.3.4.dist-info"
            digest = hashlib.sha256(outside.read_bytes()).hexdigest()
            namespace = {}
            exec((ROOT / "portable_source_probe.py").read_text(), namespace)
            # "C:/..." on Windows and "/..." elsewhere both resolve outside the
            # distribution even though the content hash matches.
            (info / "aiolm_portable_source.json").write_text(json.dumps({"format": 1, "distribution": "mlx-lm", "commit": COMMIT, "files": {outside.resolve().as_posix(): digest}}))
            self.assertEqual(namespace["portable_source_commit"](dist), "")

    def test_capture_regenerates_only_declared_console_scripts_in_the_scripts_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source, scripts, wheels = [root / name for name in ("source", "bin", "wheels")]
            source.mkdir(); scripts.mkdir(); wheels.mkdir()
            for name in ("mlx_lm", "mlx_lm.chat", "mlx_lm.private"):
                (scripts / name).write_text("Synthetic launcher; never captured\n")
            (root / "private").mkdir()
            (root / "private" / "mlx_lm").write_text("Synthetic outside file; never captured\n")
            dist = self.make_dist(source, "mlx-lm", "0.3.4")
            info = source / "mlx_lm-0.3.4.dist-info"
            (info / "WHEEL").write_text("Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
            (info / "direct_url.json").write_text(json.dumps({"vcs_info": {"commit_id": COMMIT}}))
            (info / "entry_points.txt").write_text("[console_scripts]\nmlx_lm = mlx_lm.cli:main\nmlx_lm.chat = mlx_lm.chat:main\n")
            files = [path.relative_to(source).as_posix() for path in source.rglob("*") if path.is_file()]
            record = info / "RECORD"
            record.write_text("".join(name + ",,\n" for name in files + ["../bin/mlx_lm", "../bin/mlx_lm.chat"]))
            with patch("sysconfig.get_path", return_value=str(scripts)):
                self.execute("portable_git_wheel.py", [COMMIT, str(wheels)], distribution=lambda _: dist)
                with zipfile.ZipFile(next(wheels.glob("*.whl"))) as archive:
                    self.assertIn(info.name + "/entry_points.txt", archive.namelist())
                    self.assertFalse(any(".." in name for name in archive.namelist()))
                # A matching prefix, an undeclared script, or a declared name
                # in another directory must still fail before reading it.
                for outside in ("../bin/mlx_lm.private", "../private/mlx_lm", str(scripts / "mlx_lm")):
                    record.write_text("".join(name + ",,\n" for name in files + [outside]))
                    with self.assertRaisesRegex(RuntimeError, "outside distribution file"):
                        self.execute("portable_git_wheel.py", [COMMIT, str(wheels)], distribution=lambda _: metadata.Distribution.at(info))

    def test_capture_replaces_canonical_duplicates_and_records_exact_stored_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            info = root / "mlx_lm-0.3.4.dist-info"
            info.mkdir()
            wheel = info / "WHEEL"
            wheel.write_text("Wheel-Version: 1.0\nRoot-Is-Purelib: true\n")
            first = root / "first.py"
            second = root / "second.py"
            first.write_bytes(b"first payload")
            second.write_bytes(b"replacement payload")
            entries = [
                "mlx_lm-0.3.4.dist-info/WHEEL",
                "pkg/\u00e9.py",
                "./pkg/\u00e9.py",
            ]
            dist = SyntheticWheelDistribution(
                wheel,
                entries,
                {
                    entries[0]: wheel,
                    entries[1]: first,
                    entries[2]: second,
                },
            )
            destination = root / "wheels"
            destination.mkdir()
            with patch("hashlib.sha256", wraps=hashlib.sha256) as sha256:
                self.execute("portable_git_wheel.py", [COMMIT, str(destination)], distribution=lambda _: dist)
            wheel_path = next(destination.glob("*.whl"))
            with zipfile.ZipFile(wheel_path) as archive:
                source_name = "mlx_lm-0.3.4.dist-info/aiolm_portable_source.json"
                record_name = "mlx_lm-0.3.4.dist-info/RECORD"
                member_names = [
                    "mlx_lm-0.3.4.dist-info/RECORD",
                    "mlx_lm-0.3.4.dist-info/WHEEL",
                    source_name,
                    "pkg/\u00e9.py",
                ]
                self.assertEqual(archive.namelist(), member_names)
                self.assertEqual(archive.read("pkg/\u00e9.py"), second.read_bytes())
                source_record = json.loads(archive.read(source_name))
                self.assertEqual(
                    source_record["files"],
                    {
                        "mlx_lm-0.3.4.dist-info/WHEEL": hashlib.sha256(wheel.read_bytes()).hexdigest(),
                        "pkg/\u00e9.py": hashlib.sha256(second.read_bytes()).hexdigest(),
                    },
                )
                rows = list(csv.reader(io.StringIO(archive.read(record_name).decode())))
                self.assertEqual(
                    [row[0] for row in rows],
                    [
                        "mlx_lm-0.3.4.dist-info/WHEEL",
                        "pkg/\u00e9.py",
                        source_name,
                        record_name,
                    ],
                )
                for name, digest, size in rows[:-1]:
                    data = archive.read(name)
                    expected = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
                    self.assertEqual(digest, "sha256=" + expected)
                    self.assertEqual(size, str(len(data)))
            self.assertEqual(sha256.call_count, 4)

    def test_capture_uses_replacement_size_for_exact_aggregate_bound(self):
        def run(sizes):
            with tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                paths = {}
                entries = ["mlx_lm-0.3.4.dist-info/WHEEL"]
                entries.extend(["pkg/a.py", "./pkg/a.py", "pkg/b.py", "pkg/c.py", "pkg/d.py", "pkg/e.py"])
                for index, entry in enumerate(entries):
                    path = root / ("payload_" + str(index))
                    path.write_bytes(b"x")
                    paths[entry] = path
                dist = SyntheticWheelDistribution(paths[entries[0]], entries, paths)
                destination = root / "wheels"
                destination.mkdir()
                virtual_sizes = {path: sizes[entry] for entry, path in paths.items()}

                def read_bytes(path):
                    return VirtualBytes(b"x", virtual_sizes[path])

                return self.execute_recording(dist, destination, read_bytes)

        exact = {
            "mlx_lm-0.3.4.dist-info/WHEEL": 0,
            "pkg/a.py": 64 * 1024 * 1024,
            "./pkg/a.py": 1,
            "pkg/b.py": 64 * 1024 * 1024 - 1,
            "pkg/c.py": 64 * 1024 * 1024,
            "pkg/d.py": 64 * 1024 * 1024,
            "pkg/e.py": 64 * 1024 * 1024,
        }
        self.assertIsNotNone(run(exact))
        over = dict(exact)
        over["pkg/e.py"] += 1
        with self.assertRaisesRegex(RuntimeError, "exceeds capture bounds"):
            run(over)

    def test_capture_enforces_per_file_bound_without_allocating_the_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            wheel = root / "wheel"
            large = root / "large"
            wheel.write_bytes(b"wheel")
            large.write_bytes(b"x")
            entries = ["mlx_lm-0.3.4.dist-info/WHEEL", "pkg/large.py"]
            dist = SyntheticWheelDistribution(wheel, entries, {entries[0]: wheel, entries[1]: large})
            destination = root / "wheels"
            destination.mkdir()
            original_stat = pathlib.Path.stat

            def stat(path, *args, **kwargs):
                if path == large:
                    return SimpleNamespace(st_mode=stat_module.S_IFREG, st_size=64 * 1024 * 1024)
                return original_stat(path, *args, **kwargs)

            with patch.object(pathlib.Path, "stat", stat):
                self.assertIsNotNone(self.execute_recording(dist, destination))
                with self.assertRaisesRegex(RuntimeError, "unreadable or oversized"):
                    with patch.object(
                        pathlib.Path,
                        "stat",
                        lambda path, *args, **kwargs: SimpleNamespace(
                            st_mode=stat_module.S_IFREG, st_size=64 * 1024 * 1024 + 1
                        )
                        if path == large
                        else original_stat(path, *args, **kwargs),
                    ):
                        self.execute_recording(dist, destination)

    def test_capture_enforces_ten_thousand_unique_files_without_large_fixture(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            payload = root / "payload"
            payload.write_bytes(b"")
            prefix = "mlx_lm-0.3.4.dist-info/WHEEL"
            exact_entries = [prefix] + ["pkg/file_" + str(index) + ".py" for index in range(9999)]
            dist = SyntheticWheelDistribution(payload, exact_entries)
            destination = root / "exact"
            destination.mkdir()
            self.assertIsNotNone(self.execute_recording(dist, destination))
            dist.files.append("pkg/file_9999.py")
            over_destination = root / "over"
            over_destination.mkdir()
            with self.assertRaisesRegex(RuntimeError, "exceeds capture bounds"):
                self.execute_recording(dist, over_destination)


if __name__ == "__main__":
    unittest.main()
