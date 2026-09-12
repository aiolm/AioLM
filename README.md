# AioLM

> **Language:** [English](README.md) | [한국어](docs/guides/overview.ko.md) | [日本語](docs/guides/overview.ja.md) | [中文](docs/guides/overview.zh.md)

[Documentation index](docs/README.md) — installation, development, architecture, and policies.

Windows desktop runtime manager for `llama.cpp`. Uses `llama-server` with a Tauri v2 desktop UI for models, runtimes, chat, and benchmarks.

## Features

- GGUF model discovery and safe management
- Managed runtimes (CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO) with portable ZIP support
- PR builds by number/URL with provenance review
- Streaming chat with local threads, document context, and embeddings
- Projects, Hugging Face Discover, and Developer/MCP gateways
- Tuning for server and sampling parameters

In Tuning, **Reset all tuning** removes all overrides, including raw server arguments and chat JSON; each field also has **Reset to default**. Defaults are inherited from the selected llama.cpp runtime/model, not hard-coded recommendation presets. **Set custom value** opts back into an override, and profiles retain the default-mode selection. Model files, adapters, GPU assignments, runtime selection and saved profiles are preserved. Server changes require **Apply & restart**; default context size and memory use can vary by runtime/model.

## Platform support

Windows x64 is supported today. **Linux (including NVIDIA DGX) and macOS support is planned**. Linux/macOS will use `curl | tar`; Windows uses `NSIS`/`MSI`. Windows installers are built on GitHub-hosted CI and published unsigned with SHA-256 checksums.

## Download

Get the latest release from [GitHub Releases](https://github.com/joowon-jang/AioLM/releases).

For advanced install options, verification, development setup, and CLI usage, see [install.md](docs/guides/install.md), [development.md](docs/guides/development.md), and [cli.md](docs/guides/cli.md).

For data migration and compatibility, see [the migration guide](docs/reference/migration.md).

## Security and privacy

See [Security](docs/SECURITY.md) and [Privacy](docs/policies/privacy.md).

## License

MIT — see [LICENSE](LICENSE). llama.cpp binaries — see [NOTICE](NOTICE).
