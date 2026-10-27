# AioLM

> **Language:** [English](README.md) | [한국어](docs/guides/overview.ko.md) | [日本語](docs/guides/overview.ja.md) | [中文](docs/guides/overview.zh.md)

[Documentation index](docs/README.md) — installation, development, architecture, and policies.

AioLM (All-in-One LM) — Windows/macOS/Linux desktop runtime manager with a Tauri v2 UI for models, runtimes, chat, and benchmarks. Select llama.cpp, vLLM on Linux or Apple Silicon macOS via vllm-metal, or MLX on Apple Silicon macOS; see [inference runtimes](docs/reference/inference-runtimes.md) for compatibility and validation limits.

## Features

- GGUF and safetensors snapshot discovery, runtime compatibility filters and safe management
- Engine-specific settings profiles, execution options and multimodal inputs
- Managed runtimes (CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO) with portable ZIP support
- PR builds by number/URL with provenance review
- Streaming chat with local threads, document context, and embeddings
- User AGENTS.md instructions, local skills, and an in-app personalization editor
- Projects, Hugging Face Discover, and MCP servers
- Independent model loading and one API server page for OpenAI- and Anthropic-compatible clients
- Tuning for server and sampling parameters
- New-version notification at startup and verified installer updates from Settings

In Tuning, **Reset all tuning** removes all overrides, including raw server arguments and chat JSON; each field also has **Reset to default**. Defaults are inherited from the selected llama.cpp runtime/model, not hard-coded recommendation presets. **Set custom value** opts back into an override, and profiles retain the default-mode selection. Model files, adapters, GPU assignments, runtime selection and saved profiles are preserved. Server changes require **Apply & restart**; default context size and memory use can vary by runtime/model.

Loading a model makes it available to internal chat. Start the API server separately
from **API server** in the sidebar to use loaded models from other applications: copy
the URL, key and model ID, and pick the OpenAI or Anthropic example on the same page.
The API stays up when models are unloaded or replaced, and stopping it leaves internal
chat and loaded models available. See [API server and model lifecycle](docs/guides/local-api.md).

Use **Settings → Personalization** to edit your shared and AioLM-specific
AGENTS.md instructions. Chat reads these files for new turns and can load local
skills automatically or through the skill picker and `$skill-name` references.
See [chat personalization](docs/reference/personalization.md).

## Platform support

Windows x64, macOS 13.3+ (Apple Silicon and Intel) and Linux x86_64 (Ubuntu 24.04+) builds are available. Windows uses NSIS/MSI, macOS uses DMG and Linux uses DEB/AppImage. Linux packages are included starting with **v0.2.1**; see the [Linux installation guide](docs/guides/install.md#linux). macOS 13.3+ DMGs for Apple Silicon (with Metal) and Intel (CPU) are included starting with **v0.3.0**, ad-hoc signed but not notarized, with a verified [terminal installer](docs/guides/install.md#macos); [macOS validation](docs/reference/macos-validation.md) describes the hosted checks and remaining device work. Linux ARM64/NVIDIA DGX acceptance remains pending. See [cross-platform validation](docs/reference/cross-platform-validation.md). Release assets are unsigned and include SHA-256 checksums.

## Download

[Linux: DEB / AppImage](docs/guides/install.md#linux)

Windows:

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

Or get installer files directly from [GitHub Releases](https://github.com/aiolm/AioLM/releases).

For advanced install options, verification, development setup, and CLI usage, see [install.md](docs/guides/install.md), [development.md](docs/guides/development.md), and [cli.md](docs/guides/cli.md).

For data migration and compatibility, see [the migration guide](docs/reference/migration.md).

## Security and privacy

See [Security](docs/SECURITY.md) and [Privacy](docs/policies/privacy.md).

## License

MIT — see [LICENSE](LICENSE). llama.cpp binaries — see [NOTICE](NOTICE).
