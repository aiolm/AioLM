"""Conservative installed loader evidence for vllm-metal v0.30.0.

Executed within the selected interpreter by the environment probe. Module
discovery reads installed sources; it never downloads or loads model weights.
"""


def probe_metal_capabilities(record):
    import ast
    import importlib.util
    import pathlib

    text_types = {
        "qwen2", "qwen3", "qwen3_moe", "qwen3_5", "qwen3_5_moe", "qwen3_next",
        "lfm2", "nemotron_h", "granitemoehybrid", "gemma4", "gemma4_text",
        "gemma3", "gemma3_text", "llama", "mistral", "stablelm", "phi", "phi3",
        "gpt_oss", "minicpm3", "glm4_moe_lite", "smollm3", "granite", "exaone4",
        "laguna", "hunyuan", "hunyuan_v1_dense", "minimax_m2", "olmo2", "olmoe", "olmo3",
    }
    # The pinned plugin calls mlx_lm.load for text. Resolve its installed
    # remapping table and verify that each model module has Model/ModelArgs.
    import mlx_lm.models
    from mlx_lm.utils import MODEL_REMAPPING
    import vllm_metal

    root = pathlib.Path(mlx_lm.models.__file__).parent
    installed = set()
    for model_type in text_types:
        module = MODEL_REMAPPING.get(model_type, model_type)
        source = root / (module + ".py")
        if not source.is_file():
            continue
        tree = ast.parse(source.read_text(encoding="utf-8"))
        classes = {node.name for node in tree.body if isinstance(node, ast.ClassDef)}
        for node in tree.body:
            if isinstance(node, ast.ImportFrom):
                classes.update(alias.asname or alias.name for alias in node.names)
        if {"Model", "ModelArgs"} <= classes:
            installed.add(model_type)

    # Native multimodal support is adapter-owned, not ModelRegistry-owned.
    adapter = pathlib.Path(vllm_metal.__file__).parent / "v1" / "model_adapter.py"
    adapter_tree = ast.parse(adapter.read_text(encoding="utf-8"))
    image_types = set()
    for node in adapter_tree.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.target.id in {"_QWEN3_VL_MODEL_TYPES", "_PADDLEOCR_VL_MODEL_TYPES"}:
                if isinstance(node.value, ast.Call) and node.value.args:
                    image_types.update(ast.literal_eval(node.value.args[0]))
    import mlx_vlm.models
    vlm_root = pathlib.Path(mlx_vlm.models.__file__).parent
    image_types &= {"qwen3_vl", "qwen3_5", "paddleocr_vl"}
    image_types = {name for name in image_types if (vlm_root / name / "__init__.py").is_file()}

    pool_root = pathlib.Path(vllm_metal.__file__).parent / "v1" / "pooling" / "backends"
    embed_types = {"qwen3"} & installed if (pool_root / "decoder" / "factory.py").is_file() else set()
    if (pool_root / "encoder" / "models" / "xlm_roberta.py").is_file():
        embed_types.update({"xlm-roberta", "roberta"})

    # Native speech-to-text is a separate task/session, never audio chat.
    # vllm-metal v0.30.0 docs/stt.md: Whisper (transcribe + translate) and
    # Qwen3-ASR (transcription-only). Detection reads the installed
    # vllm_metal/stt/detection.py _STT_MODEL_TYPES and requires a matching
    # constructor in vllm_metal/stt/registry.py. WAV works with the stt
    # extra (librosa/numba); non-WAV needs a local ffmpeg binary.
    stt_root = pathlib.Path(vllm_metal.__file__).parent / "stt"
    transcription_types = set()
    detection = stt_root / "detection.py"
    registry = stt_root / "registry.py"
    if detection.is_file() and registry.is_file():
        detection_tree = ast.parse(detection.read_text(encoding="utf-8"))
        for node in detection_tree.body:
            target = None
            value = None
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                target, value = node.targets[0], node.value
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                target, value = node.target, node.value
            if isinstance(target, ast.Name) and target.id == "_STT_MODEL_TYPES" and value is not None:
                if isinstance(value, ast.Call) and value.args:
                    value = value.args[0]
                try:
                    transcription_types.update(ast.literal_eval(value))
                except Exception:
                    pass
        registry_tree = ast.parse(registry.read_text(encoding="utf-8"))
        constructed = set()
        for node in registry_tree.body:
            target = None
            value = None
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                target, value = node.targets[0], node.value
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                target, value = node.target, node.value
            if isinstance(target, ast.Name) and target.id == "_STT_MODEL_CONSTRUCTORS" and isinstance(value, ast.Dict):
                for key in value.keys:
                    try:
                        constructed.add(ast.literal_eval(key))
                    except Exception:
                        pass
        transcription_types = {
            name for name in transcription_types
            if isinstance(name, str) and name in constructed
        }
    transcription_types &= {"whisper", "qwen3_asr"}
    translation_types = {"whisper"} & transcription_types
    stt_extras = (
        importlib.util.find_spec("librosa") is not None
        and importlib.util.find_spec("numba") is not None
    )
    import shutil
    ffmpeg = shutil.which("ffmpeg") is not None
    record.update(
        metal_model_types=sorted(installed),
        metal_multimodal_model_types=sorted(image_types),
        metal_embedding_model_types=sorted(embed_types),
        metal_transcription_model_types=sorted(transcription_types),
        metal_translation_model_types=sorted(translation_types),
        metal_transcription_scan=1,
        metal_stt_extras=stt_extras,
        metal_ffmpeg=ffmpeg,
        metal_gguf=importlib.util.find_spec("gguf") is not None,
        metal_registry_scan=1,
    )


if (globals().get("out", {}).get("variant") == "vllm-metal"
        and out.get("accelerator") == "metal"
        and out.get("platform_class") == "vllm_metal.platform.MetalPlatform"):
    try:
        probe_metal_capabilities(out)
    except Exception as exc:
        out.setdefault("errors", []).append("Metal loader registry scan failed: " + str(exc))
