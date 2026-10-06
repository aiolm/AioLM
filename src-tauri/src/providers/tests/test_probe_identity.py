"""Probe package identity using synthetic modules, never installed engines."""
import importlib.metadata
import json
from pathlib import Path
import platform
import sys
import sysconfig
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


PROVIDERS = Path(__file__).resolve().parents[1]


def module(name, **attributes):
    value = ModuleType(name)
    value.__dict__.update(attributes)
    return value


class ProbeIdentityTests(unittest.TestCase):
    def probe(self, metal=False):
        versions = {
            "vllm": "0.30.0+cpu" if metal else "0.31.0",
            "torch": "synthetic-torch",
            "transformers": "synthetic-transformers",
            "tokenizers": "synthetic-tokenizers",
            "safetensors": "synthetic-safetensors",
        }
        if metal:
            versions.update({"vllm-metal": "0.30.0", "mlx": "0.32.1",
                             "mlx-lm": "synthetic-mlx-lm", "mlx-vlm": "0.6.8",
                             "nanobind": "2.10.2", "llguidance": "1.7.0"})

        def version(name):
            if name not in versions:
                raise importlib.metadata.PackageNotFoundError(name)
            return versions[name]

        class MetalPlatform:
            @staticmethod
            def is_available():
                return True

        MetalPlatform.__module__ = "vllm_metal.platform"
        registry = SimpleNamespace(_TEXT_GENERATION_MODELS={"SyntheticForCausalLM": ()},
                                   _EMBEDDING_MODELS={}, _MULTIMODAL_MODELS={})
        modules = {
            "vllm": module("vllm", __version__="0.30.0" if metal else "0.31.0"),
            "vllm.platforms": module("vllm.platforms", current_platform=MetalPlatform() if metal else object()),
            "vllm.model_executor": module("vllm.model_executor"),
            "vllm.model_executor.models": module("vllm.model_executor.models", registry=registry,
                ModelRegistry=SimpleNamespace(get_supported_archs=lambda: ["SyntheticForCausalLM"])),
            "torch": module("torch", version=SimpleNamespace(hip=None),
                cuda=SimpleNamespace(is_available=lambda: False)),
            "vllm_metal": module("vllm_metal", __version__="0.30.0"),
            "vllm_metal.platform": module("vllm_metal.platform", MetalPlatform=MetalPlatform),
            "vllm_metal.metal": module("vllm_metal.metal"),
            "vllm_metal.metal._paged_ops": module("vllm_metal.metal._paged_ops"),
            "mlx": module("mlx"),
            "mlx.core": module("mlx.core", metal=SimpleNamespace(is_available=lambda: True)),
        }
        commit = "9e6acca691e64d6d8bb808c328fcdea459099cca"
        distribution = SimpleNamespace(read_text=lambda _: json.dumps({"vcs_info": {"commit_id": commit}}))
        namespace = {}
        with patch.dict(sys.modules, modules), \
                patch.object(importlib.metadata, "version", side_effect=version), \
                patch.object(importlib.metadata, "distribution", return_value=distribution), \
                patch.object(sys, "platform", "darwin" if metal else "linux"), \
                patch.object(sys, "version_info", (3, 12, 7)), \
                patch.object(platform, "system", return_value="Darwin" if metal else "Linux"), \
                patch.object(platform, "machine", return_value="arm64" if metal else "x86_64"), \
                patch.object(platform, "mac_ver", return_value=("15.0", (), "arm64")), \
                patch.object(platform, "python_implementation", return_value="CPython"), \
                patch.object(sysconfig, "get_config_var", return_value="cpython-312-darwin" if metal else "cpython-312-x86_64-linux-gnu"):
            source = PROVIDERS.joinpath("vllm_probe.py").read_text(encoding="utf-8")
            exec(compile(source, "vllm_probe.py", "exec"), namespace)
        return namespace["out"]

    def test_linux_probe_records_dependency_identity_without_metal_claims(self):
        record = self.probe()
        self.assertEqual(record["errors"], [])
        self.assertEqual(record["variant"], "standard")
        self.assertEqual(record["accelerator"], "cpu")
        self.assertEqual(record["package_versions"]["torch"], "synthetic-torch")
        self.assertEqual(record["package_versions"]["tokenizers"], "synthetic-tokenizers")
        self.assertNotIn("metal_version", record)

    def test_metal_probe_keeps_distinct_import_version_and_source_revision(self):
        record = self.probe(metal=True)
        self.assertEqual(record["errors"], [])
        self.assertEqual(record["version"], "0.30.0+cpu")
        self.assertEqual(record["imported_version"], "0.30.0")
        self.assertEqual(record["package_versions"]["mlx-lm-commit"], "9e6acca691e64d6d8bb808c328fcdea459099cca")
        self.assertEqual(record["platform_class"], "vllm_metal.platform.MetalPlatform")
        self.assertTrue(record["metal_native_importable"])
        self.assertEqual(record["accelerator"], "metal")

    def test_mlx_probe_records_dependencies_without_importing_model_packages(self):
        versions = {"mlx-vlm": "0.7.6", "mlx": "synthetic-mlx", "mlx-lm": "synthetic-mlx-lm",
                    "transformers": "synthetic-transformers", "tokenizers": "synthetic-tokenizers",
                    "safetensors": "synthetic-safetensors"}
        modules = {
            "mlx_vlm": module("mlx_vlm"),
            "mlx_vlm.models": module("mlx_vlm.models", __path__=["synthetic-unread-directory"]),
            "mlx_vlm.utils": module("mlx_vlm.utils", MODEL_REMAPPING={}),
            "mlx_vlm.embedding_loader": module("mlx_vlm.embedding_loader", EMBEDDING_MODEL_REMAPPING={}),
            "mlx": module("mlx"),
            "mlx.core": module("mlx.core", metal=SimpleNamespace(is_available=lambda: True)),
        }
        rust = PROVIDERS.joinpath("python_env.rs").read_text(encoding="utf-8")
        script = rust.split('const MLX_VLM_PROBE: &str = r#"', 1)[1].split('"#;', 1)[0]
        namespace = {}
        with patch.dict(sys.modules, modules), \
                patch.object(importlib.metadata, "version", side_effect=lambda name: versions[name]), \
                patch("pkgutil.iter_modules", return_value=[]), \
                patch.object(sysconfig, "get_config_var", return_value="synthetic-abi"), \
                patch("builtins.print"):
            exec(compile(script, "mlx_probe.py", "exec"), namespace)
        record = namespace["out"]
        self.assertEqual(record["errors"], [])
        self.assertEqual(record["mlx_version"], "synthetic-mlx")
        self.assertEqual(record["package_versions"]["tokenizers"], "synthetic-tokenizers")
        self.assertEqual(record["python_abi"], "synthetic-abi")
        self.assertEqual(record["model_types"], [])


if __name__ == "__main__":
    unittest.main()
