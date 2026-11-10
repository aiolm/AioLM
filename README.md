# AioLM

> **Language:** [English](README.md) | [한국어](docs/guides/overview.ko.md) | [日本語](docs/guides/overview.ja.md) | [中文](docs/guides/overview.zh.md)

[Documentation](docs/README.md) — installation, usage guides and reference. The documentation describes the current source; a published release may not include the latest changes yet.

AioLM (All-in-One LM) is a desktop GUI adapter for Windows, macOS and Linux, not an inference engine. It finds, runs and compares local language models through llama.cpp, vLLM on Linux or Apple Silicon macOS (via vllm-metal), MLX on Apple Silicon macOS, and other connected engines serving an OpenAI-compatible API. See [inference runtimes](docs/reference/inference-runtimes.md) for platform and model-format details.

Fixed-output benchmarks (`openai-chat-serving@2`) require an engine that can control output length and report streamed completion-token counts. Every request must report exactly the selected output count; early endings or unverifiable counts fail instead of producing a successful measurement. Choices are 1k/4k/8k/16k/32k/64k/128k/200k, with 1k=1024. Defaults are 4096/16384 input UTF-8 bytes, 1k output tokens, concurrency 1/2/4, one repetition and warmup enabled. Launch profiles and context are preserved; large targets require enough model context per slot. Historical cap-based `@1` results keep their original meaning, history, exports and sharing. See [benchmarks](docs/reference/benchmarks.md).

## Features

- Hugging Face model search across all repository formats, sorted by Trending by default, with optional GGUF, safetensors and MLX filters
- In-app GGUF and HF/MLX safetensors downloads, with per-model weight selection, required loading files, a local model library and safe deletion
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

Search shows every repository. In-app downloads support GGUF files and complete HF/MLX safetensors model bundles: choose a weight file to include its required config, tokenizer and split parts without installing other weight variants. Whole-repository data snapshots remain available for repositories with root safetensors weights. Other formats stay visible with their model card; an external engine may still be able to run them. Search results do not select or favor an inference engine.

Downloads show their rate and time left and can be paused. Paused, failed or app-interrupted transfers appear under **Discover → Paused downloads**. **Resume** keeps the original repository revision and verifies the complete file against its published digest; files without a digest restart rather than appending unverified bytes.

Discarding a pending download removes its staged partials, including companion-file partials, but keeps completed files. Inference engines can be installed while a model downloads. Closing the window hides AioLM in the system tray by default, and **Settings → Server** can also start AioLM when you sign in.

Loading a model makes it available to internal chat. To use loaded models from other applications, start **API server** from the sidebar and copy its URL, key and model ID. See [API server and model lifecycle](docs/guides/local-api.md).

To connect another engine, open **Inference engines → Add inference engine → Find automatically**, choose a model and **Connect**. AioLM registers the engine only after a real chat and streaming check. See [external engine connections](docs/reference/automatic-engine-connections.md).

## Workspace

The sidebar gives everyday use and model operations the same navigation depth:

| Group | Screens |
| --- | --- |
| Workspace | Chat, Projects |
| Model operations | Library, Discover, Inference engines, Benchmark |
| Integrations | API server, MCP servers |
| App | Settings |

Collapse the desktop sidebar to an icon rail, or use the navigation drawer in a narrow window. Open panels keep their drafts when changing screens, theme, density or fonts.

Maximized windows expand the chat canvas and workspaces instead of retaining a narrow fixed-width layout. Settings, API panels and model options use multiple columns when space permits, with each option's name, description and input kept together. Model settings adapt to the window's width and height; narrower windows reduce the column count, and shorter windows scroll the content while keeping footer actions available.

Workspace colors retain the original Orchid Periwinkle palette: pale sky-to-lilac navigation in light mode, softer periwinkle surfaces in dark mode, and pastel cyan-blue primary actions with dark labels. Brand gradients are limited to navigation and primary actions. Input boundaries, keyboard focus and success/warning/error states remain distinct.

The chat header aligns with the message canvas. The answering model and runtime sit below the title; the session picker and Conversation settings share one control row, which moves below the title in narrow conversations.

The topbar controls default execution. The always-visible session selector in the chat header chooses the session that answers that conversation; choosing a worker does not change the default target. Retrieval and audio/video preprocessing are in **Conversation settings**. Attachments and selected tools/skills appear above the input, with attachment/tool/skill controls and Send/Stop below it.

Loading a saved answering session can be cancelled directly from Chat or the Library. Cancellation is reported as **Cancelled**, not a failed request. Selected MCP tools show **Not loaded** or **Unavailable** until discovered; their loading/removal controls stay beside the selection, while detailed guidance stays in the MCP tools panel.

Model settings use **Choose runtime → Choose profile → Adjust options**. Downloading or previewing a model does not start it; saving a profile and starting execution remain separate actions. Projects likewise separate saving a preset from applying its saved settings.

Theme and font controls are in **Settings → Appearance**; density is in **General**. Compact density reduces row spacing and control padding without shrinking touch targets. Personalization separates instruction-file application from the file being edited. Benchmark input-size and concurrency rows summarize the selected values; technical environment details and advanced request options start collapsed. History and copy stay in the result toolbar, while **Export and manage** contains export, profile creation and deletion.

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
- `npm run typecheck` checks application and tooling types. For UI changes, also run `npm run test:ui` and `npm run test:i18n`, then `npm run build` for the frontend. Native behavior tests run with `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features`.
- `npm run package:tauri` builds both production executables before creating host installers. macOS bundling enables verbose helper diagnostics so DMG failures include the underlying disk-image tool output.

Vitest coverage measures the frontend sources exercised by its suite, not the separate direct Node scripts. Source-text CSS/JSX assertions are not layout evidence; use an actual rendered application to evaluate layout.

Local native UI checks must isolate both application data and webview storage. Use a disposable `HOME`/`AIOLM_HOME` and a smoke-only window override with `incognito: true`; changing `HOME` alone does not isolate macOS WKWebView storage. Verify that preferences, projects and conversations are fresh before seeding synthetic fixtures, and never run a smoke against a production webview profile.

Desktop window chrome uses one theme-aware title strip above startup, setup and the workspace. macOS retains its native traffic lights over the strip; Windows/Linux draw caption buttons only when native frame removal succeeds. The strip stays interactive inside modal settings, nested confirmations and the navigation drawer, with space reserved above their content. The frame follows Light, Dark and System without pinning System to the last resolved color; Linux delegates System to the desktop portal and GTK session policy. Closing still follows the native close request and close-to-tray setting. Browser previews do not display window controls.

The keyboard **Skip to content** link starts below the title strip so it does not cover native window controls.

## Security and privacy

See [Security](docs/SECURITY.md) and [Privacy](docs/policies/privacy.md).

## License

MIT — see [LICENSE](LICENSE). Third-party notices, including llama.cpp runtimes and the Linux AppImage runtime, are in [NOTICE](NOTICE).
