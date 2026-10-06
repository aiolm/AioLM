# Probe only the selected interpreter; no package installation or model loads.
import importlib.metadata as m
import json
import platform
import sys
import sysconfig

out = {
    "python_version": "%d.%d.%d" % sys.version_info[:3],
    "python_arch": platform.machine(),
    "python_implementation": platform.python_implementation(),
    "python_abi": sysconfig.get_config_var("SOABI") or "",
    "platform_system": platform.system(),
    "macos_version": platform.mac_ver()[0],
    "variant": "standard",
    "package_versions": {},
    "errors": [],
}

try:
    out["version"] = m.version("vllm")
except Exception as e:
    out["errors"].append("vllm: %s" % e)

# Numerical verification identity includes dependencies for Linux runtimes too.
# Optional distributions may be absent; the imports below establish readiness.
for name in ("vllm", "torch", "transformers", "tokenizers", "safetensors"):
    try:
        out["package_versions"][name] = m.version(name)
    except m.PackageNotFoundError:
        pass

try:
    out["metal_version"] = m.version("vllm-metal")
except m.PackageNotFoundError:
    pass

# A macOS core without the plugin must fail readiness. A plugin installed on
# Linux is recorded as an unsupported variant and never assigned Metal compute.
if sys.platform == "darwin" or out.get("metal_version"):
    out["variant"] = "vllm-metal"
    for name in ("vllm", "vllm-metal", "mlx", "mlx-lm", "mlx-vlm", "nanobind", "llguidance", "transformers", "torch", "tokenizers"):
        try:
            out["package_versions"][name] = m.version(name)
        except Exception as e:
            out["errors"].append("%s: %s" % (name, e))
    try:
        provenance = json.loads(m.distribution("mlx-lm").read_text("direct_url.json") or "{}")
        commit = provenance.get("vcs_info", {}).get("commit_id", "")
        if not commit and "portable_source_commit" in globals():
            commit = portable_source_commit(m.distribution("mlx-lm"))
        if len(commit) == 40 and all(c in "0123456789abcdefABCDEF" for c in commit):
            # Persist the revision only; local source paths and URLs are user data.
            out["package_versions"]["mlx-lm-commit"] = commit.lower()
    except (m.PackageNotFoundError, ValueError, TypeError, AttributeError):
        pass
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        out["errors"].append("vllm-metal requires native Apple Silicon macOS")
    if sys.version_info[:2] != (3, 12) or platform.python_implementation() != "CPython":
        out["errors"].append("vllm-metal release wheels require CPython 3.12")
    try:
        if int(platform.mac_ver()[0].split(".")[0]) < 15:
            out["errors"].append("vllm-metal release wheels require macOS 15 or later")
    except (ValueError, IndexError):
        out["errors"].append("cannot establish macOS version for vllm-metal")

if out.get("version"):
    try:
        import vllm
        out["imported_version"] = vllm.__version__
        from vllm.platforms import current_platform
        cls = type(current_platform)
        out["platform_class"] = cls.__module__ + "." + cls.__name__
        if out["variant"] == "vllm-metal":
            import vllm_metal
            out["imported_metal_version"] = vllm_metal.__version__
            from vllm_metal.platform import MetalPlatform
            import mlx.core as mx
            out["mlx_version"] = m.version("mlx")
            out["metal_available"] = bool(mx.metal.is_available()) and bool(MetalPlatform.is_available())
            if out["platform_class"] != "vllm_metal.platform.MetalPlatform" or not out["metal_available"]:
                raise RuntimeError("vLLM did not select an available vllm-metal MetalPlatform")
            # Import the shipped binary directly: no JIT compilation fallback.
            # This catches incompatible MLX linkage and a missing cp312 artifact.
            import vllm_metal.metal._paged_ops
            out["metal_native_importable"] = True
            out["accelerator"] = "metal"
        else:
            import torch
            if getattr(torch.version, "hip", None) and torch.cuda.is_available():
                out["accelerator"] = "rocm"
            elif torch.cuda.is_available():
                out["accelerator"] = "cuda"
            elif hasattr(torch, "xpu") and torch.xpu.is_available():
                out["accelerator"] = "xpu"
            else:
                out["accelerator"] = "cpu"
    except Exception as e:
        out["errors"].append("platform: %s" % e)
    try:
        from vllm.model_executor.models import ModelRegistry, registry
        out["architectures"] = sorted(ModelRegistry.get_supported_archs())
        out["generation_architectures"] = sorted(getattr(registry, "_TEXT_GENERATION_MODELS", {}))
        out["embedding_architectures"] = sorted(getattr(registry, "_EMBEDDING_MODELS", {}))
        out["multimodal_architectures"] = sorted(getattr(registry, "_MULTIMODAL_MODELS", {}))
    except Exception as e:
        out["errors"].append("registry: %s" % e)
