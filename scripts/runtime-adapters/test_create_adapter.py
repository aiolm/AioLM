import argparse
import importlib.util
from unittest.mock import patch
import json
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("adapter", Path(__file__).with_name("create_adapter.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def text(value):
    raw = value.encode()
    return struct.pack("<Q", len(raw)) + raw


class LoaderProbeTests(unittest.TestCase):
    def test_gguf_chat_support_requires_its_own_template(self):
        with tempfile.TemporaryDirectory() as area:
            path = Path(area) / "synthetic.gguf"
            fields = [("general.architecture", "qwen2")]
            for template in (None, "{{ messages }}"):
                rows = fields + ([("tokenizer.chat_template", template)] if template else [])
                raw = b"GGUF" + struct.pack("<IQQ", 3, 1, len(rows))
                for key, value in rows:
                    raw += text(key) + struct.pack("<I", 8) + text(value)
                path.write_bytes(raw)
                parsed = adapter.gguf_metadata(path)
                self.assertEqual(bool(parsed.get("tokenizer.chat_template")), template is not None)

    def test_truncated_and_unsupported_models_fail_before_launch(self):
        with tempfile.TemporaryDirectory() as area:
            path = Path(area) / "synthetic.gguf"
            for raw in (b"not GGUF", b"GGUF" + struct.pack("<IQQ", 3, 1, 1), b"GGUF" + struct.pack("<IQQ", 99, 1, 0)):
                path.write_bytes(raw)
                with self.assertRaises(ValueError):
                    adapter.gguf_metadata(path)

    def test_llama_manifest_hashes_shared_libraries_beside_the_server(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            server = root / "llama-server.exe"; server.write_bytes(b"synthetic server")
            for name in ("llama.dll", "ggml-cpu.DLL", "libggml.so.1", "libmtmd.dylib", "README.txt"):
                (root / name).write_bytes(b"synthetic")
            output = root / "runtime.json"
            args = argparse.Namespace(kind="llama.cpp", engine_id="custom.synthetic", runtime_id="r1", server=str(server),
                                      python=None, name=None, output=str(output), model=None)
            with patch("builtins.print"):
                adapter.create(args)
            artifacts = json.loads(output.read_text())["artifacts"]
            self.assertEqual(artifacts[0], str(Path(adapter.__file__).absolute()))
            self.assertEqual(sorted(Path(path).name for path in artifacts[1:]),
                             sorted(["llama.dll", "ggml-cpu.DLL", "libggml.so.1", "libmtmd.dylib"]))

    def test_strata_config_cannot_enable_independent_tools_or_lazy_loading(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            exe = root / "engine"; exe.write_bytes(b"synthetic")
            tokenizer = root / "tokenizer"; tokenizer.mkdir()
            for name in ("vocab.json", "merges.txt", "token_type.json"):
                (tokenizer / name).write_text("synthetic")
            path = root / "deployment.json"
            base = {"exe": str(exe), "args": [], "tokenizer": str(tokenizer)}
            for key, value in (("lazy_load", True), ("api_key", "synthetic-key"), ("mcp_servers", {"synthetic": {}}), ("before_load", "synthetic")):
                path.write_text(json.dumps({**base, key:value}))
                with self.assertRaises(ValueError):
                    adapter.strata_config(root, path)
            path.write_text(json.dumps(base))
            self.assertEqual(adapter.strata_config(root, path)[1], exe)

    def test_strata_model_binding_cannot_replace_the_registered_native_build(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            for name in ("engine-a", "engine-b"):
                (root / name).write_bytes(b"synthetic engine")
            tokenizer = root / "tokenizer"; tokenizer.mkdir()
            for name in ("vocab.json", "merges.txt", "token_type.json"):
                (tokenizer / name).write_text("synthetic")
            registered, selected = root / "registered.json", root / "selected.json"
            base = {"args": [], "tokenizer": str(tokenizer)}
            registered.write_text(json.dumps({**base, "exe": str(root / "engine-a")}))
            selected.write_text(json.dumps({**base, "exe": str(root / "engine-b")}))
            revision = "0123456789abcdef0123456789abcdef01234567"
            args = argparse.Namespace(kind="strata", root=str(root), config=str(registered), model=str(selected), revision=revision)
            with patch.object(adapter, "capture", side_effect=[revision, "--engine --config --host --port"]):
                with self.assertRaisesRegex(ValueError, "another Strata engine build"):
                    adapter.probe(args)


if __name__ == "__main__":
    unittest.main()
