import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import create_adapter as adapter
import strata_bridge as bridge
import strata_setup as setup


class StrataFixture(unittest.TestCase):
    def setUp(self):
        self.area = tempfile.TemporaryDirectory(prefix="aiolm-strata-validation-")
        self.root = Path(self.area.name)
        serve = self.root / "serve"
        serve.mkdir()
        (serve / "__init__.py").write_text("", encoding="utf-8")
        (serve / "server.py").write_text(
            "import sys\n"
            "if '--help' in sys.argv:\n"
            "    print('--engine --config --host --port')\n",
            encoding="utf-8",
        )
        (serve / "frontend.py").write_text("# synthetic module\n", encoding="utf-8")
        tools = self.root / "tools"
        tools.mkdir()
        (tools / "strata_tokenizer.py").write_text("# synthetic tokenizer\n", encoding="utf-8")
        tokenizer = self.root / "tokenizer"
        tokenizer.mkdir()
        for name in ("vocab.json", "merges.txt", "token_type.json"):
            (tokenizer / name).write_text("synthetic\n", encoding="utf-8")
        self.tokenizer = tokenizer
        self.engine = self.root / "engine"
        self.engine.write_bytes(b"synthetic native build")
        self.config = self.root / "deployment.json"
        self.revision = bridge.REVISION
        self._write_config(self.engine)

    def tearDown(self):
        self.area.cleanup()

    def _write_config(self, executable, **extra):
        value = {
            "exe": str(executable),
            "args": [],
            "cwd": str(self.root),
            "tokenizer": str(self.tokenizer),
            "env": {"SYNTHETIC_DEPLOYMENT": "enabled"},
            "model_name": "Synthetic served",
        }
        value.update(extra)
        self.config.write_text(json.dumps(value), encoding="utf-8")

    def _args(self, *, model=None, revision=None, config=None):
        return argparse.Namespace(
            kind="strata",
            root=str(self.root),
            config=str(config or self.config),
            model=str(model) if model else None,
            revision=revision or self.revision,
            engine_id="custom.synthetic",
            runtime_id="runtime-1",
        )

    def _capture(self, calls=None):
        real_capture = adapter.capture

        def run(*call_args, **call_kwargs):
            if call_args[0][0] == "git":
                output = self.revision
            else:
                output = real_capture(*call_args, **call_kwargs)
            if calls is not None:
                calls.append((call_args, call_kwargs, output))
            return output

        return run

    def test_setup_output_and_probe_use_exact_boundaries(self):
        python = str(Path(sys.executable).absolute())
        args = self._args()
        args.python = python
        args.name = "Synthetic recipe"
        with patch.object(adapter, "_strata_config_snapshot", wraps=adapter._strata_config_snapshot) as snapshots, \
                patch.object(adapter, "_read_json_bytes", wraps=adapter._read_json_bytes) as reads:
            result = setup.prepare(args)
        self.assertEqual(snapshots.call_count, 1)
        self.assertEqual(reads.call_count, 2)
        bridge_script = str(Path(setup.__file__).with_name("strata_bridge.py").absolute())
        helper = str(Path(adapter.__file__).absolute())
        expected_artifacts = [
            helper,
            str(self.root / "serve" / "server.py"),
            str(self.engine),
            str(self.root / "serve" / "__init__.py"),
            str(self.root / "serve" / "frontend.py"),
            str(self.root / "tools" / "strata_tokenizer.py"),
            bridge_script,
            str(self.config),
        ]
        self.assertEqual(result["engine_id"], "custom.synthetic")
        self.assertEqual(result["runtime_id"], "runtime-1")
        self.assertEqual(result["display_name"], "Synthetic recipe")
        self.assertEqual(result["program"], str(self.engine))
        self.assertEqual(result["working_directory"], str(self.root))
        self.assertEqual(result["served_model"], None)
        self.assertEqual(result["artifacts"], expected_artifacts)
        self.assertEqual(
            result["protocol"]["prefix"],
            [bridge_script, "--root", str(self.root), "--base-config", str(self.config), "--revision", self.revision],
        )
        self.assertEqual(
            result["probe"],
            {
                "program": python,
                "args": [
                    helper, "probe", "--kind", "strata", "--engine-id", "custom.synthetic",
                    "--runtime-id", "runtime-1", "--model", "{model}", "--served-model", "{model_alias}",
                    "--root", str(self.root), "--config", str(self.config), "--revision", self.revision,
                ],
                "working_directory": str(self.root),
            },
        )
        self.assertEqual(result["models"], [{"path": str(self.config), "name": "Synthetic served"}])
        metadata = result["option_metadata"]
        self.assertEqual(metadata["adapter"], {"id": "strata.native-openai-bridge", "revision": self.revision})
        self.assertEqual(
            [row["flag"] for row in metadata["options"]],
            [*bridge.RESERVED, "--spec", "--max-context", "--kv-resident"],
        )

        self._write_config(Path(sys.executable).absolute())
        probe_args = self._args()
        captured = []
        printed = []
        host_before = dict(os.environ)
        with patch.object(adapter, "capture", side_effect=self._capture(captured)), \
                patch("builtins.print", side_effect=lambda value: printed.append(value)):
            adapter.probe(probe_args)
        self.assertEqual(dict(os.environ), host_before)
        self.assertEqual(len(captured), 3)
        self.assertEqual(captured[0][0][0], ["git", "rev-parse", "HEAD"])
        self.assertEqual(captured[1][0][0][0:3], [sys.executable, "-m", "serve.server"])
        self.assertEqual(captured[2][0][0], [str(Path(sys.executable).absolute()), "--version"])
        self.assertEqual(captured[2][1]["env"]["SYNTHETIC_DEPLOYMENT"], "enabled")
        self.assertEqual(
            json.loads(printed[-1]),
            {
                "schema_version": 1,
                "engine_id": "custom.synthetic",
                "runtime_id": "runtime-1",
                "version": f"Strata {self.revision} / {captured[2][2].strip()}",
                "accelerator": "unverified",
                "model": "",
                "served_model": "Synthetic served",
                "model_supported": False,
                "capabilities": {
                    "tasks": ["generate"],
                    "modalities": {"text": True, "image": False, "audio": False, "video": False},
                    "chat": True,
                    "tools": True,
                },
            },
        )

    def test_model_specific_config_and_different_build_keep_separate_validation(self):
        self._write_config(Path(sys.executable).absolute())
        selected = self.root / "selected.json"
        selected.write_text(
            self.config.read_text(encoding="utf-8").replace("Synthetic served", "Selected served"),
            encoding="utf-8",
        )
        args = self._args(model=selected)
        printed = []
        with patch.object(adapter, "capture", side_effect=self._capture()), \
                patch.object(adapter, "_strata_config_snapshot", wraps=adapter._strata_config_snapshot) as snapshots, \
                patch("builtins.print", side_effect=lambda value: printed.append(value)):
            adapter.probe(args)
        self.assertEqual(snapshots.call_count, 2)
        result = json.loads(printed[-1])
        self.assertEqual(result["model"], str(selected))
        self.assertEqual(result["served_model"], "Selected served")

        other = self.root / "other-engine"
        other.write_bytes(b"different native build")
        selected_config = json.loads(self.config.read_text(encoding="utf-8"))
        selected_config["exe"] = str(other)
        selected.write_text(json.dumps(selected_config), encoding="utf-8")
        with patch.object(adapter, "capture", side_effect=self._capture()), \
                self.assertRaisesRegex(ValueError, "another Strata engine build"):
            adapter.probe(self._args(model=selected))

    def test_snapshot_rejects_config_replacement_during_setup_and_probe(self):
        self._write_config(Path(sys.executable).absolute())
        original = adapter._strata_config_snapshot

        def replace_after_validation(*call_args):
            snapshot = original(*call_args)
            replacement = self.root / "replacement.json"
            replacement.write_text(
                self.config.read_text(encoding="utf-8").replace("Synthetic served", "Replaced served"),
                encoding="utf-8",
            )
            replacement.replace(self.config)
            return snapshot

        args = self._args()
        args.python = str(Path(sys.executable).absolute())
        args.name = "Synthetic recipe"
        with patch.object(adapter, "_strata_config_snapshot", side_effect=replace_after_validation):
            with self.assertRaisesRegex(ValueError, "config changed during validation"):
                setup.prepare(args)

        self._write_config(Path(sys.executable).absolute())
        with patch.object(adapter, "capture", side_effect=self._capture()), \
                patch.object(adapter, "_strata_config_snapshot", side_effect=replace_after_validation):
            with self.assertRaisesRegex(ValueError, "config changed during validation"):
                adapter.probe(self._args())

    def test_missing_required_files_and_restricted_config_fail_before_use(self):
        self._write_config(self.engine)
        for key, value in (("lazy_load", True), ("api_key", "synthetic"),
                           ("mcp_servers", {"synthetic": {}}), ("before_load", "synthetic")):
            self._write_config(self.engine, **{key: value})
            with self.assertRaises(ValueError):
                adapter.strata_config(self.root, self.config)
        self._write_config(self.engine)
        (self.tokenizer / "vocab.json").unlink()
        with self.assertRaisesRegex(ValueError, "selected executable/config/adapter file is missing"):
            adapter.strata_config(self.root, self.config)
        (self.tokenizer / "vocab.json").write_text("synthetic\n", encoding="utf-8")
        self._write_config(self.root / "missing-engine")
        with self.assertRaisesRegex(ValueError, "selected executable/config/adapter file is missing"):
            adapter.strata_config(self.root, self.config)

    def test_snapshot_rechecks_files_removed_after_initial_validation(self):
        self._write_config(self.engine)
        args = self._args()
        args.python = str(Path(sys.executable).absolute())
        args.name = "Synthetic recipe"
        original_build = adapter._build_manifest_with_snapshot

        def build_then_remove(*call_args):
            result = original_build(*call_args)
            self.engine.unlink()
            return result

        with patch.object(adapter, "_build_manifest_with_snapshot", side_effect=build_then_remove):
            with self.assertRaisesRegex(ValueError, "selected executable/config/adapter file is missing"):
                setup.prepare(args)

        self.engine.write_bytes(b"synthetic native build")
        self._write_config(self.engine)
        captured = []
        original_snapshot = adapter._strata_config_snapshot

        def snapshot_then_remove(*call_args):
            snapshot = original_snapshot(*call_args)
            (self.tokenizer / "vocab.json").unlink()
            return snapshot

        with patch.object(adapter, "capture", side_effect=self._capture(captured)), \
                patch.object(adapter, "_strata_config_snapshot", side_effect=snapshot_then_remove):
            with self.assertRaisesRegex(ValueError, "selected executable/config/adapter file is missing"):
                adapter.probe(self._args())
        self.assertEqual([call[0][0] for call in captured], [
            ["git", "rev-parse", "HEAD"],
            [sys.executable, "-m", "serve.server", "--help"],
        ])

    def test_revision_and_platform_boundaries_remain_rejected(self):
        args = self._args()
        args.python = str(Path(sys.executable).absolute())
        args.name = "Synthetic recipe"
        with self.assertRaisesRegex(ValueError, "full Strata revision"):
            bad = self._args(revision="0" * 40)
            setup.prepare(bad)
        with patch.object(adapter.platform, "system", return_value="Darwin"):
            with self.assertRaisesRegex(ValueError, "actual Windows/Linux"):
                adapter.build_manifest(args)


if __name__ == "__main__":
    unittest.main()
