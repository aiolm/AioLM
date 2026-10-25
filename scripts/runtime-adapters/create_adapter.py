#!/usr/bin/env python3
"""Create an external runtime manifest, or perform its model-specific probe.

No downloads, installs, inference or changes to engine/model files occur here.
The launch remains a direct owned child; this helper only inspects the selected
build and loader inputs. Strata's installed deployment JSON is its model binding.
"""
import argparse
import codecs
import hashlib
import io
import json
import os
import platform
from pathlib import Path
import re
import selectors
import struct
import subprocess
import sys
import time


LIMIT = 262144
# The registry's bound on declared artifacts (providers/registry.rs MAX_ARTIFACTS).
ARTIFACT_LIMIT = 256
_CAPTURE_LIMIT = 65536
_CAPTURE_TIMEOUT = 15
_CAPTURE_CHUNK = 65536
SHARED_LIBRARY = re.compile(r"\.(dll|dylib|so)(\.\d+)*$", re.IGNORECASE)


class _CapturedStream:
    def __init__(self, stream, encoding, errors):
        decoder = codecs.getincrementaldecoder(encoding)(
            errors=errors if errors is not None else "strict"
        )
        self.stream = stream
        self.decoder = io.IncrementalNewlineDecoder(decoder, translate=True)
        self.retained_chars = 0
        self.prefix = []
        self.error = None
        self.closed = False

    def _retain(self, chunk):
        if self.retained_chars < _CAPTURE_LIMIT:
            keep = chunk[:_CAPTURE_LIMIT - self.retained_chars]
            self.prefix.append(keep)
            self.retained_chars += len(keep)

    def read(self, available=None):
        try:
            size = _CAPTURE_CHUNK if available is None else min(available, _CAPTURE_CHUNK)
            data = os.read(self.stream.fileno(), size)
        except OSError as error:
            if os.name == "nt" and getattr(error, "winerror", None) == 109:
                self.finish()
                self.closed = True
                return
            self.error = error
            self.closed = True
            return
        if not data:
            self.finish()
            self.closed = True
            return
        if self.error is None:
            try:
                self._retain(self.decoder.decode(data, final=False))
            except UnicodeError as error:
                # Keep draining raw bytes so the real exit status remains
                # observable and a malformed tail cannot block the child.
                self.error = error

    def finish(self):
        if self.error is None:
            try:
                self._retain(self.decoder.decode(b"", final=True))
            except UnicodeError as error:
                self.error = error

    def text(self):
        return "".join(self.prefix)


if os.name == "nt":
    import ctypes
    import msvcrt

    _PEEK_NAMED_PIPE = ctypes.WinDLL("kernel32", use_last_error=True).PeekNamedPipe
    _PEEK_NAMED_PIPE.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.POINTER(ctypes.c_uint32),
    ]
    _PEEK_NAMED_PIPE.restype = ctypes.c_int


def _windows_pipe_available(stream):
    # Peek first because synchronous anonymous-pipe reads block on Windows.
    available = ctypes.c_uint32()
    handle = ctypes.c_void_p(msvcrt.get_osfhandle(stream.fileno()))
    if _PEEK_NAMED_PIPE(handle, None, 0, None, ctypes.byref(available), None):
        return available.value
    error = ctypes.get_last_error()
    if error == 109:  # broken pipe
        return None
    if error == 232:  # no data while the writer remains connected
        return 0
    raise ctypes.WinError(error)


def _terminate_capture_process(process):
    try:
        process.kill()
    except OSError:
        pass
    try:
        process.wait()
    except OSError:
        pass


def _close_capture_pipes(streams):
    for captured in streams:
        if captured.stream is not None:
            try:
                captured.stream.close()
            except (OSError, ValueError):
                pass


def _capture_prefix(streams):
    stdout = streams[0].text()
    if len(stdout) >= _CAPTURE_LIMIT:
        return stdout[:_CAPTURE_LIMIT]
    stderr = streams[1].text()
    return stdout + stderr[:_CAPTURE_LIMIT - len(stdout)]


def _capture_run(args, cwd=None, env=None):
    """Bounded run of `args` (no shell): (exit status, stream error or None, retained output)."""
    process = None
    streams = []
    selector = None
    deadline = None
    timed_out = False
    returncode = None
    try:
        process = subprocess.Popen(
            args,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for pipe in (process.stdout, process.stderr):
            encoding, errors = pipe.encoding, pipe.errors
            buffered = pipe.detach()
            streams.append(_CapturedStream(buffered.detach(), encoding, errors))
        if os.name != "nt":
            selector = selectors.DefaultSelector()
            for captured in streams:
                selector.register(captured.stream.fileno(), selectors.EVENT_READ, captured)
        deadline = time.monotonic() + _CAPTURE_TIMEOUT
        while True:
            if all(stream.closed for stream in streams) and process.poll() is not None:
                returncode = process.wait()
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                _terminate_capture_process(process)
                break
            if selector is not None:
                for event, _ in selector.select(min(0.01, remaining)):
                    captured = event.data
                    captured.read()
                    if captured.closed:
                        selector.unregister(event.fileobj)
            else:
                progress = False
                for captured in streams:
                    if captured.closed:
                        continue
                    available = _windows_pipe_available(captured.stream)
                    if available is None:
                        captured.finish()
                        captured.closed = True
                        progress = True
                    elif available:
                        captured.read(available)
                        progress = True
                if not progress:
                    time.sleep(min(0.01, remaining))
    except BaseException:
        if process is not None:
            _terminate_capture_process(process)
        raise
    finally:
        if selector is not None:
            selector.close()
        if process is not None:
            if process.poll() is None:
                _terminate_capture_process(process)
        _close_capture_pipes(streams)

    if timed_out:
        raise subprocess.TimeoutExpired(
            args,
            _CAPTURE_TIMEOUT,
            output=_capture_prefix(streams),
            stderr=streams[1].text(),
        )
    failure = next((stream.error for stream in streams if stream.error is not None), None)
    return returncode, failure, _capture_prefix(streams)


def capture(args, cwd=None, env=None):
    returncode, failure, text = _capture_run(args, cwd, env)
    if returncode != 0:
        raise ValueError("runtime version/help probe failed; inspect the selected installation")
    if failure is not None:
        raise failure
    return text


def file_path(value):
    path = Path(value).absolute()
    if not path.is_file():
        raise ValueError("selected executable/config/adapter file is missing")
    return path


def _read_json_bytes(path):
    with path.open("rb") as stream:
        raw = stream.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError("deployment config exceeds 256 KiB")
    return raw


def _parse_json(raw):
    value = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("deployment config must be an object")
    return value


class _StrataConfigSnapshot:
    __slots__ = ("path", "raw", "config", "executable", "tokenizer_files")

    def __init__(self, path, raw, config, executable, tokenizer_files):
        self.path = path
        self.raw = raw
        self.config = config
        self.executable = executable
        self.tokenizer_files = tokenizer_files


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


def _strata_config_snapshot(root, path):
    raw = _read_json_bytes(path)
    config = _parse_json(raw)
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
    tokenizer_files = tuple(tokenizer / name for name in ("vocab.json", "merges.txt", "token_type.json"))
    for candidate in tokenizer_files:
        file_path(candidate)
    if config.get("lazy_load") or config.get("api_key"):
        raise ValueError("Use a dedicated preloaded Strata config without a saved API key; AioLM supplies its own key")
    if config.get("mcp_servers") or config.get("before_load"):
        raise ValueError("Use a dedicated Strata config without independent MCP servers or before_load commands")
    return _StrataConfigSnapshot(path, raw, config, executable, tokenizer_files)


def strata_config(root, path):
    snapshot = _strata_config_snapshot(root, path)
    return snapshot.config, snapshot.executable


def _verify_strata_config(snapshot):
    file_path(snapshot.path)
    if _read_json_bytes(snapshot.path) != snapshot.raw:
        raise ValueError("deployment config changed during validation")
    file_path(snapshot.executable)
    for candidate in snapshot.tokenizer_files:
        file_path(candidate)


def strata_engine_env(config, root=None):
    # Match the deployment server's library search path when inspecting the
    # native executable; probing must not depend on a globally installed SDK.
    env = dict(os.environ)
    for key, value in (config.get("env") or {}).items():
        env[str(key)] = str(value)
    root = Path(root or Path.cwd())
    directories = [path for path in config.get("lib_dirs") or [] if (root / path).is_dir()]
    if directories:
        variable = "PATH" if os.name == "nt" else "LD_LIBRARY_PATH"
        env[variable] = os.pathsep.join(directories + ([env[variable]] if env.get(variable) else []))
    return env


_LOADER_RESOLVED = re.compile(r"^\s*(\S+) => (.+) \(0x[0-9a-fA-F]+\)$")
_LOADER_DIRECT = re.compile(r"^\s*(/.*) \(0x[0-9a-fA-F]+\)$")
_LOADER_NOT_FOUND = re.compile(r"^\s*(\S+) => not found$")
_LOADER_ERROR = re.compile(r"error while loading shared libraries: ([^:]+):")


def elf_interpreter(path):
    """The program interpreter (PT_INTERP) of a dynamically linked 64-bit ELF, or None for any other file
    (a script, a synthetic fixture, a Windows PE) and for a static executable."""
    with path.open("rb") as stream:
        header = stream.read(64)
        if header[:4] != b"\x7fELF":
            return None
        if len(header) != 64:
            raise ValueError("the native engine's ELF header is truncated")
        if header[4] != 2 or header[5] != 1:
            raise ValueError("the native engine is not a 64-bit little-endian ELF executable")
        offset, = struct.unpack_from("<Q", header, 0x20)
        size, count = struct.unpack_from("<HH", header, 0x36)
        file_size = os.fstat(stream.fileno()).st_size
        if size < 56 or count > 4096 or offset + count * size > file_size:
            raise ValueError("the native engine has invalid ELF program headers")
        for index in range(count):
            stream.seek(offset + index * size)
            row = stream.read(56)
            if len(row) != 56:
                raise ValueError("the native engine's ELF program headers are truncated")
            if struct.unpack_from("<I", row)[0] != 3:   # PT_INTERP
                continue
            start, length = struct.unpack_from("<Q", row, 8)[0], struct.unpack_from("<Q", row, 32)[0]
            if not 1 < length <= 4096 or start + length > file_size:
                raise ValueError("the native engine names an invalid ELF interpreter")
            stream.seek(start)
            raw_name = stream.read(length)
            if not raw_name.endswith(b"\0"):
                raise ValueError("the native engine's ELF interpreter is not terminated")
            name = os.fsdecode(raw_name.split(b"\0", 1)[0])
            if not os.path.isabs(name) or not Path(name).is_file():
                raise ValueError("the native engine's ELF interpreter is missing")
            return Path(name)
    return None


def loader_resolved_libraries(executable, roots, env, cwd=None):
    """Shared libraries the selected engine's own loader resolves (transitively) inside the deployment's library
    roots, e.g. a system ROCm's lib/rocm_sysdeps/lib and lib/llvm/lib, which a listing of the roots' top level
    misses. Linux ELF only: the loader's `--list` mode maps the libraries without running the engine, with the
    engine's own environment and no shell. An unresolved library fails here, not at the first start."""
    if os.name == "nt" or platform.system() != "Linux":
        return []
    interpreter = elf_interpreter(executable)
    if interpreter is None:
        return []
    returncode, failure, text = _capture_run([str(interpreter), "--list", str(executable)], cwd=cwd, env=env)
    lines = text.splitlines()
    missing = [match[1] for match in map(_LOADER_NOT_FOUND.match, lines) if match]
    missing += [match[1] for match in map(_LOADER_ERROR.search, lines) if match]
    if failure is not None and not missing:
        if isinstance(failure, UnicodeError):
            raise ValueError("the native engine's library listing could not be decoded; check the output "
                             "encoding and library path encoding") from failure
        raise ValueError("the native engine's library listing could not be read; retry the inspection") from failure
    if missing or returncode != 0:
        detail = f" ({', '.join(dict.fromkeys(missing))})" if missing else ""
        raise ValueError(f"the native engine's shared libraries do not resolve{detail}; add the folder that holds "
                         "them to the deployment's \"lib_dirs\"")
    if len(text) >= _CAPTURE_LIMIT:
        raise ValueError("the native engine's library listing exceeds the inspection bound; provide an audited "
                         "custom manifest")
    bases = [Path(root).resolve() for root in roots]
    bases += [Path(root).absolute() for root in roots if ".." not in Path(root).parts]
    found = []
    for line in lines:
        match = _LOADER_RESOLVED.match(line)
        direct = _LOADER_DIRECT.match(line) if match is None else None
        if match is None and direct is None:
            continue
        library = Path(cwd or Path.cwd()) / Path(match[2] if match else direct[1])
        # Keep the loader's path for hashing: a symlink followed by '..' can
        # name a different file from its lexically normalized spelling.
        resolved = library.resolve()
        lexical = Path(os.path.abspath(library))
        if library.is_file() and any(resolved.is_relative_to(base)
                                     or ".." not in library.parts and lexical.is_relative_to(base)
                                     for base in bases):
            found.append(str(library))
    return found


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
        registered = _strata_config_snapshot(root, file_path(args.config))
        if model:
            selected = _strata_config_snapshot(root, file_path(model))
            config, executable = selected.config, selected.executable
        else:
            _verify_strata_config(registered)
            config, executable = registered.config, registered.executable
        registered_executable = registered.executable
        if executable.resolve() != registered_executable.resolve():
            raise ValueError("selected deployment uses another Strata engine build; register it separately")
        engine_version = capture([str(executable), "--version"], root / (config.get("cwd") or root),
                                 env=strata_engine_env(config, root)).strip()
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


def _build_manifest_with_snapshot(args):
    if not re.fullmatch(r"custom\.[a-z0-9][a-z0-9._-]{0,56}", args.engine_id):
        raise ValueError("engine ID must use the custom.* namespace")
    helper, python = Path(__file__).absolute(), file_path(args.python or sys.executable)
    strata_snapshot = None
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
        strata_snapshot = _strata_config_snapshot(root, config)
        installed, executable = strata_snapshot.config, strata_snapshot.executable
        # The serving layer documents these switches, but AioLM owns their
        # lifecycle and tool behavior. State this as adapter data; generic
        # help discovery must not infer reservations from option names.
        common["option_metadata"] = {
            "version": 1, "engine_id": args.engine_id,
            "adapter": {"id": "strata.openai", "revision": args.revision},
            "options": [
                {"flag": "--lazy", "reserved": "AioLM loads the model before reporting Ready"},
                {"flag": "--idle-unload", "reserved": "AioLM owns model unloading"},
                {"flag": "--before-load", "reserved": "AioLM owns commands run around model loading"},
                {"flag": "--mcp-config", "reserved": "AioLM owns MCP discovery and tool approval"},
                # main() uses --tokenizer when the deployment has no
                # "tokenizer"; strata_config validated the deployment's one.
                {"flag": "--tokenizer", "reserved": "The selected deployment owns its validated tokenizer"},
            ],
        }
        common["models"] = [{"path":str(config),"name":installed.get("model_name") or "qwen3.8-flash-next"}]
        modules = sorted(path for path in (root / "serve").glob("*.py") if not path.name.startswith("test_"))
        files = [helper, root / "serve/server.py", executable, *modules]
        tokenizer_module = root / "tools/strata_tokenizer.py"
        if tokenizer_module.is_file():
            files.append(tokenizer_module)
        # Hash the native libraries loaded beside the executable or from its
        # configured search directories, just as for a dynamic llama.cpp build.
        directories = [root / directory for directory in installed.get("lib_dirs", [])]
        for directory in dict.fromkeys([executable.parent, *directories]):
            if Path(directory).is_dir():
                files.extend(sorted(path for path in Path(directory).iterdir()
                                    if path.is_file() and SHARED_LIBRARY.search(path.name)))
        # Every alias above stays declared. The libraries the loader resolves
        # through them can sit in nested folders of the same roots, which the
        # top-level listing does not reach; declare those too.
        native_cwd = root / (installed.get("cwd") or root)
        roots = [native_cwd / directory for directory in installed.get("lib_dirs", [])
                 if (root / directory).is_dir()]
        files.extend(loader_resolved_libraries(executable, roots, strata_engine_env(installed, root), cwd=native_cwd))
        artifacts = list(dict.fromkeys(str(file_path(path)) for path in files))
        if len(artifacts) > ARTIFACT_LIMIT:
            raise ValueError(f"Strata adapter source exceeds the artifact count ({len(artifacts)} files, at most "
                             f"{ARTIFACT_LIMIT}); provide an audited custom manifest")
        common.update(platforms=[{"os":"windows" if platform.system() == "Windows" else "linux", "arch":"x86_64"}], model_formats=["unknown"], artifacts=artifacts)
        probe_args += ["--root",str(root),"--config",str(config),"--revision",args.revision]
        common["launch"] = {"program":str(python),"working_directory":str(root),"env":{"STRATA_API_KEY":"{api_key}"},"args":["-m","serve.server","--engine","strata","--config","{model}","--host","{host}","--port","{port}"]}
    if args.kind == "llama.cpp" and args.model:
        selected = file_path(args.model)
        common["models"] = [{"path":str(selected),"name":selected.name}]
    common["probe"] = {"program":str(python),"args":probe_args, **({"working_directory":str(root)} if args.kind == "strata" else {})}
    if args.kind == "strata" and len(json.dumps(common).encode()) > LIMIT:
        raise ValueError("Strata adapter manifest exceeds the 256 KiB registration budget; provide an audited custom "
                         "manifest")
    return common, strata_snapshot


def build_manifest(args):
    return _build_manifest_with_snapshot(args)[0]


def create(args):
    common = build_manifest(args)
    encoded = json.dumps(common, indent=2) + "\n"
    if args.kind == "strata" and len(encoded.encode()) > LIMIT:
        raise ValueError("Strata adapter manifest exceeds the 256 KiB registration budget; provide an audited custom manifest")
    output = Path(args.output).absolute()
    with output.open("x", encoding="utf-8") as stream:
        stream.write(encoded)
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
