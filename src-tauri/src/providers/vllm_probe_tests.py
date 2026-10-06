"""Execute the production probe with synthetic packages; never install engines."""
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).with_name("vllm_probe.py").read_text(encoding="utf-8")


def package(name, **attrs):
    mod = types.ModuleType(name)
    mod.__path__ = []
    vars(mod).update(attrs)
    return mod


def probe(*, os="Darwin", arch="arm64", macos="15.0", python=(3, 12, 7),
          selected="metal", available=True, native=True, plugin=True,
          imported_core="0.30.0+cpu", imported_plugin="0.30.0"):
    versions = {"vllm": "0.30.0+cpu", "mlx": "0.32.1", "mlx-lm": "synthetic",
                "mlx-vlm": "0.6.8", "nanobind": "2.10.2", "llguidance": "1.7.0",
                "transformers": "5.10.4", "torch": "2.11.0", "tokenizers": "0.22.0"}
    if plugin:
        versions["vllm-metal"] = "0.30.0"
    def version(name):
        if name not in versions:
            import importlib.metadata
            raise importlib.metadata.PackageNotFoundError(name)
        return versions[name]
    metal_class = type("MetalPlatform", (), {"__module__": "vllm_metal.platform", "is_available": staticmethod(lambda: available)})
    cpu_class = type("CpuPlatform", (), {"__module__": "vllm.platforms.cpu"})
    registry = package("vllm.model_executor.models.registry", _TEXT_GENERATION_MODELS={"SyntheticForCausalLM": None})
    modules = {
        "vllm": package("vllm", __version__=imported_core),
        "vllm.platforms": package("vllm.platforms", current_platform=(metal_class if selected == "metal" else cpu_class)()),
        "vllm.model_executor": package("vllm.model_executor"),
        "vllm.model_executor.models": package("vllm.model_executor.models", ModelRegistry=types.SimpleNamespace(get_supported_archs=lambda: ["SyntheticForCausalLM"]), registry=registry),
        "vllm.model_executor.models.registry": registry,
        "vllm_metal": package("vllm_metal", __version__=imported_plugin),
        "vllm_metal.platform": package("vllm_metal.platform", MetalPlatform=metal_class),
        "vllm_metal.metal": package("vllm_metal.metal"),
        "mlx": package("mlx"),
        "mlx.core": package("mlx.core", metal=types.SimpleNamespace(is_available=lambda: available)),
        "torch": package("torch", version=types.SimpleNamespace(hip=None), cuda=types.SimpleNamespace(is_available=lambda: False)),
    }
    if native:
        modules["vllm_metal.metal._paged_ops"] = package("vllm_metal.metal._paged_ops")
    distribution = types.SimpleNamespace(read_text=lambda name: '{"vcs_info":{"commit_id":"9e6acca691e64d6d8bb808c328fcdea459099cca"},"url":"synthetic-private-path"}')
    with patch.dict(sys.modules, modules), patch("importlib.metadata.version", side_effect=version), \
         patch("importlib.metadata.distribution", return_value=distribution), \
         patch("platform.system", return_value=os), patch("platform.machine", return_value=arch), \
         patch("platform.mac_ver", return_value=(macos, (), arch)), \
         patch("platform.python_implementation", return_value="CPython"), \
         patch("sysconfig.get_config_var", return_value="cpython-312-darwin"), \
         patch.object(sys, "platform", "darwin" if os == "Darwin" else "linux"), \
         patch.object(sys, "version_info", python):
        namespace = {}
        exec(compile(SOURCE, "vllm_probe.py", "exec"), namespace)
        return namespace["out"]


class ProbeTests(unittest.TestCase):
    def test_matched_selected_platform_records_imported_native_provenance(self):
        result = probe()
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["variant"], "vllm-metal")
        self.assertEqual(result["accelerator"], "metal")
        self.assertTrue(result["metal_native_importable"])
        self.assertEqual(result["imported_version"], "0.30.0+cpu")
        self.assertEqual(result["imported_metal_version"], "0.30.0")
        self.assertEqual(result["package_versions"]["mlx-lm-commit"], "9e6acca691e64d6d8bb808c328fcdea459099cca")
        self.assertEqual(result["package_versions"]["transformers"], "5.10.4")
        self.assertNotIn("synthetic-private-path", str(result))

    def test_mlx_on_linux_cannot_turn_cpu_vllm_into_metal(self):
        result = probe(os="Linux", arch="x86_64", macos="", plugin=False, selected="cpu")
        self.assertEqual(result["variant"], "standard")
        self.assertEqual(result["accelerator"], "cpu")
        self.assertNotIn("metal_available", result)

    def test_wrong_platform_unavailable_gpu_and_missing_binary_fail(self):
        for options in ({"selected": "cpu"}, {"available": False}, {"native": False}):
            with self.subTest(options=options):
                result = probe(**options)
                self.assertTrue(result["errors"])
                self.assertNotEqual(result.get("accelerator"), "metal")

    def test_unsupported_machine_python_os_and_missing_plugin_fail(self):
        for options in ({"arch": "x86_64"}, {"macos": "14.9"}, {"python": (3, 13, 0)}, {"os": "Linux"}, {"plugin": False}):
            with self.subTest(options=options):
                self.assertTrue(probe(**options)["errors"])

    def test_imported_versions_are_recorded_for_rust_validation(self):
        result = probe(imported_core="0.29.0", imported_plugin="0.29.0")
        self.assertNotEqual(result["version"], result["imported_version"])
        self.assertNotEqual(result["metal_version"], result["imported_metal_version"])


if __name__ == "__main__":
    unittest.main()
