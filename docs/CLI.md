# CLI

> **Language:** [English](CLI.md) | [한국어](CLI.ko.md) | [日本語](CLI.ja.md) | [中文](CLI.zh.md)

During development, `aiolm-cli.exe` is built at `.codex-target/release/aiolm-cli.exe`. Packaged builds include it as a Tauri resource; locate the installed copy in the app's resource directory. Output is JSON, the server is loopback-only, and credentials are not persisted.

```powershell
./aiolm-cli.exe --help
./aiolm-cli.exe config get
./aiolm-cli.exe config set <field> <value>  # typed, non-secret only
./aiolm-cli.exe models list
./aiolm-cli.exe models delete <path>
./aiolm-cli.exe runtime list  # `runtimes` is also accepted
./aiolm-cli.exe runtime device
./aiolm-cli.exe runtime probe <backend> <build>
./aiolm-cli.exe server start   # loopback, no API-key auth in headless mode
./aiolm-cli.exe server status
./aiolm-cli.exe server logs [lines]
./aiolm-cli.exe server stop
./aiolm-cli.exe server unload  # alias for stop
./aiolm-cli.exe server restart
./aiolm-cli.exe doctor
```

## First start

Configure a model before starting the headless server. The server executable is resolved from the selected managed runtime or from `PATH`.

```powershell
./aiolm-cli.exe config set models_dir "C:\Models"
./aiolm-cli.exe config set active_model "C:\Models\model.gguf"
./aiolm-cli.exe server start
```

- `config set` rejects credential-like and unknown fields.
- `config get` redacts credential-like values; `server_args`, `chat_options`, and `lora_adapters` require JSON values when set.
- `models delete` is limited to inactive `.gguf`/`.mmproj` files inside `models_dir`.
- `runtime device` detects local GPUs and recommended backends; `runtime probe` runs version/help/device/bench preflight.
- `server start` uses the configured model, binds to `127.0.0.1`, and intentionally disables API-key auth. Use it only on a trusted machine and do not expose or forward the port.
- Headless stdout is JSON; server logs are bounded.

See [SECURITY.md](../SECURITY.md) for auth and process boundaries.
