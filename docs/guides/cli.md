# CLI

> **Language:** [English](cli.md) | [한국어](cli.ko.md) | [日本語](cli.ja.md) | [中文](cli.zh.md)

Installers ship `aiolm-cli` next to the desktop app; on Windows, find `aiolm-cli.exe` beside `aiolm.exe` in the app's install directory. A [source build](install.md#build-from-source) also leaves it at `.codex-target/release/aiolm-cli.exe` (`aiolm-cli` on Linux/macOS). On macOS it is `/Applications/AioLM.app/Contents/MacOS/aiolm-cli` (or under `~/Applications`). Output is JSON, the server is loopback-only, and credentials are not persisted.

```powershell
./aiolm-cli.exe --help
./aiolm-cli.exe config get
./aiolm-cli.exe config set <field> <value>  # typed, non-secret only
./aiolm-cli.exe models list
./aiolm-cli.exe models delete <path>
./aiolm-cli.exe runtime list  # `runtimes` is also accepted
./aiolm-cli.exe runtime discover [folder]
./aiolm-cli.exe runtime connect <candidate-id> <model-id> [folder] [--command <word>]...
./aiolm-cli.exe runtime device
./aiolm-cli.exe runtime probe <backend> <build>
./aiolm-cli.exe runtime select <backend> <build>
./aiolm-cli.exe server start   # loopback, no API-key auth in headless mode
./aiolm-cli.exe server status
./aiolm-cli.exe server logs [lines]
./aiolm-cli.exe server stop
./aiolm-cli.exe server unload  # alias for stop
./aiolm-cli.exe server restart
./aiolm-cli.exe doctor
```

## First start

Install or import a runtime in the desktop app, then choose its backend/build from `runtime list` and configure a model. `runtime select` saves both identifiers atomically; an invalid selection leaves the settings unchanged. Starting a server requires the selected managed runtime. On Linux/macOS use `./aiolm-cli` without `.exe`.

```powershell
./aiolm-cli.exe runtime list
./aiolm-cli.exe runtime select cpu <installed-build>
./aiolm-cli.exe config set models_dir "C:\Models"
./aiolm-cli.exe config set active_model "C:\Models\model.gguf"
./aiolm-cli.exe server start
```

- `config set` rejects credential-like and unknown fields.
- Each `config set` validates the resulting configuration before saving it. When both batch sizes are explicit, `ubatch_size` must not exceed `batch_size`; lower `ubatch_size` first when reducing both.
- `config get` redacts credential-like values; `server_args`, `chat_options`, and `lora_adapters` require JSON values when set.
- `models delete` accepts inactive `.gguf`/`.mmproj` files and app-owned snapshot directories inside `models_dir`. It preserves files outside the snapshot manifest and refuses active model/companion bindings.
- `runtime device` detects local GPUs and recommended backends; `runtime probe` runs the llama-server version/help/device preflight and reports whether the optional llama-bench helper works; a missing or failing llama-bench does not fail the preflight.
- `server start` uses the configured model, binds to `127.0.0.1`, and intentionally disables API-key auth. Use it only on a trusted machine and do not expose or forward the port.
- Headless stdout is JSON. `server logs` reads only the newest 1 MiB before selecting the requested lines. The log file compacts to that tail when it exceeds 2 MiB, avoiding a rewrite on every append.

See [SECURITY.md](../SECURITY.md) for auth and process boundaries.

## External engine connections

`runtime discover [folder]` finds current-user local model APIs and, when a folder is supplied, entry points in that installation folder without executing candidates. Its JSON report includes `candidates` (with each candidate's `id`, `display_name`, `source`, `entrypoint_kind`, `endpoints`, and `state`), `warnings`, and `truncated`.

`runtime connect <candidate-id> <model-id> [folder] [--command <word>]...` rediscovers the candidate, inspects it, verifies the selected model's chat and streaming responses, and saves its registration. Use the candidate ID from discovery and supply the same folder if one was used. For a folder installation, the model ID is a local model path from the configured model catalog; for a running API, use its served model ID. Connecting may run the program or send requests to the local server, so choose installations you trust. Stop the headless server before connecting.

Repeat `--command` once per word to select a documented serving command, for example `--command serve --command llm`. If several serving commands are found, the error lists the choices; repeat the connection with one of them. Registration does not change the selected runtime or model.

For advanced manual registration, `runtime register-manifest <manifest.json>` probes and registers a versioned external process adapter; the engine files stay external. Stop the headless server before registering. Select the returned engine/runtime IDs explicitly, and use `runtime probe` to check the exact active model:

```text
aiolm-cli runtime register-manifest <manifest.json>
aiolm-cli runtime select <custom.engine> <runtime-id>
aiolm-cli runtime probe <custom.engine> <runtime-id>
```

See [external engine connections](../reference/automatic-engine-connections.md) for verification details and the [manifest format](../reference/automatic-engine-connections.md#advanced-manual-registration).

## Python engine runtimes

`config set provider_options '<json>'` replaces the complete engine option map. Read it with `config get`, keep the other engine entries, then submit an object such as `{"vllm":{"max_model_len":8192},"mlx-vlm":{"temperature":0.7}}` as one shell argument. Invalid or unknown options leave the saved configuration unchanged; `{}` clears the map. Model-specific and installed-runtime checks run before launch.

The selected runtime's entry, including `llama.cpp` once a build is selected and a registered `custom.*` engine, is checked against the same option schema as the settings window: catalog or manifest options, options from that runtime's reviewed help, value counts and repetition you confirmed for that help, and the saved `@option_order` record that keeps command-line order and a separate alias per occurrence. A record from a newer app or one that disagrees with the saved values is refused.

vLLM runs on Linux or Apple Silicon macOS 15+ via vllm-metal; mlx-vlm runs on Apple Silicon macOS. On a supported Mac, `runtime install vllm` uses matched vLLM/vllm-metal 0.30.0 wheels and native arm64 Python 3.12. `runtime list` includes native and registered Python installations. Install a pinned engine or register an existing interpreter, then select the returned runtime ID before choosing a complete local model snapshot. External environment removal preserves the interpreter and packages; Ctrl-C cancels a managed installation and removes its unfinished environment.

Standard managed vLLM (non-Metal) and mlx-vlm package installs use binary wheels only, including dependencies; they do not fall back to source builds. A missing compatible wheel stops installation with a safety explanation. You can instead prepare an external environment and register its interpreter. The Mac vLLM installation uses the separate matched-wheel Metal plan described above.

```text
aiolm-cli runtime install <vllm|mlx-vlm> [python-executable]
aiolm-cli runtime register <vllm|mlx-vlm> <python-executable>
aiolm-cli runtime select <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime probe <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime remove <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime export <vllm|mlx-vlm> <runtime-id> <new-bundle.zip>
aiolm-cli runtime import <bundle.zip>
```

See [Inference runtimes](../reference/inference-runtimes.md) for engine-specific artifacts, options and profiles.

Export downloads exact wheels for the installed engine dependency closure and preserves platform, ABI and hashes. Import installs those wheels offline into a new environment and probes it; a compatible base Python interpreter must already be installed. Models are managed separately. Stop the headless server before export/import; Ctrl-C cleans up unfinished operations. Export preserves existing destination files.
