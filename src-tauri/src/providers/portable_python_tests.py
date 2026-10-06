"""Synthetic closure and genuine offline pip round trips; no native engines."""
import contextlib
import importlib.metadata as metadata
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).parent
COMMIT = "a" * 40


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


if __name__ == "__main__":
    unittest.main()
