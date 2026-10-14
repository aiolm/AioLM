#!/usr/bin/env python3
"""Create an external runtime manifest, or perform its model-specific probe.

No downloads, installs, inference or changes to engine/model files occur here.
The launch remains a direct owned child; this helper only inspects the selected
build and loader inputs. Strata's installed deployment JSON is its model binding.
"""
import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import re
import struct
import subprocess
import sys


LIMIT = 262144
SHARED_LIBRARY = re.compile(r"\.(dll|dylib|so)(\.\d+)*$", re.IGNORECASE)


def capture(args, cwd=None, env=None):
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        raise ValueError("runtime version/help probe failed; inspect the selected installation")
    return (result.stdout + result.stderr)[:65536]


def file_path(value):
    path = Path(value).absolute()
    if not path.is_file():
        raise ValueError("selected executable/config/adapter file is missing")
    return path


def read_json(path):
    with path.open("rb") as stream:
        raw = stream.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError("deployment config exceeds 256 KiB")
    value = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("deployment config must be an object")
    return value


def gguf_metadata(path):
    size = path.stat().st_size
    with path.open("rb") as stream:
        def read(n):
            value = stream.read(n)
            if len(value) != n:
                raise ValueError("GGUF metadata is truncated")
            return value
        def integer(fmt):
            return struct.unpack("<" + fmt, read(struct.calcsize(fmt)))[0]
        def string(keep=False):
            length = integer("Q")
            if length > 4 * 1024 * 1024 or stream.tell() + length > size:
                raise ValueError("invalid GGUF metadata string")
            if keep:
                return read(length).decode("utf-8")
            stream.seek(length, 1)
            return None
        def value(kind, keep=False):
            if kind == 8:
                return string(keep)
            if kind == 9:
                element, count = integer("I"), integer("Q")
                if count > 1000000 or element == 9:
                    raise ValueError("unsupported GGUF metadata array")
                for _ in range(count):
                    value(element)
                return None
            formats = {0:"B", 1:"b", 2:"H", 3:"h", 4:"I", 5:"i", 6:"f", 7:"?", 10:"Q", 11:"q", 12:"d"}
            if kind not in formats:
                raise ValueError("unsupported GGUF metadata type")
            return integer(formats[kind])
        if read(4) != b"GGUF" or integer("I") not in (2, 3):
            raise ValueError("select a supported GGUF file")
        tensors, count = integer("Q"), integer("Q")
        if tensors == 0 or count > 100000:
            raise ValueError("GGUF has no weights or invalid metadata")
        fields = {}
        for _ in range(count):
            key = string(True)
            fields[key] = value(integer("I"), key in ("general.architecture", "tokenizer.chat_template"))
            if stream.tell() > 64 * 1024 * 1024:
                raise ValueError("GGUF metadata exceeds 64 MiB")
        if not fields.get("general.architecture"):
            raise ValueError("GGUF architecture metadata is missing")
    parts = int(fields.get("split.count") or 1)
    if parts > 1:
        match = re.fullmatch(r"(.+)-00001-of-(\d{5})\.gguf", path.name)
        if not match or int(match[2]) != parts or parts > 99999:
            raise ValueError("select the first part of a complete split GGUF")
        for part in range(1, parts + 1):
            if not path.with_name(f"{match[1]}-{part:05d}-of-{parts:05d}.gguf").is_file():
                raise ValueError("a GGUF shard is missing")
    return fields


def strata_config(root, path):
    config = read_json(path)
    cwd = Path(config.get("cwd") or root)
    if not cwd.is_absolute():
        cwd = root / cwd
    cwd = cwd.absolute()
    executable = Path(config.get("exe") or "")
    if not executable.is_absolute():
        executable = cwd / executable
    file_path(executable)
    if not isinstance(config.get("args"), list) or not all(isinstance(x, str) for x in config["args"]):
        raise ValueError("Strata requires the installed deployment config's engine args")
    tokenizer = Path(config.get("tokenizer") or root / "pack/full/tokenizer")
    if not tokenizer.is_absolute():
        tokenizer = root / tokenizer
    for name in ("vocab.json", "merges.txt", "token_type.json"):
        file_path(tokenizer / name)
    if config.get("lazy_load") or config.get("api_key"):
        raise ValueError("Use a dedicated preloaded Strata config without a saved API key; AioLM supplies its own key")
    if config.get("mcp_servers") or config.get("before_load"):
        raise ValueError("Use a dedicated Strata config without independent MCP servers or before_load commands")
    return config, executable


def strata_engine_env(config):
    # Match the deployment server's library search path when inspecting the
    # native executable; probing must not depend on a globally installed SDK.
    env = dict(os.environ)
    for key, value in (config.get("env") or {}).items():
        env[str(key)] = str(value)
    directories = [path for path in config.get("lib_dirs") or [] if Path(path).is_dir()]
    if directories:
        variable = "PATH" if os.name == "nt" else "LD_LIBRARY_PATH"
        env[variable] = os.pathsep.join(directories + ([env[variable]] if env.get(variable) else []))
    return env


def probe(args):
    model = args.model or ""
    if args.kind == "llama.cpp":
        server = file_path(args.server)
        version = capture([str(server), "--version"]).strip()
        help_text = capture([str(server), "--help"])
        if not all(flag in help_text for flag in ("--model", "--host", "--port", "--alias", "--ctx-size", "LLAMA_API_KEY")):
            raise ValueError("selected build lacks required llama-server bindings")
        fields = gguf_metadata(file_path(model)) if model else {}
        chat = bool(fields.get("tokenizer.chat_template"))
        accelerator, served = "cpu", args.served_model or "unselected"
        tools, image = False, False
    else:
        root = Path(args.root).absolute()
        revision = capture(["git", "rev-parse", "HEAD"], root).strip()
        if revision != args.revision:
            raise ValueError("Strata source revision differs from the selected full revision")
        help_text = capture([sys.executable, "-m", "serve.server", "--help"], root)
        if not all(flag in help_text for flag in ("--engine", "--config", "--host", "--port")):
            raise ValueError("this Strata version lacks the adapter's server CLI contract")
        _, registered_executable = strata_config(root, file_path(args.config))
        config, executable = strata_config(root, file_path(model or args.config))
        if executable.resolve() != registered_executable.resolve():
            raise ValueError("selected deployment uses another Strata engine build; register it separately")
        engine_version = capture([str(executable), "--version"], config.get("cwd") or root,
                                 env=strata_engine_env(config)).strip()
        version = f"Strata {revision} / {engine_version}"
        # Deployment options and build metadata do not prove a live GPU device.
        accelerator = "unverified"
        served = config.get("model_name") or "qwen3.8-flash-next"
        chat, tools, image = True, True, bool(config.get("vision"))
    if not version:
        raise ValueError("runtime did not report a version")
    if len(version.encode()) > 256:
        # Preserve a reproducible identity without storing an unbounded log.
        version = "build-sha256:" + hashlib.sha256(version.encode()).hexdigest()
    result = {"schema_version":1, "engine_id":args.engine_id, "runtime_id":args.runtime_id,
              "version":version, "accelerator":accelerator, "model":model, "served_model":served,
              "model_supported":bool(model), "capabilities":{"tasks":["generate"],
              "modalities":{"text":True, "image":image, "audio":False, "video":False}, "chat":chat, "tools":tools}}
    print(json.dumps(result))


def create(args):
    if not re.fullmatch(r"custom\.[a-z0-9][a-z0-9._-]{0,56}", args.engine_id):
        raise ValueError("engine ID must use the custom.* namespace")
    helper, python = Path(__file__).absolute(), file_path(args.python or sys.executable)
    common = {"schema_version":1,"adapter_version":1,"engine_id":args.engine_id,"runtime_id":args.runtime_id,
              "display_name":args.name or args.engine_id,"protocol":"openai-v1","health_path":"/health",
              "health_authenticated":False,"options":[
                  {"key":"max_tokens","target":"request","group":"sampling","kind":{"type":"integer","min":1,"max":65536}},
                  {"key":"temperature","target":"request","group":"sampling","kind":{"type":"number","min":0,"max":2}}]}
    probe_args = [str(helper),"probe","--kind",args.kind,"--engine-id",args.engine_id,"--runtime-id",args.runtime_id,"--model","{model}","--served-model","{model_alias}"]
    if args.kind == "llama.cpp":
        server = file_path(args.server)
        host_os = {"Darwin":"macos", "Windows":"windows", "Linux":"linux"}.get(platform.system())
        host_arch = {"arm64":"aarch64", "aarch64":"aarch64", "AMD64":"x86_64", "x86_64":"x86_64"}.get(platform.machine())
        if not host_os or not host_arch:
            raise ValueError("unsupported host OS/architecture")
        # A dynamic build loads its shared libraries from the server's folder
        # (llama.dll/ggml*.dll on Windows); hash them so a replaced library is
        # refused like a changed executable.
        libraries = sorted(path for path in server.parent.iterdir() if path.is_file() and SHARED_LIBRARY.search(path.name))
        if len(libraries) + 1 > 64:
            raise ValueError("server folder has too many shared libraries; provide an audited custom manifest")
        common.update(platforms=[{"os":host_os,"arch":host_arch}], model_formats=["gguf"], artifacts=[str(helper), *map(str, libraries)])
        probe_args += ["--server",str(server)]
        common["launch"] = {"program":str(server),"env":{"LLAMA_API_KEY":"{api_key}"},"args":["--model","{model}","--alias","{model_alias}","--host","{host}","--port","{port}","--ctx-size","{ctx_size}","--parallel","{parallel}","--n-gpu-layers","0"]}
    else:
        if platform.system() not in ("Windows", "Linux") or platform.machine() not in ("AMD64", "x86_64"):
            raise ValueError("this Strata adapter requires an actual Windows/Linux x86-64 host")
        root, config = Path(args.root).absolute(), file_path(args.config)
        if not re.fullmatch(r"[0-9a-f]{40}",args.revision or ""):
            raise ValueError("pin a full Strata source revision before registration")
        installed, executable = strata_config(root, config)
        common["models"] = [{"path":str(config),"name":installed.get("model_name") or "qwen3.8-flash-next"}]
        modules = sorted(path for path in (root / "serve").glob("*.py") if not path.name.startswith("test_"))
        files = [helper, root / "serve/server.py", executable, *modules]
        tokenizer_module = root / "tools/strata_tokenizer.py"
        if tokenizer_module.is_file():
            files.append(tokenizer_module)
        # Hash the native libraries loaded beside the executable or from its
        # configured search directories, just as for a dynamic llama.cpp build.
        for directory in dict.fromkeys([str(executable.parent), *installed.get("lib_dirs", [])]):
            if Path(directory).is_dir():
                files.extend(sorted(path for path in Path(directory).iterdir()
                                    if path.is_file() and SHARED_LIBRARY.search(path.name)))
        artifacts = list(dict.fromkeys(str(file_path(path)) for path in files))
        if len(artifacts) > 64:
            raise ValueError("Strata adapter source exceeds the artifact count; provide an audited custom manifest")
        common.update(platforms=[{"os":"windows" if platform.system() == "Windows" else "linux", "arch":"x86_64"}], model_formats=["unknown"], artifacts=artifacts)
        probe_args += ["--root",str(root),"--config",str(config),"--revision",args.revision]
        common["launch"] = {"program":str(python),"working_directory":str(root),"env":{"STRATA_API_KEY":"{api_key}"},"args":["-m","serve.server","--engine","strata","--config","{model}","--host","{host}","--port","{port}"]}
    if args.kind == "llama.cpp" and args.model:
        selected = file_path(args.model)
        common["models"] = [{"path":str(selected),"name":selected.name}]
    common["probe"] = {"program":str(python),"args":probe_args, **({"working_directory":str(root)} if args.kind == "strata" else {})}
    output = Path(args.output).absolute()
    with output.open("x", encoding="utf-8") as stream:
        json.dump(common,stream,indent=2); stream.write("\n")
    print(str(output))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("create","probe"))
    parser.add_argument("--kind", required=True, choices=("llama.cpp","strata"))
    parser.add_argument("--engine-id", required=True)
    parser.add_argument("--runtime-id", required=True)
    for name in ("server","python","root","config","revision","name","output","model","served-model"):
        parser.add_argument("--" + name)
    args = parser.parse_args()
    needed = ("server",) if args.kind == "llama.cpp" else ("root", "config", "revision")
    if any(not getattr(args,key) for key in needed):
        parser.error("missing runtime binding: " + ", ".join("--" + key for key in needed))
    if args.action == "create" and not args.output:
        parser.error("create requires a new --output path")
    try:
        create(args) if args.action == "create" else probe(args)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(str(error),file=sys.stderr); return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
