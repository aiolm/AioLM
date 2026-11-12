import json, sys, pkgutil, platform, sysconfig, importlib.metadata as m
out = {"python_version": "%d.%d.%d" % sys.version_info[:3], "errors": [],
       "python_arch": platform.machine(), "python_implementation": platform.python_implementation(),
       "python_abi": sysconfig.get_config_var("SOABI") or "", "package_versions": {},
       "platform_system": platform.system(), "macos_version": platform.mac_ver()[0]}
for name in ("mlx-vlm", "mlx", "mlx-lm", "transformers", "tokenizers", "safetensors"):
    try:
        out["package_versions"][name] = m.version(name)
    except m.PackageNotFoundError:
        pass
try:
    out["version"] = m.version("mlx-vlm")
except Exception as e:
    out["errors"].append("mlx-vlm: %s" % e)
if out.get("version"):
    try:
        import mlx_vlm.models as models
        out["model_types"] = sorted(n for _, n, p in pkgutil.iter_modules(models.__path__) if p)
        # Package sources are read as text, never imported: a model package
        # is only executed when mlx-vlm loads that model.
        import os, re
        root = models.__path__[0]
        def sources(name):
            base = os.path.join(root, name)
            for directory, _, files in os.walk(base):
                for file in sorted(files):
                    if file.endswith(".py"):
                        path = os.path.join(directory, file)
                        try:
                            with open(path, encoding="utf-8", errors="replace") as f:
                                yield os.path.relpath(path, base).replace(os.sep, "/"), f.read(4194304)
                        except OSError:
                            pass
        image_generation = re.compile(r"is_image_generation_model\s*(?::\s*ClassVar\[bool\]\s*)?=\s*True")
        out["audio_model_types"], out["embedding_model_types"], out["image_generation_model_types"] = [], [], []
        for n in out["model_types"]:
            texts = list(sources(n))
            if any(f == "config.py" and ("AudioConfig" in t or "audio_config" in t) for f, t in texts):
                out["audio_model_types"].append(n)
            if any("EmbeddingOutput" in t for _, t in texts):
                out["embedding_model_types"].append(n)
            if any(image_generation.search(t) for _, t in texts):
                out["image_generation_model_types"].append(n)
        out["package_scan"] = 1
    except Exception as e:
        out["errors"].append("models: %s" % e)
    try:
        from mlx_vlm.utils import MODEL_REMAPPING
        out["model_type_aliases"] = {str(k): str(v) for k, v in MODEL_REMAPPING.items()}
        from mlx_vlm.embedding_loader import EMBEDDING_MODEL_REMAPPING
        out["embedding_model_type_aliases"] = {str(k): str(v) for k, v in EMBEDDING_MODEL_REMAPPING.items()}
    except Exception as e:
        out["errors"].append("remapping: %s" % e)
    try:
        import mlx.core as mx
        out["mlx_version"] = m.version("mlx")
        out["accelerator"] = "metal" if mx.metal.is_available() else str(mx.default_device())
    except Exception as e:
        out["errors"].append("mlx: %s" % e)
print("AIOLM_PROBE=" + json.dumps(out))
