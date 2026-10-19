"""Synthetic adapter boundary tests; these do not claim real inference."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import strata_bridge as bridge
import strata_setup as setup


class BridgeTests(unittest.TestCase):
    def test_native_options_preserve_base_and_original_config(self):
        base = {"args": ["--spec", "4", "--kv", "int8"], "env": {"GPU": "0"}, "log": "old.log"}
        original = json.dumps(base, sort_keys=True)
        result = bridge.effective_config(base, ["--spec", "3", "--future-private", "눈길 ; &"], Path("owned"))
        self.assertEqual(result["args"], base["args"] + ["--spec", "3", "--future-private", "눈길 ; &"])
        self.assertEqual(json.dumps(base, sort_keys=True), original)
        self.assertEqual(result["env"], base["env"])
        self.assertFalse(result["open_browser"])
        self.assertEqual(result["log"], str(Path("owned") / "engine.log"))
        # A flag-looking literal is a value, not another option occurrence.
        self.assertEqual(bridge.effective_config(base, ["--future-note", "--native"], Path("owned"))["args"][-2:],
                         ["--future-note", "--native"])

    def test_recipe_produces_common_draft_and_keeps_protocol_facts_separate(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            config = root / "deployment.json"
            config.write_text("{}")
            common = {"probe": {"program": sys.executable, "args": ["probe"]},
                      "artifacts": [str(config)], "models": [{"path": str(config), "name": "Synthetic model"}],
                      "option_metadata": {"version": 1, "engine_id": "custom.recipe",
                                          "adapter": {"id": "old", "revision": bridge.REVISION}, "options": []}}
            args = argparse.Namespace(root=str(root), config=str(config), revision=bridge.REVISION,
                                      engine_id="custom.recipe", runtime_id="r1", name="Synthetic recipe", python=sys.executable)
            snapshot = setup.adapter._StrataConfigSnapshot(
                config, b"{}", {}, Path(sys.executable), ()
            )
            with patch.object(setup.adapter, "_build_manifest_with_snapshot",
                              return_value=(common, snapshot)):
                result = setup.prepare(args)
            self.assertEqual(result["program"], sys.executable)
            self.assertEqual(result["models"], common["models"])
            self.assertEqual(result["probe"], common["probe"])
            self.assertEqual(result["protocol"]["kind"], "bridge")
            self.assertEqual(result["protocol"]["engine_argv_env"], bridge.ENGINE_ENV)
            self.assertEqual(result["model"]["flag"], "--aiolm-model")
            self.assertEqual(result["launch_resources"]["directory_env"], bridge.DIRECTORY_ENV)
            self.assertNotIn("capabilities", result)
            reserved = {item["flag"] for item in result["option_metadata"]["options"] if item.get("reserved")}
            self.assertIn("--native", reserved)
            # The pinned native --gpu rewrites the device visibility the server
            # set from the deployment's gpu/backend; the deployment owns it.
            self.assertIn("--gpu", reserved)
            # Units are the pinned source's own: --spec proposes tokens and
            # --max-context is checked against token counts, while
            # --kv-resident counts resident KV cells of each QSA layer.
            units = {item["flag"]: item.get("unit") for item in result["option_metadata"]["options"]}
            self.assertEqual(units["--spec"], "tokens")
            self.assertEqual(units["--max-context"], "tokens")
            self.assertEqual(units["--kv-resident"], "cells per QSA layer")

    def test_native_help_on_stderr_reaches_the_one_parsed_help_document(self):
        # The pinned native build prints --help on stderr only. AioLM parses a
        # non-empty stdout alone, so the bridge must put its binding rows and
        # the native rows into that single stdout document.
        with tempfile.TemporaryDirectory(prefix="aiolm bridge help 눈길 ") as area:
            root = Path(area)
            tokenizer = root / "tokenizer"; tokenizer.mkdir()
            for name in ("vocab.json", "merges.txt", "token_type.json"):
                (tokenizer / name).write_text("synthetic")
            config = root / "deployment.json"
            config.write_text(json.dumps({"exe": sys.executable, "args": [], "tokenizer": str(tokenizer),
                                          "cwd": str(root)}))
            native = ("import sys; sys.stderr.write('  --fresh-native N   synthetic native option\\n'); "
                      "sys.stderr.flush()")
            # Only the command is synthetic; the bridge's own pipe settings
            # reach the real child process unchanged.
            bootstrap = ("import subprocess, sys, strata_bridge as b; b.adapter.capture=lambda *a,**k:b.REVISION; "
                         "real=subprocess.Popen; "
                         f"b.subprocess.Popen=lambda command, **kw: real([sys.executable, '-c', {native!r}], **kw); "
                         "raise SystemExit(b.main())")
            environment = dict(os.environ, PYTHONPATH=str(Path(bridge.__file__).parent), PYTHONDONTWRITEBYTECODE="1")
            environment[bridge.ENGINE_ENV] = json.dumps([sys.executable])
            result = subprocess.run([sys.executable, "-c", bootstrap, "--root", str(root), "--base-config", str(config),
                                     "--revision", bridge.REVISION, "--help"],
                                    env=environment, cwd=root, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
            stdout = result.stdout.decode()
            self.assertIn("--aiolm-model PATH", stdout)
            self.assertIn("--fresh-native N", stdout)
            self.assertLess(stdout.index("--aiolm-model"), stdout.index("--fresh-native"))
            self.assertEqual(result.stderr, b"")

    def test_actual_bridge_process_writes_owned_copy_and_only_http_bindings_reach_server(self):
        with tempfile.TemporaryDirectory(prefix="aiolm bridge 눈길 ") as area:
            root = Path(area)
            owned = root / "owned"; owned.mkdir()
            package = root / "serve"; package.mkdir()
            (package / "__init__.py").write_text("")
            evidence = root / "evidence.json"
            # This installed synthetic server records what the real bridge
            # passes through run_module. No generated answers or Ready claim.
            (package / "server.py").write_text(
                "import json, os, pathlib, sys\n"
                "config=pathlib.Path(sys.argv[sys.argv.index('--config')+1])\n"
                "pathlib.Path(os.environ['SYNTHETIC_RECORD']).write_text(json.dumps("
                "{'argv':sys.argv,'config':json.loads(config.read_text(encoding='utf-8')),"
                "'key':os.environ.get('STRATA_API_KEY')}))\n")
            tokenizer = root / "tokenizer"; tokenizer.mkdir()
            for name in ("vocab.json", "merges.txt", "token_type.json"):
                (tokenizer / name).write_text("synthetic")
            config = root / "deployment.json"
            config.write_text(json.dumps({"exe": sys.executable, "args": ["--spec", "4"],
                                          "tokenizer": str(tokenizer), "cwd": str(root)}))
            before = config.read_bytes()
            bootstrap = ("import strata_bridge as b; b.adapter.capture=lambda *a,**k:b.REVISION; "
                         "raise SystemExit(b.main())")
            environment = dict(os.environ, PYTHONPATH=str(Path(bridge.__file__).parent),
                               PYTHONDONTWRITEBYTECODE="1", STRATA_API_KEY="synthetic-key",
                               SYNTHETIC_RECORD=str(evidence))
            environment[bridge.ENGINE_ENV] = json.dumps([sys.executable])
            environment[bridge.DIRECTORY_ENV] = str(owned)
            result = subprocess.run([sys.executable, "-c", bootstrap, "--root", str(root), "--base-config", str(config),
                                     "--revision", bridge.REVISION, "--aiolm-model", str(config), "--aiolm-port", "12345",
                                     "--", "--spec", "3", "--future-private", "--aiolm-port", "54321", "눈길 ; &"],
                                    env=environment, cwd=root, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
            actual = json.loads(evidence.read_text())
            self.assertEqual(actual["argv"][1:3], ["--engine", "strata"])
            self.assertNotIn("--spec", actual["argv"])
            self.assertEqual(actual["config"]["args"], ["--spec", "4", "--spec", "3", "--future-private", "--aiolm-port", "54321", "눈길 ; &"])
            self.assertEqual(actual["argv"][actual["argv"].index("--port") + 1], "12345")
            self.assertEqual(Path(actual["argv"][actual["argv"].index("--config") + 1]).parent, owned)
            self.assertEqual(actual["key"], "synthetic-key")
            self.assertEqual(config.read_bytes(), before)
            help_result = subprocess.run([sys.executable, "-c", bootstrap, "--root", str(root), "--base-config", str(config),
                                          "--revision", bridge.REVISION, "--help"],
                                         env=environment, cwd=root, capture_output=True, timeout=10)
            self.assertEqual(help_result.returncode, 0, help_result.stderr.decode(errors="replace"))
            self.assertIn(b"PYTHONPATH", help_result.stdout + help_result.stderr,
                          "the selected native executable's actual help must reach the outer capture")

    def test_wrong_revision_or_command_is_refused(self):
        with self.assertRaisesRegex(ValueError, "reviewed full"):
            bridge.selected_engine(Path("."), Path("deployment.json"), "0" * 40)
        with patch.object(bridge.adapter, "capture", return_value="0" * 40), \
                self.assertRaisesRegex(ValueError, "revision changed"):
            bridge.selected_engine(Path("."), Path("deployment.json"), bridge.REVISION)


if __name__ == "__main__":
    unittest.main()
