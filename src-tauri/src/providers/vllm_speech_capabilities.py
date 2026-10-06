"""Read installed registered model sources without importing model kernels.

vLLM 0.31.0 interfaces.py distinguishes SupportsTranscription from ordinary
multimodal chat and supports_transcription_only from dual-purpose models.
An unrecognized inheritance chain remains unknown rather than gaining STT.
"""
import ast
import pathlib


def scan_speech_registry(record, package_root, entries):
    transcription, only, translation = set(), set(), set()
    root = pathlib.Path(package_root)
    for architecture, entry in entries.items():
        if not isinstance(entry, (tuple, list)) or len(entry) != 2:
            continue
        module, class_name = entry
        if not isinstance(module, str) or not isinstance(class_name, str):
            continue
        relative = module.removeprefix("vllm.") if module.startswith("vllm.") else "model_executor.models." + module
        if any(not part.isidentifier() for part in relative.split(".")):
            continue
        source = root.joinpath(*relative.split(".")).with_suffix(".py")
        try:
            if source.stat().st_size > 2 * 1024 * 1024:
                continue
            tree = ast.parse(source.read_text(encoding="utf-8"))
        except (OSError, SyntaxError, UnicodeError):
            continue
        classes = {node.name: node for node in tree.body if isinstance(node, ast.ClassDef)}

        def flags(name, visited):
            if name in visited or name not in classes:
                return False, False
            node = classes[name]
            visited = visited | {name}
            supports, exclusive = False, False
            for base in node.bases:
                base_name = base.id if isinstance(base, ast.Name) else ""
                if base_name == "SupportsTranscription":
                    supports = True
                else:
                    parent_supports, parent_only = flags(base_name, visited)
                    supports |= parent_supports
                    exclusive |= parent_only
            for item in node.body:
                targets = item.targets if isinstance(item, ast.Assign) else [item.target] if isinstance(item, ast.AnnAssign) else []
                value = getattr(item, "value", None)
                if not isinstance(value, ast.Constant) or type(value.value) is not bool:
                    continue
                for target in targets:
                    if isinstance(target, ast.Name) and target.id == "supports_transcription":
                        supports = value.value
                    if isinstance(target, ast.Name) and target.id == "supports_transcription_only":
                        exclusive = value.value
            return supports, exclusive

        supported, exclusive = flags(class_name, set())
        if supported:
            transcription.add(architecture)
            if exclusive:
                only.add(architecture)
            # The pinned Whisper implementation accepts both transcribe and
            # translate prompts. Other registered ASR classes need separate
            # translation evidence before the app offers that endpoint.
            if architecture == "WhisperForConditionalGeneration" and class_name == architecture:
                translation.add(architecture)
    record.update(transcription_architectures=sorted(transcription),
                  transcription_only_architectures=sorted(only),
                  translation_architectures=sorted(translation), transcription_scan=1)


if globals().get("out", {}).get("variant") == "standard" and globals().get("out", {}).get("version"):
    try:
        import vllm
        from vllm.model_executor.models import registry
        scan_speech_registry(out, pathlib.Path(vllm.__file__).parent,
                             getattr(registry, "_MULTIMODAL_MODELS", {}))
    except Exception:
        # Older or externally provided registry layouts require re-probing
        # after support is available; absence never grants an STT task.
        pass
