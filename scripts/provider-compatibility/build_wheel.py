"""Build an explicitly selected compatibility wheel without changing its source.

The audited vLLM 0.30.0 and mlx-vlm 0.7.6 corrections preserve file allowlists,
model weights and request roles. Install the output into a separate runtime;
its local version and wheel provenance distinguish it from upstream packages.
"""
import argparse
import base64
import csv
import copy
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path, PurePosixPath


LOCAL_VERSIONS = {"vllm": "aiolm.media1", "mlx-vlm": "aiolm.media8"}


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError("upstream source differs from the audited patch; refusing to guess")
    return text.replace(before, after, 1)


def patch_vllm(text):
    text = replace_once(text,
        '            raise RuntimeError(\n                "Cannot load local files without `--allowed-local-media-path`."',
        '            raise VLLMValidationError(\n                "Cannot load local files without `--allowed-local-media-path`."')
    return replace_once(text,
        '            raise ValueError(\n                f"The file path {filepath} must be a subpath "',
        '            raise VLLMValidationError(\n                f"The file path {filepath} must be a subpath "')


def patch_mlx_normalization(text):
    text = replace_once(text, 'import json\n', 'import json\n\nfrom fastapi import HTTPException\n')
    return replace_once(text,
        'def _chat_message_to_prompt(message):\n    content = message.get("content")\n',
        '''def _chat_message_to_prompt(message):
    content = message.get("content")
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            media = item.get("image_url") or item.get("input_audio") or item.get("video_url") or item.get("input_video") or item.get("video")
            reference = media.get("url", media.get("data")) if isinstance(media, dict) else media
            if isinstance(reference, str) and reference.strip().lower().startswith("file:"):
                raise HTTPException(status_code=400, detail="file:// media references are not supported; use an encoded media input.")
''')


def patch_mlx_prompt(text):
    # Preserve audio markers before the model-specific formatter allocates them.
    text = replace_once(text,
        '        if kind in ("image", "image_url", "input_image"):\n            parts.append({"type": "image"})\n',
        '        if kind in ("image", "image_url", "input_image"):\n            parts.append({"type": "image"})\n        elif kind in ("audio", "input_audio"):\n            parts.append({"type": "audio"})\n')
    text = replace_once(text,
        '    if any(part["type"] == "image" for part in parts):\n',
        '    if any(part["type"] in ("image", "audio") for part in parts):\n')
    return replace_once(text,
        '        audio_counts = [0] * len(prompt)\n        if last_user_idx >= 0:\n            audio_counts[last_user_idx] = num_audios\n',
        '''        explicit_audio_counts = [
            _content_media_count(p.get("content"), ("audio", "input_audio"))
            if isinstance(p, dict) and p.get("role", "user") == "user" else 0
            for p in prompt
        ]
        if sum(explicit_audio_counts) > num_audios:
            raise ValueError("Audio markers exceed the supplied audio inputs")
        audio_counts = _allocate_media_counts(explicit_audio_counts, num_audios)
''')


def patch_mlx_preflight(text):
    # Context overflow already finalizes its metric and returns HTTP 400.
    # Other decoder/preparation failures and cancellation need the same cleanup.
    before = '        raise HTTPException(status_code=400, detail=str(e))\n\n\ndef _build_structured_logits_processors'
    after = '        raise HTTPException(status_code=400, detail=str(e))\n    except BaseException as exc:\n        runtime.metrics.record_failure(\n            endpoint=endpoint, model=model, stream=True, error=str(exc),\n        )\n        if audio and isinstance(exc, ValueError) and str(exc) == "Unable to detect audio format from bytes":\n            raise HTTPException(status_code=400, detail="Unable to decode input_audio: unrecognized audio data.") from exc\n        raise\n\n\ndef _build_structured_logits_processors'
    return replace_once(text, before, after)


def patch_mlx_gemma4_audio(text):
    # Different recording lengths leave padding between encoded clips. Those
    # rows must not occupy the next clip's language-model audio-token slots.
    text = replace_once(text, "\n\nclass MultimodalEmbedder(nn.Module):", '''

def _pack_audio_features(features, padding_mask):
    positions = [
        index for index, padded in enumerate(padding_mask.reshape(-1).tolist())
        if not padded
    ]
    if not positions:
        raise ValueError("Audio encoder produced no valid frames")
    return mx.take(
        features.reshape(-1, features.shape[-1]),
        mx.array(positions, dtype=mx.int32), axis=0,
    )


class MultimodalEmbedder(nn.Module):''')
    return replace_once(text,
        "                enc, _ = self.audio_tower(feat, mask)\n                return self.embed_audio(enc)\n",
        "                enc, encoded_padding = self.audio_tower(feat, mask)\n                return _pack_audio_features(self.embed_audio(enc), encoded_padding)\n")


def patch_mlx_gemma3n_embeddings(text):
    # The language model scales token embeddings when it receives token IDs.
    # Media prefill supplies embeddings directly, so scale text here before
    # replacing media slots with their separately normalized projections.
    return replace_once(text,
        "        inputs_embeds = self.language_model.model.embed_tokens(input_ids)\n",
        "        inputs_embeds = self.language_model.model.embed_tokens(input_ids) * (self.config.text_config.hidden_size**0.5)\n")


def patch_mlx_gemma3n_positions(text):
    # The concrete layer already appended this chunk to a shared cache. Its
    # consumers must rotate queries at the chunk's start, rather than its end.
    text = replace_once(text,
        "            keys, values = state[0], state[1]\n            offset = cache.offset\n",
        "            keys, values = state[0], state[1]\n            offset = cache.offset - L\n")
    # Batched cache offsets are mutable arrays. Rotate both queries and keys
    # before update_and_fetch advances that array in the concrete layer.
    return replace_once(text,
        "            if cache is not None:\n                keys, values = cache.update_and_fetch(keys, values)\n\n        queries = queries.transpose(0, 2, 1, 3)\n        queries = self.rope(queries, offset=offset)\n",
        "            queries = queries.transpose(0, 2, 1, 3)\n            queries = self.rope(queries, offset=offset)\n            if cache is not None:\n                keys, values = cache.update_and_fetch(keys, values)\n\n        if self.is_kv_shared_layer and cache is not None:\n            queries = queries.transpose(0, 2, 1, 3)\n            queries = self.rope(queries, offset=offset)\n")


def patch_mlx_special_tokens(text):
    # A processor's **kwargs accepts tokenizer options even when its signature
    # does not enumerate them. Preserve the caller's template token policy.
    return replace_once(text,
        '    if "add_special_tokens" in parameters:\n',
        '    if "add_special_tokens" in parameters or any(\n        parameter.kind == inspect.Parameter.VAR_KEYWORD\n        for parameter in parameters.values()\n    ):\n')


def patch_mlx_gemma3n_template(text):
    # Generation checks the processor template, while prompt rendering can
    # fall back to the tokenizer. Both must describe the same loaded template.
    return replace_once(text,
        '            tokenizer=tokenizer,\n            **proc_kwargs,\n',
        '            tokenizer=tokenizer,\n            chat_template=getattr(tokenizer, "chat_template", None),\n            **proc_kwargs,\n')


PATCHES = {
    "vllm": {"vllm/multimodal/media/connector.py": patch_vllm},
    "mlx-vlm": {
        "mlx_vlm/server/request_normalization.py": patch_mlx_normalization,
        "mlx_vlm/prompt_utils.py": patch_mlx_prompt,
        "mlx_vlm/server/app.py": patch_mlx_preflight,
        "mlx_vlm/models/gemma4/gemma4.py": patch_mlx_gemma4_audio,
        "mlx_vlm/models/gemma3n/gemma3n.py": patch_mlx_gemma3n_embeddings,
        "mlx_vlm/models/gemma3n/language.py": patch_mlx_gemma3n_positions,
        "mlx_vlm/utils.py": patch_mlx_special_tokens,
        "mlx_vlm/models/gemma3n/processing_gemma3n.py": patch_mlx_gemma3n_template,
    },
}


def build_wheel(source, output_directory, expected_sha256, provider):
    source, output_directory = Path(source), Path(output_directory)
    original = source.read_bytes()
    source_digest = hashlib.sha256(original).hexdigest()
    if source_digest != expected_sha256:
        raise ValueError("source wheel SHA-256 mismatch")
    with zipfile.ZipFile(io.BytesIO(original)) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or any("\\" in name or PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts for name in names):
            raise ValueError("unsafe or duplicate wheel members")
        files = {name: archive.read(name) for name in names if not name.endswith("/")}
        attributes = {name: copy.copy(archive.getinfo(name)) for name in files}
    metadata_paths = [name for name in files if name.endswith(".dist-info/METADATA")]
    if len(metadata_paths) != 1:
        raise ValueError("wheel requires exactly one distribution metadata directory")
    metadata_path = metadata_paths[0]
    metadata = files[metadata_path].decode()
    name = re.search(r"^Name: (.+)$", metadata, re.MULTILINE)
    version = re.search(r"^Version: (.+)$", metadata, re.MULTILINE)
    if not name or not version or name[1].replace("_", "-") != provider:
        raise ValueError("wheel distribution identity does not match the selected provider")
    old_version = version[1]
    if (provider == "vllm" and old_version != "0.30.0+cpu") or (provider == "mlx-vlm" and old_version != "0.7.6"):
        raise ValueError("this upstream version has not been audited")
    new_version = old_version + ("." if "+" in old_version else "+") + LOCAL_VERSIONS[provider]
    changes = []
    for member, correction in PATCHES[provider].items():
        before = files[member]
        after = correction(before.decode()).encode()
        compile(after, member, "exec")
        files[member] = after
        changes.append({"member": member, "before_sha256": hashlib.sha256(before).hexdigest(), "after_sha256": hashlib.sha256(after).hexdigest()})
    old_info = metadata_path.rsplit("/", 1)[0]
    new_info = old_info.replace(old_version, new_version)
    if new_info == old_info:
        raise ValueError("distribution directory does not contain its recorded version")
    if any(name.endswith(("/RECORD.jws", "/RECORD.p7s")) for name in files):
        raise ValueError("signed wheels must be rebuilt through their signing process")
    metadata = replace_once(metadata, "Version: " + old_version + "\n", "Version: " + new_version + "\n")
    files[metadata_path] = metadata.encode()
    files = {name.replace(old_info + "/", new_info + "/", 1) if name.startswith(old_info + "/") else name: data for name, data in files.items()}
    attributes = {name.replace(old_info + "/", new_info + "/", 1) if name.startswith(old_info + "/") else name: info for name, info in attributes.items()}
    audit = {"schema_version": 1, "source_wheel_sha256": source_digest, "upstream_version": old_version, "local_version": new_version, "corrections": changes}
    files[new_info + "/aiolm_compatibility.json"] = (json.dumps(audit, indent=2) + "\n").encode()
    record_path = new_info + "/RECORD"
    rows = []
    for member, data in sorted(files.items()):
        if member != record_path:
            digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
            rows.append((member, "sha256=" + digest, str(len(data))))
    rows.append((record_path, "", ""))
    buffer = io.StringIO(newline="")
    csv.writer(buffer).writerows(rows)
    files[record_path] = buffer.getvalue().encode()
    output = output_directory / source.name.replace(old_version + "-", new_version + "-", 1)
    if output.name == source.name:
        raise ValueError("wheel filename does not contain its recorded version")
    if not output_directory.is_dir():
        raise ValueError("output directory must exist")
    created = False
    try:
        with output.open("xb") as stream:
            created = True
            with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for member, data in sorted(files.items()):
                    info = attributes.get(member, zipfile.ZipInfo(member))
                    info.filename = member
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, data)
        if source.read_bytes() != original:
            raise ValueError("source wheel changed during reconstruction")
    except BaseException:
        if created:
            output.unlink(missing_ok=True)
        raise
    return {**audit, "output_wheel_sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "output_filename": output.name}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=PATCHES, required=True)
    parser.add_argument("--wheel", type=Path, required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build_wheel(args.wheel, args.output_directory, args.source_sha256, args.provider), indent=2))
