# External engine connections

AioLM can use an inference engine other than its built-in llama.cpp, vLLM and
MLX support, as long as that engine serves an OpenAI-compatible (`/v1`) API on
your computer. The engine's implementation language does not matter. Automatic
connection is the normal way to add one; advanced manual registration remains
available for engines that need an explicit launch description.

## Connect automatically

**Inference engines** opens an inventory of all engines. Opening `llama.cpp` or
another engine browses its runtimes without changing which engine your models
use. **All inference engines** returns to the inventory with its search and
expanded details kept.

1. Open **Inference engines → Add inference engine → Find automatically**.
2. Tell the discovered items apart by their source, entry-point path and listener
   address. Select one, choose **Check selected item**, then select a model.
   A sole result is checked automatically. After a failed or cancelled check,
   **Check selected item** checks it again without repeating discovery; full
   discovery is still available, for example after the process has restarted.
   Selecting among several items does not run them. If nothing is found, choose
   the engine's installation folder, not an individual executable or JSON file.
3. Choose **Connect**. AioLM registers the engine only after the selected model
   answers a chat request and completes a streaming response. Your existing
   model settings and profiles do not change; choose the new engine and model in
   a settings profile to use them.

This flow needs no JSON files or probe programs.

## What a connection checks

- Discovery looks at your own processes, their listening ports and limited
  installation metadata. It does not run every executable, import modules or read
  process environments. The process and listener are checked again before
  connecting, and cancelling a check does not skip it on a later retry.
- A running server must answer an OpenAI `/v1` model-list request, and the
  selected model must pass a regular chat request and a complete streaming
  response. This establishes text chat and streaming only. It confirms that
  requests reach the selected model name; it is not proof of which weight files
  the server loaded, and it does not certify images, audio, tools or answer
  quality.
- A server that was already running is attached through a local proxy owned by
  AioLM. Stopping the connection in AioLM stops the proxy and its requests and
  leaves the original server, and any container it runs in, alone.
- A stopped installation can be started by AioLM only when it has a discoverable
  entry point (or an explicitly declared interpreter) and documented, unambiguous
  arguments for the model, host and port. A trial launch must confirm the model
  routing and that the listener belongs to the process AioLM started.
- AioLM records checksums of the engine's executable, scripts and connection
  data. If those external files change, register the engine again. After an
  AioLM update, AioLM revalidates its own connection helper.

Engines that need their own protocol, credentials, ambiguous model IDs or
container creation are not connected automatically. A server already running in
a container can connect like any other local server. AioLM does not install
engines, supply engine-specific flags or manage containers.

Connecting an engine runs a program or sends requests to a local server, so
choose installations you trust.

## Advanced manual registration

**Add inference engine** also offers manual options: choose an executable or
entry point, import a connection settings file supplied with an engine adapter,
or check a complete runtime manifest. The same manifest can be registered from
the CLI:

```text
aiolm-cli runtime register-manifest <manifest.json>
aiolm-cli runtime select <custom.engine-id> <runtime-id>
aiolm-cli runtime probe <custom.engine-id> <runtime-id>
aiolm-cli runtime remove <custom.engine-id> <runtime-id>
```

Stop the headless server before registering. Registration runs the manifest's
probe; removing a registration deletes only AioLM's record, never the engine's
files or models.

### Runtime manifest

A manifest is a JSON file of at most 256 KiB. Unknown fields are rejected.

| Field | Meaning |
| --- | --- |
| `schema_version`, `adapter_version` | Both `1`. |
| `protocol` | `"openai-v1"`. |
| `engine_id` | `custom.` followed by a lowercase letter or digit, then letters, digits, `.`, `_` or `-`; at most 64 characters in total. Built-in engine names cannot be used. |
| `runtime_id`, `display_name` | The installation's ID and display name. An existing registration with the same engine and runtime ID is not overwritten. |
| `platforms` | The `{os, arch}` pairs the build actually runs on: `windows`, `linux` or `macos`, and `x86_64` or `aarch64`. |
| `probe`, `launch` | Each an absolute `program`, an `args` array and optional `env` and absolute `working_directory`. Arguments are passed as given; no shell is used, so do not add quoting. |
| `health_path`, `health_authenticated` | The loopback health endpoint and whether it needs the API key. |
| `model_formats` | Declared formats: `gguf`, `hf-safetensors`, `mlx` or `unknown`. A declaration does not establish that a model works. |
| `models` | Optional explicit `{path, name}` model entries to add to the library. AioLM does not scan folders for other files. |
| `artifacts` | Optional absolute paths of scripts, libraries and configuration the engine depends on, at most 256. Their SHA-256 is recorded at registration and checked before every use. |
| `options` | Optional settings shown in AioLM: `key`, `target` (`launch` or `request`), `kind` and optional `flag`, `group` and `runtime_default`. |
| `option_metadata` | Optional facts the engine's help text cannot show, such as which options are secret, their units, ranges and whether they need a restart. Options marked `sensitive` are hidden in previews, CLI output and benchmark records. |

`launch_bindings`, `bridge_command`, `launch_resources` and `command_layout` are
optional fields for wrappers and bridges; adapters that need them document them.

Launch arguments use these placeholders: `{model}`, `{model_alias}`, `{host}`,
`{port}`, `{api_key}`, `{ctx_size}`, `{parallel}` and `{options_json}`.
`{api_key}` is allowed only in `env`. The launch must use the port AioLM assigns.
Your settings cannot override the model, host, port or authentication.

The probe must print a single JSON object to standard output within 30 seconds
and write diagnostics to standard error. Without a model it checks the
installation; with a model it reports whether that model is supported:

```json
{
  "schema_version": 1,
  "engine_id": "custom.example",
  "runtime_id": "build-1",
  "version": "reported-build-version",
  "accelerator": "cpu",
  "model": "",
  "model_supported": false,
  "served_model": "example-model",
  "capabilities": {
    "tasks": [],
    "modalities": {"text": false, "image": false, "audio": false, "video": false},
    "chat": false,
    "tools": false
  }
}
```

When a model is given, `model` must repeat it exactly. `tasks` lists
`generate`, `embed`, `transcription` or `translate`, and `served_model` is the
name the server uses in `/v1/models` and requests. Report only capabilities the
engine actually has. A base model without a chat template can load and still
be unable to chat.

### Creating a manifest for your own llama.cpp build

For a `llama-server` you built yourself, the repository's helper inspects the
build and writes a manifest:

```bash
python3 scripts/runtime-adapters/create_adapter.py create --kind llama.cpp \
  --engine-id custom.local-cpu --runtime-id build-1 \
  --server /absolute/path/to/llama-server \
  --model /absolute/path/to/model.gguf \
  --output /absolute/path/to/new-manifest.json
aiolm-cli runtime register-manifest /absolute/path/to/new-manifest.json
```

The output file must not exist yet. Read the generated manifest and confirm its
platform, program, arguments, artifacts and model before registering. The
helper runs no downloads, installations or inference. After changing the build
or the helper, remove the registration and register again.

### Limits

A registered engine is used for chat, projects, document search, MCP tools and
the API server to the extent its probe reports. Exact-token serving benchmarks,
numerical verification against a CPU reference and portable runtime archives
are not available for external engines. Their weight file size is shown as
unknown.

If a registration is removed or does not match the computer, AioLM keeps the
engine's saved settings and profiles but refuses to launch it; it never falls
back to llama.cpp. Register the engine again to use those settings.
