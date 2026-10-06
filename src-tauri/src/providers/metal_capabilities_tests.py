"""Installed Metal loader scans with synthetic modules, never real engines."""
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).with_name("metal_capabilities.py").read_text(encoding="utf-8")


def module(name, **attrs):
    result = types.ModuleType(name)
    result.__path__ = []
    vars(result).update(attrs)
    return result


class MetalCapabilityTests(unittest.TestCase):
    def test_installed_mlx_loader_and_plugin_adapter_sources_decide_lists(self):
        with tempfile.TemporaryDirectory(prefix="aiolm-metal-probe-") as tmp:
            root = pathlib.Path(tmp)
            lm = root / "lm"
            vlm = root / "vlm"
            plugin = root / "plugin"
            for path in [lm, vlm / "qwen3_vl", plugin / "v1" / "pooling" / "backends" / "decoder", plugin / "stt"]:
                path.mkdir(parents=True)
                (path / "__init__.py").write_text("", encoding="utf-8")
            (lm / "llama.py").write_text("class Model: pass\nclass ModelArgs: pass\n", encoding="utf-8")
            (lm / "qwen3.py").write_text("class Model: pass\nclass ModelArgs: pass\n", encoding="utf-8")
            (lm / "bert.py").write_text("class Model: pass\nclass ModelArgs: pass\n", encoding="utf-8")
            (plugin / "v1" / "model_adapter.py").write_text(
                '_QWEN3_VL_MODEL_TYPES: frozenset[str] = frozenset({"qwen3_vl"})\n'
                '_PADDLEOCR_VL_MODEL_TYPES: frozenset[str] = frozenset({"future_vision"})\n', encoding="utf-8")
            (plugin / "v1" / "pooling" / "backends" / "decoder" / "factory.py").write_text("", encoding="utf-8")
            (plugin / "stt" / "detection.py").write_text(
                '_STT_MODEL_TYPES = frozenset({"whisper", "qwen3_asr", "future_stt"})\n', encoding="utf-8")
            (plugin / "stt" / "registry.py").write_text(
                '_STT_MODEL_CONSTRUCTORS: dict = {"": 1, "whisper": 1, "qwen3_asr": 1}\n', encoding="utf-8")
            lm_models = module("mlx_lm.models", __file__=str(lm / "__init__.py"))
            vlm_models = module("mlx_vlm.models", __file__=str(vlm / "__init__.py"))
            modules = {
                "mlx_lm": module("mlx_lm", models=lm_models), "mlx_lm.models": lm_models,
                "mlx_lm.utils": module("mlx_lm.utils", MODEL_REMAPPING={"mistral": "llama"}),
                "mlx_vlm": module("mlx_vlm", models=vlm_models), "mlx_vlm.models": vlm_models,
                "vllm_metal": module("vllm_metal", __file__=str(plugin / "__init__.py")),
            }
            record = {"variant": "vllm-metal", "accelerator": "metal", "platform_class": "vllm_metal.platform.MetalPlatform", "errors": [], "architectures": ["BertModel"]}
            with patch.dict(sys.modules, modules), patch("importlib.util.find_spec", return_value=None):
                exec(compile(SOURCE, "metal_capabilities.py", "exec"), {"out": record})
            self.assertEqual(record["errors"], [])
            self.assertEqual(record["metal_model_types"], ["llama", "mistral", "qwen3"])
            self.assertEqual(record["metal_multimodal_model_types"], ["qwen3_vl"])
            self.assertEqual(record["metal_embedding_model_types"], ["qwen3"])
            self.assertEqual(record["metal_transcription_model_types"], ["qwen3_asr", "whisper"])
            self.assertEqual(record["metal_translation_model_types"], ["whisper"])
            self.assertEqual(record["metal_transcription_scan"], 1)
            self.assertIn("metal_stt_extras", record)
            self.assertIn("metal_ffmpeg", record)
            self.assertFalse(record["metal_gguf"])
            self.assertEqual(record["metal_registry_scan"], 1)
            self.assertNotIn("bert", record["metal_model_types"])

    def test_stt_requires_matching_registry_constructor(self):
        with tempfile.TemporaryDirectory(prefix="aiolm-metal-stt-") as tmp:
            root = pathlib.Path(tmp)
            lm = root / "lm"
            vlm = root / "vlm"
            plugin = root / "plugin"
            for path in [lm, vlm / "qwen3_vl", plugin / "v1" / "pooling" / "backends" / "decoder", plugin / "stt"]:
                path.mkdir(parents=True)
                (path / "__init__.py").write_text("", encoding="utf-8")
            (lm / "llama.py").write_text("class Model: pass\nclass ModelArgs: pass\n", encoding="utf-8")
            (plugin / "v1" / "model_adapter.py").write_text(
                '_QWEN3_VL_MODEL_TYPES: frozenset[str] = frozenset(set())\n'
                '_PADDLEOCR_VL_MODEL_TYPES: frozenset[str] = frozenset(set())\n', encoding="utf-8")
            (plugin / "v1" / "pooling" / "backends" / "decoder" / "factory.py").write_text("", encoding="utf-8")
            (plugin / "stt" / "detection.py").write_text(
                '_STT_MODEL_TYPES = frozenset({"whisper", "qwen3_asr"})\n', encoding="utf-8")
            (plugin / "stt" / "registry.py").write_text(
                '_STT_MODEL_CONSTRUCTORS: dict = {"whisper": 1}\n', encoding="utf-8")
            lm_models = module("mlx_lm.models", __file__=str(lm / "__init__.py"))
            vlm_models = module("mlx_vlm.models", __file__=str(vlm / "__init__.py"))
            modules = {
                "mlx_lm": module("mlx_lm", models=lm_models), "mlx_lm.models": lm_models,
                "mlx_lm.utils": module("mlx_lm.utils", MODEL_REMAPPING={}),
                "mlx_vlm": module("mlx_vlm", models=vlm_models), "mlx_vlm.models": vlm_models,
                "vllm_metal": module("vllm_metal", __file__=str(plugin / "__init__.py")),
            }
            record = {"variant": "vllm-metal", "accelerator": "metal", "platform_class": "vllm_metal.platform.MetalPlatform", "errors": [], "architectures": []}
            with patch.dict(sys.modules, modules), patch("importlib.util.find_spec", return_value=None), patch("shutil.which", return_value=None):
                exec(compile(SOURCE, "metal_capabilities.py", "exec"), {"out": record})
            # qwen3_asr without a registry constructor is not advertised;
            # whisper keeps transcription and translation (translate needs whisper).
            self.assertEqual(record["metal_transcription_model_types"], ["whisper"])
            self.assertEqual(record["metal_translation_model_types"], ["whisper"])
            self.assertFalse(record["metal_stt_extras"])
            self.assertFalse(record["metal_ffmpeg"])

    def test_cpu_claim_skips_metal_source_imports(self):
        record = {"variant": "vllm-metal", "accelerator": "cpu", "errors": []}
        exec(compile(SOURCE, "metal_capabilities.py", "exec"), {"out": record})
        self.assertNotIn("metal_registry_scan", record)
        self.assertEqual(record["errors"], [])

    def test_scan_failure_is_readiness_error_without_fake_registry(self):
        record = {"variant": "vllm-metal", "accelerator": "metal", "platform_class": "vllm_metal.platform.MetalPlatform", "errors": []}
        with patch.dict(sys.modules, {"mlx_lm": None}):
            exec(compile(SOURCE, "metal_capabilities.py", "exec"), {"out": record})
        self.assertNotIn("metal_registry_scan", record)
        self.assertIn("Metal loader registry scan failed", record["errors"][0])


if __name__ == "__main__":
    unittest.main()
