# Provider native acceptance

Opt-in actual-engine acceptance for Linux vLLM, Apple Silicon vllm-metal (via
the vLLM engine) and mlx-vlm. Windows unit, contract, CLI and build checks
verify shared behavior; they never certify native inference on Linux or macOS.
This harness runs the remaining checks from
[Cross-platform validation](cross-platform-validation.md) and
[Inference runtimes](inference-runtimes.md) with a real engine, a real model
and an isolated temporary `AIOLM_HOME`.

Primary sources for runtime contracts are the pinned engine trees:
[vLLM 0.31.0](https://github.com/vllm-project/vllm/tree/v0.31.0),
[vllm-metal 0.30.0](https://github.com/vllm-project/vllm-metal/tree/v0.30.0) and
[mlx-vlm 0.7.6](https://github.com/Blaizzy/mlx-vlm/tree/v0.7.6).
Managed installs use Linux vLLM 0.31.0, macOS vllm-metal 0.30.0 with matching
vLLM core, and mlx-vlm 0.7.6. Metal needs Apple Silicon macOS 15+, native
arm64 CPython 3.12 and matched core/plugin wheels. Registration probes the
installed package, accelerator, model registry and server flags; launch and
deep verification re-probe, so a registration record never proves the
environment is unchanged.

## Scope boundary

The native headless CLI (`runtime register/probe/list/select`,
`config get/set`, `models list`, `server start/status/restart/stop/logs`,
`doctor`, `runtime export/import`) talks directly to the engine process and
bypasses the application protocol and gateway layers (chat history, endpoint
adapters, the media pipeline, auth). Engine HTTP verdicts in this harness
prove engine behavior only:

- `media_refusal` records that the *engine* refused a `file://` part. It does
  not prove the application refuses file paths.
- `media_supported`, `tools` and `embeddings` record engine capability, not
  application wiring.
- History, adapter binding, gateway routing and credential handling belong to
  precise GUI/native tests and are never inferred from an engine 4xx here.

## Principles

- Isolated home: every harness run creates `mkdtemp(aiolm-provider-acceptance-)`
  with `home with spaces`, clears `AIOLM_*`/`LLAMA_BOARD_*` from the parent
  environment and sets `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`,
  `XDG_*` and `AIOLM_HOME` inside it. Only that directory is removed on exit.
  Legacy migration roots are overridden in the child environment, as in
  `scripts/smoke-native-cli.mjs`.
- Explicit inputs: `--engine`, `--model` and either `--python` (to register)
  or `--runtime-bundle` (offline import) are required. `--runtime-id` is only
  useful when that id already exists in the isolated home. `--revision` pins the expected HF
  commit for snapshot directories. No model is downloaded by unpinned `main`
  and `runtime install` is never invoked by this harness.
- Revision evidence: when `--revision` is supplied, its complete SHA must
  match the app snapshot manifest or the standard Hub cache
  `snapshots/<full-sha>` directory. An external copy without that evidence
  fails validation; a substring in its name is never accepted as a pin.
- Explicit registration: a `--runtime-id` reuse cannot resolve against a
  fresh isolated home, which starts with no manifests and never copies the
  real user home. Reuse of an unknown id fails honestly at
  probe/runtime_identity. Prefer `--python` registration on native hosts; a
  portable archive round-trip (see below) is the supported way to move a
  runtime between homes with a compatible base Python interpreter.
- No multi-GB transfers: the model path must already exist. Small public
  acceptance candidates are proposals only (see below); the operator fetches
  them once, records the immutable revision and passes both explicitly.
- Authoritative results: every check is `pass`, `fail`, `unsupported`,
  `unrun` or `blocked`. Missing usage, model alias, platform identity,
  complete embedding vectors or transcript text is a `fail`, never a `pass`.
  Checks that never started stay `unrun`. A host that cannot run the engine
  reports `blocked` before any live attempt. A failure after `server start`
  stays `fail` and is never converted to a skip. A failed cleanup retains the
  isolated home for manual recovery instead of orphaning a live process.
- Task honesty: `--task chat` (default) requires chat. `--task embedding`
  and `--task transcription` let embedding-only and STT checkpoints record a
  refused chat as `unsupported` and prove their own endpoint instead; an
  undeclared embedding model under `--task embedding` is a `fail`.
- Declared expectations: `--expect-embeddings`, `--expect-media`,
  `--expect-tools` and `--expect-transcription` declare the operator verified
  support from the model registry or processor. A refused expected
  capability is a `fail`, not `unsupported`.
- Shareable privacy: the JSON written via `--out` keeps basenames only and
  never carries user model/Python paths, PIDs or URLs. Full local paths
  appear on the console only (`--keep-home` logging, or the retained-home
  message after a failed cleanup).
- Synthetic versus live: `node scripts/smoke-provider-runtime.mjs --self-test`
  exercises harness wiring against a loopback fake and marks
  `synthetic:true, live:false`. It is not native evidence. The Rust gate
  `src-tauri/tests/provider_runtime_acceptance.rs` runs synthetic schema and
  platform checks by default; its live test is `#[ignore]`d behind
  `AIOLM_PROVIDER_ACCEPTANCE=1`.

## Harness

Script: `scripts/smoke-provider-runtime.mjs`. Synthetic tests:
`scripts/smoke-provider-runtime.test.mjs` (fake CLI plus fake streaming
engine covering stop, cleanup retention, mid-body cancel, declared-capability
failure, probe/input failure, task paths and JSON hygiene). Rust gate:
`src-tauri/tests/provider_runtime_acceptance.rs`.

```sh
# Wiring only; no engine, model or accelerator touched.
node scripts/smoke-provider-runtime.mjs --self-test
node --test scripts/smoke-provider-runtime.test.mjs
```

Live runs need a built CLI (`npm run build:cli` or
`.codex-target/release/aiolm-cli`) and a free loopback port. Default port is
18080; pick another per concurrent run.

```sh
# Linux vLLM: register an existing interpreter, then run the matrix.
node scripts/smoke-provider-runtime.mjs --engine vllm \
  --python /usr/bin/python3 \
  --model /data/models/qwen2.5-0.5b-snapshot \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --cli .codex-target/release/aiolm-cli --port 18080 \
  --out tmp/provider-acceptance-vllm.json

# Reuse an already registered runtime without touching the interpreter.
# NOTE: reuse resolves inside the isolated home only. A fresh isolated home
# holds no manifests, so reuse of an id registered in the real user home
# fails at probe/runtime_identity by design. Prefer --python, or import a
# portable bundle first (see "Portable round-trip" below).
node scripts/smoke-provider-runtime.mjs --engine vllm \
  --runtime-id managed-0-31-0 \
  --model /data/models/qwen2.5-0.5b-snapshot \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --cli .codex-target/release/aiolm-cli --port 18081 \
  --out tmp/provider-acceptance-vllm-reuse.json

# Apple Silicon vllm-metal (same vLLM engine, Metal variant).
# Requires native arm64 CPython 3.12 and macOS 15+.
node scripts/smoke-provider-runtime.mjs --engine vllm \
  --python /opt/homebrew/bin/python3.12 \
  --model /data/models/qwen2.5-0.5b-metal-snapshot \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --cli ./src-tauri/target/release/aiolm-cli --port 18080 \
  --out tmp/provider-acceptance-vllm-metal.json

# Apple Silicon mlx-vlm (native arm64 CPython 3.12).
node scripts/smoke-provider-runtime.mjs --engine mlx-vlm \
  --python /opt/homebrew/bin/python3.12 \
  --model /data/models/qwen2.5-0.5b-mlx-4bit \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --cli ./src-tauri/target/release/aiolm-cli --port 18080 \
  --out tmp/provider-acceptance-mlx-vlm.json

# GGUF with a supplied companion directory (vLLM case; no download).
node scripts/smoke-provider-runtime.mjs --engine vllm \
  --python /usr/bin/python3 \
  --model /data/models/qwen2.5-0.5b-q4_k_m.gguf \
  --companion /data/models/qwen2.5-0.5b-companion \
  --cli .codex-target/release/aiolm-cli --port 18080 \
  --out tmp/provider-acceptance-vllm-gguf.json

# Embeddings only when an embedding model is declared. --expect-embeddings
# (or --task embedding) makes refusal a fail; a provider_options declaration
# alone makes refusal unsupported.
node scripts/smoke-provider-runtime.mjs --engine vllm \
  --python /usr/bin/python3 \
  --model /data/models/bge-small-en-v1.5-snapshot \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --cli .codex-target/release/aiolm-cli --port 18080 \
  --expect-embeddings --out tmp/provider-acceptance-vllm-embed.json

# Embedding-only checkpoint: chat refusal becomes unsupported, vectors must pass.
node scripts/smoke-provider-runtime.mjs --engine vllm \
  --python /usr/bin/python3 \
  --model /data/models/bge-small-en-v1.5-snapshot \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --cli .codex-target/release/aiolm-cli --port 18080 \
  --task embedding --out tmp/provider-acceptance-vllm-embed-only.json

# Speech transcription checkpoint (Metal STT or engine endpoint).
# Transcription support never establishes audio/video chat support.
node scripts/smoke-provider-runtime.mjs --engine vllm \
  --python /usr/bin/python3 \
  --model /data/models/whisper-small-snapshot \
  --revision 0123456789abcdef0123456789abcdef01234567 \
  --cli .codex-target/release/aiolm-cli --port 18080 \
  --task transcription --audio-file /data/fixtures/speech-sample.wav \
  --out tmp/provider-acceptance-stt.json
```

Useful flags: `--task chat|embedding|transcription`, `--revision <sha>`
(snapshot pin, 40-char hex), `--companion <dir>`, `--runtime-id <id>`,
`--port N`, `--timeout-ms 60000`, `--start-timeout-ms 180000`,
`--prompt "..."`, `--max-tokens 32`, `--expect-embeddings`,
`--expect-media`, `--expect-tools`, `--expect-transcription`,
`--media-file <image>`, `--audio-file <wav>`, `--keep-home` (debug only;
default removes the temp home; full paths are logged on console only),
`--out result.json`.

The Rust live gate wraps the same script and validates its JSON schema
(including shareable-privacy rules). Task and expectation inputs arrive via
environment:

```sh
AIOLM_PROVIDER_ACCEPTANCE=1 \
AIOLM_PROVIDER_ENGINE=vllm \
AIOLM_PROVIDER_TASK=chat \
AIOLM_PROVIDER_PYTHON=/usr/bin/python3 \
AIOLM_PROVIDER_MODEL=/data/models/qwen2.5-0.5b-snapshot \
AIOLM_PROVIDER_REVISION=0123456789abcdef0123456789abcdef01234567 \
AIOLM_PROVIDER_CLI=.codex-target/release/aiolm-cli \
AIOLM_PROVIDER_PORT=18080 \
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  --test provider_runtime_acceptance -- --ignored --nocapture --test-threads=1
```

Optional gate inputs: `AIOLM_PROVIDER_RUNTIME` (reuse),
`AIOLM_PROVIDER_COMPANION`, `AIOLM_PROVIDER_MEDIA_FILE`,
`AIOLM_PROVIDER_AUDIO_FILE`, `AIOLM_PROVIDER_EXPECT_EMBEDDINGS=1`,
`AIOLM_PROVIDER_EXPECT_MEDIA=1`, `AIOLM_PROVIDER_EXPECT_TOOLS=1`,
`AIOLM_PROVIDER_EXPECT_TRANSCRIPTION=1`.

## Native host runbooks

Run one harness invocation per engine/variant, plus the Rust live gate with
`AIOLM_PROVIDER_ACCEPTANCE=1`. Record engine version, model revision,
modalities and method coverage per run; leave unknown memory/context,
untested modalities and unavailable reference kernels as explicit gaps.
Actual-engine status for every row below is currently `not-run` from Windows;
no Linux/macOS native inference is claimed yet.

### Linux GPU (vLLM)

Prerequisites: NVIDIA GPU with a working driver, Python 3.10-3.14 with the
pinned vLLM 0.31.0 installed, a built `aiolm-cli`, a staged model snapshot
with a recorded 40-char revision, and a free loopback port.

```sh
/usr/bin/python3 -c "import vllm, sys; print(vllm.__version__, sys.version)"
export AIOLM_HOME="$(mktemp -d)/aiolm"   # throwaway only; harness uses its own temp home
.build/cli/aiolm-cli doctor              # replace with the real CLI path
node scripts/smoke-provider-runtime.mjs --engine vllm \
  --python /usr/bin/python3 \
  --model /data/models/qwen2.5-0.5b-snapshot \
  --revision <40-char-sha-from-manifest> \
  --cli .codex-target/release/aiolm-cli --port 18080 \
  --out tmp/provider-acceptance-vllm.json
```

Then rerun with `--task embedding` (embedding checkpoint),
`--expect-media` (only when the registry/processor declares image support;
a 400/422 then fails instead of passing as unsupported), and the GGUF
variant with `--companion` when applicable.

### Native arm64 Python 3.12 Mac Metal (vllm-metal)

Prerequisites: Apple Silicon Mac, macOS 15+, native arm64 CPython 3.12
(`python3.12 --version` and `arch` must agree), matched vLLM 0.30.0 core plus
vllm-metal 0.30.0 plugin wheels, a built `aiolm-cli`.

```sh
arch                                          # must print arm64
/opt/homebrew/bin/python3.12 -c "import sys, vllm, vllm_metal; print(sys.version, vllm.__version__, vllm_metal.__version__)"
node scripts/smoke-provider-runtime.mjs --engine vllm \
  --python /opt/homebrew/bin/python3.12 \
  --model /data/models/qwen2.5-0.5b-metal-snapshot \
  --revision <40-char-sha-from-manifest> \
  --cli ./src-tauri/target/release/aiolm-cli --port 18080 \
  --out tmp/provider-acceptance-vllm-metal.json
```

Expected Metal specifics: probe records `variant`, `metal_version`,
`metal_available:true` and a Metal accelerator; unsupported quantizations
refuse at probe/launch (`fail` with the engine reason, never a silent
skip); audio/video chat is unsupported in the pinned release and its
refusal is recorded separately from any speech-transcription endpoint.

### MLX (mlx-vlm)

Prerequisites: Apple Silicon Mac, native arm64 Python 3.10+ with pinned
mlx-vlm 0.7.6, a 4-bit MLX checkpoint with a recorded revision.

```sh
/opt/homebrew/bin/python3.12 -c "import mlx_vlm; print(mlx_vlm.__version__)"
node scripts/smoke-provider-runtime.mjs --engine mlx-vlm \
  --python /opt/homebrew/bin/python3.12 \
  --model /data/models/qwen2.5-0.5b-mlx-4bit \
  --revision <40-char-sha-from-manifest> \
  --cli ./src-tauri/target/release/aiolm-cli --port 18080 \
  --out tmp/provider-acceptance-mlx-vlm.json
```

### Portable round-trip

`runtime export` / `runtime import` move a registered runtime between homes
as an offline bundle (fresh ABI-matched interpreter on import). Both refuse
while the headless server runs, export refuses an existing destination, and
Ctrl-C cancels with staging cleanup. Exact commands on a native host:

```sh
# 1. Register explicitly, then export the runtime to a NEW zip path.
.build/cli/aiolm-cli runtime register vllm /usr/bin/python3
.build/cli/aiolm-cli runtime export vllm <runtime-id> /data/bundles/vllm-0.31.0-linux.zip

# 2. Import into a fresh isolated home and prove the id resolves there.
export AIOLM_HOME="$(mktemp -d)/aiolm"
.build/cli/aiolm-cli runtime import /data/bundles/vllm-0.31.0-linux.zip
.build/cli/aiolm-cli runtime list        # imported id present, available:true

# 3. The harness creates its own fresh home: import the bundle there too.
node scripts/smoke-provider-runtime.mjs --engine vllm \
  --runtime-bundle /data/bundles/vllm-0.31.0-linux.zip \
  --model /data/models/qwen2.5-0.5b-snapshot \
  --revision <40-char-sha> --cli <aiolm-cli> --port 18080 \
  --out tmp/provider-acceptance-portable.json
```

Negative cases to record: importing an archive built for another
OS/arch/Python ABI must refuse with an incompatibility error (fail, never a
pass); cancelling an export/import with Ctrl-C must report cancellation and
leave no partial staging behind; importing while the server runs must
refuse. Record the native result only after the restored engine actually
launches and answers. Synthetic offline pip tests establish packaging behavior
and do not establish native engine readiness or inference.

### STT and adapted-media follow-ups

- `--task transcription` with `--audio-file <wav>` exercises
  `POST /v1/audio/transcriptions`. Without `--audio-file` the harness sends a
  0.1s synthetic silence fixture, which proves endpoint wiring only.
- A 200 must carry nonempty transcript text; 400/404/415/422 under the
  transcription task is a `fail`. Transcription never establishes
  audio/video chat: record chat refusal separately.
- Adapted media is a desktop chat flow: explicitly select a running speech
  session for audio, or enable video frame sampling on an image-capable
  answering model. Verify transcript/frame labels, original attachments
  after reload, retry without repeated preparation, cancellation before chat
  and unchanged answering session. Video sampling needs local ffmpeg,
  carries actual presentation times and includes no audio track. Multiple
  attachments share a four-part media budget. Test this separately from
  native chat modality checks in the harness.

## Coverage matrix

Each run records these checks in order. Evidence keeps version, variant,
plugin version, accelerator, served alias, usage and HTTP statuses; it never
keeps PIDs, URLs or user paths.

| Check | CLI / native path | Pass condition |
| --- | --- | --- |
| platform | `ProviderId::availability` + harness gate | `pass` on a supported OS/arch, else `blocked` before any engine contact |
| registration | `runtime register <engine> <python>` or explicit `--runtime-id` | returns a runtime id; failures are `fail`; reuse notes the isolated home starts empty |
| probe | `runtime probe <engine> <id>` | nonempty engine `version`, empty `errors`, interpreter `python_version`, platform identity (`platform_system`/`platform_class`); anything less is `fail` |
| runtime_identity | `runtime list` | our id present, `available:true`, empty `problems` |
| config_selection | `runtime select <engine> <id>`, `config set active_model/port`, `config get`, `doctor` | model/port round-trip and `runtime_ready:true` via `live-python-probe` |
| model_validation | manifest inspection + `server start` preflight | `--revision` must be 40-char hex and match the manifest when present; revision validates only from an authoritative manifest, external snapshots keep the pin unverified |
| server_launch | `server start`, `server status` | `state:running`, `health:true`; an incomplete snapshot must be refused here (negative fixture, recorded as `pass`) |
| model_alias | `GET /v1/models` | nonempty string `id` list; first id is the served alias and is reused for every later request |
| stream_text_usage | `POST /v1/chat/completions` `stream:true` + `stream_options.include_usage`, prompt `--prompt`, `max_tokens` | non-whitespace deltas plus numeric `prompt_tokens`, `completion_tokens`, `total_tokens`; non-chat tasks record a 400/404/422 refusal as `unsupported` |
| cancel | abort one open stream mid-body, then a fresh request | abort observed on the open body and the next request completes with usage; stays `unrun` when chat is unsupported for the task |
| restart | `server restart`, `server status`, one more request | back to `running` and answering (chat verify, else model-list verify) |
| stop | `server stop`, `server status` | leaves `running`; a stop that succeeds records `pass`; cleanup re-stops on failure paths and retains the home when the server is still up |
| media_supported | tiny 1x1 PNG `image_url` data URI, or `--media-file` | `200` with usage is `pass`; `400`/`422` is `unsupported` unless `--expect-media` declared support, then it is `fail`; other statuses are `fail`; non-chat tasks stay `unrun` |
| media_refusal | `file:///etc/hostname` image part | engine `4xx` with an actionable error is `pass`; acceptance is a `fail`; engine verdict only, never app file-path proof |
| tools | `tools:[{get_time}]`, `tool_choice:auto` | `200` with usage is `pass`, recording `toolsAccepted` separately from `toolCalled`; parser `400`/`422` is `unsupported` unless `--expect-tools`, then `fail` |
| embeddings | `POST /v1/embeddings` when declared (`--expect-embeddings`, `--task embedding`, or `provider_options.embedding_model`) | `200` with complete nonempty numeric vectors is `pass`; refusal is `unsupported` unless expected (or the embedding task), then `fail`; undeclared stays `unrun`; the embedding task without a declared model is `fail` |
| transcription | `POST /v1/audio/transcriptions` under `--task transcription` | `200` with nonempty text is `pass`; refusal under the transcription task is `fail`; other tasks stay `unrun` |
| benchmark | desktop PerformanceBench cold-cache flow | `unrun` with the exact follow-up; PP/TG, worker RSS and CSV/XLSX export need the GUI |
| deep_verification | desktop DeepVerificationControls | `unrun` with the exact follow-up; vLLM reports a partial top-k KL bound, mlx-vlm a full-vocabulary KL; quantized weights without a CPU reference stay `unsupported` |
| cleanup | `server stop` + remove isolated home | temp home removed (or kept only with `--keep-home`); still-running/unknown server status retains the home and records `fail`; external interpreters untouched |

Interrupted installs/downloads and manifest-owned deletion are covered by the
existing `runtime_install` and CLI smoke suites, not by this harness. The
harness never deletes the supplied model and never removes an external
interpreter: cleanup stops the owned server and removes the isolated home.

## Fixtures

- Original snapshot: a complete app-owned directory with
  `.aiolm-snapshot.json` (`complete:true`, `repository`, 40-char `revision`,
  file list) plus `config.json`, tokenizer/processor and safetensors weights.
  Pass `--revision` with the same sha.
- Cancelled/interrupted snapshot (negative fixture): the same layout with
  `complete:false` or missing weights. The harness records
  `snapshot-incomplete` and the run passes only when `server start` refuses
  with readiness; downstream live checks stay `unrun`.
- GGUF companions (vLLM): `--model <file.gguf>` plus optional
  `--companion <dir>` holding the same-revision `config.json`/tokenizer from
  the same repository. Companion availability never implies Metal tensor
  compatibility; the loader decides.
- Supplied media: `--media-file <image>` (PNG/JPEG/WebP, or MP4 where the
  loader supports video) replaces the tiny synthetic PNG for the
  `media_supported` probe; `--audio-file <wav>` replaces synthetic silence
  for transcription. Fixtures live outside the repo and are passed by path;
  paths never enter shareable JSON.
- Never fetch by unpinned `main`. If the operator stages a fixture from the
  Hub, resolve its immutable commit first (for example with the Hub API or
  `huggingface-cli`) and pass it as `--revision`.

Small public acceptance candidates (proposals; operator fetches once and pins
the revision; sizes are approximate upstream figures, not promises):

| Engine | Candidate (primary source) | Approx size |
| --- | --- | --- |
| vLLM Linux | `Qwen/Qwen2.5-0.5B-Instruct` safetensors snapshot (https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) | ~1 GB |
| vLLM Linux | `HuggingFaceTB/SmolLM2-360M-Instruct` snapshot (https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct) | ~0.7 GB |
| vLLM GGUF | `Qwen/Qwen2.5-0.5B-Instruct-GGUF` `qwen2.5-0.5b-instruct-q4_k_m.gguf` + same-revision config/tokenizer (https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF) | ~0.4 GB weights |
| mlx-vlm | `mlx-community/Qwen2.5-0.5B-Instruct-4bit` (https://huggingface.co/mlx-community/Qwen2.5-0.5B-Instruct-4bit) | ~0.3 GB |
| vllm-metal text | same MLX/HF snapshot the Metal loader supports, or a dense `qwen2`/`qwen3`/`llama` GGUF with F32/F16/BF16/Q4_0/Q4_1/Q8_0 tensors plus adjacent HF config and tokenizer | depends on checkpoint |

Image, audio and video coverage needs a checkpoint whose registry entry and
processor declare that modality; the harness attempts a tiny image request
(or the supplied `--media-file`) and always attempts a `file://` refusal on
the chat task. vllm-metal audio/video chat is unsupported in the pinned
release; record its refusal separately from any speech-transcription
endpoint. Transcription support (including any native STT or explicit
optional audio/video preprocessing in desktop chat) does not establish
audio/video chat support and is not covered by the chat media checks here;
exercise transcription through its own endpoint and inputs. LoRA,
draft/speculative and pooling bindings need explicit local adapter/draft
paths that the loader supports; pass them through saved provider options
and record the launch verdict.

## Benchmark and correctness follow-ups

The CLI harness leaves `benchmark` and `deep_verification` as `unrun` with
pointers, because cold-cache procedure, worker RSS sampling and reference
kernels need the shared Rust API and the desktop flow:

```sh
# Benchmark history, PP/TG, worker RSS and CSV/XLSX export need the desktop
# PerformanceBench panel against the running server above.
# Deep verification needs DeepVerificationControls for the same
# engine/runtime/model/options triple.
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib verify::
```

vLLM exposes a top-k partition of prompt probabilities, so it reports a KL
lower bound and an exact target-token perplexity ratio against a transformers
CPU reference; a result within limits stays partial and never becomes a full
pass. mlx-vlm compares full-vocabulary logits on MLX CPU versus Metal.
Quantized formats without a CPU reference, KV quantization and extra launch
arguments the comparison cannot reproduce are `unsupported`. Process-group RSS
is not total VRAM/unified memory.

## Actual-engine status

No native run has completed from this Windows host. Every actual-engine row
is `not-run` until a Linux GPU host and an Apple Silicon Mac execute the
runbooks above:

| Host | Engine | Status |
| --- | --- | --- |
| Linux GPU | vLLM text/stream/usage/cancel/restart/stop | not-run |
| Linux GPU | vLLM media/tools/embeddings | not-run |
| Linux GPU | portable export/import round-trip | not-run |
| Apple Silicon macOS 15+ (arm64 Python 3.12) | vllm-metal lifecycle/cancel/cleanup/registration/removal | not-run |
| Apple Silicon macOS 15+ (arm64 Python 3.12) | vllm-metal Metal platform/device/core+plugin versions, HF+MLX+GGUF separation, quantization refusal, pooling-RAG/LoRA/speculative bindings | not-run |
| Apple Silicon (arm64 Python 3.12) | mlx-vlm lifecycle with Metal availability | not-run |
| Any STT-capable native host | transcription endpoint, adapted-media preprocessing | not-run |
| Native desktop host | benchmark PP/TG/cancellation/RSS/history/export, deep top-k/full-vocabulary comparisons | not-run |

## Manual and graphical checks

Native GUI checks need eyes and input devices; the harness cannot automate
them. Run them with an isolated home and a throwaway OS account. Never reuse
production settings, credentials or deletion targets.

```sh
# Linux example: isolated home, system Tauri prerequisites installed.
export AIOLM_HOME="$(mktemp -d)/aiolm"
npm run build:cli && npm run build
npm run tauri -- dev
# macOS equivalent uses the same AIOLM_HOME override and `npm run tauri -- dev`.
```

For each engine, in order: onboarding with a fresh home; Settings persistence
(engine, runtime, profile, model path with spaces and Unicode); all navigation
panels without JS errors; project/session labels after switching engines;
`Say OK in five words or fewer.` streamed chat with usage visible; Cancel
during generation then a fresh prompt; Unload/Restart/Stop with no residual
`vllm`/`mlx-vlm` process or bound port (`ss -ltnp` on Linux,
`lsof -iTCP -sTCP:LISTEN` on macOS); tray Show/Quit and close-to-tray on/off;
native file picker for a 1x1 PNG attachment and a `file://` refusal case;
MCP stdio approval Accept/Deny/Cancel with dialog cleanup; document embeddings
where declared and lexical fallback otherwise; benchmark history and CSV/XLSX
export; OS credential save/load/delete (Linux Secret Service unlocked, locked
and unavailable; macOS Keychain allow/deny/cancel). Record engine version,
model revision, modalities covered and any `unsupported`/`unrun` explicitly.
