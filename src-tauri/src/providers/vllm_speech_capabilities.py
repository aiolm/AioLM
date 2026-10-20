"""Read installed registered model sources without importing model kernels.

vLLM 0.31.0 interfaces.py distinguishes SupportsTranscription from ordinary
multimodal chat and supports_transcription_only from dual-purpose models.
An unrecognized inheritance chain remains unknown rather than gaining STT.
"""
import ast
import pathlib


def _source_flags(text):
    tree = ast.parse(text)
    nodes = {node.name: node for node in tree.body if isinstance(node, ast.ClassDef)}
    root = ("builtin", "object")
    protocol = ("protocol", "SupportsTranscription")
    terminals = {root: (root,), protocol: (protocol, root)}
    declarations = {}
    attributes = {protocol: {"supports_transcription": True,
                             "supports_transcription_only": False}}
    flag_names = ("supports_transcription", "supports_transcription_only")
    for name, node in nodes.items():
        bases = []
        for base in node.bases:
            if isinstance(base, ast.Name) and base.id in nodes:
                key = ("local", base.id)
            elif isinstance(base, ast.Name) and base.id == "SupportsTranscription":
                key = protocol
            elif isinstance(base, ast.Name) and base.id == "object":
                key = root
            else:
                # Imported bases carry no flag evidence. Keep their identity in
                # C3 order without assuming an unknown nn.Module disables STT.
                key = ("external", ast.dump(base, include_attributes=False))
                terminals[key] = (key, root)
            bases.append(key)
        key = ("local", name)
        declarations[key] = tuple(bases) or (root,)
        own = {}
        for item in node.body:
            targets = item.targets if isinstance(item, ast.Assign) else [item.target] if isinstance(item, ast.AnnAssign) else []
            value = getattr(item, "value", None)
            if value is None:
                continue
            for target in targets:
                if isinstance(target, ast.Name) and target.id in flag_names:
                    # A nonliteral assignment shadows inherited evidence too;
                    # an annotation with no value does not set an attribute.
                    own[target.id] = value.value if isinstance(value, ast.Constant) and type(value.value) is bool else None
        attributes[key] = own
    del nodes, tree

    def linearize(start):
        # Temporary C3 state covers only the requested ancestry. The retained
        # source summary contains declarations and final booleans, not every
        # local class's full MRO (including unregistered classes).
        mros = dict(terminals)
        pending, visiting = [(start, False)], set()
        while pending:
            key, expanded = pending.pop()
            if expanded:
                visiting.discard(key)
            if key in mros:
                continue
            if not expanded:
                if key in visiting:
                    mros[key] = None
                    continue
                visiting.add(key)
                pending.append((key, True))
                pending.extend((base, False) for base in reversed(declarations[key]))
                continue
            bases = declarations[key]
            if any(mros[base] is None for base in bases):
                mros[key] = None
                continue
            if len(bases) == 1:
                mros[key] = (key,) + mros[bases[0]]
                continue
            sequences = [list(mros[base]) for base in bases] + [list(bases)]
            order = [key]
            while sequences:
                head = next((sequence[0] for sequence in sequences
                             if all(sequence[0] not in other[1:] for other in sequences)), None)
                if head is None:
                    # Cyclic or inconsistent local inheritance cannot grant a
                    # capability, including through an explicit direct flag.
                    order = None
                    break
                order.append(head)
                sequences = [sequence[1:] if sequence[0] == head else sequence
                             for sequence in sequences]
                sequences = [sequence for sequence in sequences if sequence]
            mros[key] = tuple(order) if order is not None else None
        return mros[start]

    results = {}

    def flags(name):
        key = ("local", name)
        if key not in declarations:
            return False, False
        if name not in results:
            order = linearize(key)
            values = []
            for flag in flag_names:
                value = next((attributes[base][flag] for base in order or ()
                              if flag in attributes.get(base, {})), None)
                values.append(value is True)
            results[name] = tuple(values)
        return results[name]

    return flags


def scan_speech_registry(record, package_root, entries):
    transcription, only, translation = set(), set(), set()
    root = pathlib.Path(package_root)
    latest_source, latest_text, latest_flags = None, None, None
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
            text = source.read_text(encoding="utf-8")
            # Every registration still reads fresh evidence. Retain only the
            # latest source's compact summary for this invocation, never ASTs
            # for all modules or a filename-only snapshot across reads.
            if source != latest_source or text != latest_text:
                latest_flags = _source_flags(text)
                latest_source, latest_text = source, text
        except (OSError, SyntaxError, UnicodeError):
            continue
        supported, exclusive = latest_flags(class_name)
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
