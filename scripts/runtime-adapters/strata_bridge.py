#!/usr/bin/env python3
"""Explicit Strata native-option bridge for AioLM's common entry point.

The HTTP layer stays Strata's installed server. Native options go only into
an owned copy of its deployment config, never into the server's argparse.
Help is syntax evidence; create_adapter.py remains the independent probe.
"""
import argparse
import copy
import importlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import threading

import create_adapter as adapter


# This adapter's config/command semantics were checked at this source commit.
# Other revisions need a reviewed adapter recipe, not a common-app engine case.
REVISION = "296b59d2f73c8f04a805df29c2fa97655adace78"
ENGINE_ENV = "STRATA_ADAPTER_ENGINE_ARGV"
DIRECTORY_ENV = "STRATA_ADAPTER_LAUNCH_DIRECTORY"
WEBVIEW_ORIGIN = "tauri://localhost"
RESERVED = {
    "--pack": "The selected deployment owns its pack and tokenizer",
    "--native": "The selected deployment owns its model weights",
    "--ple-gguf": "The selected deployment owns its model shards",
    "--native-head-gguf": "The selected deployment owns its model weights",
    "--native-dense-gguf": "The selected deployment owns its model weights",
    "--embd-gguf": "The selected deployment owns its model weights",
    "--tokens": "AioLM sends input through the serving protocol",
    "--tokens-file": "AioLM sends input through the serving protocol",
    "--serve": "The bridge owns the resident native serving protocol",
    "--help": "AioLM runs help separately from inference",
    "--version": "AioLM probes the selected build separately",
    "--vision": "Image support requires a separately verified deployment adapter",
    # serve/server.py child_env sets HIP/CUDA_VISIBLE_DEVICES from the
    # deployment's "gpu"/"backend"; native --gpu (generate.cpp) overrides it.
    "--gpu": "The selected deployment's gpu and backend own the visible devices",
}


def effective_config(config, options, directory):
    result = copy.deepcopy(config)
    # The pinned native parser walks argv in order and assigns scalar values
    # (--kv, --spec, --max-context). Preserve the base then append exact GUI
    # occurrences; repeatable/native validation remains the engine's job.
    # The common schema validates option occurrences against RESERVED.
    # Never reinterpret a flag-looking *value* as a second occurrence here.
    result["args"] = list(config["args"]) + list(options)
    result["open_browser"] = False
    result["log"] = str(directory / "engine.log")
    return result


def selected_engine(root, config_path, revision):
    if revision != REVISION:
        raise ValueError("this bridge requires its reviewed full Strata source revision")
    actual = adapter.capture(["git", "rev-parse", "HEAD"], root).strip()
    if actual != revision:
        raise ValueError("Strata source revision changed; review and register the adapter again")
    config, executable = adapter.strata_config(root, config_path)
    command = json.loads(os.environ.get(ENGINE_ENV, "null"))
    if not isinstance(command, list) or len(command) != 1 or not isinstance(command[0], str):
        raise ValueError("the bridge requires the explicit native engine JSON argv contract")
    if Path(command[0]).resolve() != executable.resolve():
        raise ValueError("selected deployment and bridge native executable differ")
    return config, executable


def parser():
    result = argparse.ArgumentParser(description=__doc__, add_help=False, allow_abbrev=False)
    result.add_argument("--root", required=True)
    result.add_argument("--base-config", required=True)
    result.add_argument("--revision", required=True)
    result.add_argument("--aiolm-model")
    result.add_argument("--aiolm-host", default="127.0.0.1")
    result.add_argument("--aiolm-port", type=int)
    return result


def forward_help(executable, root, config):
    # Windows GUI parents do not have a console. Give the native child real
    # pipe handles explicitly: inherited defaults with CREATE_NO_WINDOW can
    # yield exit 0 but lose both streams. Pump without an unbounded buffer.
    # The pinned native build prints --help on stderr only, while AioLM
    # parses a non-empty stdout alone; one pipe for both native streams keeps
    # the binding rows and the native rows in that single document.
    with subprocess.Popen([str(executable), "--help"], cwd=root / (config.get("cwd") or root),
                          env=adapter.strata_engine_env(config, root), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0) as process:
        errors = []
        def pump(source, destination):
            try:
                while chunk := source.read(8192):
                    destination.buffer.write(chunk)
                    destination.buffer.flush()
            except (OSError, ValueError) as error:
                errors.append(error)
        reader = threading.Thread(target=pump, args=(process.stdout, sys.stdout), daemon=True)
        reader.start()
        try:
            code = process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise
        finally:
            reader.join()
        if errors:
            raise ValueError("native help output could not be forwarded") from errors[0]
        return code


def run_server(config):
    origins = config.get("cors_origins")
    items = origins if isinstance(origins, list) else [origins]
    if not any(isinstance(value, str) and value.strip().rstrip("/") == WEBVIEW_ORIGIN for value in items):
        runpy.run_module("serve.server", run_name="__main__", alter_sys=True)
        return 0
    # The reviewed server only accepts http(s) in its explicit CORS list.
    # Linux WebKit uses this app origin. Admit it only when the deployment
    # names it; keep upstream validation and policy for every other origin.
    server = importlib.import_module("serve.server")
    original = server.origins_of

    def origins_of(value, key, wildcard):
        values = value if isinstance(value, list) else [value]
        native = [item for item in values
                  if isinstance(item, str) and item.strip().rstrip("/") == WEBVIEW_ORIGIN]
        if key != "cors_origins" or not native:
            return original(value, key, wildcard)
        remaining = [item for item in values if item not in native]
        return original(remaining, key, wildcard) + [WEBVIEW_ORIGIN]

    server.origins_of = origins_of
    try:
        return server.main()
    finally:
        server.origins_of = original


def main(argv=None):
    raw = list(sys.argv[1:] if argv is None else argv)
    separated = "--" in raw
    if separated:
        boundary = raw.index("--")
        args = parser().parse_args(raw[:boundary])
        native = raw[boundary + 1:]
    else:
        args, native = parser().parse_known_args(raw)
    root = Path(args.root).absolute()
    base = adapter.file_path(args.base_config)
    config_path = adapter.file_path(args.aiolm_model) if args.aiolm_model else base
    config, executable = selected_engine(root, config_path, args.revision)
    _, registered_executable = adapter.strata_config(root, base)
    if executable.resolve() != registered_executable.resolve():
        raise ValueError("selected model requires another native build; register it explicitly")
    if native == ["--help"]:
        print("AioLM explicit bridge bindings:\n\noptions:\n"
              "  --aiolm-model PATH   selected deployment JSON\n"
              "  --aiolm-host HOST    owned HTTP bind address\n"
              "  --aiolm-port PORT    owned HTTP bind port\n\n"
              "Native engine options (forwarded to deployment args):", flush=True)
        # Stream the native output after these rows; the outer owned help
        # service bounds it and records failure/cancellation.
        return forward_help(executable, root, config)
    if not args.aiolm_model or not args.aiolm_port or not 1 <= args.aiolm_port <= 65535:
        raise ValueError("launch needs the app-owned model and port bindings")
    if not separated:
        raise ValueError("native launch options require the explicit -- command boundary")
    directory = Path(os.environ.get(DIRECTORY_ENV, ""))
    if not directory.is_absolute() or not directory.is_dir() or directory.is_symlink():
        raise ValueError("launch needs the app-owned resource directory")
    effective = effective_config(config, native, directory)
    # The config's cwd is relative to the installed SDK, not the staging copy.
    cwd = Path(config.get("cwd") or root)
    effective["cwd"] = str(cwd if cwd.is_absolute() else root / cwd)
    effective["exe"] = str(executable)
    destination = directory / "deployment.json"
    with destination.open("x", encoding="utf-8") as stream:
        json.dump(effective, stream, ensure_ascii=False)
    # Explicit headless CLI mode supplies an empty key to mean disabled. The
    # upstream server rejects an empty *present* variable, so omit it there.
    if os.environ.get("STRATA_API_KEY") == "":
        del os.environ["STRATA_API_KEY"]
    os.chdir(root)
    sys.path.insert(0, str(root))
    sys.argv = ["serve.server", "--engine", "strata", "--config", str(destination),
                "--host", args.aiolm_host, "--port", str(args.aiolm_port)]
    return run_server(effective)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
