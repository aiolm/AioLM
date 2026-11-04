# AioLM

> **Language:** [English](README.md) | [한국어](docs/guides/overview.ko.md) | [日本語](docs/guides/overview.ja.md) | [中文](docs/guides/overview.zh.md)

[Documentation](docs/README.md) — installation, usage guides and reference. The documentation describes the current source; a published release may not include the latest changes yet.

AioLM (All-in-One LM) is a desktop GUI adapter for Windows, macOS and Linux, not an inference engine. It finds, runs and compares local language models through llama.cpp, vLLM on Linux or Apple Silicon macOS (via vllm-metal), MLX on Apple Silicon macOS, and other connected engines serving an OpenAI-compatible API. See [inference runtimes](docs/reference/inference-runtimes.md) for platform and model-format details.

All connected text-streaming engines use the same API benchmark (`openai-chat-serving@1`), history, exports, sharing and management. Timing and output bytes are client-observed; token and cache counters are engine-reported and may remain unknown. Inputs are UTF-8 bytes, not tokens; the output-token request cap is not a forced output length. Launch profiles are preserved and cache is measured as configured, not guaranteed cold. Defaults are 4096/16384 input bytes, output cap 128, concurrency 1/2/4, one repetition, warmup enabled and optional usage requests disabled. See [benchmarks](docs/reference/benchmarks.md).

## Features

- Hugging Face model search across all repository formats, sorted by Trending by default, with optional GGUF, safetensors and MLX filters
- In-app downloads of GGUF files and complete safetensors snapshots, with a local model library and safe deletion
- Managed llama.cpp runtimes (CPU/Vulkan/ROCm/CUDA/SYCL/OpenVINO), portable runtime archives and llama.cpp PR builds with provenance review
- Settings profiles per engine, resource estimates before loading, and multimodal inputs where the model and engine support them
- Loaded-model management with start/stop, settings and runtime logs in the model library
- Streaming chat with local conversations, projects, document search and MCP tools
- Personal AGENTS.md instructions and local skills, edited in **Settings → Personalization**
- A local API server for OpenAI- and Anthropic-compatible clients
- Serving benchmarks with history, exports and optional public sharing
- Automatic connection of other local inference engines
- Update notification at startup and verified installer updates from Settings
- A headless CLI

Search shows every repository, but in-app downloads handle only GGUF files and complete safetensors snapshots. A repository in another format stays visible with its model card; an external engine may still be able to run it. Search results do not select or favor an inference engine.

Loading a model makes it available to internal chat. To use loaded models from other applications, start **API server** from the sidebar and copy its URL, key and model ID. See [API server and model lifecycle](docs/guides/local-api.md).

To connect another engine, open **Inference engines → Add inference engine → Find automatically**, choose a model and **Connect**. AioLM registers the engine only after a real chat and streaming check. See [external engine connections](docs/reference/automatic-engine-connections.md).

## Install

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://github.com/aiolm/AioLM/releases/latest/download/install.ps1 | iex"
```

macOS 13.3 or later:

```bash
curl -fsSL https://github.com/aiolm/AioLM/releases/latest/download/install.sh | bash
```

Linux (Ubuntu 24.04 or later, x86_64): download the DEB or AppImage from [GitHub Releases](https://github.com/aiolm/AioLM/releases) and follow the [Linux instructions](docs/guides/install.md#linux).

Installers are unsigned; macOS builds are ad-hoc signed but not notarized. Each release includes SHA-256 checksums. The [installation guide](docs/guides/install.md) covers verification, first launch, updates, uninstalling and [building from source](docs/guides/install.md#build-from-source). See also the [CLI guide](docs/guides/cli.md) and [data folder and migration](docs/reference/migration.md).

## Development validation

Use the Node, npm and Rust versions pinned in the repository; see [build requirements](docs/guides/install.md#requirements).

- `npm test` runs contract, tooling and direct-script checks, followed by the full Vitest coverage suite.
- `npm run test:coverage` also works without prebuilt benchmark contracts: it builds the workspace package before running coverage. `test:coverage:run` is the shared internal execution step and requires that preparation.
- `npm run test:direct` runs the explicitly ordered Node assertion scripts in separate processes and stops at the first failure. Before starting a child, it rejects unregistered, missing or duplicate entries. Add a regular `tests/direct/test-*.ts` file to both `DIRECT_TEST_SCRIPTS` in `tests/direct/run.ts` and its individual npm command; the runner harness itself is excluded from the child inventory.
- `npm run typecheck` checks application and tooling types. `npm run build` builds the frontend; native behavior tests run with `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features`.

Vitest coverage measures the frontend sources exercised by its suite, not the separate direct Node scripts. Source-text CSS/JSX assertions are not layout evidence; use an actual rendered application to evaluate layout.

## Security and privacy

See [Security](docs/SECURITY.md) and [Privacy](docs/policies/privacy.md).

## License

MIT — see [LICENSE](LICENSE). Third-party notices, including llama.cpp runtimes and the Linux AppImage runtime, are in [NOTICE](NOTICE).
