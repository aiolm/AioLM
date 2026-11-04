# Inference runtimes

AioLM selects an inference engine, an installed runtime instance, a settings profile belonging to that engine, and a compatible local model. Runtime installation and model bindings remain execution choices; portable profiles do not select an installation on another computer.

| Engine | Local platform | Managed server | Model artifacts |
| --- | --- | --- | --- |
| llama.cpp | Existing supported Windows, Linux and macOS backends | llama-server | GGUF weights, with a compatible projector for multimodal models |
| vLLM | Linux | vLLM 0.31.0 | Complete supported Hugging Face safetensors snapshots |
| vLLM · vllm-metal | Apple Silicon macOS 15+, native arm64 Python 3.12 | vLLM 0.30.0 + vllm-metal 0.30.0 | Supported HF/MLX snapshots and a restricted subset of local GGUF weights |
| MLX | Apple Silicon macOS | mlx-vlm 0.7.6 | Complete supported MLX or Hugging Face safetensors snapshots |

Native Windows vLLM and WSL/remote execution are not local runtime targets. The runtime picker explains operating-system availability. Python environments are isolated managed environments or explicitly registered existing interpreters. Registration probes the installed package, accelerator, model registry and available server flags. Removing a registered environment removes AioLM's registration and preserves the external interpreter and its packages.

llama.cpp release installation, PR installation and portable archive import/export share one runtime operation. Other install and removal actions remain blocked until it finishes or is cancelled; the owning operation keeps its progress and cancellation control. A runtime manager opened elsewhere observes that busy state without preventing you from returning to model settings or closing the observing dialog.

The Linux managed vLLM plan installs the pinned PyPI package with its default CUDA dependencies. An AMD GPU does not make that wheel a ROCm build. For ROCm, prepare a compatible environment using the [upstream GPU installation instructions](https://docs.vllm.ai/en/v0.31.0/getting_started/installation/gpu/) and register its interpreter. The wheel, PyTorch, ROCm userspace and system driver must work together; registration and a real model launch establish readiness. AioLM does not install system GPU drivers or silently replace the host's ROCm libraries.

On supported Macs, choose the existing vLLM engine to use vllm-metal. Its profiles remain vLLM profiles; the selected installation determines Metal compatibility and available options. Managed installation uses the matching official core and plugin wheels in an owned environment. It does not run upstream shell installers or install the generic PyPI vllm-metal package. Registration checks that the Metal platform is active and its native device and extension work. Intel Macs, Rosetta Python, earlier macOS releases and mismatched core/plugin versions cannot become ready Metal runtimes.

## Model selection and profiles

The editor keeps engine selection, the installed runtime selector and profile selection/actions in a fixed context area. Model lists, profile details and execution options scroll separately below it. Profiles can be selected from that area before choosing a primary model. Each option category shows the selected runtime's supported options; a category with no exposed options explains that state. Profile previews show the selected engine's values, with explicit provider request values taking precedence over shared sampling defaults.

The shared model settings dialog selects the engine before presenting its profiles and compatible primary models. Selecting another engine preserves its working execution settings and system prompt while the dialog is open. Each engine has an independent default profile and recent profile selection. Existing profiles and saved sessions without an engine identifier migrate to llama.cpp. Legacy backend/build fields are preserved as migration metadata rather than selecting a runtime when a portable profile is applied.

The model library shows all detected artifacts, their format and compatibility evidence. Its runtime filter includes companion GGUF projectors for llama.cpp. Launch selection excludes projector-only artifacts. Embedding-only models can start an embedding session, and supported speech models start a transcription session; chat and text benchmarks require a generation session. Missing files, incomplete downloads and unknown model architectures remain visible in the library and cannot silently become supported launches.

## Engine presentation across menus

| Surface | Engine context and behavior |
| --- | --- |
| Application header | Displays the live engine/runtime while a model is loaded and the selected configuration while stopped. |
| Model library | Starts with all models; its engine filter is independent of execution selection. Snapshot formats, architectures and declared input modalities appear alongside GGUF metadata. |
| Find models | Engine-neutral. Search opens on All formats, which lists every Hugging Face model repository without a tag filter; an optional filter narrows it to GGUF, HF Safetensors or MLX Safetensors whichever engine is configured. In-app download actions come from the selected repository's actual file tree: GGUF shards, projectors and opt-in config/tokenizer companions when GGUF files exist, and the folder snapshot only when root safetensors weights exist. A repository with neither stays searchable with its model card and an explanation that other formats may still work with an external engine. Browsing and downloading neither edit execution settings nor choose an engine. Setup happens only on an explicit Configure: the downloaded path is applied to the currently configured engine and runtime, and model settings then reports compatibility and owns any engine change. A completed download is not handed off after the configured engine or runtime changed. |
| Runtime management | Opens on an inventory of all engines rather than a shared engine selector; opening an engine shows that engine's own inventory context. Native backend releases, PR builds and binary probes belong to llama.cpp's inventory; Python installation, registration and portable archives belong to the vLLM or MLX inventory. Operating-system support and readiness remain explicit. Opening management from an editor always returns to the complete engine inventory without saving or discarding its draft. |
| Loaded models, projects and chat | Use the same engine-aware runtime labels. The model library's loaded-model list shows each loaded session's live identity, which takes precedence over an older saved configuration. Chat shows the selected session's runtime in its conversation settings. |
| Benchmark | Reports engine, profile, runtime and the selected engine's options. Python engines do not inherit native GPU layers, cache settings or a CPU-only label from legacy configuration fields. Hardware selected by a Python runtime is reported as runtime-selected rather than inferred from native GPU placement. |
| Failure details | A failed model shows its error and runtime log in the loaded-model list, the application error banner and Chat; a loaded model's log and live engine/runtime identity are in its loaded-model details. |
| API server, MCP and app preferences | Remain shared services and preferences. Their controls apply independently of the selected inference engine. Model/session-specific behavior is resolved through the engine adapter. |

Engine-neutral presentation does not imply identical flags or verification tools. For example, llama.cpp binary probes and PR builds are native capabilities, and Python accelerator/model support is determined by installation probes and model compatibility. Unavailable features retain an explicit explanation rather than a control targeting another engine.

The option editor uses the selected installation's schema and probed flags. Metal constraints also restrict option values: a flag appearing in vLLM's generic help does not prove its implementation supports it. Absent values inherit that engine's defaults. Saved unsupported values remain available to inspect and clear; launch validation also checks them in Rust. Sampling options can be delivered to the next request. Changes to context allocation, parallelism, model/draft/embedding bindings and launch arguments require a restart. Command import and preview use the same schema, and app-owned host, port, model alias and authentication settings cannot be overridden by extra arguments.

Changing the runtime retains the saved model path for correction and checks it against the newly selected installation before enabling launch. Replacement launch validates the new configuration before unloading the current model. Python interpreters are probed again at launch, so a registration record does not establish that the environment still has the same packages or accelerator. Project and session summaries display the selected engine installation rather than a leftover llama.cpp backend/build.

Metal launches currently bind one local device. Its KV dtype choices are `auto`, `float16` and `bfloat16`; an explicit KV dtype must match an explicit model dtype. Quantization overrides must match the checkpoint's supported loader method. Text safetensors generation can use PEFT LoRA, and validated local draft, MTP or ngram settings can use speculative decoding. LoRA and speculative decoding cannot be combined. Pooling, native image and GGUF LoRA combinations, distributed topology and arbitrary loader overrides have no app binding in this version.

## Complete model snapshots

Discovery can download GGUF files or complete data snapshots for Python engines. A snapshot is pinned to an immutable Hugging Face commit and contains config, tokenizer/processor, safetensors weights and associated data files. Download progress includes every file and resumes verified completed files. New or incomplete snapshots keep an incomplete manifest until the entire snapshot is verified. Re-verifying an already complete, matching snapshot preserves its ready state if cancelled; detected missing, corrupt or invalid loading files mark it incomplete before any transfer or staging changes. Python/pickle payloads and remote model code are not downloaded for execution.

Standard split GGUF files such as `model-00001-of-00033.gguf` appear as one download choice with their combined size and part count. One operation resolves every part from the same immutable revision, reports combined progress and returns the first shard as the launch entrypoint. Cancellation preserves completed files for retry; incomplete repository shard sets are rejected before transfer. The physical GGUF parts remain separate for loaders that support split models.

Download completion actions belong to the repository and destination that produced them. Starting another search, selecting another repository or changing format clears previous actions; changing the destination hides results from the old folder immediately. A transfer still completes and refreshes the model catalog if you browse elsewhere. **Configure and run** uses the engine and runtime selected when you press it, not those selected when the download began. Until a positive transfer total is reported, progress is indeterminate and shows only received bytes rather than an invented percentage or zero-byte total.

Discovery opens on the Trending order with All formats; Most downloads, Most likes and Recently updated remain selectable. Search sends no format filter for All formats and otherwise follows the selected artifact format; the MLX format also requests MLX repositories. Searching, in-app download formats and execution compatibility are separate: one read of the selected repository's tree supplies its GGUF files and whether root safetensors weights exist, which only makes the snapshot download available. The snapshot planner still validates the complete model before writing files, tags and the configured engine are never used to infer downloadable files, and compatibility is reported during setup. Discovery lists complete and interrupted app-owned snapshots for the current repository and destination. Root config, nonempty weights, complete indexed shards and local tokenizer assets are required; processor assets are included when published and are not required for text-only snapshots.

For vLLM GGUF downloads, an optional companion checkbox appears when the same repository publishes config and tokenizer assets. These assets and the selected GGUF use the same immutable revision, and the downloaded config's architecture must match the weights. Existing files are verified and never replaced; the companion option also permits retrying a transfer whose GGUF already exists. A GGUF downloaded without these assets remains a library file until its loading prerequisites are supplied. Neither companion availability nor successful download establishes Metal tensor compatibility. Separate base-model repositories are not downloaded automatically.

App-owned snapshots have a manifest identifying their downloaded files. Deletion removes only files owned by that manifest, retains other user files and refuses deletion of active model or companion bindings. External snapshot directories are preserved. A local snapshot fingerprint namespaces embedding caches so changing weights/config/tokenizer data invalidates their previous cache identity; it is not a claimed full weight-file SHA256.

Metal GGUF loading requires one unsharded local file with dense `qwen2`, `qwen3` or `llama` architecture, matching adjacent HF config and a local tokenizer. Every tensor descriptor must use F32, F16, BF16, Q4_0, Q4_1 or Q8_0. K-quants, fused QKV, MoE, SSM and vision tensors are refused; the header's general file type alone cannot establish compatibility. Managed Metal environments include the optional GGUF dependency. The native loader still validates tensor shapes and parameter correspondence before inference.

## Multimodal chat and document retrieval

Image, audio and video inputs are enabled by the intersection of model metadata, the installed engine's model registry and the supported request protocol. Choosing an engine does not give a text-only model vision or audio capability. llama.cpp projector bindings remain specific to llama.cpp; Python models use their tokenizer/processor assets and engine-specific loading requirements.

For the pinned Metal release, image chat is limited to installed Qwen3-VL, Qwen3.5 and PaddleOCR-VL adapter paths. Gemma4 and Qwen3.5 FP8 conditional wrappers use their text backbones. Audio and video chat remain unavailable; speech transcription support does not establish audio-chat support. Unsupported inputs are rejected explicitly.

Metal Whisper and Qwen3-ASR checkpoints use dedicated speech sessions. Whisper serves `/v1/audio/transcriptions` and `/v1/audio/translations`; Qwen3-ASR serves transcription only. The installed STT registry and dependencies determine readiness. Managed Metal environments include `gguf,stt` extras. Non-WAV speech input requires locally installed ffmpeg. The public API accepts multipart audio, retains the binary file, and maps the public model alias to the selected session; an ordinary chat or embedding session cannot receive a transcription request.

The chat panel offers explicit local media preprocessing. Select a running transcription session to convert an audio attachment into labeled text for the answering model. Opt in to sampled video frames when that model supports images; extraction uses local ffmpeg with bounded frame count, file size, time and cancellation. Frames do not include the video's audio track. The original attachment reference and exact prepared transcript or image references remain in history and are reused on replay and retry. The answering runtime stays selected throughout preparation. The app does not install ffmpeg, download a speech model, or silently switch engines for this flow.

Attachments are copied to immutable app-owned media storage and saved in local chat history by reference. Requests resolve those references for the selected engine; unsupported media produces an actionable error instead of dropping the attachment. The native media store limits each file to 64 MiB, and message validation limits the number and total decoded size of media parts. MLX video uses an app-owned local file because its server does not accept video data URIs. The Anthropic wire adapter reports inputs it cannot represent; the OpenAI-compatible endpoint remains available for supported multimodal requests.

Document search prefers the answering session's embedding model. Conversation settings can explicitly select another running embedding session or keyword search. When several other embedding sessions are available, automatic selection avoids an arbitrary target. The request captures its embedding model, namespace and authentication at turn start, preserving them through retries and tool follow-ups.

When vLLM's profile declares a context limit, chat trims history against that limit and bounds an explicitly configured response token count by the estimated remaining space for that request. The saved profile is unchanged. Token estimates do not replace the engine's exact tokenizer validation; an inherited or unknown context limit is not presented as a measured allocation.

### Optional compatibility wheels

For advanced users, `scripts/provider-compatibility/build_wheel.py` rebuilds an exact upstream vLLM `0.30.0+cpu` or mlx-vlm `0.7.6` wheel with small media-handling corrections, producing `0.30.0+cpu.aiolm.media1` or `0.7.6+aiolm.media14`. It checks the input wheel's SHA-256 and expected source, refuses signed wheels, keeps license files and never overwrites existing output:

```sh
python3 scripts/provider-compatibility/build_wheel.py --provider mlx-vlm \
  --wheel <upstream-wheel> --source-sha256 <expected-sha256> \
  --output-directory <new-directory>
```

Install the result with `--no-deps` into a new Python environment that already has the same dependencies, register that interpreter in AioLM and use it with a separate profile. Managed installations and existing profiles are not changed.

The mlx-vlm compatibility wheel adds two opt-in Gemma3n audio options. Add them to that profile's additional server arguments under **Advanced**:

```json
["--gemma3n-audio-padding", "encoded-left", "--gemma3n-audio-dither"]
```

`--gemma3n-audio-padding encoded-left` places unused audio padding before the recording's features instead of after them; the default, `model`, keeps upstream behavior. `--gemma3n-audio-dither` adds a small, reproducible input dither, is off by default and requires `encoded-left`. Clips longer than 30 seconds are rejected with HTTP 400. These options exist only in the compatibility wheel and do not guarantee transcription accuracy.

## Benchmarks and verification

AioLM is a GUI adapter, not an inference engine. Every connected engine capable of text-streaming chat uses the same OpenAI-compatible API benchmark (`openai-chat-serving@1`) and the same run, history, export, sharing and management path. The selected launch profile is preserved: client concurrency does not rewrite server capacity, context, cache or thinking settings. Inputs are exact UTF-8 bytes, not token counts; `max_output_tokens` is a request cap, not a forced generation length. Defaults are 4096/16384 input bytes, output cap 128, concurrency 1/2/4, one repetition, warmup enabled and optional usage requests disabled. Cache is measured as configured, not guaranteed cold.

First output (content or reasoning), channel timings, end-to-end duration and output bytes are client-observed. Output B/s is derived from observed bytes and duration; reported tok/s uses only engine-reported completion counters. Token and cache counters may remain unknown, even when usage is requested. Missing usage and early EOS are not failures; malformed or absent streaming completion is. Unknown model identity or optional metadata does not exclude an otherwise eligible engine. Memory is reported only for a known owned compute scope; an attached upstream's proxy RSS is not engine memory. Measurements do not establish independently verified engine or hardware rankings. See [benchmarks](benchmarks.md).

The inference-engine screen runs lightweight runtime probes. Numerical comparison of a model against a CPU reference is not offered in the app or the public CLI. llama.cpp launches keep their small launch-time check of the selected GPU placement; Python engine launches do not have one and remain marked unverified.

Engine behavior follows [vLLM 0.31.0 source](https://github.com/vllm-project/vllm/tree/v0.31.0), [vllm-metal 0.30.0 source](https://github.com/vllm-project/vllm-metal/tree/v0.30.0) and [mlx-vlm 0.7.6 source](https://github.com/Blaizzy/mlx-vlm/tree/v0.7.6). Available flags and model registries are probed again for registered installations. Metal compatibility uses its loader's model types and task support rather than vLLM's broader architecture registry. The image URL adapter follows the [Anthropic Messages image source format](https://platform.claude.com/docs/en/claude_api_primer).

New shared benchmark records use public schema version 3 for every engine, with nullable runtime identity, engine-neutral model format and typed public launch/request settings. Unknown identity, format or optional counters remain unknown rather than being inferred from local IDs or another engine. Model source repository/revision, when recorded, is provenance rather than proof of weight contents. Legacy schema 1/2 records retain their original token/cold-method meanings and are not relabeled as byte measurements. Local interpreter, model, adapter and draft paths are never shared. See [benchmark history and sharing](benchmark-sharing.md).

Standard vLLM inference needs a supported Linux accelerator environment; vllm-metal and MLX inference need a supported Apple Silicon Mac. Windows cannot run these engines locally.

## Portable runtime archives

Runtime archive import/export supports llama.cpp binaries and Python engine wheel bundles. Python exports capture the exact installed dependency closure, platform/ABI and wheel hashes; imports create a new isolated environment using local wheels only, then run the normal readiness probe. They require a compatible base interpreter on the destination. The virtual environment itself is not relocated. Metal bundles preserve matched core/plugin wheels and the pinned pure-Python mlx-lm revision. Unrelated packages, credentials, interpreter paths and model files are excluded. Source or editable installs other than that pinned mlx-lm are refused with an explanation. Export may download missing wheels; import is offline and cancellable. Existing export files are preserved.

Use Runtime settings or `aiolm-cli runtime export <vllm|mlx-vlm> <runtime-id> <new.zip>` and `aiolm-cli runtime import <bundle.zip>`. Stop running headless sessions before either CLI operation.

## llama.cpp PR builds

Runtime management can install a llama.cpp pull request by number or URL. A prebuilt PR artifact needs only a compatible GPU driver for GPU backends. Building a PR from source on your computer needs CMake and a C/C++ toolchain, plus the SDK for the selected backend: the CUDA Toolkit for `cuda`, the Vulkan SDK for `vulkan`, or the HIP SDK with `hipcc` for `rocm`. SYCL and OpenVINO source builds are refused. The build compiles third-party code as your user; review the provenance AioLM shows before confirming. See [Security](../SECURITY.md#building-a-pr-from-source).
