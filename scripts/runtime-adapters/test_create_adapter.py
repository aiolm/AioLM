import importlib.util
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


if __name__ == "__main__":
    unittest.main()
