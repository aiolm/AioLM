# CLI

> **Language:** [English](cli.md) | [한국어](cli.ko.md) | [日本語](cli.ja.md) | [中文](cli.zh.md)

During development, `aiolm-cli.exe` is built at `.codex-target/release/aiolm-cli.exe`. Packaged builds ship it as an auxiliary binary next to `aiolm.exe`; locate the installed copy in the app's install directory. On macOS it is `/Applications/AioLM.app/Contents/MacOS/aiolm-cli` (or under `~/Applications`). Output is JSON, the server is loopback-only, and credentials are not persisted.

```powershell
./aiolm-cli.exe --help
./aiolm-cli.exe config get
./aiolm-cli.exe config set <field> <value>  # typed, non-secret only
./aiolm-cli.exe models list
./aiolm-cli.exe models delete <path>
./aiolm-cli.exe runtime list  # `runtimes` is also accepted
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
- `config get` redacts credential-like values; `server_args`, `chat_options`, and `lora_adapters` require JSON values when set.
- `models delete` accepts inactive `.gguf`/`.mmproj` files and app-owned snapshot directories inside `models_dir`. It preserves files outside the snapshot manifest and refuses active model/companion bindings.
- `runtime device` detects local GPUs and recommended backends; `runtime probe` runs version/help/device/bench preflight.
- `server start` uses the configured model, binds to `127.0.0.1`, and intentionally disables API-key auth. Use it only on a trusted machine and do not expose or forward the port.
- Headless stdout is JSON; server logs are bounded.

See [SECURITY.md](../SECURITY.md) for auth and process boundaries.

## Python engine runtimes

`config set provider_options '<json>'` replaces the complete engine option map. Read it with `config get`, keep the other engine entries, then submit an object such as `{"vllm":{"max_model_len":8192},"mlx-vlm":{"temperature":0.7}}` as one shell argument. Invalid or unknown options leave the saved configuration unchanged; `{}` clears the map. Model-specific and installed-runtime checks run before launch.

vLLM runs on Linux or Apple Silicon macOS 15+ via vllm-metal; mlx-vlm runs on Apple Silicon macOS. On a supported Mac, `runtime install vllm` uses matched vLLM/vllm-metal 0.30.0 wheels and native arm64 Python 3.12. `runtime list` includes native and registered Python installations. Install a pinned engine or register an existing interpreter, then select the returned runtime ID before choosing a complete local model snapshot. External environment removal preserves the interpreter and packages; Ctrl-C cancels a managed installation and removes its unfinished environment.

```text
aiolm-cli runtime install <vllm|mlx-vlm> [python-executable]
aiolm-cli runtime register <vllm|mlx-vlm> <python-executable>
aiolm-cli runtime select <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime probe <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime remove <vllm|mlx-vlm> <runtime-id>
aiolm-cli runtime export <vllm|mlx-vlm> <runtime-id> <new-bundle.zip>
aiolm-cli runtime import <bundle.zip>
```

See [Inference runtimes](../reference/inference-runtimes.md) for engine-specific artifacts, options, profiles and native validation requirements.

Export downloads exact wheels for the installed engine dependency closure and preserves platform, ABI and hashes. Import installs those wheels offline into a new environment and probes it; a compatible base Python interpreter must already be installed. Models are managed separately. Stop the headless server before export/import; Ctrl-C cleans up unfinished operations. Export preserves existing destination files.
