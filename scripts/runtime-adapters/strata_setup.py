#!/usr/bin/env python3
"""Produce common entry-point data from explicitly selected Strata inputs."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

import create_adapter as adapter
import strata_bridge as bridge


def prepare(args):
    if args.revision != bridge.REVISION:
        raise ValueError("select the full Strata revision reviewed by this adapter recipe")
    args.kind = "strata"
    args.server = args.model = args.served_model = None
    common = adapter.build_manifest(args)
    root = Path(args.root).absolute()
    config_path = adapter.file_path(args.config)
    config, executable = adapter.strata_config(root, config_path)
    python = common["probe"]["program"]
    script = Path(__file__).with_name("strata_bridge.py").absolute()
    metadata = common["option_metadata"]
    # The HTTP server's private options aren't native options. This bridge
    # exposes native help and only these namespaced HTTP bindings.
    metadata["adapter"]["id"] = "strata.native-openai-bridge"
    metadata["options"] = [{"flag": flag, "reserved": reason} for flag, reason in bridge.RESERVED.items()]
    # Units as the pinned generate.cpp uses them: --spec proposes tokens,
    # --max-context is checked against prompt token counts, and
    # --kv-resident is resident KV cells of each QSA layer (layer.cpp).
    for flag, unit in (("--spec", "tokens"), ("--max-context", "tokens"), ("--kv-resident", "cells per QSA layer")):
        metadata["options"].append({"flag": flag, "kind": "integer", "arity": {"min": 1, "max": 1},
                                    "unit": unit, "restart_required": True})
    artifacts = list(dict.fromkeys(common["artifacts"] + [str(script), str(config_path)]))
    return {
        "engine_id": args.engine_id, "runtime_id": args.runtime_id,
        "display_name": args.name or "Strata", "program": str(executable), "prefix": [],
        "working_directory": str(root), "environment": {}, "artifacts": artifacts,
        "protocol": {"kind": "bridge", "program": python,
                     "prefix": [str(script), "--root", str(root), "--base-config", str(config_path),
                                "--revision", args.revision], "engine_argv_env": bridge.ENGINE_ENV},
        "model": {"kind": "flag", "flag": "--aiolm-model"},
        "port": {"kind": "flag", "flag": "--aiolm-port"},
        "host": {"kind": "flag", "flag": "--aiolm-host"}, "served_model": None,
        "auth": {"kind": "env", "name": "STRATA_API_KEY"}, "probe": common["probe"],
        "health_path": "/health", "health_authenticated": False,
        "model_formats": ["unknown"], "models": common["models"],
        "option_metadata": metadata,
        "launch_resources": {"version": 1, "directory_env": bridge.DIRECTORY_ENV},
        "options_separator": "--",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    for name in ("python", "root", "config", "revision", "engine-id", "runtime-id", "name"):
        parser.add_argument("--" + name, required=name != "name")
    args = parser.parse_args()
    try:
        # ASCII JSON is portable across the selected interpreter's console
        # encoding; paths decode back to their original Unicode strings.
        print(json.dumps(prepare(args)))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
