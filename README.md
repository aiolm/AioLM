# AioLM

> **Language:** [English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md)

Windows desktop runtime manager for `llama.cpp`. Wraps `llama-server` / `llama-bench` with a Tauri v2 desktop UI for models, runtimes, chat, and benchmarks.

## Features

- GGUF model discovery and safe management
- Managed runtimes (CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO) with portable ZIP support
- PR builds by number/URL with provenance review
- Streaming chat with local threads, document context, and embeddings
- Projects, Hugging Face Discover, and Developer/MCP gateways
- Tuning for server and sampling parameters

In Tuning, **Reset all tuning** removes all overrides, including raw server arguments and chat JSON; each field also has **Reset to default**. Defaults are inherited from the selected llama.cpp runtime/model, not hard-coded recommendation presets. **Set custom value** opts back into an override, and profiles retain the default-mode selection. Model files, adapters, GPU assignments, runtime selection and saved profiles are preserved. Server changes require **Apply & restart**; default context size and memory use can vary by runtime/model.

## Platform support

Windows x64 is supported today. **Linux (including NVIDIA DGX) and macOS support is planned**. Linux/macOS will use `curl | tar`; Windows uses `NSIS`/`MSI`. Windows release installers are built on GitHub-hosted CI and are Authenticode-signed through the SignPath Foundation approval workflow after onboarding; verify the published signature and SHA-256 checksum.

## Download

Get the latest release from [GitHub Releases](https://github.com/llama-board/llama-board/releases).

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/llama-board/llama-board/releases/latest/download/install.ps1 | iex"
```

For advanced install options, verification, development setup, and CLI usage, see [docs/INSTALL.md](docs/INSTALL.md), [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), and [docs/CLI.md](docs/CLI.md).

AioLM — All-In-One LM installs separately from llama-board. On first launch it copies the previous configuration, managed runtimes, CLI storage and WebView profile into the new `aiolm` / `com.aiolm.desktop` locations. Original data stays intact; existing AioLM data takes priority. Close the previous app before migration and retry if a profile is locked or disk space is insufficient. See [migration details](docs/MIGRATION.md).

## Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

See [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md) and [PRIVACY.md](PRIVACY.md) for the project’s signing scope, roles, release approval, privacy, and uninstall policy. Maintainers can follow the [SignPath Foundation onboarding checklist](docs/SIGNPATH_FOUNDATION.md).

## Security

See [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE). llama.cpp binaries — see [NOTICE](NOTICE).

